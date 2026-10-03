import { moneyTextLabel } from '../domain/money'
import { MoneyText } from './MoneyText'
import { nativeDefinitionLabel, nativeDisplayDescription, nativeDisplayName, nativeIdentity } from '../domain/native-game'
import { preferredDefinitionChoices } from './definition-preferences'
import { passivePointCost } from '../domain/mechanics-facts'
import { bundledModLabel } from '../domain/bundled-mods'
import { modListPriority } from '../domain/mods'
import { MOD_PROJECT_FIELD } from '../domain/mod-library'
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PropsWithChildren, type RefObject } from 'react'
import { starterEntitySourceLabel } from '../catalog'
import { definitionModAvailability, type DefinitionModAvailability } from '../catalog/mods'
import { entityDefinitionKey, isEditablePersonalDefinition, logicalEntityKey, preferredDefinitionRef, preferredPersonalDefinitions, selectedPlaythrough } from '../domain'
import type { CatalogEntity, CatalogEntityKind, CatalogRef, CatalogSnapshot, EntityRef, GameSetupRevision, JsonValue, Knowledge, PersonalDefinition, LocalData } from '../domain/types'
import { Badge, Button, Field, InlineNotice } from './components'
import { Icon } from './icons'
import { formatAppError } from './model'
import { parentRoute, routeWithOverlay, useNavigation, type DefinitionPickerOverlay } from './navigation'
import { Sheet } from './Sheet'
import { Dropdown } from './Dropdown'
import { DefinitionFactsEditor, DefinitionOverviewEditor } from './DefinitionEditorFields'
import { definitionDraftFields, draftFieldValue, fieldDraft, type DefinitionFieldDraft } from './definition-field-draft'
import { DefinitionDraftNotice, useDefinitionDraft } from './definition-draft'
import { DefinitionArtwork } from './GameIcon'
import { ModBadge } from './DefinitionModLabel'
import { MOD_CATALOG_SCHEMA, CRYSTAL_EDIT_CATALOG_SCHEMA } from '../domain/mod-layers'

const DEFINITION_RESULT_PAGE_SIZE = 100
const defaultOptionLabel = (option: DefinitionOption) => option.name
const ALL_DEFINITION_KINDS: readonly CatalogEntityKind[] = ['item', 'class', 'ability', 'passive', 'innate', 'monsterMagic', 'monster', 'command', 'status', 'recipe', 'location', 'other']

type DefinitionRecord = CatalogEntity | PersonalDefinition
export interface DefinitionEditorDraft {
  readonly baseRef?: EntityRef
  readonly kind: CatalogEntityKind
  readonly name: string
  readonly aliases: readonly string[]
  readonly rawDescription?: string | null
  readonly fieldUpdates?: Readonly<Record<string, Knowledge<JsonValue> | null>>
}

export interface DefinitionOption {
  readonly key: string
  readonly ref: EntityRef
  readonly kind: CatalogEntityKind
  readonly name: string
  readonly aliases: readonly string[]
  readonly description?: string
  readonly category?: Knowledge<JsonValue>
  readonly ppCost?: Knowledge<number>
  readonly sourceLabel: string
  readonly stockLabel: string
  readonly gameSetupStatus?: string
  readonly modAvailability?: DefinitionModAvailability
  readonly preferred: boolean
  readonly record: DefinitionRecord
}

interface DefinitionLibraryValue {
  readonly localData: LocalData
  readonly catalogs: readonly CatalogSnapshot[]
  readonly options: readonly DefinitionOption[]
  readonly availableOptions: readonly DefinitionOption[]
  readonly planningOptions: readonly DefinitionOption[]
  readonly availablePlanningOptions: readonly DefinitionOption[]
  readonly onSaveDefinition: (draft: DefinitionEditorDraft) => Promise<EntityRef>
}

export const DefinitionLibraryContext = createContext<DefinitionLibraryValue | undefined>(undefined)

function categoryKnowledge(fields: Readonly<Record<string, Knowledge<JsonValue>>>): Knowledge<JsonValue> | undefined {
  const value = Object.entries(fields).find(([name]) => name.trim().toLocaleLowerCase() === 'category')?.[1]
  return value
}

