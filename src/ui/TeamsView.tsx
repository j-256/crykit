import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { createId, entityDefinitionKey, requirePlaythrough, validateScenario } from '../domain'
import { createScenario, TEAM_SIZE } from '../domain/scenarios'
import { sameBuildBehavior } from '../domain/build-behavior'
import type { DraftActions, DraftChangeHandler } from './drafts'
import { ValidationPanel } from './BuildReadiness'
import type { SaveTeamInput } from '../domain/teams'
import type { BuildId, BuildRevisionId, CatalogSnapshot, CharacterId, LocalData, ScenarioId, Team, TeamId } from '../domain/types'
import { BuildCharacterComparison } from './BuildCharacterComparison'
import { BuildLoadoutSummary } from './BuildLoadoutSummary'
import { TeamBuildEditor, type BuildDraft, type RevisionDraft } from './BuildsView'
import { TeamCheckpointComparison } from './TeamCheckpointComparison'
import { TeamReview, newerTeamCheckpoint } from './TeamReview'
import './team-workflow.css'
import { Button, EmptyState, Field, InlineNotice, ScreenHeader } from './components'
import { formatAppError } from './model'
import { ShareButton } from './ShareButton'
import { useNavigation, useNavigationBlocker } from './navigation'
import { WorkspacePrimaryAction } from './WorkspaceHeader'

const emptyTeamSlots = (): readonly (BuildRevisionId | null)[] => Array.from({ length: TEAM_SIZE }, () => null)

interface Props {
  readonly localData: LocalData
  readonly catalogs: readonly CatalogSnapshot[]
  readonly onDraftChange: DraftChangeHandler
  readonly onSave: (input: SaveTeamInput) => Promise<TeamId>
  readonly onAdopt: (id: TeamId, characterIds: readonly CharacterId[]) => Promise<void>
  readonly onSaveMember: (input: { readonly team: SaveTeamInput; readonly slotIndex: number; readonly build?: BuildDraft; readonly revision: RevisionDraft; readonly sourceRevisionId?: BuildRevisionId }) => Promise<{ buildId: BuildId; revisionId: BuildRevisionId }>
}

