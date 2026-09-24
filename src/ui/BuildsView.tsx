import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { compareBuildRevisions, effectiveScenarioAssignments, entityDefinitionKey, logicalEntityKey, sameLogicalEntity } from '../domain'
import type { Build, BuildKind, BuildRevision, BuildSelection, BuildState, CatalogEntityKind, CatalogSnapshot, EntityRef, Profile, ScenarioKind, TeamScenario, ValidationIssue, ValidationReport } from '../domain/types'
import { Badge, Button, EmptyState, Field, IconButton, InlineNotice, ScreenHeader, Segmented } from './components'
import { Icon } from './icons'
import { catalogLocksMatch, entityName, formatRelativeDate, resolveEntity } from './model'
import { closeBuildPickerRoute, commitBuildPickerRouteState, readBuildPickerRouteState, readStoredBuildPickerRouteState } from './route-state'
import { Sheet } from './Sheet'
import { DefinitionPickerDialog } from './definitions'
import { useSearchTarget } from './use-search-target'

export interface BuildDraft { readonly title: string; readonly kind: BuildKind; readonly characterId?: string; readonly state: BuildState; readonly tags: readonly string[] }
export interface RevisionDraft { readonly primaryClass: EntityRef | null; readonly secondaryClass: EntityRef | null; readonly selections: Readonly<Record<string, BuildSelection | null>>; readonly rotationNotes?: string; readonly contextAssumptions: readonly string[]; readonly note?: string }
export interface ScenarioDraft { readonly label: string; readonly kind: Exclude<ScenarioKind, 'recordedCurrent'>; readonly baseline: 'empty' | 'recordedParty'; readonly enforceStock: boolean; readonly includeProtected: boolean }

type BuildsSection = 'library' | 'teams' | 'compare'

function AddBuildForm({ profile, onCancel, onSubmit }: { profile: Profile; onCancel: () => void; onSubmit: (draft: BuildDraft) => Promise<void> }) {
  const characters = Object.values(profile.characters)
  const [draft, setDraft] = useState<{ title: string; kind: BuildKind; characterId: string; state: BuildState; tags: string }>({ title: '', kind: 'character', characterId: characters[0]?.id ?? '', state: 'draft', tags: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(undefined); try { await onSubmit({ ...draft, characterId: draft.kind === 'character' ? draft.characterId || undefined : undefined, tags: draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean) }) } catch (reason) { setError(reason instanceof Error ? reason.message : 'The build could not be created.') } finally { setBusy(false) } }
  return <form className="stack" onSubmit={submit}><Field label="Build title" required><input autoFocus onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="For example: counter support" required value={draft.title}/></Field><div className="grid-2"><Field label="Build type"><select onChange={(event) => setDraft({ ...draft, kind: event.target.value as BuildKind })} value={draft.kind}><option value="character">Character-bound</option><option value="template">Reusable template</option></select></Field><Field label="Planning context"><select onChange={(event) => setDraft({ ...draft, state: event.target.value as BuildState })} value={draft.state}><option value="draft">Draft alternative</option><option value="hypothetical">Hypothetical</option></select></Field></div>{draft.kind === 'character' && <Field hint={!characters.length ? 'Add a character before binding this build.' : undefined} label="Character"><select disabled={!characters.length} onChange={(event) => setDraft({ ...draft, characterId: event.target.value })} value={draft.characterId}><option value="">Choose character</option>{characters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}</select></Field>}<Field hint="Comma-separated labels used only for organization." label="Tags"><input onChange={(event) => setDraft({ ...draft, tags: event.target.value })} placeholder="support, counter, exploration" value={draft.tags}/></Field><InlineNotice title="Saved builds do not reserve stock">Availability is checked only when a build revision is assigned within a team scenario. Recording a build as current uses a separate observed-state confirmation.</InlineNotice>{error && <InlineNotice title="Build not created" tone="danger">{error} Your entries remain in this form.</InlineNotice>}<div className="form-actions"><Button onClick={onCancel} tone="quiet" type="button">Cancel</Button><Button disabled={busy || !draft.title.trim() || (draft.kind === 'character' && !draft.characterId)} icon="plus" type="submit">{busy ? 'Creating...' : 'Create build'}</Button></div></form>
}

interface PickerTarget { readonly key: 'primaryClass' | 'secondaryClass' | string; readonly label: string; readonly kinds: readonly CatalogEntityKind[] }

function checkpointSuffix(revision: BuildRevision) {
  const name = revision.note?.trim()
  return name ? ` · ${name}` : ''
}