function inventoryLabel(localData: LocalData, ref: EntityRef) {
  const positions = Object.values(selectedPlaythrough(localData)?.inventory ?? {}).filter((position) => logicalEntityKey(localData, position.ref) === logicalEntityKey(localData, ref))
  if (!positions.length) return 'Stock unrecorded'
  let confirmed = 0
  let uncertain = false
  for (const position of positions) {
    if (position.possession === 'notOwned') continue
    if (position.possession === 'unknown' || position.quantity.kind === 'unknown') uncertain = true
    else confirmed += position.quantity.value
    if (position.quantity.kind === 'atLeast') uncertain = true
  }
  if (confirmed && uncertain) return `${confirmed}+ recorded owned; total uncertain`
  if (confirmed) return `${confirmed} recorded owned`
  return uncertain ? 'Ownership or count uncertain' : 'Recorded not owned'
}

function catalogProvenance(catalogs: readonly CatalogSnapshot[], ref: EntityRef | undefined) {
  if (ref?.kind !== 'catalog') return undefined
  const entity = catalogs.find((catalog) => catalog.id === ref.catalogId && catalog.revisionId === ref.catalogRevisionId)?.entities[ref.entityId]
  return entity ? starterEntitySourceLabel(entity) : undefined
}

export function buildDefinitionOptions(localData: LocalData, catalogs: readonly CatalogSnapshot[]): readonly DefinitionOption[] {
  const preferredPersonalIds = new Set(preferredPersonalDefinitions(localData).map((definition) => definition.id))
  const activeGameSetup = localData.planningGameSetupRevisionId ? localData.gameSetups[localData.planningGameSetupRevisionId] : undefined
  const personal = Object.values(localData.personalDefinitions).map((definition): DefinitionOption => {
    const ref = { kind: 'personal', definitionId: definition.id } as const
    const editable = isEditablePersonalDefinition(localData, ref)
    const preferred = preferredPersonalIds.has(definition.id)
    const provenance = catalogProvenance(catalogs, definition.baseRef)
    return {
      key: entityDefinitionKey(ref), ref, kind: definition.kind, name: definition.name, aliases: definition.aliases,
      ...(definition.rawDescription === undefined ? {} : { description: definition.rawDescription }),
      ...(categoryKnowledge(definition.fields) === undefined ? {} : { category: categoryKnowledge(definition.fields) }),
      ppCost: passivePointCost(definition),
      sourceLabel: `${editable ? `Custom revision ${definition.revision}${preferred ? ' · preferred' : ' · older exact definition'}` : 'Saved catalog version · read-only'}${provenance ? ` · ${provenance}` : ''}`,
      stockLabel: inventoryLabel(localData, ref), preferred, record: definition,
      modAvailability: definitionModAvailability(localData, ref, activeGameSetup, catalogs),
      ...(activeGameSetup?.definitionOverrides?.some((pinned) => entityDefinitionKey(pinned) === entityDefinitionKey(ref)) ? {} : { gameSetupStatus: activeGameSetup ? 'Outside the current Game Setup definition collection' : 'No current Game Setup definition collection' }),
    }
  })
  const catalog = catalogs.flatMap((snapshot) => Object.values(snapshot.entities).map((entity): DefinitionOption => {
    const ref: CatalogRef = { kind: 'catalog', catalogId: snapshot.id, catalogRevisionId: snapshot.revisionId, entityId: entity.id }
    const provenance = nativeDefinitionLabel(entity) ?? bundledModLabel(entity) ?? starterEntitySourceLabel(entity)
    const effectiveLayer = entity.fields['Effective mod layer']
    const layerLabel = effectiveLayer?.state === 'known' && typeof effectiveLayer.value === 'string' ? `${effectiveLayer.value} · effective definition · ` : ''
    return {
      key: entityDefinitionKey(ref), ref, kind: entity.kind, name: entity.name, aliases: entity.aliases,
      ...(entity.rawDescription === undefined ? {} : { description: nativeDisplayDescription(entity) }),
      ...(categoryKnowledge(entity.fields) === undefined ? {} : { category: categoryKnowledge(entity.fields) }),
      ppCost: passivePointCost(entity),
      sourceLabel: `${layerLabel}${provenance ? `${provenance} · ` : ''}${snapshot.id} · revision ${snapshot.revisionId}`,
      stockLabel: inventoryLabel(localData, ref), preferred: true, record: entity,
      modAvailability: definitionModAvailability(localData, ref, activeGameSetup, catalogs),
      ...(activeGameSetup?.catalogLock[snapshot.id] === snapshot.revisionId ? {} : { gameSetupStatus: activeGameSetup ? 'Outside the current Game Setup catalog pin' : 'No current Game Setup catalog pin' }),
    }
  }))
  return [...personal, ...catalog].sort((left, right) => Number(right.preferred) - Number(left.preferred) || left.name.localeCompare(right.name) || Number(nativeIdentity(right.record)?.mode === 'base') - Number(nativeIdentity(left.record)?.mode === 'base') || left.sourceLabel.localeCompare(right.sourceLabel) || left.key.localeCompare(right.key))
}

