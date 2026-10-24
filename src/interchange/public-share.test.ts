import { describe, expect, it } from 'vitest'
import { deflateSync } from 'fflate'
import { addTestBuild, addTestDefinition, createTestLocalData, HAND_SLOT, SECOND_HAND_SLOT, personalRef } from '../domain/test-helpers'
import { createPublicSnapshot, encodePublicSnapshot, decodePublicSnapshot } from './public-share'
import { validatePublicSnapshot } from './public-share-schema'

function fixture() {
  let localData = addTestDefinition(createTestLocalData(), 'private-object-id')
  localData = addTestDefinition(localData, 'unselected-secret')
  localData = addTestBuild(localData, 'build', '', { [HAND_SLOT]: { ref: personalRef('private-object-id'), allocationId: 'PRIVATE_ALLOCATION' }, [SECOND_HAND_SLOT]: { ref: personalRef('private-object-id'), allocationId: 'PRIVATE_ALLOCATION' } })
  const definition = localData.personalDefinitions['private-object-id']!
  localData = { ...localData, personalDefinitions: { ...localData.personalDefinitions, [definition.id]: { ...definition, name: 'Selected sword', rawDescription: 'PRIVATE_EFFECT', fields: { private: { state: 'known', value: 'PRIVATE_ARTWORK' } }, sources: [{ sourceId: 'PRIVATE_FILENAME.json' }] } } }
  return { planner: { localData, catalogs: [] } } satisfies Parameters<typeof createPublicSnapshot>[0]
}
const target = { kind: 'build' as const, revisionId: 'build-revision' as never }
const snapshot = () => createPublicSnapshot(fixture(), target, { includeNotes: false })

