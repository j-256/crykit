import { describe, expect, it } from 'vitest'
import { activateGameSetup, activateScenario, asId, createScenario, requirePlaythrough, updateGameSetupRevision, validateScenario, type CharacterId, type ScenarioId } from './index'
import { addTestCharacter, addTestTeam, createTestLocalData, TEST_NOW, TEST_GAME_SETUP_REVISION_ID } from './test-helpers'

describe('active scenario selection', () => {
  const scenarioId = asId<ScenarioId>('alternate-team')
  const withScenario = () => {
    const team = addTestTeam(createTestLocalData())
    return createScenario(team.localData, { id: scenarioId, label: 'Alternate team', memberIds: team.memberIds, gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID, activate: false, now: TEST_NOW })
  }

  it('changes only the active selection and preserves the gameSetups and scenario pins', () => {
    const original = withScenario()
    const localData = updateGameSetupRevision(original, { sourceRevisionId: TEST_GAME_SETUP_REVISION_ID, label: 'Other gameSetup', activate: true, now: TEST_NOW })
    const selected = activateScenario(localData, { scenarioId, expectedRevision: localData.revision, now: TEST_NOW })
    expect(requirePlaythrough(selected).activeScenarioId).toBe(scenarioId)
    expect(selected.planningGameSetupRevisionId).toBe(localData.planningGameSetupRevisionId)
    expect(requirePlaythrough(selected).scenarios).toBe(requirePlaythrough(localData).scenarios)
    expect(selected.buildRevisions).toBe(localData.buildRevisions)
    expect(selected.revision).toBe(localData.revision + 1)
    expect(selected.changes.at(-1)).toMatchObject({ command: 'scenario.activate', changedPaths: [`playthroughs.${requirePlaythrough(selected).id}.activeScenarioId`] })
    const switchedGameSetup = activateGameSetup(selected, { gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID, now: TEST_NOW })
    expect(requirePlaythrough(switchedGameSetup).scenarios).toBe(requirePlaythrough(selected).scenarios)
    expect(requirePlaythrough(switchedGameSetup).activeScenarioId).toBe(scenarioId)
    const cleared = activateScenario(switchedGameSetup, { scenarioId: null, now: TEST_NOW })
    expect(requirePlaythrough(cleared).activeScenarioId).toBeUndefined()
    expect(requirePlaythrough(cleared).scenarios).toBe(requirePlaythrough(localData).scenarios)
    expect(activateScenario(cleared, { scenarioId: null })).toBe(cleared)
    expect(activateScenario(selected, { scenarioId })).toBe(selected)
  })

  it('rejects unknown identities and stale writes without changing the localData', () => {
    const localData = withScenario()
    for (const id of ['missing', '__proto__', 'constructor']) {
      expect(() => activateScenario(localData, { scenarioId: asId<ScenarioId>(id) })).toThrow('Scenario does not exist')
    }
    expect(() => activateScenario(localData, { scenarioId, expectedRevision: localData.revision - 1 })).toThrow('LocalData revision does not match')
    expect(requirePlaythrough(localData).activeScenarioId).toBeUndefined()
  })
})

describe('four-character team composition', () => {
  const withCharacters = () => ['one', 'two', 'three', 'four', 'five'].reduce((localData, id) => addTestCharacter(localData, id), createTestLocalData())
  const team = ['one', 'two', 'three', 'four'].map(id => asId<CharacterId>(id))

  it('requires exactly four distinct characters for an explicit team roster', () => {
    const localData = withCharacters()
    expect(() => createScenario(localData, { label: 'Short team', memberIds: team.slice(0, 3), gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID })).toThrow('exactly 4 distinct characters')
    expect(() => createScenario(localData, { label: 'Duplicate team', memberIds: [team[0]!, team[1]!, team[2]!, team[2]!], gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID })).toThrow('exactly 4 distinct characters')
  })

  it('keeps four roster slots independent from optional build assignments', () => {
    const localData = createScenario(withCharacters(), { id: asId<ScenarioId>('team'), label: 'Four-person team', memberIds: team, gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID })
    const scenario = requirePlaythrough(localData).scenarios.team!
    expect(scenario.memberIds).toEqual(team)
    expect(scenario.assignments).toEqual({})
    expect(validateScenario(localData, scenario.id).dimensions.structure.status).toBe('valid')
  })
})
