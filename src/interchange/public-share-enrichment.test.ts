import { describe, expect, it } from 'vitest'
import { syntheticModLayers } from '../domain/mod-layers.test-helpers'
import { createTestLocalData, addTestDefinition } from '../domain/test-helpers'
import { modModelEntity } from '../domain/mod-layers'
import { memoryBlob } from '../workspace/blobs'
import type { WorkspaceState } from '../workspace/documents'
import type { CatalogSnapshot } from '../domain/types'
import { publicPersonalDefinitionFingerprint } from './public-share'
import { enrichPublicSnapshot, publicReadOnlyPreview } from './public-share-enrichment'
import type { PublicSnapshot } from './public-share-schema'

async function fixture() {
  const { catalogs, first } = await syntheticModLayers()
  const source = catalogs[1]!, entity = modModelEntity(source, 'crystal-edit:Jobs:0')!
  const ref = { kind: 'catalog' as const, catalogId: catalogs[0]!.id, catalogRevisionId: `composition-v2:sha256:${'a'.repeat(64)}`, entityId: 'base:job:0' }
  const snapshot: PublicSnapshot = { version: 6, dataGeneration: 'catalog-sources-1', kind: 'build', title: 'Shared', setup: { baseline: { catalogId: catalogs[0]!.id, catalogRevisionId: catalogs[0]!.revisionId }, layers: [{ catalogId: source.id, catalogRevisionId: source.revisionId, checksum: source.checksum, title: 'Layer A' }], mode: { state: 'unknown' }, ppCostsNonNegative: { state: 'unknown' }, slots: [] }, slots: [{ primaryClass: ref, secondaryClass: null, equipment: [], equipmentGroups: [], passives: [] }], receipts: [{ ref, kind: 'class', name: entity.name, origin: { kind: 'catalog', projectId: source.id, sourceRevisionId: source.revisionId, catalogId: ref.catalogId, catalogRevisionId: ref.catalogRevisionId, modelKey: 'crystal-edit:Jobs:0' } }] }
  const localData = createTestLocalData()
  const archive = first.proposed.sources[0]!
  const original = { documentId: 'own-source', revisionId: 'own-revision', byteLength: archive.bytes.length, sha256: archive.digest, encoding: 'bytes' as const }
  const { bytes, ...metadata } = archive
  const viewer: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs, sources: [{ ...metadata, original }], evidence: first.proposed.evidence, history: [] }, editorDocuments: [], saveDocuments: [], assets: [], blobs: [{ ref: original, content: memoryBlob(bytes) }], libraryDefaults: { version: 1, layers: [] }, conflicts: [], retainedContent: [] }
  return { snapshot, viewer, source, entity }
}
const withCatalogs = (viewer: WorkspaceState, catalogs: readonly CatalogSnapshot[]): WorkspaceState => ({ ...viewer, planner: { ...viewer.planner, catalogs } })

it('resolves an unknown kind only from the viewer-owned exact source without rewriting the receipt', async () => {
  const { snapshot, viewer, entity } = await fixture()
  const unknown = { ...snapshot, receipts: snapshot.receipts.map(receipt => ({ ...receipt, kind: null })) }
  expect(enrichPublicSnapshot(unknown, viewer).entries[0]?.definition).toEqual(entity)
  expect(enrichPublicSnapshot(unknown, { ...viewer, blobs: [] }).entries[0]?.definition).toEqual(entity)
  expect(unknown.receipts[0]?.kind).toBeNull()
})

