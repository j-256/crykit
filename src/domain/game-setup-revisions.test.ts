import { expect, it } from 'vitest'
import { createGameSetupRevision, updateGameSetupRevision } from './local-data'
import { createTestLocalData, known, TEST_GAME_SETUP_REVISION_ID } from './test-helpers'

it('gives edits from an older setup the next unused revision without changing saved history', () => {
  const original = createTestLocalData()
  const source = original.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
  const newer = updateGameSetupRevision(original, { sourceRevisionId: source.id, platform: known('Windows') })
  const unrelated = createGameSetupRevision(newer, { label: 'Synthetic independent setup', revision: 50, activate: false })
  const edited = updateGameSetupRevision(unrelated, { sourceRevisionId: source.id, label: 'Synthetic historical edit' })
  const result = edited.gameSetups[edited.planningGameSetupRevisionId!]!
  expect(result.revision).toBe(source.revision + 2)
  expect(result.gameSetupId).toBe(source.gameSetupId)
  expect(result.platform).toEqual(source.platform)
  for (const [id, setup] of Object.entries(unrelated.gameSetups)) expect(edited.gameSetups[id]).toEqual(setup)
  expect(edited.playthroughs).toEqual(original.playthroughs)
})
