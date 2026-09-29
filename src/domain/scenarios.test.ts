import { describe, expect, it } from 'vitest'
import { activateRuleset, activateScenario, asId, createScenario, updateRulesetRevision, validateScenario, type CharacterId, type ScenarioId } from './index'
import { addTestCharacter, addTestTeam, createTestProfile, TEST_NOW, TEST_RULESET_REVISION_ID } from './test-helpers'

describe('active scenario selection', () => {
  const scenarioId = asId<ScenarioId>('alternate-team')
  const withScenario = () => {
    const team = addTestTeam(createTestProfile())
    return createScenario(team.profile, { id: scenarioId, label: 'Alternate team', memberIds: team.memberIds, rulesetRevisionId: TEST_RULESET_REVISION_ID, activate: false, now: TEST_NOW })
  }

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

describe('four-character team composition', () => {
  const withCharacters = () => ['one', 'two', 'three', 'four', 'five'].reduce((profile, id) => addTestCharacter(profile, id), createTestProfile())
  const team = ['one', 'two', 'three', 'four'].map(id => asId<CharacterId>(id))

  it('requires exactly four distinct characters for an explicit team roster', () => {
    const profile = withCharacters()
    expect(() => createScenario(profile, { label: 'Short team', memberIds: team.slice(0, 3), rulesetRevisionId: TEST_RULESET_REVISION_ID })).toThrow('exactly 4 distinct characters')
    expect(() => createScenario(profile, { label: 'Duplicate team', memberIds: [team[0]!, team[1]!, team[2]!, team[2]!], rulesetRevisionId: TEST_RULESET_REVISION_ID })).toThrow('exactly 4 distinct characters')
  })

  it('keeps four roster slots independent from optional build assignments', () => {
    const profile = createScenario(withCharacters(), { id: asId<ScenarioId>('team'), label: 'Four-person team', memberIds: team, rulesetRevisionId: TEST_RULESET_REVISION_ID })
    const scenario = profile.scenarios.team!
    expect(scenario.memberIds).toEqual(team)
    expect(scenario.assignments).toEqual({})
    expect(validateScenario(profile, scenario.id).dimensions.structure.status).toBe('valid')
  })
})