describe('public receipt snapshots', () => {
  it('publicProjectionContainsOnlySelectedDisplayReceipts', () => {
    const state = fixture(), original = structuredClone(state)
    const value = createPublicSnapshot(state, target, { includeNotes: false })
    expect(value.version).toBe(5)
    expect(value.receipts).toHaveLength(1)
    expect(value.receipts[0]?.name).toBe('Selected sword')
    const json = JSON.stringify(value)
    for (const secret of ['PRIVATE_EFFECT', 'PRIVATE_FILENAME', 'PRIVATE_ARTWORK', 'PRIVATE_ALLOCATION', 'private-object-id', 'unselected-secret', 'playthrough', 'build-revision']) expect(json).not.toContain(secret)
    expect(value.notes).toBeUndefined()
    expect(value.slots[0]?.equipmentGroups).toEqual([['hand', 'second-hand']])
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(256 * 1024)
    expect(decodePublicSnapshot(encodePublicSnapshot(value))).toEqual(value)
    expect(state).toEqual(original)
  })

  it('preserves distinct same-item intent and omits singleton allocation IDs', () => {
    const state = fixture(), revision = state.planner.localData.buildRevisions['build-revision']!
    const localData = { ...state.planner.localData, buildRevisions: { ...state.planner.localData.buildRevisions, [revision.id]: { ...revision, content: { ...revision.content, equipment: { hand: { ref: personalRef('private-object-id'), allocationId: 'PRIVATE_A' }, 'second-hand': { ref: personalRef('private-object-id'), allocationId: 'PRIVATE_B' } } } } } }
    const value = createPublicSnapshot({ ...state, planner: { ...state.planner, localData } }, target, { includeNotes: false })
    expect(value.slots[0]?.equipmentGroups).toEqual([])
    expect(JSON.stringify(value)).not.toContain('PRIVATE_')
  })

  it('strictSchemaRejectsUnknownNestedFields', () => {
    const value = snapshot(), slot = value.slots[0]!
    for (const invalid of [
      { ...value, sourceArchive: 'secret' },
      { ...value, setup: { ...value.setup, gameRules: {} } },
      { ...value, slots: [{ ...slot, equipment: [{ ...slot.equipment[0], allocationId: 'secret' }] }] },
      { ...value, receipts: [{ ...value.receipts[0], description: 'secret' }] },
      { ...value, slots: [{ ...slot, calculation: { level: Infinity, growth: [], bonuses: [], statuses: [] } }] },
      { ...value, title: 'x'.repeat(1025) },
      JSON.parse(JSON.stringify(value).replace('"version":5', '"version":5,"__proto__":{}')),
    ]) expect(() => validatePublicSnapshot(invalid)).toThrow()
  })

  it('shares only the Team-owned member name and preserves it through isolated copy and resharing', async () => {
    const { saveSharedTeam } = await import('../domain/team-checkpoints')
    const { preparePublicSnapshotCopy } = await import('./public-share-enrichment')
    const state = fixture(), data = state.planner.localData
    const source = data.buildRevisions[target.revisionId]!
    const localData = saveSharedTeam(data, { id: 'named-team' as never, title: 'Named Team', gameSetupRevisionId: source.gameSetupRevisionId, slots: [{ id: 'named-slot' as never, name: 'Aster', content: source.content, sourceBuildRevisionId: source.id, createdAt: source.createdAt }, null, null, null] })
    const named = createPublicSnapshot({ planner: { ...state.planner, localData } }, { kind: 'team', teamId: 'named-team' as never }, { includeNotes: false })
    expect(named.slots[0]?.name).toBe('Aster')
    expect(named.notes).toBeUndefined()
    expect(JSON.stringify(named)).not.toContain('private-object-id')
    expect(decodePublicSnapshot(encodePublicSnapshot(named))).toEqual(named)
    const viewerData = createTestLocalData()
    const copied = preparePublicSnapshotCopy({ planner: { localData: viewerData, catalogs: [], sources: [], evidence: [], lineage: { rootLocalDataId: viewerData.id }, history: [] }, editorDocuments: [], saveDocuments: [], assets: [], blobs: [], libraryDefaults: { version: 1, layers: [] }, conflicts: [], retainedContent: [] }, named)
    const copiedName = createPublicSnapshot(copied.state, { kind: 'team', teamId: copied.result.teamId! }, { includeNotes: false })
    expect(copiedName).toEqual(named)
    const old = { ...named, slots: [{ ...named.slots[0]!, name: undefined }, null, null, null] }
    expect(() => validatePublicSnapshot(old)).not.toThrow()
    expect(() => validatePublicSnapshot({ ...named, slots: [{ ...named.slots[0], name: 'x'.repeat(1025) }, null, null, null] })).toThrow()
    expect(() => validatePublicSnapshot({ ...snapshot(), slots: [{ ...snapshot().slots[0], name: 'PRIVATE_BUILD_TITLE' }] })).toThrow()
  })

  it.each([{ equipmentGroups: [['hand']] }, { equipmentGroups: [['hand', 'hand']] }, { equipmentGroups: [['hand', 'missing']] }, { equipmentGroups: [['hand', 'second-hand'], ['hand', 'second-hand']] }])('rejects malformed equipment groups %j', ({ equipmentGroups }) => {
    const value = snapshot()
    expect(() => validatePublicSnapshot({ ...value, slots: [{ ...value.slots[0], equipmentGroups }] })).toThrow()
  })

  it('rejects compressed expansion beyond the declared output length', () => {
    const packed = deflateSync(new TextEncoder().encode(' '.repeat(2 * 1024 * 1024)))
    const envelope = new Uint8Array(4 + packed.length)
    new DataView(envelope.buffer).setUint32(0, 2)
    envelope.set(packed, 4)
    const encoded = btoa(String.fromCharCode(...envelope)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    expect(() => decodePublicSnapshot(encoded)).toThrow()
  })
})

it('personalOverrideCannotSmugglePrivateMechanics', () => {
  const state = fixture(), data = state.planner.localData, revision = data.buildRevisions['build-revision']!, setup = data.gameSetups[revision.gameSetupRevisionId]!
  const base = { kind: 'catalog' as const, catalogId: 'native' as never, catalogRevisionId: 'native-v1' as never, entityId: 'sword' as never }
  const definition = data.personalDefinitions['private-object-id']!
  const localData = { ...data, personalDefinitions: { ...data.personalDefinitions, [definition.id]: { ...definition, baseRef: base } }, gameSetups: { ...data.gameSetups, [setup.id]: { ...setup, definitionOverrides: [personalRef(definition.id)] } }, buildRevisions: { ...data.buildRevisions, [revision.id]: { ...revision, content: { ...revision.content, equipment: { hand: { ref: base } } } } } }
  const value = createPublicSnapshot({ ...state, planner: { ...state.planner, localData } }, target, { includeNotes: false })
  expect(value.slots[0]!.equipment[0]!.ref?.kind).toBe('personal')
  expect(value.receipts[0]!.name).toBe('Selected sword')
  expect(JSON.stringify(value)).not.toContain('PRIVATE_')
  expect(JSON.stringify(value)).not.toContain('private-object-id')
})

it('keeps saved out-of-context selections inert, including removed occupied slots', () => {
  const state = fixture(), data = state.planner.localData, revision = data.buildRevisions['build-revision']!, setup = data.gameSetups[revision.gameSetupRevisionId]!
  const localData = { ...data, gameSetups: { ...data.gameSetups, [setup.id]: { ...setup, slots: [] } }, buildRevisions: { ...data.buildRevisions, [revision.id]: { ...revision, content: { ...revision.content, retainedSelections: { refs: [personalRef('private-object-id')], slotIds: [HAND_SLOT, SECOND_HAND_SLOT] } } } } }
  const value = createPublicSnapshot({ ...state, planner: { ...state.planner, localData } }, target, { includeNotes: false })
  expect(value.setup.slots).toEqual([])
  expect(value.slots[0]!.equipment.map(entry => entry.slotId)).toEqual(['hand', 'second-hand'])
  expect(JSON.stringify(value)).not.toContain('retainedSelections')
})

it('requires every ability and status receipt and preserves unknown inputs without private fields', async () => {
  const { defaultBattleCalculation } = await import('../domain/battle-plan')
  const state = fixture(), data = state.planner.localData, revision = data.buildRevisions['build-revision']!
  let localData = addTestDefinition(addTestDefinition(data, 'private-ability', { kind: 'ability' }), 'private-status', { kind: 'status' })
  localData = { ...localData, buildRevisions: { ...localData.buildRevisions, [revision.id]: { ...revision, content: { ...revision.content, calculation: { level: null, growth: [], bonuses: [], statuses: [personalRef('private-status')], ability: personalRef('private-ability'), battle: { ...defaultBattleCalculation(), statuses: [{ ref: personalRef('private-status'), count: null }], user: { hp: null, mp: 7, ap: null } } } } } } }
  const value = createPublicSnapshot({ ...state, planner: { ...state.planner, localData } }, target, { includeNotes: false })
  expect(value.receipts.map(receipt => receipt.kind).sort()).toEqual(['ability', 'item', 'status'])
  expect(value.slots[0]!.calculation!.battle!.user).toEqual({ hp: null, mp: 7, ap: null })
  expect(value.slots[0]!.calculation!.battle!.statuses[0]!.count).toBeNull()
  expect(() => validatePublicSnapshot({ ...value, receipts: value.receipts.slice(1) })).toThrow('receipt')
})

it('includes user notes only through explicit opt-in and rejects overlong content without truncation', () => {
  const state = fixture(), revision = state.planner.localData.buildRevisions['build-revision']!
  const localData = { ...state.planner.localData, buildRevisions: { ...state.planner.localData.buildRevisions, [revision.id]: { ...revision, note: 'Deliberate checkpoint note', content: { ...revision.content, rotationNotes: '<script>inert user note</script>', contextAssumptions: ['A user assumption'] } } } }
  const input = { ...state, planner: { ...state.planner, localData } }
  expect(createPublicSnapshot(input, target, { includeNotes: false }).notes).toBeUndefined()
  expect(createPublicSnapshot(input, target, { includeNotes: true }).notes?.slots[0]).toEqual({ checkpoint: 'Deliberate checkpoint note', rotationNotes: '<script>inert user note</script>', contextAssumptions: ['A user assumption'] })
  const value = snapshot()
  expect(() => validatePublicSnapshot({ ...value, notes: { slots: [{ contextAssumptions: ['x'.repeat(16385)] }] } })).toThrow(/overlong|16384/)
  expect(() => validatePublicSnapshot({ ...value, slots: [{ ...value.slots[0], passives: Array.from({ length: 65 }, () => value.receipts[0]!.ref) }] })).toThrow()
})

it('uses the selected Team checkpoint independent pins, ordered empties and original content', async () => {
  const { saveSharedTeam } = await import('../domain/team-checkpoints')
  const state = fixture(), data = state.planner.localData, setup = Object.values(data.gameSetups)[0]!
  let localData = saveSharedTeam(data, { id: 'team' as never, title: 'Historical Team', gameSetupRevisionId: setup.id, catalogLock: {}, slots: [target.revisionId, null, target.revisionId, null] })
  const team = localData.teams.team!
  if (team.kind !== 'shared') throw new Error('Expected shared Team')
  const old = localData.teamRevisions[team.latestRevisionId]!
  localData = saveSharedTeam(localData, { id: team.id, title: team.title, gameSetupRevisionId: setup.id, slots: [null, null, null, null] })
  localData = { ...localData, gameSetups: { ...localData.gameSetups, [setup.id]: { ...setup, catalogLock: { wrong: 'latest-setup-default' as never } } } }
  const before = structuredClone(localData)
  const value = createPublicSnapshot({ ...state, planner: { ...state.planner, localData } }, { kind: 'team', teamId: team.id, teamRevisionId: old.id }, { includeNotes: false })
  expect(value.slots.map(slot => slot !== null)).toEqual([true, false, true, false])
  expect(value.setup.baseline).toBeNull()
  expect(value.setup.layers).toEqual([])
  expect(JSON.stringify(value)).not.toContain('latest-setup-default')
  expect(localData).toEqual(before)
  expect(() => validatePublicSnapshot({ ...value, slots: value.slots.slice(1) })).toThrow('four')
})

it('round-trips a representative four-member modded Team with source identity and no source bodies', async () => {
  const { syntheticModLayers } = await import('../domain/mod-layers.test-helpers')
  const { addGameSetupRevision, saveBuildRevision, createBuild } = await import('../domain')
  const { saveSharedTeam } = await import('../domain/team-checkpoints')
  const { prepareModCatalogs } = await import('../persistence')
  const { catalogs: sources, composition } = await syntheticModLayers()
  const state = fixture(), original = Object.values(state.planner.localData.gameSetups)[0]!
  let localData = addGameSetupRevision(state.planner.localData, { ...original, id: 'private-setup' as never, label: 'Modded', modComposition: composition, catalogLock: { [composition.baseline.catalogId]: 'mod-setup:private-setup' as never }, now: original.createdAt })
  const catalogs = await prepareModCatalogs(localData, sources)
  const mod = catalogs.find(catalog => catalog.revisionId === 'mod-setup:private-setup')!
  const selected = Object.values(mod.entities).find(entity => entity.name === 'Second Fighter')!
  localData = createBuild(localData, { id: 'mod-build' as never, title: 'Mod Build', gameSetupId: original.gameSetupId })
  localData = saveBuildRevision(localData, { id: 'mod-build-rev' as never, buildId: 'mod-build' as never, gameSetupRevisionId: 'private-setup' as never, content: { primaryClass: { kind: 'catalog', catalogId: mod.id, catalogRevisionId: mod.revisionId, entityId: selected.id }, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] } })
  localData = saveSharedTeam(localData, { id: 'mod-team' as never, title: 'Mod Team', gameSetupRevisionId: 'private-setup' as never, slots: Array(4).fill('mod-build-rev') })
  const value = createPublicSnapshot({ ...state, planner: { ...state.planner, localData, catalogs } }, { kind: 'team', teamId: 'mod-team' as never }, { includeNotes: false })
  expect(value.slots).toHaveLength(4)
  expect(value.setup.layers.map(layer => layer.title)).toEqual(['Layer A', 'Layer B'])
  expect(value.receipts[0]!.name).toBe('Second Fighter')
  expect(decodePublicSnapshot(encodePublicSnapshot(value))).toEqual(value)
  for (const secret of ['private-setup', 'HPRating', 'gameRules', 'rawDescription', 'EquipmentTypes', 'a.json']) expect(JSON.stringify(value)).not.toContain(secret)
})

