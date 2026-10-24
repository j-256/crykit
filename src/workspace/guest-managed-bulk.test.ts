import './guest-managed-monitor.test-helpers'
import { expect, it, vi } from 'vitest'
import { GuestCoordinatorDatabase } from './guest-coordinator'
import { createGuestLocalStore, type GuestManagedManifest } from './guest-local-store'
import { prepareLocalWorkspace } from './local-root'
import { openGuestManagedRepository } from './guest-managed-repository'
import { invalidateProfile } from '../account/profile'
import { createTestLocalData } from '../domain/test-helpers'
import { createSampleLocalData } from '../domain/sample-data'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { readBlob, blobIdentity } from './blobs'
import type { WorkspaceState } from './documents'
import type { CatalogSnapshot } from '../domain/types'
import { isImmutableCatalogSnapshot } from '../interchange/native'

it('captures mutable bulk input without recloning an admitted immutable catalog', async () => {
  const database = new GuestCoordinatorDatabase(`synthetic-managed-capture-${crypto.randomUUID()}`)
  const store = createGuestLocalStore(database, () => {})
  const localData = createTestLocalData()
  const catalog: CatalogSnapshot = { id: 'synthetic-admitted' as never, revisionId: 'synthetic-admitted-v1' as never, schemaVersion: 'synthetic', checksum: 'synthetic', importedAt: localData.createdAt, applicability: { state: 'unknown' }, rights: { state: 'unknown' }, entities: {}, claims: [] }
  const initial: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [catalog], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
  const prepared = await prepareLocalWorkspace(store.adapter, 'initial', initial, { check: () => {}, assertCurrent: async () => {} })
  const receipt = await store.activate('initial', prepared.head, undefined, () => {})
  const repository = await openGuestManagedRepository(database, receipt.target)
  const state = await repository.readWorkspace(), admitted = state.planner.catalogs[0]!
  expect(isImmutableCatalogSnapshot(admitted)).toBe(true)
  const mutable: CatalogSnapshot = { ...catalog, id: 'synthetic-mutable' as never, revisionId: 'synthetic-mutable-v1' as never, legacy: { marker: 'Captured input' } }
  const input = { ...state, planner: { ...state.planner, catalogs: [admitted, mutable] } }
  const clone = globalThis.structuredClone
  let fullCatalogCopies = 0
  const observe = vi.spyOn(globalThis, 'structuredClone').mockImplementation(value => {
    const candidate = value as { readonly planner?: { readonly catalogs?: readonly CatalogSnapshot[] } } | null
    if (candidate?.planner?.catalogs?.includes(admitted)) fullCatalogCopies++
    return clone(value)
  })
  try {
    const committing = repository.commitWorkspace(input, localData.revision)
    Object.assign(mutable.legacy!, { marker: 'Late caller mutation' })
    await committing
    observe.mockRestore()
    const selected = (await database.active.get('active'))!.manifest as unknown as GuestManagedManifest
    const reopened = await openGuestManagedRepository(database, selected)
    const actual = await reopened.readWorkspace()
    expect(actual.planner.catalogs.find(value => value.id === mutable.id)?.legacy).toEqual({ marker: 'Captured input' })
    expect(actual.planner.catalogs.find(value => value.id === admitted.id)).toEqual(admitted)
    expect(fullCatalogCopies).toBe(0)
    await expect(repository.load()).rejects.toThrow(/retired/)
  } finally { observe.mockRestore(); database.close() }
}, 10_000)

