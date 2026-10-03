import { BuildCharacterComparison } from './BuildCharacterComparison'
import { resolveGameRules } from '../domain/game-rules'
import { composeModCatalog, expandModCatalogs, modCatalogRevision } from '../domain/mod-layers'
import { sameCorrectionValue } from '../domain/corrections'
import { useOptionalCorrections } from './corrections-context'
import { MoneyText } from './MoneyText'
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { buildBehavior, sameBuildBehavior, compareBuildRevisions, createId, effectiveScenarioAssignments, entityDefinitionKey, logicalEntityKey, requirePlaythrough, sameLogicalEntity, TEAM_SIZE, validateBuildContent } from '../domain'
import type { Build, BuildId, BuildRevision, BuildRevisionId, BuildRevisionContent, BuildSelection, GameSetupId, GameSetupRevision, GameSetupRevisionId, CatalogEntityKind, CatalogSnapshot, EntityRef, LocalData, ScenarioKind, TeamScenario, ValidationReport } from '../domain/types'
import { Badge, Button, EmptyState, Field, IconButton, InlineNotice, ScreenHeader, Segmented } from './components'
import { Icon } from './icons'
import { formatAppError, activeGameSetup, catalogLocksMatch, entityName, formatRelativeDate, ownRecordValue, resolveEntity, resolveCalculationEntity } from './model'
import { Sheet } from './Sheet'
import { DefinitionProvider, findDefinitionOption, useDefinitionLibrary, type DefinitionOption } from './definitions'
import { BuildReadinessAssignment, ValidationPanel } from './BuildReadiness'
import { formatStatRange } from './BuildMechanics'
import { CALCULATION_GENDER_LABELS, defaultCalculation, followPrimary } from '../domain/calculation-plan'
import { BuildValidity } from './BuildValidity'
import { calculateBuildStats, CALCULATED_STATS, STAT_LABELS } from '../domain/build-stats'
import { LoadoutSheet } from './LoadoutSheet'
import { BuildDetailsControl } from './BuildDetailsControl'
import { BuildTagsField, buildTagsFromDraft, type BuildTagsDraft } from './BuildTagsField'
import type { BuildDetailsPatch } from './BuildDetailsControl'
import { BuildDefinitionField, BUILD_DEFINITION_PAGE_SIZE } from './BuildDefinitionField'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { isReferenceResearchRoute, parentRoute, routeWithOverlay, useNavigation, useNavigationBlocker, type AppRoute, type BuildsPageRoute } from './navigation'
import type { DraftActions, DraftChangeHandler } from './drafts'
import { BuildLoadoutSummary, PassiveCapacityMeter } from './BuildLoadoutSummary'
import { FIELD_FOCUS_QUERY_KEY, fieldFocusQuery, focusFieldElement } from './field-focus'
import { buildEquipmentPermissions } from '../domain/build-mechanics'
import { ShareButton } from './ShareButton'
import { BuildBehaviorEditor } from './BuildBehaviorEditor'
import type { BuildBehavior } from '../domain/build-behavior'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { DEFAULT_GAME_MODE, DEFAULT_PP_LIMIT } from '../domain/local-data'
import { WorkspacePrimaryAction } from './WorkspaceHeader'

export interface BuildDraft { readonly id: BuildId; readonly revisionId: BuildRevisionId; readonly title: string; readonly tags: readonly string[] }
export interface RevisionDraft extends BuildRevisionContent { readonly behavior: BuildBehavior; readonly behaviorRevisionId?: GameSetupRevisionId; readonly note?: string }
export interface ScenarioDraft { readonly label: string; readonly kind: Exclude<ScenarioKind, 'recordedCurrent'>; readonly memberIds: readonly string[]; readonly baseline: 'empty' | 'recordedParty'; readonly enforceStock: boolean; readonly includeProtected: boolean; readonly buildRevisionId?: BuildRevisionId }

type BuildsSection = 'library' | 'teams' | 'compare'

function AddBuildForm({ localData, catalogs, tagSuggestions, onCancel, onSubmit, onSaved, onDirtyChange }: { localData: LocalData; catalogs: readonly CatalogSnapshot[]; tagSuggestions: readonly string[]; onCancel: () => void; onSubmit: (draft: BuildDraft, revision: RevisionDraft) => Promise<{ buildId: BuildId; revisionId: BuildRevisionId }>; onSaved: (buildId: BuildId, revisionId: BuildRevisionId) => void; onDirtyChange: DraftChangeHandler }) {
  const [id] = useState(() => createId<BuildId>('build'))
  const [revisionId] = useState(() => createId<BuildRevisionId>('buildRevision'))
  const [title, setTitle] = useState('')
  const [tags, setTags] = useState<BuildTagsDraft>({ tags: [], input: '' })
  const createdRef = useRef<BuildId>(undefined)
  return <section className="build-column build-sheet-panel"><div className="build-column__body"><RevisionEditor catalogs={catalogs} locked={Boolean(localData.buildRevisions[revisionId])} onCancel={onCancel} onDirtyChange={onDirtyChange} onSaved={(revisionId) => { if (createdRef.current) onSaved(createdRef.current, revisionId) }} onSubmit={async (revision) => {
    const automaticTitle = revision.primaryClass ? `${entityName(localData, catalogs, revision.primaryClass)} build` : 'Untitled build'
    const created = await onSubmit({ id, revisionId, title: title.trim() || automaticTitle, tags: buildTagsFromDraft(tags) }, revision)
    createdRef.current = created.buildId
    return created.revisionId
  }} localData={localData}>
    {markDirty => <><Field label="Build title" hint="Optional. Otherwise named after the selected class."><input aria-label="Build title" onChange={(event) => setTitle(event.target.value)} placeholder="Name this Build" value={title}/></Field><details className="build-tags-control"><summary>Tags</summary><div className="build-tags-control__editor"><BuildTagsField draft={tags} onChange={next => { setTags(next); markDirty() }} suggestions={tagSuggestions}/></div></details></>}
  </RevisionEditor></div></section>
}
interface PickerTarget { readonly fieldKey: string; readonly key: string; readonly target: 'primaryClass' | 'secondaryClass' | 'equipment' | 'passive'; readonly label: string; readonly kinds: readonly CatalogEntityKind[] }

function checkpointSuffix(revision: BuildRevision) {
  const name = revision.note?.trim()
  return name ? ` · ${name}` : ''
}

function revisionOptionLabel(localData: LocalData, revision: BuildRevision) {
  return `${ownRecordValue(localData.builds, revision.buildId)?.title ?? 'Unresolved build'} · r${revision.revision}${checkpointSuffix(revision)}`
}

function BuildCard({ build, selected, onSelect, onSlotSelect, localData, catalogs, showShare, shareBlocked }: { build: Build; selected: boolean; onSelect: () => void; onSlotSelect: (slotId: string) => void; localData: LocalData; catalogs: readonly CatalogSnapshot[]; showShare: boolean; shareBlocked: boolean }) {
  const revision = build.latestRevisionId ? ownRecordValue(localData.buildRevisions, build.latestRevisionId) : undefined
  const pinnedRevision = revision?.buildId === build.id ? revision : undefined
  const gameSetup = pinnedRevision ? ownRecordValue(localData.gameSetups, pinnedRevision.gameSetupRevisionId) : undefined
  return <article aria-current={selected ? 'true' : undefined} className="build-card" onClick={event => { if (event.currentTarget.contains(event.target as Node) && !(event.target as HTMLElement).closest('button, a, input, select, textarea')) onSelect() }}>
    <span className="build-card__header"><button className="build-card__open" onClick={event => { event.stopPropagation(); onSelect() }} type="button"><strong>{build.title}</strong></button></span>
    <small className="build-card__meta">{gameSetup?.label ?? 'Game Setup unavailable'} · {pinnedRevision ? `revision ${pinnedRevision.revision}` : build.latestRevisionId ? 'checkpoint unavailable' : 'no revision'}</small>
    {pinnedRevision ? <BuildLoadoutSummary catalogs={catalogs} content={pinnedRevision.content} onEquipmentSelect={onSlotSelect} localData={localData} gameSetup={gameSetup}/> : <span className="build-card__unavailable"><Icon name={build.latestRevisionId ? 'warning' : 'layers'}/>{build.latestRevisionId ? 'Saved checkpoint unavailable' : 'Save a checkpoint to summarize this build'}</span>}
    {(build.tags.length > 0 || showShare && pinnedRevision) && <div className="build-card__actions">{build.tags.length > 0 && <span className="cluster">{build.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}</span>}{showShare && pinnedRevision && <ShareButton disabled={shareBlocked} localData={localData} target={{ kind: 'build', revisionId: pinnedRevision.id }}/>}</div>}
  </article>
}

function selectionWithoutAllocation(selection: BuildSelection): BuildSelection {
  return {
    ref: selection.ref,
    ...(selection.observedName === undefined ? {} : { observedName: selection.observedName }),
  }
}

function detachAllocation(selections: Readonly<Record<string, BuildSelection | null>>, slotId: string, equipmentSlotIds: ReadonlySet<string>) {
  const next = { ...selections }
  const current = next[slotId]
  if (!current?.allocationId) return next
  const allocationId = current.allocationId
  next[slotId] = selectionWithoutAllocation(current)
  const remaining = Object.entries(next).filter(([candidateId, selection]) => candidateId !== slotId && equipmentSlotIds.has(candidateId) && selection?.allocationId === allocationId)
  if (remaining.length === 1) {
    const [remainingId, selection] = remaining[0]
    if (selection) next[remainingId] = selectionWithoutAllocation(selection)
  }
  return next
}

interface RevisionEditorProps { readonly build?: Build; readonly children?: ReactNode | ((markDirty: () => void) => ReactNode); readonly locked?: boolean; readonly sourceRevision?: BuildRevision; readonly localData: LocalData; readonly catalogs: readonly CatalogSnapshot[]; readonly onCancel?: () => void; readonly onSubmit: (draft: RevisionDraft) => Promise<BuildRevisionId>; readonly onSaved: (revisionId: BuildRevisionId) => void; readonly onDirtyChange: DraftChangeHandler }

