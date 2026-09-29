import { DefinitionArtwork } from './GameIcon'
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { compareBuildRevisions, createId, effectiveScenarioAssignments, entityDefinitionKey, logicalEntityKey, sameLogicalEntity, scenarioMemberIds, TEAM_SIZE, validateBuildContent } from '../domain'
import type { Build, BuildId, BuildKind, BuildRevision, BuildRevisionId, BuildRevisionContent, BuildSelection, BuildState, CatalogEntityKind, CatalogSnapshot, EntityRef, Profile, RulesetRevision, ScenarioKind, TeamScenario, ValidationReport } from '../domain/types'
import { Badge, Button, EmptyState, Field, IconButton, InlineNotice, ScreenHeader, Segmented } from './components'
import { Icon } from './icons'
import { activeRuleset, catalogLocksMatch, entityName, formatRelativeDate, ownRecordValue, resolveEntity } from './model'
import { Sheet } from './Sheet'
import { findDefinitionOption, useDefinitionWorkspace, type DefinitionOption } from './definitions'
import { BuildReadinessAssignment, ValidationPanel } from './BuildReadiness'
import { BuildMechanics, formatStatRange } from './BuildMechanics'
import { BuildValidity } from './BuildValidity'
import { calculateBuildStats, CALCULATED_STATS, STAT_LABELS } from '../domain/build-stats'
import { BuildSelectionDetails } from './BuildSelectionDetails'
import { BuildDefinitionField, BUILD_DEFINITION_PAGE_SIZE } from './BuildDefinitionField'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { isReferenceResearchRoute, parentRoute, routeWithOverlay, useNavigation, useNavigationBlocker, type AppRoute, type BuildsPageRoute } from './navigation'
import type { DraftActions, DraftChangeHandler } from './drafts'
import { DefinitionModLabel } from './DefinitionModLabel'

export interface BuildDraft { readonly id: BuildId; readonly revisionId: BuildRevisionId; readonly title: string; readonly kind: BuildKind; readonly characterId?: string; readonly state: BuildState; readonly tags: readonly string[] }
export interface RevisionDraft extends BuildRevisionContent { readonly note?: string }
export interface ScenarioDraft { readonly label: string; readonly kind: Exclude<ScenarioKind, 'recordedCurrent'>; readonly memberIds: readonly string[]; readonly baseline: 'empty' | 'recordedParty'; readonly enforceStock: boolean; readonly includeProtected: boolean; readonly buildRevisionId?: BuildRevisionId }

type BuildsSection = 'library' | 'teams' | 'compare'

function AddBuildForm({ profile, catalogs, onCancel, onSubmit, onSaved, onDirtyChange }: { profile: Profile; catalogs: readonly CatalogSnapshot[]; onCancel: () => void; onSubmit: (draft: BuildDraft, revision: RevisionDraft) => Promise<{ buildId: BuildId; revisionId: BuildRevisionId }>; onSaved: (buildId: BuildId, revisionId: BuildRevisionId) => void; onDirtyChange: DraftChangeHandler }) {
  const [id] = useState(() => createId<BuildId>('build'))
  const [revisionId] = useState(() => createId<BuildRevisionId>('buildRevision'))
  const [title, setTitle] = useState('')
  const [characterId, setCharacterId] = useState('')
  const createdRef = useRef<BuildId>(undefined)
  return <section className="build-column build-sheet-panel"><header className="build-column__header"><h2>New build</h2><p>Start with any slot. Ownership and learning can be checked later.</p></header><div className="build-column__body"><RevisionEditor catalogs={catalogs} locked={Boolean(profile.buildRevisions[revisionId])} onCancel={onCancel} onDirtyChange={onDirtyChange} onSaved={(revisionId) => { if (createdRef.current) onSaved(createdRef.current, revisionId) }} onSubmit={async (revision) => {
    const automaticTitle = revision.primaryClass ? `${entityName(profile, catalogs, revision.primaryClass)} build` : 'Untitled build'
    const created = await onSubmit({ id, revisionId, title: title.trim() || automaticTitle, kind: characterId ? 'character' : 'template', characterId: characterId || undefined, state: 'draft', tags: [] }, revision)
    createdRef.current = created.buildId
    return created.revisionId
  }} profile={profile}>
    <div className="grid-2"><Field label="Build title" hint="Optional. Otherwise named after the selected class."><input onChange={(event) => setTitle(event.target.value)} placeholder="Name this build" value={title}/></Field><Field label="Character" hint="Optional. An unassigned build can be used by anyone."><select aria-label="Character" onChange={(event) => setCharacterId(event.target.value)} value={characterId}><option value="">Anyone / reusable build</option>{Object.values(profile.characters).map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}</select></Field></div>
  </RevisionEditor></div></section>
}

interface PickerTarget { readonly fieldKey: string; readonly key: string; readonly target: 'primaryClass' | 'secondaryClass' | 'equipment' | 'passive'; readonly label: string; readonly kinds: readonly CatalogEntityKind[] }

function checkpointSuffix(revision: BuildRevision) {
  const name = revision.note?.trim()
  return name ? ` · ${name}` : ''
}

function revisionOptionLabel(profile: Profile, revision: BuildRevision) {
  return `${ownRecordValue(profile.builds, revision.buildId)?.title ?? 'Unresolved build'} · r${revision.revision}${checkpointSuffix(revision)}`
}

function BuildCardSelection({ label, value, profile, catalogs, ruleset, empty, compact = false }: { label: string; value?: EntityRef | null; profile: Profile; catalogs: readonly CatalogSnapshot[]; ruleset?: RulesetRevision; empty: string; compact?: boolean }) {
  return <span className="build-card__selection" data-compact={compact || undefined} data-empty={!value || undefined} title={`${label}: ${value ? entityName(profile, catalogs, value) : empty}`}>
    {value ? <DefinitionArtwork catalogs={catalogs} profile={profile} value={value}/> : <span aria-hidden="true" className="build-card__selection-placeholder">?</span>}
    <span><small className={compact ? 'sr-only' : undefined}>{label}</small><span className="build-card__selection-name">{value ? entityName(profile, catalogs, value) : empty}</span><DefinitionModLabel profile={profile} ruleset={ruleset} value={value}/></span>
  </span>
}