it('rejects private path identities, unknown eligibility and receipt identity substitutions', () => {
  const value = snapshot(), receipt = value.receipts[0]!
  for (const changed of [
    { ...receipt, eligibility: 'unknown' },
    { ...receipt, origin: { ...receipt.origin, projectId: '/private/source.json' } },
    { ...receipt, origin: { ...receipt.origin, catalogRevisionId: 'other' } },
    { ...receipt, fingerprint: { kind: 'personal-definition-v1', value: '0'.repeat(64) } },
  ]) expect(() => validatePublicSnapshot({ ...value, receipts: [changed] })).toThrow()
})

it('enforces byte, depth and node budgets before schema parsing and URL budget before encoding', () => {
  const value = snapshot()
  let deep: unknown = null
  for (let index = 0; index < 34; index++) deep = [deep]
  expect(() => validatePublicSnapshot({ ...value, deep })).toThrow('depth')
  expect(() => validatePublicSnapshot({ ...value, nodes: Array(20_001).fill(null) })).toThrow('node')
  expect(() => validatePublicSnapshot({ ...value, notes: { slots: [{ contextAssumptions: Array(17).fill('x'.repeat(16384)) }] } })).toThrow('256 KiB')
  const tooLongForLink = validatePublicSnapshot({ ...value, notes: { slots: [{ contextAssumptions: Array(4).fill('x'.repeat(16384)) }] } })
  expect(() => encodePublicSnapshot(tooLongForLink)).toThrow('too large for a portable link')
})

