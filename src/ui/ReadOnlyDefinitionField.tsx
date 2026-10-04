import { useRef } from 'react'
import { nativeDisplayName } from '../domain/native-game'
import type { CatalogSnapshot, LocalData } from '../domain/types'
import type { DefinitionOption } from './definitions'
import { subCommandLabel } from './definition-fields'
import { BuildSelectionDetails, BuildSelectionFacts } from './BuildSelectionDetails'
import { DefinitionArtwork } from './GameIcon'

const INLINE_DETAILS_QUERY = '(max-width: 1100px)'

export function ReadOnlyDefinitionField({ label, option, empty = 'Empty', localData, catalogs, onInspect }: { label: string; option?: DefinitionOption; empty?: string; localData: LocalData; catalogs: readonly CatalogSnapshot[]; onInspect: (option?: DefinitionOption) => void }) {
  const details = useRef<HTMLDetailsElement>(null)
  const inspect = () => { onInspect(option); if (details.current && window.matchMedia(INLINE_DETAILS_QUERY).matches) details.current.open = true }
  const name = option ? label === 'Sub-command' ? subCommandLabel(option) : nativeDisplayName(option.record, option.name) : empty
  return <div className="build-field">
    <span className="build-field__label">{label}</span>
    <button aria-label={`Inspect ${label}: ${name}`} className="build-readonly-selection" onClick={inspect} type="button"><DefinitionArtwork catalogs={catalogs} localData={localData} value={option?.ref}/><strong>{name}</strong></button>
    {option && <div className="build-field__evidence"><BuildSelectionFacts option={option} showClassPermissions={label !== 'Sub-command'}/><details ref={details}><summary aria-label={`Details for ${option.name}`}>Details</summary><BuildSelectionDetails option={option} showClassPermissions={label !== 'Sub-command'}/></details></div>}
  </div>
}