function RevisionEditor(props: RevisionEditorProps) {
  const library = useDefinitionLibrary()
  const navigation = useNavigation()
  const corrections = useOptionalCorrections()
  const requestedSetupId = navigation.route.query.gameSetup?.[0]
  const requestedSetup = requestedSetupId ? ownRecordValue(props.localData.gameSetups, requestedSetupId) : undefined
  const initialBehavior = () => {
    const revision = props.sourceRevision ?? (props.build?.latestRevisionId ? props.localData.buildRevisions[props.build.latestRevisionId] : undefined)
    const setup = revision ? props.localData.gameSetups[revision.gameSetupRevisionId] : requestedSetup
    if (setup) return { ...buildBehavior(setup), slots: setup.slots.length ? setup.slots : SUGGESTED_BUILD_SLOTS }
    return { label: 'Custom Game Setup', platform: { state: 'unknown' }, gameVersion: { state: 'unknown' }, mode: { state: 'known', value: DEFAULT_GAME_MODE }, mods: { state: 'unknown' }, ppLimit: { state: 'known', value: DEFAULT_PP_LIMIT }, ppCostsNonNegative: { state: 'known', value: true }, slots: SUGGESTED_BUILD_SLOTS, catalogLock: { [DEFAULT_CATALOG.id]: DEFAULT_CATALOG.revisionId } } satisfies BuildBehavior
  }
  const [behavior, setBehavior] = useState<BuildBehavior>(initialBehavior)
  const [draftIdentity] = useState(() => ({ id: createId<GameSetupRevisionId>('draftBehavior'), gameSetupId: createId<GameSetupId>('draftPreset') }))
  const draftId = draftIdentity.id
  const source = props.sourceRevision ? props.localData.gameSetups[props.sourceRevision.gameSetupRevisionId] : requestedSetup
  const gameSetup = useMemo(() => ({ id: draftId, gameSetupId: source?.gameSetupId ?? draftIdentity.gameSetupId, revision: source?.revision ?? 1, createdAt: source?.createdAt ?? props.localData.createdAt, ...behavior }), [behavior, draftId, draftIdentity.gameSetupId, source, props.localData.createdAt])
  const updateBehavior = (value: BuildBehavior) => {
    const composition = value.modComposition
    if (!composition) { setBehavior(value); return }
    const origins = Object.values(props.localData.gameSetups).filter(setup => sameCorrectionValue(setup.modComposition, composition))
    const origin = origins.find(setup => setup.catalogLock[composition.baseline.catalogId] === value.catalogLock[composition.baseline.catalogId]) ?? origins[0]
    setBehavior({ ...value, catalogLock: { ...value.catalogLock, [composition.baseline.catalogId]: origin?.catalogLock[composition.baseline.catalogId] ?? modCatalogRevision(draftId) } })
  }
  const rawCatalogs = corrections?.baseline ?? library.catalogs
  const composed = useMemo(() => {
    if (!gameSetup.modComposition || gameSetup.catalogLock[gameSetup.modComposition.baseline.catalogId] !== modCatalogRevision(draftId)) return undefined
    try { return composeModCatalog(gameSetup, rawCatalogs) } catch { return undefined }
  }, [draftId, gameSetup, rawCatalogs])
  const planningCatalogs = useMemo(() => composed ? expandModCatalogs([...rawCatalogs, composed]) : rawCatalogs, [composed, rawCatalogs])
  const displayCatalogs = useMemo(() => composed ? expandModCatalogs([...library.catalogs, composed]) : library.catalogs, [composed, library.catalogs])
  const scopedData = useMemo(() => ({ ...props.localData, planningGameSetupRevisionId: draftId, gameSetups: { ...props.localData.gameSetups, [draftId]: gameSetup } }), [props.localData, draftId, gameSetup])
  return <DefinitionProvider catalogs={displayCatalogs} planningCatalogs={planningCatalogs} localData={scopedData} onSaveDefinition={library.onSaveDefinition}><RevisionEditorBody {...props} catalogs={planningCatalogs} behavior={behavior} gameSetup={gameSetup} localData={scopedData} onBehaviorChange={updateBehavior} onDiscardBehavior={() => setBehavior(initialBehavior())} presetData={props.localData}/></DefinitionProvider>
}

