import { assertTextLength, DomainError } from './core'
import { MAX_SHORT_TEXT_LENGTH } from './limits'
import type { Knowledge, RulesetRevision } from './types'

export type ModState = 'enabled' | 'disabled' | 'unknown' | 'conflicting'
export type ModConfiguration = Pick<RulesetRevision, 'mods' | 'disabledMods'>
export interface ModSelection {
  readonly name: string
  readonly state: Exclude<ModState, 'conflicting'>
}

export function normalizeModName(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

export function recordedModNames(configuration: ModConfiguration): readonly string[] {
  const unique = new Map<string, string>()
  for (const list of [configuration.mods, configuration.disabledMods]) {
    const names = list?.state === 'known' ? list.value : list?.state === 'conflicting' ? list.claims.flatMap(claim => claim.value) : []
    for (const name of names) {
      if (!unique.has(normalizeModName(name))) unique.set(normalizeModName(name), name)
    }
  }
  return [...unique.values()]
}

export function modState(configuration: ModConfiguration | undefined, name: string): ModState {
  const key = normalizeModName(name)
  const includes = (names: readonly string[]) => names.some(value => normalizeModName(value) === key)
  const membership = (list: Knowledge<readonly string[]> | undefined) => {
    if (list?.state === 'known') return includes(list.value)
    if (list?.state !== 'conflicting') return false
    const claims = list.claims.map(claim => includes(claim.value))
    return claims.length > 0 && claims.every(Boolean) ? true : claims.some(Boolean) ? 'conflicting' : false
  }
  const isEnabled = membership(configuration?.mods)
  const isDisabled = membership(configuration?.disabledMods)
  if (isEnabled === 'conflicting' || isDisabled === 'conflicting') return 'conflicting'
  if (isEnabled && isDisabled) return 'conflicting'
  return isEnabled ? 'enabled' : isDisabled ? 'disabled' : 'unknown'
}

export function updateModSelections(configuration: ModConfiguration, selections: readonly ModSelection[]): ModConfiguration {
  const changes = new Map(selections.map(selection => [normalizeModName(selection.name), selection]))
  const reviseNames = (names: readonly string[], state: ModSelection['state']) => {
    const values = [...names.filter(name => !changes.has(normalizeModName(name))), ...[...changes.values()].filter(selection => selection.state === state).map(selection => selection.name)]
    return values.length === names.length && values.every((name, index) => name === names[index]) ? names : values
  }
  const reviseList = (list: Knowledge<readonly string[]> | undefined, state: ModSelection['state']): Knowledge<readonly string[]> | undefined => {
    if (list?.state === 'conflicting') {
      const claims = list.claims.map(claim => {
        const value = reviseNames(claim.value, state)
        return value === claim.value ? claim : { ...claim, value, sources: [] }
      })
      if (claims.every((claim, index) => claim === list.claims[index])) return list
      const identity = (names: readonly string[]) => JSON.stringify([...new Set(names.map(normalizeModName))].sort())
      if (claims.every(claim => identity(claim.value) === identity(claims[0].value))) return { state: 'known', value: claims[0].value }
      return { state: 'conflicting', claims }
    }
    const previous = list?.state === 'known' ? list.value : []
    const value = reviseNames(previous, state)
    return value === previous ? list : { state: 'known', value }
  }
  const next = { mods: reviseList(configuration.mods, 'enabled') ?? { state: 'unknown' as const }, disabledMods: reviseList(configuration.disabledMods, 'disabled') }
  assertModConfiguration(next)
  return next
}

export function assertModConfiguration(configuration: ModConfiguration): void {
  const lists: readonly (Knowledge<readonly string[]> | undefined)[] = [configuration.mods, configuration.disabledMods]
  for (const list of lists) {
    const names = list?.state === 'known' ? list.value : list?.state === 'conflicting' ? list.claims.flatMap(claim => claim.value) : []
    for (const name of names) {
      if (!name.trim()) throw new DomainError('INVALID_INPUT', 'Mod names must not be empty')
      assertTextLength(name, 'Mod name', MAX_SHORT_TEXT_LENGTH)
    }
  }
  if (configuration.mods.state === 'known' && configuration.disabledMods?.state === 'known') {
    const disabled = new Set(configuration.disabledMods.value.map(normalizeModName))
    const overlap = configuration.mods.value.filter(name => disabled.has(normalizeModName(name)))
    if (overlap.length) throw new DomainError('INVALID_INPUT', `Mods cannot be both enabled and disabled: ${overlap.join(', ')}`)
  }
}
