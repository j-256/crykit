import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { AccountDatabase, activateLocalAccountCommit } from '../persistence/account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId, readAccountBytes } from './account-cache'
import { createAccountLocalStore } from './account-local-store'
import { prepareLocalWorkspace } from './local-root'
import { openAccountManagedRepository, IncrementalWorkspaceIntentSchema } from './account-managed-repository'
import { editorClosureFixture } from './test-helpers'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { blobIdentity } from './blobs'
import { immutableCatalogSnapshot } from '../interchange/native'
import type { CatalogSnapshot } from '../domain/types'

it('captures mutable catalogs before yielding while retaining admitted immutable catalog identities', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId), store = createAccountLocalStore(database, token)
  try {
    const fixture = await editorClosureFixture(), operation = accountLocalId()
    const catalog = immutableCatalogSnapshot({ id: 'synthetic-catalog', revisionId: 'original', schemaVersion: '1', checksum: 'synthetic-original', importedAt: '2026-01-01T00:00:00.000Z', applicability: { state: 'unknown' }, rights: { state: 'unknown' }, entities: {}, claims: [] } as unknown as CatalogSnapshot)
    const initial = { ...fixture.state, planner: { ...fixture.state.planner, catalogs: [catalog] } }
    const prepared = await prepareLocalWorkspace(store.adapter, operation, initial, store.lifetime)
    await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, prepared, undefined)); store.committed(operation)
    const repository = await openAccountManagedRepository(database, token, (await database.profileMeta.get('active'))!)
    const before = await repository.readWorkspace(), admitted = before.planner.catalogs[0]!
    const mutable = structuredClone({ ...catalog, id: 'synthetic-new-catalog' as CatalogSnapshot['id'], checksum: 'synthetic-new' })
    const importing = repository.commitWorkspace({ ...before, planner: { ...before.planner, catalogs: [admitted, mutable] } }, before.planner.localData.revision)
    mutable.importedAt = 'late mutation' as CatalogSnapshot['importedAt']
    await importing
    const after = await repository.readWorkspace()
    expect(after.planner.catalogs[0]).toBe(admitted)
    expect(after.planner.catalogs[1].importedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(Object.isFrozen(mutable)).toBe(false)
    const reopened = await openAccountManagedRepository(database, token, (await database.profileMeta.get('active'))!)
    expect((await reopened.readWorkspace()).planner.catalogs).toEqual(after.planner.catalogs)
  } finally { await store.dispose(); database.close(); invalidateProfile() }
})

it('imports exact sources and saves setup with encrypted pending commands, restart and rejected damaged input', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId), store = createAccountLocalStore(database, token)
  try {
    const fixture = await editorClosureFixture(), operation = accountLocalId()
    const prepared = await prepareLocalWorkspace(store.adapter, operation, fixture.state, store.lifetime)
    await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, prepared, undefined)); store.committed(operation)
    const repository = await openAccountManagedRepository(database, token, (await database.profileMeta.get('active'))!)
    const bytes = new TextEncoder().encode('{\r\n"ID":"synthetic-account-source","Name":"Encrypted source","Version":"1","EditorVersion":34,"Equipment":[{"ID":9000,"Name":"Private sword","Type":0,"Hands":1,"StatMods":[]}],"Unknown":900719925474099312345\r\n}')
    const preview = await previewCrystalEdit(bytes, 'private.crystalmod'), before = await repository.load()
    const importing = repository.commitImport(preview, { mode: 'add-reference', expectedRevision: before.revision, targetLocalDataId: before.localData.id, includeModInReference: preview.proposed.catalogs[0]!.id })
    Object.assign(preview.proposed.catalogs[0], { importedAt: 'late mutation' })
    const imported = await importing
    expect((await repository.readSources()).find(value => value.filename === 'private.crystalmod')!.bytes).toEqual(bytes)
    const history = await repository.readHistory()
    expect(history.at(-1)).toMatchObject({ before: before.localData, after: imported.localData })
    const setup = await repository.commitModSetup([], imported.revision, true)
    expect(setup.localData.modSetup?.state).toBe('skipped')
    const state = await repository.readWorkspace(), fence = (await database.profileMeta.get('active'))!
    const source = state.planner.sources.find(value => value.filename === 'private.crystalmod')!
    const damaged = { ...state, blobs: state.blobs.map(body => blobIdentity(body.ref) === blobIdentity(source.original) ? { ref: body.ref, content: { byteLength: body.ref.byteLength, async *open() { yield new Uint8Array(body.ref.byteLength) } } } : body) }
    await expect(repository.commitWorkspace(damaged, setup.revision)).rejects.toThrow(/digest/)
    await expect(repository.commitWorkspace(state, setup.revision - 1)).rejects.toThrow(/changed/)
    expect(await database.profileMeta.get('active')).toEqual(fence)
    const reopened = await openAccountManagedRepository(database, token, fence)
    expect((await reopened.readWorkspace()).planner).toEqual(state.planner)
    expect((await reopened.readHistory()).slice(0, history.length)).toEqual(history)
    const intents = []
    for (const row of await database.outbox.toArray()) {
      const data = await readAccountBytes(database, token, row.ref)
      try { intents.push(IncrementalWorkspaceIntentSchema.parse(JSON.parse(new TextDecoder().decode(data)))) } finally { data.fill(0) }
    }
    expect(intents.map(value => value.operation).sort()).toEqual(['import', 'mod-setup'])
    for (const chunk of await database.stagedCipherChunks.toArray()) expect(new TextDecoder().decode(chunk.bytes)).not.toContain('Private sword')
    invalidateProfile()
    await expect(repository.commitWorkspace(state, setup.revision)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  } finally { await store.dispose(); database.close(); invalidateProfile() }
}, 30_000)
