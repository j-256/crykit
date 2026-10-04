import { nativeIdentity } from '../domain/native-game'
import type { DefinitionOption } from './definitions'

export function preferredDefinitionChoices(options: readonly DefinitionOption[], selectedKey?: string): readonly DefinitionOption[] {
  const available = new Set(options.filter(option => option.ref.kind === 'catalog').map(option => option.ref.kind === 'catalog' ? JSON.stringify([option.ref.catalogId, option.ref.catalogRevisionId, option.ref.entityId]) : ''))
  return options.filter(option => {
    if (option.ref.kind === 'personal' || option.key === selectedKey) return true
    const native = nativeIdentity(option.record)
    if (native) return native.mode === 'base'
    return !option.nativeReferenceId || !available.has(JSON.stringify([option.ref.catalogId, option.ref.catalogRevisionId, option.nativeReferenceId]))
  })
}