it('keeps unknown origins unresolved when only matching source files are present', async () => {
  const { snapshot, viewer } = await fixture()
  const unknown = { ...snapshot, receipts: snapshot.receipts.map(receipt => ({ ...receipt, kind: null, origin: null, origins: undefined })) }
  const result = enrichPublicSnapshot(unknown, viewer)
  expect(result.entries[0]?.definition).toBeUndefined()
  expect(result.resolved).toBe(false)
  expect(result.unresolvedCalculations).toBe(true)
})

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
  it('preserves historical pins and refuses a different interpretation', async () => {
    const { snapshot, viewer, source } = await fixture()
    const historical = structuredClone(snapshot)
    historical.setup.layers[0]!.catalogRevisionId = source.revisionId.replace(/-p1$/, '-p2')
    historical.receipts[0]!.origin!.sourceRevisionId = source.revisionId.replace(/-p1$/, '-p2')
    const result = enrichPublicSnapshot(historical, viewer)
    expect(result.entries[0]?.definition).toBeUndefined()
    expect(historical.receipts[0]!.origin!.sourceRevisionId).toBe(source.revisionId.replace(/-p1$/, '-p2'))
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
  expect(enrichPublicSnapshot({ ...native, setup: { ...native.setup, baseline: null } }, viewer).unresolvedCalculations).toBe(true)
  expect(enrichPublicSnapshot({ ...native, receipts: [{ ...native.receipts[0]!, origin: { ...native.receipts[0]!.origin!, sourceRevisionId: 'v999' } }] }, viewer).resolved).toBe(false)
})

it('does not select between ambiguous matching parser projections by array order', async () => {
  const { snapshot, viewer, source } = await fixture()
  const historical = structuredClone(snapshot)
  historical.setup.layers[0]!.catalogRevisionId = source.revisionId.replace(/-p1$/, '-p2')
  historical.receipts[0]!.origin!.sourceRevisionId = source.revisionId.replace(/-p1$/, '-p2')
  const ambiguous = withCatalogs(viewer, [source, { ...source, revisionId: source.revisionId.replace(/-p1$/, '-p3') as never }])
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
  const snapshot: PublicSnapshot = { version: 6, dataGeneration: 'catalog-sources-1', kind: 'build', title: 'Own artwork', setup: { baseline: null, catalogLock: { [catalog.id]: catalog.revisionId }, layers: [{ ...pin, checksum: catalog.checksum, title: 'Own source' }], mode: { state: 'unknown' }, ppCostsNonNegative: { state: 'unknown' }, slots: [] }, slots: [{ primaryClass: null, secondaryClass: null, equipment: [{ slotId: 'hand', ref }], equipmentGroups: [], passives: [] }], receipts: [{ ref, kind: 'item', name: entity.name, origin: { kind: 'catalog', projectId: catalog.id, sourceRevisionId: catalog.revisionId, ...pin, modelKey: 'crystal-edit:Equipment:9' } }] }
  expect(findPrivateArtwork(state, pin, entity)).toEqual(asset)
  expect(privateArtworkRegion(entity, asset)).toEqual({ x: 2, y: 2, width: 32, height: 32 })
  expect(enrichPublicSnapshot(snapshot, state).entries[0]?.artwork).toEqual(asset)
  expect(enrichPublicSnapshot(snapshot, state).entries[0]?.artworkSource).toEqual({ ...pin, entity })
  expect(enrichPublicSnapshot(snapshot, { ...state, assets: [asset, { ...asset, id: 'ambiguous-artwork' }] }).entries[0]?.artwork).toBeUndefined()
  expect(enrichPublicSnapshot(snapshot, { ...state, assets: [{ ...asset, sourceKey: asset.sourceKey.replace(catalog.revisionId, 'wrong-source-revision') }] }).entries[0]?.artwork).toBeUndefined()
})

