import { describe, expect, it } from 'vitest'
import { CHARACTER, OTHER, screenshotTestLocalData, TEST_CAPTURE } from './skill-trees.test-helpers'
import { upsertLearnedNode } from './characters'
import { asId, requirePlaythrough } from './core'
import { logicalEntityKey } from './definitions'
import { known, personalRef, TEST_NOW, TEST_GAME_SETUP_REVISION_ID } from './test-helpers'
import { findSkillTreeLayout, importSkillTrees } from './skill-trees'
import type { CharacterId, LocalData } from './types'
import { validateNativeLocalDataGraph } from '../interchange/native'

describe('reviewed screenshot observations', () => {
  it('records only mapped known states and retains unresolved evidence without inferring class progress', () => {
    const localData = screenshotTestLocalData()
    const result = importSkillTrees(localData, [], [TEST_CAPTURE], localData.revision, TEST_NOW)
    expect(result.revision).toBe(localData.revision + 1)
    expect(requirePlaythrough(result).characters[OTHER]).toEqual(requirePlaythrough(localData).characters[OTHER])
    expect(requirePlaythrough(result).characters[CHARACTER].classProgress).toEqual({})
    expect(requirePlaythrough(result).characters[CHARACTER].snapshots).toEqual({})
    expect(requirePlaythrough(result).inventory).toBe(requirePlaythrough(localData).inventory)
    expect(requirePlaythrough(result).progress).toBe(requirePlaythrough(localData).progress)
    expect(result.builds).toBe(localData.builds)
    const nodes = Object.values(requirePlaythrough(result).characters[CHARACTER].learnedNodes)
    expect(nodes.map(node => node.learned)).toEqual([expect.objectContaining(known(true)), expect.objectContaining(known(false))])
    expect(nodes.every(node => node.actualPaidLp.state === 'unknown')).toBe(true)
    expect(Object.values(requirePlaythrough(result).skillTreeCaptures!)[0].squares).toEqual(TEST_CAPTURE.squares)
    expect(() => validateNativeLocalDataGraph(result, [])).not.toThrow()
  })

  it('deduplicates identical captures and enriches unresolved mappings when reimported', () => {
    const localData = screenshotTestLocalData()
    const result = importSkillTrees(localData, [], [TEST_CAPTURE, TEST_CAPTURE], localData.revision, TEST_NOW)
    expect(Object.keys(requirePlaythrough(result).skillTreeCaptures!)).toHaveLength(1)
    expect(importSkillTrees(result, [], [TEST_CAPTURE], result.revision)).toBe(result)
    const extended = { ...TEST_CAPTURE, mappings: [...TEST_CAPTURE.mappings, { row: 1, column: 0, ref: personalRef('Third skill'), kind: 'ability' as const }] }
    const enriched = importSkillTrees(result, [], [extended], result.revision)
    expect(Object.keys(requirePlaythrough(enriched).skillTreeCaptures!)).toHaveLength(1)
    expect(Object.values(requirePlaythrough(enriched).characters[CHARACTER].learnedNodes)).toHaveLength(3)
    expect(Object.values(requirePlaythrough(enriched).characters[CHARACTER].learnedNodes)[0].sources).toHaveLength(1)
  })

  it('keeps simultaneous and prior disagreements as conflicts and preserves actual LP', () => {
    let localData = screenshotTestLocalData()
    localData = upsertLearnedNode(localData, { characterId: CHARACTER, ref: personalRef('Practice skill'), kind: 'ability', learned: known(false), actualPaidLp: known(7) })
    const contradictory = { ...TEST_CAPTURE, sourceDigest: 'b'.repeat(64), squares: TEST_CAPTURE.squares.map(square => ({ ...square, state: 'available' as const })) }
    const result = importSkillTrees(localData, [], [TEST_CAPTURE, contradictory], localData.revision)
    const record = requirePlaythrough(result).characters[CHARACTER].learnedNodes[logicalEntityKey(localData, personalRef('Practice skill'))]
    expect(record.learned.state).toBe('conflicting')
    expect(record.actualPaidLp).toEqual(known(7))
    expect(record.learned.state === 'conflicting' && record.learned.claims.map(claim => claim.value)).toEqual([false, true, false])
  })

  it('reuses layouts across characters only in the same gameSetup and exact shape', () => {
    const localData = screenshotTestLocalData()
    const result = importSkillTrees(localData, [], [TEST_CAPTURE], localData.revision)
    expect(findSkillTreeLayout(result, TEST_CAPTURE.classRef, TEST_CAPTURE.squares, TEST_GAME_SETUP_REVISION_ID)?.mappings).toEqual(TEST_CAPTURE.mappings)
    expect(findSkillTreeLayout(result, TEST_CAPTURE.classRef, TEST_CAPTURE.squares)).toBeUndefined()
    expect(findSkillTreeLayout(result, TEST_CAPTURE.classRef, TEST_CAPTURE.squares.slice(1), TEST_GAME_SETUP_REVISION_ID)).toBeUndefined()
    const second = importSkillTrees(result, [], [{ ...TEST_CAPTURE, characterId: OTHER }], result.revision)
    expect(Object.keys(second.skillTreeLayouts!)).toHaveLength(1)
    expect(Object.keys(requirePlaythrough(second).characters[OTHER].learnedNodes)).toHaveLength(2)
  })

  it('rejects invalid batches atomically, stale review, reused mappings, and unconfirmed identities', () => {
    const localData = screenshotTestLocalData()
    const original = structuredClone(localData)
    for (const invalid of [
      { ...TEST_CAPTURE, reviewed: false },
      { ...TEST_CAPTURE, characterId: asId<CharacterId>('missing') },
      { ...TEST_CAPTURE, classRef: personalRef('Practice skill') },
      { ...TEST_CAPTURE, mappings: [...TEST_CAPTURE.mappings, { ...TEST_CAPTURE.mappings[0], row: 1 }] },
      { ...TEST_CAPTURE, squares: [...TEST_CAPTURE.squares, TEST_CAPTURE.squares[0]] },
      { ...TEST_CAPTURE, filename: '../unsafe.png' },
    ]) expect(() => importSkillTrees(localData, [], [TEST_CAPTURE, invalid], localData.revision)).toThrow()
    expect(() => importSkillTrees(localData, [], [TEST_CAPTURE], localData.revision - 1)).toThrow()
    expect(localData).toEqual(original)
  })

  it('rejects invalid screenshot graphs during backup restore', () => {
    const localData = screenshotTestLocalData()
    const result = importSkillTrees(localData, [], [TEST_CAPTURE], localData.revision)
    const id = Object.keys(requirePlaythrough(result).skillTreeCaptures!)[0]
    for (const patch of [{ characterId: OTHER + '-missing' }, { squares: [TEST_CAPTURE.squares[0], TEST_CAPTURE.squares[0]] }, { mappings: [TEST_CAPTURE.mappings[0], TEST_CAPTURE.mappings[0]] }, { classRef: personalRef('Practice skill') }]) {
      const playthrough = requirePlaythrough(result)
      const invalid = {
        ...result,
        playthroughs: {
          ...result.playthroughs,
          [playthrough.id]: {
            ...playthrough,
            skillTreeCaptures: { [id]: { ...playthrough.skillTreeCaptures![id], ...patch } },
          },
        },
      } as LocalData
      expect(() => validateNativeLocalDataGraph(invalid, [])).toThrow()
    }
  })
})
