import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile } from '../account/profile'
import { AccountDatabase } from './account-database'
import { accountLocalId } from '../workspace/account-cache'
import { openAccountRepository } from '../workspace/account-repository'
import { copyPublicSnapshot } from '../interchange/public-share-enrichment'
import { archiveWorkspaceUnit } from '../workspace/pending-content'
import { openManagedNativeWorkspace } from './managed-sync.test-helpers'
import { inspectWorkspaceClosure } from '../workspace/closure'
import { privateRecordKey, type WorkspaceState } from '../workspace/documents'
import { createBlankLocalData } from '../domain/local-data'
import type { PublicSnapshot } from '../interchange/public-share-schema'

let database: AccountDatabase | undefined
afterEach(async () => { vi.restoreAllMocks(); invalidateProfile(); await database?.delete(); database = undefined })
export function missingTeam(): PublicSnapshot {
  return { version: 5, kind: 'team', title: 'Receipt-only Team', setup: { baseline: { catalogId: 'missing-base', catalogRevisionId: 'historical-base' }, catalogLock: { 'missing-base': 'historical-base', 'crystal-edit:missing': 'historical-mod' }, layers: [{ catalogId: 'crystal-edit:missing', catalogRevisionId: 'historical-mod', title: 'Missing exact mod', checksum: `sha256:${'b'.repeat(64)}` }], mode: { state: 'unknown' }, ppCostsNonNegative: { state: 'unknown' }, slots: [] }, slots: [null, null, null, null], receipts: [] }
}
it('copyPreservesContextWithoutChangingActivePlaythrough', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const repository = await openAccountRepository(token), before = await repository.readWorkspace()
  const result = await copyPublicSnapshot(repository, missingTeam())
  expect(result).toHaveProperty('loaded.localData.teams')
  const after = await (await openAccountRepository(token)).readWorkspace()
  const team = after.planner.localData.teams[result.teamId!]!
  expect(team.kind).toBe('shared')
  if (team.kind !== 'shared') throw new Error('Expected shared Team')
  const checkpoint = after.planner.localData.teamRevisions[team.latestRevisionId]!
  expect(checkpoint.slots).toEqual([null, null, null, null])
  expect(checkpoint.catalogLock).toEqual(missingTeam().setup.catalogLock)
  expect(after.planner.localData.playthroughs).toEqual(before.planner.localData.playthroughs)
  expect(after.planner.localData.selectedPlaythroughId).toEqual(before.planner.localData.selectedPlaythroughId)
  expect(after.libraryDefaults).toEqual(before.libraryDefaults)
  expect(after.planner.catalogs).toEqual(before.planner.catalogs)
  expect(after.planner.sources).toEqual(before.planner.sources)
})

it('personal receipt copies and exact setup survive native backup without sender originals', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const repository = await openAccountRepository(token), fingerprint = { kind: 'personal-definition-v1' as const, value: 'a'.repeat(64) }
  const ref = { kind: 'personal' as const, fingerprint }
  const snapshot: PublicSnapshot = { ...missingTeam(), kind: 'build', title: 'Missing personal sword', slots: [{ primaryClass: null, secondaryClass: null, equipment: [{ slotId: 'hand', ref }, { slotId: 'off', ref }], equipmentGroups: [['hand', 'off']], passives: [] }], receipts: [{ ref, fingerprint, kind: 'item', name: 'Display sword', origin: { kind: 'personal', projectId: 'personal-definition-v1', sourceRevisionId: fingerprint.value, catalogId: 'personal-definition-v1', catalogRevisionId: fingerprint.value } }] }
  const result = await copyPublicSnapshot(repository, snapshot)
  const current = await openAccountRepository(token), after = await current.readWorkspace()
  const revision = after.planner.localData.buildRevisions[after.planner.localData.builds[result.buildId!]!.latestRevisionId!]!
  expect(revision.content.equipment.hand?.allocationId).toBe(revision.content.equipment.off?.allocationId)
  expect(revision.publicSourceContext?.personalBindings).toHaveLength(1)
  expect(after.planner.localData.personalDefinitions).toEqual({})
  const backup = await current.exportPlannerBackup()
  const preview = await current.previewImport(backup, 'copy.crykit')
  expect(preview.errors).toEqual([])
  expect(preview.proposed.localData?.buildRevisions[revision.id]?.publicSourceContext).toEqual(revision.publicSourceContext)
  const opened = await openManagedNativeWorkspace(database, token)
  for (const key of [privateRecordKey('build-checkpoint', revision.id), privateRecordKey('setup', revision.gameSetupRevisionId)]) {
    const blobs = new Map<string, WorkspaceState['blobs'][number]>()
    const closure = await archiveWorkspaceUnit(opened, key, blobs)
    // Neither the live root nor another checkpoint may supply missing archive authority
    const portable = { ...after, planner: { ...after.planner, localData: createBlankLocalData(), catalogs: [], sources: [], history: [] }, blobs: [...blobs.values()] }
    const checked = await inspectWorkspaceClosure(portable, closure)
    expect(checked.value).toEqual(key.includes('build-checkpoint') ? revision : after.planner.localData.gameSetups[revision.gameSetupRevisionId])
  }
})