async function calculationFixture(options: { separateClass?: boolean; otherLayer?: 'enabled' | 'disabled' } = {}) {
  const { DEFAULT_CATALOG } = await import('../catalog/bundled')
  const { previewCrystalEdit } = await import('./crystal-edit')
  const { buildBehavior, saveBuildBehavior } = await import('../domain/build-behavior')
  const { selectBuildModRevision, buildContentForModSetup } = await import('../domain/build-mods')
  const { createBuild, saveBuildRevision } = await import('../domain/builds')
  const { composeModCatalog, expandModCatalogs } = await import('../domain/mod-layers')
  const { defaultCalculation } = await import('../domain/calculation-plan')
  const { defaultBattleCalculation } = await import('../domain/battle-plan')
  const { NATIVE_DATA, PC_RULES } = await import('../domain/calculation-rules')
  const { SUGGESTED_BUILD_SLOTS } = await import('../domain/build-planning')
  const { createPublicSnapshot } = await import('./public-share')
  const modifier = (name: string, Value1: number, Value2 = 0, Value3 = 0) => ({ Tag: Number(Object.entries(PC_RULES.statMods).find(([, value]) => value.name === name)![0]), Value1, Value2, Value3 })
  const sourceInput = { ID: 'private-battle-source', Title: 'Private battle source', EditorVersion: 34,
    Jobs: [{ ...NATIVE_DATA.records.job.find(record => record.ID === 0)!, Name: 'Owned class', AbilityIDs: [9000], PassiveIDs: [...NATIVE_DATA.records.job.find(record => record.ID === 0)!.PassiveIDs, 9000] }],
    Abilities: [{ ...NATIVE_DATA.records.ability[0], ID: 9000, Name: 'Owned beam', IsBasic: false, MPCost: 16 }],
    Passives: [{ ID: 9000, Name: 'PRIVATE_INNATE', IsInnate: true, StatMods: [modifier('StatusAuto', 9000, 100, 255), modifier('Flat_AbilityMPCost', 9000, -5)] }],
    Statuses: [{ ID: 9000, Name: 'PRIVATE_STATUS', Category: 1, PersistsThroughDeath: true, ReApplyResistance: false, StatMods: [modifier('Flat_HP', 100)] }],
  }
  const imported = await previewCrystalEdit(new TextEncoder().encode(JSON.stringify(sourceInput)), 'private-synthetic.json')
  const other = options.otherLayer ? await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ...sourceInput, ID: 'private-other-source', Title: 'Other owned source' })), 'other-private-synthetic.json') : undefined
  const imports = other ? [imported, other] : [imported]
  const source = (options.otherLayer === 'enabled' ? other! : imported).proposed.catalogs[0]!, catalogs = [DEFAULT_CATALOG, ...imports.flatMap(value => value.proposed.catalogs)]
  const initial = createTestLocalData(), originalSetup = Object.values(initial.gameSetups)[0]!
  let behavior = selectBuildModRevision({ ...buildBehavior(originalSetup), slots: SUGGESTED_BUILD_SLOTS }, imported.proposed.catalogs[0]!, catalogs)
  if (other) behavior = selectBuildModRevision(behavior, other.proposed.catalogs[0]!, catalogs, options.otherLayer === 'enabled')
  if (options.separateClass) behavior = { ...behavior, modComposition: { ...behavior.modComposition!, links: behavior.modComposition!.links.map(link => link.modelKey === 'crystal-edit:Jobs:0' ? { ...link, targetEntityId: null } : link) } }
  const saved = saveBuildBehavior(initial, behavior), effective = expandModCatalogs([...catalogs, composeModCatalog(saved.setup, catalogs)!])
  const ref = (modelKey: string) => ({ kind: 'catalog' as const, catalogId: source.id, catalogRevisionId: source.revisionId, entityId: modModelEntity(source, modelKey)!.id })
  const primaryClass = ref('crystal-edit:Jobs:0'), ability = ref('crystal-edit:Abilities:9000')
  const content = buildContentForModSetup({ primaryClass, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: { ...defaultCalculation(primaryClass), ability, battle: defaultBattleCalculation() } }, saved.setup, effective)
  let localData = createBuild(saved.localData, { id: 'private-build' as never, gameSetupId: saved.setup.gameSetupId, title: 'Owned calculation' })
  localData = saveBuildRevision(localData, { buildId: 'private-build' as never, id: 'private-checkpoint' as never, gameSetupRevisionId: saved.setup.id, content })
  const { viewer: empty } = await fixture()
  const archives = imports.map((value, index) => {
    const { bytes, ...metadata } = value.proposed.sources[0]!
    const original = { documentId: `private-source-${index}`, revisionId: 'private-source-version', byteLength: bytes.length, sha256: metadata.digest, encoding: 'bytes' as const }
    return { source: { ...metadata, original }, blob: { ref: original, content: memoryBlob(bytes) } }
  })
  const viewer: WorkspaceState = { ...empty, planner: { ...empty.planner, localData, catalogs, sources: archives.map(value => value.source), evidence: imports.flatMap(value => value.proposed.evidence) }, blobs: archives.map(value => value.blob) }
  const snapshot = createPublicSnapshot({ planner: { localData, catalogs: effective } }, { kind: 'build', revisionId: 'private-checkpoint' as never }, { includeNotes: false })
  return { snapshot, viewer, source, setup: saved.setup }
}

