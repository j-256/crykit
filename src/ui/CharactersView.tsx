import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { effectiveScenarioAssignments, entityDefinitionKey, requirePlaythrough } from '../domain'
import type {
  CatalogEntityKind,
  CatalogSnapshot,
  CharacterClassProgress,
  CharacterId,
  CharacterSnapshot,
  BuildCalculationPlan,
  EntityRef,
  Knowledge,
  LearnedNode,
  LearnedNodeKind,
  ObservedStat,
  LocalData,
  GameSetupRevisionId,
  SlotDefinition,
} from '../domain/types'
import { Badge, Button, EmptyState, Field, IconButton, InlineNotice } from './components'
import { activeGameSetup, ownRecordValue } from './model'
import { Sheet } from './Sheet'
import { DefinitionPickerField } from './definitions'
import { routeWithoutOverlays, useNavigation, useNavigationBlocker, type CharactersPageRoute, type CharacterTab } from './navigation'
import { MemberSheet, MemberSkillsToggle, MemberSummary } from './MemberSheet'
import { CharacterLearning } from './CharacterLearning'
import './member.css'
import { followPrimary } from '../domain/calculation-plan'
import { SkillScreenshotImport } from './SkillScreenshotImport'
import type { ReviewedSkillTree } from '../domain/skill-trees'
import { CharacterHistory } from './CharacterHistory'
import { CharacterOverview } from './CharacterOverview'
import type { DraftChangeHandler } from './drafts'

const UNKNOWN_NUMBER: Knowledge<number> = { state: 'unknown' }
const UNKNOWN_BOOLEAN: Knowledge<boolean> = { state: 'unknown' }
const UNKNOWN_REF: Knowledge<EntityRef> = { state: 'unknown' }

export interface CharacterDraft {
  readonly name: string
  readonly appearanceLabel?: string
}