function RevisionEditorBody({ build, sourceRevision, localData, catalogs, onCancel, onSubmit, onSaved, onDirtyChange, children, locked = false, behavior, gameSetup, onBehaviorChange, onDiscardBehavior, presetData }: RevisionEditorProps & { readonly behavior: BuildBehavior; readonly gameSetup: GameSetupRevision; readonly onBehaviorChange: (value: BuildBehavior) => void; readonly onDiscardBehavior: () => void; readonly presetData: LocalData }) {
  const formId = useId()
  const navigation = useNavigation()
  const { options, planningOptions } = useDefinitionLibrary()
  const latest = sourceRevision ?? (build?.latestRevisionId ? ownRecordValue(localData.buildRevisions, build.latestRevisionId) : undefined)
  const initialDraft = (): RevisionDraft => ({ behavior, primaryClass: latest?.content.primaryClass ?? null, secondaryClass: latest?.content.secondaryClass ?? null, equipment: { ...(latest?.content.equipment ?? {}) }, passives: [...(latest?.content.passives ?? [])], rotationNotes: latest?.content.rotationNotes, contextAssumptions: latest?.content.contextAssumptions ?? [], calculation: latest?.content.calculation ?? defaultCalculation(latest?.content.primaryClass ?? null), note: undefined })
  const behaviorRef = useRef<HTMLDetailsElement>(null)
  const [draft, setDraft] = useState<RevisionDraft>(initialDraft)
  const [assumptions, setAssumptions] = useState(draft.contextAssumptions.join('\n'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const dirtyRef = useRef(false)
  const draftRef = useRef(draft)
  const assumptionsRef = useRef(assumptions)
  const actionsRef = useRef<DraftActions | undefined>(undefined)
  const registeredActionsRef = useRef<DraftActions>({ save: () => actionsRef.current?.save() ?? Promise.resolve(false), discard: () => actionsRef.current?.discard() })
  draftRef.current = draft
  assumptionsRef.current = assumptions
  const [inspected, setInspected] = useState<DefinitionOption>()
  const [comparedWith, setComparedWith] = useState<DefinitionOption>()
  const [includeInnates, setIncludeInnates] = useState(true)
  const [behaviorEditorKey, setBehaviorEditorKey] = useState(0)
  const [editorView, setEditorView] = useState<'loadout' | 'checks'>('loadout')
  const pickerMemoryRef = useRef<Record<string, { readonly query: string; readonly resultLimit: number }>>({})
  const slots = useMemo(() => [...(gameSetup?.slots.length ? gameSetup.slots : SUGGESTED_BUILD_SLOTS)].sort((a, b) => a.order - b.order), [gameSetup])
  const definitionIndex = useMemo(() => new Map(options.map(option => [entityDefinitionKey(option.ref), option.record])), [options])
  const equipmentPermissions = useMemo(() => buildEquipmentPermissions({ primaryClass: draft.primaryClass, secondaryClass: draft.secondaryClass, passives: draft.passives }, ref => definitionIndex.get(entityDefinitionKey(ref))), [definitionIndex, draft.primaryClass, draft.secondaryClass, draft.passives])
  const equippedInnateCount = useMemo(() => draft.passives.filter(selection => definitionIndex.get(entityDefinitionKey(selection.ref))?.kind === 'innate').length, [definitionIndex, draft.passives])
  const innateToggleHint = includeInnates
    ? 'Innates are included in every passive search. Some innate PP costs remain unknown.'
    : equippedInnateCount > 0
      ? `${equippedInnateCount} equipped ${equippedInnateCount === 1 ? 'innate remains' : 'innates remain'} selected. Innates are hidden from search results.`
      : 'Innates are hidden from search results. Existing selections are unchanged.'
  const validity = useMemo(() => validateBuildContent(draft, gameSetup, slots, ref => definitionIndex.get(entityDefinitionKey(ref)), ref => logicalEntityKey(localData, ref)), [definitionIndex, draft, localData, gameSetup, slots])
  const retainedEquipment = Object.entries(draft.equipment).filter(([id]) => !slots.some(slot => slot.id === id))
  const equipmentSlots = slots
  const equipmentSlotIds = new Set(equipmentSlots.map((slot) => slot.id as string))
  const targetForFieldKey = (fieldKey: string): PickerTarget | undefined => {
    if (fieldKey === 'primary-class') return { fieldKey, key: 'primaryClass', target: 'primaryClass', label: 'Class', kinds: ['class'] }
    if (fieldKey === 'secondary-class') return { fieldKey, key: 'secondaryClass', target: 'secondaryClass', label: 'Sub-command', kinds: ['class'] }
    if (!fieldKey.startsWith('slot:')) return undefined
    const key = fieldKey.slice(5)
    const passiveMatch = /^passive-(\d+)$/.exec(key)
    if (passiveMatch) {
      const index = Number(passiveMatch[1]) - 1
      return index >= 0 && index <= draft.passives.length ? { fieldKey, key: String(index), target: 'passive', label: `Equipped passive ${index + 1}`, kinds: ['passive', 'innate'] } : undefined
    }
    const slot = slots.find((entry) => entry.id === key)
    if (!slot) return undefined
    const kinds: readonly CatalogEntityKind[] = slot.acceptedEntityKinds?.state === 'known' ? slot.acceptedEntityKinds.value : ['item']
    return { fieldKey, key, target: 'equipment', label: slot.label, kinds }
  }
  const requestedFocusField = navigation.route.query[FIELD_FOCUS_QUERY_KEY]?.[0]
  const requestedFocusTarget = requestedFocusField ? targetForFieldKey(requestedFocusField) : undefined
  const requestedEquipmentField = requestedFocusTarget?.target === 'equipment' ? requestedFocusTarget.fieldKey : undefined
  const requestedEquipmentOption = requestedFocusTarget?.target === 'equipment' ? findDefinitionOption(planningOptions, draft.equipment[requestedFocusTarget.key]?.ref) : undefined
  const focusedEquipmentFieldRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!requestedEquipmentField) {
      focusedEquipmentFieldRef.current = undefined
      return
    }
    if (focusedEquipmentFieldRef.current === requestedEquipmentField) return
    if (editorView !== 'loadout') {
      setEditorView('loadout')
      return
    }
    return focusFieldElement(requestedEquipmentField, () => { focusedEquipmentFieldRef.current = requestedEquipmentField })
  }, [editorView, requestedEquipmentField])
  useEffect(() => {
    if (!requestedEquipmentField) return
    setInspected(requestedEquipmentOption)
    setComparedWith(undefined)
  }, [requestedEquipmentField, requestedEquipmentOption])
  const pickerOverlay = navigation.route.overlays[0]?.kind === 'definition-picker' ? navigation.route.overlays[0] : undefined
  const picker = pickerOverlay ? targetForFieldKey(pickerOverlay.fieldKey) : undefined
  const missingPicker = Boolean(pickerOverlay && !picker)
  const query = pickerOverlay?.query ?? ''
  const candidateLimit = pickerOverlay?.resultLimit ?? BUILD_DEFINITION_PAGE_SIZE
  useEffect(() => {
    if (pickerOverlay) pickerMemoryRef.current[pickerOverlay.fieldKey] = { query, resultLimit: candidateLimit }
  }, [candidateLimit, pickerOverlay, query])
  const editorScope: AppRoute = { ...navigation.route, overlays: [] }
  useNavigationBlocker(editorScope, () => dirtyRef.current, () => setError('Save this revision or choose Cancel and discard before leaving the editor.'), (to) => !busy && !locked && isReferenceResearchRoute(to))
  const updateDirty = (value: boolean) => { dirtyRef.current = value; onDirtyChange(value, value ? registeredActionsRef.current : undefined) }
  const openPicker = (target: PickerTarget) => {
    if (picker?.fieldKey === target.fieldKey) return
    const stored = pickerMemoryRef.current[target.fieldKey]
    navigation.navigate(routeWithOverlay(editorScope, { kind: 'definition-picker', fieldKey: target.fieldKey, query: stored?.query ?? '', resultLimit: stored?.resultLimit ?? BUILD_DEFINITION_PAGE_SIZE }), { replace: Boolean(pickerOverlay) })
  }
  const closePicker = () => navigation.close()
  const updatePickerQuery = (target: PickerTarget, query: string, resultLimit = BUILD_DEFINITION_PAGE_SIZE) => {
    pickerMemoryRef.current[target.fieldKey] = { query, resultLimit }
    navigation.navigate(routeWithOverlay(editorScope, { kind: 'definition-picker', fieldKey: target.fieldKey, query, resultLimit }), { replace: Boolean(pickerOverlay) })
  }
  const groupSelection = (slotId: string, peerSlotId: string) => {
    setDraft((value) => {
      const equipment = detachAllocation(value.equipment, slotId, equipmentSlotIds)
      const current = equipment[slotId]
      if (!current || !peerSlotId) return { ...value, equipment }
      const peer = equipment[peerSlotId]
      if (!peer || !sameLogicalEntity(localData, peer.ref, current.ref)) return value
      const allocationId = peer.allocationId ?? JSON.stringify(['shared-copy', ...[slotId, peerSlotId].sort()])
      equipment[slotId] = { ...current, allocationId }
      equipment[peerSlotId] = { ...peer, allocationId }
      return { ...value, equipment }
    })
    updateDirty(true)
  }
  const save = async () => { if (busy) return false; setBusy(true); setError(undefined); try { const revisionId = await onSubmit({ ...draftRef.current, behavior, behaviorRevisionId: gameSetup.id, contextAssumptions: assumptionsRef.current.split('\n').map((value) => value.trim()).filter(Boolean) }); updateDirty(false); onSaved(revisionId); return true } catch (reason) { setError(reason instanceof Error ? reason.message : 'The build revision could not be saved.'); return false } finally { setBusy(false) } }
  const submit = (event: FormEvent) => { event.preventDefault(); void save() }
  const discard = () => { onDiscardBehavior(); setBehaviorEditorKey(value => value + 1); const value = initialDraft(); setDraft(value); setAssumptions(value.contextAssumptions.join('\n')); setError(undefined); updateDirty(false); onCancel?.() }
  actionsRef.current = { save, discard }
  const dismissPicker = () => { const parent = parentRoute(navigation.route); if (parent) navigation.navigate(parent, { replace: true }) }
  const field = (target: PickerTarget, value: EntityRef | null) => <BuildDefinitionField allowedKinds={target.kinds} gameSetup={gameSetup} equipmentPermissions={target.target === 'equipment' ? equipmentPermissions : undefined} equipmentSlot={target.target === 'equipment' ? slots.find(slot => slot.id === target.key) : undefined} includeInnates={includeInnates} label={target.label} onChange={(ref) => {
    if (target.target === 'primaryClass') setDraft((current) => ({ ...current, primaryClass: ref, ...(current.calculation ? { calculation: followPrimary(current.calculation, ref) } : {}) }))
    else if (target.target === 'secondaryClass') setDraft((current) => ({ ...current, secondaryClass: ref }))
    else if (target.target === 'passive') setDraft((current) => {
      const passives = [...current.passives]
      const index = Number(target.key)
      if (ref) passives[index] = { ref, observedName: entityName(localData, catalogs, ref) }
      else if (index < passives.length) passives.splice(index, 1)
      return { ...current, passives }
    })
    else setDraft((current) => ({ ...current, equipment: { ...detachAllocation(current.equipment, target.key, equipmentSlotIds), [target.key]: ref ? { ref, observedName: entityName(localData, catalogs, ref) } : null } }))
    updateDirty(true)
  }} onClose={closePicker} onDismiss={dismissPicker} onInspect={(option) => { setInspected(option); setComparedWith(findDefinitionOption(planningOptions, value)) }} onOpen={() => openPicker(target)} onQueryChange={(nextQuery) => updatePickerQuery(target, nextQuery)} onResultLimitChange={(limit) => updatePickerQuery(target, query, limit)} resultLimit={candidateLimit} open={picker?.fieldKey === target.fieldKey} query={picker?.fieldKey === target.fieldKey ? query : ''} value={value}/>
  const slotField = (slot: typeof slots[number]) => {
    const selected = draft.equipment[slot.id]
    const peers = selected ? equipmentSlots.filter((candidate) => candidate.id !== slot.id && draft.equipment[candidate.id] && sameLogicalEntity(localData, draft.equipment[candidate.id]!.ref, selected.ref)) : []
    const groupedPeer = selected?.allocationId ? peers.find((candidate) => draft.equipment[candidate.id]?.allocationId === selected.allocationId) : undefined
    return <div className="slot-entry" data-field-key={`slot:${slot.id}`} key={slot.id} tabIndex={-1}>{field(targetForFieldKey(`slot:${slot.id}`)!, selected?.ref ?? null)}{peers.length > 0 && <Field className="slot-allocation" hint="Group slots only when one physical item occupies both." label="Same copy as"><select aria-label={`${slot.label}: Same copy as`} onChange={(event) => groupSelection(slot.id, event.target.value)} value={groupedPeer?.id ?? ''}><option value="">Separate recorded copy</option>{peers.map((peer) => <option key={peer.id} value={peer.id}>{peer.label}</option>)}</select></Field>}</div>
  }
  const passiveField = (selection: BuildSelection | undefined, index: number) => {
    const target = targetForFieldKey(`slot:passive-${index + 1}`)!
    return <div className="slot-entry" key={`${index}:${selection ? entityDefinitionKey(selection.ref) : 'add'}`}>{field(target, selection?.ref ?? null)}</div>
  }
  return <form className="stack build-sheet" data-validity={validity.status} id={formId} onChange={(event) => { const target = event.target as HTMLElement; if (target.getAttribute('role') !== 'combobox' && !target.hasAttribute('data-draft-exempt')) updateDirty(true) }} onInvalid={event => { for (let parent: HTMLElement | null = event.target as HTMLElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true }} onSubmit={submit}>
    {locked && <InlineNotice title="Build retained for saving">Use Retry save if needed, then Save build to open the saved sheet.</InlineNotice>}
    {error && <InlineNotice title="Revision not saved" tone="danger">{error} Your selections remain in this editor.</InlineNotice>}
    <fieldset className="build-sheet__fields" disabled={busy || locked}><BuildBehaviorEditor detailsRef={behaviorRef} initiallyOpen={!build} key={behaviorEditorKey} localData={presetData} onChange={value => { onBehaviorChange(value); updateDirty(true) }} value={behavior}/></fieldset>
    <BuildValidity report={validity}/>
    <fieldset className="build-sheet__fields" disabled={busy || locked}><LoadoutSheet gameSetup={gameSetup} catalogs={catalogs} content={draft} localData={localData} slots={slots} view={editorView} onViewChange={setEditorView} viewLabel="Build editor view" selection={inspected} comparedWith={comparedWith}
      classFields={<>{field(targetForFieldKey('primary-class')!, draft.primaryClass)}{field(targetForFieldKey('secondary-class')!, draft.secondaryClass)}</>}
      equipmentFields={<>{equipmentSlots.map(slotField)}{retainedEquipment.length > 0 && <InlineNotice title="Previous slots need review" tone="warning">This Game Setup has a different slot layout. Previous selections remain until you remove them.{retainedEquipment.map(([id, selection]) => <div className="cluster" key={id}><span>{id}: {selection ? entityName(localData, catalogs, selection.ref) : 'Empty'}</span><Button onClick={() => { setDraft(value => { const equipment = { ...value.equipment }; delete equipment[id]; return { ...value, equipment } }); updateDirty(true) }} tone="quiet" type="button">Remove {id}</Button></div>)}</InlineNotice>}</>}
      passiveTools={<><PassiveCapacityMeter announce pp={validity.pp}/><label className="build-innate-toggle"><input checked={includeInnates} data-draft-exempt="true" onChange={(event) => setIncludeInnates(event.target.checked)} type="checkbox"/><span><strong>Include innates from the Learnable Innate Skill mod</strong><small>{innateToggleHint}</small></span></label></>}
      passiveFields={[...draft.passives, undefined].map(passiveField)}
      context={<p className="build-sheet__planning-note"><Icon name="info"/>Plan freely. Saving does not change your inventory or recorded character.</p>}
      onCalculationChange={calculation => { setDraft(current => ({ ...current, calculation })); updateDirty(true) }}
      onReviewGameSetup={() => { const details = behaviorRef.current; if (details) { details.open = true; details.scrollIntoView({ block: 'start' }); details.querySelector<HTMLSelectElement>('select')?.focus({ preventScroll: true }) } }}
      notes={<section className="build-details"><h3>Build details & notes</h3><div className="stack">{typeof children === 'function' ? children(() => updateDirty(true)) : children}<Field label="Rotation or use notes"><textarea onChange={(event) => setDraft({ ...draft, rotationNotes: event.target.value || undefined })} placeholder="Optional play notes" value={draft.rotationNotes ?? ''}/></Field><Field hint="One assumption per line. These stay visible in comparisons." label="Context assumptions"><textarea onChange={(event) => setAssumptions(event.target.value)} value={assumptions}/></Field><Field label="Checkpoint name"><input onChange={(event) => setDraft({ ...draft, note: event.target.value || undefined })} value={draft.note ?? ''}/></Field><p className="field__hint">{gameSetup?.slots.length ? `Slot layout: ${gameSetup.label}` : 'Suggested planning slots. Game version, mods, and equipment permissions remain unverified; review the Game Setup coverage.'}</p></div></section>}
    /></fieldset>
    {missingPicker && <InlineNotice title="Build field unavailable" tone="warning">The requested slot or class field is not part of this editor configuration. <Button onClick={closePicker} tone="quiet" type="button">Close picker route</Button></InlineNotice>}
    <div className="form-actions"><Button disabled={busy} onClick={discard} tone="quiet" type="button">{onCancel ? 'Cancel and discard' : 'Discard edits'}</Button><WorkspacePrimaryAction><Button disabled={busy} form={formId} icon="check" type="submit">{busy ? 'Saving...' : build ? 'Save new revision' : 'Save build'}</Button></WorkspacePrimaryAction></div>
  </form>
}