async function previewCalculation(snapshot: PublicSnapshot, viewer: WorkspaceState) {
  const { resolveCalculationEntity } = await import('../ui/model')
  const { calculatePCStats } = await import('../domain/pc-stats')
  const { collectEffectiveModifiers } = await import('../domain/effective-modifiers')
  const { resolveGameRules } = await import('../domain/game-rules')
  const preview = publicReadOnlyPreview(snapshot, viewer), revision = preview.revisions[0]!, setup = preview.localData.gameSetups[revision.gameSetupRevisionId]!
  const resolve = (ref: import('../domain/types').EntityRef) => resolveCalculationEntity(preview.localData, preview.catalogs, ref, setup)
  return { preview, setup, stats: calculatePCStats(revision.content, setup.slots, resolve, [], false, resolveGameRules(setup, preview.catalogs)), modifiers: collectEffectiveModifiers(revision.content, setup.slots, resolve, { includeAutomaticStatuses: true }) }
}

it('resolves unknown origins only within the exact captured composition and preserves its calculations', async () => {
  const { snapshot, viewer } = await calculationFixture()
  const unknown = { ...snapshot, receipts: snapshot.receipts.map(receipt => ({ ...receipt, kind: null, origin: null, origins: undefined })) }
  const result = enrichPublicSnapshot(unknown, viewer)
  expect(result.resolved).toBe(true)
  expect(result.unresolvedCalculations).toBe(false)
  expect((await previewCalculation(unknown, viewer)).stats.neutral.HP).toBe(1344)
  const historical = JSON.parse(JSON.stringify(unknown).replaceAll(snapshot.receipts[0]!.ref.kind === 'catalog' ? snapshot.receipts[0]!.ref.catalogRevisionId : 'unreachable', `composition-v2:sha256:${'b'.repeat(64)}`)) as PublicSnapshot
  historical.setup = snapshot.setup
  expect(enrichPublicSnapshot(historical, viewer).entries[0]?.definition).toBeUndefined()
  expect(enrichPublicSnapshot(historical, viewer).unresolvedCalculations).toBe(true)
  expect(enrichPublicSnapshot(unknown, { ...viewer, blobs: [] }).resolved).toBe(true)
})

it('resolves unchanged native equipment inside the exact owned composition without an origin receipt', async () => {
  const { snapshot, viewer } = await calculationFixture()
  const baseline = viewer.planner.catalogs[0]!
  const equipment = Object.values(baseline.entities).find(entity => entity.kind === 'item')!
  const selected = snapshot.slots[0]!.primaryClass!
  if (selected.kind !== 'catalog') throw new Error('Expected composed catalog fixture')
  const ref = { ...selected, entityId: equipment.id }
  const unknown: PublicSnapshot = { ...snapshot, slots: [{ ...snapshot.slots[0]!, equipment: [{ slotId: 'plan-main-hand', ref }] }], receipts: [...snapshot.receipts, { ref, kind: null, origin: null, name: equipment.name }] }
  expect(enrichPublicSnapshot(unknown, viewer).entries.at(-1)?.definition).toEqual(equipment)
  const wrong = { ...unknown, receipts: unknown.receipts.map(receipt => receipt.ref === ref ? { ...receipt, kind: 'class' as const } : receipt) }
  expect(enrichPublicSnapshot(wrong, viewer).entries.at(-1)?.definition).toBeUndefined()
})