function TeamEditor({ team, localData, catalogs, onSave, onSaveMember, onDraftChange }: Props & { readonly team?: Team }) {
  const formId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const navigation = useNavigation()
  const [id] = useState(() => team?.id ?? createId<TeamId>('team'))
  const [title, setTitle] = useState(team?.title ?? '')
  const [slots, setSlots] = useState<readonly (BuildRevisionId | null)[]>(team?.slots ?? emptyTeamSlots())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [member, setMember] = useState<{ readonly index: number; readonly revisionId?: BuildRevisionId }>()
  const [memberDirty, setMemberDirty] = useState(false)
  const [savedMemberTeamId, setSavedMemberTeamId] = useState<TeamId>()
  const memberActionsRef = useRef<DraftActions | undefined>(undefined)
  const memberDraftChange = useCallback<DraftChangeHandler>((dirty, actions) => { setMemberDirty(dirty); memberActionsRef.current = actions }, [])
  const teamDirty = title !== (team?.title ?? '') || JSON.stringify(slots) !== JSON.stringify(team?.slots ?? emptyTeamSlots())
  const dirty = !savedMemberTeamId && (teamDirty || memberDirty)
  const actionsRef = useRef<DraftActions | undefined>(undefined)
  const registeredActions = useRef<DraftActions>({ save: () => actionsRef.current?.save() ?? Promise.resolve(false), discard: () => actionsRef.current?.discard() })
  useEffect(() => { onDraftChange(dirty, dirty ? registeredActions.current : undefined); return () => onDraftChange(false) }, [dirty, onDraftChange])
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  useEffect(() => {
    if (!savedMemberTeamId) return
    dirtyRef.current = false
    navigation.navigate({ page: { page: 'teams', view: 'team', teamId: savedMemberTeamId }, overlays: [], query: {} }, { replace: true })
    setSavedMemberTeamId(undefined)
  }, [navigation, savedMemberTeamId])
  useNavigationBlocker(navigation.route, () => dirtyRef.current, () => setError('Save or discard your Team and member changes before leaving.'))
  useEffect(() => {
    if (!dirty) return
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [dirty])
  const back = () => { dirtyRef.current = false; onDraftChange(false); navigation.navigate({ page: { page: 'teams', view: 'list' }, overlays: [], query: {} }) }
  const save = async (adopt = false) => {
    if (busy || !title.trim() || formRef.current && !formRef.current.reportValidity()) return false
    setBusy(true)
    setError(undefined)
    try {
      const saved = await onSave({ id, title, slots })
      dirtyRef.current = false
      onDraftChange(false)
      navigation.navigate({ page: { page: 'teams', view: adopt ? 'adopt' : 'team', teamId: saved }, overlays: [], query: {} }, { replace: !adopt })
      return true
    } catch (reason) { setError(formatAppError(reason, 'The Team could not be saved.')); return false }
    finally { setBusy(false) }
  }
  const closeMember = () => { setMember(undefined); setMemberDirty(false); memberActionsRef.current = undefined }
  actionsRef.current = {
    save: () => member && memberDirty && memberActionsRef.current ? memberActionsRef.current.save() : save(),
    discard: () => {
      memberActionsRef.current?.discard()
      closeMember()
      setTitle(team?.title ?? '')
      setSlots(team?.slots ?? emptyTeamSlots())
      dirtyRef.current = false
      onDraftChange(false)
      setError(undefined)
    },
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void save() }
  const builds = Object.values(localData.builds).filter(build => !build.archived || slots.some(id => id && localData.buildRevisions[id]?.buildId === build.id)).sort((left, right) => left.title.localeCompare(right.title))
  const reusedSetup = slots.map(slot => slot ? localData.buildRevisions[slot] : undefined).find(Boolean)?.gameSetupRevisionId
  const sourceRevision = member?.revisionId ? localData.buildRevisions[member.revisionId] : undefined
  const returnFromMember = () => { if (memberDirty) memberActionsRef.current?.discard(); closeMember() }
  if (member) return <div className="stack">
    <ScreenHeader unsavedObject={!sourceRevision} eyebrow={title.trim() || 'New Team'} title={sourceRevision ? `Edit ${localData.builds[sourceRevision.buildId]?.title ?? 'member'}` : `Create member ${member.index + 1}`} description="Save this member to create a checkpoint and assign it to this Team. Other Teams keep their pinned checkpoints." breadcrumb={<Button disabled={busy} icon="arrow-left" onClick={returnFromMember} title={`Return to ${title.trim() || 'Team'}${memberDirty ? ' and discard this member edit' : ''}`} tone="quiet" type="button">{memberDirty ? 'Discard and return' : 'Return to Team'}</Button>}/>
    <section aria-label="Team member context" className="team-member-context">
      <strong>{title.trim() || 'New Team'} · Slot {member.index + 1}</strong>
      <p>{teamDirty ? 'Your Team name and slot changes stay here while you edit. Saving this member saves those Team changes too.' : 'Your Team stays open while you edit this member.'}</p>
      {!title.trim() && <p>The Team will be saved as "New Team". You can rename it on return.</p>}
      {!sourceRevision && reusedSetup && <p>Starting with this Team's Game Setup: {localData.gameSetups[reusedSetup]?.label ?? 'Saved setup'}. You can review or change it below.</p>}
    </section>
    {error && <InlineNotice title="Team not saved" tone="danger">{error} Your selections remain available.</InlineNotice>}
    <TeamBuildEditor catalogs={catalogs} gameSetupRevisionId={reusedSetup} localData={localData} onCancel={closeMember} onDraftChange={memberDraftChange} sourceRevision={sourceRevision} onSubmit={async (build, revision) => {
      setBusy(true)
      setError(undefined)
      try {
        const savedTitle = title.trim() || 'New Team'
        const saved = await onSaveMember({ team: { id, title: savedTitle, slots }, slotIndex: member.index, build, revision, sourceRevisionId: sourceRevision?.id })
        setTitle(savedTitle)
        setSlots(values => values.map((value, index) => index === member.index ? saved.revisionId : value))
        dirtyRef.current = false
        onDraftChange(false)
        closeMember()
        setSavedMemberTeamId(id)
        return saved
      } finally { setBusy(false) }
    }}/>
  </div>
  return <form className="stack" id={formId} onSubmit={submit} ref={formRef}>
    <ScreenHeader eyebrow="Buildcrafting" title={team ? team.title : 'New Team'} description="Create members here or choose saved checkpoints. Draft Teams can be saved at any stage." breadcrumb={<Button disabled={busy} icon="arrow-left" onClick={back} tone="quiet" type="button">{dirty ? 'Discard and return' : 'All Teams'}</Button>} actions={team && <ShareButton disabled={busy || dirty || !slots.some(Boolean)} localData={localData} target={{ kind: 'team', teamId: team.id }}/>}/>
    {error && <InlineNotice title="Team not saved" tone="danger">{error} Your selections remain available.</InlineNotice>}
    <Field label="Team name" required><input disabled={busy} required value={title} onChange={event => setTitle(event.target.value)}/></Field>
    <TeamReview catalogs={catalogs} localData={localData} saved={!!team && !dirty} slots={slots}/>
    <div className="share-team-grid">{slots.map((slotId, index) => {
      const revision = slotId ? localData.buildRevisions[slotId] : undefined
      const setup = revision ? localData.gameSetups[revision.gameSetupRevisionId] : undefined
      const build = revision ? localData.builds[revision.buildId] : undefined
      const newer = revision ? newerTeamCheckpoint(localData, revision) : undefined
      return <section aria-label={`Team slot ${index + 1} loadout`} className="panel team-loadout-card" key={index}>
        <header className="panel__header"><div><small>Slot {index + 1}</small><h2>{build?.title ?? 'Add a member'}</h2></div></header>
        <div className="panel__body stack">
          {revision && <p className="team-slot-checkpoint">Selected checkpoint: {build?.title ?? 'Build'} · r{revision.revision}{revision.note ? ` · ${revision.note}` : ''}</p>}
          <Field label={`Team slot ${index + 1}`} hint={revision ? 'This slot keeps its selected checkpoint until you change it.' : 'Choose an existing checkpoint or create a member below.'}><select aria-label={`Team slot ${index + 1}`} disabled={busy} value={slotId ?? ''} onChange={event => setSlots(values => values.map((value, slotIndex) => slotIndex === index ? event.target.value as BuildRevisionId || null : value))}>
            <option value="">Choose a build checkpoint</option>{builds.map(build => <optgroup key={build.id} label={build.title}>{Object.values(localData.buildRevisions).filter(revision => revision.buildId === build.id).sort((left, right) => right.revision - left.revision).map(revision => <option key={revision.id} value={revision.id}>{build.title} · r{revision.revision}</option>)}</optgroup>)}
          </select></Field>
          {revision && newer && <InlineNotice title={`Newer checkpoint available: r${newer.revision}`} tone="warning"><p>This slot keeps r{revision.revision} until you update it.</p><details><summary>Compare checkpoints</summary><TeamCheckpointComparison catalogs={catalogs} current={revision} next={newer} localData={localData}/></details><Button disabled={busy} onClick={() => setSlots(values => values.map((value, slotIndex) => slotIndex === index ? newer.id : value))} tone="secondary" type="button">Update this slot to r{newer.revision}</Button><p>Save Team to retain the update.</p></InlineNotice>}
          {revision && <BuildLoadoutSummary content={revision.content} catalogs={catalogs} equipmentNames localData={localData} gameSetup={setup}/>}
          <div className="team-slot-actions">{revision && <Button tone="secondary" type="button" disabled={busy} onClick={() => setMember({ index, revisionId: revision.id })}>Edit member</Button>}<Button disabled={busy} icon="plus" onClick={() => setMember({ index })} tone={revision ? 'quiet' : 'secondary'} type="button">{revision ? 'Create replacement' : 'Create member'}</Button></div>
        </div>
      </section>
    })}</div>
    <WorkspacePrimaryAction><Button disabled={busy || !title.trim() || !!team && !dirty} form={formId} icon="check" type="submit">{busy ? 'Saving...' : 'Save Team'}</Button></WorkspacePrimaryAction>
    {team && <details><summary>Use with Tracking</summary><div className="stack"><p>Compare these builds with tracked characters, then record the Team as their current loadouts.</p><Button disabled={busy || slots.some(id => !id) || !title.trim()} onClick={() => dirty ? void save(true) : navigation.navigate({ page: { page: 'teams', view: 'adopt', teamId: team.id }, overlays: [], query: {} })} tone="secondary" type="button">{dirty ? 'Save and adopt Team' : 'Adopt Team'}</Button></div></details>}
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
  if ('teamId' in page && !team) return <><ScreenHeader title="Teams" description="The requested Team is not saved in this browser." actions={<Button onClick={() => navigation.navigate({ page: { page: 'teams', view: 'list' }, overlays: [], query: {} })} tone="secondary">All Teams</Button>}/><InlineNotice title="Team unavailable">The requested Team is not saved in this browser.</InlineNotice></>
  if (page.view === 'adopt' && team) return <AdoptTeam {...props} team={team} key={`${team.id}:${props.localData.selectedPlaythroughId}`}/>
  if (page.view !== 'list') return <TeamEditor {...props} team={team} key={team?.id ?? 'new'}/>
  const teams = Object.values(props.localData.teams).sort((left, right) => left.title.localeCompare(right.title))
  const create = () => navigation.navigate({ page: { page: 'teams', view: 'new' }, overlays: [], query: {} })
  return <div className="stack"><ScreenHeader eyebrow="Buildcrafting" title="Teams" description="Four builds designed to work together. Plan, save, and share them independently of any Playthrough." actions={<Button onClick={create} icon="plus">New Team</Button>}/>{teams.length === 0 ? <EmptyState title="Plan a Team" description="Create members or choose saved build checkpoints. Tracking is optional." icon="team"><Button onClick={create}>Create Team</Button></EmptyState> : teams.map(team => <section className="panel" key={team.id}><header className="panel__header"><h2>{team.title}</h2><Button tone="secondary" onClick={() => navigation.navigate({ page: { page: 'teams', view: 'team', teamId: team.id }, overlays: [], query: {} })}>Open Team</Button></header><div className="panel__body stack"><TeamReview catalogs={props.catalogs} localData={props.localData} saved slots={team.slots}/><ol>{team.slots.map((id, index) => { const revision = id ? props.localData.buildRevisions[id] : undefined; const newer = revision ? newerTeamCheckpoint(props.localData, revision) : undefined; return <li key={index}>{revision ? `${props.localData.builds[revision.buildId]?.title ?? 'Build'} · r${revision.revision}${newer ? ` (r${newer.revision} available)` : ''}` : 'Empty slot'}</li> })}</ol></div></section>)}</div>
}
