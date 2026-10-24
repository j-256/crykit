import { defaultCalculation } from './calculation-plan'
import { saveBuildRevision } from './builds'
import { validateBuildContent } from './build-validity'
import { composeModCatalog } from './mod-layers'
import { syntheticModLayers } from './mod-layers.test-helpers'
import { describe, expect, it } from 'vitest'
import { addBuildToTeam, changeTeamSetup, saveTeamSlotAsBuild, saveTeamCheckpoint, saveSharedTeam } from './team-checkpoints'
import { addTestBuild, addTestDefinition, addTestTeam, createTestLocalData, HAND_SLOT, personalRef, TEST_GAME_SETUP_REVISION_ID, TEST_NOW } from './test-helpers'
import { addGameSetupRevision } from './local-data'
import { adoptTeam } from './teams'
import { requirePlaythrough } from './core'
import { validateNativeLocalDataGraph } from '../interchange/native'
import type { CatalogRef, LocalData, TeamId } from './types'
const teamId = 'owned-team' as TeamId
const owned = (data: LocalData) => { const team = data.teams[teamId]!; if (team.kind !== 'shared') throw new Error('Expected shared'); return data.teamRevisions[team.latestRevisionId]! }
const fixture = () => addTestBuild(addTestDefinition(createTestLocalData(), 'sword'), 'source', '', { [HAND_SLOT]: { ref: personalRef('sword') } })
const empty = (data: LocalData) => saveTeamCheckpoint(data, { teamId, title: 'Owned Team', setupRevisionId: TEST_GAME_SETUP_REVISION_ID, slots: [null, null, null, null], expectedRevision: data.revision, now: TEST_NOW })

describe('shared Team setup commands', () => {
  it('adaptsCopyAndRetainsUnresolvedSelections', () => {
    const original = fixture()
    const configured = addGameSetupRevision(original, { ...original.gameSetups[TEST_GAME_SETUP_REVISION_ID]!, id: 'no-hands' as never, label: 'No hand slots', slots: [], activate: false })
    const initial = empty(configured)
    const before = changeTeamSetup(initial, { teamId, setupRevisionId: 'no-hands' as never, expectedRevision: initial.revision }, [])
    const after = addBuildToTeam(before, { teamId, slot: 0, sourceRevisionId: 'source-revision' as never, expectedRevision: before.revision }, [])
    expect(after.buildRevisions).toEqual(before.buildRevisions)
    expect(after.builds).toEqual(before.builds)
    expect(owned(after).slots[0]!.content.equipment).toEqual(original.buildRevisions['source-revision']!.content.equipment)
    expect(owned(after).slots[0]!.sourceBuildRevisionId).toBe('source-revision')
    validateNativeLocalDataGraph(after, [])
    const exported = saveTeamSlotAsBuild(after, { teamRevisionId: owned(after).id, slot: 0, title: 'Independent', expectedRevision: after.revision })
    const created = Object.values(exported.builds).find(build => !after.builds[build.id])!
    expect(created.id).not.toBe('source')
    expect(exported.buildRevisions[created.latestRevisionId!]!.content).toEqual(owned(after).slots[0]!.content)
    expect(exported.buildRevisions['source-revision']).toEqual(original.buildRevisions['source-revision'])
    validateNativeLocalDataGraph(exported, [])
  })
  it('setupChangeAffectsOnlyNewTeamRevision', () => {
    const base = fixture()
    const before = addGameSetupRevision(empty(base), { ...base.gameSetups[TEST_GAME_SETUP_REVISION_ID]!, id: 'different' as never, label: 'Different rules', ppLimit: { state: 'known', value: 99 }, activate: false })
    const after = changeTeamSetup(before, { teamId, setupRevisionId: 'different' as never, expectedRevision: before.revision }, [])
    expect(owned(after).parentRevisionId).toBe(owned(before).id)
    expect(after.teamRevisions[owned(before).id]).toEqual(owned(before))
    expect(after.builds).toEqual(before.builds)
    expect(after.buildRevisions).toEqual(before.buildRevisions)
    expect(after.playthroughs).toEqual(before.playthroughs)
    expect(after.gameSetups).toEqual(before.gameSetups)
  })
  it('adoptUsesSharedTeamContextWithoutSourceMutation', () => {
    const roster = addTestTeam(fixture())
    let before = empty(roster.localData)
    for (const slot of [0, 1, 2, 3] as const) before = addBuildToTeam(before, { teamId, slot, sourceRevisionId: 'source-revision' as never, expectedRevision: before.revision }, [])
    const after = adoptTeam(before, { teamId, characterIds: roster.memberIds, expectedRevision: before.revision })
    expect(after.builds).toEqual(before.builds)
    expect(after.buildRevisions).toEqual(before.buildRevisions)
    const party = requirePlaythrough(after)
    const scenario = Object.values(party.scenarios).find(value => value.kind === 'recordedCurrent')!
    expect(scenario.gameSetupRevisionId).toBe(owned(before).gameSetupRevisionId)
    expect(scenario.assignments[roster.memberIds[0]!]).toEqual({ kind: 'team-slot', teamRevisionId: owned(before).id, slot: 0 })
    expect(party.inventory).toEqual(requirePlaythrough(before).inventory)
    for (const id of roster.memberIds) expect(party.characters[id]!.learnedNodes).toEqual(requirePlaythrough(before).characters[id]!.learnedNodes)
    validateNativeLocalDataGraph(after, [])
  })
})