function BuildCard({ build, selected, onSelect, profile, catalogs }: { build: Build; selected: boolean; onSelect: () => void; profile: Profile; catalogs: readonly CatalogSnapshot[] }) {
  const revision = build.latestRevisionId ? ownRecordValue(profile.buildRevisions, build.latestRevisionId) : undefined
  const pinnedRevision = revision?.buildId === build.id ? revision : undefined
  const ruleset = pinnedRevision ? ownRecordValue(profile.rulesets, pinnedRevision.rulesetRevisionId) : undefined
  const slots = [...(ruleset?.slots ?? [])].sort((left, right) => left.order - right.order)
  const selectedSlots = slots.flatMap(slot => {
    const selection = pinnedRevision?.content.equipment[slot.id]
    return selection ? [{ slot, selection }] : []
  })
  const equipment = selectedSlots
  const passives = pinnedRevision?.content.passives ?? []
  const character = build.characterId ? ownRecordValue(profile.characters, build.characterId) : undefined
  const stateLabel = build.state === 'recordedCurrent' ? 'Current' : build.state === 'hypothetical' ? 'Hypothetical' : 'Draft'
  const stateTone = build.state === 'recordedCurrent' ? 'positive' : build.state === 'hypothetical' ? 'warning' : 'info'
  return <button aria-current={selected ? 'true' : undefined} className="build-card" onClick={onSelect} type="button">
    <span className="build-card__header"><strong>{build.title}</strong><Badge tone={stateTone}>{stateLabel}</Badge></span>
    <small className="build-card__meta">{build.characterId ? character?.name ?? 'Unresolved character' : 'Reusable template'} · {pinnedRevision ? `revision ${pinnedRevision.revision}` : build.latestRevisionId ? 'checkpoint unavailable' : 'no revision'}</small>
    {pinnedRevision ? <>
      <span className="build-card__classes">
        <BuildCardSelection catalogs={catalogs} empty="No class selected" label="Class" profile={profile} ruleset={ruleset} value={pinnedRevision.content.primaryClass}/>
        <BuildCardSelection catalogs={catalogs} empty="No sub-command" label="Sub-command" profile={profile} ruleset={ruleset} value={pinnedRevision.content.secondaryClass}/>
      </span>
      <span className="build-card__summary-group">
        <span className="build-card__summary-label"><Icon name="sword"/>Equipment</span>
        {equipment.length ? <span className="build-card__selections">{equipment.map(({ slot, selection }) => <BuildCardSelection catalogs={catalogs} compact empty="Empty" key={slot.id} label={slot.label} profile={profile} ruleset={ruleset} value={selection.ref}/>)}</span> : <small>No equipment selected</small>}
      </span>
      <span className="build-card__summary-group">
        <span className="build-card__summary-label"><Icon name="crystal"/>Passives</span>
        {passives.length ? <span className="build-card__selections">{passives.map((selection, index) => <BuildCardSelection catalogs={catalogs} compact empty="Empty" key={`${entityDefinitionKey(selection.ref)}:${index}`} label={`Equipped passive ${index + 1}`} profile={profile} ruleset={ruleset} value={selection.ref}/>)}</span> : <small>No passives selected</small>}
      </span>
    </> : <span className="build-card__unavailable"><Icon name={build.latestRevisionId ? 'warning' : 'layers'}/>{build.latestRevisionId ? 'Saved checkpoint unavailable' : 'Save a checkpoint to summarize this build'}</span>}
    {build.tags.length > 0 && <span className="cluster">{build.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}</span>}
  </button>
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

function RevisionEditor({ build, sourceRevision, profile, catalogs, onCancel, onSubmit, onSaved, onDirtyChange, children, locked = false }: { build?: Build; children?: ReactNode; locked?: boolean; sourceRevision?: BuildRevision; profile: Profile; catalogs: readonly CatalogSnapshot[]; onCancel?: () => void; onSubmit: (draft: RevisionDraft) => Promise<BuildRevisionId>; onSaved: (revisionId: BuildRevisionId) => void; onDirtyChange: DraftChangeHandler }) {
  const navigation = useNavigation()
  const { options, planningOptions } = useDefinitionWorkspace()
  const latest = sourceRevision ?? (build?.latestRevisionId ? ownRecordValue(profile.buildRevisions, build.latestRevisionId) : undefined)
  const ruleset = profile.activeRulesetRevisionId ? activeRuleset(profile) : latest ? ownRecordValue(profile.rulesets, latest.rulesetRevisionId) : undefined
  const initialDraft = (): RevisionDraft => ({ primaryClass: latest?.content.primaryClass ?? null, secondaryClass: latest?.content.secondaryClass ?? null, equipment: { ...(latest?.content.equipment ?? {}) }, passives: [...(latest?.content.passives ?? [])], rotationNotes: latest?.content.rotationNotes, contextAssumptions: latest?.content.contextAssumptions ?? [], calculation: latest?.content.calculation, note: undefined })
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
  const pickerMemoryRef = useRef<Record<string, { readonly query: string; readonly resultLimit: number }>>({})
  const slots = useMemo(() => [...(ruleset?.slots.length ? ruleset.slots : SUGGESTED_BUILD_SLOTS)].sort((a, b) => a.order - b.order), [ruleset])
  const definitionIndex = useMemo(() => new Map(options.map(option => [entityDefinitionKey(option.ref), option.record])), [options])
  const validity = useMemo(() => validateBuildContent(draft, ruleset, slots, ref => definitionIndex.get(entityDefinitionKey(ref)), ref => logicalEntityKey(profile, ref)), [definitionIndex, draft, profile, ruleset, slots])
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
      if (!peer || !sameLogicalEntity(profile, peer.ref, current.ref)) return value
      const allocationId = peer.allocationId ?? JSON.stringify(['shared-copy', ...[slotId, peerSlotId].sort()])
      equipment[slotId] = { ...current, allocationId }
      equipment[peerSlotId] = { ...peer, allocationId }
      return { ...value, equipment }
    })
    updateDirty(true)
  }
  const save = async () => { setBusy(true); setError(undefined); try { const revisionId = await onSubmit({ ...draftRef.current, contextAssumptions: assumptionsRef.current.split('\n').map((value) => value.trim()).filter(Boolean) }); updateDirty(false); onSaved(revisionId); return true } catch (reason) { setError(reason instanceof Error ? reason.message : 'The build revision could not be saved.'); return false } finally { setBusy(false) } }
  const submit = (event: FormEvent) => { event.preventDefault(); void save() }
  const discard = () => { const value = initialDraft(); setDraft(value); setAssumptions(value.contextAssumptions.join('\n')); setError(undefined); updateDirty(false); onCancel?.() }
  actionsRef.current = { save, discard }
  const dismissPicker = () => { const parent = parentRoute(navigation.route); if (parent) navigation.navigate(parent, { replace: true }) }
  const field = (target: PickerTarget, value: EntityRef | null) => <BuildDefinitionField allowedKinds={target.kinds} includeInnates={includeInnates} label={target.label} onChange={(ref) => {
    if (target.target === 'primaryClass') setDraft((current) => ({ ...current, primaryClass: ref }))
    else if (target.target === 'secondaryClass') setDraft((current) => ({ ...current, secondaryClass: ref }))
    else if (target.target === 'passive') setDraft((current) => {
      const passives = [...current.passives]
      const index = Number(target.key)
      if (ref) passives[index] = { ref, observedName: entityName(profile, catalogs, ref) }
      else if (index < passives.length) passives.splice(index, 1)
      return { ...current, passives }
    })
    else setDraft((current) => ({ ...current, equipment: { ...detachAllocation(current.equipment, target.key, equipmentSlotIds), [target.key]: ref ? { ref, observedName: entityName(profile, catalogs, ref) } : null } }))
    updateDirty(true)
  }} onClose={closePicker} onDismiss={dismissPicker} onInspect={(option) => { setInspected(option); setComparedWith(findDefinitionOption(planningOptions, value)) }} onOpen={() => openPicker(target)} onQueryChange={(nextQuery) => updatePickerQuery(target, nextQuery)} onResultLimitChange={(limit) => updatePickerQuery(target, query, limit)} resultLimit={candidateLimit} open={picker?.fieldKey === target.fieldKey} query={picker?.fieldKey === target.fieldKey ? query : ''} value={value}/>
  const slotField = (slot: typeof slots[number]) => {
    const selected = draft.equipment[slot.id]
    const peers = selected ? equipmentSlots.filter((candidate) => candidate.id !== slot.id && draft.equipment[candidate.id] && sameLogicalEntity(profile, draft.equipment[candidate.id]!.ref, selected.ref)) : []
    const groupedPeer = selected?.allocationId ? peers.find((candidate) => draft.equipment[candidate.id]?.allocationId === selected.allocationId) : undefined
    return <div className="slot-entry" key={slot.id}>{field(targetForFieldKey(`slot:${slot.id}`)!, selected?.ref ?? null)}{peers.length > 0 && <Field className="slot-allocation" hint="Group slots only when one physical item occupies both." label="Same copy as"><select aria-label={`${slot.label}: Same copy as`} onChange={(event) => groupSelection(slot.id, event.target.value)} value={groupedPeer?.id ?? ''}><option value="">Separate recorded copy</option>{peers.map((peer) => <option key={peer.id} value={peer.id}>{peer.label}</option>)}</select></Field>}</div>
  }
  const passiveField = (selection: BuildSelection | undefined, index: number) => {
    const target = targetForFieldKey(`slot:passive-${index + 1}`)!
    return <div className="slot-entry" key={`${index}:${selection ? entityDefinitionKey(selection.ref) : 'add'}`}>{field(target, selection?.ref ?? null)}</div>
  }
  return <form className="stack build-sheet" onInput={(event) => { const target = event.target as HTMLElement; if (target.getAttribute('role') !== 'combobox' && !target.hasAttribute('data-draft-exempt')) updateDirty(true) }} onSubmit={submit}>
    {locked && <InlineNotice title="Build retained for saving">Use Retry save if needed, then Save build to open the saved sheet.</InlineNotice>}
    <fieldset className="build-sheet__fields" disabled={busy || locked}><div className="build-sheet__layout">
      <div className="build-sheet__slots">
        <section className="build-sheet__group" aria-label="Class and command"><h3><Icon name="crystal"/>Class & command</h3>{field(targetForFieldKey('primary-class')!, draft.primaryClass)}{field(targetForFieldKey('secondary-class')!, draft.secondaryClass)}</section>
        <section className="build-sheet__group" aria-label="Equipment"><h3><Icon name="sword"/>Equipment</h3>{equipmentSlots.map(slotField)}</section>
        <section className="build-sheet__group" aria-label="Passives"><h3><Icon name="spark"/>Equipped passives</h3><p className="settings-section__intro">Spend one shared PP budget across any number of passives.</p><label className="build-innate-toggle"><input checked={includeInnates} data-draft-exempt="true" onChange={(event) => setIncludeInnates(event.target.checked)} type="checkbox"/><span><strong>Include innates from the Learnable Innate Skill mod</strong><small>Enabled for every passive search. Some innate PP costs are not yet in the catalog.</small></span></label><div className="build-sheet__passives">{[...draft.passives, undefined].map(passiveField)}</div></section>
      </div>
      <aside className="build-sheet__preview" aria-label="Selection details" data-empty={!inspected}>{inspected ? <><span className="eyebrow">Selection details</span><h3 className="icon-label"><DefinitionArtwork catalogs={catalogs} profile={profile} value={inspected.ref}/>{inspected.name}</h3><BuildSelectionDetails comparedWith={comparedWith} option={inspected}/></> : <><Icon name="character"/><h3>Your next build</h3><p>Pick a class, add your equipment, then choose passives.</p><p>Search any slot to see matching definitions and their descriptions.</p></>}<p className="build-sheet__planning-note"><Icon name="info"/>Plan freely. Saving does not change your inventory or recorded character.</p></aside>
    </div>
    <BuildValidity report={validity}/>
    <BuildMechanics catalogs={catalogs} content={draft} onChange={calculation => { setDraft(current => ({ ...current, calculation })); updateDirty(true) }} profile={profile} slots={slots}/>
    <details className="build-details"><summary>Build details & notes</summary><div className="stack">{children}<Field label="Rotation or use notes"><textarea onChange={(event) => setDraft({ ...draft, rotationNotes: event.target.value || undefined })} placeholder="Optional play notes" value={draft.rotationNotes ?? ''}/></Field><Field hint="One assumption per line. These stay visible in comparisons." label="Context assumptions"><textarea onChange={(event) => setAssumptions(event.target.value)} value={assumptions}/></Field><Field label="Checkpoint name"><input onChange={(event) => setDraft({ ...draft, note: event.target.value || undefined })} value={draft.note ?? ''}/></Field><p className="field__hint">{ruleset?.slots.length ? `Slot layout: ${ruleset.label}` : 'Suggested planning slots. Game version, mods, and equipment permissions remain unverified; adjust the layout in Data & settings.'}</p></div></details></fieldset>
    {missingPicker && <InlineNotice title="Build field unavailable" tone="warning">The requested slot or class field is not part of this editor configuration. <Button onClick={closePicker} tone="quiet" type="button">Close picker route</Button></InlineNotice>}
    {error && <InlineNotice title="Revision not saved" tone="danger">{error} Your selections remain in this editor.</InlineNotice>}
    <div className="form-actions"><Button disabled={busy} onClick={discard} tone="quiet" type="button">{onCancel ? 'Cancel and discard' : 'Discard edits'}</Button><Button disabled={busy} icon="check" type="submit">{busy ? 'Saving...' : build ? 'Save new revision' : 'Save build'}</Button></div>
  </form>
}

