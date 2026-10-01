import { definitionModAvailability, type DefinitionModAvailability } from '../catalog/mods'
import type { EntityRef, GameSetupRevision, LocalData } from '../domain/types'
import { Badge } from './components'
import { useOptionalCorrections } from './corrections-context'

const MOD_STATE_LABELS: Readonly<Record<DefinitionModAvailability['state'], string>> = Object.freeze({
  unknown: 'Enabled status not recorded',
  conflicting: 'Enabled status has conflicting records',
  enabled: 'Enabled',
  disabled: 'Disabled',
})
export const LEARNABLE_INNATE_SKILLS_MOD_LABEL = 'Learnable Innate Skills'

export function ModBadge({ name, state, className = '', showState = true }: { readonly name: string; readonly state?: DefinitionModAvailability['state']; readonly className?: string; readonly showState?: boolean }) {
  const status = state ? MOD_STATE_LABELS[state] : undefined
  const tone = !showState ? 'info' : state === 'enabled' ? 'positive' : state === 'disabled' || state === 'conflicting' ? 'danger' : state === 'unknown' ? 'warning' : 'info'
  return <span aria-label={`Mod: ${name}${showState && status ? `. ${status}.` : ''}`} className={`mod-badge ${className}`.trim()} data-mod-badge={name} data-mod-state={state}><Badge tone={tone}>Mod: {name}</Badge>{showState && status && <small className="mod-badge__state">{status}</small>}</span>
}

export function DefinitionModLabel({ localData, gameSetup, value, className = '' }: { readonly localData: LocalData; readonly gameSetup?: GameSetupRevision; readonly value?: EntityRef | null; readonly className?: string }) {
  const context = useOptionalCorrections()
  if (!value) return null
  const availability = definitionModAvailability(localData, value, gameSetup, context?.baseline)
  return availability.requiredMod ? <ModBadge className={`definition-mod-label ${className}`.trim()} name={availability.requiredMod} state={availability.state}/> : null
}