it('rolls back a copy when the encrypted workspace publication fails', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const repository = await openAccountRepository(token), before = await repository.readWorkspace()
  const fence = await database.profileMeta.get('active'), put = IDBObjectStore.prototype.put
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    if (this.name === 'profileMeta') throw new DOMException('Synthetic copy quota failure', 'QuotaExceededError')
    return put.apply(this, args)
  })
  await expect(copyPublicSnapshot(repository, missingTeam())).rejects.toThrow()
  vi.restoreAllMocks()
  expect(await database.profileMeta.get('active')).toEqual(fence)
  expect((await repository.readWorkspace()).planner.localData).toEqual(before.planner.localData)
})

it('old v5 remains viewable but cannot silently guess a missing exact lock during copy', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const repository = await openAccountRepository(token), before = await repository.readWorkspace()
  const { catalogLock: _lock, ...setup } = missingTeam().setup
  const old = { ...missingTeam(), setup }
  const { validatePublicSnapshot } = await import('../interchange/public-share-schema')
  expect(validatePublicSnapshot(old)).toEqual(old)
  await expect(copyPublicSnapshot(repository, old)).rejects.toThrow(/owner to update/)
  expect((await repository.readWorkspace()).planner.localData).toEqual(before.planner.localData)
})

it('guest backup excludes only public receipt dependencies and retains imported-field dependencies', async () => {
  const { CryKitDatabase } = await import('./database')
  const { loadLocalData, exportBackup, previewImport } = await import('./local-data')
  const { preparePublicSnapshotCopy } = await import('../interchange/public-share-enrichment')
  const { createPersonalDefinition } = await import('../domain')
  const guest = new CryKitDatabase(`public-receipt-${crypto.randomUUID()}`)
  try {
    const loaded = await loadLocalData(guest), localData = loaded.localData
    const state: WorkspaceState = { planner: { localData, lineage: loaded.lineage, catalogs: loaded.catalogs, sources: [], evidence: [], history: [] }, assets: [], blobs: [], editorDocuments: [], saveDocuments: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] } }
    const prepared = preparePublicSnapshotCopy(state, missingTeam())
    const copy = prepared.state.planner.localData
    const backup = await exportBackup(copy, guest)
    const preview = await previewImport(backup, 'guest-copy.crykit')
    expect(preview.errors).toEqual([])
    expect(preview.proposed.localData?.teamRevisions).toEqual(copy.teamRevisions)
    const data = createPersonalDefinition(copy, { name: 'Opaque source dependency', kind: 'item', fields: { opaque: { state: 'known', value: { id: 'lookalike', gameSetupId: 'lookalike', slots: [], publicSourceContext: { checksum: `sha256:${'d'.repeat(64)}` } } } } })
    await expect(exportBackup(data, guest)).rejects.toThrow(/source bytes/)
  } finally { await guest.delete() }
})

