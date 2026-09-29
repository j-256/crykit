import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { entityDefinitionKey, requirePlaythrough } from './core'
import { createSampleLocalData } from './sample-data'
import { validateScenario } from './validation'

describe('sample starter team', () => {
  it('creates a complete, labeled localData with stocked character builds and valid references', () => {
    const localData = createSampleLocalData(DEFAULT_CATALOG)
    expect(() => validateNativeLocalDataGraph(localData, [DEFAULT_CATALOG])).not.toThrow()
    expect(requirePlaythrough(localData).label).toBe('Sample playthrough')
    expect(localData.revision).toBe(0)
    expect(localData.changes).toEqual([])
    expect(Object.values(requirePlaythrough(localData).characters).map(character => character.name)).toEqual(['Rowan', 'Mira', 'Tavi', 'Sol'])
    expect(Object.values(localData.builds)).toHaveLength(4)
    expect(Object.values(requirePlaythrough(localData).scenarios)).toHaveLength(1)
    const scenario = requirePlaythrough(localData).scenarios[requirePlaythrough(localData).activeScenarioId!]!
    expect(scenario.gameSetupRevisionId).toBe(localData.planningGameSetupRevisionId)
    expect(scenario.inventoryPolicy.enforceStock).toBe(true)
    expect(localData.gameSetups[scenario.gameSetupRevisionId]!.ppLimit).toEqual({ state: 'known', value: 10 })
    expect(localData.gameSetups[scenario.gameSetupRevisionId]!.ppCostsNonNegative).toEqual({ state: 'known', value: true })
    expect(localData.gameSetups[scenario.gameSetupRevisionId]!.gameVersion).toEqual({ state: 'known', value: '1.6.6' })
    expect(scenario.memberIds).toEqual(Object.keys(requirePlaythrough(localData).characters))
    expect(Object.keys(scenario.assignments).sort()).toEqual(Object.keys(requirePlaythrough(localData).characters).sort())
    for (const character of Object.values(requirePlaythrough(localData).characters)) {
      const snapshot = character.snapshots[character.currentSnapshotId!]!
      const revision = localData.buildRevisions[scenario.assignments[character.id]!]!
      expect(localData.builds[revision.buildId]!.gameSetupId).toBe(localData.gameSetups[revision.gameSetupRevisionId]!.gameSetupId)
      expect(snapshot.note).toContain('Sample data')
      expect(snapshot.primaryClass).toEqual({ state: 'known', value: revision.content.primaryClass })
      expect(snapshot.gameSetupRevisionId).toBe(revision.gameSetupRevisionId)
      expect(snapshot.equipment).toEqual(Object.fromEntries(Object.entries(revision.content.equipment).map(([slotId, selection]) => [slotId, selection?.ref ?? null])))
      expect(snapshot.passives).toEqual({ state: 'known', value: [] })
      expect(snapshot.level).toEqual({ state: 'known', value: 1 })
      expect(snapshot).not.toHaveProperty('ppCapacity')
      expect(snapshot.displayedStats).toEqual({})
      expect(character.learnedNodes).toEqual({})
    }
    const report = validateScenario(localData, scenario.id, {
      snapshots: { [JSON.stringify([DEFAULT_CATALOG.id, DEFAULT_CATALOG.revisionId])]: DEFAULT_CATALOG },
      entitiesByRef: Object.fromEntries(Object.values(DEFAULT_CATALOG.entities).map(entity => [
        entityDefinitionKey({ kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: entity.id }), entity,
      ])),
    })
    expect(report.issues.filter(issue => issue.status === 'invalid')).toEqual([])
    expect(report.dimensions.structure.status).toBe('valid')
    expect(report.dimensions.inventory.status).toBe('valid')
    expect(report.dimensions.characterReadiness.status).toBe('valid')
    expect(report.dimensions.gameSetupCertainty.status).toBe('undetermined')
    expect(requirePlaythrough(localData).inventoryEvents).toEqual({})
    expect(requirePlaythrough(localData).progress).toEqual({})
    expect(localData.personalDefinitions).toEqual({})
  })

  it('rejects missing or mismatched catalog definitions instead of creating broken references', () => {
    expect(() => createSampleLocalData({ ...DEFAULT_CATALOG, entities: {} })).toThrow('sample team requires')
    const warrior = DEFAULT_CATALOG.entities['base:class:warrior']!
    expect(() => createSampleLocalData({ ...DEFAULT_CATALOG, entities: { ...DEFAULT_CATALOG.entities, [warrior.id]: { ...warrior, kind: 'item' } } })).toThrow('sample team requires')
  })

  it('rejects duplicate members in an imported explicit team roster', () => {
    const localData = createSampleLocalData(DEFAULT_CATALOG)
    const scenario = requirePlaythrough(localData).scenarios[requirePlaythrough(localData).activeScenarioId!]!
    const duplicateRoster = [scenario.memberIds[0]!, scenario.memberIds[1]!, scenario.memberIds[2]!, scenario.memberIds[2]!]
    const playthrough = requirePlaythrough(localData)
    const changed = {
      ...localData,
      playthroughs: {
        ...localData.playthroughs,
        [playthrough.id]: { ...playthrough, scenarios: { ...playthrough.scenarios, [scenario.id]: { ...scenario, memberIds: duplicateRoster } } },
      },
    }
    expect(() => validateNativeLocalDataGraph(changed, [DEFAULT_CATALOG])).toThrow('duplicate characters')
  })

  it('rejects an imported team without an explicit roster', () => {
    const localData = createSampleLocalData(DEFAULT_CATALOG)
    const scenario = requirePlaythrough(localData).scenarios[requirePlaythrough(localData).activeScenarioId!]!
    const { memberIds: _memberIds, ...rosterlessScenario } = scenario
    const playthrough = requirePlaythrough(localData)
    const changed = {
      ...localData,
      playthroughs: {
        ...localData.playthroughs,
        [playthrough.id]: { ...playthrough, scenarios: { ...playthrough.scenarios, [scenario.id]: rosterlessScenario } },
      },
    }
    expect(() => validateNativeLocalDataGraph(changed as unknown as typeof localData, [DEFAULT_CATALOG])).toThrow('unsupported shape')
  })
})
