import { useMemo, useState, type FormEvent } from 'react'
import { entityDefinitionKey } from '../domain'
import type {
  CatalogEntityKind,
  CatalogSnapshot,
  CharacterClassProgress,
  CharacterId,
  CharacterSnapshot,
  EntityRef,
  Knowledge,
  LearnedNode,
  LearnedNodeKind,
  ObservedStat,
  Profile,
  SlotDefinition,
} from '../domain/types'
import { Badge, Button, DefinitionRow, EmptyState, Field, IconButton, InlineNotice, ScreenHeader } from './components'
import { entityName, formatRelativeDate, initials, knowledgeLabel } from './model'
import { Sheet } from './Sheet'
import { DefinitionPickerField } from './definitions'
import { useSearchTarget } from './use-search-target'

const UNKNOWN_NUMBER: Knowledge<number> = { state: 'unknown' }
const UNKNOWN_BOOLEAN: Knowledge<boolean> = { state: 'unknown' }
const UNKNOWN_REF: Knowledge<EntityRef> = { state: 'unknown' }

export interface CharacterDraft {
  readonly name: string
  readonly appearanceLabel?: string
}

export interface SnapshotDraft {
  readonly level: Knowledge<number>
  readonly primaryClass: Knowledge<EntityRef>
  readonly secondaryClass: Knowledge<EntityRef>
  readonly displayedStats: Readonly<Record<string, ObservedStat>>
  readonly ppCapacity: Knowledge<number>
  readonly observedAt?: string
  readonly note?: string
  readonly selections: Readonly<Record<string, EntityRef | null>>
}

export interface ClassProgressDraft {
  readonly classRef: EntityRef
  readonly unlocked: Knowledge<boolean>
  readonly coreTreeComplete: Knowledge<boolean>
  readonly mastered: Knowledge<boolean>
  readonly observedLp: Knowledge<number>
}

export interface LearnedNodeDraft {
  readonly ref: EntityRef
  readonly kind: LearnedNodeKind
  readonly learned: Knowledge<boolean>
  readonly actualPaidLp: Knowledge<number>
}

export interface CharactersViewProps {
  readonly profile: Profile
  readonly catalogs: readonly CatalogSnapshot[]
  readonly onAdd: (draft: CharacterDraft) => Promise<void>
  readonly onCapture: (characterId: CharacterId, draft: SnapshotDraft) => Promise<void>
  readonly onUpsertClass: (characterId: CharacterId, draft: ClassProgressDraft) => Promise<void>
  readonly onUpsertLearned: (characterId: CharacterId, draft: LearnedNodeDraft) => Promise<void>
}

interface StatRow {
  readonly id: number
  readonly key: string
  readonly unit: string
  readonly value: Knowledge<number>
}

