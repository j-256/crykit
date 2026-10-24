import { SUGGESTED_BUILD_SLOTS } from './build-planning'
import { createId } from './core'
import { createGameSetupRevision, createPlaythrough, DEFAULT_GAME_DIFFICULTY, DEFAULT_GAME_MODE, DEFAULT_PP_COSTS_NONNEGATIVE, DEFAULT_PP_LIMIT, selectPlaythrough, type CreatePlaythroughInput } from './local-data'
import type { CatalogSnapshot, GameSetupRevision, GameSetupRevisionId, LocalData } from './types'
import type { LibraryDefaults } from '../workspace/file-types'
import { applyLibraryDefaultsToNewSetup } from './mod-library-actions'

export function latestGameSetups(localData: LocalData): readonly GameSetupRevision[] {
  const latest = new Map<string, GameSetupRevision>()
  for (const setup of Object.values(localData.gameSetups)) {
    const previous = latest.get(setup.gameSetupId)
    if (!previous || setup.revision > previous.revision) latest.set(setup.gameSetupId, setup)
  }
  return [...latest.values()].sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
}

export function createPlaythroughWithSetup(localData: LocalData, input: CreatePlaythroughInput & { readonly catalogLock: GameSetupRevision['catalogLock']; readonly defaultMods?: { readonly defaults: LibraryDefaults; readonly catalogs: readonly CatalogSnapshot[] } }): LocalData {
  let next = localData
  const setupId = input.currentGameSetupRevisionId ?? createId<GameSetupRevisionId>('gameSetupRevision')
  if (!input.currentGameSetupRevisionId) {
    const behavior = { label: `${input.label.trim()} settings`, platform: { state: 'unknown' as const }, gameVersion: { state: 'unknown' as const }, mode: { state: 'known' as const, value: DEFAULT_GAME_MODE }, difficulty: DEFAULT_GAME_DIFFICULTY, mods: { state: 'unknown' as const }, ppLimit: { state: 'known' as const, value: DEFAULT_PP_LIMIT }, ppCostsNonNegative: { state: 'known' as const, value: DEFAULT_PP_COSTS_NONNEGATIVE }, slots: SUGGESTED_BUILD_SLOTS, catalogLock: input.catalogLock }
    const configured = input.defaultMods ? applyLibraryDefaultsToNewSetup(behavior, input.defaultMods.defaults, input.defaultMods.catalogs) : behavior
    next = createGameSetupRevision(next, { ...configured, id: setupId, activate: false, now: input.now, expectedRevision: input.expectedRevision })
  }
  next = createPlaythrough(next, { ...input, currentGameSetupRevisionId: setupId, select: false, expectedRevision: input.currentGameSetupRevisionId ? input.expectedRevision : next.revision })
  const created = Object.values(next.playthroughs).find(playthrough => !localData.playthroughs[playthrough.id])!
  return input.select === false ? next : selectPlaythrough(next, { playthroughId: created.id, now: input.now, expectedRevision: next.revision })
}