function revisionOptionLabel(profile: Profile, revision: BuildRevision) {
  return `${profile.builds[revision.buildId]?.title ?? 'Unresolved build'} · r${revision.revision}${checkpointSuffix(revision)}`
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

function RevisionEditor({ build, sourceRevision, profile, catalogs, onCancel, onSubmit, onDirtyChange }: { build: Build; sourceRevision?: BuildRevision; profile: Profile; catalogs: readonly CatalogSnapshot[]; onCancel?: () => void; onSubmit: (draft: RevisionDraft) => Promise<void>; onDirtyChange: (dirty: boolean) => void }) {
  const latest = sourceRevision ?? (build.latestRevisionId ? profile.buildRevisions[build.latestRevisionId] : undefined)
  const ruleset = profile.activeRulesetRevisionId ? profile.rulesets[profile.activeRulesetRevisionId] : latest ? profile.rulesets[latest.rulesetRevisionId] : undefined
  const initialDraft = (): RevisionDraft => ({ primaryClass: latest?.content.primaryClass ?? null, secondaryClass: latest?.content.secondaryClass ?? null, selections: { ...(latest?.content.selections ?? {}) }, rotationNotes: latest?.content.rotationNotes, contextAssumptions: latest?.content.contextAssumptions ?? [], note: undefined })
  const [draft, setDraft] = useState<RevisionDraft>(initialDraft)
  const [assumptions, setAssumptions] = useState(draft.contextAssumptions.join('\n'))
  const [picker, setPicker] = useState<PickerTarget>()
  const [query, setQuery] = useState('')
  const [candidateLimit, setCandidateLimit] = useState(100)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const slots = [...(ruleset?.slots ?? [])].sort((a, b) => a.order - b.order)
  const equipmentSlots = slots.filter((slot) => slot.kind === 'equipment')
  const equipmentSlotIds = new Set(equipmentSlots.map((slot) => slot.id as string))
  const targetForKey = (key: string): PickerTarget | undefined => {
    if (key === 'primaryClass') return { key, label: 'Primary class', kinds: ['class'] }
    if (key === 'secondaryClass') return { key, label: 'Secondary class', kinds: ['class'] }
    const slot = slots.find((entry) => entry.id === key)
    if (!slot) return undefined
    const kinds: readonly CatalogEntityKind[] = slot.acceptedEntityKinds?.state === 'known' ? slot.acceptedEntityKinds.value : slot.kind === 'passive' ? ['passive', 'innate'] : ['item']
    return { key, label: slot.label, kinds }
  }
  const openPicker = (target: PickerTarget) => {
    const stored = readStoredBuildPickerRouteState(build.id, target.key)
    const nextQuery = stored?.query ?? ''
    const nextLimit = stored?.resultLimit ?? 100
    setPicker(target)
    setQuery(nextQuery)
    setCandidateLimit(nextLimit)
    commitBuildPickerRouteState({ buildId: build.id, pickerKey: target.key, query: nextQuery, resultLimit: nextLimit }, 'push')
  }
  const closePicker = () => {
    setPicker(undefined)
    closeBuildPickerRoute()
  }
  useEffect(() => {
    const restore = () => {
      const route = readBuildPickerRouteState()
      if (!route || route.buildId !== build.id) {
        setPicker(undefined)
        return
      }
      const target = targetForKey(route.pickerKey)
      if (!target) return
      setPicker(target)
      setQuery(route.query)
      setCandidateLimit(route.resultLimit)
    }
    restore()
    window.addEventListener('popstate', restore)
    window.addEventListener('hashchange', restore)
    return () => {
      window.removeEventListener('popstate', restore)
      window.removeEventListener('hashchange', restore)
    }
  }, [build.id, ruleset])
  const selectedRef = picker?.key === 'primaryClass' ? draft.primaryClass : picker?.key === 'secondaryClass' ? draft.secondaryClass : picker ? draft.selections[picker.key]?.ref ?? null : null
  const choose = (ref: EntityRef | null) => {
    if (!picker) return
    if (picker.key === 'primaryClass') setDraft((value) => ({ ...value, primaryClass: ref }))
    else if (picker.key === 'secondaryClass') setDraft((value) => ({ ...value, secondaryClass: ref }))
    else setDraft((value) => {
      const selections = equipmentSlotIds.has(picker.key) ? detachAllocation(value.selections, picker.key, equipmentSlotIds) : { ...value.selections }
      selections[picker.key] = ref ? { ref, observedName: entityName(profile, catalogs, ref) } : null
      return { ...value, selections }
    })
    onDirtyChange(true)
    closePicker()
  }
  const groupSelection = (slotId: string, peerSlotId: string) => {
    setDraft((value) => {
      const selections = detachAllocation(value.selections, slotId, equipmentSlotIds)
      const current = selections[slotId]
      if (!current || !peerSlotId) return { ...value, selections }
      const peer = selections[peerSlotId]
      if (!peer || !sameLogicalEntity(profile, peer.ref, current.ref)) return value
      const allocationId = peer.allocationId ?? JSON.stringify(['shared-copy', ...[slotId, peerSlotId].sort()])
      selections[slotId] = { ...current, allocationId }
      selections[peerSlotId] = { ...peer, allocationId }
      return { ...value, selections }
    })
    onDirtyChange(true)
  }
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(undefined); try { await onSubmit({ ...draft, contextAssumptions: assumptions.split('\n').map((value) => value.trim()).filter(Boolean) }); onDirtyChange(false); onCancel?.() } catch (reason) { setError(reason instanceof Error ? reason.message : 'The build revision could not be saved.') } finally { setBusy(false) } }
  const discard = () => { const value = initialDraft(); setDraft(value); setAssumptions(value.contextAssumptions.join('\n')); setError(undefined); onDirtyChange(false); onCancel?.() }
  if (!ruleset) return <InlineNotice title="Configure a ruleset" tone="warning">A pinned ruleset is required before this build can receive a reproducible revision.</InlineNotice>
  const classPicker = (key: 'primaryClass' | 'secondaryClass', label: string, value: EntityRef | null) => <button className="slot" onClick={() => openPicker({ key, label, kinds: ['class'] })} type="button"><span><span className="slot__label">{label}</span><span className="slot__value">{value ? entityName(profile, catalogs, value) : 'Unselected'}</span></span><Icon name="search"/></button>
  return <>
    <form className="stack" onInput={() => onDirtyChange(true)} onSubmit={submit}>
      <div className="grid-2">{classPicker('primaryClass', 'Primary class', draft.primaryClass)}{classPicker('secondaryClass', 'Secondary class', draft.secondaryClass)}</div>
      <div>
        <div className="split"><div><h3>Ordered selections</h3><p className="settings-section__intro">Pick an exact catalog or personal definition. Equal names remain separate identities.</p></div><Badge tone="info">{ruleset.label}</Badge></div>
        <div className="slot-grid">{slots.map((slot) => {
          const selected = draft.selections[slot.id]
          const accepted: readonly CatalogEntityKind[] = slot.acceptedEntityKinds?.state === 'known' ? slot.acceptedEntityKinds.value : slot.kind === 'passive' ? ['passive', 'innate'] : ['item']
          const peers = selected && slot.kind === 'equipment' ? equipmentSlots.filter((candidate) => {
            const candidateSelection = draft.selections[candidate.id]
            return candidate.id !== slot.id && candidateSelection && sameLogicalEntity(profile, candidateSelection.ref, selected.ref)
          }) : []
          const groupedPeer = selected?.allocationId ? peers.find((candidate) => draft.selections[candidate.id]?.allocationId === selected.allocationId) : undefined
          return <div className="slot-entry" key={slot.id}>
            <button className="slot" onClick={() => openPicker({ key: slot.id, label: slot.label, kinds: accepted })} type="button"><span><span className="slot__label">{slot.label}</span><span className="slot__value">{selected ? entityName(profile, catalogs, selected.ref, selected.observedName) : 'Empty slot'}</span></span><Icon name="search"/></button>
            {peers.length > 0 && <Field className="slot-allocation" hint="Group slots only when one physical item occupies both." label="Same copy as"><select aria-label={`${slot.label}: Same copy as`} onChange={(event) => groupSelection(slot.id, event.target.value)} value={groupedPeer?.id ?? ''}><option value="">Separate recorded copy</option>{peers.map((peer) => <option key={peer.id} value={peer.id}>{peer.label}</option>)}</select></Field>}
          </div>
        })}</div>
      </div>
      <Field label="Rotation or use notes"><textarea onChange={(event) => setDraft({ ...draft, rotationNotes: event.target.value || undefined })} placeholder="Optional play notes" value={draft.rotationNotes ?? ''}/></Field>
      <Field hint="One assumption per line. These stay visible in comparisons." label="Context assumptions"><textarea onChange={(event) => setAssumptions(event.target.value)} placeholder="For example: protect the current shield" value={assumptions}/></Field>
      <Field hint="Optional name shown beside the revision number in checkpoint pickers." label="Checkpoint name"><input onChange={(event) => setDraft({ ...draft, note: event.target.value || undefined })} placeholder="For example: shielded support" value={draft.note ?? ''}/></Field>
      {error && <InlineNotice title="Revision not saved" tone="danger">{error} Your selections remain in this editor.</InlineNotice>}
      <div className="form-actions"><Button disabled={busy} onClick={discard} tone="quiet" type="button">{onCancel ? 'Cancel and discard' : 'Discard edits'}</Button><Button disabled={busy} icon="check" type="submit">{busy ? 'Saving...' : 'Save new revision'}</Button></div>
    </form>
    <DefinitionPickerDialog allowEmpty allowUnknown={false} allowedKinds={picker?.kinds ?? []} emptyDescription="Remove the current selection from this draft" emptyLabel="Leave empty" description={`${build.characterId ? profile.characters[build.characterId]?.name ?? 'Character' : 'Template'} · ${ruleset.label}. Candidate type and slot metadata do not assert legality; scenario validation checks learning, PP, and stock after assignment.`} onClose={closePicker} onQueryChange={(nextQuery) => { setQuery(nextQuery); setCandidateLimit(100); if (picker) commitBuildPickerRouteState({ buildId: build.id, pickerKey: picker.key, query: nextQuery, resultLimit: 100 }, 'replace') }} onResultLimitChange={(nextLimit) => { setCandidateLimit(nextLimit); if (picker) commitBuildPickerRouteState({ buildId: build.id, pickerKey: picker.key, query, resultLimit: nextLimit }, 'replace') }} onSelect={(ref) => choose(ref ?? null)} open={Boolean(picker)} query={query} resultLimit={candidateLimit} selected={selectedRef} title={picker ? `Choose ${picker.label}` : 'Choose definition'}/>
  </>
}