it('calculates owned class innates and automatic statuses from the exact captured private composition', async () => {
  const { snapshot, viewer } = await calculationFixture()
  const before = JSON.stringify(snapshot), viewerBefore = JSON.stringify(viewer)
  const result = await previewCalculation(snapshot, viewer)
  expect(result.stats.issues).toEqual([])
  expect(result.stats.neutral.HP).toBe(1344)
  expect(result.modifiers.stats.HP).toBe(100)
  expect(result.modifiers.abilityMP[9000]).toBe(-5)
  expect(result.modifiers.automaticStatuses[0]).toMatchObject({ id: 9000, applied: true })
  expect(JSON.stringify(snapshot)).toBe(before)
  expect(JSON.stringify(viewer)).toBe(viewerBefore)
  for (const privateBody of ['PRIVATE_INNATE', 'PRIVATE_STATUS', 'StatMods', 'identityMappings', 'private-synthetic.json']) expect(before).not.toContain(privateBody)
})

it('keeps calculations unknown when matching files lack the exact captured private composition', async () => {
  const { snapshot, viewer, setup } = await calculationFixture()
  const { [setup.id]: _captured, ...withoutCaptured } = viewer.planner.localData.gameSetups
  const recipient = { ...viewer, planner: { ...viewer.planner, localData: { ...viewer.planner.localData, gameSetups: withoutCaptured } } }
  const enriched = enrichPublicSnapshot(snapshot, recipient)
  expect(enriched.resolved).toBe(true)
  expect(enriched.unresolvedCalculations).toBe(true)
  const result = await previewCalculation(snapshot, recipient)
  expect(result.stats.neutral.HP).toBeNull()
  expect(result.stats.issues.length).toBeGreaterThan(0)
})

it.each(['missing-body', 'changed-source', 'other-project'] as const)('cannot borrow transitive mechanics from %s despite a captured composition', async availability => {
  const { snapshot, viewer, source } = await calculationFixture()
  const recipient = availability === 'missing-body' ? withCatalogs(viewer, viewer.planner.catalogs.filter(catalog => catalog !== source)) : withCatalogs(viewer, viewer.planner.catalogs.map(catalog => catalog !== source ? catalog : availability === 'changed-source' ? { ...catalog, revisionId: 'changed-source' as never, checksum: `sha256:${'b'.repeat(64)}` } : { ...catalog, id: 'other-project' as never }))
  expect(enrichPublicSnapshot(snapshot, recipient).unresolvedCalculations).toBe(true)
  expect((await previewCalculation(snapshot, recipient)).stats.neutral.HP).toBeNull()
})

it('preserves an authored separate-class link instead of inferring a native replacement', async () => {
  const { snapshot, viewer, setup } = await calculationFixture({ separateClass: true })
  const result = await previewCalculation(snapshot, viewer), selected = result.preview.revisions[0]!.content.primaryClass!
  expect(result.setup.modComposition).toEqual(setup.modComposition)
  expect(result.setup.modComposition!.links).toContainEqual({ modelKey: 'crystal-edit:Jobs:0', targetEntityId: null })
  expect(selected.kind === 'catalog' && selected.entityId).not.toBe('base:job:0')
  expect(result.stats.neutral.HP).toBe(1344)
})

it('keeps colliding added passive, ability, and status IDs in the captured project scope', async () => {
  const { snapshot, viewer } = await calculationFixture({ otherLayer: 'enabled' })
  const result = await previewCalculation(snapshot, viewer)
  expect(result.stats.issues).toEqual([])
  expect(result.stats.neutral.HP).toBe(1344)
  expect(result.modifiers.abilityMP[9001]).toBe(-5)
  expect(result.modifiers.abilityMP[9000]).toBeUndefined()
  expect(result.modifiers.automaticStatuses[0]).toMatchObject({ id: 9001, applied: true })
})

