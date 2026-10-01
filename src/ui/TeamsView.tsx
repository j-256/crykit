import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createId, entityDefinitionKey, requirePlaythrough, validateScenario } from '../domain'
import { createScenario, TEAM_SIZE } from '../domain/scenarios'
import { sameBuildBehavior } from '../domain/build-behavior'
import type { DraftActions, DraftChangeHandler } from './drafts'
import { ValidationPanel } from './BuildReadiness'
import type { SaveTeamInput } from '../domain/teams'
import type { BuildRevisionId, CatalogSnapshot, CharacterId, LocalData, ScenarioId, Team, TeamId } from '../domain/types'
import { BuildCharacterComparison } from './BuildCharacterComparison'
import { BuildLoadoutSummary } from './BuildLoadoutSummary'
import { Button, EmptyState, Field, InlineNotice, ScreenHeader } from './components'
import { formatAppError } from './model'
import { ShareButton } from './ShareButton'
import { useNavigation, useNavigationBlocker } from './navigation'

const emptyTeamSlots = (): readonly (BuildRevisionId | null)[] => Array.from({ length: TEAM_SIZE }, () => null)

interface Props {
  readonly localData: LocalData
  readonly catalogs: readonly CatalogSnapshot[]
  readonly onDraftChange: DraftChangeHandler
  readonly onSave: (input: SaveTeamInput) => Promise<TeamId>
  readonly onAdopt: (id: TeamId, characterIds: readonly CharacterId[]) => Promise<void>
}

