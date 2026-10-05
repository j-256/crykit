import { expect, it } from 'vitest'
import { createGameSetupRevision, updateGameSetupRevision } from './local-data'
import { createTestLocalData, known, TEST_GAME_SETUP_REVISION_ID } from './test-helpers'
import { buildBehavior, saveBuildBehavior } from './build-behavior'
import type { GameSetupRevision } from './types'

const RETAINED_DIFFICULTIES: readonly GameSetupRevision['difficulty'][] = [undefined, { version: 1, selection: { state: 'unknown', reason: 'Not recorded in the imported setup' } }, { version: 1, selection: { state: 'known', value: 2 } }]

it.each(RETAINED_DIFFICULTIES)('preserves existing difficulty through unrelated setup and Build edits: %j', difficulty => {
  const original = createTestLocalData()
  const source = { ...original.gameSetups[TEST_GAME_SETUP_REVISION_ID]!, ...(difficulty === undefined ? {} : { difficulty }) }
  const data = { ...original, gameSetups: { ...original.gameSetups, [source.id]: source } }
  const revised = updateGameSetupRevision(data, { sourceRevisionId: source.id, label: 'Renamed setup' })
  expect(revised.gameSetups[revised.planningGameSetupRevisionId!]!.difficulty).toEqual(difficulty)
  const saved = saveBuildBehavior(revised, { ...buildBehavior(source), gameVersion: known('Synthetic changed version') })
  expect(saved.setup.difficulty).toEqual(difficulty)
  expect(saved.localData.gameSetups[source.id]).toEqual(source)
})

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
