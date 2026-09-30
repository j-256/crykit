import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isPotentiallyLearnableInnate } from '../catalog/switch'
import { nativeDefinitionLabel } from '../domain/native-game'
import { entityDefinitionKey } from '../domain'
import type { CatalogEntityKind, EntityRef } from '../domain/types'
import { Dropdown } from './Dropdown'
import { definitionKindLabel, findDefinitionOption, useDefinitionLibrary, type DefinitionOption } from './definitions'
import { Icon } from './icons'
import { DefinitionArtwork } from './GameIcon'
import { commandName, matchesSlot } from './definition-fields'
import { hasNameEvidenceOnly, isReferenceArticle, ppCostLabel, similarNameOptions } from './build-evidence'
import { BuildSelectionDetails, BuildSelectionFacts } from './BuildSelectionDetails'
import { LEARNABLE_INNATE_SKILLS_MOD_LABEL, ModBadge } from './DefinitionModLabel'
import { preferredDefinitionChoices } from './definition-preferences'

export const BUILD_DEFINITION_PAGE_SIZE = 100
export function BuildDefinitionField({ label, allowedKinds, value, open, query, resultLimit, includeInnates = false, onOpen, onClose, onDismiss, onQueryChange, onResultLimitChange, onChange, onInspect }: {
  label: string
  allowedKinds: readonly CatalogEntityKind[]
  value: EntityRef | null
  open: boolean
  query: string
  resultLimit: number
  includeInnates?: boolean
  onOpen: () => void
  onClose: () => void
  onDismiss: () => void
  onQueryChange: (query: string) => void
  onResultLimitChange: (limit: number) => void
  onChange: (value: EntityRef | null) => void
  onInspect: (option: DefinitionOption | undefined) => void
}) {
  const { localData, catalogs, planningOptions: options, availablePlanningOptions: availableOptions } = useDefinitionLibrary()
  const selected = findDefinitionOption(options, value)
  const similarNames = useMemo(() => similarNameOptions(localData, availableOptions), [availableOptions, localData])
  const optionName = (option: DefinitionOption) => label === 'Sub-command' ? commandName(option) ?? option.name : option.name
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()
  const [activeIndex, setActiveIndex] = useState(-1)
  const [includeAlternatives, setIncludeAlternatives] = useState(false)
  const candidates = useMemo(() => {
    if (!open) return []
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const choices = includeAlternatives ? availableOptions : preferredDefinitionChoices(availableOptions, selected?.key)
    return choices.filter((option) => allowedKinds.includes(option.kind) && (option.kind !== 'innate' || (includeInnates && isPotentiallyLearnableInnate(option.record))) && !isReferenceArticle(localData, option.ref) && matchesSlot(option, label) && tokens.every((token) => `${option.name} ${commandName(option) ?? ''} ${option.aliases.join(' ')} ${option.description ?? ''}`.toLowerCase().includes(token)))
      .sort((a, b) => Number(hasNameEvidenceOnly(a.record)) - Number(hasNameEvidenceOnly(b.record)))
  }, [allowedKinds, availableOptions, includeAlternatives, includeInnates, label, open, localData, query, selected?.key])
  const visible = candidates.slice(0, resultLimit)
  const hasMore = candidates.length > resultLimit
  const lastIndex = hasMore ? visible.length : visible.length - 1
  useEffect(() => { setActiveIndex(-1) }, [query, open, includeInnates])
  useLayoutEffect(() => { if (open) inputRef.current?.select() }, [open])
  const choose = (ref: EntityRef | null) => { onInspect(findDefinitionOption(options, ref)); onChange(ref); onClose() }
  const move = (index: number) => {
    if (!visible.length) return
    const next = Math.max(0, Math.min(lastIndex, index))
    setActiveIndex(next)
    onInspect(visible[next])
    document.getElementById(`${id}-option-${next}`)?.scrollIntoView({ block: 'nearest' })
  }
  return <div className="build-field">
    <label htmlFor={id}>{label}</label>
    <div className="build-field__input">
      <input aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined} aria-autocomplete="list" aria-controls={open ? `${id}-list` : undefined} aria-expanded={open} aria-haspopup="listbox" autoComplete="off" data-definition-trigger="true" id={id} onChange={(event) => onQueryChange(event.target.value)} onClick={() => { if (!open) onOpen() }} onFocus={() => { onInspect(selected); if (!open) onOpen() }} onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          if (!open) onOpen()
          else move(activeIndex < 0 && event.key === 'ArrowUp' ? lastIndex : activeIndex + (event.key === 'ArrowDown' ? 1 : -1))
        }
        if (open && (event.key === 'Home' || event.key === 'End')) { event.preventDefault(); move(event.key === 'Home' ? 0 : lastIndex) }
        if (event.key === 'Enter') {
          event.preventDefault()
          if (open && visible[activeIndex]) choose(visible[activeIndex].ref)
          else if (open && hasMore && activeIndex === visible.length) onResultLimitChange(resultLimit + BUILD_DEFINITION_PAGE_SIZE)
        }
      }} placeholder="Type to search..." ref={inputRef} role="combobox" value={open ? query : (selected ? optionName(selected) : value ? 'Unresolved selection' : '')}/>
      {value ? <button aria-label={`Clear ${label}`} onClick={() => { onInspect(undefined); onChange(null); if (open) onDismiss() }} type="button"><Icon name="close"/></button> : <Icon name="search"/>}
    </div>
    <Dropdown anchorRef={inputRef} id={`${id}-list`} initialFocusRef={inputRef} onClose={onClose} onDismiss={onDismiss} open={open} role="listbox" title={`Choose ${label}`}>
      <label className="check-row"><input checked={includeAlternatives} onChange={event => { setIncludeAlternatives(event.target.checked); setActiveIndex(-1) }} type="checkbox"/>Include other sources and mode variants</label>
      <div className="picker-results">
        <button aria-selected={value === null} className="picker-result picker-result--empty" onMouseDown={(event) => event.preventDefault()} onClick={() => choose(null)} role="option" tabIndex={-1} type="button"><span className="picker-result__content"><strong>Leave empty</strong></span></button>
        {visible.map((option, index) => <button aria-selected={value ? entityDefinitionKey(value) === option.key : false} className={`picker-result${activeIndex === index ? ' picker-result--active' : ''}`} id={`${id}-option-${index}`} key={option.key} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option.ref)} onPointerEnter={() => setActiveIndex(index)} role="option" tabIndex={-1} type="button"><DefinitionArtwork catalogs={catalogs} localData={localData} value={option.ref}/><span className="picker-result__content"><span className="picker-result__heading"><strong>{optionName(option)}</strong>{option.kind === 'innate' && <ModBadge name={LEARNABLE_INNATE_SKILLS_MOD_LABEL}/>}{option.modAvailability?.requiredMod && <ModBadge name={option.modAvailability.requiredMod} state={option.modAvailability.state}/>}{['passive', 'innate'].includes(option.kind) && <small className="picker-result__cost">{ppCostLabel(option)}</small>}</span><small>{definitionKindLabel(option.kind)}{label === 'Sub-command' ? ` · ${option.name} class` : ''} · {nativeDefinitionLabel(option.record) ? nativeDefinitionLabel(option.record) : option.ref.kind === 'personal' ? 'Personal definition' : hasNameEvidenceOnly(option.record) ? 'Name only' : 'Catalog details'}</small><small className="picker-result__description"><BuildSelectionFacts option={option}/></small>{similarNames.has(option.key) && <small className="picker-result__source">Similar spelling exists; shared identity unconfirmed</small>}</span></button>)}
        {!candidates.length && <div className="definition-dropdown__empty" role="presentation">No matching definitions. Try another search. Only listed selections are saved.</div>}
        {hasMore && <button className={`picker-result${activeIndex === visible.length ? ' picker-result--active' : ''}`} id={`${id}-option-${visible.length}`} onMouseDown={(event) => event.preventDefault()} onClick={() => onResultLimitChange(resultLimit + BUILD_DEFINITION_PAGE_SIZE)} role="option" aria-selected={false} tabIndex={-1} type="button">Show more results</button>}
      </div>
    </Dropdown>
    {selected && <div className="build-field__evidence"><BuildSelectionFacts option={selected}/>{isReferenceArticle(localData, selected.ref) && <p className="field__hint">This saved selection is a reference article, not a specific equipment item. Choose a replacement.</p>}<details><summary aria-label={`Details for ${selected.name}`}>Details</summary><BuildSelectionDetails alternatives={similarNames.get(selected.key)} option={selected}/></details></div>}
  </div>
}