export function definitionOptionsForRevisions(options: readonly DefinitionOption[], catalogLock: Readonly<Record<string, string>> = {}): readonly DefinitionOption[] {
  return options.filter(option => {
    if (option.ref.kind !== 'catalog') return true
    const pinned = catalogLock[option.ref.catalogId]
    return pinned ? option.ref.catalogRevisionId === pinned : true
  })
}

export function definitionOptionsForSetup(options: readonly DefinitionOption[], catalogs: readonly CatalogSnapshot[], gameSetup?: GameSetupRevision): readonly DefinitionOption[] {
  const lock = { ...gameSetup?.catalogLock, ...Object.fromEntries((gameSetup?.modComposition?.layers ?? []).map(layer => [layer.catalogId, layer.catalogRevisionId])) }
  const revisions = definitionOptionsForRevisions(options, lock)
  const schemas = new Map(catalogs.map(catalog => [JSON.stringify([catalog.id, catalog.revisionId]), catalog.schemaVersion]))
  return revisions.filter(option => {
    if (option.ref.kind !== 'catalog') return true
    const schema = schemas.get(JSON.stringify([option.ref.catalogId, option.ref.catalogRevisionId]))
    if (schema === MOD_CATALOG_SCHEMA) return gameSetup?.catalogLock[option.ref.catalogId] === option.ref.catalogRevisionId
    if (!gameSetup?.modComposition) return true
    if (option.ref.catalogId === gameSetup.modComposition.baseline.catalogId) return gameSetup?.catalogLock[option.ref.catalogId] === option.ref.catalogRevisionId
    const catalogId = option.ref.catalogId
    return schema !== CRYSTAL_EDIT_CATALOG_SCHEMA || !gameSetup.modComposition.layers.some(layer => layer.catalogId === catalogId && layer.enabled)
  })
}

export function DefinitionProvider({ localData, catalogs, onSaveDefinition, children, planningCatalogs }: PropsWithChildren<{ localData: LocalData; catalogs: readonly CatalogSnapshot[]; planningCatalogs?: readonly CatalogSnapshot[]; onSaveDefinition: (draft: DefinitionEditorDraft) => Promise<EntityRef> }>) {
  const options = useMemo(() => buildDefinitionOptions(localData, catalogs), [catalogs, localData])
  const availableOptions = useMemo(() => {
    const gameSetup = localData.planningGameSetupRevisionId ? localData.gameSetups[localData.planningGameSetupRevisionId] : undefined
    return definitionOptionsForSetup(options, catalogs, gameSetup)
  }, [catalogs, options, localData])
  const baseline = planningCatalogs ?? catalogs
  const planningOptions = useMemo(() => buildDefinitionOptions(localData, baseline), [baseline, localData])
  const availablePlanningOptions = useMemo(() => {
    const gameSetup = localData.planningGameSetupRevisionId ? localData.gameSetups[localData.planningGameSetupRevisionId] : undefined
    return definitionOptionsForSetup(planningOptions, baseline, gameSetup)
  }, [baseline, planningOptions, localData])
  const value = useMemo(() => ({ localData, catalogs, options, availableOptions, planningOptions, availablePlanningOptions, onSaveDefinition }), [availableOptions, availablePlanningOptions, catalogs, onSaveDefinition, options, planningOptions, localData])
  return <DefinitionLibraryContext.Provider value={value}>{children}</DefinitionLibraryContext.Provider>
}

export function useDefinitionLibrary() {
  const value = useContext(DefinitionLibraryContext)
  if (!value) throw new Error('DefinitionProvider is required for definition search and editing')
  return value
}

export function findDefinitionOption(options: readonly DefinitionOption[], ref: EntityRef | null | undefined) {
  const key = ref ? entityDefinitionKey(ref) : undefined
  return key ? options.find((option) => option.key === key) : undefined
}