export interface SnapshotDraft {
  readonly gameSetupRevisionId?: GameSetupRevisionId
  readonly level: Knowledge<number>
  readonly primaryClass: Knowledge<EntityRef>
  readonly secondaryClass: Knowledge<EntityRef>
  readonly displayedStats: Readonly<Record<string, ObservedStat>>
  readonly observedAt?: string
  readonly note?: string
  readonly equipment: Readonly<Record<string, EntityRef | null>>
  readonly passives: Knowledge<readonly EntityRef[]>
  readonly calculation?: BuildCalculationPlan
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
  readonly localData: LocalData
  readonly catalogs: readonly CatalogSnapshot[]
  readonly hasPendingSave: boolean
  readonly onDraftChange: DraftChangeHandler
  readonly onRetrySave: () => Promise<void>
  readonly onAdd: (draft: CharacterDraft) => Promise<void>
  readonly onCapture: (characterId: CharacterId, draft: SnapshotDraft) => Promise<void>
  readonly onUpsertClass: (characterId: CharacterId, draft: ClassProgressDraft) => Promise<void>
  readonly onImportScreenshots: (captures: readonly ReviewedSkillTree[], expectedRevision: number) => Promise<void>
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

function snapshotDraft(gameSetupRevisionId: GameSetupRevisionId | undefined, initial?: CharacterSnapshot): SnapshotDraft {
  return {
    gameSetupRevisionId,
    level: initial?.level ?? UNKNOWN_NUMBER,
    primaryClass: initial?.primaryClass ?? UNKNOWN_REF,
    secondaryClass: initial?.secondaryClass ?? UNKNOWN_REF,
    displayedStats: initial?.displayedStats ?? {},
    equipment: initial?.gameSetupRevisionId === gameSetupRevisionId ? initial?.equipment ?? {} : {},
    passives: initial?.passives ?? { state: 'unknown' },
    ...(initial?.calculation ? { calculation: initial.calculation } : {}),
  }
}

function snapshotStatRows(initial?: CharacterSnapshot): StatRow[] {
  return Object.entries(initial?.displayedStats ?? {}).map(([key, stat], index) => ({ id: index, key, unit: stat.unit, value: stat.value }))
}

function slotEntityKinds(slot: SlotDefinition): readonly CatalogEntityKind[] {
  if (slot.acceptedEntityKinds?.state === 'known' && slot.acceptedEntityKinds.value.length > 0) {
    return slot.acceptedEntityKinds.value
  }
  return ['item']
}

function SnapshotForm({ localData, initial, onSubmit }: {
  readonly localData: LocalData
  readonly initial?: CharacterSnapshot
  readonly onSubmit: (draft: SnapshotDraft) => Promise<void>
}) {
  const navigation = useNavigation()
  const gameSetup = activeGameSetup(localData)
  const [draft, setDraft] = useState<SnapshotDraft>(() => snapshotDraft(gameSetup?.id, initial))
  const [stats, setStats] = useState<StatRow[]>(() => snapshotStatRows(initial))
  const [nextStatId, setNextStatId] = useState(stats.length)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [closeWarning, setCloseWarning] = useState(false)
  const scope = useRef(routeWithoutOverlays(navigation.route))
  const initialSignature = useRef(JSON.stringify({ draft, stats }))
  const dirty = JSON.stringify({ draft, stats }) !== initialSignature.current
  const exitAllowed = useRef(false)
  const blocked = useRef(false)
  blocked.current = !exitAllowed.current && (dirty || busy)
  useNavigationBlocker(scope.current, () => blocked.current, () => setCloseWarning(true))
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (blocked.current) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [])
  const finish = () => { exitAllowed.current = true; blocked.current = false; navigation.close() }
  const requestClose = () => {
    if (blocked.current) { setCloseWarning(true); return false }
    return true
  }
  const pickerOverlay = navigation.route.overlays[0]?.kind === 'definition-picker' ? navigation.route.overlays[0] : undefined
  const requestedSlot = pickerOverlay?.fieldKey.startsWith('slot:') ? pickerOverlay.fieldKey.slice(5) : undefined
  const passivePickerIndex = requestedSlot ? /^passive-(\d+)$/.exec(requestedSlot) : undefined
  const knownPassives = draft.passives.state === 'known' ? draft.passives.value : []
  const missingPicker = Boolean(requestedSlot && !gameSetup?.slots.some((slot) => slot.id === requestedSlot) && !(passivePickerIndex && Number(passivePickerIndex[1]) >= 1 && Number(passivePickerIndex[1]) <= knownPassives.length + 1))
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
    try { await onSubmit({ ...draft, displayedStats }); finish() } catch (reason) { setError(reason instanceof Error ? reason.message : 'The snapshot could not be saved.') } finally { setBusy(false) }
  }
  const updateStat = (id: number, patch: Partial<StatRow>) => setStats((current) => current.map((stat) => stat.id === id ? { ...stat, ...patch } : stat))
  return <Sheet description="Save your character's in-game stats and equipment. Earlier snapshots stay unchanged." onClose={() => navigation.close()} onRequestClose={requestClose} open title="Capture character snapshot" width="wide"><form className="stack" onSubmit={submit}>
    {closeWarning && <InlineNotice title="Unsaved snapshot" tone="warning">Save this snapshot or choose {error ? 'Close form' : 'Cancel and discard'} before leaving.</InlineNotice>}
    {initial && initial.gameSetupRevisionId !== gameSetup?.id && <InlineNotice title="Record equipment again" tone="warning">The previous snapshot has different or unrecorded equipment-slot context. Its equipment selections have not been copied into this Game Setup. The separate passive list remains carried forward.</InlineNotice>}
    {initial && <InlineNotice title="Starting from the latest snapshot">Review the carried-forward values before saving this snapshot. The observation date and note start blank.</InlineNotice>}
    <NumberKnowledgeField hint="Record the displayed value only." label="Level" min={1} onChange={(level) => setDraft({ ...draft, level })} value={draft.level}/>
    <div className="grid-2"><DefinitionPickerField allowedKinds={['class']} label="Primary class" onChange={(ref) => setDraft({ ...draft, primaryClass: ref ? { state: 'known', value: ref } : UNKNOWN_REF, ...(draft.calculation ? { calculation: followPrimary(draft.calculation, ref ?? null) } : {}) })} routeKey="primary-class" value={selectedRef(draft.primaryClass)}/><DefinitionPickerField allowedKinds={['class']} label="Secondary class" onChange={(ref) => setDraft({ ...draft, secondaryClass: ref ? { state: 'known', value: ref } : UNKNOWN_REF })} routeKey="secondary-class" value={selectedRef(draft.secondaryClass)}/></div>
    <div className="stack"><div className="split"><div><h3>Displayed final stats</h3><p className="settings-section__intro">Record only totals visible on the character screen.</p></div><Button onClick={() => { setStats((current) => [...current, { id: nextStatId, key: '', unit: 'displayed', value: UNKNOWN_NUMBER }]); setNextStatId((value) => value + 1) }} tone="secondary" type="button">Add stat</Button></div>{stats.length === 0 ? <InlineNotice title="No displayed stats recorded">Unlisted stats remain unrecorded and are never treated as zero.</InlineNotice> : stats.map((stat) => <div className="grid-3" key={stat.id}><Field label="Stat name" required><input onChange={(event) => updateStat(stat.id, { key: event.target.value })} placeholder="For example: Max HP" required value={stat.key}/></Field><NumberKnowledgeField label="Displayed value" min={0} onChange={(value) => updateStat(stat.id, { value })} value={stat.value}/><div className="field"><span className="field__label">Unit</span><input aria-label="Stat unit" onChange={(event) => updateStat(stat.id, { unit: event.target.value })} placeholder="displayed" value={stat.unit}/><Button onClick={() => setStats((current) => current.filter((entry) => entry.id !== stat.id))} tone="quiet" type="button">Remove stat</Button></div></div>)}</div>
    {gameSetup?.slots.length ? <div className="stack"><div><h3>Equipment</h3><p className="settings-section__intro">Each saved choice keeps its exact personal or catalog identity. Candidate lists do not assert legality.</p></div><div className="grid-2">{[...gameSetup.slots].sort((left, right) => left.order - right.order).map((slot) => {
      const kinds = slotEntityKinds(slot)
      const observed = Object.prototype.hasOwnProperty.call(draft.equipment, slot.id)
      const selection = draft.equipment[slot.id]
      const setSelection = (ref: EntityRef | null | undefined) => setDraft((current) => {
        const equipment = { ...current.equipment }
        if (ref === undefined) delete equipment[slot.id]
        else equipment[slot.id] = ref
        return { ...current, equipment }
      })
      return <DefinitionPickerField allowEmpty allowedKinds={kinds} hint="Empty means nothing is equipped. Unknown means this slot has not been recorded." key={slot.id} label={slot.label} onChange={setSelection} routeKey={`slot:${slot.id}`} value={observed ? selection : undefined}/>
    })}</div></div> : <InlineNotice title="No equipment slots configured">Configure a current Game Setup to capture ordered equipment in this snapshot.</InlineNotice>}
    <div className="stack"><div><h3>Equipped passives</h3><p className="settings-section__intro">Record the variable-length passive list. Its PP limit comes from the selected Game Setup.</p></div><Field label="Passive list certainty"><select aria-label="Passive list certainty" onChange={event => setDraft(current => ({ ...current, passives: event.target.value === 'known' ? { state: 'known', value: current.passives.state === 'known' ? current.passives.value : [] } : { state: 'unknown' } }))} value={draft.passives.state === 'known' ? 'known' : 'unknown'}><option value="unknown">Unknown</option><option value="known">Known</option></select></Field>{draft.passives.state === 'known' && <div className="grid-2">{[...draft.passives.value, undefined].map((ref, index) => <DefinitionPickerField allowedKinds={['passive', 'innate']} key={`${index}:${ref ? entityDefinitionKey(ref) : 'add'}`} label={`Equipped passive ${index + 1}`} onChange={value => setDraft(current => { const passives = current.passives.state === 'known' ? [...current.passives.value] : []; if (value) passives[index] = value; else if (index < passives.length) passives.splice(index, 1); return { ...current, passives: { state: 'known', value: passives } } })} routeKey={`slot:passive-${index + 1}`} value={ref}/>)}</div>}</div>
    <div className="grid-2"><Field label="Observed on"><input onChange={(event) => setDraft({ ...draft, observedAt: event.target.value || undefined })} type="date" value={draft.observedAt ?? ''}/></Field><Field label="Snapshot note"><input onChange={(event) => setDraft({ ...draft, note: event.target.value || undefined })} placeholder="Optional context" value={draft.note ?? ''}/></Field></div>
    {missingPicker && <InlineNotice title="Character field unavailable" tone="warning">The requested equipment slot or passive position is unavailable. No other field was opened. <Button onClick={() => navigation.close()} tone="quiet" type="button">Close picker route</Button></InlineNotice>}
    <InlineNotice title="Stats are saved as entered">Recorded totals stay unchanged when equipment changes. The current character page shows calculated loadout totals separately.</InlineNotice>
    {error && <InlineNotice title="Snapshot not saved" tone="danger">{error} Your entered values remain in this form.</InlineNotice>}
    <div className="form-actions"><Button disabled={busy} onClick={finish} tone="quiet" type="button">{error ? 'Close form' : dirty ? 'Cancel and discard' : 'Cancel'}</Button><Button disabled={busy} icon="check" type="submit">{busy ? 'Saving...' : 'Save snapshot'}</Button></div>
  </form></Sheet>
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
    <DefinitionPickerField allowedKinds={['class']} disabled={Boolean(initial)} hint={initial ? 'The linked class identity stays unchanged while its observed facts are edited.' : 'Choose an exact reference or create a personal class definition.'} label="Class" onChange={(value) => setClassRef(value ?? undefined)} routeKey="class-reference" value={classRef}/>
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
    <DefinitionPickerField allowedKinds={[kind]} disabled={Boolean(initial)} hint={initial ? 'The linked definition identity stays unchanged while its observed facts are edited.' : 'Names never link records. Select or create the exact definition.'} key={kind} label={kindLabel(kind)} onChange={(value) => setRef(value ?? undefined)} routeKey="node-reference" value={ref}/>
    <div className="grid-2"><BooleanKnowledgeField label="Learned" onChange={setLearned} value={learned}/><NumberKnowledgeField hint="Actual observed spend, not a catalog price." label="Paid LP" min={0} onChange={setActualPaidLp} value={actualPaidLp}/></div>
    <InlineNotice title="Explicit learning record">Equipping a selection, mastering a class, or recording party progress does not mark this node learned.</InlineNotice>
    {error && <InlineNotice title="Learning not saved" tone="danger">{error}</InlineNotice>}
    <div className="form-actions"><Button onClick={onCancel} tone="quiet" type="button">Cancel</Button><Button disabled={busy || !ref} icon="check" type="submit">{busy ? 'Saving...' : 'Save learning'}</Button></div>
  </form>
}