function AddScenarioForm({ profile, onCancel, onSubmit }: { profile: Profile; onCancel: () => void; onSubmit: (draft: ScenarioDraft) => Promise<void> }) {
  const activeRuleset = profile.activeRulesetRevisionId ? profile.rulesets[profile.activeRulesetRevisionId] : undefined
  const recorded = Object.values(profile.scenarios).find((scenario) => scenario.kind === 'recordedCurrent')
  const sameLock = Boolean(recorded && activeRuleset && catalogLocksMatch(recorded.catalogLock, activeRuleset.catalogLock))
  const recordedAssignments = recorded ? effectiveScenarioAssignments(recorded) : {}
  const recordedBaselineAvailable = Boolean(recorded && activeRuleset && recorded.rulesetRevisionId === activeRuleset.id && sameLock && Object.keys(recordedAssignments).length)
  const [draft, setDraft] = useState<ScenarioDraft>({ label: '', kind: 'draft', baseline: 'empty', enforceStock: true, includeProtected: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(undefined); try { await onSubmit(draft) } catch (reason) { setError(reason instanceof Error ? reason.message : 'The scenario could not be created.') } finally { setBusy(false) } }
  return <form className="stack" onSubmit={submit}><Field label="Scenario label" required><input autoFocus onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="For example: next boss party" required value={draft.label}/></Field><Field hint="Recorded current parties are created only through the confirmed Record as current flow." label="Context"><select onChange={(event) => setDraft({ ...draft, kind: event.target.value as ScenarioDraft['kind'] })} value={draft.kind}><option value="draft">Draft team</option><option value="hypothetical">Hypothetical team</option></select></Field><Field hint={recordedBaselineAvailable ? 'Copies the compatible recorded party as a pinned baseline. Later scenario changes remain explicit overrides.' : 'A recorded party with the active ruleset and catalog lock is required.'} label="Starting assignments"><select onChange={(event) => setDraft({ ...draft, baseline: event.target.value as ScenarioDraft['baseline'] })} value={draft.baseline}><option value="empty">Start empty</option><option disabled={!recordedBaselineAvailable} value="recordedParty">Copy recorded current party</option></select></Field><label className="check-row"><input checked={draft.enforceStock} onChange={(event) => setDraft({ ...draft, enforceStock: event.target.checked })} type="checkbox"/><span><strong>Check recorded stock</strong><small>Report simultaneous assignments against current observations</small></span></label><label className="check-row"><input checked={draft.includeProtected} onChange={(event) => setDraft({ ...draft, includeProtected: event.target.checked })} type="checkbox"/><span><strong>Allow protected copies</strong><small>Use only when this scenario deliberately includes them</small></span></label>{error && <InlineNotice title="Scenario not created" tone="danger">{error} Your entries remain in this form.</InlineNotice>}<div className="form-actions"><Button onClick={onCancel} tone="quiet" type="button">Cancel</Button><Button disabled={busy || !draft.label.trim()} icon="plus" type="submit">{busy ? 'Creating...' : 'Create scenario'}</Button></div></form>
}

function validationIssueContext(issue: ValidationIssue, profile: Profile, catalogs: readonly CatalogSnapshot[], scenario?: TeamScenario) {
  const details: string[] = []
  if (issue.ref) details.push(entityName(profile, catalogs, issue.ref))
  if (issue.characterId) details.push(profile.characters[issue.characterId]?.name ?? issue.characterId)
  if (issue.ref && scenario) {
    const affected = Object.entries(effectiveScenarioAssignments(scenario)).flatMap(([characterId, revisionId]) => {
      if (!revisionId) return []
      const revision = profile.buildRevisions[revisionId]
      const matches = revision && Object.values(revision.content.selections).some((selection) => selection && entityDefinitionKey(selection.ref) === entityDefinitionKey(issue.ref!))
      return matches ? [profile.characters[characterId]?.name ?? characterId] : []
    })
    if (affected.length) details.push(`Assigned to ${affected.join(', ')}`)
  }
  if (issue.inputs && typeof issue.inputs === 'object' && !Array.isArray(issue.inputs)) {
    const inputs = issue.inputs as Readonly<Record<string, unknown>>
    const demand = typeof inputs.demand === 'number' ? inputs.demand : undefined
    const available = typeof inputs.available === 'number' ? inputs.available : typeof inputs.confirmedAvailable === 'number' ? inputs.confirmedAvailable : undefined
    if (demand !== undefined) details.push(`${demand} required${available !== undefined ? `, ${available} confirmed available` : ''}`)
  }
  return [...new Set(details)].join(' · ')
}

function ValidationPanel({ report, profile, catalogs, scenario }: { report?: ValidationReport; profile: Profile; catalogs: readonly CatalogSnapshot[]; scenario?: TeamScenario }) {
  const labels: Record<string, string> = { structure: 'Structure', equipment: 'Equipment legality', passives: 'Passive legality', characterReadiness: 'Character readiness', inventory: 'Inventory sufficiency', rulesetCertainty: 'Ruleset certainty', calculationReadiness: 'Calculation readiness' }
  if (!report) return <InlineNotice title="Validation awaits a scenario">Assign pinned build revisions to a team to evaluate simultaneous stock and readiness.</InlineNotice>
  return <div className="validation-list">{Object.entries(report.dimensions).map(([dimension, result]) => <div className={`validation-item validation-item--${result.status}`} key={dimension}><span className="validation-item__icon"><Icon name={result.status === 'valid' ? 'check' : result.status === 'invalid' ? 'close' : 'warning'}/></span><div><strong>{labels[dimension] ?? dimension}</strong>{result.status === 'valid' ? <p>No issue found with the known inputs.</p> : result.status === 'notApplicable' ? <p>Not applicable in this scenario.</p> : result.issues.length ? <ul className="validation-issues">{result.issues.map((issue, index) => { const context = validationIssueContext(issue, profile, catalogs, scenario); return <li key={`${issue.code}:${issue.characterId ?? ''}:${issue.slotId ?? ''}:${index}`}>{issue.message}{context ? <small>{context}</small> : null}{issue.suggestion ? <small>{issue.suggestion}</small> : null}</li> })}</ul> : <p>Relevant inputs remain unresolved.</p>}</div></div>)}</div>
}

function ScenarioCard({ scenario, profile, catalogs, validation, onAssign }: { scenario: TeamScenario; profile: Profile; catalogs: readonly CatalogSnapshot[]; validation?: ValidationReport; onAssign: (scenarioId: string, characterId: string, revisionId: string) => Promise<void> }) {
  const characters = Object.values(profile.characters)
  const revisions = Object.values(profile.buildRevisions)
  const effectiveAssignments = effectiveScenarioAssignments(scenario)
  const [assignmentError, setAssignmentError] = useState<string>()
  const assign = async (characterId: string, revisionId: string) => {
    if (scenario.kind === 'recordedCurrent') return
    setAssignmentError(undefined)
    try { await onAssign(scenario.id, characterId, revisionId) } catch (reason) { setAssignmentError(reason instanceof Error ? reason.message : 'The scenario assignment could not be saved.') }
  }
  return <article className="panel" id={`scenario-${scenario.id}`}><header className="panel__header"><div><div className="cluster"><h2>{scenario.label}</h2><Badge tone={scenario.kind === 'recordedCurrent' ? 'positive' : scenario.kind === 'hypothetical' ? 'warning' : 'info'}>{scenario.kind === 'recordedCurrent' ? 'Recorded current' : scenario.kind === 'hypothetical' ? 'Hypothetical' : 'Draft team'}</Badge></div><p>{scenario.inventoryPolicy.enforceStock ? 'Stock checks enabled' : 'Stock checks informational'} · {scenario.inventoryPolicy.includeProtected ? 'Protected copies allowed' : 'Protected copies excluded'}</p></div></header><div className="panel__body stack">{scenario.kind === 'recordedCurrent' && <InlineNotice title="Recorded assignments follow confirmed observations">Use a build's Record as current action after applying it in game. Draft and hypothetical scenarios remain directly editable.</InlineNotice>}<div className="grid-2">{characters.map((character) => <Field hint={scenario.kind === 'recordedCurrent' ? 'Record a pinned build as current to change this assignment.' : undefined} key={character.id} label={character.name}><select disabled={scenario.kind === 'recordedCurrent'} onChange={(event) => void assign(character.id, event.target.value)} value={effectiveAssignments[character.id] ?? ''}><option value="">No build assigned</option>{revisions.filter((revision) => { const build = profile.builds[revision.buildId]; return build && (!build.characterId || build.characterId === character.id) }).map((revision) => <option key={revision.id} value={revision.id}>{revisionOptionLabel(profile, revision)}</option>)}</select></Field>)}</div>{assignmentError && <InlineNotice title="Assignment not saved" tone="danger">{assignmentError} The prior pinned assignment remains active.</InlineNotice>}<ValidationPanel catalogs={catalogs} profile={profile} report={validation} scenario={scenario}/></div></article>
}

export function BuildsView({ profile, catalogs, validations, onCreateBuild, onCloneBuild, onSaveRevision, onCreateScenario, onAssign, onRecordCurrent, onOpenSettings, onDraftChange }: { profile: Profile; catalogs: readonly CatalogSnapshot[]; validations: Readonly<Record<string, ValidationReport | undefined>>; onCreateBuild: (draft: BuildDraft) => Promise<void>; onCloneBuild: (buildId: string) => Promise<string>; onSaveRevision: (buildId: string, draft: RevisionDraft) => Promise<void>; onCreateScenario: (draft: ScenarioDraft) => Promise<void>; onAssign: (scenarioId: string, characterId: string, revisionId: string) => Promise<void>; onRecordCurrent: (buildId: string) => Promise<void>; onOpenSettings: () => void; onDraftChange: (dirty: boolean) => void }) {
  const initialPickerRoute = readBuildPickerRouteState()
  const allBuilds = Object.values(profile.builds).filter((build) => build.state !== 'archived')
  const scenarios = Object.values(profile.scenarios)
  const revisions = Object.values(profile.buildRevisions).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const [section, setSection] = useState<BuildsSection>('library')
  const [addingBuild, setAddingBuild] = useState(false)
  const [addingScenario, setAddingScenario] = useState(false)
  const [selectedId, setSelectedId] = useState<string | undefined>(() => initialPickerRoute?.buildId)
  const [buildQuery, setBuildQuery] = useState('')
  const [editingMobile, setEditingMobile] = useState(() => Boolean(initialPickerRoute && typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches))
  const [leftRevision, setLeftRevision] = useState<string>('')
  const [rightRevision, setRightRevision] = useState<string>('')
  const [editorBases, setEditorBases] = useState<Record<string, string>>({})
  const [recordingCurrent, setRecordingCurrent] = useState(false)
  const [currentConfirmed, setCurrentConfirmed] = useState(false)
  const [recordingBusy, setRecordingBusy] = useState(false)
  const [recordingError, setRecordingError] = useState<string>()
  const [editorDirty, setEditorDirty] = useState(false)
  const [draftGuard, setDraftGuard] = useState<string>()
  const [mobileCloseWarning, setMobileCloseWarning] = useState<string>()
  const [cloneBusy, setCloneBusy] = useState(false)
  const [cloneError, setCloneError] = useState<string>()
  useSearchTarget((target) => {
    if (target.kind === 'build' && profile.builds[target.buildId]) {
      setSection('library')
      setSelectedId(target.buildId)
      setBuildQuery('')
    }
    if (target.kind === 'scenario' && profile.scenarios[target.scenarioId]) {
      setSection('teams')
      window.requestAnimationFrame(() => document.getElementById(`scenario-${target.scenarioId}`)?.scrollIntoView({ block: 'start' }))
    }
  })
  useEffect(() => {
    const restorePickerBuild = () => {
      const route = readBuildPickerRouteState()
      if (!route || !profile.builds[route.buildId]) return
      setSelectedId(route.buildId)
      if (window.matchMedia('(max-width: 820px)').matches) setEditingMobile(true)
    }
    window.addEventListener('popstate', restorePickerBuild)
    window.addEventListener('hashchange', restorePickerBuild)
    return () => {
      window.removeEventListener('popstate', restorePickerBuild)
      window.removeEventListener('hashchange', restorePickerBuild)
    }
  }, [profile.builds])
  const updateEditorDirty = (value: boolean) => { setEditorDirty(value); if (!value) { setDraftGuard(undefined); setMobileCloseWarning(undefined) } onDraftChange(value) }
  const changeSection = (value: BuildsSection) => { if (editorDirty && value !== section) { setDraftGuard('Save or discard the build edits before changing workspace sections.'); return } setSection(value) }
  const selectBuild = (value: string) => { if (editorDirty && value !== selected?.id) { setDraftGuard('Save or discard the build edits before opening another build.'); return } setSelectedId(value) }
  const builds = allBuilds.filter((build) => `${build.title} ${build.tags.join(' ')} ${build.characterId ? profile.characters[build.characterId]?.name ?? '' : 'template'}`.toLocaleLowerCase().includes(buildQuery.trim().toLocaleLowerCase()))
  const selected = profile.builds[selectedId ?? ''] ?? builds[0]
  const selectedScenario = selected?.latestRevisionId ? scenarios.find((scenario) => Object.values(effectiveScenarioAssignments(scenario)).includes(selected.latestRevisionId!)) : undefined
  const selectedRevision = selected?.latestRevisionId ? profile.buildRevisions[selected.latestRevisionId] : undefined
  const recordedScenario = scenarios.find((scenario) => scenario.kind === 'recordedCurrent')
  const forksRecordedParty = Boolean(recordedScenario && selectedRevision && (recordedScenario.rulesetRevisionId !== selectedRevision.rulesetRevisionId || !catalogLocksMatch(recordedScenario.catalogLock, selectedRevision.catalogLock)))
  const selectedBuildRevisions = selected ? revisions.filter((revision) => revision.buildId === selected.id) : []
  const editorBaseRevision = selected ? profile.buildRevisions[editorBases[selected.id] ?? selected.latestRevisionId ?? ''] : undefined
  const selectedCharacter = selected?.characterId ? profile.characters[selected.characterId] : undefined
  const currentSnapshot = selectedCharacter?.currentSnapshotId ? selectedCharacter.snapshots[selectedCharacter.currentSnapshotId] : undefined
  const currentChanges = useMemo(() => {
    if (!selectedRevision) return []
    const ruleset = profile.rulesets[selectedRevision.rulesetRevisionId]
    const classes = [
      { label: 'Primary class', before: currentSnapshot?.primaryClass.state === 'known' ? currentSnapshot.primaryClass.value : null, after: selectedRevision.content.primaryClass },
      { label: 'Secondary class', before: currentSnapshot?.secondaryClass.state === 'known' ? currentSnapshot.secondaryClass.value : null, after: selectedRevision.content.secondaryClass },
    ].flatMap((change) => (change.before ? entityDefinitionKey(change.before) : '') === (change.after ? entityDefinitionKey(change.after) : '') ? [] : [{ label: change.label, before: change.before ? entityName(profile, catalogs, change.before) : 'Unrecorded', after: change.after ? entityName(profile, catalogs, change.after) : 'Empty' }])
    const slots = [...(ruleset?.slots ?? [])].sort((left, right) => left.order - right.order).flatMap((slot) => {
      const before = currentSnapshot?.selections[slot.id]
      const after = selectedRevision.content.selections[slot.id]?.ref
      if ((before ? entityDefinitionKey(before) : '') === (after ? entityDefinitionKey(after) : '')) return []
      return [{ label: slot.label, before: before ? entityName(profile, catalogs, before) : 'Empty or unrecorded', after: after ? entityName(profile, catalogs, after) : 'Empty' }]
    })
    return [...classes, ...slots]
  }, [catalogs, currentSnapshot, profile, selectedRevision])
  const differences = useMemo(() => {
    const left = profile.buildRevisions[leftRevision]
    const right = profile.buildRevisions[rightRevision]
    if (!left || !right) return []
    const names = new Map<string, string>()
    for (const definition of Object.values(profile.personalDefinitions)) names.set(entityDefinitionKey({ kind: 'personal', definitionId: definition.id }), `${definition.name} · personal definition`)
    for (const catalog of catalogs) for (const entity of Object.values(catalog.entities)) names.set(entityDefinitionKey({ kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entity.id }), `${entity.name} · ${catalog.id}`)
    const format = (value: unknown) => {
      if (typeof value === 'string') return names.get(value) ?? profile.rulesets[value]?.label ?? value
      if (value && typeof value === 'object' && 'ref' in value && typeof value.ref === 'string') {
        const allocation = 'allocationId' in value && typeof value.allocationId === 'string' ? ' · shared physical copy' : ' · separate recorded copy'
        return `${names.get(value.ref) ?? value.ref}${allocation}`
      }
      return value == null ? 'None' : JSON.stringify(value)
    }
    const summarize = (revision: typeof left) => {
      const ruleset = profile.rulesets[revision.rulesetRevisionId]
      let pp = 0
      let unresolvedPp = 0
      let owned = 0
      let unknownStock = 0
      let missing = 0
      const stockRequirements = new Map<string, { ref: EntityRef; allocations: Set<string> }>()
      const contributions: string[] = []
      const effects: string[] = []
      const definitionRefs = [revision.content.primaryClass, revision.content.secondaryClass, ...Object.values(revision.content.selections).map((selection) => selection?.ref ?? null)].filter((ref): ref is EntityRef => Boolean(ref))
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
      for (const [slotId, selection] of Object.entries(revision.content.selections)) {
        if (!selection) continue
        const definition = resolveEntity(profile, catalogs, selection.ref)
        const slot = ruleset?.slots.find((value) => value.id === slotId)
        if (slot?.kind === 'passive') {
          if (definition?.ppCost?.state === 'known') pp += definition.ppCost.value
          else unresolvedPp += 1
        }
        if (slot?.kind === 'equipment') {
          const key = logicalEntityKey(profile, selection.ref)
          const requirement = stockRequirements.get(key) ?? { ref: selection.ref, allocations: new Set<string>() }
          requirement.allocations.add(selection.allocationId ?? `slot:${slotId}`)
          stockRequirements.set(key, requirement)
        }
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
      return { pp: `${pp} known source PP${unresolvedPp ? ` + ${unresolvedPp} unresolved` : ''}`, stock: `${owned} confirmed · ${unknownStock} uncertain · ${missing} missing`, contributions: summarizeText(contributions, 'No documented numeric contributions'), effects: summarizeText(effects, 'No descriptions or documented effects'), validation: report ? `${scenarioName}: ${statuses?.invalid ?? 0} invalid · ${statuses?.undetermined ?? 0} undetermined` : scenarioName ? `${scenarioName}: validation unavailable` : 'Not assigned to a scenario' }
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
    return [...summaryRows, ...compareBuildRevisions(left, right).differences.map((difference) => ({ label: difference.path.startsWith('content.selections.') ? profile.rulesets[left.rulesetRevisionId]?.slots.find((entry) => entry.id === difference.path.replace('content.selections.', ''))?.label ?? difference.label : difference.label, left: format(difference.left), right: format(difference.right) }))]
  }, [catalogs, leftRevision, profile, rightRevision, validations])
  const createBuild = async (draft: BuildDraft) => { await onCreateBuild(draft); setAddingBuild(false) }
  const createScenario = async (draft: ScenarioDraft) => { await onCreateScenario(draft); setAddingScenario(false) }
  const cloneSelected = async () => {
    if (!selected?.latestRevisionId) return
    setCloneBusy(true)
    setCloneError(undefined)
    try {
      const clonedId = await onCloneBuild(selected.id)
      setSelectedId(clonedId)
      setEditorBases((values) => {
        const next = { ...values }
        delete next[clonedId]
        return next
      })
    } catch (reason) {
      setCloneError(reason instanceof Error ? reason.message : 'The build could not be cloned.')
    } finally {
      setCloneBusy(false)
    }
  }

  return <>
    <ScreenHeader actions={section === 'teams' ? <Button icon="plus" onClick={() => setAddingScenario(true)}>New scenario</Button> : <><Button icon="plus" onClick={() => setAddingBuild(true)}>New build</Button>{section === 'library' && selected?.latestRevisionId && <Button disabled={editorDirty || cloneBusy} icon="layers" onClick={() => void cloneSelected()} tone="secondary">{cloneBusy ? 'Cloning...' : 'Clone build'}</Button>}{section === 'library' && selectedRevision && selectedCharacter && selected?.state !== 'recordedCurrent' && <Button disabled={editorDirty} icon="check" onClick={() => { setRecordingError(undefined); setRecordingCurrent(true) }} tone="secondary">Record as current</Button>}</>} description="Create pinned build revisions, assemble alternative teams, and keep validation dimensions explained." eyebrow="Planning table" title="Builds & teams"/>
    <div className="toolbar"><Segmented label="Build workspace" onChange={changeSection} options={[{ value: 'library', label: 'Build library' }, { value: 'teams', label: 'Team scenarios' }, { value: 'compare', label: 'Compare revisions' }]} value={section}/>{section === 'library' && allBuilds.length > 0 && <div className="search-field"><Icon name="search"/><input aria-label="Search build library" onChange={(event) => setBuildQuery(event.target.value)} placeholder="Search titles, tags, characters" type="search" value={buildQuery}/></div>}</div>{draftGuard && <InlineNotice title="Build edits are still open" tone="warning">{draftGuard}</InlineNotice>}{cloneError && <InlineNotice title="Build not cloned" tone="danger">{cloneError} The original build and checkpoint remain unchanged.</InlineNotice>}
    {section === 'library' && (builds.length === 0 ? <EmptyState aside={profile.activeRulesetRevisionId ? <>A saved alternative does not reserve inventory. Stock is evaluated only when a pinned revision joins a scenario.</> : <>Build revisions need a ruleset with configured slots. Set one up first, then return here to plan.</>} description="Create a character-bound build or reusable template. Drafts remain separate from the recorded current party until you explicitly apply them." icon="layers" title={allBuilds.length ? 'No builds match this search' : 'No builds yet'}>{allBuilds.length ? <Button onClick={() => setBuildQuery('')} tone="secondary">Clear search</Button> : profile.activeRulesetRevisionId ? <Button icon="plus" onClick={() => setAddingBuild(true)}>Create a build</Button> : <Button icon="settings" onClick={onOpenSettings}>Configure ruleset</Button>}</EmptyState> : <div className="build-layout">
      <section className="build-column"><header className="build-column__header"><div className="split"><div><h2>Library</h2><p>{builds.length} matching {builds.length === 1 ? 'build' : 'builds'}</p></div><IconButton icon="plus" label="Create build" onClick={() => setAddingBuild(true)}/></div></header><div className="build-column__body">{builds.map((build) => <button aria-current={selected?.id === build.id ? 'true' : undefined} className="build-card" key={build.id} onClick={() => selectBuild(build.id)} type="button"><div className="split"><strong>{build.title}</strong><Badge tone={build.state === 'recordedCurrent' ? 'positive' : build.state === 'hypothetical' ? 'warning' : 'info'}>{build.state === 'recordedCurrent' ? 'Current' : build.state === 'hypothetical' ? 'Hypothetical' : 'Draft'}</Badge></div><small>{build.characterId ? profile.characters[build.characterId]?.name ?? 'Unresolved character' : 'Reusable template'} · {build.latestRevisionId ? `revision ${profile.buildRevisions[build.latestRevisionId]?.revision}` : 'no revision'}</small>{build.tags.length > 0 && <div className="cluster">{build.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}</div>}</button>)}{selected && <Button className="mobile-edit-build" icon="edit" onClick={() => setEditingMobile(true)} tone="secondary">Edit selected build</Button>}</div></section>
      <section className="build-column"><header className="build-column__header"><h2>{selected?.title ?? 'Build editor'}</h2><p>{selected?.latestRevisionId ? 'Changes save as a new immutable revision' : 'Create the first pinned revision'}</p>{selectedBuildRevisions.length > 0 && <Field hint={editorBaseRevision?.id !== selected?.latestRevisionId ? 'Saving creates a new latest revision using this older checkpoint as the content base.' : 'Inspect or edit the latest pinned checkpoint.'} label="Editor checkpoint"><select disabled={editorDirty} onChange={(event) => selected && setEditorBases((values) => ({ ...values, [selected.id]: event.target.value }))} value={editorBaseRevision?.id ?? ''}>{selectedBuildRevisions.map((revision) => <option key={revision.id} value={revision.id}>r{revision.revision}{checkpointSuffix(revision)} · {formatRelativeDate(revision.createdAt)}</option>)}</select></Field>}</header><div className="build-column__body">{selected && !editingMobile && <RevisionEditor build={selected} catalogs={catalogs} key={`${selected.id}:${selected.latestRevisionId ?? 'new'}:${editorBaseRevision?.id ?? 'new'}`} onDirtyChange={updateEditorDirty} onSubmit={async (draft) => { await onSaveRevision(selected.id, draft); setEditorBases((values) => { const next = { ...values }; delete next[selected.id]; return next }) }} profile={profile} sourceRevision={editorBaseRevision}/>}</div></section>
      <aside className="build-column"><header className="build-column__header"><h2>Readiness</h2><p>{selectedScenario ? `Evaluated in ${selectedScenario.label}` : 'Assign this revision to a scenario'}</p></header><div className="build-column__body"><ValidationPanel catalogs={catalogs} profile={profile} report={selectedScenario ? validations[selectedScenario.id] : undefined} scenario={selectedScenario}/>{selected?.latestRevisionId && <div className="settings-section"><h3>Pinned checkpoint</h3><dl className="definition-list">{profile.buildRevisions[selected.latestRevisionId]?.note?.trim() && <div className="definition-row"><dt>Name</dt><dd>{profile.buildRevisions[selected.latestRevisionId]?.note}</dd></div>}<div className="definition-row"><dt>Revision</dt><dd>{profile.buildRevisions[selected.latestRevisionId]?.revision}</dd></div><div className="definition-row"><dt>Saved</dt><dd>{formatRelativeDate(profile.buildRevisions[selected.latestRevisionId]?.createdAt)}</dd></div><div className="definition-row"><dt>Ruleset</dt><dd>{profile.rulesets[profile.buildRevisions[selected.latestRevisionId]?.rulesetRevisionId]?.label ?? 'Unresolved'}</dd></div></dl></div>}</div></aside>
    </div>)}
    {section === 'teams' && (scenarios.length === 0 ? <EmptyState aside={<>A scenario is the boundary for simultaneous inventory use. Alternative scenarios may each use the same recorded copy.</>} description="Create a draft, hypothetical, or recorded-current team, then pin one build revision per participating character." icon="team" title="No team scenarios"><Button icon="plus" onClick={() => setAddingScenario(true)}>Create a scenario</Button></EmptyState> : <div className="stack">{scenarios.map((scenario) => <ScenarioCard catalogs={catalogs} key={scenario.id} onAssign={onAssign} profile={profile} scenario={scenario} validation={validations[scenario.id]}/>)}</div>)}
    {section === 'compare' && <div className="stack"><div className="panel"><div className="panel__body grid-2"><Field label="Revision A"><select onChange={(event) => setLeftRevision(event.target.value)} value={leftRevision}><option value="">Choose revision</option>{revisions.map((revision) => <option key={revision.id} value={revision.id}>{revisionOptionLabel(profile, revision)}</option>)}</select></Field><Field label="Revision B"><select onChange={(event) => setRightRevision(event.target.value)} value={rightRevision}><option value="">Choose revision</option>{revisions.map((revision) => <option key={revision.id} value={revision.id}>{revisionOptionLabel(profile, revision)}</option>)}</select></Field></div></div>{leftRevision && rightRevision ? differences.length ? <div className="comparison-grid"><section className="comparison-column"><h2>{profile.builds[profile.buildRevisions[leftRevision]?.buildId]?.title}</h2>{differences.map((row) => <div className="comparison-row" key={row.label}><small>{row.label}</small><strong>{row.left}</strong></div>)}</section><section className="comparison-column"><h2>{profile.builds[profile.buildRevisions[rightRevision]?.buildId]?.title}</h2>{differences.map((row) => <div className="comparison-row" key={row.label}><small>{row.label}</small><strong>{row.right}</strong></div>)}</section></div> : <InlineNotice title="Selections match">These revisions have no descriptive differences in class or ordered selections.</InlineNotice> : <EmptyState description="Choose two immutable build revisions. The comparison explains changed selections without producing an opaque score." icon="compare" title="Select revisions to compare"/>}</div>}
    <Sheet onClose={() => setAddingBuild(false)} open={addingBuild} title="Create build"><AddBuildForm onCancel={() => setAddingBuild(false)} onSubmit={createBuild} profile={profile}/></Sheet>
    <Sheet onClose={() => setAddingScenario(false)} open={addingScenario} title="Create team scenario"><AddScenarioForm onCancel={() => setAddingScenario(false)} onSubmit={createScenario} profile={profile}/></Sheet>
    <Sheet description="Selections save together as one new revision." onClose={() => { setEditingMobile(false); updateEditorDirty(false) }} onRequestClose={() => { if (!editorDirty) return true; setMobileCloseWarning('Save the revision or choose Cancel and discard before closing this editor.'); return false }} open={editingMobile} title={selected?.title ?? 'Edit build'} width="wide">{mobileCloseWarning && <InlineNotice title="Build draft still open" tone="warning">{mobileCloseWarning}</InlineNotice>}{selected && <RevisionEditor build={selected} catalogs={catalogs} key={`${selected.id}:${selected.latestRevisionId ?? 'new'}:${editorBaseRevision?.id ?? 'new'}:mobile`} onCancel={() => { setEditingMobile(false); updateEditorDirty(false) }} onDirtyChange={updateEditorDirty} onSubmit={async (draft) => { await onSaveRevision(selected.id, draft); setEditorBases((values) => { const next = { ...values }; delete next[selected.id]; return next }) }} profile={profile} sourceRevision={editorBaseRevision}/>}</Sheet>
    <Sheet description="This changes the tracker only after you confirm the build was applied in game." onClose={() => { setRecordingCurrent(false); setCurrentConfirmed(false) }} open={recordingCurrent} title="Record build as current"><div className="stack"><InlineNotice title="No game connection">Crystal Companion cannot apply this build to Crystal Project. Confirm only after making the changes yourself. Existing PP capacity and displayed final stats will be marked for recapture because this configuration changed; a known character level is preserved.</InlineNotice>{forksRecordedParty && <InlineNotice title="This starts a new recorded-party ruleset" tone="warning">The existing recorded current party uses another ruleset. It will remain available as a draft scenario, while the new recorded party starts with only {selectedCharacter?.name ?? 'this character'}. Add other members after recording compatible build revisions.</InlineNotice>}<div className="panel"><div className="panel__header"><div><h3>{selected?.title}</h3><p>{selectedCharacter?.name} · revision {selectedRevision?.revision}</p></div></div><div className="panel__body">{currentChanges.length ? <dl className="definition-list">{currentChanges.map((change) => <div className="definition-row" key={change.label}><dt>{change.label}</dt><dd><span className="status-change">{change.before}</span> → {change.after}</dd></div>)}</dl> : <InlineNotice title="No slot changes detected">The recorded snapshot and selected revision use the same known slot references. Class or unknown-field differences may still remain.</InlineNotice>}</div></div>{recordingError && <InlineNotice title="Current build not recorded" tone="danger">{recordingError} This confirmation remains open so you can retry.</InlineNotice>}{selectedScenario && validations[selectedScenario.id]?.issues.length ? <InlineNotice title="Validation issues remain" tone="warning">{validations[selectedScenario.id]?.issues.length} checks are invalid or undetermined in {selectedScenario.label}. The observation can still be recorded without declaring those rules valid.</InlineNotice> : null}<label className="check-row"><input checked={currentConfirmed} onChange={(event) => setCurrentConfirmed(event.target.checked)} type="checkbox"/><span><strong>I made these changes in game</strong><small>Record this pinned revision as the tracker's current configuration</small></span></label><div className="form-actions"><Button onClick={() => { setRecordingCurrent(false); setCurrentConfirmed(false) }} tone="quiet">Cancel</Button><Button disabled={!currentConfirmed || recordingBusy} icon="check" onClick={() => { if (!selected) return; setRecordingBusy(true); void onRecordCurrent(selected.id).then(() => { setRecordingCurrent(false); setCurrentConfirmed(false) }).catch((reason: unknown) => setRecordingError(reason instanceof Error ? reason.message : 'The current build could not be recorded.')).finally(() => setRecordingBusy(false)) }}>{recordingBusy ? 'Recording...' : 'Record as current'}</Button></div></div></Sheet>
  </>
}
