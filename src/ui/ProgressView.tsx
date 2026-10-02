import { memo, useCallback, useMemo, useState, type FormEvent } from 'react'
import classSealUrl from '../assets/class-seal.png?url&no-inline'
import { CERTAINTY_CATALOG_REVISION_ID } from '../catalog/certainty-catalog'
import { VANILLA_CLASS_SEAL_PAIRS } from '../catalog/class-seals'
import { STARTER_CATALOG_ID } from '../catalog/starter'
import { classSealStage, classSealStageFacts, CLASS_SEAL_STAGES, entityDefinitionKey, logicalEntityKey, nextClassSealStage, preferredDefinitionRef, requirePlaythrough, type ClassSealProgressSelection } from '../domain'
import type { CatalogEntity, CatalogSnapshot, EntityRef, Knowledge, LocalData, PartyProgressRecord, ProgressRecordId, ProgressStage } from '../domain/types'
import { Badge, Button, Field, InlineNotice } from './components'
import { Icon } from './icons'
import { formatRelativeDate, ownRecordValue, resolveEntity } from './model'
import { Sheet } from './Sheet'
import { DefinitionPickerField, findDefinitionOption, useDefinitionLibrary } from './definitions'
import { useNavigation, type ProgressPageRoute } from './navigation'
import { ReferenceLink } from './ReferenceLink'
import { ClassWorldArtwork } from './WikiSprite'
import { TravelUnlocksView, travelUnlockEntries } from './TravelUnlocksView'
import { SummonsView, summonEntries } from './SummonsView'
import type { SummonId } from '../catalog/summons'
import { ProgressPage } from './ProgressPage'
import { useQueuedTileUpdates } from './useQueuedTileUpdates'

const UNKNOWN_LOCATION: Knowledge<string> = { state: 'unknown' }

const STAGE_DETAILS: Readonly<Record<ProgressStage, {
  readonly label: string
  readonly counterLabel: string
  readonly nextLabel: string
}>> = Object.freeze({
  notAcquired: { label: 'Class not acquired', counterLabel: 'Not acquired', nextLabel: 'Mark class unlocked' },
  unlocked: { label: 'Class unlocked', counterLabel: 'Unlocked', nextLabel: 'Mark class mastered' },
  mastered: { label: 'Class mastered', counterLabel: 'Mastered', nextLabel: 'Mark seal acquired' },
  sealAcquired: { label: 'Seal acquired', counterLabel: 'Seals acquired', nextLabel: 'Reset to not acquired' },
})

export interface ProgressDraft {
  readonly name: string
  readonly subject?: EntityRef
  readonly stage: Knowledge<ProgressStage>
  readonly unlocked: Knowledge<boolean>
  readonly partyMastery: Knowledge<boolean>
  readonly collection: Knowledge<boolean>
  readonly masterLocation: Knowledge<string>
  readonly observedAt?: string | null
}

export interface ProgressViewProps {
  readonly localData: LocalData
  readonly catalogs: readonly CatalogSnapshot[]
  readonly onAdd: (draft: ProgressDraft) => Promise<void>
  readonly onAdvance: (subject: EntityRef, displayName: string) => Promise<void>
  readonly onToggleSummon: (id: SummonId) => Promise<void>
  readonly onSetStage: (selections: readonly ClassSealProgressSelection[], stage: ProgressStage) => Promise<void>
  readonly onUpdate: (recordId: ProgressRecordId, draft: ProgressDraft) => Promise<void>
  readonly saveBlocked: boolean
  readonly onSetAcquired: (subject: EntityRef, displayName: string, acquired: boolean) => Promise<void>
}

interface ClassSealEntry {
  readonly key: string
  readonly classRef: EntityRef
  readonly sealRef: EntityRef
  readonly classEntity: CatalogEntity
  readonly className: string
  readonly sealName: string
  readonly record?: PartyProgressRecord
  readonly stage: ProgressStage
}

function progressDraft(record?: PartyProgressRecord): ProgressDraft {
  const facts = classSealStageFacts('notAcquired')
  return {
    name: record?.displayName ?? '',
    ...(record ? { subject: record.subject } : {}),
    stage: record?.stage ?? facts.stage,
    unlocked: record?.unlocked ?? facts.unlocked,
    partyMastery: record?.partyMastery ?? facts.partyMastery,
    collection: record?.collection ?? facts.collection,
    masterLocation: record?.masterLocation ?? UNKNOWN_LOCATION,
    ...(record?.observedAt ? { observedAt: record.observedAt.slice(0, 10) } : {}),
  }
}

