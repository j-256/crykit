import { definitionModAvailability, type DefinitionModAvailability } from '../catalog/mods'
import { LEARNABLE_INNATE_FIELD } from '../catalog/switch'
import type { CatalogEntity, EntityRef, GameSetupRevision, LocalData } from '../domain/types'
import { Badge } from './components'
import { useContext } from 'react'
import { DefinitionLibraryContext } from './definitions'

const MOD_STATE_LABELS: Readonly<Record<DefinitionModAvailability['state'], string>> = Object.freeze({
  unknown: 'Enabled status not recorded',
  conflicting: 'Enabled status has conflicting records',
  enabled: 'Enabled',
  disabled: 'Disabled',
})
export const LEARNABLE_INNATE_SKILLS_MOD_LABEL = 'Learnable Innate Skills'

export function LegacyInnateModBadge({ record }: { readonly record: Pick<CatalogEntity, 'fields'> }) {
  const availability = record.fields[LEARNABLE_INNATE_FIELD]
  return availability?.state === 'known' && availability.value === true ? <ModBadge name={LEARNABLE_INNATE_SKILLS_MOD_LABEL}/> : null
}

function modStateTone(state?: DefinitionModAvailability['state']) {
  return state === 'enabled' ? 'positive' : state === 'disabled' || state === 'conflicting' ? 'danger' : state === 'unknown' ? 'warning' : 'info'
}

export function ModStateBadge({ state, disabledLabel = MOD_STATE_LABELS.disabled }: { readonly state: DefinitionModAvailability['state']; readonly disabledLabel?: string }) {
  return <Badge tone={modStateTone(state)}>{state === 'disabled' ? disabledLabel : MOD_STATE_LABELS[state]}</Badge>
}

export function ModBadge({ name, state, className = '', showState = true }: { readonly name: string; readonly state?: DefinitionModAvailability['state']; readonly className?: string; readonly showState?: boolean }) {
  const status = state ? MOD_STATE_LABELS[state] : undefined
  const tone = !showState ? 'info' : modStateTone(state)
  return <span aria-label={`Mod: ${name}${showState && status ? `. ${status}.` : ''}`} className={`mod-badge ${className}`.trim()} data-mod-badge={name} data-mod-state={state}><Badge tone={tone}>Mod: {name}</Badge>{showState && status && <small className="mod-badge__state">{status}</small>}</span>
}

export function DefinitionModLabel({ localData, gameSetup, value, className = '' }: { readonly localData: LocalData; readonly gameSetup?: GameSetupRevision; readonly value?: EntityRef | null; readonly className?: string }) {
  const context = useContext(DefinitionLibraryContext)
  if (!value) return null
  const availability = definitionModAvailability(localData, value, gameSetup, context?.catalogs)
  return availability.requiredMod ? <ModBadge className={`definition-mod-label ${className}`.trim()} name={availability.requiredMod} state={availability.state}/> : null
}