it('preserves explicitly invalid mixed-item grouping for normal reporting without inferring mechanics', () => {
  const state = fixture(), data = addTestDefinition(state.planner.localData, 'different-item'), revision = data.buildRevisions['build-revision']!
  const localData = { ...data, buildRevisions: { ...data.buildRevisions, [revision.id]: { ...revision, content: { ...revision.content, equipment: { hand: { ref: personalRef('private-object-id'), allocationId: 'PRIVATE_GROUP' }, 'second-hand': { ref: personalRef('different-item'), allocationId: 'PRIVATE_GROUP' } } } } } }
  const value = createPublicSnapshot({ ...state, planner: { ...state.planner, localData } }, target, { includeNotes: false })
  expect(value.slots[0]!.equipmentGroups).toEqual([['hand', 'second-hand']])
  expect(value.slots[0]!.equipment[0]!.ref).not.toEqual(value.slots[0]!.equipment[1]!.ref)
})

it('consumes T01 unavailable personal receipts without recovering old mechanics or private IDs', () => {
  const state = fixture(), data = state.planner.localData
  const localData = { ...data, personalDefinitions: {}, unavailableDefinitions: [{ ref: personalRef('private-object-id'), kind: 'item' as const, name: 'Unavailable selected sword', fingerprint: { kind: 'personal-definition-v1' as const, value: 'a'.repeat(64) } }] }
  const value = createPublicSnapshot({ ...state, planner: { ...state.planner, localData } }, target, { includeNotes: false })
  expect(value.receipts[0]!.ref).toEqual({ kind: 'personal', fingerprint: { kind: 'personal-definition-v1', value: 'a'.repeat(64) } })
  expect(value.receipts[0]!.name).toBe('Unavailable selected sword')
  expect(JSON.stringify(value)).not.toContain('private-object-id')
})