function ProgressForm({ initial, onCancel, onSubmit }: {
  readonly initial?: PartyProgressRecord
  readonly onCancel: () => void
  readonly onSubmit: (draft: ProgressDraft) => Promise<void>
}) {
  const { options } = useDefinitionLibrary()
  const [draft, setDraft] = useState<ProgressDraft>(() => progressDraft(initial))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const stageValue = draft.stage.state === 'known' ? draft.stage.value : draft.stage.state
  const locationSpecialState = draft.masterLocation.state === 'conflicting' || draft.masterLocation.state === 'notApplicable' ? draft.masterLocation.state : undefined
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try { await onSubmit(draft) } catch (reason) { setError(reason instanceof Error ? reason.message : 'The progress observation could not be saved.') } finally { setBusy(false) }
  }
  const setStage = (stage: ProgressStage) => setDraft({ ...draft, ...classSealStageFacts(stage) })
  return <form className="stack" onSubmit={submit}>
    <DefinitionPickerField allowedKinds={['class']} autoFocus disabled={Boolean(initial)} hint={initial ? 'The linked subject identity stays unchanged while its observations are edited.' : 'Choose an exact class definition or create a personal class.'} label="Class reference" onChange={(ref) => { const option = findDefinitionOption(options, ref); setDraft({ ...draft, subject: ref ?? undefined, name: option?.name ?? draft.name }) }} routeKey="class-reference" value={draft.subject}/>
    <Field label="Class display name" required><input onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Enter the class name" required value={draft.name}/></Field>
    <Field hint="Changing this state records consistent unlock, mastery, and seal facts for the playthrough." label="Mastery state"><select onChange={(event) => setStage(event.target.value as ProgressStage)} value={stageValue}>{draft.stage.state !== 'known' && <option disabled value={stageValue}>Imported state needs review</option>}{CLASS_SEAL_STAGES.map(stage => <option key={stage} value={stage}>{STAGE_DETAILS[stage].label}</option>)}</select></Field>
    <div className="field"><span className="field__label">Master location</span><select aria-label="Master location certainty" onChange={(event) => setDraft({ ...draft, masterLocation: event.target.value === 'known' ? { state: 'known', value: '' } : UNKNOWN_LOCATION })} value={draft.masterLocation.state}><option value="unknown">Unknown</option><option value="known">Known</option>{locationSpecialState === 'conflicting' && <option disabled value="conflicting">Conflicting claims</option>}{locationSpecialState === 'notApplicable' && <option disabled value="notApplicable">Not applicable</option>}</select>{draft.masterLocation.state === 'known' && <input aria-label="Master location" onChange={(event) => setDraft({ ...draft, masterLocation: { state: 'known', value: event.target.value } })} placeholder="Enter the observed destination or area" required value={draft.masterLocation.value}/>}<span className="field__hint">A destination or area is not a verified route.</span></div>
    <Field hint={initial?.observedAt ? 'Clear this field to explicitly remove the saved observation date.' : undefined} label="Observed on"><input onChange={(event) => setDraft({ ...draft, observedAt: event.target.value || (initial?.observedAt ? null : undefined) })} type="date" value={draft.observedAt ?? ''}/></Field>
    <InlineNotice title="Playthrough-level progress">This state does not change any character's mastery, learned skills, builds, teams, or inventory quantities.</InlineNotice>
    {initial && <InlineNotice title="Stable progress record">Saving updates this record and keeps its exact subject reference. A matching display name never creates or links another identity.</InlineNotice>}
    {error && <InlineNotice title="Progress not saved" tone="danger">{error} Your entered values remain in this form.</InlineNotice>}
    <div className="form-actions"><Button onClick={onCancel} tone="quiet" type="button">Cancel</Button><Button disabled={busy || !draft.name.trim()} icon="check" type="submit">{busy ? 'Saving...' : initial ? 'Save changes' : 'Save progress'}</Button></div>
  </form>
}

function findTrackerCatalog(catalogs: readonly CatalogSnapshot[]): CatalogSnapshot | undefined {
  return catalogs.find(catalog => catalog.id === STARTER_CATALOG_ID && catalog.revisionId === CERTAINTY_CATALOG_REVISION_ID)
    ?? catalogs.findLast(catalog => catalog.id === STARTER_CATALOG_ID)
}

