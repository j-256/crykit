import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { isPotentiallyLearnableInnate } from '../catalog/switch'
import { nativeDisplayName } from '../domain/native-game'
import { entityDefinitionKey, logicalEntityKey } from '../domain'
import type { BuildRevisionContent, CatalogEntityKind, EntityRef, GameSetupRevision, SlotDefinition } from '../domain/types'
import { modListPriority } from '../domain/mods'
import { definitionModAvailability, modPlanningReason } from '../catalog/mods'
import { assessEquipmentPermission, type BuildEquipmentPermissions } from '../domain/build-mechanics'
import { Dropdown } from './Dropdown'
import { definitionKindLabel, findDefinitionOption, useDefinitionLibrary, type DefinitionOption } from './definitions'
import { Icon, type IconName } from './icons'
import { DefinitionArtwork } from './GameIcon'
import { matchesEquipmentSlot, matchesSlot, subCommandLabel } from './definition-fields'
import { definitionChoiceSourceLabel, hasNameEvidenceOnly, isReferenceArticle, ppCostLabel, similarNameOptions } from './build-evidence'
import { BuildSelectionDetails, BuildSelectionFacts } from './BuildSelectionDetails'
import { LegacyInnateModBadge, ModBadge } from './DefinitionModLabel'
import { preferredDefinitionChoices } from './definition-preferences'
import { Button, InlineNotice } from './components'
import { useBuildModSelection } from './BuildModSelectionGate'
import { buildReferenceName } from '../domain/build-reference-names'
import { PICKER_STAT_FIELDS, pickerAvailableForSetup, pickerCategoryKey, pickerEquipmentAssessment, pickerHandedness, pickerListedStat, pickerRemainingPp, pickerSearchEntry, pickerSearchMatch } from './build-picker'
import { referenceCategoryLabel } from './reference-categories'
import './build-picker.css'

export const BUILD_DEFINITION_PAGE_SIZE = 100
const MAX_CONFLICT_EXAMPLES = 3
const FIELD_ICONS: Readonly<Record<string, IconName>> = Object.freeze({ Class: 'crystal', 'Sub-command': 'tome', 'Main hand': 'sword', 'Off hand': 'shield', Head: 'character', Body: 'chest', 'Accessory 1': 'ring', 'Accessory 2': 'ring' })
export interface DefinitionChoiceGroup {
  readonly key: string
  readonly label: string
  readonly refs: readonly EntityRef[]
}
const NO_PRIORITY_GROUPS: readonly DefinitionChoiceGroup[] = []