it('personal content identity ignores private provenance but distinguishes opaque fields named sources', async () => {
  const { publicPersonalDefinitionFingerprint } = await import('./public-share')
  const data = fixture().planner.localData, original = data.personalDefinitions['private-object-id']!
  const identity = publicPersonalDefinitionFingerprint(data, original.id)
  const renamed = { ...original, id: 'other-private-id' as never, sources: [{ sourceId: 'different-private-file' }] }
  const equivalent = { ...data, personalDefinitions: { [renamed.id]: renamed } }
  expect(publicPersonalDefinitionFingerprint(equivalent, renamed.id)).toBe(identity)
  const changed = { ...original, fields: { ...original.fields, sources: { state: 'known' as const, value: { sources: 'mechanical-value' } } } }
  expect(publicPersonalDefinitionFingerprint({ ...data, personalDefinitions: { [original.id]: changed } }, original.id)).not.toBe(identity)
})

async function composedOriginFixture() {
  const { syntheticModLayers } = await import('../domain/mod-layers.test-helpers')
  const { addGameSetupRevision, saveBuildRevision, createBuild } = await import('../domain')
  const { prepareModCatalogs } = await import('../persistence')
  const { withBuildReferenceNames, modSourceReceipts } = await import('../domain/build-reference-names')
  const { catalogs: sources, composition } = await syntheticModLayers()
  const original = fixture().planner.localData, setup = Object.values(original.gameSetups)[0]!
  let localData = addGameSetupRevision(original, { ...setup, id: 'origin-setup' as never, modComposition: composition, catalogLock: { [composition.baseline.catalogId]: 'mod-setup:origin-setup' as never }, now: setup.createdAt })
  const catalogs = await prepareModCatalogs(localData, sources), composed = catalogs.find(value => value.revisionId === 'mod-setup:origin-setup')!
  const selected = Object.values(composed.entities).find(value => value.name === 'Second Fighter')!
  const content = withBuildReferenceNames({ primaryClass: { kind: 'catalog' as const, catalogId: composed.id, catalogRevisionId: composed.revisionId, entityId: selected.id }, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] }, catalogs)
  const capturedSetup = localData.gameSetups['origin-setup']!
  localData = { ...localData, gameSetups: { ...localData.gameSetups, [capturedSetup.id]: { ...capturedSetup, modSourceReceipts: modSourceReceipts(capturedSetup, catalogs) } } }
  localData = createBuild(localData, { id: 'origin-build' as never, title: 'Origin Build', gameSetupId: setup.gameSetupId })
  localData = saveBuildRevision(localData, { id: 'origin-build-revision' as never, buildId: 'origin-build' as never, gameSetupRevisionId: capturedSetup.id, content })
  return { localData, catalogs, composed, sources, target: { kind: 'build' as const, revisionId: 'origin-build-revision' as never } }
}