function TeamEditor({ team, localData, catalogs, onSave, onDraftChange }: Props & { readonly team?: Team }) {
  const navigation = useNavigation()
  const [id] = useState(() => team?.id ?? createId<TeamId>('team'))
  const [title, setTitle] = useState(team?.title ?? '')
  const [slots, setSlots] = useState<readonly (BuildRevisionId | null)[]>(team?.slots ?? emptyTeamSlots())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const dirty = title !== (team?.title ?? '') || JSON.stringify(slots) !== JSON.stringify(team?.slots ?? emptyTeamSlots())
  const actionsRef = useRef<DraftActions | undefined>(undefined)
  const registeredActions = useRef<DraftActions>({ save: () => actionsRef.current?.save() ?? Promise.resolve(false), discard: () => actionsRef.current?.discard() })
  useEffect(() => { onDraftChange(dirty, dirty ? registeredActions.current : undefined); return () => onDraftChange(false) }, [dirty, onDraftChange])
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  useNavigationBlocker(navigation.route, () => dirtyRef.current, () => setError('Save or discard your Team changes before leaving.'))
  useEffect(() => {
    if (!dirty) return
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [dirty])
  const back = () => { dirtyRef.current = false; onDraftChange(false); navigation.navigate({ page: { page: 'teams', view: 'list' }, overlays: [], query: {} }) }
  const save = async () => {
    if (busy || !title.trim()) return false
    setBusy(true)
    setError(undefined)
    try {
      const saved = await onSave({ id, title, slots })
      dirtyRef.current = false
      onDraftChange(false)
      navigation.navigate({ page: { page: 'teams', view: 'team', teamId: saved }, overlays: [], query: {} }, { replace: true })
      return true
    } catch (reason) { setError(formatAppError(reason, 'The Team could not be saved.')); return false }
    finally { setBusy(false) }
  }
  actionsRef.current = { save, discard: () => { setTitle(team?.title ?? ''); setSlots(team?.slots ?? emptyTeamSlots()); dirtyRef.current = false; onDraftChange(false); setError(undefined) } }
  const submit = (event: FormEvent) => { event.preventDefault(); void save() }
  const builds = Object.values(localData.builds).filter(build => build.state !== 'archived' || slots.some(id => id && localData.buildRevisions[id]?.buildId === build.id)).sort((left, right) => left.title.localeCompare(right.title))
  return <form className="stack" onSubmit={submit}>
    <ScreenHeader eyebrow="Buildcrafting" title={team ? team.title : 'New Team'} description="Choose four build checkpoints. You can reuse the same build in multiple slots." actions={<Button disabled={busy} onClick={back} tone="quiet" type="button">{dirty ? 'Discard and return' : 'All Teams'}</Button>}/>
    {error && <InlineNotice title="Team not saved" tone="danger">{error} Your selections remain available.</InlineNotice>}
    <Field label="Team name" required><input disabled={busy} required value={title} onChange={event => setTitle(event.target.value)}/></Field>
    <div className="share-team-grid">{slots.map((id, index) => {
      const revision = id ? localData.buildRevisions[id] : undefined
      const setup = revision ? localData.gameSetups[revision.gameSetupRevisionId] : undefined
      return <section aria-label={`Team slot ${index + 1} loadout`} className="panel team-loadout-card" key={index}><header className="panel__header"><h2>Slot {index + 1}</h2></header><div className="panel__body stack"><Field label={`Team slot ${index + 1}`}><select disabled={busy} value={id ?? ''} onChange={event => setSlots(values => values.map((value, slotIndex) => slotIndex === index ? event.target.value as BuildRevisionId || null : value))}><option value="">Choose a build checkpoint</option>{builds.map(build => <optgroup key={build.id} label={build.title}>{Object.values(localData.buildRevisions).filter(revision => revision.buildId === build.id).sort((left, right) => right.revision - left.revision).map(revision => <option key={revision.id} value={revision.id}>{build.title} · r{revision.revision}</option>)}</optgroup>)}</select></Field>{revision && <><BuildLoadoutSummary content={revision.content} catalogs={catalogs} localData={localData} gameSetup={setup}/><Button tone="quiet" type="button" disabled={busy || dirty} onClick={() => navigation.navigate({ page: { page: 'builds', view: 'revision', buildId: revision.buildId, revisionId: revision.id }, overlays: [], query: {} })}>Open checkpoint</Button></>}</div></section>
    })}</div>
    {builds.length === 0 && <p>Create a Build first, or save an empty Team and fill its slots later.</p>}
    <div className="form-actions"><Button disabled={busy || !title.trim() || !!team && !dirty} icon="check" type="submit">{busy ? 'Saving...' : 'Save Team'}</Button>{team && <ShareButton disabled={busy || dirty || !slots.some(Boolean)} localData={localData} target={{ kind: 'team', teamId: team.id }}/>}</div>
    {team && <details><summary>Use with Tracking</summary><div className="stack"><p>Compare these builds with tracked characters, then record the Team as their current loadouts.</p><Button disabled={busy || dirty || slots.some(id => !id)} onClick={() => navigation.navigate({ page: { page: 'teams', view: 'adopt', teamId: team.id }, overlays: [], query: {} })} tone="secondary" type="button">Adopt Team</Button></div></details>}
  </form>
}

function AdoptTeam({ team, localData, catalogs, onAdopt }: Props & { readonly team: Team }) {
  const navigation = useNavigation()
  const playthrough = requirePlaythrough(localData)
  const characters = Object.values(playthrough.characters)
  const [previewId] = useState(() => createId<ScenarioId>('team-preview'))
  const [ids, setIds] = useState<readonly string[]>(() => Array.from({ length: TEAM_SIZE }, () => ''))
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const complete = ids.every(id => !!playthrough.characters[id]) && new Set(ids).size === TEAM_SIZE && team.slots.every(id => !!id)
  const compatible = team.slots.every(id => {
    const first = localData.buildRevisions[team.slots[0] ?? '']
    const revision = localData.buildRevisions[id ?? '']
    return first && revision && sameBuildBehavior(localData.gameSetups[first.gameSetupRevisionId], localData.gameSetups[revision.gameSetupRevisionId])
  })
  const preview = useMemo(() => {
    if (!complete) return undefined
    const first = localData.buildRevisions[team.slots[0]!]!
    const id = previewId
    const data = createScenario(localData, { id, label: team.title, memberIds: ids as CharacterId[], gameSetupRevisionId: first.gameSetupRevisionId, catalogLock: first.catalogLock, assignments: Object.fromEntries(ids.map((id, index) => [id, team.slots[index]!])), inventoryPolicy: { enforceStock: true, includeProtected: true }, activate: false })
    const index = { snapshots: Object.fromEntries(catalogs.map(catalog => [JSON.stringify([catalog.id, catalog.revisionId]), catalog])), entitiesByRef: Object.fromEntries(catalogs.flatMap(catalog => Object.values(catalog.entities).map(entity => [entityDefinitionKey({ kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entity.id }), entity]))) }
    return { data, scenario: requirePlaythrough(data).scenarios[id]!, report: validateScenario(data, id, index) }
  }, [catalogs, complete, ids, localData, previewId, team])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!compatible || !complete || !confirmed) return
    setBusy(true)
    setError(undefined)
    try { await onAdopt(team.id, ids as CharacterId[]); navigation.navigate({ page: { page: 'characters', view: 'list' }, overlays: [], query: {} }) }
    catch (reason) { setError(formatAppError(reason, 'The Team could not be recorded.')) }
    finally { setBusy(false) }
  }
  return <form className="stack" onSubmit={submit}>
    <ScreenHeader eyebrow="Tracking" title={`Adopt ${team.title}`} description={`Match builds to characters in ${playthrough.label}. Review the differences before recording the party.`} actions={<Button onClick={() => navigation.navigate({ page: { page: 'teams', view: 'team', teamId: team.id }, overlays: [], query: {} })} tone="quiet" type="button">Back to Team</Button>}/>
    {error && <InlineNotice title="Team not recorded" tone="danger">{error} No partial party was saved.</InlineNotice>}
    {characters.length < TEAM_SIZE && <InlineNotice title="Tracked characters needed">Create four characters under Tracking to adopt a complete Team. The Team itself stays available for buildcrafting.<Button type="button" tone="secondary" onClick={() => navigation.navigate({ page: { page: 'characters', view: 'new' }, overlays: [], query: {} })}>Add a tracked character</Button></InlineNotice>}
    {team.slots.map((id, index) => {
      const revision = id ? localData.buildRevisions[id] : undefined
      const character = playthrough.characters[ids[index]!]
      return <section className="panel" key={index}><header className="panel__header"><h2>{index + 1}. {revision ? localData.builds[revision.buildId]?.title : 'Empty slot'}</h2></header><div className="panel__body stack"><Field label={`Tracked character ${index + 1}`}><select disabled={busy} value={ids[index]} onChange={event => { setIds(values => values.map((id, position) => position === index ? event.target.value : id)); setConfirmed(false) }}><option value="">Choose character</option>{characters.map(character => <option disabled={ids.some((id, position) => position !== index && id === character.id)} key={character.id} value={character.id}>{character.name}</option>)}</select></Field>{revision && character && <details><summary>Compare with current loadout</summary><BuildCharacterComparison revision={revision} character={character} localData={localData} catalogs={catalogs}/></details>}</div></section>
    })}
    {!compatible && <InlineNotice title="Different Game Setups" tone="warning">These build checkpoints use different rules. Save compatible checkpoints before recording them as one party.</InlineNotice>}
    {preview && <details><summary>Check party readiness and shared equipment</summary><ValidationPanel report={preview.report} scenario={preview.scenario} localData={preview.data} catalogs={catalogs}/></details>}
    <p>Recording creates new character snapshots and preserves their history. Displayed stats need recapture. Learning, levels, and inventory are not granted by adopting builds.</p>
    <label className="check-row"><input type="checkbox" checked={confirmed} disabled={!complete || !compatible || busy} onChange={event => setConfirmed(event.target.checked)}/><span>I applied these builds in game</span></label>
    <Button disabled={!complete || !compatible || !confirmed || busy} type="submit">{busy ? 'Recording...' : 'Record Team as current'}</Button>
  </form>
}

