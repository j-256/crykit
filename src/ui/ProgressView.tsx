import { useMemo, useState, type FormEvent } from 'react'
import type { CatalogSnapshot, EntityRef, Knowledge, PartyProgressRecord, Profile, ProgressRecordId, ProgressStage } from '../domain/types'
import { Badge, Button, EmptyState, Field, InlineNotice, ScreenHeader } from './components'
import { formatRelativeDate, knowledgeTone, ownRecordValue } from './model'
import { Sheet } from './Sheet'
import { DefinitionPickerField, findDefinitionOption, useDefinitionWorkspace } from './definitions'
import { useNavigation, type ProgressPageRoute } from './navigation'

const UNKNOWN_BOOLEAN: Knowledge<boolean> = { state: 'unknown' }
const UNKNOWN_LOCATION: Knowledge<string> = { state: 'unknown' }
const UNKNOWN_STAGE: Knowledge<ProgressStage> = { state: 'unknown' }

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
  readonly profile: Profile
  readonly catalogs: readonly CatalogSnapshot[]
  readonly onAdd: (draft: ProgressDraft) => Promise<void>
  readonly onUpdate: (recordId: ProgressRecordId, draft: ProgressDraft) => Promise<void>
}

function booleanSelectValue(value: Knowledge<boolean>): string {
  return value.state === 'known' ? String(value.value) : value.state
}

function BooleanKnowledgeField({ label, value, onChange }: {
  readonly label: string
  readonly value: Knowledge<boolean>
  readonly onChange: (value: Knowledge<boolean>) => void
}) {
  const specialState = value.state === 'conflicting' || value.state === 'notApplicable' ? value.state : undefined
  return <Field label={label}><select onChange={(event) => onChange(event.target.value === 'true' ? { state: 'known', value: true } : event.target.value === 'false' ? { state: 'known', value: false } : { state: 'unknown' })} value={booleanSelectValue(value)}><option value="unknown">Unknown</option><option value="true">Yes</option><option value="false">No</option>{specialState === 'conflicting' && <option disabled value="conflicting">Conflicting claims</option>}{specialState === 'notApplicable' && <option disabled value="notApplicable">Not applicable</option>}</select></Field>
}

function progressDraft(record?: PartyProgressRecord): ProgressDraft {
  return {
    name: record?.displayName ?? '',
    ...(record ? { subject: record.subject } : {}),
    stage: record?.stage ?? UNKNOWN_STAGE,
    unlocked: record?.unlocked ?? UNKNOWN_BOOLEAN,
    partyMastery: record?.partyMastery ?? UNKNOWN_BOOLEAN,
    collection: record?.collection ?? UNKNOWN_BOOLEAN,
    masterLocation: record?.masterLocation ?? UNKNOWN_LOCATION,
    ...(record?.observedAt ? { observedAt: record.observedAt.slice(0, 10) } : {}),
  }
}