it('requires the exact owned disabled layers that reserve captured composition identities', async () => {
  const { snapshot, viewer, setup } = await calculationFixture({ otherLayer: 'disabled' })
  expect(snapshot.setup.layers.map(layer => layer.enabled)).toEqual([true, false])
  expect((await previewCalculation(snapshot, viewer)).stats.neutral.HP).toBe(1344)
  const disabled = setup.modComposition!.layers.find(layer => !layer.enabled)!
  const recipient = withCatalogs(viewer, viewer.planner.catalogs.filter(catalog => catalog.id !== disabled.catalogId))
  expect(enrichPublicSnapshot(snapshot, recipient).resolved).toBe(false)
  expect(enrichPublicSnapshot(snapshot, recipient).unresolvedCalculations).toBe(true)
  expect((await previewCalculation(snapshot, recipient)).stats.neutral.HP).toBeNull()
})

it('keeps retained raw-source selections inert before rebinding the active composition', async () => {
  const { snapshot, viewer, source } = await calculationFixture()
  const receipt = snapshot.receipts.find(receipt => receipt.kind === 'class')!
  const raw = { kind: 'catalog' as const, catalogId: source.id, catalogRevisionId: source.revisionId, entityId: modModelEntity(source, 'crystal-edit:Jobs:0')!.id }
  const retained = JSON.parse(JSON.stringify(snapshot).replaceAll(JSON.stringify(receipt.ref), JSON.stringify(raw))) as PublicSnapshot
  const inactive = { ...retained, receipts: retained.receipts.map(receipt => receipt.kind === 'class' ? { ...receipt, origin: { ...receipt.origin!, kind: 'catalog' as const, catalogId: raw.catalogId, catalogRevisionId: raw.catalogRevisionId } } : receipt) }
  const result = await previewCalculation(inactive, viewer), content = result.preview.revisions[0]!.content
  expect(content.primaryClass).toEqual(raw)
  expect(content.retainedSelections?.refs).toContainEqual(raw)
  expect(result.stats.neutral.HP).toBeNull()
})

it('rejects a viewer composition with the same sources but different authored links', async () => {
  const { snapshot, viewer, setup } = await calculationFixture()
  const changed = { ...setup, modComposition: { ...setup.modComposition!, links: setup.modComposition!.links.map(link => link.modelKey === 'crystal-edit:Jobs:0' ? { ...link, targetEntityId: null } : link) } }
  const recipient = { ...viewer, planner: { ...viewer.planner, localData: { ...viewer.planner.localData, gameSetups: { ...viewer.planner.localData.gameSetups, [setup.id]: changed } } } }
  expect(enrichPublicSnapshot(snapshot, recipient).resolved).toBe(true)
  expect(enrichPublicSnapshot(snapshot, recipient).unresolvedCalculations).toBe(true)
  expect((await previewCalculation(snapshot, recipient)).stats.neutral.HP).toBeNull()
})

it('rejects a contributor claim that disagrees with the exact captured composition', async () => {
  const { snapshot, viewer } = await calculationFixture()
  const forged = structuredClone(snapshot), receipt = forged.receipts.find(value => value.kind === 'class')!
  const baseline = snapshot.setup.baseline!
  receipt.origins = { mechanical: { kind: 'catalog', ...baseline, entityId: 'base:job:0' }, text: { kind: 'catalog', ...baseline, entityId: 'base:job:0' } }
  receipt.origin = { kind: 'catalog', projectId: baseline.catalogId, sourceRevisionId: baseline.catalogRevisionId, catalogId: receipt.ref.kind === 'catalog' ? receipt.ref.catalogId : '', catalogRevisionId: receipt.ref.kind === 'catalog' ? receipt.ref.catalogRevisionId : '' }
  expect(enrichPublicSnapshot(forged, viewer).entries.find(entry => entry.receipt.kind === 'class')?.definition).toBeUndefined()
})