it('imports and configures a managed guest through exact staged native successors with rollback and old-wrapper rejection', async () => {
  const started = performance.now()
  const phase = (name: string) => { if (process.env.R16_BULK_TRACE) console.log(JSON.stringify({ phase: name, elapsedMs: performance.now() - started, rss: process.memoryUsage().rss })) }
  const database = new GuestCoordinatorDatabase(`synthetic-managed-bulk-${crypto.randomUUID()}`)
  const store = createGuestLocalStore(database, () => {})
  const localData = createSampleLocalData(BUNDLED_CATALOGS[0])
  const initial: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: BUNDLED_CATALOGS, sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
  const prepared = await prepareLocalWorkspace(store.adapter, 'initial', initial, { check: () => {}, assertCurrent: async () => {} })
  const receipt = await store.activate('initial', prepared.head, undefined, () => {}); phase('prepared')
  const reopen = async () => openGuestManagedRepository(database, (await database.active.get('active'))!.manifest as unknown as GuestManagedManifest)
  const text = '{\r\n"ID":"synthetic-managed-bulk","Name":"Synthetic bulk source","Version":"1","EditorVersion":34,"Equipment":[{"ID":9000,"Name":"Synthetic sword","Type":0,"Hands":1,"StatMods":[]}],"Unknown":900719925474099312345\r\n}'
  const bytes = new TextEncoder().encode(text)
  const preview = await previewCrystalEdit(bytes, 'bulk.crystalmod')
  const catalog = preview.proposed.catalogs[0]!
  try {
    let repository = await openGuestManagedRepository(database, receipt.target)
    phase('opened'); const old = repository
    const importing = repository.commitImport(preview, { mode: 'add-reference', expectedRevision: localData.revision, targetLocalDataId: localData.id, includeModInReference: catalog.id })
    Object.assign(preview.proposed.catalogs[0], { importedAt: 'late caller mutation' })
    const imported = await importing; phase('imported')
    await expect(old.load()).rejects.toThrow(/retired/)
    repository = await reopen(); phase('reopened')
    expect(await repository.load()).toEqual(imported)
    expect(imported.localData.revision).toBe(localData.revision + 1)
    expect(imported.localData.selectedPlaythroughId).toBe(localData.selectedPlaythroughId)
    expect((await repository.readSources())[0]!.bytes).toEqual(bytes)
    const firstHistory = await repository.readHistory()
    expect(firstHistory.at(-1)!.before).toEqual(localData)
    expect(firstHistory.at(-1)!.after).toEqual(imported.localData)
    expect(firstHistory.at(-1)!.command).toBe('workspace-command')
    const beforeSetup = repository
    const configured = await repository.commitModSetup([], imported.revision, true); phase('configured')
    await expect(beforeSetup.save(imported.localData, imported.revision)).rejects.toThrow(/retired/)
    repository = await reopen(); phase('reopened')
    expect(await repository.load()).toEqual(configured)
    expect((await repository.readHistory()).slice(0, firstHistory.length)).toEqual(firstHistory)
    const state = await repository.readWorkspace(), active = await database.active.get('active')
    const count = await database.table('managedOperations').count()
    await expect(repository.commitWorkspace(state, configured.revision - 1)).rejects.toThrow(/changed/)
    const source = state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(state.planner.sources[0]!.original))!
    const corrupted = { ...state, blobs: state.blobs.map(value => value === source ? { ref: value.ref, content: { byteLength: value.content.byteLength, async *open() { yield new Uint8Array(value.content.byteLength) } } } : value) }
    await expect(repository.commitWorkspace(corrupted, configured.revision)).rejects.toThrow(/digest/)
    expect(await database.active.get('active')).toEqual(active)
    expect(await database.table('managedOperations').count()).toBe(count)
    expect((await repository.load()).localData).toEqual(configured.localData)
    expect(await readBlob(source.content, source.ref.byteLength)).toEqual(bytes)
    phase('negative-cases'); const completed = await repository.commitWorkspace(state, configured.revision); phase('committed')
    repository = await reopen(); phase('reopened')
    expect(await repository.load()).toEqual(completed)
    expect((await repository.readHistory()).slice(0, firstHistory.length)).toEqual(firstHistory)
    expect((await repository.readSources())[0]!.bytes).toEqual(bytes)
  } finally { database.close() }
}, 120_000)

for (const fault of ['corrupt-staging', 'profile-change'] as const) it(`keeps the old managed head after ${fault} during bulk preparation`, async () => {
  const database = new GuestCoordinatorDatabase(`synthetic-managed-bulk-${fault}-${crypto.randomUUID()}`)
  const store = createGuestLocalStore(database, () => {})
  const localData = createTestLocalData()
  const initial: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
  const prepared = await prepareLocalWorkspace(store.adapter, 'initial', initial, { check: () => {}, assertCurrent: async () => {} })
  const receipt = await store.activate('initial', prepared.head, undefined, () => {})
  const repository = await openGuestManagedRepository(database, receipt.target)
  let injected = false
  const inject = (_key: unknown, row: { sha256: string }) => {
    if (injected) return
    injected = true
    if (fault === 'corrupt-staging') row.sha256 = '0'.repeat(64)
    else invalidateProfile()
  }
  database.table('managedRecords').hook('creating', inject)
  try {
    await expect(repository.commitWorkspace(initial, localData.revision)).rejects.toThrow()
    expect(injected).toBe(true)
    expect((await database.active.get('active'))!.manifest).toEqual(receipt.target)
    expect(await database.table('managedOperations').count()).toBe(1)
    database.table('managedRecords').hook('creating').unsubscribe(inject)
    const reopened = await openGuestManagedRepository(database, receipt.target)
    expect(await reopened.readWorkspace()).toEqual(initial)
  } finally { database.close() }
}, 10_000)
