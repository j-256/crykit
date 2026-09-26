import { assertTextLength, DomainError } from './core'
import { MAX_SHORT_TEXT_LENGTH } from './limits'
import type { Knowledge, RulesetRevision } from './types'

export type ModState = 'enabled' | 'disabled' | 'unknown' | 'conflicting'
export type ModConfiguration = Pick<RulesetRevision, 'mods' | 'disabledMods'>

export function normalizeModName(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

export function parseModNames(text: string): readonly string[] {
  const unique = new Map<string, string>()
  for (const line of text.split('\n')) {
    const name = line.trim()
    if (name && !unique.has(normalizeModName(name))) unique.set(normalizeModName(name), name)
  }
  return [...unique.values()]
}

export function modState(configuration: ModConfiguration | undefined, name: string): ModState {
  const key = normalizeModName(name)
  const includes = (names: readonly string[]) => names.some(value => normalizeModName(value) === key)
  const enabled = configuration?.mods
  const disabled = configuration?.disabledMods
  if ([enabled, disabled].some(value => value?.state === 'conflicting' && value.claims.some(claim => includes(claim.value)))) return 'conflicting'
  const isEnabled = enabled?.state === 'known' && includes(enabled.value)
  const isDisabled = disabled?.state === 'known' && includes(disabled.value)
  if (isEnabled && isDisabled) return 'conflicting'
  return isEnabled ? 'enabled' : isDisabled ? 'disabled' : 'unknown'
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
