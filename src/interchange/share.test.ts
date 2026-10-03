import { savedCatalogVersion } from '../domain/legacy-definition.test-helpers'
import { describe, expect, it } from 'vitest'
import { deflateSync } from 'fflate'
import { addGameSetupRevision, asId, createBuild, revisePersonalDefinition, createPersonalDefinition, createScenario, requirePlaythrough, saveBuildRevision, updateGameSetupRevision } from '../domain'
import { syntheticModLayers } from '../domain/mod-layers.test-helpers'
import { prepareModCatalogs } from '../persistence'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { addTestBuild, addTestDefinition, addTestScenario, createTestLocalData, HAND_SLOT, personalRef, TEST_GAME_SETUP_REVISION_ID, TEST_NOW } from '../domain/test-helpers'
import { createSampleLocalData } from '../domain/sample-data'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import type { BuildId, BuildRevisionId, EntityId, GameSetupRevision, PersonalDefinitionId, ScenarioId } from '../domain'
import { MAX_SHORT_TEXT_LENGTH } from '../domain/limits'
import { defaultCalculation } from '../domain/calculation-plan'
import { validateNativeLocalDataGraph } from './native'
import { createSharePayload, createShareUrl, decodeSharePayload, encodeSharePayload, MAX_SHARE_JSON_BYTES, MAX_SHARE_URL_LENGTH, saveSharedCopy, SHARE_ROUTE_PREFIX, sharePreviewData, validateSharePayload } from './share'

const MOD_CATALOG_GRAPH_TIMEOUT_MS = 30_000

function fixture() {
  let data = addTestDefinition(createTestLocalData(), 'sword')
  data = addTestDefinition(data, 'unrelated-private-definition')
  data = addTestBuild(data, 'build', '', { [HAND_SLOT]: { ref: personalRef('sword'), allocationId: 'one-copy' } })
  return data
}

function variedText(length: number, seed = 1234567): string {
  let state = seed
  return Array.from({ length }, () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return String.fromCharCode(32 + Math.floor(state / 2 ** 32 * 95)) }).join('')
}

