import { useState } from 'react'
import { compareCharacterSnapshots, snapshotSlots } from '../domain/character-snapshots'
import type { CatalogSnapshot, Character, CharacterSnapshot, CharacterSnapshotId, Profile } from '../domain/types'
import { Badge, Button, Field, InlineNotice } from './components'
import { CharacterSheet, SnapshotValueView } from './CharacterSheet'
import { formatRelativeDate, knowledgeLabel, ownRecordValue } from './model'
import { useNavigation, type CharactersPageRoute } from './navigation'

interface HistoryProps {
  readonly profile: Profile
  readonly catalogs: readonly CatalogSnapshot[]
  readonly character: Character
  readonly page: CharactersPageRoute
}

function snapshotLabel(snapshot: CharacterSnapshot, index: number): string {
  return `#${index + 1} · ${formatRelativeDate(snapshot.observedAt)} · ${snapshot.note || 'No note'}`
}

function SnapshotComparison({ profile, catalogs, character, page, snapshots, navigate }: HistoryProps & { readonly snapshots: readonly CharacterSnapshot[]; readonly navigate: (page: CharactersPageRoute) => void }) {
  const [showAll, setShowAll] = useState(false)
  const explicitPair = page.view === 'snapshot-pair'
  const leftId = explicitPair ? page.leftSnapshotId : snapshots.at(-2)?.id
  const rightId = explicitPair ? page.rightSnapshotId : snapshots.at(-1)?.id
  const left = leftId ? ownRecordValue(character.snapshots, leftId) : undefined
  const right = rightId ? ownRecordValue(character.snapshots, rightId) : undefined
  const selectPair = (a: CharacterSnapshotId | undefined, b: CharacterSnapshotId | undefined) => {
    if (a && b) navigate({ page: 'characters', view: 'snapshot-pair', characterId: character.id, leftSnapshotId: a, rightSnapshotId: b })
  }
  const selector = (label: string, id: CharacterSnapshotId | undefined, onChange: (id: CharacterSnapshotId) => void) => <Field label={label}><select onChange={(event) => onChange(event.target.value as CharacterSnapshotId)} value={id ?? ''}>{(!id || !ownRecordValue(character.snapshots, id)) && <option value={id ?? ''}>{id ? 'Snapshot unavailable' : 'Choose a snapshot'}</option>}{snapshots.map((snapshot, index) => <option key={snapshot.id} value={snapshot.id}>{snapshotLabel(snapshot, index)}</option>)}</select></Field>
  const leftRuleset = left?.rulesetRevisionId ? ownRecordValue(profile.rulesets, left.rulesetRevisionId) : undefined
  const rightRuleset = right?.rulesetRevisionId ? ownRecordValue(profile.rulesets, right.rulesetRevisionId) : undefined
  const rows = left && right ? compareCharacterSnapshots(left, right) : []
  const changedRows = rows.filter((row) => row.changed)
  const leftSlots = new Map(left ? snapshotSlots(profile, left).map((slot) => [slot.id, slot.label]) : [])
  const rightSlots = new Map(right ? snapshotSlots(profile, right).map((slot) => [slot.id, slot.label]) : [])
  return <div className="stack">
    <div><h3>Compare recorded snapshots</h3><p className="settings-section__intro">Differences between observations do not explain their cause. Learning records and build revisions are separate.</p></div>
    <div className="grid-2">{selector('Snapshot A', leftId, (id) => selectPair(id, rightId))}{selector('Snapshot B', rightId, (id) => selectPair(leftId, id))}</div>
    {(!left || !right) ? <InlineNotice title="Snapshot unavailable" tone="warning">Choose two snapshots from this character. A missing snapshot is never replaced with another record.</InlineNotice> : <>
      {!left.rulesetRevisionId && !right.rulesetRevisionId && <InlineNotice title="Slot context is unrecorded">These snapshots retain slot IDs without historical labels. No labels are borrowed from the active ruleset.</InlineNotice>}
      {left.rulesetRevisionId !== right.rulesetRevisionId && <InlineNotice title="Different slot contexts" tone="warning">Selections are paired by stored slot ID. A slot's label or meaning may differ between the recorded rulesets.</InlineNotice>}
      <div className="split"><span>{changedRows.length} changed fields</span><label className="snapshot-toggle"><input checked={showAll} onChange={(event) => setShowAll(event.target.checked)} type="checkbox"/>Show unchanged fields</label></div>
      {left.id === right.id && <InlineNotice title="Same snapshot selected">Select a different snapshot to inspect changes over time.</InlineNotice>}
      <div className="snapshot-comparison">{(showAll ? rows : changedRows).map((row) => {
        const aLabel = row.slotId ? leftSlots.get(row.slotId) ?? row.label : row.label
        const bLabel = row.slotId ? rightSlots.get(row.slotId) ?? row.label : row.label
        const unitsDiffer = row.left.kind === 'number' && row.right.kind === 'number' && row.left.unit !== row.right.unit
        return <section aria-label={aLabel === bLabel ? aLabel : `${aLabel} / ${bLabel}`} className="snapshot-difference" key={row.key}><h4>{aLabel === bLabel ? aLabel : `${aLabel} / ${bLabel}`}{!row.changed && <small>Unchanged</small>}</h4><div className="snapshot-difference__values"><div><span className="snapshot-difference__side">A · {formatRelativeDate(left.observedAt)}{row.slotId && aLabel !== bLabel ? ` · ${aLabel}` : ''}</span><SnapshotValueView catalogs={catalogs} profile={profile} ruleset={leftRuleset} showIdentity={row.changed} value={row.left}/>{unitsDiffer && row.left.kind === 'number' && row.left.unit && <small>Unit: {row.left.unit}</small>}</div><div><span className="snapshot-difference__side">B · {formatRelativeDate(right.observedAt)}{row.slotId && aLabel !== bLabel ? ` · ${bLabel}` : ''}</span><SnapshotValueView catalogs={catalogs} profile={profile} ruleset={rightRuleset} showIdentity={row.changed} value={row.right}/>{unitsDiffer && row.right.kind === 'number' && row.right.unit && <small>Unit: {row.right.unit}</small>}</div></div>{row.delta !== undefined && row.changed && <p className="snapshot-difference__delta">Observed difference (B minus A): {row.delta > 0 ? '+' : ''}{row.delta}</p>}</section>
      })}</div>
      {changedRows.length === 0 && !showAll && <p>No recorded fields differ.</p>}
    </>}
  </div>
}

export function CharacterHistory({ profile, catalogs, character, page }: HistoryProps) {
  const navigation = useNavigation()
  const snapshots = Object.values(character.snapshots).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id))
  const navigate = (next: CharactersPageRoute) => navigation.navigate({ page: next, overlays: [], query: {} })
  const history = () => navigate({ page: 'characters', view: 'character', characterId: character.id, tab: 'history' })
  if (page.view === 'snapshot-compare' || page.view === 'snapshot-pair') return <div className="stack"><div><Button onClick={history} tone="quiet">Back to snapshot history</Button></div><SnapshotComparison catalogs={catalogs} character={character} navigate={navigate} page={page} profile={profile} snapshots={snapshots}/></div>
  if (page.view === 'snapshot') {
    const snapshot = ownRecordValue(character.snapshots, page.snapshotId)
    return <div className="stack"><div className="split"><Button onClick={history} tone="quiet">Back to snapshot history</Button><Badge tone={snapshot?.id === character.currentSnapshotId ? 'positive' : 'info'}>{snapshot?.id === character.currentSnapshotId ? 'Current snapshot' : 'Recorded snapshot'}</Badge></div>{snapshot ? <CharacterSheet catalogs={catalogs} profile={profile} snapshot={snapshot}/> : <InlineNotice title="Snapshot unavailable" tone="warning">This snapshot is not part of the selected character. Choose a recorded snapshot from History.</InlineNotice>}</div>
  }
  return <div className="stack"><div className="split"><div><h3>Recorded snapshot history</h3><p className="settings-section__intro">Inspect observations or compare what was recorded. Proposed build revisions stay in Builds & teams.</p></div><Button disabled={snapshots.length < 2} onClick={() => {
    const a = snapshots.at(-2)
    const b = snapshots.at(-1)
    if (a && b) navigate({ page: 'characters', view: 'snapshot-pair', characterId: character.id, leftSnapshotId: a.id, rightSnapshotId: b.id })
  }} tone="secondary">Compare snapshots</Button></div>{snapshots.length ? [...snapshots].reverse().map((snapshot) => <article className="snapshot-history-row" key={snapshot.id}><div><h4>{snapshot.observedAt ? `Observed ${formatRelativeDate(snapshot.observedAt)}` : 'Observation date unknown'}</h4><small>Recorded {formatRelativeDate(snapshot.recordedAt)} · Level {knowledgeLabel(snapshot.level)}</small>{snapshot.note && <p>{snapshot.note}</p>}</div><div className="snapshot-history-row__actions">{snapshot.id === character.currentSnapshotId && <Badge tone="positive">Current snapshot</Badge>}<Button onClick={() => navigate({ page: 'characters', view: 'snapshot', characterId: character.id, snapshotId: snapshot.id })} tone="secondary">Inspect snapshot</Button></div></article>) : <InlineNotice title="No snapshot history">Capture the first observed sheet to begin a snapshot history.</InlineNotice>}</div>
}
