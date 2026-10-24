import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile } from '../account/profile'
import { AccountDatabase } from './account-database'
import { accountLocalId, cipherRef, stageAccountJson } from '../workspace/account-cache'
import { MappedWorkspaceChangeSchema, stageMappedWorkspaceIntent, readMappedWorkspaceChanges } from '../workspace/account-intents'

it('keeps a large mapped intent ordered across bounded pages and rejects stale authority or missing pages', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  try {
    const target = await stageAccountJson(database, token, { version: 1, synthetic: true }, [])
    const records = []
    for (let index = 0; index < 300; index++) records.push(await stageAccountJson(database, token, { version: 1, index }, []))
    const changes = records.map((record, index) => ({ key: JSON.stringify(['personal-definition', String(index)]), kind: 'personal-definition' as const, before: null, after: cipherRef(record) }))
    const id = accountLocalId()
    const prepared = await stageMappedWorkspaceIntent(database, token, { version: 1, kind: 'mapped-workspace-intent', operationId: id, portableGroupId: accountLocalId(), operation: 'save', mode: 'additive', original: { base: cipherRef(target), target: cipherRef(target) }, base: cipherRef(target), target: cipherRef(target), localRevision: 1, changes })
    expect(prepared.records.length).toBeGreaterThan(3)
    // Paging fixtures need installed descriptors, not a synthetic target selected as a workspace
    await database.encryptedRevisions.bulkAdd([target, ...records, ...prepared.records])
    expect(await readMappedWorkspaceChanges(database, token, prepared.value)).toEqual(changes)
    for (const failure of ['duplicate', 'foreign'] as const) {
      const page = await stageAccountJson(database, token, { version: 1, kind: 'mapped-change-page', operationId: failure === 'foreign' ? accountLocalId() : id, entries: [], children: failure === 'duplicate' ? [prepared.value.changesIndex, prepared.value.changesIndex] : [] }, failure === 'duplicate' ? [prepared.value.changesIndex] : [])
      await database.encryptedRevisions.add(page)
      await expect(readMappedWorkspaceChanges(database, token, { ...prepared.value, changesIndex: cipherRef(page) })).rejects.toThrow(failure === 'duplicate' ? 'duplicate' : 'Foreign')
    }
    const cache = await import('../workspace/account-cache')
    const reader = vi.spyOn(cache, 'openAccountJson').mockImplementation(async () => ({ version: 1, kind: 'mapped-change-page', operationId: id, entries: [], children: [prepared.value.changesIndex] }) as never)
    await expect(readMappedWorkspaceChanges(database, token, prepared.value)).rejects.toThrow('Cyclic')
    reader.mockRestore()
    await database.encryptedRevisions.delete(prepared.value.changesIndex.revisionId)
    await expect(readMappedWorkspaceChanges(database, token, prepared.value)).rejects.toThrow()
    invalidateProfile()
    await expect(readMappedWorkspaceChanges(database, token, prepared.value)).rejects.toThrow()
  } finally { vi.restoreAllMocks(); invalidateProfile(); await database.delete() }
})

it('rejects empty or foreign per-key intent changes before staging', () => {
  const ref = { documentId: accountLocalId(), revisionId: accountLocalId() }
  expect(() => MappedWorkspaceChangeSchema.parse({ key: 'k', kind: 'personal-definition', before: null, after: null })).toThrow()
  expect(() => MappedWorkspaceChangeSchema.parse({ key: 'k', kind: 'personal-definition', before: ref, after: { ...ref, documentId: accountLocalId() } })).toThrow()
})
