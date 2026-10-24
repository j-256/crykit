import { expect, it } from 'vitest'
import { createTestLocalData } from './test-helpers'
import type { WorkspaceState } from '../workspace/documents'
import type { PublicSnapshot } from '../interchange/public-share-schema'
import { preparePublicSnapshotCopy, publicReadOnlyPreview } from '../interchange/public-share-enrichment'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { saveBuildRevision } from './builds'
import { publicSnapshotFromCheckpoint } from './public-source-context'
import { checkpointBuildView } from './team-checkpoints'
import { NativeLocalDataSchema } from '../interchange/native-schema'
import { upgradeBundledReferences } from './bundled-reference-upgrade'

function fixture() {
  const localData = createTestLocalData()
  const state: WorkspaceState = { planner: { localData, catalogs: [], lineage: { rootLocalDataId: localData.id }, sources: [], evidence: [], history: [] }, assets: [], blobs: [], editorDocuments: [], saveDocuments: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] } }
  const ref = { kind: 'catalog' as const, catalogId: 'missing-base', catalogRevisionId: 'historical-base', entityId: 'base:item:0' }
  const snapshot: PublicSnapshot = { version: 5, kind: 'build', title: 'Missing selection', setup: { baseline: { catalogId: ref.catalogId, catalogRevisionId: ref.catalogRevisionId }, catalogLock: { [ref.catalogId]: ref.catalogRevisionId }, layers: [], mode: { state: 'unknown' }, ppCostsNonNegative: { state: 'unknown' }, slots: [] }, slots: [{ primaryClass: null, secondaryClass: null, equipment: [{ slotId: 'removed-slot', ref }], equipmentGroups: [], passives: [] }], receipts: [{ ref, kind: 'item', name: 'Historical item', origin: { kind: 'catalog', projectId: ref.catalogId, sourceRevisionId: ref.catalogRevisionId, catalogId: ref.catalogId, catalogRevisionId: ref.catalogRevisionId } }] }
  const prepared = preparePublicSnapshotCopy(state, snapshot), data = prepared.state.planner.localData
  const revision = data.buildRevisions[data.builds[prepared.result.buildId!]!.latestRevisionId!]!
  return { data, revision, setup: data.gameSetups[revision.gameSetupRevisionId]!, snapshot }
}
it('preserves note-only revisions and blocks implicit selection reinterpretation', () => {
  const { data, revision, setup } = fixture()
  const next = saveBuildRevision(data, { buildId: revision.buildId, gameSetupRevisionId: setup.id, parentRevisionId: revision.id, content: { ...revision.content, rotationNotes: 'Independent recipient note' }, note: 'Own checkpoint' })
  expect(() => validateNativeLocalDataGraph(next, [])).not.toThrow()
  const saved = next.buildRevisions[next.builds[revision.buildId]!.latestRevisionId!]!
  expect(saved.publicSourceContext).toEqual(revision.publicSourceContext)
  expect(() => saveBuildRevision(data, { buildId: revision.buildId, gameSetupRevisionId: setup.id, content: { ...revision.content, equipment: {} } })).toThrow(/setup|adapt/i)
})
it('denies foreign setup allowance, active planning, forged context and present missing entities', () => {
  const { data, revision, setup } = fixture()
  expect(() => validateNativeLocalDataGraph(data, [])).not.toThrow()
  const without = { ...revision, publicSourceContext: undefined }
  expect(() => validateNativeLocalDataGraph({ ...data, buildRevisions: { ...data.buildRevisions, [revision.id]: without } }, [])).toThrow()
  expect(() => validateNativeLocalDataGraph({ ...data, planningGameSetupRevisionId: setup.id }, [])).toThrow(/Playthrough/)
  const forged = { ...revision, publicSourceContext: { ...revision.publicSourceContext!, setupDigest: '0'.repeat(64) } }
  expect(() => validateNativeLocalDataGraph({ ...data, buildRevisions: { ...data.buildRevisions, [revision.id]: forged } }, [])).toThrow(/exact setup/)
  const catalog = { id: 'missing-base' as never, revisionId: 'historical-base' as never, schemaVersion: 'test', checksum: 'synthetic-complete', importedAt: setup.createdAt, applicability: { state: 'unknown' as const }, rights: { state: 'unknown' as const }, entities: {}, claims: [] }
  expect(() => validateNativeLocalDataGraph(data, [catalog])).toThrow('A reference points to a missing catalog entity')
})
it('public receipt identity survives typed bundled reference upgrades', () => {
  const { data, revision, setup, snapshot } = fixture()
  const after = upgradeBundledReferences(data, { id: 'missing-base' as never, revisionId: 'historical-base' as never }, new Map([['base:item:0', 'replacement' as never]]))
  expect(after.buildRevisions[revision.id]).toEqual(revision)
  expect(publicSnapshotFromCheckpoint(setup, revision, snapshot.title).setup).toEqual(snapshot.setup)
})
it('rejects mechanics added to an inert copied setup', () => {
  const { data, setup } = fixture()
  for (const extra of [{ platform: { state: 'known', value: 'PC' } }, { mods: { state: 'known', value: ['Unrelated'] } }, { customMods: ['unrelated'] }, { slots: setup.slots.map(slot => ({ ...slot, acceptedEntityKinds: { state: 'known', value: ['item'] } })) }]) {
    if ('slots' in extra && !extra.slots?.length) continue
    expect(() => validateNativeLocalDataGraph({ ...data, gameSetups: { ...data.gameSetups, [setup.id]: { ...setup, ...extra } } } as typeof data, [])).toThrow(/source receipt/)
  }
})
it('isolated checkpoint closure checks its own exact personal receipt and cannot borrow a setup', async () => {
  const { splitWorkspace, privateRecordKey } = await import('../workspace/documents')
  const { resolvedDomainClosureKeys } = await import('../workspace/domain-closure')
  const { data, snapshot } = fixture(), fingerprint = { kind: 'personal-definition-v1' as const, value: 'c'.repeat(64) }, ref = { kind: 'personal' as const, fingerprint }
  const state: WorkspaceState = { planner: { localData: data, lineage: { rootLocalDataId: data.id }, catalogs: [], sources: [], evidence: [], history: [] }, assets: [], blobs: [], editorDocuments: [], saveDocuments: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] } }
  const personal: PublicSnapshot = { ...snapshot, slots: [{ ...snapshot.slots[0]!, equipment: [{ slotId: 'removed-slot', ref }] }], receipts: [{ ref, fingerprint, kind: 'item', name: 'Missing personal', origin: { kind: 'personal', projectId: 'personal-definition-v1', sourceRevisionId: fingerprint.value, catalogId: 'personal-definition-v1', catalogRevisionId: fingerprint.value } }] }
  const copy = preparePublicSnapshotCopy(state, personal), localData = copy.state.planner.localData
  const checkpoint = localData.buildRevisions[localData.builds[copy.result.buildId!]!.latestRevisionId!]!
  const documents = new Map(splitWorkspace(copy.state).map(value => [value.key, value]))
  const document = documents.get(privateRecordKey('build-checkpoint', checkpoint.id))!
  expect(resolvedDomainClosureKeys(document, documents)).toContain(privateRecordKey('workspace-preferences'))
  expect(() => resolvedDomainClosureKeys({ ...document, value: { ...checkpoint, publicSourceContext: undefined } } as unknown as typeof document, documents)).toThrow()
  const key = privateRecordKey('workspace-preferences'), preferences = documents.get(key)!
  const invalid = { ...preferences, value: { ...preferences.value as object, unavailableDefinitions: [] } } as typeof preferences
  expect(() => resolvedDomainClosureKeys(document, new Map(documents).set(key, invalid))).toThrow(/personal receipt/)
  expect(() => resolvedDomainClosureKeys({ ...document, value: { ...checkpoint, publicSourceContext: { ...checkpoint.publicSourceContext!, setupDigest: '0'.repeat(64) } } } as unknown as typeof document, documents)).toThrow(/exact setup/)
})
it('preserves included Build and Team checkpoint notes across copy and reprojection', () => {
  const { data, snapshot } = fixture()
  const state: WorkspaceState = { planner: { localData: data, lineage: { rootLocalDataId: data.id }, catalogs: [], sources: [], evidence: [], history: [] }, assets: [], blobs: [], editorDocuments: [], saveDocuments: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] } }
  for (const kind of ['build', 'team'] as const) {
    const notes = { ...(kind === 'team' ? { checkpoint: 'Shared Team checkpoint' } : {}), slots: [{ checkpoint: 'Slot checkpoint', rotationNotes: 'Rotation note', contextAssumptions: ['Captured assumption'] }, ...(kind === 'team' ? [null, null, null] : [])] }
    const shared: PublicSnapshot = { ...snapshot, kind, slots: [snapshot.slots[0]!, ...(kind === 'team' ? [null, null, null] : [])], notes }
    const copied = preparePublicSnapshotCopy(state, shared), local = copied.state.planner.localData
    const checkpoint = copied.result.buildId ? local.buildRevisions[local.builds[copied.result.buildId]!.latestRevisionId!]! : Object.values(local.teamRevisions).find(value => value.teamId === copied.result.teamId)!
    expect(publicSnapshotFromCheckpoint(local.gameSetups[checkpoint.gameSetupRevisionId]!, checkpoint, shared.title).notes).toEqual(notes)
    expect(NativeLocalDataSchema.parse(local)).toEqual(local)
    if ('slots' in checkpoint) expect(checkpointBuildView(local, { kind: 'team-slot', teamRevisionId: checkpoint.id, slot: 0 })?.note).toBe('Slot checkpoint')
  }
})