export function definitionKindLabel(kind: CatalogEntityKind) {
  return kind === 'monsterMagic' ? 'Monster Magic' : kind.charAt(0).toLocaleUpperCase() + kind.slice(1)
}

export function DefinitionEditor({ open, baseRef, allowedKinds, initialName = '', initialSourceMod, initialSourceModProjectId, routeIndex, onClose, onSaved }: { open: boolean; baseRef?: EntityRef; allowedKinds: readonly CatalogEntityKind[]; initialName?: string; initialSourceMod?: string; initialSourceModProjectId?: string; routeIndex?: number; onClose: () => void; onSaved: (ref: EntityRef) => void }) {
  const navigation = useNavigation()
  const { localData, options, onSaveDefinition } = useDefinitionLibrary()
  const ownedEditorIndex = routeIndex ?? navigation.route.overlays.findLastIndex(overlay => overlay.kind === 'definition-editor')
  const routedEditor = ownedEditorIndex >= 0 ? navigation.route.overlays[ownedEditorIndex] : undefined
  const routedBaseRef = routedEditor?.kind === 'definition-editor' && routedEditor.mode === 'override' ? routedEditor.ref : undefined
  const [editRef] = useState(() => baseRef ?? routedBaseRef)
  const [base] = useState(() => findDefinitionOption(options, editRef))
  const kinds = allowedKinds.length ? allowedKinds : ALL_DEFINITION_KINDS
  const [kind, setKind] = useState<CatalogEntityKind>(() => base?.kind ?? kinds[0] ?? 'other')
  const [name, setName] = useState(() => base?.name ?? initialName)
  const [aliases, setAliases] = useState(() => base?.aliases.join('\n') ?? '')
  const [description, setDescription] = useState(() => base?.description ?? '')
  const [fields, setFields] = useState<Readonly<Record<string, DefinitionFieldDraft>>>(() => {
    const fields = definitionDraftFields(base?.record ?? { fields: {} })
    return {
      ...(!Object.keys(fields).some(field => field.toLowerCase() === 'category') ? { Category: fieldDraft(undefined) } : {}),
      ...(!Object.keys(fields).some(field => ['pp', 'pp cost'].includes(field.toLowerCase())) ? { PP: fieldDraft(base?.ppCost) } : {}),
      ...(!base && initialSourceMod ? { 'Source mod': fieldDraft({ state: 'known', value: initialSourceMod }, true) } : {}),
      ...(!base && initialSourceModProjectId ? { [MOD_PROJECT_FIELD]: fieldDraft({ state: 'known', value: initialSourceModProjectId }, true) } : {}),
      ...fields,
    }
  })
  const [error, setError] = useState<string>()
  const [scope] = useState({ ...navigation.route, overlays: navigation.route.overlays.slice(0, Math.max(0, ownedEditorIndex + 1)) })
  const draft = useDefinitionDraft(scope)
  const formId = useId()
  const close = () => draft.complete(onClose)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (draft.busy) return
    setError(undefined)
    try {
      if (!name.trim()) throw new Error('Enter a definition name.')
      const fieldUpdates: Record<string, Knowledge<JsonValue> | null> = {}
      for (const [field, value] of Object.entries(fields)) {
        try { const after = draftFieldValue(value); if (after !== undefined) fieldUpdates[field] = after } catch (error) { throw new Error(`${field}: ${error instanceof Error ? error.message : 'Invalid value'}`) }
      }
      draft.pending(true)
      const ref = await onSaveDefinition({ ...(editRef ? { baseRef: editRef } : {}), kind, name: name.trim(), aliases: [...new Set(aliases.split('\n').map(alias => alias.trim()).filter(Boolean))], rawDescription: description.trim() || (editRef ? null : undefined), fieldUpdates })
      draft.complete(() => onSaved(ref), onClose)
    } catch (reason) { setError(formatAppError(reason, 'The definition could not be saved.')) } finally { draft.pending(false) }
  }
  const readOnly = Boolean(editRef && base && !isEditablePersonalDefinition(localData, editRef))
  const saveDisabled = !name.trim() || Boolean(editRef && !base) || readOnly
  const title = readOnly ? 'Definition is read-only' : editRef ? `Edit custom definition: ${base?.name ?? 'definition'}` : 'Create personal definition'
  const saveLabel = editRef ? 'Save personal revision' : 'Create definition'
  const footer = <div className="definition-editor-footer"><DefinitionDraftNotice draft={draft} formId={formId} onDiscard={close} saveDisabled={saveDisabled} title="Definition draft still open"/>{error && <InlineNotice title="Definition not saved" tone="danger">{error} Your entered values remain in this editor. Try saving again.</InlineNotice>}<small>Available to every Playthrough. Saves a new revision; recorded references stay unchanged.</small><div className="form-actions"><Button disabled={draft.busy} onClick={close} tone="quiet" type="button">{draft.dirty ? 'Discard draft' : 'Cancel'}</Button><Button disabled={draft.busy || saveDisabled} form={formId} icon="check" type="submit">{draft.busy ? 'Saving...' : saveLabel}</Button></div></div>
  return <Sheet description={readOnly ? 'This saved definition remains available to existing records.' : 'Customize this definition in your shared local library.'} footer={readOnly ? <Button onClick={close} tone="quiet">Close</Button> : footer} layer={ownedEditorIndex + 1} onClose={close} onRequestClose={draft.requestClose} open={open} title={title} width="wide">

    {readOnly ? <InlineNotice title="Catalog versions cannot be edited">Catalog entries and saved catalog versions are read-only. Report source errors from the catalog entry.</InlineNotice> : editRef && !base ? <InlineNotice title="Definition could not be opened" tone="warning">The exact definition is unavailable in the local planner data and reference catalogs.</InlineNotice> : <form className="stack definition-editor" id={formId} onSubmit={submit}>
      <fieldset className="definition-editor-fields stack" disabled={draft.busy}>
        <DefinitionOverviewEditor aliases={aliases} description={description} name={name} onAliases={value => { setAliases(value); draft.markDirty() }} onDescription={value => { setDescription(value); const field = Object.keys(fields).find(field => field.toLowerCase() === 'description'); if (field) setFields(current => ({ ...current, [field]: fieldDraft(value ? { state: 'known', value } : null, true) })); draft.markDirty() }} onName={value => { setName(value); draft.markDirty() }}><Field label="Definition type"><select disabled={Boolean(editRef)} onChange={event => { setKind(event.target.value as CatalogEntityKind); draft.markDirty() }} value={kind}>{kinds.map(value => <option key={value} value={value}>{definitionKindLabel(value)}</option>)}</select></Field></DefinitionOverviewEditor>
        <DefinitionFactsEditor fields={fields} onChange={value => { setFields(value); const field = Object.keys(value).find(field => field.toLowerCase() === 'description'); if (field && value[field] !== fields[field]) setDescription(value[field]?.mode === 'keep' ? base?.description ?? '' : value[field]?.mode === 'known' && value[field]?.type === 'text' ? value[field].text : ''); draft.markDirty() }} source={base?.record.fields ?? {}}/>
      </fieldset>

    </form>}
  </Sheet>
}

