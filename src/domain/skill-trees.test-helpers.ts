import { createCharacter } from './characters'
import { asId } from './core'
import { addTestDefinition, createTestLocalData, personalRef, TEST_NOW, TEST_GAME_SETUP_REVISION_ID } from './test-helpers'
import type { ReviewedSkillTree } from './skill-trees'
import type { CharacterId, LocalData } from './types'

export const CHARACTER = asId<CharacterId>('synthetic-rowan')
export const OTHER = asId<CharacterId>('synthetic-mira')
export function screenshotTestLocalData(localData: LocalData = createTestLocalData()): LocalData {
  let next = createCharacter(localData, { id: CHARACTER, name: 'Rowan', now: TEST_NOW })
  next = createCharacter(next, { id: OTHER, name: 'Mira', now: TEST_NOW })
  next = addTestDefinition(next, 'Practice class', { kind: 'class' })
  for (const name of ['Practice skill', 'Second skill', 'Third skill']) next = addTestDefinition(next, name, { kind: 'ability' })
  return next
}

export const TEST_CAPTURE: ReviewedSkillTree = {
  characterId: CHARACTER,
  classRef: personalRef('Practice class'),
  gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
  sourceDigest: 'a'.repeat(64),
  filename: 'synthetic-tree.png',
  squares: [{ row: 0, column: 0, state: 'learned' }, { row: 0, column: 1, state: 'available' }, { row: 1, column: 0, state: 'locked' }, { row: 1, column: 1, state: 'unknown' }],
  mappings: [{ row: 0, column: 0, ref: personalRef('Practice skill'), kind: 'ability' }, { row: 0, column: 1, ref: personalRef('Second skill'), kind: 'ability' }],
  reviewed: true,
}
