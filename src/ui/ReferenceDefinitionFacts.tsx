import type { ComponentProps } from 'react'
import type { NativeFieldFact } from '../catalog/native-field-facts'
import type { CatalogEntity, PersonalDefinition } from '../domain/types'
import { DefinitionFactsPanel, DefinitionPlanningPanel } from './DefinitionDetailSections'
import { Icon } from './icons'

const TECHNICAL_FIELDS = new Set(['Stat modifiers', 'Ability modifiers', 'Ability costs', 'Automatic equipment price disabled', 'Automatic equipment stats disabled', 'Automatic stat generation disabled', 'Prevent Auto Equip', 'Game platform', 'Game version', 'Mode data', 'Native category code', 'Hands', 'Max Capacity'])
const TECHNICAL_FIELD_PATTERN = /^(?:Crystal Edit |Is |Uses player-style|Hide |Invert |Raw )|(?: inputs?| ID| IDs)$/
const PLAYER_BOOLEAN_FIELDS = new Set(['Is Two Handed', 'Is One Only', 'Is Starting Job', 'Is Unselectable Job', 'Is Unselectable Sub Job', 'Is Not Crystal Job', 'Is Learnable', 'Is Innate', 'Is Sellable', 'Is Consumable'])

export function isTechnicalReferenceFact(field: string): boolean {
  // Familiar restrictions stay beside gameplay facts; engine flags and codes stay inspectable
  return !PLAYER_BOOLEAN_FIELDS.has(field) && (TECHNICAL_FIELDS.has(field) || TECHNICAL_FIELD_PATTERN.test(field))
}

type Props = Omit<ComponentProps<typeof DefinitionFactsPanel>, 'label' | 'readableBooleans'> & { readonly definition: CatalogEntity | PersonalDefinition; readonly planningFacts?: readonly NativeFieldFact[] }

export function ReferenceDefinitionFacts({ definition, facts, verifiedNativeFacts = [], planningFacts = [], ...props }: Props) {
  const gameplay = facts.filter(([field]) => !isTechnicalReferenceFact(field))
  const technical = facts.filter(([field]) => isTechnicalReferenceFact(field))
  return <div className="stack definition-detail-sections">
    {gameplay.length > 0 && <DefinitionFactsPanel {...props} facts={gameplay} readableBooleans verifiedNativeFacts={verifiedNativeFacts}/>}
    {/* Selection costs and restrictions are gameplay information even when their values are unknown */}
    <DefinitionPlanningPanel definition={definition} verifiedNativeFacts={planningFacts}/>
    {technical.length > 0 && <details className="reference-technical">
      <summary><span className="icon-label"><Icon name="settings"/>Technical details</span><span className="reference-technical__hint">Engine fields and source metadata</span></summary>
      <DefinitionFactsPanel {...props} facts={technical} label="Technical facts" verifiedNativeFacts={verifiedNativeFacts}/>
    </details>}
  </div>
}