function AddScenarioForm({ localData, revision, onCancel, onSubmit }: { localData: LocalData; revision?: BuildRevision; onCancel: () => void; onSubmit: (draft: ScenarioDraft) => Promise<void> }) {
  const currentGameSetup = revision ? ownRecordValue(localData.gameSetups, revision.gameSetupRevisionId) : activeGameSetup(localData)
  const recorded = Object.values(requirePlaythrough(localData).scenarios).find((scenario) => scenario.kind === 'recordedCurrent')
  const sameLock = Boolean(recorded && currentGameSetup && catalogLocksMatch(recorded.catalogLock, revision?.catalogLock ?? currentGameSetup.catalogLock))
  const recordedAssignments = recorded ? effectiveScenarioAssignments(recorded) : {}
  const recordedMembers = recorded?.memberIds ?? []
  const recordedBaselineAvailable = Boolean(recorded && currentGameSetup && sameBuildBehavior(localData.gameSetups[recorded.gameSetupRevisionId], currentGameSetup) && sameLock && Object.keys(recordedAssignments).length)
  const initialMembers = Array.from({ length: TEAM_SIZE }, () => '')
  const [draft, setDraft] = useState<ScenarioDraft>({ label: '', kind: 'draft', memberIds: initialMembers, baseline: 'empty', enforceStock: true, includeProtected: false, buildRevisionId: revision?.id })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const distinctMembers = new Set(draft.memberIds.filter(Boolean))
  const rosterComplete = draft.memberIds.length === TEAM_SIZE && distinctMembers.size === TEAM_SIZE
  const updateMember = (index: number, characterId: string) => setDraft({ ...draft, memberIds: draft.memberIds.map((value, memberIndex) => memberIndex === index ? characterId : value) })
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!rosterComplete) return; setBusy(true); setError(undefined); try { await onSubmit(draft) } catch (reason) { setError(reason instanceof Error ? reason.message : 'The party plan could not be created.') } finally { setBusy(false) } }
  return <form className="stack" onSubmit={submit}><Field label="Party plan name" required><input autoFocus onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="For example: next boss party" required value={draft.label}/></Field><Field hint="Adopting a Team records the current party after you confirm the in-game changes." label="Context"><select onChange={(event) => setDraft({ ...draft, kind: event.target.value as ScenarioDraft['kind'] })} value={draft.kind}><option value="draft">Draft party</option><option value="hypothetical">Hypothetical party</option></select></Field><section className="scenario-roster-editor"><div className="scenario-roster-editor__heading"><div><h3>Tracked party</h3><p>Choose the party roster first. Builds remain independent and can be assigned, cleared, or reused later.</p></div><Badge tone={rosterComplete ? 'positive' : 'warning'}>{distinctMembers.size} of {TEAM_SIZE}</Badge></div>{Object.values(requirePlaythrough(localData).characters).length < TEAM_SIZE && <InlineNotice title="More characters needed" tone="warning">Add at least {TEAM_SIZE - Object.values(requirePlaythrough(localData).characters).length} more {TEAM_SIZE - Object.values(requirePlaythrough(localData).characters).length === 1 ? 'character' : 'characters'} before creating a party plan.</InlineNotice>}<div className="grid-2">{draft.memberIds.map((memberId, index) => <Field key={index} label={`Party member ${index + 1}`} required><select aria-label={`Party member ${index + 1}`} disabled={draft.baseline === 'recordedParty'} onChange={(event) => updateMember(index, event.target.value)} required value={memberId}><option value="">Choose character</option>{Object.values(requirePlaythrough(localData).characters).map((character) => <option disabled={draft.memberIds.some((value, memberIndex) => memberIndex !== index && value === character.id)} key={character.id} value={character.id}>{character.name}</option>)}</select></Field>)}</div></section><Field hint={recordedBaselineAvailable ? 'Copies the compatible recorded party roster and pinned assignments. Later build changes remain explicit overrides.' : 'A complete recorded party with the chosen Game Setup and catalog lock is required.'} label="Starting assignments"><select onChange={(event) => { const baseline = event.target.value as ScenarioDraft['baseline']; setDraft({ ...draft, baseline, memberIds: baseline === 'recordedParty' ? recordedMembers : draft.memberIds }) }} value={draft.baseline}><option value="empty">Start without assigned builds</option><option disabled={!recordedBaselineAvailable} value="recordedParty">Copy recorded current party</option></select></Field><label className="check-row"><input checked={draft.enforceStock} onChange={(event) => setDraft({ ...draft, enforceStock: event.target.checked })} type="checkbox"/><span><strong>Check recorded stock</strong><small>Report simultaneous assignments against current observations</small></span></label><label className="check-row"><input checked={draft.includeProtected} onChange={(event) => setDraft({ ...draft, includeProtected: event.target.checked })} type="checkbox"/><span><strong>Allow protected copies</strong><small>Use only when this party plan deliberately includes them</small></span></label>{error && <InlineNotice title="Party plan not created" tone="danger">{error} Your entries remain in this form.</InlineNotice>}<div className="form-actions"><Button onClick={onCancel} tone="quiet" type="button">Cancel</Button><Button disabled={busy || !draft.label.trim() || !rosterComplete} icon="plus" type="submit">{busy ? 'Creating...' : 'Create party plan'}</Button></div></form>
}

