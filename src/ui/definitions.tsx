import { createContext, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PropsWithChildren } from 'react'
import { starterEntitySourceLabel } from '../catalog'
import { entityDefinitionKey, logicalEntityKey, preferredDefinitionRef, preferredPersonalDefinitions } from '../domain'
import type { CatalogEntity, CatalogEntityKind, CatalogRef, CatalogSnapshot, EntityRef, JsonValue, Knowledge, PersonalDefinition, Profile } from '../domain/types'
import { Badge, Button, Field, InlineNotice } from './components'
import { Icon } from './icons'
import { formatAppError } from './model'
import { parentRoute, routeWithOverlay, useNavigation, useNavigationBlocker, type DefinitionPickerOverlay } from './navigation'
import { Sheet } from './Sheet'

const DEFINITION_RESULT_PAGE_SIZE = 100
const ALL_DEFINITION_KINDS: readonly CatalogEntityKind[] = ['item', 'class', 'ability', 'passive', 'innate', 'monsterMagic', 'monster', 'command', 'status', 'recipe', 'location', 'other']

type DefinitionRecord = CatalogEntity | PersonalDefinition
export interface DefinitionEditorDraft {
  readonly baseRef?: EntityRef
  readonly kind: CatalogEntityKind
  readonly name: string
  readonly aliases: readonly string[]
  readonly rawDescription?: string | null
  readonly category?: Knowledge<string> | null
  readonly ppCost?: Knowledge<number> | null
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
  readonly rulesetStatus?: string
  readonly preferred: boolean
  readonly record: DefinitionRecord
}

interface DefinitionWorkspaceValue {
  readonly profile: Profile
  readonly catalogs: readonly CatalogSnapshot[]
  readonly options: readonly DefinitionOption[]
  readonly onSaveDefinition: (draft: DefinitionEditorDraft) => Promise<EntityRef>
}

const DefinitionWorkspaceContext = createContext<DefinitionWorkspaceValue | undefined>(undefined)

function categoryKnowledge(fields: Readonly<Record<string, Knowledge<JsonValue>>>): Knowledge<JsonValue> | undefined {
  const value = Object.entries(fields).find(([name]) => name.trim().toLocaleLowerCase() === 'category')?.[1]
  return value
}

function editableCategoryValue(value: Knowledge<JsonValue> | undefined): string {
  if (value?.state !== 'known') return ''
  if (typeof value.value === 'string') return value.value
  if (Array.isArray(value.value)) return value.value.find((entry): entry is string => typeof entry === 'string') ?? ''
  return ''
}

