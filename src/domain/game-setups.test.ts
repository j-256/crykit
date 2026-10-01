import { describe, expect, it } from 'vitest'
import { createPlaythroughWithSetup, latestGameSetups } from './game-setups'
import { createTestLocalData, TEST_NOW } from './test-helpers'
import { requirePlaythrough } from './core'
import { createPlaythrough, selectPlaythrough, updateGameSetupRevision } from './local-data'

describe('explicit tracking settings', () => {
  it('starts a fresh playthrough with Standard mode, unknown game context, and empty records', () => {
    const original = createTestLocalData()
    const next = createPlaythroughWithSetup(original, { label: 'Fresh game', catalogLock: {}, now: TEST_NOW, expectedRevision: original.revision })
    const playthrough = requirePlaythrough(next)
    const setup = next.gameSetups[playthrough.currentGameSetupRevisionId!]!
    expect(playthrough.id).not.toBe(original.selectedPlaythroughId)
    expect(setup.id).not.toBe(original.planningGameSetupRevisionId)
    expect(next.planningGameSetupRevisionId).toBe(setup.id)
    expect(setup.mode).toEqual({ state: 'known', value: 'Standard' })
    for (const field of ['platform', 'gameVersion', 'mods'] as const) expect(setup[field]).toEqual({ state: 'unknown' })
    for (const field of ['characters', 'inventory', 'inventoryEvents', 'progress', 'scenarios', 'goals'] as const) expect(playthrough[field]).toEqual({})
    expect(next.playthroughs[original.selectedPlaythroughId!]).toEqual(requirePlaythrough(original))
    expect(next.buildRevisions).toEqual(original.buildRevisions)
  })

  it('uses an explicitly chosen immutable revision without copying tracked records', () => {
    const original = createTestLocalData()
    const setupId = original.planningGameSetupRevisionId!
    const next = createPlaythroughWithSetup(original, { label: 'Another game', currentGameSetupRevisionId: setupId, catalogLock: {}, now: TEST_NOW })
    expect(requirePlaythrough(next).currentGameSetupRevisionId).toBe(setupId)
    expect(requirePlaythrough(next).characters).toEqual({})
    expect(next.gameSetups).toEqual(original.gameSetups)
  })

  it('does not carry another playthrough settings into an unconfigured legacy playthrough', () => {
    const original = createTestLocalData()
    const created = createPlaythrough(original, { label: 'Legacy unconfigured', select: false, now: TEST_NOW })
    const legacy = Object.values(created.playthroughs).find(value => !original.playthroughs[value.id])!
    const selected = selectPlaythrough(created, { playthroughId: legacy.id, now: TEST_NOW })
    expect(selected.planningGameSetupRevisionId).toBeUndefined()
    expect(selected.gameSetups).toEqual(original.gameSetups)
  })

  it('retains history and tracking pins when saving a standalone setup revision', () => {
    const original = createTestLocalData()
    const source = original.gameSetups[original.planningGameSetupRevisionId!]!
    const next = updateGameSetupRevision(original, { sourceRevisionId: source.id, gameVersion: { state: 'known', value: 'synthetic' }, activate: false, now: TEST_NOW })
    expect(latestGameSetups(next).find(value => value.gameSetupId === source.gameSetupId)?.revision).toBe(source.revision + 1)
    expect(next.gameSetups[source.id]).toEqual(source)
    expect(next.playthroughs).toEqual(original.playthroughs)
    expect(next.planningGameSetupRevisionId).toBe(original.planningGameSetupRevisionId)
  })
})