export function TeamsView(props: Props) {
  const navigation = useNavigation()
  const page = navigation.route.page
  if (page.page !== 'teams') return null
  const team = 'teamId' in page ? props.localData.teams[page.teamId] : undefined
  if ('teamId' in page && !team) return <InlineNotice title="Team unavailable">The requested Team is not saved in this browser.</InlineNotice>
  if (page.view === 'adopt' && team) return <AdoptTeam {...props} team={team} key={`${team.id}:${props.localData.selectedPlaythroughId}`}/>
  if (page.view !== 'list') return <TeamEditor {...props} team={team} key={team?.id ?? 'new'}/>
  const teams = Object.values(props.localData.teams).sort((left, right) => left.title.localeCompare(right.title))
  const create = () => navigation.navigate({ page: { page: 'teams', view: 'new' }, overlays: [], query: {} })
  return <div className="stack"><ScreenHeader eyebrow="Buildcrafting" title="Teams" description="Four builds designed to work together. Plan, save, and share them independently of any Playthrough." actions={<Button onClick={create} icon="plus">New Team</Button>}/>{teams.length === 0 ? <EmptyState title="Plan a Team" description="Choose four build checkpoints. Tracking is optional." icon="team"><Button onClick={create}>Create Team</Button></EmptyState> : teams.map(team => <section className="panel" key={team.id}><header className="panel__header"><h2>{team.title}</h2><Button tone="secondary" onClick={() => navigation.navigate({ page: { page: 'teams', view: 'team', teamId: team.id }, overlays: [], query: {} })}>Open Team</Button></header><div className="panel__body"><ol>{team.slots.map((id, index) => { const revision = id ? props.localData.buildRevisions[id] : undefined; return <li key={index}>{revision ? `${props.localData.builds[revision.buildId]?.title ?? 'Build'} · r${revision.revision}` : 'Empty slot'}</li> })}</ol></div></section>)}</div>
}