export interface DefinitionDropdownProps {
  readonly id: string
  readonly anchorRef: RefObject<HTMLButtonElement | null>
  readonly open: boolean
  readonly title: string
  readonly allowedKinds: readonly CatalogEntityKind[]
  readonly selected?: EntityRef | null
  readonly allowUnknown?: boolean
  readonly allowEmpty?: boolean
  readonly emptyLabel?: string
  readonly emptyDescription?: string
  readonly createLabel?: string
  readonly compact?: boolean
  readonly filterOption?: (option: DefinitionOption) => boolean
  readonly optionLabel?: (option: DefinitionOption) => string
  readonly onInspect?: (option: DefinitionOption) => void
  readonly query?: string
  readonly resultLimit?: number
  readonly onQueryChange?: (query: string) => void
  readonly onResultLimitChange?: (limit: number) => void
  readonly onClose: () => void
  readonly onSelect: (ref: EntityRef | null | undefined) => void
}

export function DefinitionDropdown({ id, anchorRef, open, title, allowedKinds, selected, allowUnknown = true, allowEmpty = false, emptyLabel = 'Empty', emptyDescription = 'Nothing is equipped in this slot', createLabel = 'Create personal definition', compact = false, filterOption, optionLabel = defaultOptionLabel, onInspect, query: controlledQuery, resultLimit: controlledLimit, onQueryChange, onResultLimitChange, onClose, onSelect }: DefinitionDropdownProps) {
  const navigation = useNavigation()
  const { localData, catalogs, options, availableOptions } = useDefinitionLibrary()
  const [includeAlternatives, setIncludeAlternatives] = useState(false)
  const [internalQuery, setInternalQuery] = useState('')
  const [internalLimit, setInternalLimit] = useState(DEFINITION_RESULT_PAGE_SIZE)
  const [pendingSavedRef, setPendingSavedRef] = useState<EntityRef>()
  const searchRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const pickerIndex = open ? navigation.route.overlays.findLastIndex((overlay) => overlay.kind === 'definition-picker') : -1
  const pickerOverlay = pickerIndex >= 0 ? navigation.route.overlays[pickerIndex] : undefined
  const editorOverlay = pickerIndex >= 0 ? navigation.route.overlays[pickerIndex + 1] : undefined
  const editingRef = open && editorOverlay?.kind === 'definition-editor' && editorOverlay.mode === 'override' ? editorOverlay.ref : undefined
  const creating = open && editorOverlay?.kind === 'definition-editor' && editorOverlay.mode === 'new'
  const query = controlledQuery ?? (pickerOverlay?.kind === 'definition-picker' ? pickerOverlay.query : internalQuery)
  const limit = controlledLimit ?? (pickerOverlay?.kind === 'definition-picker' ? pickerOverlay.resultLimit : internalLimit)
  const updatePickerOverlay = (change: Partial<DefinitionPickerOverlay>) => {
    if (pickerIndex < 0 || pickerOverlay?.kind !== 'definition-picker') return
    const overlays = navigation.route.overlays.map((overlay, index) => index === pickerIndex ? { ...pickerOverlay, ...change } : overlay)
    navigation.navigate({ ...navigation.route, overlays }, { replace: true })
  }
  const setQuery = (value: string) => {
    onQueryChange?.(value)
    updatePickerOverlay({ query: value, resultLimit: DEFINITION_RESULT_PAGE_SIZE })
    if (controlledQuery === undefined && pickerIndex < 0) setInternalQuery(value)
    if (controlledLimit === undefined && pickerIndex < 0) setInternalLimit(DEFINITION_RESULT_PAGE_SIZE)
  }
  const setLimit = (value: number) => {
    onResultLimitChange?.(value)
    updatePickerOverlay({ resultLimit: value })
    if (controlledLimit === undefined && pickerIndex < 0) setInternalLimit(value)
  }
  const selectedOption = findDefinitionOption(options, selected)
  const displayOptionLabel = (option: DefinitionOption) => nativeDisplayName(option.record, optionLabel(option))
  const candidates = useMemo(() => {
    if (!open) return []
    const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const choices = includeAlternatives ? availableOptions : preferredDefinitionChoices(availableOptions, selectedOption?.key)
    return choices.filter((option) => allowedKinds.includes(option.kind) && (!filterOption || filterOption(option)) && (!tokens.length || tokens.every((token) => `${optionLabel(option)} ${option.name} ${option.aliases.join(' ')} ${option.description ?? ''} ${option.kind} ${option.sourceLabel}`.toLocaleLowerCase().includes(token)))).sort((a, b) => modListPriority(a.modAvailability) - modListPriority(b.modAvailability))
  }, [allowedKinds, availableOptions, filterOption, includeAlternatives, open, optionLabel, query, selectedOption?.key])
  const visible = candidates.slice(0, limit)
  const selectedVisible = selectedOption && allowedKinds.includes(selectedOption.kind) && visible.some((option) => option.key === selectedOption.key)
  const focusResult = (direction: 1 | -1 | 'first' | 'last', event: KeyboardEvent<HTMLElement>) => {
    const buttons = [...(resultsRef.current?.querySelectorAll<HTMLButtonElement>('button[data-definition-result="true"]') ?? [])]
    if (!buttons.length) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = direction === 'first' ? 0 : direction === 'last' ? buttons.length - 1 : current < 0 ? direction > 0 ? 0 : buttons.length - 1 : (current + direction + buttons.length) % buttons.length
    event.preventDefault()
    buttons[next]?.focus({ preventScroll: true })
    buttons[next]?.scrollIntoView({ block: 'nearest' })
  }
  const choose = (ref: EntityRef | null | undefined) => { onSelect(ref); onClose() }
  const editorSaved = (ref: EntityRef) => { setPendingSavedRef(ref) }
  useEffect(() => {
    if (!open || !pendingSavedRef || !findDefinitionOption(options, pendingSavedRef)) return
    setPendingSavedRef(undefined)
    onSelect(pendingSavedRef)
    const pickerRoute = parentRoute(navigation.route)
    const hostRoute = pickerRoute ? parentRoute(pickerRoute) : undefined
    if (hostRoute) navigation.navigate(hostRoute, { replace: true })
    else onClose()
  }, [navigation, onClose, onSelect, open, options, pendingSavedRef])
  return <>
    <Dropdown anchorRef={anchorRef} id={id} initialFocusRef={searchRef} onClose={onClose} onDismiss={() => { const parent = parentRoute(navigation.route); if (parent) navigation.navigate(parent, { replace: true }) }} open={open && !editorOverlay} title={title}>
      <div className="definition-dropdown__search search-field"><Icon name="search"/><input aria-label="Search available definitions" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'ArrowDown') focusResult(1, event); if (event.key === 'ArrowUp') focusResult(-1, event); if (event.key === 'Enter') event.preventDefault() }} placeholder="Search name, description, or source" ref={searchRef} type="search" value={query}/></div>
      <label className="check-row"><input checked={includeAlternatives} onChange={event => setIncludeAlternatives(event.target.checked)} type="checkbox"/>Include other sources and mode variants</label>
      <div aria-label="Available definitions" className="picker-results" role="group" tabIndex={0} onKeyDown={(event) => { if (event.key === 'ArrowDown') focusResult(1, event); if (event.key === 'ArrowUp') focusResult(-1, event); if (event.key === 'Home') focusResult('first', event); if (event.key === 'End') focusResult('last', event) }} ref={resultsRef}>
        {allowUnknown && <button aria-pressed={selected === undefined} className="picker-result picker-result--empty" data-definition-result="true" onClick={() => choose(undefined)} tabIndex={-1} type="button"><span className="picker-result__content"><strong>Unknown</strong><small>No selection has been recorded</small></span></button>}
        {allowEmpty && <button aria-pressed={selected === null} className="picker-result picker-result--empty" data-definition-result="true" onClick={() => choose(null)} tabIndex={-1} type="button"><span className="picker-result__content"><strong>{emptyLabel}</strong><small>{emptyDescription}</small></span></button>}
        {selectedOption && !selectedVisible && <button aria-pressed="true" className="picker-result" data-definition-result="true" onClick={() => choose(selectedOption.ref)} tabIndex={-1} type="button"><span className="picker-result__content"><span className="picker-result__heading"><strong>{nativeDisplayName(selectedOption.record)}</strong>{selectedOption.modAvailability?.requiredMod && <ModBadge name={selectedOption.modAvailability.requiredMod} state={selectedOption.modAvailability.state}/>}</span><small>{definitionKindLabel(selectedOption.kind)} · {selectedOption.sourceLabel}</small><small>Current exact selection</small></span><Icon name="check"/></button>}
        {visible.map((option) => <button aria-pressed={selected ? entityDefinitionKey(selected) === option.key : false} className="picker-result" data-definition-result="true" data-mod-state={option.modAvailability?.requiredMod ? option.modAvailability.state : undefined} key={option.key} onClick={() => choose(option.ref)} onFocus={() => onInspect?.(option)} tabIndex={-1} type="button"><DefinitionArtwork catalogs={catalogs} localData={localData} value={option.ref}/><span className="picker-result__content"><span className="picker-result__heading"><strong>{displayOptionLabel(option)}</strong>{option.modAvailability?.requiredMod && <ModBadge name={option.modAvailability.requiredMod} state={option.modAvailability.state}/>}{option.ppCost?.state === 'known' && <span className="picker-result__cost"><Badge tone="info">{option.ppCost.value} PP</Badge></span>}{selected && entityDefinitionKey(selected) === option.key && <Icon name="check"/>}</span>{optionLabel(option) !== option.name && <small>{option.name} class</small>}{option.description && <small className="picker-result__description" title={moneyTextLabel(option.description)}><MoneyText>{option.description}</MoneyText></small>}{!compact && <small className="picker-result__source">{definitionKindLabel(option.kind)} · {option.sourceLabel}</small>}<span className="picker-result__status">{!compact && option.kind === 'item' && <small>{option.stockLabel}</small>}{!compact && option.gameSetupStatus && <small className="picker-result__warning">{option.gameSetupStatus}</small>}{!option.preferred && <small>Historical or base</small>}</span></span></button>)}
        {candidates.length > limit && <Button onClick={() => setLimit(limit + DEFINITION_RESULT_PAGE_SIZE)} tone="quiet" type="button">Show {Math.min(DEFINITION_RESULT_PAGE_SIZE, candidates.length - limit)} more</Button>}
        {candidates.length === 0 && <p className="definition-dropdown__empty" role="status">No matching definitions. Try another search or create a personal definition.</p>}
      </div>
      <div className="definition-dropdown__actions">{selectedOption && isEditablePersonalDefinition(localData, selectedOption.ref) && <Button icon="edit" onClick={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'definition-editor', mode: 'override', ref: preferredDefinitionRef(localData, selectedOption.ref) }))} tone="quiet" type="button">Edit selected definition</Button>}<Button icon="plus" onClick={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'definition-editor', mode: 'new' }))} tone="quiet" type="button">{query.trim() ? `Create "${query.trim().slice(0, 80)}"` : createLabel}</Button></div>
    </Dropdown>
    {editingRef && <DefinitionEditor allowedKinds={allowedKinds} baseRef={editingRef} initialName="" key={entityDefinitionKey(editingRef)} onClose={() => navigation.close()} onSaved={editorSaved} open routeIndex={pickerIndex + 1}/>}
    {creating && <DefinitionEditor allowedKinds={allowedKinds} initialName={query.trim()} key={`create:${query.trim()}`} onClose={() => navigation.close()} onSaved={editorSaved} open routeIndex={pickerIndex + 1}/>}
  </>
}