function kindLabel(kind: CatalogEntityKind | LearnedNodeKind): string {
  if (kind === 'monsterMagic') return 'Monster Magic'
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

function selectedRef(value: Knowledge<EntityRef>): EntityRef | undefined {
  return value.state === 'known' ? value.value : undefined
}

function NumberKnowledgeField({ label, hint, min, value, onChange }: {
  readonly label: string
  readonly hint?: string
  readonly min: number
  readonly value: Knowledge<number>
  readonly onChange: (value: Knowledge<number>) => void
}) {
  const specialState = value.state === 'conflicting' || value.state === 'notApplicable' ? value.state : undefined
  return <div className="field">
    <span className="field__label">{label}</span>
    <select aria-label={`${label} certainty`} onChange={(event) => onChange(event.target.value === 'known' ? { state: 'known', value: min } : { state: 'unknown' })} value={value.state}>
      <option value="unknown">Unknown</option>
      <option value="known">Known</option>
      {specialState === 'conflicting' && <option disabled value="conflicting">Conflicting claims</option>}
      {specialState === 'notApplicable' && <option disabled value="notApplicable">Not applicable</option>}
    </select>
    {value.state === 'known' && <input aria-label={label} inputMode="numeric" min={min} onChange={(event) => onChange({ state: 'known', value: event.target.valueAsNumber })} required type="number" value={value.value}/>}
    {hint && <span className="field__hint">{hint}</span>}
  </div>
}

function BooleanKnowledgeField({ label, value, onChange }: {
  readonly label: string
  readonly value: Knowledge<boolean>
  readonly onChange: (value: Knowledge<boolean>) => void
}) {
  const selected = value.state === 'known' ? String(value.value) : value.state
  const specialState = value.state === 'conflicting' || value.state === 'notApplicable' ? value.state : undefined
  return <Field label={label}><select onChange={(event) => onChange(event.target.value === 'true' ? { state: 'known', value: true } : event.target.value === 'false' ? { state: 'known', value: false } : { state: 'unknown' })} value={selected}>
    <option value="unknown">Unknown</option>
    <option value="true">Yes</option>
    <option value="false">No</option>
    {specialState === 'conflicting' && <option disabled value="conflicting">Conflicting claims</option>}
    {specialState === 'notApplicable' && <option disabled value="notApplicable">Not applicable</option>}
  </select></Field>
}

function AddCharacterForm({ onCancel, onSubmit }: { readonly onCancel: () => void; readonly onSubmit: (draft: CharacterDraft) => Promise<void> }) {
  const [draft, setDraft] = useState<CharacterDraft>({ name: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try { await onSubmit(draft) } catch (reason) { setError(reason instanceof Error ? reason.message : 'The character could not be added.') } finally { setBusy(false) }
  }
  return <form className="stack" onSubmit={submit}><Field label="Character name" required><input autoFocus onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Name used in your playthrough" required value={draft.name}/></Field><Field hint="Optional visual shorthand, kept separate from identity." label="Appearance label"><input onChange={(event) => setDraft({ ...draft, appearanceLabel: event.target.value || undefined })} placeholder="For example: blue cloak" value={draft.appearanceLabel ?? ''}/></Field><InlineNotice title="Blank character record">Creating a character does not infer classes, equipment, mastery, or learned abilities.</InlineNotice>{error && <InlineNotice title="Character not added" tone="danger">{error}</InlineNotice>}<div className="form-actions"><Button onClick={onCancel} tone="quiet" type="button">Cancel</Button><Button disabled={busy || !draft.name.trim()} icon="plus" type="submit">{busy ? 'Adding...' : 'Add character'}</Button></div></form>
}

function snapshotDraft(initial?: CharacterSnapshot): SnapshotDraft {
  return {
    level: initial?.level ?? UNKNOWN_NUMBER,
    primaryClass: initial?.primaryClass ?? UNKNOWN_REF,
    secondaryClass: initial?.secondaryClass ?? UNKNOWN_REF,
    displayedStats: initial?.displayedStats ?? {},
    ppCapacity: initial?.ppCapacity ?? UNKNOWN_NUMBER,
    selections: initial?.selections ?? {},
  }
}

function snapshotStatRows(initial?: CharacterSnapshot): StatRow[] {
  return Object.entries(initial?.displayedStats ?? {}).map(([key, stat], index) => ({ id: index, key, unit: stat.unit, value: stat.value }))
}

function slotEntityKinds(slot: SlotDefinition): readonly CatalogEntityKind[] {
  if (slot.acceptedEntityKinds?.state === 'known' && slot.acceptedEntityKinds.value.length > 0) {
    return slot.acceptedEntityKinds.value
  }
  return slot.kind === 'passive' ? ['passive', 'innate'] : ['item']
}

function SnapshotForm({ profile, initial, onCancel, onSubmit }: {
  readonly profile: Profile
  readonly initial?: CharacterSnapshot
  readonly onCancel: () => void
  readonly onSubmit: (draft: SnapshotDraft) => Promise<void>
}) {
  const ruleset = profile.activeRulesetRevisionId ? profile.rulesets[profile.activeRulesetRevisionId] : undefined
  const [draft, setDraft] = useState<SnapshotDraft>(() => snapshotDraft(initial))
  const [stats, setStats] = useState<StatRow[]>(() => snapshotStatRows(initial))
  const [nextStatId, setNextStatId] = useState(stats.length)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    const namedStats = stats.filter((stat) => stat.key.trim()).map((stat) => ({ ...stat, key: stat.key.trim() }))
    const names = new Set<string>()
    const duplicateName = namedStats.find((stat) => {
      if (names.has(stat.key)) return true
      names.add(stat.key)
      return false
    })
    if (duplicateName) {
      setError('Displayed stat names must be unique after trimming whitespace.')
      return
    }
    setBusy(true)
    const displayedStats = Object.fromEntries(namedStats.map((stat) => [stat.key, { value: stat.value, unit: stat.unit.trim() || 'displayed' }]))
    try { await onSubmit({ ...draft, displayedStats }) } catch (reason) { setError(reason instanceof Error ? reason.message : 'The snapshot could not be saved.') } finally { setBusy(false) }
  }
  const updateStat = (id: number, patch: Partial<StatRow>) => setStats((current) => current.map((stat) => stat.id === id ? { ...stat, ...patch } : stat))
  return <form className="stack" onSubmit={submit}>
    {initial && <InlineNotice title="Starting from the latest snapshot">Review the carried-forward values before saving this new observation. The observation date and note start blank.</InlineNotice>}
    <div className="grid-2"><NumberKnowledgeField hint="Record the displayed value only." label="Level" min={1} onChange={(level) => setDraft({ ...draft, level })} value={draft.level}/><NumberKnowledgeField hint="Displayed capacity, not inferred from selections." label="PP capacity" min={0} onChange={(ppCapacity) => setDraft({ ...draft, ppCapacity })} value={draft.ppCapacity}/></div>
    <div className="grid-2"><DefinitionPickerField allowedKinds={['class']} label="Primary class" onChange={(ref) => setDraft({ ...draft, primaryClass: ref ? { state: 'known', value: ref } : UNKNOWN_REF })} value={selectedRef(draft.primaryClass)}/><DefinitionPickerField allowedKinds={['class']} label="Secondary class" onChange={(ref) => setDraft({ ...draft, secondaryClass: ref ? { state: 'known', value: ref } : UNKNOWN_REF })} value={selectedRef(draft.secondaryClass)}/></div>
    <div className="stack"><div className="split"><div><h3>Displayed final stats</h3><p className="settings-section__intro">Record only totals visible on the character screen.</p></div><Button onClick={() => { setStats((current) => [...current, { id: nextStatId, key: '', unit: 'displayed', value: UNKNOWN_NUMBER }]); setNextStatId((value) => value + 1) }} tone="secondary" type="button">Add stat</Button></div>{stats.length === 0 ? <InlineNotice title="No displayed stats recorded">Unlisted stats remain unrecorded and are never treated as zero.</InlineNotice> : stats.map((stat) => <div className="grid-3" key={stat.id}><Field label="Stat name" required><input onChange={(event) => updateStat(stat.id, { key: event.target.value })} placeholder="For example: Max HP" required value={stat.key}/></Field><NumberKnowledgeField label="Displayed value" min={0} onChange={(value) => updateStat(stat.id, { value })} value={stat.value}/><div className="field"><span className="field__label">Unit</span><input aria-label="Stat unit" onChange={(event) => updateStat(stat.id, { unit: event.target.value })} placeholder="displayed" value={stat.unit}/><Button onClick={() => setStats((current) => current.filter((entry) => entry.id !== stat.id))} tone="quiet" type="button">Remove stat</Button></div></div>)}</div>
    {ruleset?.slots.length ? <div className="stack"><div><h3>Observed selections</h3><p className="settings-section__intro">Each saved choice keeps its exact personal or catalog identity. Candidate lists do not assert legality.</p></div><div className="grid-2">{[...ruleset.slots].sort((left, right) => left.order - right.order).map((slot) => {
      const kinds = slotEntityKinds(slot)
      const observed = Object.prototype.hasOwnProperty.call(draft.selections, slot.id)
      const selection = draft.selections[slot.id]
      const setSelection = (ref: EntityRef | null | undefined) => setDraft((current) => {
        const selections = { ...current.selections }
        if (ref === undefined) delete selections[slot.id]
        else selections[slot.id] = ref
        return { ...current, selections }
      })
      return <DefinitionPickerField allowEmpty allowedKinds={kinds} hint="Choose unknown when the slot was not checked, or observed empty when you confirmed it had no selection." key={slot.id} label={slot.label} onChange={setSelection} value={observed ? selection : undefined}/>
    })}</div></div> : <InlineNotice title="No slots configured">Configure an active ruleset to capture ordered equipment and passive slots in this snapshot.</InlineNotice>}
    <div className="grid-2"><Field label="Observed on"><input onChange={(event) => setDraft({ ...draft, observedAt: event.target.value || undefined })} type="date" value={draft.observedAt ?? ''}/></Field><Field label="Snapshot note"><input onChange={(event) => setDraft({ ...draft, note: event.target.value || undefined })} placeholder="Optional context" value={draft.note ?? ''}/></Field></div>
    <InlineNotice title="Observed totals stay observed">Displayed values are not recalculated or treated as base stats. Personal definitions are saved separately from this observation.</InlineNotice>
    {error && <InlineNotice title="Snapshot not saved" tone="danger">{error} Your entered values remain in this form.</InlineNotice>}
    <div className="form-actions"><Button onClick={onCancel} tone="quiet" type="button">Cancel</Button><Button disabled={busy} icon="check" type="submit">{busy ? 'Saving...' : 'Save snapshot'}</Button></div>
  </form>
}

function ClassProgressForm({ initial, onCancel, onSubmit }: {
  readonly initial?: CharacterClassProgress
  readonly onCancel: () => void
  readonly onSubmit: (draft: ClassProgressDraft) => Promise<void>
}) {
  const [classRef, setClassRef] = useState<EntityRef | undefined>(initial?.classRef)
  const [unlocked, setUnlocked] = useState(initial?.unlocked ?? UNKNOWN_BOOLEAN)
  const [coreTreeComplete, setCoreTreeComplete] = useState(initial?.coreTreeComplete ?? UNKNOWN_BOOLEAN)
  const [mastered, setMastered] = useState(initial?.mastered ?? UNKNOWN_BOOLEAN)
  const [observedLp, setObservedLp] = useState(initial?.observedLp ?? UNKNOWN_NUMBER)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!classRef) return
    setBusy(true)
    setError(undefined)
    try { await onSubmit({ classRef, unlocked, coreTreeComplete, mastered, observedLp }) } catch (reason) { setError(reason instanceof Error ? reason.message : 'The class observation could not be saved.') } finally { setBusy(false) }
  }
  return <form className="stack" onSubmit={submit}>
    <DefinitionPickerField allowedKinds={['class']} disabled={Boolean(initial)} hint={initial ? 'The linked class identity stays unchanged while its observed facts are edited.' : 'Choose an exact reference or create a personal class definition.'} label="Class" onChange={(value) => setClassRef(value ?? undefined)} value={classRef}/>
    <div className="grid-3"><BooleanKnowledgeField label="Unlocked" onChange={setUnlocked} value={unlocked}/><BooleanKnowledgeField label="Core tree complete" onChange={setCoreTreeComplete} value={coreTreeComplete}/><BooleanKnowledgeField label="Mastered" onChange={setMastered} value={mastered}/></div>
    <NumberKnowledgeField hint="Leave unknown when the displayed LP was not checked." label="Observed LP" min={0} onChange={setObservedLp} value={observedLp}/>
    <InlineNotice title="Character-specific progress">This record does not change party-wide collection, class progress, or another character.</InlineNotice>
    {error && <InlineNotice title="Class progress not saved" tone="danger">{error}</InlineNotice>}
    <div className="form-actions"><Button onClick={onCancel} tone="quiet" type="button">Cancel</Button><Button disabled={busy || !classRef} icon="check" type="submit">{busy ? 'Saving...' : 'Save class progress'}</Button></div>
  </form>
}