function TrackedBuildPicker({ localData, characterId, disabled }: { localData: LocalData; characterId: CharacterId; disabled: boolean }) {
  const navigation = useNavigation()
  const [revisionId, setRevisionId] = useState('')
  const revision = localData.buildRevisions[revisionId]
  return <div className="stack"><Field label="Build checkpoint to compare"><select disabled={disabled} value={revisionId} onChange={event => setRevisionId(event.target.value)}><option value="">Choose a saved build</option>{Object.values(localData.builds).filter(build => build.state !== 'archived').map(build => <optgroup key={build.id} label={build.title}>{Object.values(localData.buildRevisions).filter(revision => revision.buildId === build.id).sort((a, b) => b.revision - a.revision).map(revision => <option key={revision.id} value={revision.id}>{build.title} · r{revision.revision}</option>)}</optgroup>)}</select></Field><Button disabled={disabled || !revision} tone="secondary" onClick={() => { if (revision) navigation.navigate({ page: { page: 'builds', view: 'record-current', buildId: revision.buildId, revisionId: revision.id }, overlays: [], query: { character: [characterId] } }) }}>Compare / apply Build</Button><p className="field__hint">Review differences first. Recording a build requires confirmation that you applied it in game.</p></div>
}

export function CharactersView({ localData, catalogs, hasPendingSave, onAdd, onCapture, onUpsertClass, onUpsertLearned, onImportScreenshots, onDraftChange, onRetrySave }: CharactersViewProps) {
  const navigation = useNavigation()
  const [memberDirty, setMemberDirty] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(true)
  const updateMemberDirty = useCallback<DraftChangeHandler>((dirty, actions) => { setMemberDirty(dirty); onDraftChange(dirty, actions) }, [onDraftChange])
  const characters = Object.values(requirePlaythrough(localData).characters)
  const page = navigation.route.page.page === 'characters' ? navigation.route.page : { page: 'characters', view: 'list' } as const
  const selectedId = 'characterId' in page ? page.characterId : undefined
  const selected = selectedId ? ownRecordValue(requirePlaythrough(localData).characters, selectedId) : undefined
  const missingCharacter = Boolean(selectedId && !selected)
  const tab: CharacterTab = page.view === 'character' ? page.tab : page.view === 'snapshot' || page.view === 'snapshot-compare' || page.view === 'snapshot-pair' ? 'history' : 'current'
  const adding = page.view === 'new'
  const overview = page.view === 'list' || adding
  const capturing = page.view === 'snapshot-new' && Boolean(selected)
  const snapshot = selected?.currentSnapshotId ? ownRecordValue(selected.snapshots, selected.currentSnapshotId) : undefined
  const initialLearningKind = page.view === 'learning-new' || page.view === 'learning-edit' ? page.learningKind === 'magic' ? 'monsterMagic' : 'all' : 'all'

  const classRows = selected ? Object.values(selected.classProgress) : []
  const knowledgeRows = selected ? Object.values(selected.learnedNodes).filter((node) => node.kind !== 'monsterMagic') : []
  const magicRows = selected ? Object.values(selected.learnedNodes).filter((node) => node.kind === 'monsterMagic') : []
  const classEditor = page.view === 'class-new' ? null : page.view === 'class-edit' ? classRows.find((entry) => entityDefinitionKey(entry.classRef) === entityDefinitionKey(page.ref)) : undefined
  const learnedEditor = page.view === 'learning-new'
    ? { kind: page.learningKind === 'magic' ? 'monsterMagic' as const : 'ability' as const }
    : page.view === 'learning-edit'
      ? (() => {
          const node = [...knowledgeRows, ...magicRows].find((entry) => entityDefinitionKey(entry.ref) === entityDefinitionKey(page.ref) && (page.learningKind === 'magic' ? entry.kind === 'monsterMagic' : entry.kind !== 'monsterMagic'))
          return node ? { node, kind: node.kind } : undefined
        })()
      : undefined
  const editorRequestMissing = (page.view === 'skill-screenshots' || page.view === 'snapshot-new' || page.view === 'class-new' || page.view === 'class-edit' || page.view === 'learning-new' || page.view === 'learning-edit') && (!selected || page.view === 'class-edit' && !classEditor || page.view === 'learning-edit' && !learnedEditor)
  const navigate = (next: CharactersPageRoute) => navigation.navigate({ ...navigation.route, page: next, overlays: [] })

  const add = async (draft: CharacterDraft) => { await onAdd(draft); navigation.close() }
  const capture = async (draft: SnapshotDraft) => { if (!selected) return; await onCapture(selected.id, draft) }
  const saveClass = async (draft: ClassProgressDraft) => { if (!selected) return; await onUpsertClass(selected.id, draft); navigation.close() }
  const saveLearned = async (draft: LearnedNodeDraft) => { if (!selected) return; await onUpsertLearned(selected.id, draft); navigation.close() }

  const selectedIndex = characters.findIndex(character => character.id === selected?.id)
  const selectNeighbor = (step: number) => {
    const character = characters[(selectedIndex + step + characters.length) % characters.length]
    if (character) navigate({ page: 'characters', view: 'character', characterId: character.id, tab })
  }
  const record = () => { if (selected) navigate({ page: 'characters', view: 'snapshot-new', characterId: selected.id }) }
  return <>
    {overview ? <header className="roster-heading"><div><p className="eyebrow">Character overview</p><h1>Characters</h1><Button tone="quiet" onClick={() => navigation.navigate({ page: { page: 'builds', view: 'teams' }, overlays: [], query: {} })}>Party plans &amp; readiness</Button><p>Your roster at a glance. Stats and equipment follow each character's current snapshot.</p></div><Button icon="plus" onClick={() => navigate({ page: 'characters', view: 'new' })}>Add character</Button></header> : <header className="member-toolbar"><div className="member-toolbar__heading"><Button icon="arrow-left" onClick={() => navigate({ page: 'characters', view: 'list' })} tone="quiet">Overview</Button><h1>Character</h1></div><div className="member-switcher">{characters.length > 0 && <><IconButton disabled={characters.length < 2} icon="arrow-left" label="Previous member" onClick={() => selectNeighbor(-1)}/><label className="sr-only" htmlFor="member-select">Character</label><select id="member-select" onChange={event => navigate({ page: 'characters', view: 'character', characterId: event.target.value as CharacterId, tab })} value={selected?.id ?? ''}>{!selected && <option value="">Choose a character</option>}{characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}</select><IconButton className="member-next" disabled={characters.length < 2} icon="arrow-left" label="Next member" onClick={() => selectNeighbor(1)}/></>}<IconButton icon="plus" label="Add character" onClick={() => navigate({ page: 'characters', view: 'new' })}/></div></header>}
    {(missingCharacter || editorRequestMissing) && <InlineNotice title={missingCharacter ? 'Character unavailable' : 'Character editor unavailable'} tone="warning">This character or observation is unavailable in the active playthrough. <Button onClick={() => navigate({ page: 'characters', view: 'list' })} tone="quiet">Return to characters</Button></InlineNotice>}
    {characters.length === 0 ? <EmptyState description="Add a character to record your in-game sheet. Unchecked values stay unknown." icon="user" title="Your roster is blank"><Button icon="plus" onClick={() => navigate({ page: 'characters', view: 'new' })}>Add a character</Button></EmptyState> : overview ? <CharacterOverview catalogs={catalogs} localData={localData}/> : selected && <section className="member-window">
      <MemberSummary catalogs={catalogs} character={selected} localData={localData} snapshot={page.view === 'snapshot' ? ownRecordValue(selected.snapshots, page.snapshotId) : snapshot}/>
      <nav aria-label="Character views" className="member-navigation"><div><Button aria-current={tab !== 'history' ? 'page' : undefined} icon="user" onClick={() => navigate({ page: 'characters', view: 'character', characterId: selected.id, tab: 'current' })} tone="quiet">Character</Button><Button aria-current={tab === 'history' ? 'page' : undefined} icon="history" onClick={() => navigate({ page: 'characters', view: 'character', characterId: selected.id, tab: 'history' })} tone="quiet">History</Button><Button disabled={memberDirty} icon="edit" onClick={record} tone="quiet">Capture snapshot</Button></div></nav>
      <div className="member-window__body">
        {tab === 'current' && <>{snapshot ? <MemberSheet catalogs={catalogs} hasPendingSave={hasPendingSave} key={selected.id} onDirtyChange={updateMemberDirty} onRetrySave={onRetrySave} onRecord={record} onSave={capture} onSkills={() => setSkillsOpen(value => !value)} localData={localData} skillsOpen={skillsOpen} snapshot={snapshot}/> : <><EmptyState description="Start with what you can see in game. Leave the rest unknown." icon="character" title="No snapshot recorded"><Button onClick={record}>Capture current sheet</Button></EmptyState><div className="member-menu__group member-skills-standalone"><MemberSkillsToggle onToggle={() => setSkillsOpen(value => !value)} open={skillsOpen}/></div></>}
          <details className="member-record member-plans"><summary>Compare or apply a Build</summary><TrackedBuildPicker localData={localData} characterId={selected.id} disabled={memberDirty}/>{Object.values(requirePlaythrough(localData).scenarios).flatMap(scenario => { const revisionId = effectiveScenarioAssignments(scenario)[selected.id]; const revision = revisionId ? localData.buildRevisions[revisionId] : undefined; const build = revision ? localData.builds[revision.buildId] : undefined; return build ? [{ scenario, build }] : [] }).map(({ scenario, build }) => <div className="list-row" key={`${scenario.id}:${build.id}`}><Button onClick={() => navigation.navigate({ page: { page: 'builds', view: 'build', buildId: build.id }, overlays: [], query: {} })} tone="quiet">{build.title}</Button><Badge>{scenario.label}</Badge></div>)}<Button onClick={() => navigation.navigate({ page: { page: 'builds', view: 'library' }, overlays: [], query: {} })} tone="quiet">Open Builds</Button></details>
        </>}
        {tab === 'current' && skillsOpen && <CharacterLearning catalogs={catalogs} character={selected} initialKind={initialLearningKind} key={selected.id} localData={localData}/>}
        {tab === 'history' && <CharacterHistory catalogs={catalogs} character={selected} key={selected.id} page={page} localData={localData}/>}
      </div>
    </section>}
    {selected && page.view === 'skill-screenshots' && <SkillScreenshotImport catalogs={catalogs} onImport={onImportScreenshots} localData={localData}/>}
    <Sheet onClose={() => navigation.close()} open={adding} title="Add character"><AddCharacterForm onCancel={() => navigation.close()} onSubmit={add}/></Sheet>
    {capturing && selected && <SnapshotForm initial={snapshot} key={selected.id} onSubmit={capture} localData={localData}/>}
    <Sheet description="Record only this character's observed class state." onClose={() => navigation.close()} open={Boolean(selected && classEditor !== undefined)} title={classEditor ? 'Edit class progress' : 'Add class progress'}>{selected && classEditor !== undefined && <ClassProgressForm initial={classEditor ?? undefined} key={`${selected.id}:${classEditor ? entityDefinitionKey(classEditor.classRef) : 'new'}`} onCancel={() => navigation.close()} onSubmit={saveClass}/>}</Sheet>
    <Sheet description="Record explicit learning without inferring it from equipment or party progress." onClose={() => navigation.close()} open={Boolean(selected && learnedEditor)} title={learnedEditor?.kind === 'monsterMagic' ? 'Record Monster Magic' : 'Record learned node'}>{selected && learnedEditor && <LearnedNodeForm defaultKind={learnedEditor.kind} initial={'node' in learnedEditor ? learnedEditor.node : undefined} key={`${selected.id}:${'node' in learnedEditor && learnedEditor.node ? entityDefinitionKey(learnedEditor.node.ref) : `new:${learnedEditor.kind}`}`} lockedKind={learnedEditor.kind === 'monsterMagic' ? 'monsterMagic' : undefined} onCancel={() => navigation.close()} onSubmit={saveLearned}/>}</Sheet>
  </>
}
