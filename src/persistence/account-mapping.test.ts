import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { installProfile, invalidateProfile } from '../account/profile'
import { createBlankLocalData } from '../domain/local-data'
import { createPersonalDefinition } from '../domain'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { AccountDatabase, activateLocalAccountCommit } from './account-database'
import { accountLocalId, stageAccountJson, cipherRef, openAccountJson, AccountProjectionSchema, AccountIntentSchema } from '../workspace/account-cache'
import { openAccountRepository } from '../workspace/account-repository'
import { MappedWorkspaceIntentSchema, openOrMapAccountWorkspace, readMappedWorkspaceChanges } from '../workspace/account-intents'

it('maps pending legacy edits from their original bases and preserves operation identity atomically', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  try {
    const localData = createBlankLocalData()
    const projection = AccountProjectionSchema.parse({ version: 1, kind: 'local-planner-cache', localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], bundledCatalogs: BUNDLED_CATALOGS.map(({ id, revisionId, checksum }) => ({ id, revisionId, checksum })), evidence: [], sources: [] })
    const base = await stageAccountJson(database, token, projection, [])
    const fence = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: cipherRef(base), records: [base] })
    const next = createPersonalDefinition(localData, { name: 'Original pending target', kind: 'item' })
    const target = await stageAccountJson(database, token, { ...projection, localData: next }, [], cipherRef(base))
    const id = accountLocalId()
    const intent = await stageAccountJson(database, token, AccountIntentSchema.parse({ version: 1, kind: 'unmapped-planner-intent', operationId: id, operation: 'save', mode: 'additive', base: cipherRef(base), target: cipherRef(target), localRevision: 1 }), [cipherRef(base), cipherRef(target)])
    await activateLocalAccountCommit(database, token, { version: 1, id, expected: fence, head: cipherRef(target), intent: cipherRef(intent), records: [target, intent] })
    // Exercise the native pending-intent mapper directly, before the public opener's managed migration
    // Complete native-to-managed startup is covered separately without changing this native fixture
    const selected = await openOrMapAccountWorkspace(database, token, (await database.profileMeta.get('active'))!)
    const row = (await database.outbox.toArray())[0]!
    expect(row.id).toBe(id)
    expect(row.status).toBe('mapped-local')
    const mapped = await openAccountJson(database, token, row.ref, MappedWorkspaceIntentSchema)
    expect(mapped.original).toEqual({ base: cipherRef(base), target: cipherRef(target) })
    expect((await readMappedWorkspaceChanges(database, token, mapped)).some(change => change.kind === 'personal-definition' && change.before === null && change.after !== null)).toBe(true)
    expect(selected.workspace.state.planner.localData.personalDefinitions).toEqual(next.personalDefinitions)
    expect((await database.encryptedRevisions.get(base.revisionId))?.revisionId).toBe(base.revisionId)
    for (const table of database.tables) await table.each(row => {
      const value = table.name === 'stagedCipherChunks' ? new TextDecoder().decode(row.bytes) : JSON.stringify(row)
      expect(value).not.toContain('Original pending target')
    })
  } finally { invalidateProfile(); await database.delete() }
})

it.each(['missing-original-base', 'unsupported-intent', 'activation-failure', 'stale-profile'])('keeps legacy authority and pending rows unchanged on %s', async failure => {
  const { vi } = await import('vitest')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  try {
    const localData = createBlankLocalData()
    const projection = { version: 1, kind: 'local-planner-cache', localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], bundledCatalogs: [], sources: [], evidence: [] }
    const base = await stageAccountJson(database, token, projection, [])
    const fence = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: cipherRef(base), records: [base] })
    const next = createPersonalDefinition(localData, { name: 'Must remain pending', kind: 'item' })
    const target = await stageAccountJson(database, token, { ...projection, localData: next }, [], cipherRef(base))
    const id = accountLocalId()
    const intent = await stageAccountJson(database, token, { version: 1, kind: failure === 'unsupported-intent' ? 'unknown-future-intent' : 'unmapped-planner-intent', operationId: id, operation: 'save', mode: 'additive', base: cipherRef(base), target: cipherRef(target), localRevision: 1 }, [cipherRef(base), cipherRef(target)])
    await activateLocalAccountCommit(database, token, { version: 1, id, expected: fence, head: cipherRef(target), intent: cipherRef(intent), records: [target, intent] })
    if (failure === 'missing-original-base') await database.encryptedRevisions.delete(base.revisionId)
    const before = { fence: await database.profileMeta.get('active'), outbox: await database.outbox.toArray() }
    if (failure === 'activation-failure') {
      const put = IDBObjectStore.prototype.put
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) { if (this.name === 'profileMeta') throw new DOMException('Synthetic activation failure', 'QuotaExceededError'); return put.apply(this, args) })
    }
    if (failure === 'stale-profile') invalidateProfile()
    await expect(openAccountRepository(token)).rejects.toThrow()
    expect(await database.profileMeta.get('active')).toEqual(before.fence)
    expect(await database.outbox.toArray()).toEqual(before.outbox)
    expect((await database.encryptedRevisions.get(target.revisionId))?.descriptor).toEqual(target.descriptor)
  } finally { vi.restoreAllMocks(); invalidateProfile(); await database.delete() }
})

it.each(['forward', 'reverse'])('preserves forked original pending bases in %s mapping order', async order => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  try {
    const localData = { ...createBlankLocalData(), referenceLibrary: { version: 1 as const, excludedMods: [] } }
    const projection = { version: 1, kind: 'local-planner-cache', localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], bundledCatalogs: [], sources: [], evidence: [] }
    const base = await stageAccountJson(database, token, projection, [])
    let fence = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: cipherRef(base), records: [base] })
    const ids: string[] = []
    for (const [index, excluded] of (order === 'forward' ? ['crystal-edit:first', 'crystal-edit:second'] : ['crystal-edit:second', 'crystal-edit:first']).entries()) {
      const target = await stageAccountJson(database, token, { ...projection, localData: { ...localData, revision: index + 1, referenceLibrary: { version: 1, excludedMods: [excluded] } } }, [], cipherRef(base))
      const id = accountLocalId(); ids.push(id)
      const intent = await stageAccountJson(database, token, { version: 1, kind: 'unmapped-planner-intent', operationId: id, operation: 'save', mode: 'additive', base: cipherRef(base), target: cipherRef(target), localRevision: index + 1 }, [cipherRef(base), cipherRef(target)])
      fence = await activateLocalAccountCommit(database, token, { version: 1, id, expected: fence, head: cipherRef(target), intent: cipherRef(intent), records: [target, intent] })
    }
    await openAccountRepository(token)
    const changes = []
    for (const id of ids) {
      const row = (await database.outbox.get(id))!
      const intent = await openAccountJson(database, token, row.ref, MappedWorkspaceIntentSchema)
      changes.push((await readMappedWorkspaceChanges(database, token, intent)).find(change => change.kind === 'reference-preferences')!)
    }
    expect(changes[0].before).toEqual(changes[1].before)
    expect(changes[0].after!.documentId).toBe(changes[1].after!.documentId)
    expect((await database.encryptedRevisions.get(changes[1].after!.revisionId))!.descriptor.parents).toEqual([changes[1].before!.revisionId])
  } finally { invalidateProfile(); await database.delete() }
})
