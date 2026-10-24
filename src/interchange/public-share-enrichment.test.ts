import { describe, expect, it } from 'vitest'
import { syntheticModLayers } from '../domain/mod-layers.test-helpers'
import { createTestLocalData, addTestDefinition } from '../domain/test-helpers'
import { modModelEntity } from '../domain/mod-layers'
import { memoryBlob } from '../workspace/blobs'
import type { WorkspaceState } from '../workspace/documents'
import type { CatalogSnapshot } from '../domain/types'
import { publicPersonalDefinitionFingerprint } from './public-share'
import { enrichPublicSnapshot } from './public-share-enrichment'
import type { PublicSnapshot } from './public-share-schema'

async function fixture() {
  const { catalogs, first } = await syntheticModLayers()
  const source = catalogs[1]!, entity = modModelEntity(source, 'crystal-edit:Jobs:0')!
  const ref = { kind: 'catalog' as const, catalogId: catalogs[0]!.id, catalogRevisionId: `composition-v1:sha256:${'a'.repeat(64)}`, entityId: 'base:job:0' }
  const snapshot: PublicSnapshot = { version: 5, kind: 'build', title: 'Shared', setup: { baseline: { catalogId: catalogs[0]!.id, catalogRevisionId: catalogs[0]!.revisionId }, layers: [{ catalogId: source.id, catalogRevisionId: source.revisionId, checksum: source.checksum, title: 'Layer A' }], mode: { state: 'unknown' }, ppCostsNonNegative: { state: 'unknown' }, slots: [] }, slots: [{ primaryClass: ref, secondaryClass: null, equipment: [], equipmentGroups: [], passives: [] }], receipts: [{ ref, kind: 'class', name: entity.name, origin: { kind: 'catalog', projectId: source.id, sourceRevisionId: source.revisionId, catalogId: ref.catalogId, catalogRevisionId: ref.catalogRevisionId, modelKey: 'crystal-edit:Jobs:0' } }] }
  const localData = createTestLocalData()
  const archive = first.proposed.sources[0]!
  const original = { documentId: 'own-source', revisionId: 'own-revision', byteLength: archive.bytes.length, sha256: archive.digest, encoding: 'bytes' as const }
  const { bytes, ...metadata } = archive
  const viewer: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs, sources: [{ ...metadata, original }], evidence: first.proposed.evidence, history: [] }, editorDocuments: [], saveDocuments: [], assets: [], blobs: [{ ref: original, content: memoryBlob(bytes) }], libraryDefaults: { version: 1, layers: [] }, conflicts: [], retainedContent: [] }
  return { snapshot, viewer, source, entity }
}
const withCatalogs = (viewer: WorkspaceState, catalogs: readonly CatalogSnapshot[]): WorkspaceState => ({ ...viewer, planner: { ...viewer.planner, catalogs } })

describe('viewer-owned public enrichment', () => {
  it('requiresViewerOwnedExactSourceForModOverride', async () => {
    const { snapshot, viewer, entity } = await fixture()
    const before = JSON.stringify(snapshot), viewerBefore = JSON.stringify(viewer)
    expect(enrichPublicSnapshot(snapshot, withCatalogs(viewer, [])).unresolvedCalculations).toBe(true)
    expect(enrichPublicSnapshot(snapshot, { ...viewer, planner: { ...viewer.planner, sources: [] }, blobs: [] }).unresolvedCalculations).toBe(true)
    const exact = enrichPublicSnapshot(snapshot, viewer)
    expect(exact.resolved).toBe(true)
    expect(exact.entries[0]?.definition).toEqual(entity)
    expect(exact.missingReceiptIds).toEqual([])
    expect(JSON.stringify(snapshot)).toBe(before)
    expect(JSON.stringify(viewer)).toBe(viewerBefore)
  })
  it('doesNotFallBackToVanillaOrSameNameRevision', async () => {
    const { snapshot, viewer, source } = await fixture()
    expect(enrichPublicSnapshot(snapshot, withCatalogs(viewer, [viewer.planner.catalogs[0]!])).unresolvedCalculations).toBe(true)
    const wrong = { ...source, revisionId: 'wrong' as never, checksum: `sha256:${'b'.repeat(64)}` }
    expect(enrichPublicSnapshot(snapshot, withCatalogs(viewer, [wrong])).unresolvedCalculations).toBe(true)
    expect(enrichPublicSnapshot(snapshot, withCatalogs(viewer, [{ ...source, id: 'wrong-project' as never }])).unresolvedCalculations).toBe(true)
  })
  it('preserves historical pins and reports changed parser projection explicitly', async () => {
    const { snapshot, viewer, source } = await fixture()
    const historical = structuredClone(snapshot)
    historical.setup.layers[0]!.catalogRevisionId = 'historical:library-v1'
    historical.receipts[0]!.origin.sourceRevisionId = 'historical:library-v1'
    const result = enrichPublicSnapshot(historical, viewer)
    expect(result.entries[0]?.definition).toEqual(modModelEntity(source, 'crystal-edit:Jobs:0'))
    expect(result.adaptedProjections).toHaveLength(1)
    expect(historical.receipts[0]!.origin.sourceRevisionId).toBe('historical:library-v1')
  })
  it('personal display receipts remain unknown without exact viewer content', async () => {
    const { snapshot, viewer } = await fixture()
    const localData = addTestDefinition(viewer.planner.localData, 'own-definition', { kind: 'class' })
    const fingerprint = { kind: 'personal-definition-v1' as const, value: publicPersonalDefinitionFingerprint(localData, 'own-definition') }
    const ref = { kind: 'personal' as const, fingerprint }
    const personal: PublicSnapshot = { ...snapshot, slots: [{ ...snapshot.slots[0]!, primaryClass: ref }], receipts: [{ ref, fingerprint, kind: 'class', name: 'own-definition', origin: { kind: 'personal', projectId: 'personal-definition-v1', sourceRevisionId: fingerprint.value, catalogId: 'personal-definition-v1', catalogRevisionId: fingerprint.value } }] }
    expect(enrichPublicSnapshot(personal, viewer).unresolvedCalculations).toBe(true)
    expect(enrichPublicSnapshot(personal, { ...viewer, planner: { ...viewer.planner, localData } }).entries[0]?.definition).toEqual(localData.personalDefinitions['own-definition'])
  })
})

