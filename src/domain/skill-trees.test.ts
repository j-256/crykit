import { describe, expect, it } from 'vitest'
import { CHARACTER, OTHER, screenshotTestProfile, TEST_CAPTURE } from './skill-trees.test-helpers'
import { upsertLearnedNode } from './characters'
import { asId } from './core'
import { logicalEntityKey } from './definitions'
import { known, personalRef, TEST_NOW, TEST_RULESET_REVISION_ID } from './test-helpers'
import { findSkillTreeLayout, importSkillTrees } from './skill-trees'
import type { CharacterId, Profile } from './types'
import { validateNativeProfileGraph } from '../interchange/native'

describe('reviewed screenshot observations', () => {
  it('records only mapped known states and retains unresolved evidence without inferring class progress', () => {
    const profile = screenshotTestProfile()
    const result = importSkillTrees(profile, [], [TEST_CAPTURE], profile.revision, TEST_NOW)
    expect(result.revision).toBe(profile.revision + 1)
    expect(result.characters[OTHER]).toEqual(profile.characters[OTHER])
    expect(result.characters[CHARACTER].classProgress).toEqual({})
    expect(result.characters[CHARACTER].snapshots).toEqual({})
    expect(result.inventory).toBe(profile.inventory)
    expect(result.progress).toBe(profile.progress)
    expect(result.builds).toBe(profile.builds)
    const nodes = Object.values(result.characters[CHARACTER].learnedNodes)
    expect(nodes.map(node => node.learned)).toEqual([expect.objectContaining(known(true)), expect.objectContaining(known(false))])
    expect(nodes.every(node => node.actualPaidLp.state === 'unknown')).toBe(true)
    expect(Object.values(result.skillTreeCaptures!)[0].squares).toEqual(TEST_CAPTURE.squares)
    expect(() => validateNativeProfileGraph(result, [])).not.toThrow()
  })

  it('deduplicates identical captures and enriches unresolved mappings when reimported', () => {
    const profile = screenshotTestProfile()
    const result = importSkillTrees(profile, [], [TEST_CAPTURE, TEST_CAPTURE], profile.revision, TEST_NOW)
    expect(Object.keys(result.skillTreeCaptures!)).toHaveLength(1)
    expect(importSkillTrees(result, [], [TEST_CAPTURE], result.revision)).toBe(result)
    const extended = { ...TEST_CAPTURE, mappings: [...TEST_CAPTURE.mappings, { row: 1, column: 0, ref: personalRef('Third skill'), kind: 'ability' as const }] }
    const enriched = importSkillTrees(result, [], [extended], result.revision)
    expect(Object.keys(enriched.skillTreeCaptures!)).toHaveLength(1)
    expect(Object.values(enriched.characters[CHARACTER].learnedNodes)).toHaveLength(3)
    expect(Object.values(enriched.characters[CHARACTER].learnedNodes)[0].sources).toHaveLength(1)
  })

  it('keeps simultaneous and prior disagreements as conflicts and preserves actual LP', () => {
    let profile = screenshotTestProfile()
    profile = upsertLearnedNode(profile, { characterId: CHARACTER, ref: personalRef('Practice skill'), kind: 'ability', learned: known(false), actualPaidLp: known(7) })
    const contradictory = { ...TEST_CAPTURE, sourceDigest: 'b'.repeat(64), squares: TEST_CAPTURE.squares.map(square => ({ ...square, state: 'available' as const })) }
    const result = importSkillTrees(profile, [], [TEST_CAPTURE, contradictory], profile.revision)
    const record = result.characters[CHARACTER].learnedNodes[logicalEntityKey(profile, personalRef('Practice skill'))]
    expect(record.learned.state).toBe('conflicting')
    expect(record.actualPaidLp).toEqual(known(7))
    expect(record.learned.state === 'conflicting' && record.learned.claims.map(claim => claim.value)).toEqual([false, true, false])
  })

  it('reuses layouts across characters only in the same ruleset and exact shape', () => {
    const profile = screenshotTestProfile()
    const result = importSkillTrees(profile, [], [TEST_CAPTURE], profile.revision)
    expect(findSkillTreeLayout(result, TEST_CAPTURE.classRef, TEST_CAPTURE.squares, TEST_RULESET_REVISION_ID)?.mappings).toEqual(TEST_CAPTURE.mappings)
    expect(findSkillTreeLayout(result, TEST_CAPTURE.classRef, TEST_CAPTURE.squares)).toBeUndefined()
    expect(findSkillTreeLayout(result, TEST_CAPTURE.classRef, TEST_CAPTURE.squares.slice(1), TEST_RULESET_REVISION_ID)).toBeUndefined()
    const second = importSkillTrees(result, [], [{ ...TEST_CAPTURE, characterId: OTHER }], result.revision)
    expect(Object.keys(second.skillTreeLayouts!)).toHaveLength(1)
    expect(Object.keys(second.characters[OTHER].learnedNodes)).toHaveLength(2)
  })

  it('rejects invalid batches atomically, stale review, reused mappings, and unconfirmed identities', () => {
    const profile = screenshotTestProfile()
    const original = structuredClone(profile)
    for (const invalid of [
      { ...TEST_CAPTURE, reviewed: false },
      { ...TEST_CAPTURE, characterId: asId<CharacterId>('missing') },
      { ...TEST_CAPTURE, classRef: personalRef('Practice skill') },
      { ...TEST_CAPTURE, mappings: [...TEST_CAPTURE.mappings, { ...TEST_CAPTURE.mappings[0], row: 1 }] },
      { ...TEST_CAPTURE, squares: [...TEST_CAPTURE.squares, TEST_CAPTURE.squares[0]] },
      { ...TEST_CAPTURE, filename: '../unsafe.png' },
    ]) expect(() => importSkillTrees(profile, [], [TEST_CAPTURE, invalid], profile.revision)).toThrow()
    expect(() => importSkillTrees(profile, [], [TEST_CAPTURE], profile.revision - 1)).toThrow()
    expect(profile).toEqual(original)
  })

  it('rejects invalid screenshot graphs during backup restore', () => {
    const profile = screenshotTestProfile()
    const result = importSkillTrees(profile, [], [TEST_CAPTURE], profile.revision)
    const id = Object.keys(result.skillTreeCaptures!)[0]
    for (const patch of [{ characterId: OTHER + '-missing' }, { squares: [TEST_CAPTURE.squares[0], TEST_CAPTURE.squares[0]] }, { mappings: [TEST_CAPTURE.mappings[0], TEST_CAPTURE.mappings[0]] }, { classRef: personalRef('Practice skill') }]) {
      const invalid = { ...result, skillTreeCaptures: { [id]: { ...result.skillTreeCaptures![id], ...patch } } } as Profile
      expect(() => validateNativeProfileGraph(invalid, [])).toThrow()
    }
  })
})