function boardEntries(localData: LocalData, catalogs: readonly CatalogSnapshot[]): readonly ClassSealEntry[] {
  const catalog = findTrackerCatalog(catalogs)
  if (!catalog) return []
  const recordsBySubject = new Map(Object.values(requirePlaythrough(localData).progress).map(record => [logicalEntityKey(localData, record.subject), record]))
  return VANILLA_CLASS_SEAL_PAIRS.flatMap(pair => {
    const classEntity = catalog.entities[pair.classEntityId]
    const sealEntity = catalog.entities[pair.sealEntityId]
    if (classEntity?.kind !== 'class' || sealEntity?.kind !== 'item') return []
    const baseClassRef = { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: classEntity.id } as const
    const baseSealRef = { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: sealEntity.id } as const
    const classRef = preferredDefinitionRef(localData, baseClassRef)
    const sealRef = preferredDefinitionRef(localData, baseSealRef)
    const key = logicalEntityKey(localData, classRef)
    const record = recordsBySubject.get(key)
    return [{
      key,
      classRef,
      sealRef,
      classEntity,
      className: resolveEntity(localData, catalogs, classRef)?.name ?? classEntity.name,
      sealName: resolveEntity(localData, catalogs, sealRef)?.name ?? sealEntity.name,
      record,
      stage: classSealStage(record),
    }]
  })
}

const ClassSealTile = memo(function ClassSealTile({ entry, pending, selecting, selected, onAdvance, onEdit, onToggleSelection }: {
  readonly entry: ClassSealEntry
  readonly pending: boolean
  readonly selecting: boolean
  readonly selected: boolean
  readonly onAdvance: (entry: ClassSealEntry) => void
  readonly onEdit: (recordId: ProgressRecordId) => void
  readonly onToggleSelection: (key: string) => void
}) {
  const detail = STAGE_DETAILS[entry.stage]
  const recordId = entry.record?.id
  const label = selecting ? `${entry.className}: ${selected ? 'selected' : 'not selected'} for bulk edit. Current state: ${detail.label}` : `${entry.className}: ${detail.label}. ${detail.nextLabel}`
  return <article aria-busy={pending || undefined} className="class-seal-tile" data-selected={selected || undefined} data-stage={entry.stage}>
    <button aria-label={label} aria-pressed={selecting ? selected : undefined} className="class-seal-tile__advance" onClick={() => selecting ? onToggleSelection(entry.key) : onAdvance(entry)} type="button">
      {selecting && <span aria-hidden="true" className="class-seal-tile__selection-mark">{selected && <Icon name="check"/>}</span>}
      <span className="class-seal-tile__art" aria-hidden="true">
        <span className="class-seal-tile__seal"><img alt="" decoding="async" src={classSealUrl}/></span>
        <span className="class-seal-tile__portrait"><ClassWorldArtwork catalogId={STARTER_CATALOG_ID} detailed entity={entry.classEntity}/></span>
      </span>
      <span className="class-seal-tile__copy">
        <strong>{entry.className}</strong>
        <span className="class-seal-tile__state">{detail.label}</span>
        <small>{selecting ? selected ? 'Selected for bulk edit' : 'Select for bulk edit' : detail.nextLabel}</small>
      </span>
    </button>
    <div className="class-seal-tile__links">
      <ReferenceLink refValue={entry.classRef}>{entry.className}</ReferenceLink>
      <ReferenceLink refValue={entry.sealRef}>{entry.sealName}</ReferenceLink>
      {recordId && <button onClick={() => onEdit(recordId)} type="button">Details</button>}
    </div>
  </article>
}, (previous, next) => previous.pending === next.pending
  && previous.selecting === next.selecting
  && previous.selected === next.selected
  && previous.entry.stage === next.entry.stage
  && previous.entry.className === next.entry.className
  && previous.entry.sealName === next.entry.sealName
  && previous.entry.classEntity === next.entry.classEntity
  && previous.entry.record?.id === next.entry.record?.id
  && entityDefinitionKey(previous.entry.classRef) === entityDefinitionKey(next.entry.classRef)
  && entityDefinitionKey(previous.entry.sealRef) === entityDefinitionKey(next.entry.sealRef)
  && previous.onAdvance === next.onAdvance
  && previous.onEdit === next.onEdit
  && previous.onToggleSelection === next.onToggleSelection)