it('preserves a saved exact Layer B origin when only the real composed catalog remains', async () => {
  const { localData, catalogs, composed, sources, target } = await composedOriginFixture()
  const before = structuredClone(localData)
  const complete = createPublicSnapshot({ planner: { localData, catalogs } }, target, { includeNotes: false })
  const reduced = createPublicSnapshot({ planner: { localData, catalogs: [composed] } }, target, { includeNotes: false })
  expect(reduced.receipts[0]!.origin).toEqual(complete.receipts[0]!.origin)
  expect(reduced.receipts[0]!.origin).toMatchObject({ projectId: sources[2]!.id, sourceRevisionId: sources[2]!.revisionId, modelKey: 'crystal-edit:Jobs:0' })
  expect(localData).toEqual(before)
})

it.each(['missing', 'ambiguous'] as const)('rejects %s composed source origin instead of substituting baseline', async mode => {
  const { localData, composed, sources, target } = await composedOriginFixture()
  const revision = localData.buildRevisions[target.revisionId]!, saved = revision.content.referenceNames![0]!
  const referenceNames = mode === 'missing' ? [] : [saved, { ...saved, projectId: sources[1]!.id }]
  const changed = { ...localData, buildRevisions: { ...localData.buildRevisions, [revision.id]: { ...revision, content: { ...revision.content, referenceNames } } } }
  expect(() => createPublicSnapshot({ planner: { localData: changed, catalogs: [composed] } }, target, { includeNotes: false })).toThrow(/exact source origin|ambiguous source origin/)
})