function ScenarioCard({ scenario, localData, catalogs, validation, onAssign, shareBlocked }: { scenario: TeamScenario; localData: LocalData; catalogs: readonly CatalogSnapshot[]; validation?: ValidationReport; shareBlocked: boolean; onAssign: (scenarioId: string, characterId: string, revisionId: string) => Promise<void> }) {
  const navigation = useNavigation()
  const memberIds = scenario.memberIds
  const characters = memberIds.flatMap(characterId => ownRecordValue(requirePlaythrough(localData).characters, characterId) ?? [])
  const revisions = Object.values(localData.buildRevisions).filter(candidate => sameBuildBehavior(localData.gameSetups[candidate.gameSetupRevisionId], localData.gameSetups[scenario.gameSetupRevisionId]))
  const effectiveAssignments = effectiveScenarioAssignments(scenario)
  const scenarioGameSetup = ownRecordValue(localData.gameSetups, scenario.gameSetupRevisionId)
  const [assignmentError, setAssignmentError] = useState<string>()
  const assign = async (characterId: string, revisionId: string) => {
    if (scenario.kind === 'recordedCurrent') return
    setAssignmentError(undefined)
    try { await onAssign(scenario.id, characterId, revisionId) } catch (reason) { setAssignmentError(reason instanceof Error ? reason.message : 'The scenario assignment could not be saved.') }
  }
  const completeRoster = memberIds.length === TEAM_SIZE && new Set(memberIds).size === TEAM_SIZE && characters.length === TEAM_SIZE
  return <article className="panel scenario-card" id={`scenario-${scenario.id}`}><header className="panel__header"><div><div className="cluster"><h2>{scenario.label}</h2>{scenario.id === requirePlaythrough(localData).activeScenarioId && <Badge tone="info">Active</Badge>}<Badge tone={scenario.kind === 'recordedCurrent' ? 'positive' : scenario.kind === 'hypothetical' ? 'warning' : 'info'}>{scenario.kind === 'recordedCurrent' ? 'Recorded current' : scenario.kind === 'hypothetical' ? 'Hypothetical' : 'Draft party'}</Badge><Badge tone={completeRoster ? 'positive' : 'danger'}>{memberIds.length} of {TEAM_SIZE} members</Badge></div><p>{scenario.inventoryPolicy.enforceStock ? 'Stock checks enabled' : 'Stock checks informational'} · {scenario.inventoryPolicy.includeProtected ? 'Protected copies allowed' : 'Protected copies excluded'}</p></div><ShareButton disabled={!completeRoster || shareBlocked} localData={localData} target={{ kind: 'team', scenarioId: scenario.id }}/></header><div className="panel__body stack">{scenario.kind === 'recordedCurrent' && <InlineNotice title="Recorded assignments follow confirmed observations">Use a build's Record as current action after applying it in game. Draft and hypothetical party plans remain directly editable.</InlineNotice>}{!completeRoster && <InlineNotice title="This party is incomplete" tone="warning">Party plans use four distinct characters. Choose all four tracked characters in a new party plan. <Button onClick={() => navigation.navigate({ page: { page: 'builds', view: 'scenario-new' }, overlays: [], query: {} })} tone="quiet" type="button">Create party plan</Button></InlineNotice>}<div className="scenario-roster-grid">{Array.from({ length: TEAM_SIZE }, (_, index) => {
    const character = characters[index]
    if (!character) return <section aria-label={`Party member ${index + 1}: missing`} className="scenario-member-card scenario-member-card--empty" key={`empty-${index}`}><header className="scenario-member-card__header"><div className="scenario-member-card__number">{index + 1}</div><div><strong>Member missing</strong><p>No character was recorded for this party slot.</p></div></header><BuildLoadoutSummary catalogs={catalogs} localData={localData} gameSetup={scenarioGameSetup}/></section>
    const assignmentId = ownRecordValue(effectiveAssignments, character.id)
    const revision = assignmentId ? ownRecordValue(localData.buildRevisions, assignmentId) : undefined
    const gameSetup = revision ? ownRecordValue(localData.gameSetups, revision.gameSetupRevisionId) : scenarioGameSetup
    const assignmentHint = scenario.kind === 'recordedCurrent' ? 'Record a pinned build as current to change this assignment.' : 'Choose the pinned build for this party member.'
    return <section aria-label={`${character.name} loadout`} className="scenario-member-card" key={character.id}><header className="scenario-member-card__header"><div className="scenario-member-card__number">{index + 1}</div><strong className="scenario-member-card__name">{character.name}</strong><select aria-label={character.name} disabled={scenario.kind === 'recordedCurrent'} onChange={(event) => void assign(character.id, event.target.value)} title={assignmentHint} value={assignmentId ?? ''}><option value="">No build assigned</option>{revisions.map((candidate) => <option key={candidate.id} value={candidate.id}>{revisionOptionLabel(localData, candidate)}</option>)}</select></header>{assignmentId && !revision ? <span className="build-card__unavailable"><Icon name="warning"/>Assigned checkpoint unavailable</span> : <BuildLoadoutSummary catalogs={catalogs} content={revision?.content} onEquipmentSelect={revision ? slotId => navigation.navigate({ page: { page: 'builds', view: 'revision-edit', buildId: revision.buildId, revisionId: revision.id }, overlays: [], query: fieldFocusQuery(`slot:${slotId}`) }) : undefined} localData={localData} gameSetup={gameSetup}/>}</section>
  })}</div>{assignmentError && <InlineNotice title="Assignment not saved" tone="danger">{assignmentError} The prior pinned assignment remains active.</InlineNotice>}<ValidationPanel catalogs={catalogs} localData={localData} report={validation} scenario={scenario}/></div></article>
}