export function ProgressView(props: ProgressViewProps) {
  const navigation = useNavigation()
  const page = navigation.route.page
  const focusedRecordId = page.page === 'progress' && page.view === 'edit' ? page.recordId : undefined
  const summons = page.page === 'progress' && page.view === 'summons'
    || focusedRecordId !== undefined && summonEntries(props.localData, props.catalogs).some(entry => entry.record?.id === focusedRecordId)
  if (summons) return <SummonsView catalogs={props.catalogs} focusedRecordId={focusedRecordId} localData={props.localData} onToggle={props.onToggleSummon}/>
  const unlocks = page.page === 'progress' && page.view === 'unlocks'
    || focusedRecordId !== undefined && travelUnlockEntries(props.localData, props.catalogs).some(entry => entry.record?.id === focusedRecordId)
  return unlocks ? <TravelUnlocksView catalogs={props.catalogs} focusedRecordId={focusedRecordId} key={focusedRecordId ?? 'unlocks'} localData={props.localData} onSetAcquired={props.onSetAcquired} saveBlocked={props.saveBlocked}/> : <ClassSealProgressView {...props}/>
}

function ClassSealProgressView({ localData, catalogs, onAdd, onAdvance, onSetStage, onUpdate }: ProgressViewProps) {
  const navigation = useNavigation()
  const { queuedUpdates: queuedAdvances, pendingCount: queuedAdvanceCount, enqueue } = useQueuedTileUpdates<string, ProgressStage>()
  const [selecting, setSelecting] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [bulkSaving, setBulkSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const playthrough = requirePlaythrough(localData)
  const records = Object.values(playthrough.progress)
  const entries = useMemo(() => boardEntries(localData, catalogs), [catalogs, localData])
  const displayedEntries = useMemo(() => entries.map((entry) => {
    const queued = queuedAdvances.get(entry.key)
    return queued ? { ...entry, stage: queued.state } : entry
  }), [entries, queuedAdvances])
  const page = navigation.route.page.page === 'progress' ? navigation.route.page : { page: 'progress', view: 'list' } as const
  const adding = page.view === 'new'
  const editing = page.view === 'edit' ? ownRecordValue(requirePlaythrough(localData).progress, page.recordId) : undefined
  const missingRecord = page.view === 'edit' && !editing
  const navigate = useCallback((next: ProgressPageRoute) => navigation.navigate({ ...navigation.route, page: next, overlays: [] }), [navigation])
  const boardKeys = useMemo(() => new Set(entries.map(entry => logicalEntityKey(localData, entry.classRef))), [entries, localData])
  const unlockKeys = new Set(travelUnlockEntries(localData, catalogs).map(entry => entry.key))
  const summonKeys = new Set(summonEntries(localData, catalogs).map(entry => entry.key))
  const otherRecords = records.filter(record => !boardKeys.has(logicalEntityKey(localData, record.subject)) && !unlockKeys.has(logicalEntityKey(localData, record.subject)) && !summonKeys.has(logicalEntityKey(localData, record.subject)))
  const counts = Object.fromEntries(CLASS_SEAL_STAGES.map(stage => [stage, displayedEntries.filter(entry => entry.stage === stage).length])) as Record<ProgressStage, number>
  const add = async (draft: ProgressDraft) => { await onAdd(draft); navigation.close() }
  const update = async (draft: ProgressDraft) => { if (!editing) return; await onUpdate(editing.id, draft); navigation.close() }
  const advance = useCallback((entry: ClassSealEntry) => {
    setSaveError(undefined)
    enqueue(entry.key, entry.stage, nextClassSealStage, () => onAdvance(entry.classRef, entry.className), (reason) => {
      setSaveError(current => current ?? (reason instanceof Error ? reason.message : `The ${entry.className} progress could not be saved.`))
    })
  }, [enqueue, onAdvance])
  const edit = useCallback((recordId: ProgressRecordId) => navigate({ page: 'progress', view: 'edit', recordId }), [navigate])
  const toggleSelection = useCallback((key: string) => setSelectedKeys(current => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  }), [])
  const cancelSelection = useCallback(() => {
    setSelecting(false)
    setSelectedKeys(new Set())
  }, [])
  const applyBulkStage = async (stage: ProgressStage) => {
    const selections = entries.filter(entry => selectedKeys.has(entry.key)).map(entry => ({ subject: entry.classRef, displayName: entry.className }))
    if (selections.length === 0) return
    setBulkSaving(true)
    setSaveError(undefined)
    try {
      await onSetStage(selections, stage)
      setSelectedKeys(new Set())
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : 'The selected class progress could not be saved.')
    } finally { setBulkSaving(false) }
  }
  return <ProgressPage actions={selecting ? undefined : <Button className="class-seal-multi-edit" disabled={queuedAdvanceCount > 0} onClick={() => { setSelecting(true); setSaveError(undefined) }} tone="secondary">Edit multiple</Button>} count={counts.sealAcquired} notices={<>
    {missingRecord && <InlineNotice title="Progress record unavailable" tone="warning">The requested progress record is not part of the active playthrough. It may have been removed or the link may belong to another playthrough. <Button onClick={() => navigate({ page: 'progress', view: 'list' })} tone="quiet">Return to progress</Button></InlineNotice>}
    {saveError && <InlineNotice title="Progress not saved" tone="danger">{saveError}</InlineNotice>}
    {selecting && <section aria-busy={bulkSaving} aria-label="Bulk edit class mastery" className="class-seal-bulk" data-saving={bulkSaving || undefined}>
      <div aria-live="polite" className="class-seal-bulk__summary"><strong>{selectedKeys.size} selected</strong><small>{bulkSaving ? 'Saving selected classes...' : 'Select classes below, then set their shared state.'}</small></div>
      <div className="class-seal-bulk__selection-actions"><Button disabled={bulkSaving || selectedKeys.size === entries.length} onClick={() => setSelectedKeys(new Set(entries.map(entry => entry.key)))} tone="secondary">Select all</Button><Button disabled={bulkSaving || selectedKeys.size === 0} onClick={() => setSelectedKeys(new Set())} tone="quiet">Clear</Button><Button disabled={bulkSaving} onClick={cancelSelection} tone="quiet">Done</Button></div>
      <div aria-label="Set selected classes to" className="class-seal-bulk__states" role="group"><span>Set selected to</span>{CLASS_SEAL_STAGES.map(stage => <Button className="class-seal-bulk__state" data-stage={stage} disabled={bulkSaving || selectedKeys.size === 0} key={stage} onClick={() => void applyBulkStage(stage)} tone={stage === 'sealAcquired' ? 'primary' : 'secondary'}>{STAGE_DETAILS[stage].label}</Button>)}</div>
    </section>}
    </>} summaryDetails={<dl className="class-seal-summary__stages">{CLASS_SEAL_STAGES.filter(stage => stage !== 'sealAcquired').map(stage => <div data-stage={stage} key={stage}><dt>{STAGE_DETAILS[stage].counterLabel}</dt><dd>{counts[stage]}</dd></div>)}</dl>} total={entries.length} variant="seals">
    {displayedEntries.length ? <section aria-label="Vanilla class mastery board" className="class-seal-board">{displayedEntries.map(entry => <ClassSealTile entry={entry} key={entry.key} onAdvance={advance} onEdit={edit} onToggleSelection={toggleSelection} pending={queuedAdvances.has(entry.key)} selected={selectedKeys.has(entry.key)} selecting={selecting}/>)}</section> : <InlineNotice title="Vanilla class references unavailable" tone="warning">The bundled vanilla class and seal references are unavailable. Restore the bundled catalog before recording this checklist.</InlineNotice>}
    <section className="progress-other"><div className="split"><div><h2>Other class records</h2><p>Personal classes and imported records outside the vanilla seal board remain separate.</p></div><Button icon="plus" onClick={() => navigate({ page: 'progress', view: 'new' })} tone="secondary">Add other class</Button></div>{otherRecords.length ? <div className="progress-other__rows">{otherRecords.map(record => <article className="progress-other__row" key={record.id}><div><strong>{record.displayName}</strong><small>{record.observedAt ? `Observed ${formatRelativeDate(record.observedAt)}` : 'Observation date unknown'}</small></div><Badge tone="info">{STAGE_DETAILS[classSealStage(record)].label}</Badge><Button onClick={() => navigate({ page: 'progress', view: 'edit', recordId: record.id })} tone="quiet">Details</Button></article>)}</div> : <p className="progress-other__empty">No additional class records.</p>}</section>
    <Sheet description="Record a class that is not part of the vanilla mastery-seal board." onClose={() => navigation.close()} open={adding} title="Add other class progress"><ProgressForm onCancel={() => navigation.close()} onSubmit={add}/></Sheet>
    <Sheet description="Update secondary details without changing the linked class identity." onClose={() => navigation.close()} open={Boolean(editing)} title="Edit progress record">{editing && <ProgressForm initial={editing} key={editing.id} onCancel={() => navigation.close()} onSubmit={update}/>}</Sheet>
  </ProgressPage>
}
