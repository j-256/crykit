import { sameValue } from './definition-values'
import { DEFAULT_PP_LIMIT, addGameSetupRevision } from './local-data'
import { MAX_SHORT_TEXT_LENGTH } from './limits'
import { modCatalogRevision } from './mod-layers'
import { normalizeModName } from './mods'
import type { GameSetupRevision, GameSetupRevisionId, Knowledge, LocalData, Timestamp } from './types'

export type BuildBehavior = Omit<GameSetupRevision, 'id' | 'gameSetupId' | 'revision' | 'createdAt'>

export function buildBehavior(setup: GameSetupRevision): BuildBehavior {
  const { id, gameSetupId, revision, createdAt, ...behavior } = setup
  return behavior
}

function comparableBehavior(behavior: BuildBehavior) {
  const { label, id, gameSetupId, revision, createdAt, ...configuration } = behavior as GameSetupRevision
  const names = (values: readonly string[]) => [...new Set(values.map(normalizeModName))].sort()
  const list = (value: Knowledge<readonly string[]> | undefined) => value?.state === 'known' ? { ...value, value: names(value.value) } : value ?? { state: 'unknown' }
  return { ...configuration, difficulty: configuration.difficulty ?? { version: 1, selection: { state: 'unknown' } }, ppLimit: configuration.ppLimit ?? { state: 'known', value: DEFAULT_PP_LIMIT }, mods: list(configuration.mods), disabledMods: list(configuration.disabledMods), customMods: names(configuration.customMods ?? []), definitionOverrides: configuration.definitionOverrides ?? [] }
}

export function sameBuildBehavior(left: BuildBehavior | undefined, right: BuildBehavior | undefined): boolean {
  return Boolean(left && right && sameValue(comparableBehavior(left), comparableBehavior(right)))
}

export function uniqueGameSetupLabel(label: string, setups: LocalData['gameSetups'], kind: string): string {
  const normalize = (name: string) => name.trim().toLowerCase()
  const names = new Set(Object.values(setups).map(setup => normalize(setup.label)))
  if (!names.has(normalize(label))) return label
  for (let copy = 1; ; copy += 1) {
    const suffix = copy === 1 ? ` (${kind})` : ` (${kind} ${copy})`
    const candidate = `${label.trim().slice(0, MAX_SHORT_TEXT_LENGTH - suffix.length).trimEnd()}${suffix}`
    if (!names.has(normalize(candidate))) return candidate
  }
}

export function saveBuildBehavior(localData: LocalData, behavior: BuildBehavior, now?: Timestamp | string, id?: GameSetupRevisionId): { readonly localData: LocalData; readonly setup: GameSetupRevision } {
  const composition = behavior.modComposition
  const origins = composition ? Object.values(localData.gameSetups).filter(setup => sameValue(setup.modComposition, composition) && setup.catalogLock[composition.baseline.catalogId] === modCatalogRevision(setup.id)) : []
  const origin = composition ? origins.find(setup => modCatalogRevision(setup.id) === behavior.catalogLock[composition.baseline.catalogId]) ?? origins[0] : undefined
  const modCatalogRevisionId = origin ? modCatalogRevision(origin.id) : undefined
  const candidate = origin ? { ...behavior, catalogLock: { ...behavior.catalogLock, [composition!.baseline.catalogId]: modCatalogRevisionId! } } : behavior
  const matches = Object.values(localData.gameSetups).filter(setup => sameBuildBehavior(candidate, setup))
  const match = matches.find(setup => setup.label === candidate.label) ?? matches[0]
  if (match) return { localData, setup: match }
  const next = addGameSetupRevision(localData, { ...candidate, id, label: uniqueGameSetupLabel(candidate.label, localData.gameSetups, 'custom'), modCatalogRevisionId, activate: false, now, expectedRevision: localData.revision })
  const setup = Object.values(next.gameSetups).find(setup => !localData.gameSetups[setup.id])!
  return { localData: next, setup }
}