it('retains mixed and all-null legacy Teams until explicit conversion with no first-member fallback', () => {
  const data = fixture()
  for (const slots of [[null, null, null, null], ['source-revision', null, null, null]] as const) {
    const legacy = { id: teamId, kind: 'legacy-mixed' as const, title: 'Historical', revision: 7, createdAt: TEST_NOW, updatedAt: TEST_NOW, slots: slots as readonly (import('./types').BuildRevisionId | null)[] }
    const before = { ...data, teams: { [teamId]: legacy } }
    const converted = changeTeamSetup(before, { teamId, setupRevisionId: TEST_GAME_SETUP_REVISION_ID, expectedRevision: before.revision }, [])
    expect(before.teams[teamId]).toEqual(legacy)
    expect(converted.teams[teamId]!.createdAt).toBe(TEST_NOW)
    expect(owned(converted).slots.map(slot => slot?.sourceBuildRevisionId ?? null)).toEqual(slots)
    expect(converted.builds).toEqual(before.builds)
    expect(converted.buildRevisions).toEqual(before.buildRevisions)
  }
})

it('keeps disabled mod selections unresolved while old sources and another Team remain exact', async () => {
  const { catalogs, composition } = await syntheticModLayers()
  let data = addTestBuild(createTestLocalData(), 'mod-source', '', {})
  data = addGameSetupRevision(data, { ...data.gameSetups[TEST_GAME_SETUP_REVISION_ID]!, id: 'enabled-mod-setup' as never, modComposition: composition, activate: false })
  const enabled = data.gameSetups['enabled-mod-setup']!
  const primaryClass: CatalogRef = { kind: 'catalog', catalogId: composition.baseline.catalogId, catalogRevisionId: enabled.catalogLock[composition.baseline.catalogId]!, entityId: 'base:job:0' as never }
  data = saveBuildRevision(data, { buildId: 'mod-source' as never, id: 'mod-source-enabled' as never, gameSetupRevisionId: enabled.id, content: { primaryClass, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: defaultCalculation(primaryClass) } })
  data = saveSharedTeam(data, { id: teamId, title: 'Mod Team', gameSetupRevisionId: enabled.id, slots: ['mod-source-enabled' as never, null, null, null] })
  data = saveSharedTeam(data, { id: 'other-team' as never, title: 'Other Team', gameSetupRevisionId: enabled.id, slots: ['mod-source-enabled' as never, null, null, null] })
  data = addGameSetupRevision(data, { ...enabled, id: 'disabled-mod-setup' as never, label: 'Disabled mod setup', modComposition: { ...composition, layers: composition.layers.map(layer => ({ ...layer, enabled: false })) }, activate: false })
  const before = structuredClone(data)
  const after = changeTeamSetup(data, { teamId, setupRevisionId: 'disabled-mod-setup' as never, expectedRevision: data.revision }, catalogs)
  const checkpoint = owned(after), selected = checkpoint.slots[0]!.content
  expect(selected.primaryClass).toEqual(primaryClass)
  expect(selected.calculation).toEqual(owned(before).slots[0]!.content.calculation)
  expect(selected.retainedSelections?.refs).toEqual([primaryClass])
  const allCatalogs = [...catalogs, composeModCatalog(enabled, catalogs)!, composeModCatalog(after.gameSetups[checkpoint.gameSetupRevisionId]!, catalogs)!]
  const disabledSelectionStatus = validateBuildContent(selected, after.gameSetups[checkpoint.gameSetupRevisionId], enabled.slots, ref => ref.kind === 'catalog' ? allCatalogs.find(catalog => catalog.id === ref.catalogId && catalog.revisionId === ref.catalogRevisionId)?.entities[ref.entityId] : undefined).status
  expect(disabledSelectionStatus).toBe('undetermined')
  expect(after.builds).toEqual(before.builds)
  expect(after.buildRevisions).toEqual(before.buildRevisions)
  expect(after.teams['other-team']).toEqual(before.teams['other-team'])
  for (const [id, revision] of Object.entries(before.teamRevisions)) expect(after.teamRevisions[id]).toEqual(revision)
  validateNativeLocalDataGraph(after, allCatalogs)
})