function LearnedNodeForm({ initial, defaultKind, lockedKind, onCancel, onSubmit }: {
  readonly initial?: LearnedNode
  readonly defaultKind: LearnedNodeKind
  readonly lockedKind?: LearnedNodeKind
  readonly onCancel: () => void
  readonly onSubmit: (draft: LearnedNodeDraft) => Promise<void>
}) {
  const [kind, setKind] = useState<LearnedNodeKind>(initial?.kind ?? defaultKind)
  const [ref, setRef] = useState<EntityRef | undefined>(initial?.ref)
  const [learned, setLearned] = useState(initial?.learned ?? UNKNOWN_BOOLEAN)
  const [actualPaidLp, setActualPaidLp] = useState(initial?.actualPaidLp ?? UNKNOWN_NUMBER)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const kinds: readonly LearnedNodeKind[] = lockedKind ? [lockedKind] : ['ability', 'passive', 'innate']
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ref) return
    setBusy(true)
    setError(undefined)
    try { await onSubmit({ ref, kind, learned, actualPaidLp }) } catch (reason) { setError(reason instanceof Error ? reason.message : 'The learning observation could not be saved.') } finally { setBusy(false) }
  }
  return <form className="stack" onSubmit={submit}>
    {!lockedKind && <Field label="Knowledge type"><select disabled={Boolean(initial)} onChange={(event) => { setKind(event.target.value as LearnedNodeKind); setRef(undefined) }} value={kind}>{kinds.map((value) => <option key={value} value={value}>{kindLabel(value)}</option>)}</select></Field>}
    <DefinitionPickerField allowedKinds={[kind]} disabled={Boolean(initial)} hint={initial ? 'The linked definition identity stays unchanged while its observed facts are edited.' : 'Names never link records. Select or create the exact definition.'} key={kind} label={kindLabel(kind)} onChange={(value) => setRef(value ?? undefined)} value={ref}/>
    <div className="grid-2"><BooleanKnowledgeField label="Learned" onChange={setLearned} value={learned}/><NumberKnowledgeField hint="Actual observed spend, not a catalog price." label="Paid LP" min={0} onChange={setActualPaidLp} value={actualPaidLp}/></div>
    <InlineNotice title="Explicit learning record">Equipping a selection, mastering a class, or recording party progress does not mark this node learned.</InlineNotice>
    {error && <InlineNotice title="Learning not saved" tone="danger">{error}</InlineNotice>}
    <div className="form-actions"><Button onClick={onCancel} tone="quiet" type="button">Cancel</Button><Button disabled={busy || !ref} icon="check" type="submit">{busy ? 'Saving...' : 'Save learning'}</Button></div>
  </form>
}

