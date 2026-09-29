import { definitionModAvailability, type DefinitionModAvailability } from '../catalog/mods'
import type { EntityRef, Profile, RulesetRevision } from '../domain/types'
import { Badge } from './components'

const MOD_STATE_LABELS: Readonly<Record<DefinitionModAvailability['state'], string>> = Object.freeze({
  unknown: 'Enabled status not recorded',
  conflicting: 'Enabled status has conflicting records',
  enabled: 'Enabled',
  disabled: 'Disabled',
})
export const LEARNABLE_INNATE_SKILLS_MOD_LABEL = 'Learnable Innate Skills'

export function ModBadge({ name, state, className = '' }: { readonly name: string; readonly state?: DefinitionModAvailability['state']; readonly className?: string }) {
  const status = state ? MOD_STATE_LABELS[state] : undefined
  const tone = state === 'enabled' ? 'positive' : state === 'disabled' || state === 'conflicting' ? 'danger' : state === 'unknown' ? 'warning' : 'info'
  return <span aria-label={`Mod: ${name}${status ? `. ${status}.` : ''}`} className={`mod-badge ${className}`.trim()} data-mod-badge={name} data-mod-state={state}><Badge tone={tone}>Mod: {name}</Badge>{status && <small className="mod-badge__state">{status}</small>}</span>
}

export function DefinitionModLabel({ profile, ruleset, value, className = '' }: { readonly profile: Profile; readonly ruleset?: RulesetRevision; readonly value?: EntityRef | null; readonly className?: string }) {
  if (!value) return null
  const availability = definitionModAvailability(profile, value, ruleset)
  return availability.requiredMod ? <ModBadge className={`definition-mod-label ${className}`.trim()} name={availability.requiredMod} state={availability.state}/> : null
}
