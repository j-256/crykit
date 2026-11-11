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
import type { CatalogSnapshot, EntityId } from '../domain/types'
import { validatePublicSnapshot, type PublicSnapshot } from '../interchange/public-share-schema'
import { editCopiedCheckpoint } from '../interchange/public-checkpoint-edit'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { createPublicSnapshot } from '../interchange/public-share'

const AVAILABLE_CATALOG_PIN = Object.freeze({ catalogId: 'synthetic-public-copy-catalog' as CatalogSnapshot['id'], catalogRevisionId: 'synthetic-public-copy-v1' as CatalogSnapshot['revisionId'] })
const AVAILABLE_ENTITY_ID = 'synthetic-present-item' as EntityId

let database: AccountDatabase | undefined
afterEach(async () => { vi.restoreAllMocks(); invalidateProfile(); await database?.delete(); database = undefined })
export function missingTeam(): PublicSnapshot {
  return { version: 5, kind: 'team', title: 'Receipt-only Team', setup: { baseline: { catalogId: 'missing-base', catalogRevisionId: 'historical-base' }, catalogLock: { 'missing-base': 'historical-base', 'crystal-edit:missing': 'historical-mod' }, layers: [{ catalogId: 'crystal-edit:missing', catalogRevisionId: 'historical-mod', title: 'Missing exact mod', checksum: `sha256:${'b'.repeat(64)}` }], mode: { state: 'unknown' }, ppCostsNonNegative: { state: 'unknown' }, slots: [] }, slots: [null, null, null, null], receipts: [] }
}
function unknownCatalogSnapshot(kind: 'build' | 'team' = 'build', available = false): PublicSnapshot {
  const ref = { kind: 'catalog', catalogId: available ? AVAILABLE_CATALOG_PIN.catalogId : 'missing-base', catalogRevisionId: available ? AVAILABLE_CATALOG_PIN.catalogRevisionId : 'historical-base', entityId: available ? AVAILABLE_ENTITY_ID : 'unknown-selected-item' }
  const loadout = { primaryClass: null, secondaryClass: null, equipment: [{ slotId: 'hand', ref }], equipmentGroups: [], passives: [] }
  return validatePublicSnapshot({ ...missingTeam(), kind, title: 'Unknown catalog selection', setup: { ...missingTeam().setup, baseline: { catalogId: ref.catalogId, catalogRevisionId: ref.catalogRevisionId }, catalogLock: { [ref.catalogId]: ref.catalogRevisionId }, layers: [], slots: [{ id: 'hand', label: 'Hand' }] }, slots: kind === 'team' ? [null, loadout, null, null] : [loadout], receipts: [{ ref, kind: null, origin: null, name: 'Saved unknown selection' }] })
}

