import { describe, expect, it } from 'vitest'
import { activateRuleset, activateScenario, asId, createScenario, updateRulesetRevision, type ScenarioId } from './index'
import { createTestProfile, TEST_NOW, TEST_RULESET_REVISION_ID } from './test-helpers'

describe('active scenario selection', () => {
  const scenarioId = asId<ScenarioId>('alternate-team')
  const withScenario = () => createScenario(createTestProfile(), { id: scenarioId, label: 'Alternate team', rulesetRevisionId: TEST_RULESET_REVISION_ID, activate: false, now: TEST_NOW })

  it('changes only the active selection and preserves the rulesets and scenario pins', () => {
    const original = withScenario()
    const profile = updateRulesetRevision(original, { sourceRevisionId: TEST_RULESET_REVISION_ID, label: 'Other ruleset', activate: true, now: TEST_NOW })
    const selected = activateScenario(profile, { scenarioId, expectedRevision: profile.revision, now: TEST_NOW })
    expect(selected.activeScenarioId).toBe(scenarioId)
    expect(selected.activeRulesetRevisionId).toBe(profile.activeRulesetRevisionId)
    expect(selected.scenarios).toBe(profile.scenarios)
    expect(selected.buildRevisions).toBe(profile.buildRevisions)
    expect(selected.revision).toBe(profile.revision + 1)
    expect(selected.changes.at(-1)).toMatchObject({ command: 'scenario.activate', changedPaths: ['activeScenarioId'] })
    const switchedRuleset = activateRuleset(selected, { rulesetRevisionId: TEST_RULESET_REVISION_ID, now: TEST_NOW })
    expect(switchedRuleset.scenarios).toBe(selected.scenarios)
    expect(switchedRuleset.activeScenarioId).toBe(scenarioId)
    const cleared = activateScenario(switchedRuleset, { scenarioId: null, now: TEST_NOW })
    expect(cleared.activeScenarioId).toBeUndefined()
    expect(cleared.scenarios).toBe(profile.scenarios)
    expect(activateScenario(cleared, { scenarioId: null })).toBe(cleared)
    expect(activateScenario(selected, { scenarioId })).toBe(selected)
  })

  it('rejects unknown identities and stale writes without changing the profile', () => {
    const profile = withScenario()
    for (const id of ['missing', '__proto__', 'constructor']) {
      expect(() => activateScenario(profile, { scenarioId: asId<ScenarioId>(id) })).toThrow('Scenario does not exist')
    }
    expect(() => activateScenario(profile, { scenarioId, expectedRevision: profile.revision - 1 })).toThrow('Profile revision does not match')
    expect(profile.activeScenarioId).toBeUndefined()
  })
})