it('refuses a Build-only unsupported shared header note without dropping it', () => {
  const { data, snapshot } = fixture()
  const state: WorkspaceState = { planner: { localData: data, lineage: { rootLocalDataId: data.id }, catalogs: [], sources: [], evidence: [], history: [] }, assets: [], blobs: [], editorDocuments: [], saveDocuments: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] } }
  const shared = { ...snapshot, notes: { checkpoint: 'Extra header note', slots: [{ contextAssumptions: [], checkpoint: 'Original checkpoint note' }] } }
  expect(() => preparePublicSnapshotCopy(state, shared)).toThrow(/header note/)
  expect(() => publicReadOnlyPreview(shared, state)).not.toThrow()
})

it('does not let an ordinary historical setup borrow another copied setup missing-pin authority', async () => {
  const { resolvedDomainClosureKeys } = await import('../workspace/domain-closure')
  const { privateRecordKey } = await import('../workspace/documents')
  const { historyEntry } = await import('../persistence/local-data')
  const { data, setup } = fixture()
  const historical = (root: typeof data) => {
    const history = historyEntry(root, root, 'synthetic-history', setup.createdAt)
    return { version: 1 as const, key: privateRecordKey('history', history.id), kind: 'history' as const, value: history as unknown as import('./types').JsonValue }
  }
  const valid = historical(data)
  expect(() => resolvedDomainClosureKeys(valid, new Map([[valid.key, valid]]))).not.toThrow()
  const id = 'ordinary-missing-setup' as typeof setup.id
  const forged = historical({ ...data, gameSetups: { ...data.gameSetups, [id]: { ...setup, id, publicSourceContext: undefined } } })
  expect(() => resolvedDomainClosureKeys(forged, new Map([[forged.key, forged]]))).toThrow(/missing catalog/)
})