it('publishes a genuine unchanged native entry from a composed catalog only with exact baseline evidence', async () => {
  const { localData, composed, sources, target } = await composedOriginFixture()
  const native = Object.values(sources[0]!.entities).find(value => value.kind === 'class' && JSON.stringify(value) === JSON.stringify(composed.entities[value.id]))!
  expect(native).toBeDefined()
  const revision = localData.buildRevisions[target.revisionId]!
  const changed = { ...localData, buildRevisions: { ...localData.buildRevisions, [revision.id]: { ...revision, content: { ...revision.content, referenceNames: [], primaryClass: { kind: 'catalog' as const, catalogId: composed.id, catalogRevisionId: composed.revisionId, entityId: native.id } } } } }
  const value = createPublicSnapshot({ planner: { localData: changed, catalogs: [composed, sources[0]!] } }, target, { includeNotes: false })
  expect(value.receipts[0]!.origin).toMatchObject({ projectId: sources[0]!.id, sourceRevisionId: sources[0]!.revisionId })
  expect(() => createPublicSnapshot({ planner: { localData: changed, catalogs: [composed] } }, target, { includeNotes: false })).toThrow(/exact source origin/)
})

it('rejects conflicting saved origins for the same selected identity across Team slots', async () => {
  const { saveSharedTeam } = await import('../domain/team-checkpoints')
  const { localData: initial, composed, sources, target } = await composedOriginFixture()
  let localData = saveSharedTeam(initial, { id: 'origin-team' as never, title: 'Origin Team', gameSetupRevisionId: 'origin-setup' as never, slots: [target.revisionId, target.revisionId, null, null] })
  const team = localData.teams['origin-team']!
  if (team.kind !== 'shared') throw new Error('Expected shared Team')
  const checkpoint = localData.teamRevisions[team.latestRevisionId]!, member = checkpoint.slots[1]!, saved = member.content.referenceNames![0]!
  localData = { ...localData, teamRevisions: { ...localData.teamRevisions, [checkpoint.id]: { ...checkpoint, slots: [checkpoint.slots[0], { ...member, content: { ...member.content, referenceNames: [{ ...saved, projectId: sources[1]!.id }] } }, null, null] } } }
  expect(() => createPublicSnapshot({ planner: { localData, catalogs: [composed] } }, { kind: 'team', teamId: team.id }, { includeNotes: false })).toThrow(/ambiguous source origin/)
})

it('publishes the exact effective lock even for an empty Team independently of setup defaults', async () => {
  const { saveSharedTeam } = await import('../domain/team-checkpoints')
  const state = fixture(), original = Object.values(state.planner.localData.gameSetups)[0]!
  const localData = saveSharedTeam(state.planner.localData, { id: 'empty-team' as never, title: 'Empty historical Team', gameSetupRevisionId: original.id, catalogLock: { native: 'historical-native' as never }, slots: [null, null, null, null] })
  const value = createPublicSnapshot({ planner: { localData, catalogs: [] } }, { kind: 'team', teamId: 'empty-team' as never }, { includeNotes: false })
  expect(value.setup).toHaveProperty('catalogLock', { native: 'historical-native' })
})
