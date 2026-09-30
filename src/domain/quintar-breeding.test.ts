import { describe, expect, it } from 'vitest'
import { QUINTAR_STEP, type QuintarBreedingStepId } from '../catalog/quintar-breeding'
import { asId, createPlaythrough, requirePlaythrough, toggleQuintarStep } from './index'
import { createTestLocalData, TEST_NOW, TEST_PLAYTHROUGH_ID } from './test-helpers'
import type { PlaythroughId } from './types'

describe('quintar guide observations', () => {
  it('records only the clicked step, keeps observations independent, and targets an explicit playthrough', () => {
    const original = createTestLocalData()
    const otherId = asId<PlaythroughId>('other-playthrough')
    const withOther = createPlaythrough(original, { id: otherId, label: 'Other save', select: true, now: TEST_NOW })
    const next = toggleQuintarStep(withOther, { stepId: QUINTAR_STEP.golden, playthroughId: TEST_PLAYTHROUGH_ID, expectedRevision: withOther.revision, now: TEST_NOW })
    const before = requirePlaythrough(withOther, TEST_PLAYTHROUGH_ID)
    const after = requirePlaythrough(next, TEST_PLAYTHROUGH_ID)
    expect(after.quintarBreeding).toEqual({ [QUINTAR_STEP.golden]: TEST_NOW })
    expect(next.selectedPlaythroughId).toBe(otherId)
    expect(requirePlaythrough(next, otherId)).toBe(requirePlaythrough(withOther, otherId))
    for (const key of ['characters', 'inventory', 'inventoryEvents', 'progress', 'scenarios', 'goals'] as const) expect(after[key]).toBe(before[key])
    expect(next.builds).toBe(withOther.builds)
    expect(next.gameSetups).toBe(withOther.gameSetups)
    expect(next.changes.at(-1)?.changedPaths).toEqual([`playthroughs.${TEST_PLAYTHROUGH_ID}.quintarBreeding.golden`])
    const undone = toggleQuintarStep(next, { stepId: QUINTAR_STEP.golden, playthroughId: TEST_PLAYTHROUGH_ID, now: TEST_NOW })
    expect(requirePlaythrough(undone, TEST_PLAYTHROUGH_ID).quintarBreeding).toEqual({})
  })

  it('rejects stale writes, unknown steps, and missing playthroughs without mutation', () => {
    const localData = createTestLocalData()
    const input = { stepId: QUINTAR_STEP.babel, playthroughId: TEST_PLAYTHROUGH_ID, now: TEST_NOW }
    expect(() => toggleQuintarStep(localData, { ...input, expectedRevision: localData.revision - 1 })).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
    expect(() => toggleQuintarStep(localData, { ...input, stepId: '__proto__' as QuintarBreedingStepId })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => toggleQuintarStep(localData, { ...input, playthroughId: asId<PlaythroughId>('missing') })).toThrow(expect.objectContaining({ code: 'MISSING_PLAYTHROUGH' }))
    expect(requirePlaythrough(localData).quintarBreeding).toBeUndefined()
  })
})