it.each([{ kind: 'build', available: false }, { kind: 'team', available: false }, { kind: 'build', available: true }] as const)('unknown catalog $kind copy with exact definition available $available survives reopen, notes, re-share, backup and isolated closure', async ({ kind, available }) => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const repository = await openAccountRepository(token)
  if (available) {
    const initial = await repository.readWorkspace()
    // A distinct complete catalog exercises exact present-definition authority without archiving the entire native dataset
    // Publish through the real repository before capture so every later reopen, backup, and closure owns the same fixture
    const catalog: CatalogSnapshot = { id: AVAILABLE_CATALOG_PIN.catalogId, revisionId: AVAILABLE_CATALOG_PIN.catalogRevisionId, schemaVersion: 'synthetic-public-copy-1', checksum: 'synthetic-public-copy-v1', importedAt: initial.planner.localData.createdAt, applicability: { state: 'unknown' }, rights: { state: 'unknown' }, entities: { [AVAILABLE_ENTITY_ID]: { id: AVAILABLE_ENTITY_ID, kind: 'item', name: 'Exact synthetic item', aliases: [], fields: {}, sources: [] } }, claims: [] }
    await repository.commitWorkspace({ ...initial, planner: { ...initial.planner, catalogs: [...initial.planner.catalogs, catalog] } }, initial.planner.localData.revision)
  }
  const before = await repository.readWorkspace(), snapshot = unknownCatalogSnapshot(kind, available)
  const result = await copyPublicSnapshot(repository, snapshot)
  const current = await openAccountRepository(token), after = await current.readWorkspace(), data = after.planner.localData
  const revision = result.buildId ? data.buildRevisions[data.builds[result.buildId]!.latestRevisionId!]! : Object.values(data.teamRevisions).find(checkpoint => checkpoint.teamId === result.teamId)!
  const content = 'slots' in revision ? revision.slots[1]!.content : revision.content
  expect(revision.publicSourceContext?.version).toBe(2)
  expect(revision.publicSourceContext?.receipts).toEqual(snapshot.receipts)
  expect(content.equipment.hand?.ref).toEqual(snapshot.receipts[0]!.ref)
  expect(content.referenceNames).toEqual([{ ref: snapshot.receipts[0]!.ref, name: 'Saved unknown selection' }])
  expect(data.unavailableDefinitions ?? []).toEqual(before.planner.localData.unavailableDefinitions ?? [])
  expect(after.planner.catalogs).toEqual(before.planner.catalogs)
  expect(after.planner.sources).toEqual(before.planner.sources)
  expect(data.playthroughs).toEqual(before.planner.localData.playthroughs)
  if (available) {
    expect(after.planner.catalogs.some(catalog => catalog.id === AVAILABLE_CATALOG_PIN.catalogId && catalog.revisionId === AVAILABLE_CATALOG_PIN.catalogRevisionId && catalog.entities[AVAILABLE_ENTITY_ID])).toBe(true)
    expect(after.planner.catalogs.some(catalog => catalog.id === CURRENT_CATALOG.id && catalog.revisionId === CURRENT_CATALOG.revisionId && catalog.entities['base:equipment:41'])).toBe(true)
  }
  const notes = { ...(kind === 'team' ? { checkpoint: 'Recipient Team checkpoint' } : {}), slots: snapshot.slots.map(slot => slot ? { rotationNotes: 'Recipient note without mechanics', checkpoint: 'Recipient checkpoint', contextAssumptions: [] } : null) }
  const edited = editCopiedCheckpoint(after, { checkpoint: 'slots' in revision ? { kind: 'team', revisionId: revision.id } : { kind: 'build', revisionId: revision.id }, notes })
  await current.commitWorkspace({ ...after, planner: { ...after.planner, localData: edited.localData } }, data.revision)
  const reopened = await openAccountRepository(token), saved = await reopened.readWorkspace()
  const checkpoint = edited.checkpoint.kind === 'build' ? saved.planner.localData.buildRevisions[edited.checkpoint.revisionId]! : saved.planner.localData.teamRevisions[edited.checkpoint.revisionId]!
  expect(checkpoint.publicSourceContext).toEqual(revision.publicSourceContext)
  expect('slots' in revision ? saved.planner.localData.teamRevisions[revision.id] : saved.planner.localData.buildRevisions[revision.id]).toEqual(revision)
  const target = 'slots' in checkpoint ? { kind: 'team' as const, teamId: checkpoint.teamId, teamRevisionId: checkpoint.id } : { kind: 'build' as const, revisionId: checkpoint.id }
  const shared = createPublicSnapshot(saved, target, { includeNotes: true })
  expect(shared.receipts).toEqual(snapshot.receipts)
  expect(shared.slots).toEqual(snapshot.slots)
  expect(shared.notes).toEqual(notes)
  const backup = await reopened.exportPlannerBackup(), preview = await reopened.previewImport(backup, 'unknown-copy.crykit')
  expect(preview.errors).toEqual([])
  expect('slots' in checkpoint ? preview.proposed.localData?.teamRevisions[checkpoint.id] : preview.proposed.localData?.buildRevisions[checkpoint.id]).toEqual(checkpoint)
  const opened = await openManagedNativeWorkspace(database, token)
  const checkpointKey = privateRecordKey('slots' in checkpoint ? 'team-checkpoint' : 'build-checkpoint', checkpoint.id)
  for (const key of [checkpointKey, privateRecordKey('setup', checkpoint.gameSetupRevisionId)]) {
    const blobs = new Map<string, WorkspaceState['blobs'][number]>()
    const closure = await archiveWorkspaceUnit(opened, key, blobs)
    // Unknown receipt authority must come from this archive, independently of the live planner
    const isolated = { ...saved, planner: { ...saved.planner, localData: createBlankLocalData(), catalogs: [], sources: [], history: [] }, blobs: [...blobs.values()] }
    expect((await inspectWorkspaceClosure(isolated, closure)).value).toEqual(key === checkpointKey ? checkpoint : saved.planner.localData.gameSetups[checkpoint.gameSetupRevisionId])
  }
  if (!('slots' in checkpoint) && !available) {
    const recipientToken = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
    const recipientDatabase = new AccountDatabase(recipientToken.accountId)
    try {
      expect(recipientToken.accountId).not.toBe(token.accountId)
      const recipient = await openAccountRepository(recipientToken), empty = await recipient.readWorkspace()
      expect(empty.planner.localData.buildRevisions[checkpoint.id]).toBeUndefined()
      const restore = await recipient.previewImport(backup, 'unknown-copy.crykit')
      expect(restore.errors).toEqual([])
      await recipient.commitImport(restore, { mode: 'replace', expectedRevision: empty.planner.localData.revision, targetLocalDataId: empty.planner.localData.id })
      const restored = await (await openAccountRepository(recipientToken)).readWorkspace()
      const restoredCheckpoint = restored.planner.localData.buildRevisions[checkpoint.id]!
      expect(restoredCheckpoint).toEqual(checkpoint)
      expect(restoredCheckpoint.publicSourceContext?.version).toBe(2)
      expect(restoredCheckpoint.publicSourceContext?.receipts).toEqual(snapshot.receipts)
      expect(restoredCheckpoint.content.referenceNames).toEqual(content.referenceNames)
      expect(restoredCheckpoint.content.equipment.hand?.ref).toEqual(snapshot.receipts[0]!.ref)
      expect(restored.planner.localData.unavailableDefinitions ?? []).toEqual(data.unavailableDefinitions ?? [])
    } finally {
      invalidateProfile()
      await recipientDatabase.delete()
    }
  }
})

