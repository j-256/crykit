import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { validateNativeProfileGraph } from '../interchange/native'
import { entityDefinitionKey } from './core'
import { createSampleProfile } from './sample-profile'
import { validateScenario } from './validation'

describe('sample starter team', () => {
  it('creates a complete, labeled profile with stocked character builds and valid references', () => {
    const profile = createSampleProfile(DEFAULT_CATALOG)
    expect(() => validateNativeProfileGraph(profile, [DEFAULT_CATALOG])).not.toThrow()
    expect(profile.label).toBe('Sample playthrough')
    expect(profile.revision).toBe(0)
    expect(profile.changes).toEqual([])
    expect(Object.values(profile.characters).map(character => character.name)).toEqual(['Rowan', 'Mira'])
    expect(Object.values(profile.builds)).toHaveLength(2)
    expect(Object.values(profile.scenarios)).toHaveLength(1)
    const scenario = profile.scenarios[profile.activeScenarioId!]!
    expect(scenario.rulesetRevisionId).toBe(profile.activeRulesetRevisionId)
    expect(scenario.inventoryPolicy.enforceStock).toBe(true)
    expect(Object.keys(scenario.assignments).sort()).toEqual(Object.keys(profile.characters).sort())
    for (const character of Object.values(profile.characters)) {
      const snapshot = character.snapshots[character.currentSnapshotId!]!
      const revision = profile.buildRevisions[scenario.assignments[character.id]!]!
      expect(profile.builds[revision.buildId]!.characterId).toBe(character.id)
      expect(snapshot.note).toContain('Sample data')
      expect(snapshot.primaryClass).toEqual({ state: 'known', value: revision.content.primaryClass })
      expect(snapshot.rulesetRevisionId).toBe(revision.rulesetRevisionId)
      expect(snapshot.selections).toEqual(Object.fromEntries(Object.entries(revision.content.selections).map(([slotId, selection]) => [slotId, selection?.ref ?? null])))
      expect(snapshot.level).toEqual({ state: 'known', value: 1 })
      expect(snapshot.ppCapacity.state).toBe('unknown')
      expect(snapshot.displayedStats).toEqual({})
      expect(character.learnedNodes).toEqual({})
    }
    const report = validateScenario(profile, scenario.id, {
      snapshots: { [JSON.stringify([DEFAULT_CATALOG.id, DEFAULT_CATALOG.revisionId])]: DEFAULT_CATALOG },
      entitiesByRef: Object.fromEntries(Object.values(DEFAULT_CATALOG.entities).map(entity => [
        entityDefinitionKey({ kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: entity.id }), entity,
      ])),
    })
    expect(report.issues.filter(issue => issue.status === 'invalid')).toEqual([])
    expect(report.dimensions.structure.status).toBe('valid')
    expect(report.dimensions.inventory.status).toBe('valid')
    expect(report.dimensions.characterReadiness.status).toBe('valid')
    expect(report.dimensions.rulesetCertainty.status).toBe('undetermined')
    expect(profile.inventoryEvents).toEqual({})
    expect(profile.progress).toEqual({})
    expect(profile.personalDefinitions).toEqual({})
  })

  it('rejects missing or mismatched catalog definitions instead of creating broken references', () => {
    expect(() => createSampleProfile({ ...DEFAULT_CATALOG, entities: {} })).toThrow('sample team requires')
    const warrior = DEFAULT_CATALOG.entities['base:class:warrior']!
    expect(() => createSampleProfile({ ...DEFAULT_CATALOG, entities: { ...DEFAULT_CATALOG.entities, [warrior.id]: { ...warrior, kind: 'item' } } })).toThrow('sample team requires')
  })
})