export function BuildsView({ localData, catalogs, validations, shareBlocked = false, onCreateBuild, onCloneBuild, onSaveDetails, onSaveRevision, onCreateScenario, onAssign, onRecordCurrent, onDraftChange }: { localData: LocalData; catalogs: readonly CatalogSnapshot[]; validations: Readonly<Record<string, ValidationReport | undefined>>; shareBlocked?: boolean; onCreateBuild: (draft: BuildDraft, revision: RevisionDraft) => Promise<{ buildId: BuildId; revisionId: BuildRevisionId }>; onCloneBuild: (buildId: string) => Promise<string>; onSaveDetails: (buildId: string, patch: BuildDetailsPatch) => Promise<void>; onSaveRevision: (buildId: string, draft: RevisionDraft, parentRevisionId?: string) => Promise<BuildRevisionId>; onCreateScenario: (draft: ScenarioDraft) => Promise<void>; onAssign: (scenarioId: string, characterId: string, revisionId: string) => Promise<void>; onRecordCurrent: (buildId: string, revisionId: string, characterId: string) => Promise<void>; onDraftChange: DraftChangeHandler }) {
  const navigation = useNavigation()
  const page = navigation.route.page.page === 'builds' ? navigation.route.page : { page: 'builds', view: 'library' } as const
  const playthrough = requirePlaythrough(localData)
  const allBuilds = Object.values(localData.builds).filter((build) => !build.archived)
  const tagSuggestions = useMemo(() => [...new Set(Object.values(localData.builds).flatMap(build => build.tags))].sort((left, right) => left.localeCompare(right)), [localData.builds])
  const scenarios = Object.values(playthrough.scenarios)
  const revisions = Object.values(localData.buildRevisions).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const section: BuildsSection = page.view === 'teams' || page.view === 'scenario-new' || page.view === 'scenario' ? 'teams' : page.view === 'compare' || page.view === 'compare-pair' ? 'compare' : 'library'
  const addingBuild = page.view === 'build-new'
  const addingScenario = page.view === 'scenario-new'
  const scenarioRevisionId = navigation.route.query.forRevision?.[0]
  const scenarioRevision = scenarioRevisionId ? ownRecordValue(localData.buildRevisions, scenarioRevisionId) : undefined
  const selectedId = 'buildId' in page ? page.buildId : undefined
  const buildQuery = navigation.route.query.q?.[0] ?? ''
  const editingRoute = page.view === 'revision-new' || page.view === 'revision-edit'
  const [libraryOpen, setLibraryOpen] = useState(() => window.matchMedia('(min-width: 821px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(min-width: 821px)')
    const update = () => setLibraryOpen(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const [compareDraft, setCompareDraft] = useState<{ readonly left: string; readonly right: string }>({ left: '', right: '' })
  const leftRevision = page.view === 'compare-pair' ? page.leftRevisionId : compareDraft.left
  const rightRevision = page.view === 'compare-pair' ? page.rightRevisionId : compareDraft.right
  const recordingCurrent = page.view === 'record-current'
  const [currentConfirmed, setCurrentConfirmed] = useState(false)
  const [recordingBusy, setRecordingBusy] = useState(false)
  const [recordingError, setRecordingError] = useState<string>()
  const [recordingCharacterId, setRecordingCharacterId] = useState<string>()
  const [editorDirty, setEditorDirty] = useState(false)
  const editorActionsRef = useRef<DraftActions | undefined>(undefined)
  const openDraftsRef = useRef<{ details?: DraftActions; revision?: DraftActions }>({})
  const combinedActionsRef = useRef<DraftActions>({
    save: async () => {
      const { details, revision } = openDraftsRef.current
      if (details && !await details.save()) return false
      return revision ? revision.save() : true
    },
    discard: () => {
      const { details, revision } = openDraftsRef.current
      details?.discard()
      revision?.discard()
    },
  })
  const draftContinuationRef = useRef<(() => void) | undefined>(undefined)
  const [resolvingDraft, setResolvingDraft] = useState(false)
  const [readinessScenarioId, setReadinessScenarioId] = useState<string>()
  const [draftGuard, setDraftGuard] = useState<string>()
  const [cloneBusy, setCloneBusy] = useState(false)
  const [cloneError, setCloneError] = useState<string>()
  const navigate = (next: BuildsPageRoute, replace = false, query = {}) => navigation.navigate({ ...navigation.route, page: next, overlays: [], query }, { replace })
  const editorRouteFor = (build: Build): BuildsPageRoute => build.latestRevisionId
    ? { page: 'builds', view: 'revision-edit', buildId: build.id, revisionId: build.latestRevisionId }
    : { page: 'builds', view: 'revision-new', buildId: build.id }
  useEffect(() => {
    if (navigation.route.overlays.length) return
    if (page.view === 'revision') {
      navigate({ ...page, view: 'revision-edit' }, true)
      return
    }
    if (page.view !== 'build') return
    const build = ownRecordValue(localData.builds, page.buildId)
    if (build) navigate(editorRouteFor(build), true)
  }, [allBuilds, navigation.route.overlays.length, page, localData.builds, selectedId])
  useEffect(() => {
    if (page.view !== 'scenario' || !ownRecordValue(playthrough.scenarios, page.scenarioId)) return
    window.requestAnimationFrame(() => document.getElementById(`scenario-${page.scenarioId}`)?.scrollIntoView({ block: 'start' }))
  }, [page, playthrough.scenarios])
  const updateDraftDirty = (channel: 'details' | 'revision', value: boolean, actions?: DraftActions) => {
    openDraftsRef.current[channel] = value ? actions : undefined
    const dirty = Boolean(openDraftsRef.current.details || openDraftsRef.current.revision)
    setEditorDirty(dirty)
    editorActionsRef.current = dirty ? combinedActionsRef.current : undefined
    if (!dirty) { draftContinuationRef.current = undefined; setDraftGuard(undefined) }
    onDraftChange(dirty, editorActionsRef.current)
  }
  const updateEditorDirty: DraftChangeHandler = (value, actions) => updateDraftDirty('revision', value, actions)
  const updateDetailsDirty: DraftChangeHandler = (value, actions) => updateDraftDirty('details', value, actions)
  const guardDraft = (message: string, continuation: () => void) => { draftContinuationRef.current = continuation; setDraftGuard(message) }
  const changeSection = (value: BuildsSection) => { if (editorDirty && value !== section) { guardDraft('Choose whether to save or discard the build edits, then continue to the selected section.', () => navigate({ page: 'builds', view: value })); return } navigate({ page: 'builds', view: value }) }
  const selectBuild = (value: string, focusField?: string) => { const build = ownRecordValue(localData.builds, value); if (!build) return; const open = () => { navigate(editorRouteFor(build), false, focusField ? fieldFocusQuery(focusField) : {}); if (window.matchMedia('(max-width: 820px)').matches) setLibraryOpen(false) }; if (editorDirty && value !== selected?.id) { guardDraft('Choose whether to save or discard the build edits, then open the selected build.', open); return } open() }
  const resolveDraft = async (resolution: 'save' | 'discard') => {
    const actions = editorActionsRef.current
    const continuation = draftContinuationRef.current
    if (!actions || !continuation) return
    setResolvingDraft(true)
    try {
      const resolved = resolution === 'save' ? await actions.save() : (actions.discard(), true)
      if (resolved) continuation()
    } finally { setResolvingDraft(false) }
  }
  const matchingBuilds = allBuilds.filter((build) => `${build.title} ${build.tags.join(' ')} ${ownRecordValue(localData.gameSetups, build.latestRevisionId ? localData.buildRevisions[build.latestRevisionId]?.gameSetupRevisionId : '')?.label ?? ''}`.toLocaleLowerCase().includes(buildQuery.trim().toLocaleLowerCase()))
  const builds = matchingBuilds
  const selected = selectedId ? ownRecordValue(localData.builds, selectedId) : undefined
  const requestedRevisionId = page.view === 'revision' || page.view === 'revision-edit' || page.view === 'record-current' ? page.revisionId : undefined
  const requestedRevision = requestedRevisionId ? ownRecordValue(localData.buildRevisions, requestedRevisionId) : undefined
  const pinnedRevision = requestedRevision?.buildId === selected?.id ? requestedRevision : undefined
  const editorBaseId = page.view === 'revision-edit' ? page.baseRevisionId ?? page.revisionId : undefined
  const requestedEditorBase = editorBaseId ? ownRecordValue(localData.buildRevisions, editorBaseId) : undefined
  const editorBaseRevision = requestedEditorBase?.buildId === selected?.id ? requestedEditorBase : undefined
  const selectedRevision = page.view === 'revision-edit' ? editorBaseRevision : pinnedRevision
  useEffect(() => {
    setCurrentConfirmed(false)
    setRecordingError(undefined)
    setRecordingCharacterId(undefined)
  }, [recordingCurrent, requestedRevisionId, selectedId])
  useEffect(() => { setReadinessScenarioId(undefined) }, [playthrough.activeScenarioId, selectedRevision?.id])
  const matchingScenarios = selectedRevision ? scenarios.filter((scenario) => Object.values(effectiveScenarioAssignments(scenario)).includes(selectedRevision.id)) : []
  const selectedScenario = readinessScenarioId ? matchingScenarios.find((scenario) => scenario.id === readinessScenarioId) : matchingScenarios.find((scenario) => scenario.id === playthrough.activeScenarioId) ?? matchingScenarios[0]
  const recordingCharacters = Object.values(playthrough.characters)
  const selectedCharacter = recordingCharacters.find(character => character.id === recordingCharacterId) ?? recordingCharacters.find(character => character.id === navigation.route.query.character?.[0]) ?? recordingCharacters[0]
  const selectedBuildRevisions = selected ? revisions.filter((revision) => revision.buildId === selected.id) : []
  const missingBuild = Boolean(selectedId && !selected)
  const missingRevision = Boolean(requestedRevisionId && !pinnedRevision)
  const missingEditorBase = page.view === 'revision-edit' && !editorBaseRevision
  const missingScenario = page.view === 'scenario' && !ownRecordValue(playthrough.scenarios, page.scenarioId)
  const leftComparedRevision = ownRecordValue(localData.buildRevisions, leftRevision)
  const rightComparedRevision = ownRecordValue(localData.buildRevisions, rightRevision)
  const missingCompareRevision = page.view === 'compare-pair' && (!leftComparedRevision || !rightComparedRevision)

  const differences = useMemo(() => {
    const left = ownRecordValue(localData.buildRevisions, leftRevision)
    const right = ownRecordValue(localData.buildRevisions, rightRevision)
    if (!left || !right) return []
    const names = new Map<string, string>()
    for (const definition of Object.values(localData.personalDefinitions)) names.set(entityDefinitionKey({ kind: 'personal', definitionId: definition.id }), `${definition.name} · personal definition`)
    for (const catalog of catalogs) for (const entity of Object.values(catalog.entities)) names.set(entityDefinitionKey({ kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entity.id }), `${entity.name} · ${catalog.id}`)
    const format = (value: unknown) => {
      if (typeof value === 'string') return names.get(value) ?? ownRecordValue(localData.gameSetups, value)?.label ?? value
      if (value && typeof value === 'object' && 'ref' in value && typeof value.ref === 'string') {
        const allocation = 'allocationId' in value && typeof value.allocationId === 'string' ? ' · shared physical copy' : ' · separate recorded copy'
        return `${names.get(value.ref) ?? value.ref}${allocation}`
      }
      return value == null ? 'None' : JSON.stringify(value)
    }
    const summarize = (revision: typeof left) => {
      const gameSetup = ownRecordValue(localData.gameSetups, revision.gameSetupRevisionId)
      let pp = 0
      let unresolvedPp = 0
      let owned = 0
      let unknownStock = 0
      let missing = 0
      const stockRequirements = new Map<string, { ref: EntityRef; allocations: Set<string> }>()
      const contributions: string[] = []
      const effects: string[] = []
      const definitionRefs = [revision.content.primaryClass, revision.content.secondaryClass, ...Object.values(revision.content.equipment).map((selection) => selection?.ref ?? null), ...revision.content.passives.map(selection => selection.ref)].filter((ref): ref is EntityRef => Boolean(ref))
      for (const ref of definitionRefs) {
        const definition = resolveEntity(localData, catalogs, ref)
        if (!definition) continue
        for (const [label, contribution] of Object.entries(definition.listedContributions ?? {})) {
          if (contribution.state === 'known') contributions.push(`${definition.name}: ${label} ${contribution.value.value} ${contribution.value.unit}${contribution.value.condition ? ` when ${contribution.value.condition}` : ''}`)
          else if (contribution.state === 'conflicting') contributions.push(`${definition.name}: ${label} conflicts`)
        }
        if (definition.grants?.state === 'known') effects.push(...definition.grants.value.map((grant) => `${definition.name}: ${grant}`))
        else if (definition.rawDescription) effects.push(`${definition.name}: ${definition.rawDescription}`)
      }
      for (const [slotId, selection] of Object.entries(revision.content.equipment)) {
        if (!selection) continue
        const slot = gameSetup?.slots.find((value) => value.id === slotId)
        if (slot) {
          const key = logicalEntityKey(localData, selection.ref)
          const requirement = stockRequirements.get(key) ?? { ref: selection.ref, allocations: new Set<string>() }
          requirement.allocations.add(selection.allocationId ?? `slot:${slotId}`)
          stockRequirements.set(key, requirement)
        }
      }
      for (const selection of revision.content.passives) {
        const definition = resolveEntity(localData, catalogs, selection.ref)
        if (definition?.ppCost?.state === 'known') pp += definition.ppCost.value
        else unresolvedPp += 1
      }
      for (const requirement of stockRequirements.values()) {
        const needed = requirement.allocations.size
        const inventory = Object.values(requirePlaythrough(localData).inventory).find((position) => sameLogicalEntity(localData, position.ref, requirement.ref))
        if (!inventory || inventory.possession === 'unknown' || inventory.quantity.kind === 'unknown') unknownStock += needed
        else if (inventory.possession === 'notOwned') missing += needed
        else {
          const available = inventory.quantity.value
          owned += Math.min(needed, available)
          if (available < needed) {
            if (inventory.quantity.kind === 'exact') missing += needed - available
            else unknownStock += needed - available
          }
        }
      }
      const matchingScenarios = Object.values(requirePlaythrough(localData).scenarios).filter((value) => Object.values(effectiveScenarioAssignments(value)).includes(revision.id)).sort((leftScenario, rightScenario) => leftScenario.label.localeCompare(rightScenario.label) || leftScenario.id.localeCompare(rightScenario.id))
      const scenario = matchingScenarios.find((value) => value.id === requirePlaythrough(localData).activeScenarioId) ?? matchingScenarios[0]
      const report = scenario ? validations[scenario.id] : undefined
      const statuses = report ? Object.values(report.dimensions).reduce((counts, value) => ({ ...counts, [value.status]: (counts[value.status] ?? 0) + 1 }), {} as Record<string, number>) : undefined
      const summarizeText = (values: readonly string[], empty: string) => values.length ? `${values.slice(0, 3).join(' · ')}${values.length > 3 ? ` · ${values.length - 3} more` : ''}` : empty
      const scenarioName = scenario ? `${scenario.label}${scenario.id === requirePlaythrough(localData).activeScenarioId ? ' (active)' : ''}` : undefined
      return { pp: `${pp} known PP${unresolvedPp ? ` + ${unresolvedPp} unresolved` : ''}`, stock: `${owned} confirmed · ${unknownStock} uncertain · ${missing} missing`, contributions: summarizeText(contributions, 'No documented numeric contributions'), effects: summarizeText(effects, 'No descriptions or documented effects'), validation: report ? `${scenarioName}: ${statuses?.invalid ?? 0} invalid · ${statuses?.undetermined ?? 0} undetermined` : scenarioName ? `${scenarioName}: validation unavailable` : 'Not assigned to a scenario' }
    }
    const leftSummary = summarize(left)
    const rightSummary = summarize(right)
    const summaryRows = [
      { label: 'Passive cost evidence', left: leftSummary.pp, right: rightSummary.pp },
      { label: 'Recorded stock', left: leftSummary.stock, right: rightSummary.stock },
      { label: 'Documented contributions', left: leftSummary.contributions, right: rightSummary.contributions },
      { label: 'Descriptions and documented effects', left: leftSummary.effects, right: rightSummary.effects },
      { label: 'Scenario readiness', left: leftSummary.validation, right: rightSummary.validation },
    ]
    const leftStats = calculateBuildStats(left.content, ownRecordValue(localData.gameSetups, left.gameSetupRevisionId)?.slots ?? [], ref => resolveCalculationEntity(localData, catalogs, ref, localData.gameSetups[left.gameSetupRevisionId]), ref => logicalEntityKey(localData, ref), resolveGameRules(localData.gameSetups[left.gameSetupRevisionId], catalogs))
    const rightStats = calculateBuildStats(right.content, ownRecordValue(localData.gameSetups, right.gameSetupRevisionId)?.slots ?? [], ref => resolveCalculationEntity(localData, catalogs, ref, localData.gameSetups[right.gameSetupRevisionId]), ref => logicalEntityKey(localData, ref), resolveGameRules(localData.gameSetups[right.gameSetupRevisionId], catalogs))
    const statRows = left.content.calculation || right.content.calculation ? CALCULATED_STATS.map(stat => ({ label: `${STAT_LABELS[stat]} (native resting total)`, left: formatStatRange(leftStats.stats[stat].value), right: formatStatRange(rightStats.stats[stat].value) })) : []
    const calculationLabel = (revision: BuildRevision) => {
      const plan = revision.content.calculation
      if (!plan) return 'No calculation inputs'
      return [`PC 1.6.9.0 (${plan.pcMode ?? 'standard'}${plan.gender ? '' : '; no gender bonus preview'})`, `Gender: ${plan.gender ? CALCULATION_GENDER_LABELS[plan.gender] : 'not specified'}`, `Level ${plan.level ?? 'unknown'}`, `Growth: ${plan.growth.map(row => `${entityName(localData, catalogs, row.classRef, 'Unknown class')} ${row.levels ?? '?'}`).join(', ') || 'unallocated'}`, `Bonuses: ${plan.bonuses.join(', ') || 'none'}`, `Statuses: ${plan.statuses.map(ref => entityName(localData, catalogs, ref)).join(', ') || 'none'}`, ...(plan.ability ? [`Ability: ${entityName(localData, catalogs, plan.ability)}`] : []), ...(plan.targetEvasion != null ? [`Target evasion: ${plan.targetEvasion}`] : [])].join(' · ')
    }
    const scopeRows = statRows.length ? [{ label: 'Estimate exclusions', left: leftStats.excluded.join('; ') || 'None found in supplied fields', right: rightStats.excluded.join('; ') || 'None found in supplied fields' }, { label: 'Calculation notes', left: leftStats.issues.join('; '), right: rightStats.issues.join('; ') }] : []
    return [...summaryRows, ...statRows, ...scopeRows, ...compareBuildRevisions(left, right).differences.map((difference) => ({ label: difference.path.startsWith('content.equipment.') ? ownRecordValue(localData.gameSetups, left.gameSetupRevisionId)?.slots.find((entry) => entry.id === difference.path.replace('content.equipment.', ''))?.label ?? difference.label : difference.label, left: difference.path === 'content.calculation' ? calculationLabel(left) : format(difference.left), right: difference.path === 'content.calculation' ? calculationLabel(right) : format(difference.right) }))]
  }, [catalogs, leftRevision, localData, rightRevision, validations])
  const createScenario = async (draft: ScenarioDraft) => { await onCreateScenario(draft); if (scenarioRevision) navigate({ page: 'builds', view: 'revision-edit', buildId: scenarioRevision.buildId, revisionId: scenarioRevision.id }); else navigation.close() }
  const changeCompareRevision = (side: 'left' | 'right', value: string) => {
    const next = { left: side === 'left' ? value : leftRevision, right: side === 'right' ? value : rightRevision }
    setCompareDraft(next)
    if (next.left && next.right) navigate({ page: 'builds', view: 'compare-pair', leftRevisionId: next.left as BuildRevisionId, rightRevisionId: next.right as BuildRevisionId })
    else if (page.view === 'compare-pair') navigate({ page: 'builds', view: 'compare' })
  }
  const savedRevisionRoute = (revisionId: BuildRevisionId) => {
    if (!selected) return
    navigation.navigate({ ...navigation.route, page: { page: 'builds', view: 'revision-edit', buildId: selected.id, revisionId }, overlays: [] }, { replace: true })
  }
  const cloneSelected = async () => {
    if (!selected?.latestRevisionId) return
    setCloneBusy(true)
    setCloneError(undefined)
    try {
      const clonedId = await onCloneBuild(selected.id)
      navigate({ page: 'builds', view: 'build', buildId: clonedId as BuildId })
    } catch (reason) {
      setCloneError(reason instanceof Error ? reason.message : 'The build could not be cloned.')
    } finally {
      setCloneBusy(false)
    }
  }
  const updateBuildQuery = (value: string) => navigation.navigate({ ...navigation.route, query: { ...navigation.route.query, q: value ? [value] : [] } }, { replace: true })
  const chooseEditorBase = (revisionId: string) => {
    if (!selected) return
    navigate({ page: 'builds', view: 'revision-edit', buildId: selected.id, revisionId: revisionId as BuildRevisionId })
  }

  const buildCard = (build: Build) => <BuildCard build={build} catalogs={catalogs} key={build.id} onSelect={() => selectBuild(build.id)} onSlotSelect={slotId => selectBuild(build.id, `slot:${slotId}`)} localData={localData} selected={selected?.id === build.id} showShare={page.view === 'library'} shareBlocked={editorDirty || shareBlocked}/>
  const groupedBuildCards = <div className="build-library-grid">{builds.map(buildCard)}</div>

  return <div className="build-planner">
    <ScreenHeader
      title={section === 'teams' ? 'Party plans' : section === 'compare' ? 'Compare revisions' : addingBuild ? 'New Build' : selected?.title ?? 'Builds'}
      eyebrow={section === 'teams' ? 'Tracking' : 'Buildcrafting'}
      description={section === 'teams' ? 'Check how tracked characters can use builds together, including shared equipment and learning.' : 'Explore classes, equipment, and passives. No character or inventory tracking required.'}
      breadcrumb={section !== 'teams' && page.view !== 'library' ? <Button aria-label="Back to Build library" icon="arrow-left" onClick={() => { const back = () => navigate({ page: 'builds', view: 'library' }); if (editorDirty) guardDraft('Save or discard the build edits before returning to the library.', back); else back() }} tone="quiet" type="button">Builds</Button> : undefined}
      context={section === 'library' && selectedBuildRevisions.length > 0 ? <label className="workspace-checkpoint"><span className="sr-only">Editor checkpoint</span><select disabled={editorDirty} onChange={event => chooseEditorBase(event.target.value)} title={editorBaseRevision?.id !== selected?.latestRevisionId ? 'Saving creates a new latest revision using this older checkpoint as the content base.' : 'Inspect or edit the latest pinned checkpoint.'} value={editorBaseRevision?.id ?? selectedRevision?.id ?? ''}>{selectedBuildRevisions.map(revision => <option key={revision.id} value={revision.id}>r{revision.revision}{checkpointSuffix(revision)} · {formatRelativeDate(revision.createdAt)}</option>)}</select></label> : undefined}
      actions={section === 'teams' ? <Button icon="plus" onClick={() => navigate({ page: 'builds', view: 'scenario-new' })}>New party plan</Button> : selected && section === 'library' ? <>
        {selectedRevision && <ShareButton disabled={editorDirty || shareBlocked} localData={localData} target={{ kind: 'build', revisionId: selectedRevision.id }}/>}
        <BuildDetailsControl build={selected} compact key={selected.id} onDirtyChange={updateDetailsDirty} onSave={onSaveDetails} suggestions={tagSuggestions}>
          {selected.latestRevisionId && <Button disabled={editorDirty || cloneBusy} icon="layers" onClick={() => void cloneSelected()} tone="secondary" type="button">{cloneBusy ? 'Cloning...' : 'Clone Build'}</Button>}
          <Button onClick={() => navigation.navigate({ page: { page: 'settings', section: 'game-setup' }, overlays: [], query: {} })} tone="secondary" type="button">Game Setups</Button>
          <Button icon="plus" onClick={() => navigate({ page: 'builds', view: 'build-new' })} tone="secondary" type="button">New Build</Button>
        </BuildDetailsControl>
      </> : !addingBuild ? <><Button onClick={() => navigation.navigate({ page: { page: 'settings', section: 'game-setup' }, overlays: [], query: {} })} tone="secondary">Game Setups</Button><Button icon="plus" onClick={() => navigate({ page: 'builds', view: 'build-new' })}>New Build</Button></> : undefined}
    />
    <div className="toolbar"><Segmented label="Build planner" onChange={changeSection} options={[{ value: 'library', label: 'Build library' }, { value: 'compare', label: 'Compare revisions' }]} value={section}/>{section === 'library' && !addingBuild && allBuilds.length > 0 && <div className="search-field"><Icon name="search"/><input aria-label="Search Build library" onChange={(event) => updateBuildQuery(event.target.value)} placeholder="Search titles, tags, and Game Setups" type="search" value={buildQuery}/></div>}</div>{draftGuard && <div className="external-update"><InlineNotice title="Build edits are still open" tone="warning">{draftGuard}</InlineNotice><div className="cluster"><Button disabled={resolvingDraft} onClick={() => void resolveDraft('discard')} tone="quiet">Discard and continue</Button><Button disabled={resolvingDraft} icon="check" onClick={() => void resolveDraft('save')}>{resolvingDraft ? 'Saving...' : 'Save and continue'}</Button></div></div>}{cloneError && <InlineNotice title="Build not cloned" tone="danger">{cloneError} The original Build and checkpoint remain unchanged.</InlineNotice>}
    {missingBuild && <InlineNotice title="Build unavailable" tone="warning">The requested Build is not available in the planner data. <Button onClick={() => navigate({ page: 'builds', view: 'library' })} tone="quiet">Return to Build library</Button></InlineNotice>}
    {missingRevision && <InlineNotice title="Build checkpoint unavailable" tone="warning">The requested checkpoint is missing or belongs to another build. No other checkpoint was substituted. <Button onClick={() => navigate({ page: 'builds', view: 'library' })} tone="quiet">Return to build library</Button></InlineNotice>}
    {!missingRevision && missingEditorBase && <InlineNotice title="Checkpoint base unavailable" tone="warning">The requested editor base is missing or belongs to another build. Choose an available checkpoint from the build library; no latest revision was substituted. <Button onClick={() => navigate({ page: 'builds', view: 'library' })} tone="quiet">Return to build library</Button></InlineNotice>}
    {section === 'library' && addingBuild ? <AddBuildForm catalogs={catalogs} tagSuggestions={tagSuggestions} onCancel={() => { updateEditorDirty(false); navigation.close() }} onDirtyChange={updateEditorDirty} onSaved={(buildId, revisionId) => navigate({ page: 'builds', view: 'revision-edit', buildId, revisionId }, true)} onSubmit={onCreateBuild} localData={localData}/> : section === 'library' && (builds.length === 0 && !selected ? <EmptyState description="Start with a blank Build. Choose classes, equipment, and passives from the reference catalog. Assign it to a character in a team when you want readiness checks." icon="sword" title={allBuilds.length ? 'No Builds match this search' : 'Plan your next Build'}>{allBuilds.length ? <Button onClick={() => updateBuildQuery('')} tone="secondary">Clear search</Button> : <Button icon="plus" onClick={() => navigate({ page: 'builds', view: 'build-new' })}>Create a Build</Button>}</EmptyState> : page.view === 'library' ? <section aria-label="Build library" className="build-library-groups">{groupedBuildCards}</section> : <div className="build-layout">
      <details className="build-column build-library" open={libraryOpen} onToggle={(event) => setLibraryOpen(event.currentTarget.open)}><summary>Library{selected ? `: ${selected.title}` : ''}</summary><header className="build-column__header"><div className="split"><div><h2>Library</h2><p>{builds.length} matching {builds.length === 1 ? 'Build' : 'Builds'}</p></div><IconButton icon="plus" label="Create Build" onClick={() => navigate({ page: 'builds', view: 'build-new' })}/></div></header><div className="build-column__body build-library-groups">{groupedBuildCards}</div></details>
      <section className="build-column"><div className="build-column__body">{selected && editingRoute && !missingRevision && !missingEditorBase && <RevisionEditor build={selected} catalogs={catalogs} key={`${selected.id}:${page.view}:${editorBaseRevision?.id ?? 'new'}`} onDirtyChange={updateEditorDirty} onSaved={savedRevisionRoute} onSubmit={(draft) => onSaveRevision(selected.id, draft, editorBaseRevision?.id)} localData={localData} sourceRevision={editorBaseRevision}/>}</div></section>
      <details className="build-column build-readiness"><summary>Use with Tracking</summary><header className="build-column__header"><h2>Tracking and readiness</h2><p>Check a saved Build against a character's learning, unlocks, inventory, and party conflicts.</p><p>{selectedScenario ? `Evaluated in ${selectedScenario.label}` : 'Assign this revision to a party plan'}</p></header><div className="build-column__body">{section === 'library' && selected && selectedRevision && <Button disabled={editorDirty} icon="check" onClick={() => { setRecordingError(undefined); navigate({ page: 'builds', view: 'record-current', buildId: selected.id, revisionId: selectedRevision.id }) }} tone="secondary">Compare / record on a character</Button>}{selected && selectedRevision && <BuildReadinessAssignment build={selected} disabled={editorDirty} onAssign={onAssign} onScenarioChange={setReadinessScenarioId} localData={localData} revision={selectedRevision} scenarioId={readinessScenarioId ?? selectedScenario?.id}/>}<ValidationPanel catalogs={catalogs} localData={localData} report={selectedScenario ? validations[selectedScenario.id] : undefined} scenario={selectedScenario}/>{selectedRevision && <div className="settings-section"><h3>Pinned checkpoint</h3><dl className="definition-list">{selectedRevision.note?.trim() && <div className="definition-row"><dt>Name</dt><dd>{selectedRevision.note}</dd></div>}<div className="definition-row"><dt>Revision</dt><dd>{selectedRevision.revision}</dd></div><div className="definition-row"><dt>Saved</dt><dd>{formatRelativeDate(selectedRevision.createdAt)}</dd></div><div className="definition-row"><dt>Game Setup</dt><dd>{ownRecordValue(localData.gameSetups, selectedRevision.gameSetupRevisionId)?.label ?? 'Unresolved'}</dd></div></dl></div>}</div></details>
    </div>)}
    {section === 'teams' && <>{missingScenario && <InlineNotice title="Party plan unavailable" tone="warning">The requested party plan is not available in this Playthrough. No other party plan was selected. <Button onClick={() => navigate({ page: 'builds', view: 'teams' })} tone="quiet">Show party plans</Button></InlineNotice>}{scenarios.length === 0 ? <EmptyState aside={<>A party plan checks simultaneous inventory use. Alternative plans may each use the same recorded copy.</>} description="Choose four tracked characters, then assign builds to check their readiness together." icon="team" title="No party plans"><Button icon="plus" onClick={() => navigate({ page: 'builds', view: 'scenario-new' })}>Create a party plan</Button></EmptyState> : <div className="stack">{scenarios.map((scenario) => <ScenarioCard catalogs={catalogs} shareBlocked={shareBlocked} key={scenario.id} onAssign={onAssign} localData={localData} scenario={scenario} validation={validations[scenario.id]}/>)}</div>}</>}
    {section === 'compare' && <div className="stack"><div className="panel"><div className="panel__body grid-2"><Field label="Revision A"><select onChange={(event) => changeCompareRevision('left', event.target.value)} value={leftRevision}><option value="">Choose revision</option>{revisions.map((revision) => <option key={revision.id} value={revision.id}>{revisionOptionLabel(localData, revision)}</option>)}</select></Field><Field label="Revision B"><select onChange={(event) => changeCompareRevision('right', event.target.value)} value={rightRevision}><option value="">Choose revision</option>{revisions.map((revision) => <option key={revision.id} value={revision.id}>{revisionOptionLabel(localData, revision)}</option>)}</select></Field></div></div>{missingCompareRevision ? <InlineNotice title="Comparison checkpoint unavailable" tone="warning">One or both requested checkpoints are not available in the Build library. Choose two available checkpoints to create a new comparison address.</InlineNotice> : leftComparedRevision && rightComparedRevision ? <>
      <div className="comparison-grid comparison-grid--loadouts">
        {[leftComparedRevision, rightComparedRevision].map((revision) => <section aria-label={`${ownRecordValue(localData.builds, revision.buildId)?.title ?? 'Unresolved build'} loadout`} className="comparison-column" key={revision.id}><h2>{ownRecordValue(localData.builds, revision.buildId)?.title}</h2><BuildLoadoutSummary catalogs={catalogs} content={revision.content} onEquipmentSelect={slotId => navigate({ page: 'builds', view: 'revision-edit', buildId: revision.buildId, revisionId: revision.id }, false, fieldFocusQuery(`slot:${slotId}`))} localData={localData} gameSetup={ownRecordValue(localData.gameSetups, revision.gameSetupRevisionId)}/></section>)}
      </div>
      <details className="comparison-evidence"><summary>Evidence and differences</summary><div className="comparison-grid"><section className="comparison-column"><h3>{ownRecordValue(localData.builds, leftComparedRevision.buildId)?.title}</h3>{differences.map((row) => <div className="comparison-row" key={row.label}><small>{row.label}</small><strong><MoneyText>{row.left}</MoneyText></strong></div>)}</section><section className="comparison-column"><h3>{ownRecordValue(localData.builds, rightComparedRevision.buildId)?.title}</h3>{differences.map((row) => <div className="comparison-row" key={row.label}><small>{row.label}</small><strong><MoneyText>{row.right}</MoneyText></strong></div>)}</section></div></details>
    </> : <EmptyState description="Choose two immutable build revisions. The comparison explains changed selections without producing an opaque score." icon="compare" title="Select revisions to compare"/>}</div>}
    <Sheet onClose={() => navigation.close()} open={addingScenario} title="Create party plan"><>{scenarioRevisionId && !scenarioRevision ? <InlineNotice title="Build revision unavailable" tone="warning">The requested revision is missing. No other Game Setup was substituted.</InlineNotice> : <><p className="field__hint">{scenarioRevision ? `Uses saved r${scenarioRevision.revision}: ${ownRecordValue(localData.gameSetups, scenarioRevision.gameSetupRevisionId)?.label ?? 'Unresolved Game Setup'}` : 'Uses the current Game Setup'}</p><AddScenarioForm onCancel={() => navigation.close()} onSubmit={createScenario} localData={localData} revision={scenarioRevision}/></>}</></Sheet>

    <Sheet description="Compare a saved build with a tracked character. Recording creates a new snapshot after you confirm the in-game change." onClose={() => { setCurrentConfirmed(false); navigation.close() }} open={recordingCurrent && !missingRevision} title="Compare and record Build"><div className="stack">
      {recordingCharacters.length ? <Field label="Character"><select onChange={event => { setRecordingCharacterId(event.target.value); setCurrentConfirmed(false) }} value={selectedCharacter?.id ?? ''}>{recordingCharacters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}</select></Field> : <InlineNotice title="No tracked characters">Add a character under Tracking when you want to record an in-game loadout.<Button onClick={() => navigation.navigate({ page: { page: 'characters', view: 'new' }, overlays: [], query: {} })}>Add a tracked character</Button></InlineNotice>}
      {selectedCharacter && selectedRevision && <BuildCharacterComparison revision={selectedRevision} character={selectedCharacter} localData={localData} catalogs={catalogs}/>}
      <p>Recording preserves the character's history and known level. Displayed stats need recapture. Inventory and learning stay as recorded.</p>
      {recordingError && <InlineNotice title="Current Build not recorded" tone="danger">{recordingError} Your previous snapshot was preserved.</InlineNotice>}
      <label className="check-row"><input checked={currentConfirmed} disabled={!selectedCharacter} onChange={event => setCurrentConfirmed(event.target.checked)} type="checkbox"/><span>I made these changes in game</span></label>
      <div className="form-actions"><Button onClick={() => navigation.close()} tone="quiet">Close comparison</Button><Button disabled={!currentConfirmed || recordingBusy || !selectedCharacter} icon="check" onClick={() => { if (!selected || !selectedRevision || !selectedCharacter) return; setRecordingBusy(true); void onRecordCurrent(selected.id, selectedRevision.id, selectedCharacter.id).then(() => { setCurrentConfirmed(false); navigation.close() }).catch((reason: unknown) => setRecordingError(formatAppError(reason, 'The current Build could not be recorded.'))).finally(() => setRecordingBusy(false)) }}>{recordingBusy ? 'Recording...' : 'Record as current'}</Button></div>
    </div></Sheet>
  </div>
}