function inventoryLabel(profile: Profile, ref: EntityRef) {
  const positions = Object.values(profile.inventory).filter((position) => logicalEntityKey(profile, position.ref) === logicalEntityKey(profile, ref))
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

export function buildDefinitionOptions(profile: Profile, catalogs: readonly CatalogSnapshot[]): readonly DefinitionOption[] {
  const preferredPersonalIds = new Set(preferredPersonalDefinitions(profile).map((definition) => definition.id))
  const activeRuleset = profile.activeRulesetRevisionId ? profile.rulesets[profile.activeRulesetRevisionId] : undefined
  const personal = Object.values(profile.personalDefinitions).map((definition): DefinitionOption => {
    const ref = { kind: 'personal', definitionId: definition.id } as const
    const preferred = preferredPersonalIds.has(definition.id)
    const provenance = catalogProvenance(catalogs, definition.baseRef)
    return {
      key: entityDefinitionKey(ref), ref, kind: definition.kind, name: definition.name, aliases: definition.aliases,
      ...(definition.rawDescription === undefined ? {} : { description: definition.rawDescription }),
      ...(categoryKnowledge(definition.fields) === undefined ? {} : { category: categoryKnowledge(definition.fields) }),
      ...(definition.ppCost === undefined ? {} : { ppCost: definition.ppCost }),
      sourceLabel: `${preferred ? `Personal revision ${definition.revision} · preferred` : `Personal revision ${definition.revision} · older exact definition`}${provenance ? ` · override of ${provenance}` : ''}`,
      stockLabel: inventoryLabel(profile, ref), preferred, record: definition,
      ...(activeRuleset?.definitionOverrides?.some((pinned) => entityDefinitionKey(pinned) === entityDefinitionKey(ref)) ? {} : { rulesetStatus: activeRuleset ? 'Outside the active ruleset definition collection' : 'No active ruleset definition collection' }),
    }
  })
  const catalog = catalogs.flatMap((snapshot) => Object.values(snapshot.entities).map((entity): DefinitionOption => {
    const ref: CatalogRef = { kind: 'catalog', catalogId: snapshot.id, catalogRevisionId: snapshot.revisionId, entityId: entity.id }
    const preferred = entityDefinitionKey(preferredDefinitionRef(profile, ref)) === entityDefinitionKey(ref)
    const provenance = starterEntitySourceLabel(entity)
    return {
      key: entityDefinitionKey(ref), ref, kind: entity.kind, name: entity.name, aliases: entity.aliases,
      ...(entity.rawDescription === undefined ? {} : { description: entity.rawDescription }),
      ...(categoryKnowledge(entity.fields) === undefined ? {} : { category: categoryKnowledge(entity.fields) }),
      ...(entity.ppCost === undefined ? {} : { ppCost: entity.ppCost }),
      sourceLabel: `${provenance ? `${provenance} · ` : ''}${snapshot.id} · revision ${snapshot.revisionId}${preferred ? '' : ' · base definition'}`,
      stockLabel: inventoryLabel(profile, ref), preferred, record: entity,
      ...(activeRuleset?.catalogLock[snapshot.id] === snapshot.revisionId ? {} : { rulesetStatus: activeRuleset ? 'Outside the active ruleset catalog pin' : 'No active ruleset catalog pin' }),
    }
  }))
  return [...personal, ...catalog].sort((left, right) => Number(right.preferred) - Number(left.preferred) || left.name.localeCompare(right.name) || left.sourceLabel.localeCompare(right.sourceLabel) || left.key.localeCompare(right.key))
}

export function DefinitionProvider({ profile, catalogs, onSaveDefinition, children }: PropsWithChildren<{ profile: Profile; catalogs: readonly CatalogSnapshot[]; onSaveDefinition: (draft: DefinitionEditorDraft) => Promise<EntityRef> }>) {
  const options = useMemo(() => buildDefinitionOptions(profile, catalogs), [catalogs, profile])
  const value = useMemo(() => ({ profile, catalogs, options, onSaveDefinition }), [catalogs, onSaveDefinition, options, profile])
  return <DefinitionWorkspaceContext.Provider value={value}>{children}</DefinitionWorkspaceContext.Provider>
}

export function useDefinitionWorkspace() {
  const value = useContext(DefinitionWorkspaceContext)
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

export function DefinitionEditor({ open, baseRef, allowedKinds, initialName = '', routeIndex, onClose, onSaved }: { open: boolean; baseRef?: EntityRef; allowedKinds: readonly CatalogEntityKind[]; initialName?: string; routeIndex?: number; onClose: () => void; onSaved: (ref: EntityRef) => void }) {
  const navigation = useNavigation()
  const { options, onSaveDefinition } = useDefinitionWorkspace()
  const ownedEditorIndex = routeIndex ?? navigation.route.overlays.findLastIndex((overlay) => overlay.kind === 'definition-editor')
  const routedEditor = ownedEditorIndex >= 0 ? navigation.route.overlays[ownedEditorIndex] : undefined
  const routedBaseRef = routedEditor?.kind === 'definition-editor' && routedEditor.mode === 'override' ? routedEditor.ref : undefined
  const [editRef] = useState(() => baseRef ?? routedBaseRef)
  const base = findDefinitionOption(options, editRef)
  const kinds = allowedKinds.length ? allowedKinds : ALL_DEFINITION_KINDS
  const [kind, setKind] = useState<CatalogEntityKind>(() => base?.kind ?? kinds[0] ?? 'other')
  const [name, setName] = useState(() => base?.name ?? initialName)
  const [aliases, setAliases] = useState(() => base?.aliases.join('\n') ?? '')
  const [description, setDescription] = useState(() => base?.description ?? '')
  const [category, setCategory] = useState(() => editableCategoryValue(base?.category))
  const [categoryMode, setCategoryMode] = useState<'preserve' | 'known' | 'unknown' | 'clear'>(() => baseRef ? 'preserve' : 'unknown')
  const [ppState, setPpState] = useState<'preserve' | 'known' | 'unknown' | 'clear'>(() => baseRef ? 'preserve' : 'unknown')
  const [pp, setPp] = useState(() => base?.ppCost?.state === 'known' ? String(base.ppCost.value) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [closeWarning, setCloseWarning] = useState(false)
  const dirtyRef = useRef(false)
  const scopeRef = useRef({ ...navigation.route, overlays: navigation.route.overlays.slice(0, Math.max(0, ownedEditorIndex + 1)) })
  useNavigationBlocker(scopeRef.current, () => dirtyRef.current, () => setCloseWarning(true))
  const clearDirty = () => { dirtyRef.current = false; setCloseWarning(false) }
  const close = () => { clearDirty(); onClose() }
  if (editRef && !base) {
    return <Sheet description="The exact definition in this address is unavailable in the active profile and reference catalogs." layer={ownedEditorIndex + 1} onClose={close} open={open} title="Definition unavailable" width="wide"><div className="stack"><InlineNotice title="Definition could not be opened" tone="warning">The requested definition may have been removed, or the link may belong to another profile or catalog revision. No substitute definition was selected.</InlineNotice><div className="form-actions"><Button onClick={close} tone="quiet" type="button">Close editor</Button></div></div></Sheet>
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const normalizedName = name.trim()
    if (!normalizedName) return
    const numericPp = ppState === 'known' && pp.trim() ? Number(pp) : undefined
    if (ppState === 'known' && (numericPp === undefined || !Number.isFinite(numericPp))) { setError('Enter a finite PP value or mark PP as unknown.'); return }
    setBusy(true)
    setError(undefined)
    try {
      const draft: DefinitionEditorDraft = {
        ...(editRef ? { baseRef: editRef } : {}), kind, name: normalizedName,
        aliases: aliases.split('\n').map((alias) => alias.trim()).filter(Boolean),
        rawDescription: description.trim() || (editRef ? null : undefined),
        ...(categoryMode === 'preserve' ? {} : { category: categoryMode === 'known' ? { state: 'known' as const, value: category.trim() } : categoryMode === 'unknown' ? { state: 'unknown' as const } : null }),
        ...(ppState === 'preserve' ? {} : { ppCost: ppState === 'known' ? { state: 'known' as const, value: numericPp! } : ppState === 'unknown' ? { state: 'unknown' as const } : null }),
      }
      const ref = await onSaveDefinition(draft)
      clearDirty()
      onSaved(ref)
    } catch (reason) { setError(formatAppError(reason, 'The definition could not be saved.')) } finally { setBusy(false) }
  }
  return <Sheet description={editRef ? 'Editing creates a new personal override. Existing observations and build revisions keep their exact earlier reference.' : 'Create a personal definition without inventing unobserved mechanics.'} layer={ownedEditorIndex + 1} onClose={close} onRequestClose={() => { if (!dirtyRef.current) return true; setCloseWarning(true); return false }} open={open} title={editRef ? `Edit ${base?.name ?? 'definition'}` : 'Create personal definition'} width="wide"><form className="stack" onInput={() => { dirtyRef.current = true; setCloseWarning(false) }} onSubmit={submit}>
    {closeWarning && <InlineNotice title="Definition draft still open" tone="warning">Save this definition or choose Cancel to discard its entered values before leaving.</InlineNotice>}
    {editRef && <InlineNotice title="Immutable override">The source definition remains available for historical records. This saved revision becomes the preferred choice in ordinary pickers.</InlineNotice>}
    <div className="grid-2"><Field label="Definition name" required><input autoFocus onChange={(event) => setName(event.target.value)} required value={name}/></Field><Field hint={baseRef ? 'Definition kind is inherited by an override.' : undefined} label="Definition type"><select disabled={Boolean(baseRef)} onChange={(event) => setKind(event.target.value as CatalogEntityKind)} value={kind}>{kinds.map((value) => <option key={value} value={value}>{definitionKindLabel(value)}</option>)}</select></Field></div>
    <Field hint="One alternate name per line." label="Aliases"><textarea onChange={(event) => setAliases(event.target.value)} value={aliases}/></Field>
    <Field label="Description"><textarea onChange={(event) => setDescription(event.target.value)} placeholder="Optional source or personal description" value={description}/></Field>
    <div className="grid-2"><Field label="Category knowledge"><select onChange={(event) => setCategoryMode(event.target.value as typeof categoryMode)} value={categoryMode}>{baseRef && <option value="preserve">Keep current ({base?.category?.state ?? 'unrecorded'})</option>}<option value="unknown">Unknown or not recorded</option><option value="known">Known category</option>{baseRef && <option value="clear">Clear category field</option>}</select></Field>{categoryMode === 'known' && <Field label="Category" required><input onChange={(event) => setCategory(event.target.value)} required value={category}/></Field>}</div>
    <div className="grid-2"><Field label="PP knowledge"><select onChange={(event) => setPpState(event.target.value as typeof ppState)} value={ppState}>{baseRef && <option value="preserve">Keep current ({base?.ppCost?.state ?? 'unrecorded'})</option>}<option value="unknown">Unknown or not recorded</option><option value="known">Known value</option>{baseRef && <option value="clear">Clear PP field</option>}</select></Field>{ppState === 'known' && <Field label="PP value" required><input inputMode="decimal" onChange={(event) => setPp(event.target.value)} required type="number" value={pp}/></Field>}</div>
    {error && <InlineNotice title="Definition not saved" tone="danger">{error} Your entered values remain in this editor.</InlineNotice>}
    <div className="form-actions"><Button disabled={busy} onClick={close} tone="quiet" type="button">Cancel</Button><Button disabled={busy || !name.trim()} icon="check" type="submit">{busy ? 'Saving...' : editRef ? 'Save new override' : 'Create definition'}</Button></div>
  </form></Sheet>
}

export interface DefinitionPickerDialogProps {
  readonly open: boolean
  readonly title: string
  readonly allowedKinds: readonly CatalogEntityKind[]
  readonly selected?: EntityRef | null
  readonly allowUnknown?: boolean
  readonly allowEmpty?: boolean
  readonly emptyLabel?: string
  readonly emptyDescription?: string
  readonly createLabel?: string
  readonly description?: string
  readonly query?: string
  readonly resultLimit?: number
  readonly onQueryChange?: (query: string) => void
  readonly onResultLimitChange?: (limit: number) => void
  readonly onClose: () => void
  readonly onSelect: (ref: EntityRef | null | undefined) => void
}

export function DefinitionPickerDialog({ open, title, allowedKinds, selected, allowUnknown = true, allowEmpty = false, emptyLabel = 'Observed empty', emptyDescription = 'Record that this slot was checked and empty', createLabel = 'Create personal definition', description = 'Search exact catalog and personal definitions. Equal names remain separate identities.', query: controlledQuery, resultLimit: controlledLimit, onQueryChange, onResultLimitChange, onClose, onSelect }: DefinitionPickerDialogProps) {
  const navigation = useNavigation()
  const { profile, options } = useDefinitionWorkspace()
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
  const candidates = useMemo(() => {
    const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    return options.filter((option) => allowedKinds.includes(option.kind) && (!tokens.length || tokens.every((token) => `${option.name} ${option.aliases.join(' ')} ${option.description ?? ''} ${option.kind} ${option.sourceLabel}`.toLocaleLowerCase().includes(token))))
  }, [allowedKinds, options, query])
  const visible = candidates.slice(0, limit)
  const selectedVisible = selectedOption && allowedKinds.includes(selectedOption.kind) && visible.some((option) => option.key === selectedOption.key)
  const focusResult = (direction: 1 | -1, event: KeyboardEvent<HTMLElement>) => {
    const buttons = [...(resultsRef.current?.querySelectorAll<HTMLButtonElement>('button[data-definition-result="true"]') ?? [])]
    if (!buttons.length) return
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = current < 0 ? direction > 0 ? 0 : buttons.length - 1 : (current + direction + buttons.length) % buttons.length
    event.preventDefault()
    buttons[next]?.focus()
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
    <Sheet description={description} initialFocusRef={searchRef} layer={pickerIndex + 1} onClose={onClose} open={open} title={title}><div className="stack"><div className="search-field"><Icon name="search"/><input aria-label="Search available definitions" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'ArrowDown') focusResult(1, event) }} placeholder="Name, alias, description, type, or source" ref={searchRef} type="search" value={query}/></div>
      <div className="picker-results" onKeyDown={(event) => { if (event.key === 'ArrowDown') focusResult(1, event); if (event.key === 'ArrowUp') focusResult(-1, event) }} ref={resultsRef}>
        {allowUnknown && <button className="picker-result" data-definition-result="true" onClick={() => choose(undefined)} type="button"><span><strong>Unknown or unrecorded</strong><small>Keep this field explicitly unknown</small></span><Badge>Unknown</Badge></button>}
        {allowEmpty && <button className="picker-result" data-definition-result="true" onClick={() => choose(null)} type="button"><span><strong>{emptyLabel}</strong><small>{emptyDescription}</small></span><Badge>Empty</Badge></button>}
        {selectedOption && !selectedVisible && <button aria-pressed="true" className="picker-result" data-definition-result="true" onClick={() => choose(selectedOption.ref)} type="button"><span><strong>{selectedOption.name}</strong><small>{definitionKindLabel(selectedOption.kind)} · {selectedOption.sourceLabel}</small></span><Badge tone="info">Current exact selection</Badge></button>}
        {visible.map((option) => <button aria-pressed={selected ? entityDefinitionKey(selected) === option.key : false} className="picker-result" data-definition-result="true" key={option.key} onClick={() => choose(option.ref)} type="button"><span><strong>{option.name}</strong><small>{definitionKindLabel(option.kind)} · {option.sourceLabel}<br/>{option.description ?? 'No description supplied'} · {option.stockLabel}</small></span><span className="picker-result__status">{option.ppCost?.state === 'known' && <Badge tone="info">{option.ppCost.value} PP</Badge>}{option.rulesetStatus && <Badge tone="warning">{option.rulesetStatus}</Badge>}{!option.preferred && <Badge>Historical or base</Badge>}</span></button>)}
      </div>
      {candidates.length > limit && <Button onClick={() => setLimit(limit + DEFINITION_RESULT_PAGE_SIZE)} tone="secondary">Show {Math.min(DEFINITION_RESULT_PAGE_SIZE, candidates.length - limit)} more</Button>}
      {candidates.length === 0 && <InlineNotice title="No matching definitions">Create a personal definition from this search, or try another name or type.</InlineNotice>}
      <div className="form-actions">{selectedOption && <Button icon="edit" onClick={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'definition-editor', mode: 'override', ref: preferredDefinitionRef(profile, selectedOption.ref) }))} tone="secondary">Edit selected definition</Button>}<Button icon="plus" onClick={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'definition-editor', mode: 'new' }))} tone="secondary">{query.trim() ? `Create "${query.trim().slice(0, 80)}"` : createLabel}</Button></div>
    </div></Sheet>
    {editingRef && <DefinitionEditor allowedKinds={allowedKinds} baseRef={editingRef} initialName="" key={entityDefinitionKey(editingRef)} onClose={() => navigation.close()} onSaved={editorSaved} open routeIndex={pickerIndex + 1}/>}
    {creating && <DefinitionEditor allowedKinds={allowedKinds} initialName={query.trim()} key={`create:${query.trim()}`} onClose={() => navigation.close()} onSaved={editorSaved} open routeIndex={pickerIndex + 1}/>}
  </>
}

