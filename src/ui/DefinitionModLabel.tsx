import { definitionModAvailability, modAvailabilityLabel } from '../catalog/mods'
import type { EntityRef, Profile, RulesetRevision } from '../domain/types'

export function DefinitionModLabel({ profile, ruleset, value, className = '' }: { readonly profile: Profile; readonly ruleset?: RulesetRevision; readonly value?: EntityRef | null; readonly className?: string }) {
  if (!value) return null
  const label = modAvailabilityLabel(definitionModAvailability(profile, value, ruleset))
  return label ? <span className={`definition-mod-label ${className}`.trim()}>{label}</span> : null
}
