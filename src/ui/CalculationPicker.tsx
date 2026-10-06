import { useState } from 'react'
import type { CatalogEntityKind, EntityRef, GameSetupRevision } from '../domain/types'
import { BuildDefinitionField, BUILD_DEFINITION_PAGE_SIZE, type DefinitionChoiceGroup } from './BuildDefinitionField'

export function CalculationPicker({ label, kinds, value, gameSetup, excludedRefs, priorityGroups, otherGroupLabel, resetSearchOnOpen = false, showSelectionDetails = true, onChange }: { gameSetup?: GameSetupRevision; showSelectionDetails?: boolean; label: string; kinds: readonly CatalogEntityKind[]; value: EntityRef | null; excludedRefs?: readonly EntityRef[]; priorityGroups?: readonly DefinitionChoiceGroup[]; otherGroupLabel?: string; resetSearchOnOpen?: boolean; onChange: (ref: EntityRef | null) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(BUILD_DEFINITION_PAGE_SIZE)
  return <BuildDefinitionField showSelectionDetails={showSelectionDetails} gameSetup={gameSetup} allowedKinds={kinds} excludedRefs={excludedRefs} priorityGroups={priorityGroups} otherGroupLabel={otherGroupLabel} label={label} onChange={onChange} onClose={() => setOpen(false)} onDismiss={() => setOpen(false)} onInspect={() => undefined} onOpen={() => { if (resetSearchOnOpen) { setQuery(''); setLimit(BUILD_DEFINITION_PAGE_SIZE) } setOpen(true) }} onQueryChange={value => { setOpen(true); setQuery(value); setLimit(BUILD_DEFINITION_PAGE_SIZE) }} onResultLimitChange={setLimit} open={open} query={query} resultLimit={limit} value={value}/>
}