function AddScenarioForm({ profile, revision, onCancel, onSubmit }: { profile: Profile; revision?: BuildRevision; onCancel: () => void; onSubmit: (draft: ScenarioDraft) => Promise<void> }) {
  const currentRuleset = revision ? ownRecordValue(profile.rulesets, revision.rulesetRevisionId) : activeRuleset(profile)
  const recorded = Object.values(profile.scenarios).find((scenario) => scenario.kind === 'recordedCurrent')
  const sameLock = Boolean(recorded && currentRuleset && catalogLocksMatch(recorded.catalogLock, revision?.catalogLock ?? currentRuleset.catalogLock))
  const recordedAssignments = recorded ? effectiveScenarioAssignments(recorded) : {}
  const recordedMembers = recorded ? scenarioMemberIds(recorded) : []
  const recordedBaselineAvailable = Boolean(recorded && currentRuleset && recorded.rulesetRevisionId === currentRuleset.id && sameLock && recordedMembers.length === TEAM_SIZE && new Set(recordedMembers).size === TEAM_SIZE && Object.keys(recordedAssignments).length)
  const revisionCharacterId = revision ? ownRecordValue(profile.builds, revision.buildId)?.characterId : undefined
  const initialMembers = Array.from({ length: TEAM_SIZE }, (_, index) => index === 0 ? revisionCharacterId ?? '' : '')
  const [draft, setDraft] = useState<ScenarioDraft>({ label: '', kind: 'draft', memberIds: initialMembers, baseline: 'empty', enforceStock: true, includeProtected: false, buildRevisionId: revision?.id })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const distinctMembers = new Set(draft.memberIds.filter(Boolean))
  const rosterComplete = draft.memberIds.length === TEAM_SIZE && distinctMembers.size === TEAM_SIZE
  const updateMember = (index: number, characterId: string) => setDraft({ ...draft, memberIds: draft.memberIds.map((value, memberIndex) => memberIndex === index ? characterId : value) })
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!rosterComplete) return; setBusy(true); setError(undefined); try { await onSubmit(draft) } catch (reason) { setError(reason instanceof Error ? reason.message : 'The scenario could not be created.') } finally { setBusy(false) } }
  return <form className="stack" onSubmit={submit}><Field label="Scenario label" required><input autoFocus onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="For example: next boss party" required value={draft.label}/></Field><Field hint="Recorded current parties are created only through the confirmed Record as current flow." label="Context"><select onChange={(event) => setDraft({ ...draft, kind: event.target.value as ScenarioDraft['kind'] })} value={draft.kind}><option value="draft">Draft team</option><option value="hypothetical">Hypothetical team</option></select></Field><section className="scenario-roster-editor"><div className="scenario-roster-editor__heading"><div><h3>Four-character team</h3><p>Choose the party roster first. Builds remain independent and can be assigned, cleared, or reused later.</p></div><Badge tone={rosterComplete ? 'positive' : 'warning'}>{distinctMembers.size} of {TEAM_SIZE}</Badge></div>{Object.values(profile.characters).length < TEAM_SIZE && <InlineNotice title="More characters needed" tone="warning">Add at least {TEAM_SIZE - Object.values(profile.characters).length} more {TEAM_SIZE - Object.values(profile.characters).length === 1 ? 'character' : 'characters'} before creating a team.</InlineNotice>}<div className="grid-2">{draft.memberIds.map((memberId, index) => <Field key={index} label={`Team member ${index + 1}`} required><select aria-label={`Team member ${index + 1}`} disabled={draft.baseline === 'recordedParty'} onChange={(event) => updateMember(index, event.target.value)} required value={memberId}><option value="">Choose character</option>{Object.values(profile.characters).map((character) => <option disabled={draft.memberIds.some((value, memberIndex) => memberIndex !== index && value === character.id)} key={character.id} value={character.id}>{character.name}</option>)}</select></Field>)}</div></section><Field hint={recordedBaselineAvailable ? 'Copies the compatible recorded party roster and pinned assignments. Later build changes remain explicit overrides.' : 'A complete recorded party with the chosen ruleset and catalog lock is required.'} label="Starting assignments"><select onChange={(event) => { const baseline = event.target.value as ScenarioDraft['baseline']; setDraft({ ...draft, baseline, memberIds: baseline === 'recordedParty' ? recordedMembers : draft.memberIds }) }} value={draft.baseline}><option value="empty">Start without assigned builds</option><option disabled={!recordedBaselineAvailable} value="recordedParty">Copy recorded current party</option></select></Field><label className="check-row"><input checked={draft.enforceStock} onChange={(event) => setDraft({ ...draft, enforceStock: event.target.checked })} type="checkbox"/><span><strong>Check recorded stock</strong><small>Report simultaneous assignments against current observations</small></span></label><label className="check-row"><input checked={draft.includeProtected} onChange={(event) => setDraft({ ...draft, includeProtected: event.target.checked })} type="checkbox"/><span><strong>Allow protected copies</strong><small>Use only when this scenario deliberately includes them</small></span></label>{error && <InlineNotice title="Scenario not created" tone="danger">{error} Your entries remain in this form.</InlineNotice>}<div className="form-actions"><Button onClick={onCancel} tone="quiet" type="button">Cancel</Button><Button disabled={busy || !draft.label.trim() || !rosterComplete} icon="plus" type="submit">{busy ? 'Creating...' : 'Create scenario'}</Button></div></form>
}