for (const kind of ['build', 'team'] as const) for (const availability of ['missing-entity', 'present-entity', 'absent-source', 'partial-withdrawn'] as const) {
  it(`checks ${kind} isolated copied archive membership with ${availability}`, async () => {
    const { createBlankLocalData } = await import('./local-data')
    const { HISTORICAL_BUNDLED_CATALOG } = await import('./withdrawn-catalogs')
    const { privateRecordKey } = await import('../workspace/documents')
    const { memoryBlob, hashBlob } = await import('../workspace/blobs')
    const { inspectWorkspaceClosure, validateWorkspaceClosure } = await import('../workspace/closure')
    const localData = createBlankLocalData()
    const before: WorkspaceState = { planner: { localData, catalogs: [], lineage: { rootLocalDataId: localData.id }, sources: [], evidence: [], history: [] }, assets: [], blobs: [], editorDocuments: [], saveDocuments: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] } }
    const ref = { kind: 'catalog' as const, catalogId: 'present-source', catalogRevisionId: 'exact-revision', entityId: 'selected-entity' }
    const loadout = { primaryClass: null, secondaryClass: null, equipment: [{ slotId: 'hand', ref }], equipmentGroups: [], passives: [] }
    const snapshot: PublicSnapshot = { version: 5, kind, title: 'Isolated copy', setup: { baseline: { catalogId: ref.catalogId, catalogRevisionId: ref.catalogRevisionId }, catalogLock: { [ref.catalogId]: ref.catalogRevisionId }, layers: [], mode: { state: 'unknown' }, ppCostsNonNegative: { state: 'unknown' }, slots: [{ id: 'hand', label: 'Hand' }] }, slots: kind === 'build' ? [loadout] : [null, loadout, null, null], receipts: [{ ref, kind: 'item', name: 'Selected item', origin: { kind: 'catalog', projectId: ref.catalogId, sourceRevisionId: ref.catalogRevisionId, catalogId: ref.catalogId, catalogRevisionId: ref.catalogRevisionId } }] }
    const prepared = preparePublicSnapshotCopy(before, snapshot), data = prepared.state.planner.localData
    const checkpoint = kind === 'build' ? Object.values(data.buildRevisions)[0]! : Object.values(data.teamRevisions)[0]!
    const catalog: import('./types').CatalogSnapshot = { id: ref.catalogId as never, revisionId: ref.catalogRevisionId as never, schemaVersion: availability === 'partial-withdrawn' ? 'game-setup-mod-catalog-1' : 'test', checksum: 'synthetic-complete', importedAt: localData.updatedAt, applicability: { state: 'unknown' }, rights: { state: 'unknown' }, entities: availability === 'present-entity' ? { [ref.entityId]: { id: ref.entityId as never, name: 'Selected item', kind: 'item', aliases: [], fields: {}, sources: [] } } : {}, claims: [], ...(availability === 'partial-withdrawn' ? { legacy: { modBaseline: { catalogId: HISTORICAL_BUNDLED_CATALOG.id, catalogRevisionId: HISTORICAL_BUNDLED_CATALOG.revisionId }, crystalEditIdentities: {} } } : {}) }
    const catalogs = availability === 'absent-source' ? [] : [catalog]
    if (availability === 'missing-entity') expect(() => validateNativeLocalDataGraph(data, catalogs)).toThrow('A reference points to a missing catalog entity')
    else expect(() => validateNativeLocalDataGraph(data, catalogs)).not.toThrow()
    const setupKey = privateRecordKey('setup', checkpoint.gameSetupRevisionId), checkpointKey = privateRecordKey(kind === 'build' ? 'build-checkpoint' : 'team-checkpoint', checkpoint.id), catalogKey = privateRecordKey('catalog', ref.catalogId, ref.catalogRevisionId)
    const documents = [{ kind: 'setup', key: setupKey, value: data.gameSetups[checkpoint.gameSetupRevisionId] }, { kind: kind === 'build' ? 'build-checkpoint' : 'team-checkpoint', key: checkpointKey, value: checkpoint }, ...catalogs.map(value => ({ kind: 'catalog', key: catalogKey, value }))]
    const blobs: WorkspaceState['blobs'][number][] = []
    const add = async (value: unknown, documentId: string) => {
      const content = memoryBlob(new TextEncoder().encode(JSON.stringify(value)))
      const ref = { documentId, revisionId: 'v1', byteLength: content.byteLength, sha256: await hashBlob(content), encoding: 'utf8' as const }
      blobs.push({ ref, content }); return ref
    }
    const refs = new Map<string, import('../workspace/documents').WorkspaceBlobRef>()
    for (const [index, document] of documents.entries()) refs.set(document.key, await add(document.value, `document-${index}`))
    const catalogRefs = catalogs.length ? [refs.get(catalogKey)!] : []
    const entries = documents.map(document => ({ version: 1, ref: refs.get(document.key), documentVersion: 1, kind: document.kind, key: document.key, encoding: 'json', dependencies: document.key === checkpointKey ? [refs.get(setupKey)!, ...catalogRefs] : document.key === setupKey ? catalogRefs : [] }))
    const index = await add({ version: 1, kind: 'conflict-closure-page', entries, children: [] }, 'index')
    const closure = { version: 1 as const, root: refs.get(checkpointKey)!, index }
    // The live root is blank; the archive must carry all selected-reference authority itself
    const isolated: WorkspaceState = { ...before, blobs, retainedContent: [{ version: 1, kind: 'pending-content', id: 'isolated-copy', groupId: 'copy', unit: { kind: 'record', privateKey: checkpointKey }, base: { kind: 'absent' }, target: closure }] }
    if (availability === 'missing-entity') {
      await expect(inspectWorkspaceClosure(isolated, closure)).rejects.toThrow('A reference points to a missing catalog entity')
      await expect(validateWorkspaceClosure(isolated)).rejects.toThrow('A reference points to a missing catalog entity')
    } else {
      expect((await inspectWorkspaceClosure(isolated, closure)).value).toEqual(checkpoint)
      await expect(validateWorkspaceClosure(isolated)).resolves.toBeUndefined()
    }
  })
}