type CharacterTab = 'current' | 'classes' | 'knowledge' | 'magic' | 'history'
const tabs: readonly { readonly id: CharacterTab; readonly label: string }[] = [{ id: 'current', label: 'Current' }, { id: 'classes', label: 'Classes' }, { id: 'knowledge', label: 'Abilities & passives' }, { id: 'magic', label: 'Monster Magic' }, { id: 'history', label: 'History' }]

export function CharactersView({ profile, catalogs, onAdd, onCapture, onUpsertClass, onUpsertLearned }: CharactersViewProps) {
  const characters = Object.values(profile.characters)
  const [adding, setAdding] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [classEditor, setClassEditor] = useState<CharacterClassProgress | null>()
  const [learnedEditor, setLearnedEditor] = useState<{ readonly node?: LearnedNode; readonly kind: LearnedNodeKind }>()
  const [selectedId, setSelectedId] = useState<string>()
  const [tab, setTab] = useState<CharacterTab>('current')
  useSearchTarget((target) => {
    if (target.kind !== 'character' || !profile.characters[target.characterId]) return
    setSelectedId(target.characterId)
    setTab('current')
  })
  const selected = profile.characters[selectedId ?? ''] ?? characters[0]
  const snapshot = selected?.currentSnapshotId ? selected.snapshots[selected.currentSnapshotId] : undefined
  const orderedSlots = useMemo(() => {
    const ruleset = profile.activeRulesetRevisionId ? profile.rulesets[profile.activeRulesetRevisionId] : undefined
    return [...(ruleset?.slots ?? [])].sort((left, right) => left.order - right.order)
  }, [profile])

  const add = async (draft: CharacterDraft) => { await onAdd(draft); setAdding(false) }
  const capture = async (draft: SnapshotDraft) => { if (!selected) return; await onCapture(selected.id, draft); setCapturing(false) }
  const saveClass = async (draft: ClassProgressDraft) => { if (!selected) return; await onUpsertClass(selected.id, draft); setClassEditor(undefined) }
  const saveLearned = async (draft: LearnedNodeDraft) => { if (!selected) return; await onUpsertLearned(selected.id, draft); setLearnedEditor(undefined) }
  const classRows = selected ? Object.values(selected.classProgress) : []
  const knowledgeRows = selected ? Object.values(selected.learnedNodes).filter((node) => node.kind !== 'monsterMagic') : []
  const magicRows = selected ? Object.values(selected.learnedNodes).filter((node) => node.kind === 'monsterMagic') : []

  return <>
    <ScreenHeader actions={<Button icon="plus" onClick={() => setAdding(true)}>Add character</Button>} description="Keep observed sheets, individual learning, and class progress distinct from party-wide milestones." eyebrow="Roster journal" title="Characters"/>
    {characters.length === 0 ? <EmptyState aside={<>Character records are personal observations. Party progress, catalog entries, and imported class lists never create roster members.</>} description="Add a character when you are ready to capture a real in-game sheet. Every field can remain unknown until you observe it." icon="user" title="Your roster is blank"><Button icon="plus" onClick={() => setAdding(true)}>Add a character</Button></EmptyState> : <div className="character-layout"><aside className="panel"><div className="panel__header"><div><h2>Roster</h2><p>{characters.length} recorded</p></div><IconButton icon="plus" label="Add character" onClick={() => setAdding(true)}/></div><div className="character-list">{characters.map((character) => <button aria-current={selected?.id === character.id ? 'true' : undefined} className="character-list__item" key={character.id} onClick={() => setSelectedId(character.id)} type="button"><span className="avatar">{initials(character.name)}</span><span><strong>{character.name}</strong><small>{character.currentSnapshotId ? 'Snapshot recorded' : 'Needs first snapshot'}</small></span></button>)}</div></aside><section className="panel"><div className="panel__header"><div><h2>{selected.name}</h2><p>{selected.appearanceLabel ?? 'No appearance label'}</p></div><Button icon="plus" onClick={() => setCapturing(true)} tone="secondary">Capture snapshot</Button></div><div className="panel__body"><div aria-label="Character sections" className="tabs" role="tablist">{tabs.map((item) => <button aria-selected={tab === item.id} className="tab" key={item.id} onClick={() => setTab(item.id)} role="tab" type="button">{item.label}</button>)}</div>
          {tab === 'current' && <div className="stack">{snapshot ? <><div className="metric-grid"><div className="metric"><span className="metric__label">Level</span><span className="metric__value">{knowledgeLabel(snapshot.level)}</span><span className="metric__detail">Observed value</span></div><div className="metric"><span className="metric__label">Primary class</span><span className="metric__value">{snapshot.primaryClass.state === 'known' ? entityName(profile, catalogs, snapshot.primaryClass.value) : knowledgeLabel(snapshot.primaryClass)}</span><span className="metric__detail">Last observed</span></div><div className="metric"><span className="metric__label">Secondary</span><span className="metric__value">{snapshot.secondaryClass.state === 'known' ? entityName(profile, catalogs, snapshot.secondaryClass.value) : knowledgeLabel(snapshot.secondaryClass)}</span><span className="metric__detail">Last observed</span></div><div className="metric"><span className="metric__label">PP capacity</span><span className="metric__value">{knowledgeLabel(snapshot.ppCapacity)}</span><span className="metric__detail">Not calculated</span></div></div>{Object.keys(snapshot.displayedStats).length > 0 && <div><h3>Displayed final stats</h3><dl className="definition-list">{Object.entries(snapshot.displayedStats).map(([key, stat]) => <DefinitionRow key={key} term={key}>{knowledgeLabel(stat.value)} {stat.unit}</DefinitionRow>)}</dl></div>}<div><div className="split"><div><h3>Equipment & passives</h3><p className="settings-section__intro">Ordered by the active ruleset</p></div><Badge tone="info">{formatRelativeDate(snapshot.observedAt)}</Badge></div><div className="slot-grid">{orderedSlots.length ? orderedSlots.map((slot) => { const observed = Object.prototype.hasOwnProperty.call(snapshot.selections, slot.id); const selection = snapshot.selections[slot.id]; return <div className="slot" key={slot.id}><span><span className="slot__label">{slot.label}</span><span className="slot__value">{!observed ? 'Unknown or unrecorded' : selection ? entityName(profile, catalogs, selection) : 'Observed empty'}</span></span><IconButton icon="edit" label={`Edit ${slot.label}`} onClick={() => setCapturing(true)}/></div> }) : <InlineNotice title="No ruleset slots">Add slots under Data & settings to capture ordered selections.</InlineNotice>}</div></div></> : <EmptyState description="Capture only what the game screen shows. Unfilled fields remain explicitly unknown." icon="spark" title="No snapshot recorded"><Button icon="plus" onClick={() => setCapturing(true)}>Capture current sheet</Button></EmptyState>}</div>}
          {tab === 'classes' && <div className="stack"><div className="split"><div><h3>Character class progress</h3><p className="settings-section__intro">Unlock, core-tree, mastery, and LP observations stay independent.</p></div><Button icon="plus" onClick={() => setClassEditor(null)} tone="secondary">Add class</Button></div>{classRows.length ? classRows.map((progress) => <div className="list-row" key={entityDefinitionKey(progress.classRef)}><div className="list-row__primary"><strong>{entityName(profile, catalogs, progress.classRef)}</strong><small>{knowledgeLabel(progress.unlocked, (value) => value ? 'Unlocked' : 'Not unlocked')} · {knowledgeLabel(progress.coreTreeComplete, (value) => value ? 'Core tree complete' : 'Core tree incomplete')}</small></div><Badge tone={progress.mastered.state === 'known' && progress.mastered.value ? 'positive' : 'warning'}>{knowledgeLabel(progress.mastered, (value) => value ? 'Mastered' : 'Not mastered')}</Badge><div className="list-row__fact">LP: {knowledgeLabel(progress.observedLp)}</div><div className="list-row__action"><IconButton icon="edit" label={`Edit ${entityName(profile, catalogs, progress.classRef)}`} onClick={() => setClassEditor(progress)}/></div></div>) : <InlineNotice title="No class learning recorded">Party-wide progress does not populate character mastery. Add observations when you confirm them in game.</InlineNotice>}</div>}
          {tab === 'knowledge' && <div className="stack"><div className="split"><div><h3>Abilities and passives</h3><p className="settings-section__intro">Track each character's explicit learning state and observed LP spend.</p></div><Button icon="plus" onClick={() => setLearnedEditor({ kind: 'ability' })} tone="secondary">Add learning</Button></div>{knowledgeRows.length ? knowledgeRows.map((node) => <div className="list-row" key={entityDefinitionKey(node.ref)}><div className="list-row__primary"><strong>{entityName(profile, catalogs, node.ref)}</strong><small>{kindLabel(node.kind)}</small></div><Badge tone={node.learned.state === 'known' && node.learned.value ? 'positive' : 'warning'}>{knowledgeLabel(node.learned, (value) => value ? 'Learned' : 'Not learned')}</Badge><div className="list-row__fact">Paid LP: {knowledgeLabel(node.actualPaidLp)}</div><div className="list-row__action"><IconButton icon="edit" label={`Edit ${entityName(profile, catalogs, node.ref)}`} onClick={() => setLearnedEditor({ node, kind: node.kind })}/></div></div>) : <InlineNotice title="No learning observations">Learned nodes and currently equipped selections are recorded separately.</InlineNotice>}</div>}
          {tab === 'magic' && <div className="stack"><div className="split"><div><h3>Monster Magic</h3><p className="settings-section__intro">Record spell knowledge for this character only.</p></div><Button icon="plus" onClick={() => setLearnedEditor({ kind: 'monsterMagic' })} tone="secondary">Add spell</Button></div>{magicRows.length ? magicRows.map((node) => <div className="list-row" key={entityDefinitionKey(node.ref)}><div className="list-row__primary"><strong>{entityName(profile, catalogs, node.ref)}</strong><small>Character-specific spell knowledge</small></div><Badge tone={node.learned.state === 'known' && node.learned.value ? 'positive' : 'warning'}>{knowledgeLabel(node.learned, (value) => value ? 'Learned' : 'Not learned')}</Badge><div className="list-row__fact">Paid LP: {knowledgeLabel(node.actualPaidLp)}</div><div className="list-row__action"><IconButton icon="edit" label={`Edit ${entityName(profile, catalogs, node.ref)}`} onClick={() => setLearnedEditor({ node, kind: 'monsterMagic' })}/></div></div>) : <InlineNotice title="No Monster Magic observations">A party-wide note or class mastery does not identify which spells this character knows.</InlineNotice>}</div>}
          {tab === 'history' && <div className="stack">{Object.values(selected.snapshots).length ? Object.values(selected.snapshots).sort((left, right) => right.recordedAt.localeCompare(left.recordedAt)).map((entry) => <article className="panel snapshot-card" key={entry.id}><div className="split"><div><h3>{formatRelativeDate(entry.observedAt)}</h3><p className="settings-section__intro">Recorded {formatRelativeDate(entry.recordedAt)}</p></div>{entry.id === selected.currentSnapshotId && <Badge tone="positive">Current snapshot</Badge>}</div>{entry.note && <p>{entry.note}</p>}</article>) : <InlineNotice title="No snapshot history">Capture the first observed sheet to begin a revision history.</InlineNotice>}</div>}
        </div></section></div>}
    <Sheet onClose={() => setAdding(false)} open={adding} title="Add character"><AddCharacterForm onCancel={() => setAdding(false)} onSubmit={add}/></Sheet>
    <Sheet description={selected ? `Record a new observed state for ${selected.name}.` : undefined} onClose={() => setCapturing(false)} open={capturing} title="Capture character snapshot" width="wide">{selected && <SnapshotForm initial={snapshot} onCancel={() => setCapturing(false)} onSubmit={capture} profile={profile}/>}</Sheet>
    <Sheet description="Record only this character's observed class state." onClose={() => setClassEditor(undefined)} open={classEditor !== undefined} title={classEditor ? 'Edit class progress' : 'Add class progress'}>{selected && classEditor !== undefined && <ClassProgressForm initial={classEditor ?? undefined} onCancel={() => setClassEditor(undefined)} onSubmit={saveClass}/>}</Sheet>
    <Sheet description="Record explicit learning without inferring it from equipment or party progress." onClose={() => setLearnedEditor(undefined)} open={Boolean(learnedEditor)} title={learnedEditor?.kind === 'monsterMagic' ? 'Record Monster Magic' : 'Record learned node'}>{selected && learnedEditor && <LearnedNodeForm defaultKind={learnedEditor.kind} initial={learnedEditor.node} lockedKind={learnedEditor.kind === 'monsterMagic' ? 'monsterMagic' : undefined} onCancel={() => setLearnedEditor(undefined)} onSubmit={saveLearned}/>}</Sheet>
  </>
}