function ScenarioCard({ scenario, profile, catalogs, validation, onAssign }: { scenario: TeamScenario; profile: Profile; catalogs: readonly CatalogSnapshot[]; validation?: ValidationReport; onAssign: (scenarioId: string, characterId: string, revisionId: string) => Promise<void> }) {
  const navigation = useNavigation()
  const memberIds = scenarioMemberIds(scenario)
  const characters = memberIds.flatMap(characterId => ownRecordValue(profile.characters, characterId) ?? [])
  const revisions = Object.values(profile.buildRevisions)
  const effectiveAssignments = effectiveScenarioAssignments(scenario)
  const [assignmentError, setAssignmentError] = useState<string>()
  const assign = async (characterId: string, revisionId: string) => {
    if (scenario.kind === 'recordedCurrent') return
    setAssignmentError(undefined)
    try { await onAssign(scenario.id, characterId, revisionId) } catch (reason) { setAssignmentError(reason instanceof Error ? reason.message : 'The scenario assignment could not be saved.') }
  }
  const completeRoster = memberIds.length === TEAM_SIZE && new Set(memberIds).size === TEAM_SIZE && characters.length === TEAM_SIZE
  return <article className="panel" id={`scenario-${scenario.id}`}><header className="panel__header"><div><div className="cluster"><h2>{scenario.label}</h2>{scenario.id === profile.activeScenarioId && <Badge tone="info">Active</Badge>}<Badge tone={scenario.kind === 'recordedCurrent' ? 'positive' : scenario.kind === 'hypothetical' ? 'warning' : 'info'}>{scenario.kind === 'recordedCurrent' ? 'Recorded current' : scenario.kind === 'hypothetical' ? 'Hypothetical' : 'Draft team'}</Badge><Badge tone={completeRoster ? 'positive' : 'danger'}>{memberIds.length} of {TEAM_SIZE} members</Badge></div><p>{scenario.inventoryPolicy.enforceStock ? 'Stock checks enabled' : 'Stock checks informational'} · {scenario.inventoryPolicy.includeProtected ? 'Protected copies allowed' : 'Protected copies excluded'}</p></div></header><div className="panel__body stack">{scenario.kind === 'recordedCurrent' && <InlineNotice title="Recorded assignments follow confirmed observations">Use a build's Record as current action after applying it in game. Draft and hypothetical scenarios remain directly editable.</InlineNotice>}{!completeRoster && <InlineNotice title="This legacy team is incomplete" tone="warning">Team scenarios now require exactly four distinct characters. Create a replacement team to choose the missing members explicitly. <Button onClick={() => navigation.navigate({ page: { page: 'builds', view: 'scenario-new' }, overlays: [], query: {} })} tone="quiet" type="button">Create four-person team</Button></InlineNotice>}<div className="scenario-roster-grid">{Array.from({ length: TEAM_SIZE }, (_, index) => { const character = characters[index]; return character ? <div className="scenario-member-card" key={character.id}><div className="scenario-member-card__number">{index + 1}</div><Field hint={scenario.kind === 'recordedCurrent' ? 'Record a pinned build as current to change this assignment.' : 'This slot stays on the team when its build is cleared.'} label={character.name}><select aria-label={character.name} disabled={scenario.kind === 'recordedCurrent'} onChange={(event) => void assign(character.id, event.target.value)} value={ownRecordValue(effectiveAssignments, character.id) ?? ''}><option value="">No build assigned</option>{revisions.filter((revision) => { const build = ownRecordValue(profile.builds, revision.buildId); return build && (!build.characterId || build.characterId === character.id) }).map((revision) => <option key={revision.id} value={revision.id}>{revisionOptionLabel(profile, revision)}</option>)}</select></Field></div> : <div className="scenario-member-card scenario-member-card--empty" key={`empty-${index}`}><div className="scenario-member-card__number">{index + 1}</div><div><strong>Member missing</strong><p>No character was recorded for this legacy team slot.</p></div></div> })}</div>{assignmentError && <InlineNotice title="Assignment not saved" tone="danger">{assignmentError} The prior pinned assignment remains active.</InlineNotice>}<ValidationPanel catalogs={catalogs} profile={profile} report={validation} scenario={scenario}/></div></article>
}

export function BuildsView({ profile, catalogs, validations, onCreateBuild, onCloneBuild, onSaveRevision, onCreateScenario, onAssign, onRecordCurrent, onDraftChange }: { profile: Profile; catalogs: readonly CatalogSnapshot[]; validations: Readonly<Record<string, ValidationReport | undefined>>; onCreateBuild: (draft: BuildDraft, revision: RevisionDraft) => Promise<{ buildId: BuildId; revisionId: BuildRevisionId }>; onCloneBuild: (buildId: string) => Promise<string>; onSaveRevision: (buildId: string, draft: RevisionDraft, parentRevisionId?: string) => Promise<BuildRevisionId>; onCreateScenario: (draft: ScenarioDraft) => Promise<void>; onAssign: (scenarioId: string, characterId: string, revisionId: string) => Promise<void>; onRecordCurrent: (buildId: string, revisionId: string) => Promise<void>; onDraftChange: DraftChangeHandler }) {
  const navigation = useNavigation()
  const page = navigation.route.page.page === 'builds' ? navigation.route.page : { page: 'builds', view: 'library' } as const
  const allBuilds = Object.values(profile.builds).filter((build) => build.state !== 'archived')
  const scenarios = Object.values(profile.scenarios)
  const revisions = Object.values(profile.buildRevisions).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const section: BuildsSection = page.view === 'teams' || page.view === 'scenario-new' || page.view === 'scenario' ? 'teams' : page.view === 'compare' || page.view === 'compare-pair' ? 'compare' : 'library'
  const addingBuild = page.view === 'build-new'
  const addingScenario = page.view === 'scenario-new'
  const scenarioRevisionId = navigation.route.query.forRevision?.[0]
  const scenarioRevision = scenarioRevisionId ? ownRecordValue(profile.buildRevisions, scenarioRevisionId) : undefined
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
  const [editorDirty, setEditorDirty] = useState(false)
  const editorActionsRef = useRef<DraftActions | undefined>(undefined)
  const draftContinuationRef = useRef<(() => void) | undefined>(undefined)
  const [resolvingDraft, setResolvingDraft] = useState(false)
  const [readinessScenarioId, setReadinessScenarioId] = useState<string>()
  const [draftGuard, setDraftGuard] = useState<string>()
  const [cloneBusy, setCloneBusy] = useState(false)
  const [cloneError, setCloneError] = useState<string>()
  const navigate = (next: BuildsPageRoute, replace = false) => navigation.navigate({ ...navigation.route, page: next, overlays: [], query: {} }, { replace })
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
    const build = ownRecordValue(profile.builds, page.buildId)
    if (build) navigate(editorRouteFor(build), true)
  }, [allBuilds, navigation.route.overlays.length, page, profile.builds, selectedId])
  useEffect(() => {
    if (page.view !== 'scenario' || !ownRecordValue(profile.scenarios, page.scenarioId)) return
    window.requestAnimationFrame(() => document.getElementById(`scenario-${page.scenarioId}`)?.scrollIntoView({ block: 'start' }))
  }, [page, profile.scenarios])
  const updateEditorDirty: DraftChangeHandler = (value, actions) => { setEditorDirty(value); editorActionsRef.current = value ? actions : undefined; if (!value) { draftContinuationRef.current = undefined; setDraftGuard(undefined) } onDraftChange(value, actions) }
  const guardDraft = (message: string, continuation: () => void) => { draftContinuationRef.current = continuation; setDraftGuard(message) }
  const changeSection = (value: BuildsSection) => { if (editorDirty && value !== section) { guardDraft('Choose whether to save or discard the build edits, then continue to the selected workspace.', () => navigate({ page: 'builds', view: value })); return } navigate({ page: 'builds', view: value }) }
  const selectBuild = (value: string) => { const build = ownRecordValue(profile.builds, value); if (!build) return; const open = () => { navigate(editorRouteFor(build)); if (window.matchMedia('(max-width: 820px)').matches) setLibraryOpen(false) }; if (editorDirty && value !== selected?.id) { guardDraft('Choose whether to save or discard the build edits, then open the selected build.', open); return } open() }
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
  const builds = allBuilds.filter((build) => `${build.title} ${build.tags.join(' ')} ${build.characterId ? ownRecordValue(profile.characters, build.characterId)?.name ?? '' : 'template'}`.toLocaleLowerCase().includes(buildQuery.trim().toLocaleLowerCase()))
  const selected = selectedId ? ownRecordValue(profile.builds, selectedId) : undefined
  const requestedRevisionId = page.view === 'revision' || page.view === 'revision-edit' || page.view === 'record-current' ? page.revisionId : undefined
  const requestedRevision = requestedRevisionId ? ownRecordValue(profile.buildRevisions, requestedRevisionId) : undefined
  const pinnedRevision = requestedRevision?.buildId === selected?.id ? requestedRevision : undefined
  const editorBaseId = page.view === 'revision-edit' ? page.baseRevisionId ?? page.revisionId : undefined
  const requestedEditorBase = editorBaseId ? ownRecordValue(profile.buildRevisions, editorBaseId) : undefined
  const editorBaseRevision = requestedEditorBase?.buildId === selected?.id ? requestedEditorBase : undefined
  const selectedRevision = page.view === 'revision-edit' ? editorBaseRevision : pinnedRevision
  useEffect(() => {
    setCurrentConfirmed(false)
    setRecordingError(undefined)
  }, [recordingCurrent, requestedRevisionId, selectedId])
  useEffect(() => { setReadinessScenarioId(undefined) }, [profile.activeScenarioId, selectedRevision?.id])
  const matchingScenarios = selectedRevision ? scenarios.filter((scenario) => Object.values(effectiveScenarioAssignments(scenario)).includes(selectedRevision.id)) : []
  const selectedScenario = readinessScenarioId ? matchingScenarios.find((scenario) => scenario.id === readinessScenarioId) : matchingScenarios.find((scenario) => scenario.id === profile.activeScenarioId) ?? matchingScenarios[0]
  const selectedCharacter = selected?.characterId ? ownRecordValue(profile.characters, selected.characterId) : undefined
  const recordedScenario = scenarios.find((scenario) => scenario.kind === 'recordedCurrent')
  const activeScenario = profile.activeScenarioId ? ownRecordValue(profile.scenarios, profile.activeScenarioId) : undefined
  const supportsRecording = (scenario: TeamScenario | undefined) => {
    if (!scenario || !selectedRevision || !selectedCharacter) return false
    const members = scenarioMemberIds(scenario)
    return scenario.rulesetRevisionId === selectedRevision.rulesetRevisionId && catalogLocksMatch(scenario.catalogLock, selectedRevision.catalogLock) && members.length === TEAM_SIZE && new Set(members).size === TEAM_SIZE && members.includes(selectedCharacter.id)
  }
  const recordRosterScenario = supportsRecording(recordedScenario) ? recordedScenario : supportsRecording(activeScenario) ? activeScenario : undefined
  const forksRecordedParty = Boolean(recordedScenario && recordRosterScenario && recordedScenario.id !== recordRosterScenario.id)
  const selectedBuildRevisions = selected ? revisions.filter((revision) => revision.buildId === selected.id) : []
  const missingBuild = Boolean(selectedId && !selected)
  const missingRevision = Boolean(requestedRevisionId && !pinnedRevision)
  const missingEditorBase = page.view === 'revision-edit' && !editorBaseRevision
  const missingScenario = page.view === 'scenario' && !ownRecordValue(profile.scenarios, page.scenarioId)
  const missingCompareRevision = page.view === 'compare-pair' && (!ownRecordValue(profile.buildRevisions, page.leftRevisionId) || !ownRecordValue(profile.buildRevisions, page.rightRevisionId))
  const currentSnapshot = selectedCharacter?.currentSnapshotId ? ownRecordValue(selectedCharacter.snapshots, selectedCharacter.currentSnapshotId) : undefined
  const currentChanges = useMemo(() => {
    if (!selectedRevision) return []
    const ruleset = ownRecordValue(profile.rulesets, selectedRevision.rulesetRevisionId)
    const classes = [
      { label: 'Class', before: currentSnapshot?.primaryClass.state === 'known' ? currentSnapshot.primaryClass.value : null, after: selectedRevision.content.primaryClass },
      { label: 'Sub-command', before: currentSnapshot?.secondaryClass.state === 'known' ? currentSnapshot.secondaryClass.value : null, after: selectedRevision.content.secondaryClass },
    ].flatMap((change) => (change.before ? entityDefinitionKey(change.before) : '') === (change.after ? entityDefinitionKey(change.after) : '') ? [] : [{ label: change.label, before: change.before ? entityName(profile, catalogs, change.before) : 'Unrecorded', after: change.after ? entityName(profile, catalogs, change.after) : 'Empty' }])
    const slots = [...(ruleset?.slots ?? [])].sort((left, right) => left.order - right.order).flatMap((slot) => {
      const before = currentSnapshot?.equipment[slot.id]
      const after = selectedRevision.content.equipment[slot.id]?.ref
      if ((before ? entityDefinitionKey(before) : '') === (after ? entityDefinitionKey(after) : '')) return []
      return [{ label: slot.label, before: before ? entityName(profile, catalogs, before) : 'Empty or unrecorded', after: after ? entityName(profile, catalogs, after) : 'Empty' }]
    })
    const beforePassives = currentSnapshot?.passives.state === 'known' ? currentSnapshot.passives.value : []
    const passiveCount = Math.max(beforePassives.length, selectedRevision.content.passives.length)
    const passives = Array.from({ length: passiveCount }, (_, index) => {
      const before = beforePassives[index]
      const after = selectedRevision.content.passives[index]?.ref
      if ((before ? entityDefinitionKey(before) : '') === (after ? entityDefinitionKey(after) : '')) return undefined
      return { label: `Equipped passive ${index + 1}`, before: before ? entityName(profile, catalogs, before) : 'Empty or unrecorded', after: after ? entityName(profile, catalogs, after) : 'Empty' }
    }).filter((change): change is NonNullable<typeof change> => Boolean(change))
    return [...classes, ...slots, ...passives]
  }, [catalogs, currentSnapshot, profile, selectedRevision])
  const differences = useMemo(() => {
    const left = ownRecordValue(profile.buildRevisions, leftRevision)
    const right = ownRecordValue(profile.buildRevisions, rightRevision)
    if (!left || !right) return []
    const names = new Map<string, string>()
    for (const definition of Object.values(profile.personalDefinitions)) names.set(entityDefinitionKey({ kind: 'personal', definitionId: definition.id }), `${definition.name} · personal definition`)
    for (const catalog of catalogs) for (const entity of Object.values(catalog.entities)) names.set(entityDefinitionKey({ kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entity.id }), `${entity.name} · ${catalog.id}`)
    const format = (value: unknown) => {
      if (typeof value === 'string') return names.get(value) ?? ownRecordValue(profile.rulesets, value)?.label ?? value
      if (value && typeof value === 'object' && 'ref' in value && typeof value.ref === 'string') {
        const allocation = 'allocationId' in value && typeof value.allocationId === 'string' ? ' · shared physical copy' : ' · separate recorded copy'
        return `${names.get(value.ref) ?? value.ref}${allocation}`
      }
      return value == null ? 'None' : JSON.stringify(value)
    }
    const summarize = (revision: typeof left) => {
      const ruleset = ownRecordValue(profile.rulesets, revision.rulesetRevisionId)
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
        const definition = resolveEntity(profile, catalogs, ref)
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
        const slot = ruleset?.slots.find((value) => value.id === slotId)
        if (slot) {
          const key = logicalEntityKey(profile, selection.ref)
          const requirement = stockRequirements.get(key) ?? { ref: selection.ref, allocations: new Set<string>() }
          requirement.allocations.add(selection.allocationId ?? `slot:${slotId}`)
          stockRequirements.set(key, requirement)
        }
      }
      for (const selection of revision.content.passives) {
        const definition = resolveEntity(profile, catalogs, selection.ref)
        if (definition?.ppCost?.state === 'known') pp += definition.ppCost.value
        else unresolvedPp += 1
      }
      for (const requirement of stockRequirements.values()) {
        const needed = requirement.allocations.size
        const inventory = Object.values(profile.inventory).find((position) => sameLogicalEntity(profile, position.ref, requirement.ref))
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
      const matchingScenarios = Object.values(profile.scenarios).filter((value) => Object.values(effectiveScenarioAssignments(value)).includes(revision.id)).sort((leftScenario, rightScenario) => leftScenario.label.localeCompare(rightScenario.label) || leftScenario.id.localeCompare(rightScenario.id))
      const scenario = matchingScenarios.find((value) => value.id === profile.activeScenarioId) ?? matchingScenarios[0]
      const report = scenario ? validations[scenario.id] : undefined
      const statuses = report ? Object.values(report.dimensions).reduce((counts, value) => ({ ...counts, [value.status]: (counts[value.status] ?? 0) + 1 }), {} as Record<string, number>) : undefined
      const summarizeText = (values: readonly string[], empty: string) => values.length ? `${values.slice(0, 3).join(' · ')}${values.length > 3 ? ` · ${values.length - 3} more` : ''}` : empty
      const scenarioName = scenario ? `${scenario.label}${scenario.id === profile.activeScenarioId ? ' (active)' : ''}` : undefined
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
    const leftStats = calculateBuildStats(left.content, ownRecordValue(profile.rulesets, left.rulesetRevisionId)?.slots ?? [], ref => resolveEntity(profile, catalogs, ref), ref => logicalEntityKey(profile, ref))
    const rightStats = calculateBuildStats(right.content, ownRecordValue(profile.rulesets, right.rulesetRevisionId)?.slots ?? [], ref => resolveEntity(profile, catalogs, ref), ref => logicalEntityKey(profile, ref))
    const statRows = left.content.calculation || right.content.calculation ? CALCULATED_STATS.map(stat => ({ label: `${STAT_LABELS[stat]} (supported estimate)`, left: formatStatRange(leftStats.stats[stat].value), right: formatStatRange(rightStats.stats[stat].value) })) : []
    const calculationLabel = (revision: BuildRevision) => {
      const plan = revision.content.calculation
      if (!plan) return 'No calculation inputs'
      return [`Level ${plan.level ?? 'unknown'}`, `Growth: ${plan.growth.map(row => `${entityName(profile, catalogs, row.classRef, 'Unknown class')} ${row.levels ?? '?'}`).join(', ') || 'unallocated'}`, `Bonuses: ${plan.bonuses.join(', ') || 'none'}`, `Statuses: ${plan.statuses.map(ref => entityName(profile, catalogs, ref)).join(', ') || 'none'}`, ...(plan.ability ? [`Ability: ${entityName(profile, catalogs, plan.ability)}`] : []), ...(plan.targetEvasion != null ? [`Target evasion: ${plan.targetEvasion}`] : [])].join(' · ')
    }
    const scopeRows = statRows.length ? [{ label: 'Estimate exclusions', left: leftStats.excluded.join('; ') || 'None found in supplied fields', right: rightStats.excluded.join('; ') || 'None found in supplied fields' }, { label: 'Calculation notes', left: leftStats.issues.join('; '), right: rightStats.issues.join('; ') }] : []
    return [...summaryRows, ...statRows, ...scopeRows, ...compareBuildRevisions(left, right).differences.map((difference) => ({ label: difference.path.startsWith('content.equipment.') ? ownRecordValue(profile.rulesets, left.rulesetRevisionId)?.slots.find((entry) => entry.id === difference.path.replace('content.equipment.', ''))?.label ?? difference.label : difference.label, left: difference.path === 'content.calculation' ? calculationLabel(left) : format(difference.left), right: difference.path === 'content.calculation' ? calculationLabel(right) : format(difference.right) }))]
  }, [catalogs, leftRevision, profile, rightRevision, validations])
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

  const buildCard = (build: Build) => <BuildCard build={build} catalogs={catalogs} key={build.id} onSelect={() => selectBuild(build.id)} profile={profile} selected={selected?.id === build.id}/>

  return <div className="build-workspace">
    <ScreenHeader actions={section === 'teams' ? <Button icon="plus" onClick={() => navigate({ page: 'builds', view: 'scenario-new' })}>New scenario</Button> : <>{!addingBuild && <Button icon="plus" onClick={() => navigate({ page: 'builds', view: 'build-new' })}>New build</Button>}{section === 'library' && selected?.latestRevisionId && <Button disabled={editorDirty || cloneBusy} icon="layers" onClick={() => void cloneSelected()} tone="secondary">{cloneBusy ? 'Cloning...' : 'Clone build'}</Button>}</>} description="Explore classes, equipment, and passives. No character or inventory tracking required." eyebrow="Buildcrafting" title="Builds"/>
    <div className="toolbar"><Segmented label="Build workspace" onChange={changeSection} options={[{ value: 'library', label: 'Build library' }, { value: 'teams', label: 'Team scenarios' }, { value: 'compare', label: 'Compare revisions' }]} value={section}/>{section === 'library' && !addingBuild && allBuilds.length > 0 && <div className="search-field"><Icon name="search"/><input aria-label="Search build library" onChange={(event) => updateBuildQuery(event.target.value)} placeholder="Search titles, tags, characters" type="search" value={buildQuery}/></div>}</div>{draftGuard && <div className="external-update"><InlineNotice title="Build edits are still open" tone="warning">{draftGuard}</InlineNotice><div className="cluster"><Button disabled={resolvingDraft} onClick={() => void resolveDraft('discard')} tone="quiet">Discard and continue</Button><Button disabled={resolvingDraft} icon="check" onClick={() => void resolveDraft('save')}>{resolvingDraft ? 'Saving...' : 'Save and continue'}</Button></div></div>}{cloneError && <InlineNotice title="Build not cloned" tone="danger">{cloneError} The original build and checkpoint remain unchanged.</InlineNotice>}
    {missingBuild && <InlineNotice title="Build unavailable" tone="warning">The requested build is not available in this profile. <Button onClick={() => navigate({ page: 'builds', view: 'library' })} tone="quiet">Return to build library</Button></InlineNotice>}
    {missingRevision && <InlineNotice title="Build checkpoint unavailable" tone="warning">The requested checkpoint is missing or belongs to another build. No other checkpoint was substituted. <Button onClick={() => navigate({ page: 'builds', view: 'library' })} tone="quiet">Return to build library</Button></InlineNotice>}
    {!missingRevision && missingEditorBase && <InlineNotice title="Checkpoint base unavailable" tone="warning">The requested editor base is missing or belongs to another build. Choose an available checkpoint from the build library; no latest revision was substituted. <Button onClick={() => navigate({ page: 'builds', view: 'library' })} tone="quiet">Return to build library</Button></InlineNotice>}
    {section === 'library' && addingBuild ? <AddBuildForm catalogs={catalogs} onCancel={() => { updateEditorDirty(false); navigation.close() }} onDirtyChange={updateEditorDirty} onSaved={(buildId, revisionId) => navigate({ page: 'builds', view: 'revision-edit', buildId, revisionId }, true)} onSubmit={onCreateBuild} profile={profile}/> : section === 'library' && (builds.length === 0 ? <EmptyState description="Start with a blank build. Choose classes, equipment, and passives from the reference catalog. Link a character or check tracked stock whenever you want." icon="sword" title={allBuilds.length ? 'No builds match this search' : 'Plan your next build'}>{allBuilds.length ? <Button onClick={() => updateBuildQuery('')} tone="secondary">Clear search</Button> : <Button icon="plus" onClick={() => navigate({ page: 'builds', view: 'build-new' })}>Create a build</Button>}</EmptyState> : page.view === 'library' ? <section aria-label="Build library" className="build-library-grid">{builds.map(buildCard)}</section> : <div className="build-layout">
      <details className="build-column build-library" open={libraryOpen} onToggle={(event) => setLibraryOpen(event.currentTarget.open)}><summary>Library{selected ? `: ${selected.title}` : ''}</summary><header className="build-column__header"><div className="split"><div><h2>Library</h2><p>{builds.length} matching {builds.length === 1 ? 'build' : 'builds'}</p></div><IconButton icon="plus" label="Create build" onClick={() => navigate({ page: 'builds', view: 'build-new' })}/></div></header><div className="build-column__body">{builds.map(buildCard)}</div></details>
      <section className="build-column"><header className="build-column__header"><h2>{selected?.title ?? 'Build editor'}</h2><p>{selected?.latestRevisionId ? 'Changes save as a new immutable revision' : 'Create the first pinned revision'}</p>{selectedBuildRevisions.length > 0 && <Field hint={editorBaseRevision?.id !== selected?.latestRevisionId ? 'Saving creates a new latest revision using this older checkpoint as the content base.' : 'Inspect or edit the latest pinned checkpoint.'} label="Editor checkpoint"><select disabled={editorDirty} onChange={(event) => chooseEditorBase(event.target.value)} value={editorBaseRevision?.id ?? selectedRevision?.id ?? ''}>{selectedBuildRevisions.map((revision) => <option key={revision.id} value={revision.id}>r{revision.revision}{checkpointSuffix(revision)} · {formatRelativeDate(revision.createdAt)}</option>)}</select></Field>}</header><div className="build-column__body">{selected && editingRoute && !missingRevision && !missingEditorBase && <RevisionEditor build={selected} catalogs={catalogs} key={`${selected.id}:${page.view}:${editorBaseRevision?.id ?? 'new'}`} onDirtyChange={updateEditorDirty} onSaved={savedRevisionRoute} onSubmit={(draft) => onSaveRevision(selected.id, draft, editorBaseRevision?.id)} profile={profile} sourceRevision={editorBaseRevision}/>}</div></section>
      <details className="build-column build-readiness"><summary>Can I use this build now?</summary><header className="build-column__header"><h2>Current readiness</h2><p>Check a saved build against a character's learning, unlocks, inventory, and party conflicts.</p><p>{selectedScenario ? `Evaluated in ${selectedScenario.label}` : 'Assign this revision to a scenario'}</p></header><div className="build-column__body">{section === 'library' && selected && selectedRevision && selectedCharacter && selected.state !== 'recordedCurrent' && <Button disabled={editorDirty} icon="check" onClick={() => { setRecordingError(undefined); navigate({ page: 'builds', view: 'record-current', buildId: selected.id, revisionId: selectedRevision.id }) }} tone="secondary">Record as current</Button>}{selected && selectedRevision && <BuildReadinessAssignment build={selected} disabled={editorDirty} onAssign={onAssign} onScenarioChange={setReadinessScenarioId} profile={profile} revision={selectedRevision} scenarioId={readinessScenarioId ?? selectedScenario?.id}/>}<ValidationPanel catalogs={catalogs} profile={profile} report={selectedScenario ? validations[selectedScenario.id] : undefined} scenario={selectedScenario}/>{selectedRevision && <div className="settings-section"><h3>Pinned checkpoint</h3><dl className="definition-list">{selectedRevision.note?.trim() && <div className="definition-row"><dt>Name</dt><dd>{selectedRevision.note}</dd></div>}<div className="definition-row"><dt>Revision</dt><dd>{selectedRevision.revision}</dd></div><div className="definition-row"><dt>Saved</dt><dd>{formatRelativeDate(selectedRevision.createdAt)}</dd></div><div className="definition-row"><dt>Ruleset</dt><dd>{ownRecordValue(profile.rulesets, selectedRevision.rulesetRevisionId)?.label ?? 'Unresolved'}</dd></div></dl></div>}</div></details>
    </div>)}
    {section === 'teams' && <>{missingScenario && <InlineNotice title="Team scenario unavailable" tone="warning">The requested scenario is not available in this profile. No other scenario was selected. <Button onClick={() => navigate({ page: 'builds', view: 'teams' })} tone="quiet">Show team scenarios</Button></InlineNotice>}{scenarios.length === 0 ? <EmptyState aside={<>A scenario is the boundary for simultaneous inventory use. Alternative scenarios may each use the same recorded copy.</>} description="Create a draft, hypothetical, or recorded-current team, then pin one build revision per participating character." icon="team" title="No team scenarios"><Button icon="plus" onClick={() => navigate({ page: 'builds', view: 'scenario-new' })}>Create a scenario</Button></EmptyState> : <div className="stack">{scenarios.map((scenario) => <ScenarioCard catalogs={catalogs} key={scenario.id} onAssign={onAssign} profile={profile} scenario={scenario} validation={validations[scenario.id]}/>)}</div>}</>}
    {section === 'compare' && <div className="stack"><div className="panel"><div className="panel__body grid-2"><Field label="Revision A"><select onChange={(event) => changeCompareRevision('left', event.target.value)} value={leftRevision}><option value="">Choose revision</option>{revisions.map((revision) => <option key={revision.id} value={revision.id}>{revisionOptionLabel(profile, revision)}</option>)}</select></Field><Field label="Revision B"><select onChange={(event) => changeCompareRevision('right', event.target.value)} value={rightRevision}><option value="">Choose revision</option>{revisions.map((revision) => <option key={revision.id} value={revision.id}>{revisionOptionLabel(profile, revision)}</option>)}</select></Field></div></div>{missingCompareRevision ? <InlineNotice title="Comparison checkpoint unavailable" tone="warning">One or both requested checkpoints are not available in this profile. Choose two available checkpoints to create a new comparison address.</InlineNotice> : leftRevision && rightRevision ? differences.length ? <div className="comparison-grid"><section className="comparison-column"><h2>{ownRecordValue(profile.builds, ownRecordValue(profile.buildRevisions, leftRevision)?.buildId ?? '')?.title}</h2>{differences.map((row) => <div className="comparison-row" key={row.label}><small>{row.label}</small><strong>{row.left}</strong></div>)}</section><section className="comparison-column"><h2>{ownRecordValue(profile.builds, ownRecordValue(profile.buildRevisions, rightRevision)?.buildId ?? '')?.title}</h2>{differences.map((row) => <div className="comparison-row" key={row.label}><small>{row.label}</small><strong>{row.right}</strong></div>)}</section></div> : <InlineNotice title="Selections match">These revisions have no descriptive differences in class or ordered selections.</InlineNotice> : <EmptyState description="Choose two immutable build revisions. The comparison explains changed selections without producing an opaque score." icon="compare" title="Select revisions to compare"/>}</div>}
    <Sheet onClose={() => navigation.close()} open={addingScenario} title="Create team scenario"><>{scenarioRevisionId && !scenarioRevision ? <InlineNotice title="Build revision unavailable" tone="warning">The requested revision is missing. No other ruleset was substituted.</InlineNotice> : <><p className="field__hint">{scenarioRevision ? `Uses saved r${scenarioRevision.revision}: ${ownRecordValue(profile.rulesets, scenarioRevision.rulesetRevisionId)?.label ?? 'Unresolved ruleset'}` : 'Uses the active ruleset'}</p><AddScenarioForm onCancel={() => navigation.close()} onSubmit={createScenario} profile={profile} revision={scenarioRevision}/></>}</></Sheet>

    <Sheet description="This changes the tracker only after you confirm the build was applied in game." onClose={() => { setCurrentConfirmed(false); navigation.close() }} open={recordingCurrent && !missingRevision} title="Record build as current"><div className="stack"><InlineNotice title="No game connection">Crystal Companion cannot apply this build to Crystal Project. Confirm only after making the changes yourself. Existing PP capacity and displayed final stats will be marked for recapture because this configuration changed; a known character level is preserved.</InlineNotice>{!recordRosterScenario && <InlineNotice title="Choose a complete team first" tone="warning">Recording preserves a four-character party and never guesses the other members. Select or create a compatible team containing {selectedCharacter?.name ?? 'this character'}, then try again. <Button onClick={() => navigate({ page: 'builds', view: 'scenario-new' })} tone="quiet" type="button">Create four-person team</Button></InlineNotice>}{forksRecordedParty && <InlineNotice title="This starts a new recorded-party ruleset" tone="warning">The existing recorded current party uses another setup and will remain available as a draft. The new recorded party will preserve all four members from {recordRosterScenario?.label}.</InlineNotice>}<div className="panel"><div className="panel__header"><div><h3>{selected?.title}</h3><p>{selectedCharacter?.name} · revision {selectedRevision?.revision}</p></div></div><div className="panel__body">{currentChanges.length ? <dl className="definition-list">{currentChanges.map((change) => <div className="definition-row" key={change.label}><dt>{change.label}</dt><dd><span className="status-change">{change.before}</span> → {change.after}</dd></div>)}</dl> : <InlineNotice title="No slot changes detected">The recorded snapshot and selected revision use the same known slot references. Class or unknown-field differences may still remain.</InlineNotice>}</div></div>{recordingError && <InlineNotice title="Current build not recorded" tone="danger">{recordingError} This confirmation remains open so you can retry.</InlineNotice>}{selectedScenario && validations[selectedScenario.id]?.issues.length ? <InlineNotice title="Validation issues remain" tone="warning">{validations[selectedScenario.id]?.issues.length} checks are invalid or undetermined in {selectedScenario.label}. The observation can still be recorded without declaring those rules valid.</InlineNotice> : null}<label className="check-row"><input checked={currentConfirmed} disabled={!recordRosterScenario} onChange={(event) => setCurrentConfirmed(event.target.checked)} type="checkbox"/><span><strong>I made these changes in game</strong><small>Record this pinned revision as the tracker's current configuration</small></span></label><div className="form-actions"><Button onClick={() => { setCurrentConfirmed(false); navigation.close() }} tone="quiet">Cancel</Button><Button disabled={!currentConfirmed || recordingBusy || !recordRosterScenario} icon="check" onClick={() => { if (!selected || !selectedRevision) return; setRecordingBusy(true); void onRecordCurrent(selected.id, selectedRevision.id).then(() => { setCurrentConfirmed(false); navigation.close() }).catch((reason: unknown) => setRecordingError(reason instanceof Error ? reason.message : 'The current build could not be recorded.')).finally(() => setRecordingBusy(false)) }}>{recordingBusy ? 'Recording...' : 'Record as current'}</Button></div></div></Sheet>
  </div>
}
