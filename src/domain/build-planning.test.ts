import { describe, expect, it } from 'vitest'
import { STARTER_CATALOG } from '../catalog'
import { createBuildPlan, ensureBuildPlanningRuleset, SUGGESTED_BUILD_SLOTS } from './build-planning'
import { createBlankProfile, updateRulesetRevision } from './profile'
import { createTestProfile } from './test-helpers'
import type { BuildRevisionContent, CatalogRef } from './types'

const catalogLock = { [STARTER_CATALOG.id]: STARTER_CATALOG.revisionId }
const item = Object.values(STARTER_CATALOG.entities).find((entity) => entity.name === 'Muramasa')!
const ref: CatalogRef = { kind: 'catalog', catalogId: STARTER_CATALOG.id, catalogRevisionId: STARTER_CATALOG.revisionId, entityId: item.id }
const content: BuildRevisionContent = { primaryClass: null, secondaryClass: null, selections: { [SUGGESTED_BUILD_SLOTS[0]!.id]: { ref } }, contextAssumptions: [] }

describe('build planning without observations', () => {
  it('creates a complete saved plan without inventory, characters, or verified rules', () => {
    const before = createBlankProfile({ label: 'Synthetic planner' })
    const profile = createBuildPlan(before, { title: 'Synthetic plan', kind: 'template', content, catalogLock })
    const build = Object.values(profile.builds)[0]!
    expect(profile.buildRevisions[build.latestRevisionId!]!.content).toEqual(content)
    const ruleset = profile.rulesets[profile.activeRulesetRevisionId!]!
    expect(ruleset.slots.every((slot) => slot.provenance === 'suggested')).toBe(true)
    expect(ruleset.platform.state).toBe('unknown')
    expect(ruleset.mods.state).toBe('unknown')
    expect(ruleset.ppLimit).toEqual({ state: 'known', value: 10 })
    expect(ruleset.ppCostsNonNegative.state).toBe('unknown')
    for (const field of ['inventory', 'inventoryEvents', 'characters', 'progress', 'scenarios', 'personalDefinitions'] as const) expect(profile[field]).toEqual(before[field])
    expect(before.builds).toEqual({})
    expect(before.rulesets).toEqual({})
  })

  it('preserves configured slots and ruleset knowledge', () => {
    const profile = createTestProfile()
    expect(ensureBuildPlanningRuleset(profile, catalogLock)).toBe(profile)
  })

  it('adds a suggested layout to an empty ruleset without changing its mod knowledge', () => {
    const original = createTestProfile()
    const empty = updateRulesetRevision(original, { sourceRevisionId: original.activeRulesetRevisionId!, slots: [], mods: { state: 'known', value: ['Doge Shield'] }, activate: true })
    const profile = ensureBuildPlanningRuleset(empty, catalogLock)
    const ruleset = profile.rulesets[profile.activeRulesetRevisionId!]!
    expect(ruleset.mods).toEqual({ state: 'known', value: ['Doge Shield'] })
    expect(ruleset.platform).toEqual(original.rulesets[original.activeRulesetRevisionId!]!.platform)
    expect(profile.rulesets[empty.activeRulesetRevisionId!]!.slots).toEqual([])
    expect(ruleset.slots.every((slot) => slot.provenance === 'suggested')).toBe(true)
  })

  it('leaves the original profile unchanged if the initial revision is invalid', () => {
    const profile = createBlankProfile({ label: 'Synthetic planner' })
    const original = structuredClone(profile)
    expect(() => createBuildPlan(profile, { title: 'Synthetic plan', kind: 'template', catalogLock, content: { ...content, selections: { invalid: { ref } } } })).toThrow('unknown ruleset slot')
    expect(profile).toEqual(original)
  })
})