export function DefinitionPickerField({ label, hint, allowedKinds, value, disabled = false, allowUnknown = true, allowEmpty = false, autoFocus = false, routeKey, onChange }: { label: string; hint?: string; allowedKinds: readonly CatalogEntityKind[]; value?: EntityRef | null; disabled?: boolean; allowUnknown?: boolean; allowEmpty?: boolean; autoFocus?: boolean; routeKey?: string; onChange: (ref: EntityRef | null | undefined) => void }) {
  const navigation = useNavigation()
  const { options } = useDefinitionWorkspace()
  const pickerMemoryRef = useRef({ query: '', resultLimit: DEFINITION_RESULT_PAGE_SIZE })
  const fieldKey = routeKey ?? (label.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'definition')
  const picker = navigation.route.overlays.findLast((overlay) => overlay.kind === 'definition-picker')
  const open = picker?.kind === 'definition-picker' && picker.fieldKey === fieldKey
  if (open) pickerMemoryRef.current = { query: picker.query, resultLimit: picker.resultLimit }
  const selected = findDefinitionOption(options, value)
  const display = value === null ? 'Observed empty' : selected?.name ?? (value ? 'Unresolved exact definition' : 'Unknown or unrecorded')
  // Keep native autofocus available when the containing dialog opens
  return <div className="field definition-picker-field"><span className="field__label">{label}</span><button aria-haspopup="dialog" aria-label={`Choose ${label}`} autoFocus={autoFocus} className="definition-picker-trigger" disabled={disabled} onClick={() => navigation.navigate(routeWithOverlay(navigation.route, { kind: 'definition-picker', fieldKey, ...pickerMemoryRef.current }))} ref={(trigger) => { if (trigger) trigger.autofocus = autoFocus }} type="button"><span><strong>{display}</strong><small>{selected ? `${definitionKindLabel(selected.kind)} · ${selected.sourceLabel}` : hint}</small></span><Icon name="search"/></button>{hint && selected && <span className="field__hint">{hint}</span>}<DefinitionPickerDialog allowEmpty={allowEmpty} allowedKinds={allowedKinds} allowUnknown={allowUnknown} onClose={() => navigation.close()} onSelect={onChange} open={open} selected={value} title={`Choose ${label}`}/></div>
}