it('resolves native definitions only with exact baseline and receipt origin', async () => {
  const { snapshot, viewer } = await fixture(), baseline = viewer.planner.catalogs[0]!
  const entity = Object.values(baseline.entities).find(entity => entity.kind === 'class')!
  const ref = { kind: 'catalog' as const, catalogId: baseline.id, catalogRevisionId: baseline.revisionId, entityId: entity.id }
  const native: PublicSnapshot = { ...snapshot, setup: { ...snapshot.setup, layers: [] }, slots: [{ ...snapshot.slots[0]!, primaryClass: ref }], receipts: [{ ref, kind: entity.kind, name: entity.name, origin: { kind: 'catalog', projectId: baseline.id, sourceRevisionId: baseline.revisionId, catalogId: baseline.id, catalogRevisionId: baseline.revisionId } }] }
  expect(enrichPublicSnapshot(native, viewer).entries[0]?.definition).toEqual(entity)
  expect(enrichPublicSnapshot({ ...native, setup: { ...native.setup, baseline: null } }, viewer).resolved).toBe(false)
  expect(enrichPublicSnapshot({ ...native, receipts: [{ ...native.receipts[0]!, origin: { ...native.receipts[0]!.origin, sourceRevisionId: 'other' } }] }, viewer).resolved).toBe(false)
})

it('does not select between ambiguous matching parser projections by array order', async () => {
  const { snapshot, viewer, source } = await fixture()
  const historical = structuredClone(snapshot)
  historical.setup.layers[0]!.catalogRevisionId = 'historical:library-v1'
  historical.receipts[0]!.origin.sourceRevisionId = 'historical:library-v1'
  const ambiguous = withCatalogs(viewer, [source, { ...source, revisionId: 'different:library-v2' as never }])
  expect(enrichPublicSnapshot(historical, ambiguous).entries[0]?.definition).toBeUndefined()
  expect(enrichPublicSnapshot(historical, ambiguous).missingReceiptIds).toHaveLength(1)
})

it('reconstructs only captured equipment grouping with fresh independent identities', async () => {
  const { publicLoadoutContent } = await import('./public-share-enrichment')
  const { snapshot } = await fixture(), ref = snapshot.receipts[0]!.ref
  const loadout = { ...snapshot.slots[0]!, equipment: [{ slotId: 'hand', ref }, { slotId: 'second-hand', ref }], equipmentGroups: [['hand', 'second-hand']] }
  const map = () => ({ kind: 'personal' as const, definitionId: 'own' as never })
  const one = publicLoadoutContent(loadout, map), two = publicLoadoutContent(loadout, map)
  expect(one.equipment.hand?.allocationId).toBeTruthy()
  expect(one.equipment.hand?.allocationId).toBe(one.equipment['second-hand']?.allocationId)
  expect(two.equipment.hand?.allocationId).not.toBe(one.equipment.hand?.allocationId)
  const distinct = publicLoadoutContent({ ...loadout, equipmentGroups: [] }, map)
  expect(distinct.equipment.hand?.allocationId).toBeUndefined()
  expect(distinct.equipment['second-hand']?.allocationId).toBeUndefined()
})

