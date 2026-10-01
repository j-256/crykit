import { describe, expect, it } from 'vitest'
import { buildBehavior, sameBuildBehavior, saveBuildBehavior } from './build-behavior'
import { replaceScenarioBuild } from './scenarios'
import { asId } from './core'
import type { BuildRevisionId, CharacterId } from './types'
import { createGameSetupRevision } from './local-data'
import { validateScenario } from './validation'
import { saveBuildRevision } from './builds'
import { syntheticModLayers } from './mod-layers.test-helpers'
import { prepareModCatalogs } from '../persistence'
import { modState, recordedModNames, updateModSelections } from './mods'
import { addTestBuild, addTestScenario, createTestLocalData, known, TEST_GAME_SETUP_REVISION_ID, TEST_NOW } from './test-helpers'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { createSharePayload, decodeSharePayload, encodeSharePayload, saveSharedCopy } from '../interchange/share'

const IMPORTED_CATALOG_BEHAVIOR_TIMEOUT_MS = 15_000

describe('checkpoint-owned behavior', () => {
  it('reuses equivalent presets without interpreting their labels or mod spelling as rules', () => {
    const data = createTestLocalData()
    const behavior = buildBehavior(data.gameSetups[TEST_GAME_SETUP_REVISION_ID]!)
    const first = saveBuildBehavior(data, { ...behavior, mods: known(['Synthetic Mod', 'Other mod']) }, TEST_NOW)
    const reused = saveBuildBehavior(first.localData, { ...behavior, label: 'Another name', mods: known(['OTHER MOD', ' synthetic  mod ']) }, TEST_NOW)
    expect(reused.localData).toBe(first.localData)
    expect(reused.setup).toBe(first.setup)
    expect(sameBuildBehavior(behavior, { ...behavior, ppLimit: undefined })).toBe(true)
    expect(sameBuildBehavior(behavior, { ...behavior, gameVersion: { state: 'unknown' } })).toBe(false)
    expect(sameBuildBehavior(behavior, { ...behavior, ppLimit: known(11) })).toBe(false)
  })

  it('saves different behavior in the same build while preserving earlier checkpoints and the Playthrough', () => {
    const original = addTestBuild(createTestLocalData(), 'build', 'alpha', {})
    const prior = original.buildRevisions['build-revision']!
    const configured = saveBuildBehavior(original, { ...buildBehavior(original.gameSetups[prior.gameSetupRevisionId]!), gameVersion: known('synthetic-version'), mods: known(['Synthetic mod']), customMods: ['Synthetic mod'] }, TEST_NOW)
    const saved = saveBuildRevision(configured.localData, { buildId: prior.buildId, parentRevisionId: prior.id, gameSetupRevisionId: configured.setup.id, content: prior.content, now: TEST_NOW })
    expect(saved.buildRevisions[prior.id]).toEqual(prior)
    expect(saved.gameSetups[prior.gameSetupRevisionId]).toEqual(original.gameSetups[prior.gameSetupRevisionId])
    expect(saved.playthroughs).toEqual(original.playthroughs)
    expect(saved.planningGameSetupRevisionId).toBe(original.planningGameSetupRevisionId)
    expect(saved.builds[prior.buildId]!.gameSetupId).toBe(configured.setup.gameSetupId)
    validateNativeLocalDataGraph(saved, [])
    const oldPayload = createSharePayload(saved, { kind: 'build', revisionId: prior.id })
    expect(oldPayload.records.builds[prior.buildId]!.gameSetupId).toBe(original.builds[prior.buildId]!.gameSetupId)
    expect(oldPayload.records.gameSetups[prior.gameSetupRevisionId]).toEqual(original.gameSetups[prior.gameSetupRevisionId])
    const payload = decodeSharePayload(encodeSharePayload(createSharePayload(saved, { kind: 'build', revisionId: saved.builds[prior.buildId]!.latestRevisionId! })))
    const copy = saveSharedCopy(original, payload)
    expect(Object.values(copy.localData.gameSetups).some(setup => setup.customMods?.includes('Synthetic mod'))).toBe(true)
    const restored = saveBuildRevision(saved, { buildId: prior.buildId, parentRevisionId: prior.id, gameSetupRevisionId: prior.gameSetupRevisionId, content: prior.content, now: TEST_NOW })
    expect(restored.builds[prior.buildId]!.gameSetupId).toBe(original.builds[prior.buildId]!.gameSetupId)
    expect(restored.buildRevisions[prior.id]).toEqual(prior)
  })

  it('accepts an equivalent behavior preset in a team regardless of its identity', () => {
    const original = addTestScenario(addTestBuild(createTestLocalData(), 'build', 'alpha', {}), { alpha: asId<BuildRevisionId>('build-revision') })
    const prior = original.buildRevisions['build-revision']!
    const configured = createGameSetupRevision(original, { ...buildBehavior(original.gameSetups[prior.gameSetupRevisionId]!), label: 'Equivalent preset', activate: true, now: TEST_NOW })
    const saved = saveBuildRevision(configured, { buildId: prior.buildId, id: asId<BuildRevisionId>(prior.id + '-equivalent'), gameSetupRevisionId: configured.planningGameSetupRevisionId!, content: prior.content, now: TEST_NOW })
    const scenario = Object.values(saved.playthroughs[saved.selectedPlaythroughId!]!.scenarios)[0]!
    const assigned = replaceScenarioBuild(saved, { scenarioId: scenario.id, characterId: asId<CharacterId>('alpha'), buildRevisionId: saved.builds[prior.buildId]!.latestRevisionId!, now: TEST_NOW })
    const report = validateScenario(assigned, scenario.id)
    expect(report.issues.some(issue => issue.code === 'GAME_SETUP_REVISION_MISMATCH')).toBe(false)
  })

  it('keeps the selected imported catalog origin when another equivalent origin already exists', async () => {
    const { catalogs, composition } = await syntheticModLayers()
    const original = createTestLocalData()
    const behavior = { ...buildBehavior(original.gameSetups[TEST_GAME_SETUP_REVISION_ID]!), modComposition: composition, catalogLock: { [composition.baseline.catalogId]: composition.baseline.catalogRevisionId } }
    const first = saveBuildBehavior(original, behavior, TEST_NOW)
    const second = createGameSetupRevision(first.localData, { ...behavior, label: 'Another imported origin', activate: true, now: TEST_NOW })
    const selected = second.gameSetups[second.planningGameSetupRevisionId!]!
    expect(selected.catalogLock).not.toEqual(first.setup.catalogLock)
    const changed = saveBuildBehavior(second, { ...buildBehavior(selected), ppLimit: known(12) }, TEST_NOW)
    expect(changed.setup.catalogLock).toEqual(selected.catalogLock)
    validateNativeLocalDataGraph(changed.localData, await prepareModCatalogs(changed.localData, catalogs))
  }, IMPORTED_CATALOG_BEHAVIOR_TIMEOUT_MS)

  it('retains individually named custom choices when their state is unknown', () => {
    const original = createTestLocalData()
    const configuration = { ...buildBehavior(original.gameSetups[TEST_GAME_SETUP_REVISION_ID]!), customMods: ['Synthetic optional mod'] }
    const changed = updateModSelections(configuration, [{ name: 'Synthetic optional mod', state: 'enabled' }])
    const cleared = updateModSelections(changed, [{ name: 'Synthetic optional mod', state: 'unknown' }])
    const saved = saveBuildBehavior(original, { ...configuration, ...cleared }, TEST_NOW)
    expect(modState(saved.setup, 'Synthetic optional mod')).toBe('unknown')
    expect(recordedModNames(saved.setup)).toContain('Synthetic optional mod')
    expect(saved.setup.customMods).toEqual(configuration.customMods)
    validateNativeLocalDataGraph(saved.localData, [])
  })
})