function envelope(json: string, claimedLength = new TextEncoder().encode(json).length): string {
  const packed = deflateSync(new TextEncoder().encode(json))
  const bytes = new Uint8Array(4 + packed.length)
  new DataView(bytes.buffer).setUint32(0, claimedLength)
  bytes.set(packed, 4)
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

describe('sharing snapshots', () => {
  it('continues to decode version 1 links with their original pinned behavior', () => {
    const payload = { ...createSharePayload(fixture(), { kind: 'build', revisionId: asId<BuildRevisionId>('build-revision') }), version: 1 as const }
    expect(decodeSharePayload(encodeSharePayload(payload))).toEqual(payload)
  })

  it.each([1, 2])('discards obsolete Build classifications from version %s links', version => {
    const current = createSharePayload(fixture(), { kind: 'build', revisionId: asId<BuildRevisionId>('build-revision') })
    const builds = Object.fromEntries(Object.entries(current.records.builds).map(([id, { archived: _archived, ...build }]) => [id, { ...build, kind: 'template', state: 'hypothetical' }]))
    const decoded = decodeSharePayload(envelope(JSON.stringify({ ...current, version, records: { ...current.records, builds } })))
    expect(decoded.records.builds).toEqual(current.records.builds)
    expect(decoded.records.buildRevisions).toEqual(current.records.buildRevisions)
  })

  it('writes only the current Build shape and rejects classifications in version 3', () => {
    const payload = createSharePayload(fixture(), { kind: 'build', revisionId: asId<BuildRevisionId>('build-revision') })
    expect(payload.version).toBe(3)
    expect(payload.records.builds.build).toHaveProperty('archived', false)
    expect(payload.records.builds.build).not.toHaveProperty('kind')
    expect(payload.records.builds.build).not.toHaveProperty('state')
    const builds = { ...payload.records.builds, build: { ...payload.records.builds.build, kind: 'template', state: 'hypothetical' } }
    expect(() => validateSharePayload({ ...payload, records: { ...payload.records, builds } })).toThrow('malformed format')
  })

  it('round trips only a pinned checkpoint and its transitive dependencies', () => {
    const data = fixture()
    const payload = createSharePayload(data, { kind: 'build', revisionId: asId<BuildRevisionId>('build-revision') })
    expect(Object.keys(payload.records.personalDefinitions)).toEqual(['sword'])
    expect(decodeSharePayload(encodeSharePayload(payload))).toEqual(payload)
    expect(sharePreviewData(payload).playthroughs).toEqual({})
    expect(JSON.stringify(payload)).not.toContain('unrelated-private-definition')
    validateNativeLocalDataGraph(sharePreviewData(payload), [])
  })

  it.each(['primary', 'manual'] as const)('preserves native calculation rules and %s growth intent through a shared copy', growthMode => {
    let data = addTestDefinition(fixture(), 'growth-class', { kind: 'class' })
    const revision = data.buildRevisions['build-revision']!
    const calculation = { ...defaultCalculation(personalRef('growth-class'), 20), growthMode, pcMode: 'chaos' as const, gender: 'male' as const }
    data = saveBuildRevision(data, { buildId: revision.buildId, gameSetupRevisionId: revision.gameSetupRevisionId, content: { ...revision.content, primaryClass: personalRef('growth-class'), calculation }, now: TEST_NOW })
    const payload = decodeSharePayload(encodeSharePayload(createSharePayload(data, { kind: 'build', revisionId: data.builds.build!.latestRevisionId! })))
    expect(Object.values(payload.records.buildRevisions)[0]!.content.calculation).toEqual(calculation)
    expect(payload.records.personalDefinitions['growth-class']!.kind).toBe('class')
    const copied = saveSharedCopy(createTestLocalData(), payload)
    const checkpoint = copied.localData.buildRevisions[copied.localData.builds[copied.buildId!]!.latestRevisionId!]!
    expect(checkpoint.content.calculation).toEqual({ ...calculation, growth: [{ classRef: checkpoint.content.primaryClass, levels: 20 }] })
    expect(checkpoint.content.primaryClass).not.toEqual(personalRef('growth-class'))
    validateNativeLocalDataGraph(copied.localData, [])
  })

  it('shares an explicitly chosen older checkpoint and includes notes only on request', () => {
    const data = fixture()
    const before = data.buildRevisions['build-revision']!
    const old = { ...data, buildRevisions: { ...data.buildRevisions, [before.id]: { ...before, note: 'private checkpoint', content: { ...before.content, rotationNotes: 'private rotation', contextAssumptions: ['private assumption'] } } } }
    const updated = saveBuildRevision(old, { buildId: before.buildId, gameSetupRevisionId: before.gameSetupRevisionId, content: { ...before.content, equipment: { [HAND_SLOT]: null } }, now: TEST_NOW })
    const target = { kind: 'build' as const, revisionId: before.id }
    const publicPayload = createSharePayload(updated, target)
    expect(publicPayload.records.buildRevisions[before.id]!.content.equipment[HAND_SLOT]).toEqual(before.content.equipment[HAND_SLOT])
    expect(JSON.stringify(publicPayload)).not.toContain('private')
    expect(createSharePayload(updated, target, true).records.buildRevisions[before.id]!.content.rotationNotes).toBe('private rotation')
    expect(Object.keys(publicPayload.records.buildRevisions)).toHaveLength(1)
    expect(publicPayload.records.builds[before.buildId]!.latestRevisionId).toBe(before.id)
  })

  it('shares multiple checkpoints of one build with their own behavior and rejects that graph in version 1', () => {
    let data = fixture()
    const before = data.buildRevisions['build-revision']!
    data = addGameSetupRevision(data, { ...data.gameSetups[before.gameSetupRevisionId]!, id: asId<import('../domain/types').GameSetupRevisionId>('different-behavior'), gameSetupId: asId<import('../domain/types').GameSetupId>('different-preset'), ppLimit: { state: 'known', value: 20 }, activate: false, now: TEST_NOW })
    data = saveBuildRevision(data, { buildId: before.buildId, id: asId<BuildRevisionId>('second-checkpoint'), gameSetupRevisionId: asId<import('../domain/types').GameSetupRevisionId>('different-behavior'), content: before.content, now: TEST_NOW })
    data = addTestScenario(data, { alpha: before.id, beta: asId<BuildRevisionId>('second-checkpoint') })
    const payload = createSharePayload(data, { kind: 'team', scenarioId: asId<ScenarioId>('scenario') })
    expect(decodeSharePayload(encodeSharePayload(payload))).toEqual(payload)
    expect(() => encodeSharePayload({ ...payload, version: 1 })).toThrow('invalid dependency')
    const recipient = addTestScenario(createTestLocalData(), {})
    const copied = saveSharedCopy(recipient, payload)
    validateNativeLocalDataGraph(copied.localData, [])
    const checkpoints = Object.values(copied.localData.buildRevisions)
    expect(checkpoints).toHaveLength(2)
    expect(new Set(checkpoints.map(revision => revision.gameSetupRevisionId)).size).toBe(2)
  })

  it('preserves ordered slots, repeated checkpoints and effective baseline assignments without character IDs', () => {
    const data = addTestScenario(fixture(), { alpha: asId<BuildRevisionId>('build-revision') })
    const scenario = requirePlaythrough(data).scenarios.scenario!
    const updated = createScenario(data, { id: asId<ScenarioId>('baseline-team'), label: 'Portable team', memberIds: [...scenario.memberIds].reverse(), baseline: { kind: 'recordedParty', playthroughRevision: requirePlaythrough(data).revision, assignments: { [scenario.memberIds[0]!]: asId<BuildRevisionId>('build-revision') } }, assignments: { [scenario.memberIds[1]!]: asId<BuildRevisionId>('build-revision') }, gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID, now: TEST_NOW })
    const payload = createSharePayload(updated, { kind: 'team', scenarioId: asId<ScenarioId>('baseline-team') })
    expect(payload.slots).toEqual([null, null, 'build-revision', 'build-revision'])
    expect(Object.keys(payload.records.buildRevisions)).toHaveLength(1)
    expect(JSON.stringify(payload)).not.toContain('alpha')
    expect(JSON.stringify(payload)).not.toContain('test-team-member')
    expect(decodeSharePayload(encodeSharePayload(payload))).toEqual(payload)
  })

  it('preserves explicit unknowns and definition lineage, requirements and provenance', () => {
    let data = fixture()
    data = createPersonalDefinition(data, { id: asId<PersonalDefinitionId>('custom-passive'), kind: 'passive', name: 'Custom passive', ppCost: { state: 'unknown', reason: 'Unverified', sources: [{ sourceId: 'synthetic-evidence' }] }, requirements: { state: 'known', value: [{ kind: 'selected', ref: personalRef('sword') }] }, now: TEST_NOW })
    const override = revisePersonalDefinition(data, { sourceRef: personalRef('custom-passive'), id: asId<PersonalDefinitionId>('revised-passive'), name: 'Revised passive', now: TEST_NOW })
    data = override.localData
    const revision = data.buildRevisions['build-revision']!
    data = saveBuildRevision(data, { buildId: revision.buildId, gameSetupRevisionId: revision.gameSetupRevisionId, content: { ...revision.content, passives: [{ ref: override.ref }] }, now: TEST_NOW })
    const payload = createSharePayload(data, { kind: 'build', revisionId: data.builds.build!.latestRevisionId! })
    const decoded = decodeSharePayload(encodeSharePayload(payload))
    expect(decoded.records.personalDefinitions['custom-passive']!.ppCost).toEqual(data.personalDefinitions['custom-passive']!.ppCost)
    expect(Object.keys(decoded.records.personalDefinitions).sort()).toEqual(['custom-passive', 'revised-passive', 'sword'])
    validateNativeLocalDataGraph(sharePreviewData(decoded), [])
    validateNativeLocalDataGraph(saveSharedCopy(createTestLocalData(), decoded).localData, [])
  })

  it('preserves opaque source JSON without interpreting it as a dependency or rewriting it', () => {
    const data = fixture()
    const field = { state: 'known' as const, value: { kind: 'personal', definitionId: 'opaque-source-record' } }
    const modified = { ...data, personalDefinitions: { ...data.personalDefinitions, sword: { ...data.personalDefinitions.sword!, fields: { sourceRecord: field } } } }
    const payload = createSharePayload(modified, { kind: 'build', revisionId: asId<BuildRevisionId>('build-revision') })
    expect(Object.keys(payload.records.personalDefinitions)).toEqual(['sword'])
    const copy = saveSharedCopy(data, decodeSharePayload(encodeSharePayload(payload)))
    const definition = Object.values(copy.localData.personalDefinitions).find(entry => entry.id !== 'sword' && entry.name === 'sword')!
    expect(definition.fields.sourceRecord).toEqual(field)
    validateNativeLocalDataGraph(copy.localData, [])
  })

  it('retains mod composition origins and regenerates pins when copied to new setup identities', async () => {
    const { catalogs, composition } = await syntheticModLayers()
    let data = addGameSetupRevision(createTestLocalData(), { label: 'Synthetic mod setup', slots: SUGGESTED_BUILD_SLOTS, modComposition: composition, activate: true, now: TEST_NOW })
    const originId = data.planningGameSetupRevisionId!
    data = updateGameSetupRevision(data, { sourceRevisionId: originId, label: 'Derived setup', now: TEST_NOW })
    const setup = data.gameSetups[data.planningGameSetupRevisionId!]!
    const buildId = asId<BuildId>('mod-build')
    data = createBuild(data, { id: buildId, title: 'Mod build', gameSetupId: setup.gameSetupId, now: TEST_NOW })
    data = saveBuildRevision(data, { buildId, gameSetupRevisionId: setup.id, content: { primaryClass: { kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: setup.catalogLock[DEFAULT_CATALOG.id]!, entityId: asId<EntityId>('base:job:0') }, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] }, now: TEST_NOW })
    const payload = decodeSharePayload(encodeSharePayload(createSharePayload(data, { kind: 'build', revisionId: data.builds[buildId]!.latestRevisionId! })))
    expect(Object.keys(payload.records.gameSetups)).toContain(originId)
    const preview = sharePreviewData(payload)
    validateNativeLocalDataGraph(preview, await prepareModCatalogs(preview, catalogs))
    const copy = saveSharedCopy(createTestLocalData(), payload).localData
    validateNativeLocalDataGraph(copy, await prepareModCatalogs(copy, catalogs))
    expect(Object.keys(copy.gameSetups)).not.toContain(originId)
    const repeated = saveSharedCopy(copy, payload).localData
    expect(repeated.gameSetups).toEqual(copy.gameSetups)
    validateNativeLocalDataGraph(repeated, await prepareModCatalogs(repeated, catalogs))
    const recipient = addGameSetupRevision(createTestLocalData(), { label: 'My mod setup', slots: SUGGESTED_BUILD_SLOTS, modComposition: composition, activate: true, now: '2026-03-04T05:06:07.000Z' })
    const recipientSetup = recipient.gameSetups[recipient.planningGameSetupRevisionId!]!
    const reused = saveSharedCopy(recipient, payload)
    const reusedRevision = reused.localData.buildRevisions[reused.localData.builds[reused.buildId!]!.latestRevisionId!]!
    expect(reused.localData.gameSetups).toEqual(recipient.gameSetups)
    expect(reusedRevision.gameSetupRevisionId).toBe(recipientSetup.id)
    expect(reusedRevision.content.primaryClass).toMatchObject({ catalogRevisionId: recipientSetup.catalogLock[DEFAULT_CATALOG.id] })
    validateNativeLocalDataGraph(reused.localData, await prepareModCatalogs(reused.localData, catalogs))
    const different = addGameSetupRevision(createTestLocalData(), { label: 'Different mod order', slots: SUGGESTED_BUILD_SLOTS, modComposition: { ...composition, layers: [...composition.layers].reverse() }, activate: true, now: TEST_NOW })
    const separate = saveSharedCopy(different, payload)
    const separateRevision = separate.localData.buildRevisions[separate.localData.builds[separate.buildId!]!.latestRevisionId!]!
    expect(separateRevision.gameSetupRevisionId).not.toBe(different.planningGameSetupRevisionId)
    validateNativeLocalDataGraph(separate.localData, await prepareModCatalogs(separate.localData, catalogs))
  }, MOD_CATALOG_GRAPH_TIMEOUT_MS)

  it('adds fresh build identities while reusing identical dependencies and preserving existing records', () => {
    const data = fixture()
    const payload = createSharePayload(data, { kind: 'build', revisionId: asId<BuildRevisionId>('build-revision') })
    const { localData, buildId } = saveSharedCopy(data, payload)
    expect(buildId).not.toBe('build')
    expect(localData.playthroughs).toBe(data.playthroughs)
    expect(localData.builds.build).toBe(data.builds.build)
    expect(localData.personalDefinitions).toEqual(data.personalDefinitions)
    expect(localData.gameSetups).toEqual(data.gameSetups)
    const revision = localData.buildRevisions[localData.builds[buildId!]!.latestRevisionId!]!
    expect(revision.content.equipment[HAND_SLOT]!.ref).toEqual(personalRef('sword'))
    validateNativeLocalDataGraph(localData, [])
  })

  it('prefers the active equivalent setup across foreign identities and permits editing without a fork', () => {
    const source = createSampleLocalData(DEFAULT_CATALOG, TEST_NOW)
    let recipient = createSampleLocalData(DEFAULT_CATALOG, '2026-03-04T05:06:07.000Z')
    const activeId = requirePlaythrough(recipient).currentGameSetupRevisionId!
    const active = recipient.gameSetups[activeId]!
    const otherId = asId<GameSetupRevision['id']>('another-equivalent-setup')
    recipient = { ...recipient, gameSetups: { ...recipient.gameSetups, [otherId]: { ...active, id: otherId, gameSetupId: asId<GameSetupRevision['gameSetupId']>('another-equivalent-family'), revision: 9 }, [activeId]: { ...active, label: 'My setup', revision: 7 } } }
    const sourceRevision = Object.values(source.buildRevisions)[0]!
    const payload = createSharePayload(source, { kind: 'build', revisionId: sourceRevision.id })
    const first = saveSharedCopy(recipient, payload)
    const revision = first.localData.buildRevisions[first.localData.builds[first.buildId!]!.latestRevisionId!]!
    expect(revision.gameSetupRevisionId).toBe(activeId)
    expect(first.localData.builds[first.buildId!]!.gameSetupId).toBe(active.gameSetupId)
    expect(first.localData.gameSetups).toEqual(recipient.gameSetups)
    const edited = saveBuildRevision(first.localData, { buildId: first.buildId!, gameSetupRevisionId: activeId, content: { ...revision.content, rotationNotes: 'Editable immediately' }, now: TEST_NOW })
    const repeated = saveSharedCopy(edited, payload)
    expect(repeated.localData.gameSetups).toEqual(recipient.gameSetups)
    expect(repeated.localData.playthroughs).toBe(recipient.playthroughs)
    validateNativeLocalDataGraph(repeated.localData, [DEFAULT_CATALOG])
  })

  it.each<[string, Partial<GameSetupRevision>]>([
    ['platform', { platform: { state: 'known', value: 'another platform' } }],
    ['game version', { gameVersion: { state: 'known', value: 'another version' } }],
    ['mode', { mode: { state: 'unknown', reason: 'Unverified mode' } }],
    ['mods', { mods: { state: 'known', value: ['another mod'] } }],
    ['disabled mods', { disabledMods: { state: 'known', value: ['disabled mod'] } }],
    ['PP limit', { ppLimit: { state: 'known', value: 11 } }],
    ['PP uncertainty', { ppLimit: { state: 'unknown', reason: 'Unverified limit' } }],
    ['PP provenance', { ppLimit: { state: 'known', value: 10, sources: [{ sourceId: 'other-evidence' }] } }],
    ['PP costs', { ppCostsNonNegative: { state: 'known', value: false } }],
    ['catalog pins', { catalogLock: { [DEFAULT_CATALOG.id]: DEFAULT_CATALOG.revisionId } }],
    ['slot uncertainty', { slots: createTestLocalData().gameSetups[TEST_GAME_SETUP_REVISION_ID]!.slots.map(slot => ({ ...slot, acceptedEntityKinds: { state: 'unknown', reason: 'Unverified slot' } })) }],
  ])('preserves different %s in a separate setup with a unique name', (_name, change) => {
    const recipient = createTestLocalData()
    const source = fixture()
    const setup = source.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
    const modified = { ...source, gameSetups: { ...source.gameSetups, [setup.id]: { ...setup, ...change } } }
    const copy = saveSharedCopy(recipient, createSharePayload(modified, { kind: 'build', revisionId: asId<BuildRevisionId>('build-revision') }))
    const copiedRevision = copy.localData.buildRevisions[copy.localData.builds[copy.buildId!]!.latestRevisionId!]!
    const copiedSetup = copy.localData.gameSetups[copiedRevision.gameSetupRevisionId]!
    expect(copiedSetup.id).not.toBe(setup.id)
    expect(copiedSetup.label).toBe(`${setup.label} (shared)`)
    expect(copiedSetup).toMatchObject(change)
    expect(copy.localData.gameSetups[setup.id]).toBe(recipient.gameSetups[setup.id])
    expect(copy.localData.playthroughs).toBe(recipient.playthroughs)
    validateNativeLocalDataGraph(copy.localData, [DEFAULT_CATALOG])
  })

  it('checks case and surrounding spaces and increments an occupied shared suffix', () => {
    const source = fixture()
    const setup = source.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
    let recipient = createTestLocalData(undefined, { state: 'known', value: 20 })
    recipient = { ...recipient, gameSetups: { ...recipient.gameSetups, [setup.id]: { ...recipient.gameSetups[setup.id]!, label: ` ${setup.label.toUpperCase()} ` } } }
    recipient = addGameSetupRevision(recipient, { label: `${setup.label} (shared)`, ppLimit: { state: 'known', value: 30 }, now: TEST_NOW })
    const payload = createSharePayload(source, { kind: 'build', revisionId: asId<BuildRevisionId>('build-revision') })
    const first = saveSharedCopy(recipient, payload)
    const added = Object.values(first.localData.gameSetups).find(entry => !recipient.gameSetups[entry.id])!
    expect(added.label).toBe(`${setup.label} (shared 2)`)
    const second = saveSharedCopy(first.localData, payload)
    expect(second.localData.gameSetups).toEqual(first.localData.gameSetups)
    validateNativeLocalDataGraph(second.localData, [])
  })

  it('keeps collision suffixes within the persisted label limit', () => {
    const label = 'a'.repeat(MAX_SHORT_TEXT_LENGTH)
    const source = fixture()
    const setup = source.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
    const modified = { ...source, gameSetups: { [setup.id]: { ...setup, label } } }
    const recipient = createTestLocalData(undefined, { state: 'known', value: 20 })
    const withCollision = { ...recipient, gameSetups: { [setup.id]: { ...recipient.gameSetups[setup.id]!, label } } }
    const copy = saveSharedCopy(withCollision, createSharePayload(modified, { kind: 'build', revisionId: asId<BuildRevisionId>('build-revision') }))
    const added = Object.values(copy.localData.gameSetups).find(entry => entry.id !== setup.id)!
    expect(added.label).toHaveLength(MAX_SHORT_TEXT_LENGTH)
    expect(added.label.endsWith(' (shared)')).toBe(true)
    validateNativeLocalDataGraph(copy.localData, [])
  })

  it('reuses imported override lineage on repeated saves without merging changed definitions', () => {
    let source = fixture()
    const override = revisePersonalDefinition(source, { sourceRef: personalRef('sword'), name: 'Corrected sword', now: TEST_NOW })
    source = updateGameSetupRevision(override.localData, { sourceRevisionId: TEST_GAME_SETUP_REVISION_ID, definitionOverrides: [override.ref], now: TEST_NOW })
    const setup = source.gameSetups[source.planningGameSetupRevisionId!]!
    const revision = source.buildRevisions['build-revision']!
    source = saveBuildRevision(source, { buildId: revision.buildId, gameSetupRevisionId: setup.id, content: { ...revision.content, equipment: { [HAND_SLOT]: { ref: override.ref } } }, now: TEST_NOW })
    const payload = createSharePayload(source, { kind: 'build', revisionId: source.builds.build!.latestRevisionId! })
    const first = saveSharedCopy(createTestLocalData(), payload)
    const second = saveSharedCopy(first.localData, payload)
    expect(second.localData.personalDefinitions).toEqual(first.localData.personalDefinitions)
    expect(second.localData.gameSetups).toEqual(first.localData.gameSetups)
    const changed = { ...payload, records: { ...payload.records, personalDefinitions: { ...payload.records.personalDefinitions, [override.ref.definitionId]: { ...payload.records.personalDefinitions[override.ref.definitionId]!, rawDescription: 'Changed evidence' } } } }
    const third = saveSharedCopy(second.localData, changed)
    expect(Object.keys(third.localData.gameSetups)).toHaveLength(Object.keys(second.localData.gameSetups).length + 1)
    expect(Object.values(third.localData.gameSetups).map(setup => setup.label)).toContain(`${setup.label} (shared 2)`)
    validateNativeLocalDataGraph(third.localData, [])
  })

  it('reuses identical personal versions and rejects conflicting definition lineage without changing local records', () => {
    let source = createSampleLocalData(DEFAULT_CATALOG, TEST_NOW)
    const revision = Object.values(source.buildRevisions)[0]!
    const override = savedCatalogVersion(source, [DEFAULT_CATALOG], { sourceRef: revision.content.primaryClass!, rawDescription: 'Synthetic class correction', now: TEST_NOW })
    source = updateGameSetupRevision(override.localData, { sourceRevisionId: revision.gameSetupRevisionId, definitionOverrides: [override.ref], now: TEST_NOW })
    source = saveBuildRevision(source, { buildId: revision.buildId, gameSetupRevisionId: source.planningGameSetupRevisionId!, content: { ...revision.content, primaryClass: override.ref }, now: TEST_NOW })
    const payload = createSharePayload(source, { kind: 'build', revisionId: source.builds[revision.buildId]!.latestRevisionId! })
    const recipient = createSampleLocalData(DEFAULT_CATALOG, TEST_NOW)
    const first = saveSharedCopy(recipient, payload).localData
    const repeated = saveSharedCopy(first, payload).localData
    expect(repeated.gameSetups).toEqual(first.gameSetups)
    expect(repeated.personalDefinitions).toEqual(first.personalDefinitions)
    const original = structuredClone(repeated)
    const changed = { ...payload, records: { ...payload.records, personalDefinitions: { ...payload.records.personalDefinitions, [override.ref.definitionId]: { ...payload.records.personalDefinitions[override.ref.definitionId]!, rawDescription: 'Different class correction' } } } }
    expect(() => saveSharedCopy(repeated, changed)).toThrow('different personal version')
    expect(repeated).toEqual(original)
    validateNativeLocalDataGraph(repeated, [DEFAULT_CATALOG])
  })

  it('saves a reusable Team without requiring or changing tracked characters', () => {
    const data = addTestScenario(fixture(), { alpha: asId<BuildRevisionId>('build-revision') })
    const payload = createSharePayload(data, { kind: 'team', scenarioId: asId<ScenarioId>('scenario') })
    const result = saveSharedCopy(data, payload)
    const team = result.localData.teams[result.teamId!]!
    expect(team.slots).toHaveLength(4)
    expect(team.slots[0]).not.toBeNull()
    expect(team.slots[1]).toBeNull()
    expect(result.localData.playthroughs).toBe(data.playthroughs)
    validateNativeLocalDataGraph(result.localData, [])
  })

  it('rejects malformed, truncated, dangerous and unsupported payloads', () => {
    const payload = createSharePayload(fixture(), { kind: 'build', revisionId: asId<BuildRevisionId>('build-revision') })
    for (const encoded of ['', 'invalid!', 'AAA', encodeSharePayload(payload).slice(0, -12), envelope('{"__proto__":{}}'), envelope(JSON.stringify({ ...payload, version: 4 })), envelope(JSON.stringify({ ...payload, unexpected: true }))]) expect(() => decodeSharePayload(encoded)).toThrow()
    expect(() => validateSharePayload({ ...payload, records: { ...payload.records, personalDefinitions: {} } })).toThrow('missing')
    expect(() => validateSharePayload({ ...payload, kind: 'team', slots: [null], teamGameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID })).toThrow()
  })

  it('bounds inflation even when the declared length lies', () => {
    expect(() => decodeSharePayload(envelope('x'.repeat(MAX_SHARE_JSON_BYTES * 2), 64))).toThrow('declared size')
    expect(() => decodeSharePayload(envelope('{}', MAX_SHARE_JSON_BYTES + 1))).toThrow('data limit')
  })

  it('has substantial room for standard builds and teams and large varied personal definitions', () => {
    const sample = createSampleLocalData(DEFAULT_CATALOG, TEST_NOW)
    const revision = Object.values(sample.buildRevisions)[0]!
    const team = Object.values(requirePlaythrough(sample).scenarios)[0]!
    const single = createShareUrl(createSharePayload(sample, { kind: 'build', revisionId: revision.id }), 'https://crykit.lasers.app/')
    const fullTeam = createShareUrl(createSharePayload(sample, { kind: 'team', scenarioId: team.id }), 'https://crykit.lasers.app/')
    let equipped = { ...sample, personalDefinitions: { ...sample.personalDefinitions } }
    const equippedRevisions = { ...equipped.buildRevisions }
    const passiveSelections = Object.values(DEFAULT_CATALOG.entities).filter(entity => entity.kind === 'passive' || entity.kind === 'innate').slice(0, 10).map(entity => ({ ref: { kind: 'catalog' as const, catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: entity.id } }))
    for (const [index, revision] of Object.values(equipped.buildRevisions).entries()) {
      const definitionId = asId<PersonalDefinitionId>(`large-item-${index}`)
      equipped = createPersonalDefinition(equipped, { id: definitionId, kind: 'item', name: `Synthetic custom item ${index}`, rawDescription: variedText(6_000, index + 77), now: TEST_NOW })
      equippedRevisions[revision.id] = { ...revision, content: { ...revision.content, secondaryClass: revision.content.primaryClass, equipment: Object.fromEntries(SUGGESTED_BUILD_SLOTS.map(slot => [slot.id, { ref: { kind: 'personal' as const, definitionId } }])), passives: passiveSelections, calculation: { level: 20, growth: [{ classRef: revision.content.primaryClass, levels: 20 }], bonuses: ['STR', 'AGI'], statuses: [], targetEvasion: null } } }
    }
    equipped = { ...equipped, buildRevisions: equippedRevisions }
    const detailedTeam = createShareUrl(createSharePayload(equipped, { kind: 'team', scenarioId: team.id }), 'https://crykit.lasers.app/')
    const data = fixture()
    const custom = { ...data, personalDefinitions: { ...data.personalDefinitions, sword: { ...data.personalDefinitions.sword!, rawDescription: variedText(24_000) } } }
    const large = createShareUrl(createSharePayload(custom, { kind: 'build', revisionId: asId<BuildRevisionId>('build-revision') }), 'https://crykit.lasers.app/')
    expect(single.length).toBeLessThan(MAX_SHARE_URL_LENGTH / 16)
    expect(fullTeam.length).toBeLessThan(MAX_SHARE_URL_LENGTH / 16)
    expect(large.length).toBeGreaterThan(16_384)
    expect(large.length).toBeLessThan(MAX_SHARE_URL_LENGTH / 2)
    expect(detailedTeam.length).toBeLessThan(MAX_SHARE_URL_LENGTH / 2)
    validateNativeLocalDataGraph(sharePreviewData(decodeSharePayload(new URL(detailedTeam).hash.slice(SHARE_ROUTE_PREFIX.length))), [DEFAULT_CATALOG])
    expect(decodeSharePayload(new URL(large).hash.slice(SHARE_ROUTE_PREFIX.length)).records.personalDefinitions.sword!.rawDescription).toBe(custom.personalDefinitions.sword!.rawDescription)
    console.info(JSON.stringify({ sampleBuild: single.length, sampleTeam: fullTeam.length, detailedCustomTeam: detailedTeam.length, variedCustomDefinition: large.length, budget: MAX_SHARE_URL_LENGTH }))
  })

  it('rejects excess URL and decoded size on export and includes the complete address in the budget', () => {
    const data = fixture()
    const payload = createSharePayload(data, { kind: 'build', revisionId: asId<BuildRevisionId>('build-revision') }, true)
    const revision = payload.records.buildRevisions['build-revision']!
    const withNotes = (rotationNotes: string) => ({ ...payload, records: { ...payload.records, buildRevisions: { ...payload.records.buildRevisions, [revision.id]: { ...revision, content: { ...revision.content, rotationNotes } } } } })
    expect(() => encodeSharePayload(withNotes(variedText(100_000)))).toThrow('too large')
    expect(() => encodeSharePayload(withNotes('é'.repeat(600_000)))).toThrow('data limit')
    expect(() => decodeSharePayload('a'.repeat(MAX_SHARE_URL_LENGTH))).toThrow('URL limit')
    expect(() => createShareUrl(payload, `https://example.test/${'a'.repeat(MAX_SHARE_URL_LENGTH)}`)).toThrow('too large')
    const url = new URL(createShareUrl(payload, 'https://example.test/subdir/?private=query#old'))
    expect(url.pathname).toBe('/subdir/')
    expect(url.search).toBe('')
  })
})
