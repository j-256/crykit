import { nativeIdentity, nativeRecord } from '../domain/native-game'
import type { DefinitionOption } from './definitions'

export function preferredDefinitionChoices(options: readonly DefinitionOption[], selectedKey?: string): readonly DefinitionOption[] {
  const nativeNames = new Set(options.filter(option => nativeIdentity(option.record)?.mode === 'base').map(option => `${option.kind}:${option.name.toLocaleLowerCase()}`))
  return options.filter(option => {
    if (option.ref.kind === 'personal' || option.key === selectedKey) return true
    const native = nativeIdentity(option.record)
    if (native) return native.mode === 'base'
    const legacy = 'legacy' in option.record ? option.record.legacy : undefined
    return !(nativeRecord(legacy) && legacy.supplemental === true && nativeNames.has(`${option.kind}:${option.name.toLocaleLowerCase()}`))
  })
}