export function DefinitionPickerField({ label, hint, allowedKinds, value, disabled = false, allowUnknown = true, allowEmpty = false, autoFocus = false, routeKey, onChange }: { label: string; hint?: string; allowedKinds: readonly CatalogEntityKind[]; value?: EntityRef | null; disabled?: boolean; allowUnknown?: boolean; allowEmpty?: boolean; autoFocus?: boolean; routeKey?: string; onChange: (ref: EntityRef | null | undefined) => void }) {
  const navigation = useNavigation()
  const { localData, catalogs, options } = useDefinitionLibrary()
  const pickerMemoryRef = useRef({ query: '', resultLimit: DEFINITION_RESULT_PAGE_SIZE })
  const fieldKey = routeKey ?? (label.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'definition')
  const picker = navigation.route.overlays.findLast((overlay) => overlay.kind === 'definition-picker')
  const open = picker?.kind === 'definition-picker' && picker.fieldKey === fieldKey
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownId = useId()
  const openPicker = () => navigation.navigate(routeWithOverlay({ ...navigation.route, overlays: [] }, { kind: 'definition-picker', fieldKey, ...pickerMemoryRef.current }), { replace: Boolean(picker) })
  if (open) pickerMemoryRef.current = { query: picker.query, resultLimit: picker.resultLimit }
  const selected = findDefinitionOption(options, value)
  const display = value === null ? 'Empty' : selected ? nativeDisplayName(selected.record) : value ? 'Unresolved exact definition' : 'Unknown'
  // Keep native autofocus available when the containing dialog opens
  return <div className="field definition-picker-field"><span className="field__label">{label}</span><button aria-controls={open ? dropdownId : undefined} aria-expanded={open} aria-haspopup="dialog" aria-label={`Choose ${label}`} autoFocus={autoFocus} className="definition-picker-trigger" data-definition-trigger="true" disabled={disabled} onClick={() => open ? navigation.close() : openPicker()} onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!open) openPicker() } }} ref={(trigger) => { triggerRef.current = trigger; if (trigger) trigger.autofocus = autoFocus }} type="button"><DefinitionArtwork catalogs={catalogs} localData={localData} value={value}/><span><span className="definition-badge-heading"><strong>{display}</strong>{selected?.modAvailability?.requiredMod && <ModBadge name={selected.modAvailability.requiredMod} state={selected.modAvailability.state}/>}</span><small>{selected ? `${definitionKindLabel(selected.kind)} · ${selected.sourceLabel}` : hint}</small></span><Icon name="chevron-down"/></button>{hint && selected && <span className="field__hint">{hint}</span>}<DefinitionDropdown anchorRef={triggerRef} id={dropdownId} allowEmpty={allowEmpty} allowedKinds={allowedKinds} allowUnknown={allowUnknown} onClose={() => navigation.close()} onSelect={onChange} open={open} selected={value} title={`Choose ${label}`}/></div>
}