it('counts shared two-handed contribution once and reports an invalid configured group', async () => {
  const { publicLoadoutContent } = await import('./public-share-enrichment')
  const { collectEffectiveModifiers } = await import('../domain/effective-modifiers')
  const { analyzeBuildEquipment } = await import('../domain/build-mechanics')
  const { SUGGESTED_BUILD_SLOTS } = await import('../domain/build-planning')
  const { PC_RULES } = await import('../domain/calculation-rules')
  const { snapshot, viewer } = await fixture(), baseline = viewer.planner.catalogs[0]!
  const ref = { kind: 'catalog' as const, catalogId: baseline.id, catalogRevisionId: baseline.revisionId, entityId: 'synthetic-weapon' }
  const tag = Number(Object.entries(PC_RULES.statMods).find(([, value]) => value.name === 'Flat_MPCosts')![0])
  const weapon = { id: 'synthetic-weapon' as never, name: 'Two-handed synthetic weapon', kind: 'item' as const, aliases: [], sources: [], fields: { 'Crystal Edit source record': { state: 'known' as const, value: { ID: 9000, EquipmentType: 0, IsTwoHanded: true, StatMods: [{ Tag: tag, Value1: -2, Value2: 0, Value3: 0 }] } } } }
  const map = () => ({ ...ref, entityId: ref.entityId as never })
  const loadout = { ...snapshot.slots[0]!, primaryClass: null, equipment: [{ slotId: 'plan-main-hand', ref }, { slotId: 'plan-off-hand', ref }], equipmentGroups: [['plan-main-hand', 'plan-off-hand']] }
  const grouped = publicLoadoutContent(loadout, map), distinct = publicLoadoutContent({ ...loadout, equipmentGroups: [] }, map)
  expect(collectEffectiveModifiers(grouped, SUGGESTED_BUILD_SLOTS, () => weapon).stats.MPCostsFlat).toBe(-2)
  expect(collectEffectiveModifiers(distinct, SUGGESTED_BUILD_SLOTS, () => weapon).stats.MPCostsFlat).toBe(-4)
  const oneHanded = { ...weapon, fields: { ...weapon.fields, 'Crystal Edit source record': { state: 'known' as const, value: { ...weapon.fields['Crystal Edit source record'].value, IsTwoHanded: false } } } }
  expect(analyzeBuildEquipment(grouped, SUGGESTED_BUILD_SLOTS, () => oneHanded).some(issue => issue.code === 'EQUIPMENT_ALLOCATION_HANDS')).toBe(true)
})

it('enriches artwork through the exact source pin without leaking entity-reference fields into its binding', async () => {
  const { previewCrystalEdit } = await import('./crystal-edit')
  const { findArtworkBinding, findPrivateArtwork, privateArtworkRegion } = await import('../workspace/artwork-repository')
  const { viewer } = await fixture()
  const preview = await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: 'viewer-artwork', Title: 'Own artwork source', Equipment: [{ ID: 9, Name: 'Own blade', EquipmentType: 0, TexturePath: 'Equipment/Own', TextureIndex: 0 }] })), 'mod.json')
  const catalog = preview.proposed.catalogs[0]!, entity = modModelEntity(catalog, 'crystal-edit:Equipment:9')!, archive = preview.proposed.sources[0]!
  const { bytes, ...metadata } = archive
  const original = { documentId: 'own-source', revisionId: 'own-source-version', byteLength: bytes.length, sha256: archive.digest, encoding: 'bytes' as const }
  const own: WorkspaceState = { ...viewer, planner: { ...viewer.planner, catalogs: [catalog], sources: [{ ...metadata, original }] }, blobs: [{ ref: original, content: memoryBlob(bytes) }] }
  const pin = { catalogId: catalog.id, catalogRevisionId: catalog.revisionId }
  const ref = { kind: 'catalog' as const, ...pin, entityId: entity.id }
  const asset = { version: 1 as const, id: 'own-artwork', sourceKey: findArtworkBinding(own, pin, 'mod/Equipment/Own.png', 'mod.json'), relativePath: 'mod/Equipment/Own.png', original: { documentId: 'art', revisionId: 'art-version', byteLength: 1, sha256: 'a'.repeat(64), encoding: 'bytes' as const }, mediaType: 'image/png' as const, width: 240, height: 36 }
  const state = { ...own, assets: [asset] }
  const snapshot: PublicSnapshot = { version: 5, kind: 'build', title: 'Own artwork', setup: { baseline: null, catalogLock: { [catalog.id]: catalog.revisionId }, layers: [{ ...pin, checksum: catalog.checksum, title: 'Own source' }], mode: { state: 'unknown' }, ppCostsNonNegative: { state: 'unknown' }, slots: [] }, slots: [{ primaryClass: null, secondaryClass: null, equipment: [{ slotId: 'hand', ref }], equipmentGroups: [], passives: [] }], receipts: [{ ref, kind: 'item', name: entity.name, origin: { kind: 'catalog', projectId: catalog.id, sourceRevisionId: catalog.revisionId, ...pin, modelKey: 'crystal-edit:Equipment:9' } }] }
  expect(findPrivateArtwork(state, pin, entity)).toEqual(asset)
  expect(privateArtworkRegion(entity, asset)).toEqual({ x: 2, y: 2, width: 32, height: 32 })
  expect(enrichPublicSnapshot(snapshot, state).entries[0]?.artwork).toEqual(asset)
  expect(enrichPublicSnapshot(snapshot, { ...state, assets: [asset, { ...asset, id: 'ambiguous-artwork' }] }).entries[0]?.artwork).toBeUndefined()
  expect(enrichPublicSnapshot(snapshot, { ...state, assets: [{ ...asset, sourceKey: asset.sourceKey.replace(catalog.revisionId, 'wrong-source-revision') }] }).entries[0]?.artwork).toBeUndefined()
})