export function BuildDefinitionField({ label, allowedKinds, value, open, query, resultLimit, allowEmpty = true, includeInnates = false, showSelectionDetails = true, gameSetup, equipmentPermissions, equipmentSlot, buildContent, equipmentSlots, passiveIndex, excludedRefs, priorityGroups = NO_PRIORITY_GROUPS, otherGroupLabel = 'Other choices', onOpen, onClose, onDismiss, onQueryChange, onResultLimitChange, onChange, onInspect, onConfigureMod }: {
  label: string
  allowedKinds: readonly CatalogEntityKind[]
  value: EntityRef | null
  open: boolean
  query: string
  resultLimit: number
  allowEmpty?: boolean
  includeInnates?: boolean
  showSelectionDetails?: boolean
  gameSetup?: GameSetupRevision
  equipmentPermissions?: BuildEquipmentPermissions
  equipmentSlot?: SlotDefinition
  buildContent?: BuildRevisionContent
  equipmentSlots?: readonly SlotDefinition[]
  passiveIndex?: number
  excludedRefs?: readonly EntityRef[]
  priorityGroups?: readonly DefinitionChoiceGroup[]
  otherGroupLabel?: string
  onOpen: () => void
  onClose: () => void
  onDismiss: () => void
  onQueryChange: (query: string) => void
  onResultLimitChange: (limit: number) => void
  onChange: (value: EntityRef | null) => void
  onConfigureMod?: (name: string) => void
  onInspect: (option: DefinitionOption | undefined) => void
}) {
  const { localData, catalogs, planningOptions: options, availablePlanningOptions: libraryOptions, onRequestBundledSearch, bundledSearchPending, bundledSearchError } = useDefinitionLibrary()
  useEffect(() => { if (open) onRequestBundledSearch() }, [open, onRequestBundledSearch])
  const selectedBase = findDefinitionOption(options, value)
  const selected = useMemo(() => selectedBase ? { ...selectedBase, modAvailability: definitionModAvailability(localData, selectedBase.ref, gameSetup, catalogs) } : undefined, [catalogs, gameSetup, localData, selectedBase])
  const availableOptions = useMemo(() => {
    if (!open) return []
    const available = libraryOptions.map(option => ({ ...option, modAvailability: definitionModAvailability(localData, option.ref, gameSetup, catalogs) }))
    return selected && !available.some(option => option.key === selected.key) ? [...available, selected] : available
  }, [catalogs, gameSetup, libraryOptions, localData, open, selected])
  const similarNames = useMemo(() => similarNameOptions(localData, availableOptions), [availableOptions, localData])
  const optionName = (option: DefinitionOption) => label === 'Sub-command' ? subCommandLabel(option) : nativeDisplayName(option.record, option.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const skipNextFocus = useRef(false)
  const selectionPending = useRef(false)
  const modSelection = useBuildModSelection()
  const id = useId()
  const [activeIndex, setActiveIndex] = useState(-1)
  const [includeAlternatives, setIncludeAlternatives] = useState(false)
  const [includeUnavailable, setIncludeUnavailable] = useState(true)
  const [compatibleOnly, setCompatibleOnly] = useState(true)
  const [withinPp, setWithinPp] = useState(false)
  const [category, setCategory] = useState('')
  const [sort, setSort] = useState('name')
  const allowedKindKey = allowedKinds.join(',')
  const excludedKeys = useMemo(() => new Set(excludedRefs?.map(ref => logicalEntityKey(localData, ref))), [excludedRefs, localData])
  const definitionIndex = useMemo(() => new Map(open ? options.map(option => [option.key, option.record]) : []), [open, options])
  const slotOptions = useMemo(() => {
    const kinds = new Set(allowedKindKey.split(','))
    return availableOptions.filter(option => option.key === selected?.key || kinds.has(option.kind) && !excludedKeys.has(logicalEntityKey(localData, option.ref)) && !isReferenceArticle(localData, option.ref) && (equipmentSlot ? matchesEquipmentSlot(option, equipmentSlot) : matchesSlot(option, label)))
  }, [allowedKindKey, availableOptions, equipmentSlot, excludedKeys, label, localData, selected?.key])
  const permissionAssessments = useMemo(() => new Map(equipmentPermissions && open ? slotOptions.map(option => [option.key, buildContent && equipmentSlot && equipmentSlots
    ? pickerEquipmentAssessment(option, buildContent, equipmentSlot, equipmentSlots, ref => definitionIndex.get(entityDefinitionKey(ref)), ref => logicalEntityKey(localData, ref))
    : assessEquipmentPermission(option.record, equipmentPermissions)]) : []), [buildContent, definitionIndex, equipmentPermissions, equipmentSlot, equipmentSlots, localData, open, slotOptions])
  const remainingPp = useMemo(() => buildContent && passiveIndex !== undefined ? pickerRemainingPp(buildContent, passiveIndex, gameSetup, ref => definitionIndex.get(entityDefinitionKey(ref))) : undefined, [buildContent, definitionIndex, gameSetup, passiveIndex])
  const equippedElsewhere = useMemo(() => new Set(buildContent && passiveIndex !== undefined
    ? buildContent.passives.flatMap((selection, index) => index === passiveIndex ? [] : [logicalEntityKey(localData, selection.ref)])
    : []), [buildContent, localData, passiveIndex])
  const categories = useMemo(() => [...new Set(slotOptions.filter(option => pickerAvailableForSetup(option, includeUnavailable, selected?.key)).flatMap(option => pickerCategoryKey(option) ?? []))].sort((a, b) => referenceCategoryLabel(a).localeCompare(referenceCategoryLabel(b))), [includeUnavailable, selected?.key, slotOptions])
  const searchEntries = useMemo(() => new Map(slotOptions.map(option => [option.key, pickerSearchEntry(option, label === 'Sub-command' ? subCommandLabel(option) : nativeDisplayName(option.record, option.name))])), [label, slotOptions])
  const searchMatches = useMemo(() => new Map([...searchEntries].map(([key, entry]) => [key, pickerSearchMatch(entry, query)])), [query, searchEntries])
  const priorityByKey = useMemo(() => {
    const priorities = new Map<string, number>()
    if (!priorityGroups.length) return priorities
    const memberships = new Map<string, number>()
    priorityGroups.forEach((group, index) => group.refs.forEach(ref => {
      const key = logicalEntityKey(localData, ref)
      if (!memberships.has(key)) memberships.set(key, index)
    }))
    for (const option of slotOptions) {
      const priority = memberships.get(logicalEntityKey(localData, option.ref))
      if (priority !== undefined) priorities.set(option.key, priority)
    }
    return priorities
  }, [localData, priorityGroups, slotOptions])
  const matchingChoices = useMemo(() => {
    if (!open) return []
    const choices = includeAlternatives ? slotOptions : preferredDefinitionChoices(slotOptions, selected?.key)
    return choices.filter(option => (option.key === selected?.key || (option.kind !== 'innate' || (includeInnates && isPotentiallyLearnableInnate(option.record))) && pickerAvailableForSetup(option, includeUnavailable) && (!category || pickerCategoryKey(option) === category) && (!withinPp || remainingPp === undefined || option.ppCost?.state === 'known' && option.ppCost.value <= remainingPp)) && searchMatches.get(option.key))
      .sort((a, b) => {
        const priorityDifference = (priorityByKey.get(a.key) ?? priorityGroups.length) - (priorityByKey.get(b.key) ?? priorityGroups.length)
        if (priorityDifference) return priorityDifference
        if (sort !== 'name') {
          const left = pickerListedStat(a, sort)
          const right = pickerListedStat(b, sort)
          const difference = Number(left === undefined) - Number(right === undefined) || (right ?? 0) - (left ?? 0)
          if (difference) return difference
        }
        return (searchMatches.get(a.key)?.rank ?? 0) - (searchMatches.get(b.key)?.rank ?? 0) || modListPriority(a.modAvailability) - modListPriority(b.modAvailability) || Number(permissionAssessments.get(a.key)?.status === 'invalid') - Number(permissionAssessments.get(b.key)?.status === 'invalid') || Number(hasNameEvidenceOnly(a.record)) - Number(hasNameEvidenceOnly(b.record)) || optionName(a).localeCompare(optionName(b))
      })
  }, [category, includeAlternatives, includeInnates, includeUnavailable, label, open, permissionAssessments, priorityByKey, priorityGroups.length, remainingPp, searchMatches, selected?.key, slotOptions, sort, withinPp])
  const duplicatePassives = matchingChoices.filter(option => option.key !== selected?.key && equippedElsewhere.has(logicalEntityKey(localData, option.ref)))
  const uniqueChoices = matchingChoices.filter(option => option.key === selected?.key || !equippedElsewhere.has(logicalEntityKey(localData, option.ref)))
  const hiddenConflicts = compatibleOnly ? uniqueChoices.filter(option => option.key !== selected?.key && permissionAssessments.get(option.key)?.status === 'invalid') : []
  const candidates = compatibleOnly ? uniqueChoices.filter(option => option.key === selected?.key || permissionAssessments.get(option.key)?.status !== 'invalid') : uniqueChoices
  const conflictReasons = [...new Set(hiddenConflicts.flatMap(option => permissionAssessments.get(option.key)?.reason ?? []))]
  const needsDualWield = conflictReasons.some(reason => reason.includes('requires Dual Wield'))
  const activeFilterCount = Number(Boolean(category)) + Number(sort !== 'name') + Number(includeAlternatives) + Number(!includeUnavailable) + Number(withinPp) + Number(Boolean(equipmentPermissions) && compatibleOnly)
  const visible = candidates.slice(0, resultLimit)
  const visibleGroups = visible.reduce<{ key: string; label?: string; start: number; options: DefinitionOption[] }[]>((groups, option, index) => {
    const priority = priorityByKey.get(option.key)
    const group = priority === undefined ? undefined : priorityGroups[priority]
    const key = group?.key ?? 'other'
    const previous = groups.at(-1)
    if (previous?.key === key) previous.options.push(option)
    else groups.push({ key, label: group?.label ?? (priorityGroups.length ? otherGroupLabel : undefined), start: index, options: [option] })
    return groups
  }, [])
  const hasMore = candidates.length > resultLimit
  const lastIndex = hasMore ? visible.length : visible.length - 1
  useEffect(() => { setActiveIndex(-1) }, [query, open, includeInnates, equipmentPermissions, gameSetup, category, compatibleOnly, includeAlternatives, includeUnavailable, sort, withinPp, equippedElsewhere, priorityGroups])
  useLayoutEffect(() => { if (open) inputRef.current?.select() }, [open])
  useEffect(() => { if (open) selectionPending.current = false }, [open])
  const closePicker = () => { inputRef.current?.focus({ preventScroll: true }); onClose() }
  const choose = (ref: EntityRef | null) => {
    selectionPending.current = true
    const option = findDefinitionOption(availableOptions, ref)
    const accept = () => { onInspect(option); if (ref === null || value === null || entityDefinitionKey(ref) !== entityDefinitionKey(value)) onChange(ref) }
    closePicker()
    if (option && modSelection) modSelection.select({ option, accept, cancel: () => onInspect(selected), restoreFocus: () => {
      if (inputRef.current?.isConnected) { skipNextFocus.current = document.activeElement !== inputRef.current; inputRef.current.focus({ preventScroll: true }) }
    } })
    else accept()
  }
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
      <span className="build-field__artwork">{selected ? <DefinitionArtwork catalogs={catalogs} localData={localData} value={selected.ref}/> : <Icon name={FIELD_ICONS[label] ?? (allowedKinds.includes('passive') ? 'spark' : 'box')}/>}</span>
      <input aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined} aria-autocomplete="list" aria-controls={open ? `${id}-list` : undefined} aria-expanded={open} aria-haspopup="listbox" autoComplete="off" data-definition-trigger="true" id={id} onChange={(event) => onQueryChange(event.target.value)} onClick={() => { if (!open) onOpen() }} onFocus={() => { if (skipNextFocus.current) { skipNextFocus.current = false; return } onInspect(selected); if (!open) onOpen() }} onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          if (!open) onOpen()
          else move(activeIndex < 0 && event.key === 'ArrowUp' ? lastIndex : activeIndex + (event.key === 'ArrowDown' ? 1 : -1))
        }
        if (open && (event.key === 'Home' || event.key === 'End')) { event.preventDefault(); move(event.key === 'Home' ? 0 : lastIndex) }
        if (event.key === 'Enter') {
          event.preventDefault()
          if (open && visible[activeIndex]) choose(visible[activeIndex].ref)
          else if (open && candidates.length === 1) choose(candidates[0]!.ref)
          else if (open && hasMore && activeIndex === visible.length) onResultLimitChange(resultLimit + BUILD_DEFINITION_PAGE_SIZE)
        }
      }} placeholder="Search names, stats, effects..." ref={inputRef} role="combobox" value={open ? query : (selected ? optionName(selected) : value ? (buildContent && buildReferenceName(buildContent, value)) ?? 'Unresolved selection' : '')}/>
      {value && allowEmpty ? <button aria-label={`Clear ${label}`} onClick={() => { onInspect(undefined); onChange(null); if (open) onDismiss() }} type="button"><Icon name="close"/></button> : <Icon name="search"/>}
    </div>
    <Dropdown anchorRef={inputRef} id={`${id}-list`} initialFocusRef={inputRef} onClose={closePicker} onDismiss={onDismiss} open={open} role="listbox" title={`Choose ${label}`}>
      <details className="build-picker-filters">
        <summary>Search filters{activeFilterCount > 0 && <small>{activeFilterCount} active</small>}</summary>
        <div className="build-picker-filters__controls">
          {equipmentSlot && <div className="build-picker-filters__selects"><label>Equipment category<select data-draft-exempt onChange={event => setCategory(event.target.value)} value={category}><option value="">All categories</option>{categories.map(key => <option key={key} value={key}>{referenceCategoryLabel(key)}</option>)}</select></label><label>Sort results<select data-draft-exempt onChange={event => setSort(event.target.value)} value={sort}><option value="name">Name</option>{PICKER_STAT_FIELDS.map(stat => <option key={stat} value={stat}>Highest listed {stat}</option>)}</select></label></div>}
          {equipmentPermissions && <label className="check-row"><input checked={compatibleOnly} data-draft-exempt onChange={event => setCompatibleOnly(event.target.checked)} type="checkbox"/>Hide known equipment conflicts</label>}
          {equipmentPermissions && <small className="field__hint">Keeps unknown compatibility visible. Uncheck to see conflicting choices.</small>}
          {passiveIndex !== undefined && <><label className="check-row"><input checked={withinPp} data-draft-exempt disabled={remainingPp === undefined} onChange={event => setWithinPp(event.target.checked)} type="checkbox"/>Within remaining PP{remainingPp !== undefined ? ` (${remainingPp} PP for this selection)` : ' (budget unresolved)'}</label><small className="field__hint">Includes the PP freed by this replacement. Hides passives with unknown costs.</small></>}
          <details className="build-picker-filters__broader"><summary>Broader planning options</summary><label className="check-row"><input checked={includeUnavailable} data-draft-exempt onChange={event => setIncludeUnavailable(event.target.checked)} type="checkbox"/>Include disabled or unconfirmed mods</label><label className="check-row"><input checked={includeAlternatives} data-draft-exempt onChange={event => setIncludeAlternatives(event.target.checked)} type="checkbox"/>Include other sources and mode variants</label></details>
        </div>
      </details>
      <div className="picker-results">
        {bundledSearchPending && <p role="status">Loading mod choices...</p>}
        {bundledSearchError && <InlineNotice title="Mod choices unavailable" tone="warning">{bundledSearchError} Reload to try again.</InlineNotice>}
        <div className="build-picker-results-summary" role="presentation"><small>{candidates.length} {candidates.length === 1 ? 'result' : 'results'}{candidates.length === 1 ? ' · Enter to select' : ''}</small>{hiddenConflicts.length > 0 && <button onClick={() => setCompatibleOnly(false)} type="button">Show {hiddenConflicts.length} {hiddenConflicts.length === 1 ? 'conflict' : 'conflicts'}</button>}</div>
        {allowEmpty && <button aria-selected={value === null} className="picker-result picker-result--empty" onMouseDown={(event) => event.preventDefault()} onClick={() => choose(null)} role="option" tabIndex={-1} type="button"><span className="picker-result__content"><strong>Leave empty</strong></span></button>}
        {visibleGroups.map((group, groupIndex) => <div aria-labelledby={group.label ? `${id}-group-${groupIndex}` : undefined} key={group.key} role={group.label ? 'group' : undefined}>
          {group.label && <div className="build-picker-group-heading" id={`${id}-group-${groupIndex}`}>{group.label}</div>}
          {group.options.map((option, offset) => {
            const index = group.start + offset
            const assessment = permissionAssessments.get(option.key)
            const modReason = modPlanningReason(option.modAvailability)
            return <button aria-selected={value ? entityDefinitionKey(value) === option.key : false} className={`picker-result${activeIndex === index ? ' picker-result--active' : ''}`} data-mod-state={option.modAvailability?.requiredMod ? option.modAvailability.state : undefined} data-permission-state={assessment?.status} id={`${id}-option-${index}`} key={option.key} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option.ref)} onPointerEnter={event => { if (!open || selectionPending.current || event.pointerType === 'touch') return; setActiveIndex(index); onInspect(option) }} role="option" tabIndex={-1} type="button"><DefinitionArtwork catalogs={catalogs} localData={localData} value={option.ref}/><span className="picker-result__content"><span className="picker-result__heading"><strong>{optionName(option)}</strong>{option.kind === 'innate' && !option.modAvailability?.requiredMod && <LegacyInnateModBadge record={option.record}/>}{option.modAvailability?.requiredMod && <ModBadge name={option.modAvailability.requiredMod} showState={false} state={option.modAvailability.state}/>}{['passive', 'innate'].includes(option.kind) && <small className="picker-result__cost">{ppCostLabel(option)}</small>}</span><small>{definitionKindLabel(option.kind)} · {definitionChoiceSourceLabel(option)}</small>{pickerHandedness(option) && <small className="picker-result__handedness">{pickerHandedness(option)}</small>}{modReason && <small className="picker-result__mod-reason">{modReason}</small>}{assessment?.reason && <small className="picker-result__permission">{assessment.reason}</small>}{sort !== 'name' && <small>Listed {sort}: {pickerListedStat(option, sort) ?? 'Unknown'}</small>}{searchMatches.get(option.key)?.explanation && <small className="picker-result__match">{searchMatches.get(option.key)!.explanation}</small>}{label !== 'Sub-command' && <small className="picker-result__description"><BuildSelectionFacts interactiveHelp={false} option={option}/></small>}</span></button>
          })}
        </div>)}
        {!candidates.length && !bundledSearchPending && <div className="definition-dropdown__empty" role="presentation">{hiddenConflicts.length ? <><strong>{hiddenConflicts.length} matching {hiddenConflicts.length === 1 ? 'choice is' : 'choices are'} hidden by equipment conflicts.</strong><ul>{conflictReasons.slice(0, MAX_CONFLICT_EXAMPLES).map(reason => <li key={reason}>{reason}</li>)}</ul><p>{needsDualWield ? 'Choose a class that grants Dual Wield, or choose a permitted off-hand item. Off hand can also stay empty.' : 'Change your class or equipment, or uncheck Hide known equipment conflicts.'}</p></> : duplicatePassives.length ? <>That passive is already equipped. Clear its other slot or choose another.</> : <>No matches. Try another name, stat, or effect, or change Search filters.</>}</div>}
        {hasMore && <button className={`picker-result${activeIndex === visible.length ? ' picker-result--active' : ''}`} id={`${id}-option-${visible.length}`} onMouseDown={(event) => event.preventDefault()} onClick={() => onResultLimitChange(resultLimit + BUILD_DEFINITION_PAGE_SIZE)} role="option" aria-selected={false} tabIndex={-1} type="button">Show more results</button>}
      </div>
    </Dropdown>
    {showSelectionDetails && selected && <div className="build-field__evidence">{label !== 'Sub-command' && <BuildSelectionFacts option={selected}/>}{pickerHandedness(selected) && <p className="field__hint">{pickerHandedness(selected)}</p>}{modPlanningReason(selected.modAvailability) && <p className="field__hint">{modPlanningReason(selected.modAvailability)} Your selection is kept.</p>}{selected.modAvailability?.requiredMod && onConfigureMod && <div className="build-field__mod-action"><Button aria-label={`${selected.name} mod settings`} onClick={() => onConfigureMod(selected.modAvailability!.requiredMod!)} tone="quiet" type="button">Mod settings</Button></div>}{isReferenceArticle(localData, selected.ref) && <p className="field__hint">This selection links to an article. Choose an equipment item to replace it.</p>}<details><summary aria-label={`Details for ${selected.name}`}>Details</summary><BuildSelectionDetails alternatives={similarNames.get(selected.key)} catalogs={catalogs} gameSetup={gameSetup} localData={localData} option={selected} showClassPermissions={label !== 'Sub-command'}/></details></div>}
  </div>
}