it('copies a missing selected source while retaining the actual bundled baseline', async () => {
  const { CURRENT_CATALOG } = await import('../catalog/bundled')
  const { previewCrystalEdit } = await import('../interchange/crystal-edit')
  const { modModelEntity } = await import('../domain/mod-layers')
  const { importLibrarySource } = await import('../workspace/mod-repository')
  const { enrichPublicSnapshot } = await import('../interchange/public-share-enrichment')
  const preview = await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: 'copy-baseline-import', Title: 'Exact own source', Jobs: [{ ID: 0, Name: 'Exact own class' }] })), 'own.json')
  const catalog = preview.proposed.catalogs[0]!
  const definition = modModelEntity(catalog, 'crystal-edit:Jobs:0')!
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const blobModule = await import('../workspace/blobs')
  const reads = vi.spyOn(blobModule, 'readBlob')
  const repository = await openAccountRepository(token), before = await repository.readWorkspace()
  const ref = { kind: 'catalog' as const, catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: definition.id }
  const original = missingTeam()
  const snapshot: PublicSnapshot = { ...original, setup: { ...original.setup, layers: [{ catalogId: catalog.id, catalogRevisionId: catalog.revisionId, checksum: catalog.checksum, title: 'Exact own source' }], baseline: { catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId }, catalogLock: { [CURRENT_CATALOG.id]: CURRENT_CATALOG.revisionId, [ref.catalogId]: ref.catalogRevisionId } }, slots: [{ primaryClass: ref, secondaryClass: null, equipment: [], equipmentGroups: [], passives: [] }, null, null, null], receipts: [{ ref, kind: 'class', name: 'Missing class', origin: { kind: 'catalog', projectId: ref.catalogId, sourceRevisionId: ref.catalogRevisionId, catalogId: ref.catalogId, catalogRevisionId: ref.catalogRevisionId, modelKey: 'crystal-edit:Jobs:0' } }] }
  const copied = await copyPublicSnapshot(repository, snapshot)
  const selected = await openAccountRepository(token)
  const after = await selected.readWorkspace(), team = after.planner.localData.teams[copied.teamId!]!
  if (team.kind !== 'shared') throw new Error('Expected shared Team')
  expect(after.planner.localData.teamRevisions[team.latestRevisionId]?.catalogLock).toEqual(snapshot.setup.catalogLock)
  expect(after.planner.catalogs).toEqual(before.planner.catalogs)
  expect(after.planner.sources).toEqual(before.planner.sources)
  const mapped = await openManagedNativeWorkspace(database, token)
  reads.mockClear()
  const { validatedWorkspaceRetentionEdges } = await import('../workspace/closure')
  await validatedWorkspaceRetentionEdges(mapped.state)
  const repeated = new Map<object, number>()
  for (const [source] of reads.mock.calls) if (source.byteLength > 100_000) repeated.set(source, (repeated.get(source) ?? 0) + 1)
  expect(repeated.size).toBeGreaterThan(0)
  expect([...repeated.values()]).toEqual([...repeated.values()].map(() => 1))
  reads.mockRestore()
  const phases: { phase: string; ms: number }[] = []
  const observed: typeof repository = { ...selected,
    readWorkspace: async () => { const start = performance.now(); try { return await selected.readWorkspace() } finally { phases.push({ phase: 'readWorkspace', ms: performance.now() - start }) } },
    commitWorkspace: async (...args) => { const start = performance.now(); try { return await selected.commitWorkspace(...args) } finally { phases.push({ phase: 'commitWorkspace', ms: performance.now() - start }) } },
  }
  await importLibrarySource(observed, preview, { inReference: true, futureDefault: false })
  const enriched = await (await openAccountRepository(token)).readWorkspace()
  expect(enrichPublicSnapshot(snapshot, enriched).entries[0]?.definition).toEqual(definition)
  expect(enriched.planner.localData.teamRevisions[team.latestRevisionId]?.catalogLock).toEqual(snapshot.setup.catalogLock)
  expect(enriched.libraryDefaults).toEqual(before.libraryDefaults)
  expect(enriched.planner.localData.playthroughs).toEqual(before.planner.localData.playthroughs)
  if (process.env.CRYKIT_SYNC_MEASUREMENTS) (await import('node:fs')).appendFileSync(process.env.CRYKIT_SYNC_MEASUREMENTS, `${JSON.stringify({ operation: 'public-copy-matching-import', phases })}\n`)
})