it('unknown catalog receipt cannot hide a missing entity in an exact complete recipient catalog', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const repository = await openAccountRepository(token), before = await repository.readWorkspace()
  const ref = { kind: 'catalog' as const, catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId, entityId: 'synthetic-absent-complete-entity' }
  expect(before.planner.catalogs.some(catalog => catalog.id === ref.catalogId && catalog.revisionId === ref.catalogRevisionId)).toBe(true)
  expect(CURRENT_CATALOG.entities[ref.entityId]).toBeUndefined()
  const original = unknownCatalogSnapshot()
  const snapshot = validatePublicSnapshot({ ...original, setup: { ...original.setup, baseline: { catalogId: ref.catalogId, catalogRevisionId: ref.catalogRevisionId }, catalogLock: { [ref.catalogId]: ref.catalogRevisionId }, layers: [] }, slots: [{ ...original.slots[0]!, equipment: [{ slotId: 'hand', ref }] }], receipts: [{ ref, kind: null, origin: null, name: 'Absent exact entity' }] })
  const fence = await database.profileMeta.get('active')
  await expect(copyPublicSnapshot(repository, snapshot)).rejects.toThrow(/missing catalog entity/)
  expect(await database.profileMeta.get('active')).toEqual(fence)
  expect(await repository.readWorkspace()).toEqual(before)
})

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

it.each([['concrete metadata', missingTeam], ['unknown catalog metadata', () => unknownCatalogSnapshot()]] as const)('rolls back a copy with %s when the encrypted workspace publication fails', async (_label, snapshot) => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const repository = await openAccountRepository(token), before = await repository.readWorkspace()
  const fence = await database.profileMeta.get('active'), put = IDBObjectStore.prototype.put
  let publicationFaultFired = false
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    if (this.name === 'profileMeta') { publicationFaultFired = true; throw new DOMException('Synthetic copy quota failure', 'QuotaExceededError') }
    return put.apply(this, args)
  })
  const input = snapshot()
  await expect(copyPublicSnapshot(repository, input)).rejects.toThrow()
  expect(publicationFaultFired).toBe(true)
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