function ProgressForm({ initial, onCancel, onSubmit }: {
  readonly initial?: PartyProgressRecord
  readonly onCancel: () => void
  readonly onSubmit: (draft: ProgressDraft) => Promise<void>
}) {
  const { options } = useDefinitionWorkspace()
  const [draft, setDraft] = useState<ProgressDraft>(() => progressDraft(initial))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const stageValue = draft.stage.state === 'known' ? draft.stage.value : draft.stage.state
  const stageSpecialState = draft.stage.state === 'conflicting' || draft.stage.state === 'notApplicable' ? draft.stage.state : undefined
  const locationSpecialState = draft.masterLocation.state === 'conflicting' || draft.masterLocation.state === 'notApplicable' ? draft.masterLocation.state : undefined
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try { await onSubmit(draft) } catch (reason) { setError(reason instanceof Error ? reason.message : 'The progress observation could not be saved.') } finally { setBusy(false) }
  }
  return <form className="stack" onSubmit={submit}>
    <DefinitionPickerField allowedKinds={['class']} autoFocus disabled={Boolean(initial)} hint={initial ? 'The linked subject identity stays unchanged while its observations are edited.' : 'Choose an exact class definition or create a personal class.'} label="Class reference" onChange={(ref) => { const option = findDefinitionOption(options, ref); setDraft({ ...draft, subject: ref ?? undefined, name: option?.name ?? draft.name }) }} routeKey="class-reference" value={draft.subject}/>
    <Field label="Class display name" required><input onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Enter the class name" required value={draft.name}/></Field>
    <Field hint="Unknown remains distinct from the unclassified tracking group." label="Tracking group"><select onChange={(event) => setDraft({ ...draft, stage: event.target.value === 'unknown' ? UNKNOWN_STAGE : { state: 'known', value: event.target.value as ProgressStage } })} value={stageValue}><option value="unknown">Unknown</option><option value="collected">Seal collected</option><option value="masteredPending">Mastered, collection pending</option><option value="inProgress">In progress</option><option value="unclassified">Unclassified</option>{stageSpecialState === 'conflicting' && <option disabled value="conflicting">Conflicting claims</option>}{stageSpecialState === 'notApplicable' && <option disabled value="notApplicable">Not applicable</option>}</select></Field>
    <div className="grid-3"><BooleanKnowledgeField label="Unlocked" onChange={(unlocked) => setDraft({ ...draft, unlocked })} value={draft.unlocked}/><BooleanKnowledgeField label="Party mastery" onChange={(partyMastery) => setDraft({ ...draft, partyMastery })} value={draft.partyMastery}/><BooleanKnowledgeField label="Seal collected" onChange={(collection) => setDraft({ ...draft, collection })} value={draft.collection}/></div>
    <div className="field"><span className="field__label">Master location</span><select aria-label="Master location certainty" onChange={(event) => setDraft({ ...draft, masterLocation: event.target.value === 'known' ? { state: 'known', value: '' } : UNKNOWN_LOCATION })} value={draft.masterLocation.state}><option value="unknown">Unknown</option><option value="known">Known</option>{locationSpecialState === 'conflicting' && <option disabled value="conflicting">Conflicting claims</option>}{locationSpecialState === 'notApplicable' && <option disabled value="notApplicable">Not applicable</option>}</select>{draft.masterLocation.state === 'known' && <input aria-label="Master location" onChange={(event) => setDraft({ ...draft, masterLocation: { state: 'known', value: event.target.value } })} placeholder="Enter the observed destination or area" required value={draft.masterLocation.value}/>}<span className="field__hint">A destination or area is not a verified route.</span></div>
    <Field hint={initial?.observedAt ? 'Clear this field to explicitly remove the saved observation date.' : undefined} label="Observed on"><input onChange={(event) => setDraft({ ...draft, observedAt: event.target.value || (initial?.observedAt ? null : undefined) })} type="date" value={draft.observedAt ?? ''}/></Field>
    <InlineNotice title="Dimensions stay separate">Collecting a seal does not change per-character mastery or create an exact accessory count.</InlineNotice>
    {initial && <InlineNotice title="Stable progress record">Saving updates this record and keeps its exact subject reference. A matching display name never creates or links another identity.</InlineNotice>}
    {error && <InlineNotice title="Progress not saved" tone="danger">{error} Your entered values remain in this form.</InlineNotice>}
    <div className="form-actions"><Button onClick={onCancel} tone="quiet" type="button">Cancel</Button><Button disabled={busy || !draft.name.trim()} icon="check" type="submit">{busy ? 'Saving...' : initial ? 'Save changes' : 'Save progress'}</Button></div>
  </form>
}

const groups: readonly { readonly stage: ProgressStage; readonly title: string; readonly description: string }[] = [
  { stage: 'inProgress', title: 'In progress', description: 'Classes actively being learned or investigated' },
  { stage: 'masteredPending', title: 'Mastered, collection pending', description: 'Party milestone recorded; seal remains separate' },
  { stage: 'collected', title: 'Collected', description: 'Seal collection recorded' },
  { stage: 'unclassified', title: 'Unclassified', description: 'Records awaiting a clearer observation' },
]

