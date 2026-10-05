import { SUGGESTED_BUILD_SLOTS } from './build-planning'
import { createId } from './core'
import { createGameSetupRevision, createPlaythrough, DEFAULT_GAME_DIFFICULTY, selectPlaythrough, type CreatePlaythroughInput } from './local-data'
import type { GameSetupRevision, GameSetupRevisionId, LocalData } from './types'

export function latestGameSetups(localData: LocalData): readonly GameSetupRevision[] {
  const latest = new Map<string, GameSetupRevision>()
  for (const setup of Object.values(localData.gameSetups)) {
    const previous = latest.get(setup.gameSetupId)
    if (!previous || setup.revision > previous.revision) latest.set(setup.gameSetupId, setup)
  }
  return [...latest.values()].sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
}

export function createPlaythroughWithSetup(localData: LocalData, input: CreatePlaythroughInput & { readonly catalogLock: GameSetupRevision['catalogLock'] }): LocalData {
  let next = localData
  const setupId = input.currentGameSetupRevisionId ?? createId<GameSetupRevisionId>('gameSetupRevision')
  if (!input.currentGameSetupRevisionId) {
    next = createGameSetupRevision(next, { id: setupId, label: `${input.label.trim()} settings`, platform: { state: 'unknown' }, gameVersion: { state: 'unknown' }, difficulty: DEFAULT_GAME_DIFFICULTY, mods: { state: 'unknown' }, slots: SUGGESTED_BUILD_SLOTS, catalogLock: input.catalogLock, activate: false, now: input.now, expectedRevision: input.expectedRevision })
  }
  next = createPlaythrough(next, { ...input, currentGameSetupRevisionId: setupId, select: false, expectedRevision: input.currentGameSetupRevisionId ? input.expectedRevision : next.revision })
  const created = Object.values(next.playthroughs).find(playthrough => !localData.playthroughs[playthrough.id])!
  return input.select === false ? next : selectPlaythrough(next, { playthroughId: created.id, now: input.now, expectedRevision: next.revision })
}