export function ProgressView({ profile, onAdd, onUpdate }: ProgressViewProps) {
  const navigation = useNavigation()
  const records = Object.values(profile.progress)
  const page = navigation.route.page.page === 'progress' ? navigation.route.page : { page: 'progress', view: 'list' } as const
  const adding = page.view === 'new'
  const editing = page.view === 'edit' ? ownRecordValue(profile.progress, page.recordId) : undefined
  const missingRecord = page.view === 'edit' && !editing
  const navigate = (next: ProgressPageRoute) => navigation.navigate({ ...navigation.route, page: next, overlays: [] })
  const grouped = useMemo(() => Object.fromEntries(groups.map((group) => [group.stage, records.filter((record) => record.stage.state === 'known' ? record.stage.value === group.stage : group.stage === 'unclassified')])), [records])
  const add = async (draft: ProgressDraft) => { await onAdd(draft); navigation.close() }
  const update = async (draft: ProgressDraft) => { if (!editing) return; await onUpdate(editing.id, draft); navigation.close() }
  return <>
    <ScreenHeader actions={<Button icon="plus" onClick={() => navigate({ page: 'progress', view: 'new' })}>Add progress</Button>} description="Track class unlocks, party mastery, collection, and individual learning as separate facts." eyebrow="Expedition milestones" title="Progress"/>
    {missingRecord && <InlineNotice title="Progress record unavailable" tone="warning">The requested progress record is not part of the active playthrough. It may have been removed or the link may belong to another profile. <Button onClick={() => navigate({ page: 'progress', view: 'list' })} tone="quiet">Return to progress</Button></InlineNotice>}
    {records.length === 0 ? <EmptyState aside={<>Imported party progress belongs here only after a review. It will not populate characters, inventory counts, or builds.</>} description="Record a class milestone manually, or import a playthrough record and preview each progress group before saving." icon="compass" title="No milestones recorded"><Button icon="plus" onClick={() => navigate({ page: 'progress', view: 'new' })}>Add class progress</Button></EmptyState> : <div className="progress-groups">{groups.map((group) => {
      const rows = grouped[group.stage] ?? []
      if (!rows.length) return null
      return <section className="progress-group" key={group.stage}><header className="progress-group__header"><div><h2>{group.title}</h2><p>{group.description}</p></div><Badge tone={group.stage === 'collected' ? 'positive' : group.stage === 'unclassified' ? 'warning' : 'info'}>{rows.length}</Badge></header>{rows.map((record) => <article className="progress-row" key={record.id}><div><strong>{record.displayName}</strong><small>{record.observedAt ? `Observed ${formatRelativeDate(record.observedAt)}` : 'Observation date unknown'}</small></div><Badge tone={knowledgeTone(record.stage)}>{record.stage.state === 'known' ? group.title : record.stage.state === 'conflicting' ? 'Stage claims conflict' : 'Stage unknown'}</Badge><div>{group.stage === 'collected' ? <small>Master location hidden in this progress view</small> : <><strong>{record.masterLocation.state === 'known' ? record.masterLocation.value : record.masterLocation.state === 'conflicting' ? 'Location claims conflict' : 'Master location unknown'}</strong><small>Destination only; route not inferred</small></>}</div><Button onClick={() => navigate({ page: 'progress', view: 'edit', recordId: record.id })} tone="quiet">Edit</Button></article>)}</section>
    })}</div>}
    <Sheet description="Record only the milestone dimensions you have actually observed." onClose={() => navigation.close()} open={adding} title="Add class progress"><ProgressForm onCancel={() => navigation.close()} onSubmit={add}/></Sheet>
    <Sheet description="Update this progress record without changing its linked subject identity." onClose={() => navigation.close()} open={Boolean(editing)} title="Edit progress record">{editing && <ProgressForm initial={editing} key={editing.id} onCancel={() => navigation.close()} onSubmit={update}/>}</Sheet>
  </>
}
