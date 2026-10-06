import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
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
import { TeamCheckpointPicker } from './TeamCheckpointPicker'
import { TeamOverview } from './TeamOverview'
import { TeamReview, newerTeamCheckpoint } from './TeamReview'
import './team-workflow.css'
import { Button, EmptyState, Field, InlineNotice, ScreenHeader } from './components'
import { formatAppError } from './model'
import { ShareButton } from './ShareButton'
import { Sheet } from './Sheet'
import { useNavigation, useNavigationBlocker } from './navigation'
import { WorkspacePrimaryAction } from './WorkspaceHeader'

const emptyTeamSlots = (): readonly (BuildRevisionId | null)[] => Array.from({ length: TEAM_SIZE }, () => null)

interface Props {
  readonly localData: LocalData
  readonly catalogs: readonly CatalogSnapshot[]
  readonly onDraftChange: DraftChangeHandler
  readonly onSave: (input: SaveTeamInput) => Promise<TeamId>
  readonly onAdopt: (id: TeamId, characterIds: readonly CharacterId[]) => Promise<void>
  readonly onDelete: (id: TeamId) => Promise<void>
  readonly onSaveMember: (input: { readonly team: SaveTeamInput; readonly slotIndex: number; readonly build?: BuildDraft; readonly buildTitle?: string; readonly revision: RevisionDraft; readonly sourceRevisionId?: BuildRevisionId }) => Promise<{ buildId: BuildId; revisionId: BuildRevisionId }>
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
  const [member, setMember] = useState<{ readonly index: number; readonly revisionId?: BuildRevisionId; readonly initialFieldKey?: string }>()
  const returnPositionRef = useRef<{ readonly main: number; readonly window: number; readonly index: number } | undefined>(undefined)
  const openMember = (next: NonNullable<typeof member>) => {
    returnPositionRef.current = { main: document.querySelector('.main-shell')?.scrollTop ?? 0, window: window.scrollY, index: next.index }
    setMember(next)
  }
  useLayoutEffect(() => {
    const main = document.querySelector('.main-shell')
    if (member) {
      if (main) main.scrollTop = 0
      window.scrollTo({ top: 0, behavior: 'instant' })
      if (!member.initialFieldKey) document.querySelector<HTMLElement>('.team-member-context')?.focus({ preventScroll: true })
    } else if (returnPositionRef.current) {
      const position = returnPositionRef.current
      if (main) main.scrollTop = position.main
      window.scrollTo({ top: position.window, behavior: 'instant' })
      document.querySelector<HTMLElement>(`[data-team-slot="${position.index}"] .team-slot-actions button`)?.focus({ preventScroll: true })
      returnPositionRef.current = undefined
    }
  }, [member])
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
    navigation.navigate({ page: { page: 'teams', view: 'edit', teamId: savedMemberTeamId }, overlays: [], query: {} }, { replace: true })
    setSavedMemberTeamId(undefined)
  }, [navigation, savedMemberTeamId])
  useNavigationBlocker(navigation.route, () => dirtyRef.current, () => setError('Save or discard your Team and member changes before leaving.'))
  useEffect(() => {
    if (!dirty) return
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventLoss)
    return () => window.removeEventListener('beforeunload', preventLoss)
  }, [dirty])
  const back = () => {
    dirtyRef.current = false
    onDraftChange(false)
    if (team) navigation.navigate({ page: { page: 'teams', view: 'team', teamId: team.id }, overlays: [], query: {} })
    else navigation.navigate({ page: { page: 'teams', view: 'list' }, overlays: [], query: {} })
  }
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
  const reusedSetup = slots.map(slot => slot ? localData.buildRevisions[slot] : undefined).find(Boolean)?.gameSetupRevisionId
  const sourceRevision = member?.revisionId ? localData.buildRevisions[member.revisionId] : undefined
  const returnFromMember = () => { if (memberDirty) memberActionsRef.current?.discard(); closeMember() }
  if (member) return <div className="stack">
    <ScreenHeader unsavedObject={!sourceRevision} eyebrow={title.trim() || 'New Team'} title={sourceRevision ? `Edit ${localData.builds[sourceRevision.buildId]?.title ?? 'member'}` : `Create member ${member.index + 1}`} description="Save this member to create a checkpoint and assign it to this Team. Other Teams keep their pinned checkpoints." breadcrumb={<Button disabled={busy} icon="arrow-left" onClick={returnFromMember} title={`Return to ${title.trim() || 'Team'}${memberDirty ? ' and discard this member edit' : ''}`} tone="quiet" type="button">{memberDirty ? 'Discard and return' : 'Return to Team'}</Button>}/>
    <section aria-label="Team member context" className="team-member-context" tabIndex={-1}>
      <strong>{title.trim() || 'New Team'} · Slot {member.index + 1}</strong>
      <p>{teamDirty ? 'Your Team name and slot changes stay here while you edit. Saving this member saves those Team changes too.' : 'Your Team stays open while you edit this member.'}</p>
      {!title.trim() && <p>The Team will be saved as "New Team". You can rename it on return.</p>}
      {!sourceRevision && reusedSetup && <p>Starting with this Team's Game Setup: {localData.gameSetups[reusedSetup]?.label ?? 'Saved setup'}. You can review or change it below.</p>}
    </section>
    {error && <InlineNotice title="Team not saved" tone="danger">{error} Your selections remain available.</InlineNotice>}
    <TeamBuildEditor catalogs={catalogs} gameSetupRevisionId={reusedSetup} initialFieldKey={member.initialFieldKey} localData={localData} onCancel={closeMember} onDraftChange={memberDraftChange} sourceRevision={sourceRevision} onSubmit={async (build, revision, buildTitle) => {
      setBusy(true)
      setError(undefined)
      try {
        const savedTitle = title.trim() || 'New Team'
        const saved = await onSaveMember({ team: { id, title: savedTitle, slots }, slotIndex: member.index, build, buildTitle, revision, sourceRevisionId: sourceRevision?.id })
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
    <ScreenHeader eyebrow="Buildcrafting" title={team ? `Edit ${team.title}` : 'New Team'} description="Create members here or choose saved checkpoints. Draft Teams can be saved at any stage." breadcrumb={<Button disabled={busy} icon="arrow-left" onClick={back} tone="quiet" type="button">{team ? dirty ? 'Discard and return' : 'Return to Team' : dirty ? 'Discard and return' : 'All Teams'}</Button>} actions={team && <ShareButton disabled={busy || dirty || !slots.some(Boolean)} localData={localData} target={{ kind: 'team', teamId: team.id }}/>}/>
    {error && <InlineNotice title="Team not saved" tone="danger">{error} Your selections remain available.</InlineNotice>}
    <Field label="Team name" required><input disabled={busy} required value={title} onChange={event => setTitle(event.target.value)}/></Field>
    <TeamReview catalogs={catalogs} localData={localData} saved={!!team && !dirty} slots={slots}/>
    <div className="share-team-grid">{slots.map((slotId, index) => {
      const revision = slotId ? localData.buildRevisions[slotId] : undefined
      const setup = revision ? localData.gameSetups[revision.gameSetupRevisionId] : undefined
      const build = revision ? localData.builds[revision.buildId] : undefined
      const newer = revision ? newerTeamCheckpoint(localData, revision) : undefined
      return <section aria-label={`Team slot ${index + 1} loadout`} className="panel team-loadout-card" data-team-slot={index} key={index}>
        <header className="panel__header"><div><small>Slot {index + 1}</small><h2>{build?.title ?? 'Add a member'}</h2></div></header>
        <div className="panel__body stack">
          {revision && <p className="team-slot-checkpoint">Selected checkpoint: {build?.title ?? 'Build'} · r{revision.revision}{revision.note ? ` · ${revision.note}` : ''}</p>}
          <TeamCheckpointPicker catalogs={catalogs} disabled={busy} localData={localData} onChange={id => setSlots(values => values.map((value, slotIndex) => slotIndex === index ? id : value))} slotNumber={index + 1} value={slotId}/>
          {revision && newer && <InlineNotice title={`Newer checkpoint available: r${newer.revision}`} tone="warning"><p>This slot keeps r{revision.revision} until you update it.</p><details><summary>Compare checkpoints</summary><TeamCheckpointComparison catalogs={catalogs} current={revision} next={newer} localData={localData}/></details><Button disabled={busy} onClick={() => setSlots(values => values.map((value, slotIndex) => slotIndex === index ? newer.id : value))} tone="secondary" type="button">Update this slot to r{newer.revision}</Button><p>Save Team to retain the update.</p></InlineNotice>}
          {revision && <BuildLoadoutSummary content={revision.content} catalogs={catalogs} equipmentNames localData={localData} gameSetup={setup} onEquipmentEdit={busy ? undefined : slotId => openMember({ index, revisionId: revision.id, initialFieldKey: `slot:${slotId}` })}/>}
          <div className="team-slot-actions">{revision && <Button tone="secondary" type="button" disabled={busy} onClick={() => openMember({ index, revisionId: revision.id })}>Edit member</Button>}<Button disabled={busy} icon="plus" onClick={() => openMember({ index })} tone={revision ? 'quiet' : 'secondary'} type="button">{revision ? 'Create replacement' : 'Create member'}</Button></div>
        </div>
      </section>
    })}</div>
    <WorkspacePrimaryAction><Button disabled={busy || !title.trim() || !!team && !dirty} form={formId} icon="check" type="submit">{busy ? 'Saving...' : 'Save Team'}</Button></WorkspacePrimaryAction>
    {team && <details><summary>Use with Tracking</summary><div className="stack"><p>Compare these builds with tracked characters, then record the Team as their current loadouts.</p><Button disabled={busy || slots.some(id => !id) || !title.trim()} onClick={() => dirty ? void save(true) : navigation.navigate({ page: { page: 'teams', view: 'adopt', teamId: team.id }, overlays: [], query: {} })} tone="secondary" type="button">{dirty ? 'Save and adopt Team' : 'Adopt Team'}</Button></div></details>}
  </form>
}

function SavedTeam({ team, localData, catalogs, onRequestDelete }: Props & { readonly team: Team; readonly onRequestDelete: (team: Team) => void }) {
  const navigation = useNavigation()
  return <div className="stack team-detail">
    <ScreenHeader eyebrow="Buildcrafting" title={team.title} description="Plan and share up to four pinned Build checkpoints." breadcrumb={<Button icon="arrow-left" onClick={() => navigation.navigate({ page: { page: 'teams', view: 'list' }, overlays: [], query: {} })} tone="quiet" type="button">All Teams</Button>} actions={<><Button onClick={() => navigation.navigate({ page: { page: 'teams', view: 'edit', teamId: team.id }, overlays: [], query: {} })} tone="secondary" type="button">Edit Team</Button><ShareButton disabled={!team.slots.some(Boolean)} localData={localData} target={{ kind: 'team', teamId: team.id }}/><Button icon="trash" onClick={() => onRequestDelete(team)} tone="quiet" type="button">Delete Team</Button></>}/>
    <TeamOverview catalogs={catalogs} localData={localData} slots={team.slots}/>
    <section className="team-detail__tracking"><div><h2>Use with Tracking</h2><p>Build checks cover individual checkpoints. Adopt into a Playthrough to check shared stock and character readiness.</p></div><Button disabled={team.slots.some(id => !id)} onClick={() => navigation.navigate({ page: { page: 'teams', view: 'adopt', teamId: team.id }, overlays: [], query: {} })} tone="secondary" type="button">Adopt Team</Button></section>
  </div>
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
  const [deletingTeam, setDeletingTeam] = useState<Team>()
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string>()
  const requestDelete = (team: Team) => { setDeleteError(undefined); setDeletingTeam(team) }
  const confirmDelete = async () => {
    if (!deletingTeam || deleteBusy) return
    setDeleteBusy(true)
    setDeleteError(undefined)
    try {
      await props.onDelete(deletingTeam.id)
      setDeletingTeam(undefined)
      if (page.page === 'teams' && page.view !== 'list') navigation.navigate({ page: { page: 'teams', view: 'list' }, overlays: [], query: {} }, { replace: true })
    } catch (reason) { setDeleteError(formatAppError(reason, 'The Team could not be deleted.')) }
    finally { setDeleteBusy(false) }
  }
  // Keep the confirmation mounted while optimistic storage updates remove a Team card
  const withDeleteDialog = (content: ReactNode) => <>{content}<Sheet description={`Delete ${deletingTeam?.title ?? 'Team'} from this browser?`} footer={<div className="form-actions"><Button disabled={deleteBusy} onClick={() => setDeletingTeam(undefined)} tone="secondary" type="button">Cancel</Button><Button disabled={deleteBusy} icon="trash" onClick={() => void confirmDelete()} tone="danger" type="button">{deleteBusy ? 'Deleting...' : 'Delete Team'}</Button></div>} onClose={() => setDeletingTeam(undefined)} onRequestClose={() => !deleteBusy} open={Boolean(deletingTeam)} title="Delete Team"><p>The saved Team will be removed. Its Builds, checkpoints, tracked characters, and party plans will remain.</p>{deleteError && <InlineNotice title="Team not deleted" tone="danger">{deleteError} The Team is still saved.</InlineNotice>}</Sheet></>
  if (page.page !== 'teams') return null
  const team = 'teamId' in page ? props.localData.teams[page.teamId] : undefined
  if ('teamId' in page && !team) return withDeleteDialog(<><ScreenHeader title="Teams" description="The requested Team is not saved in this browser." actions={<Button onClick={() => navigation.navigate({ page: { page: 'teams', view: 'list' }, overlays: [], query: {} })} tone="secondary">All Teams</Button>}/><InlineNotice title="Team unavailable">The requested Team is not saved in this browser.</InlineNotice></>)
  if (page.view === 'adopt' && team) return withDeleteDialog(<AdoptTeam {...props} team={team} key={`${team.id}:${props.localData.selectedPlaythroughId}`}/>)
  if (page.view === 'team' && team) return withDeleteDialog(<SavedTeam {...props} onRequestDelete={requestDelete} team={team} key={team.id}/>)
  if (page.view !== 'list') return withDeleteDialog(<TeamEditor {...props} team={team} key={team?.id ?? 'new'}/>)
  const teams = Object.values(props.localData.teams).sort((left, right) => left.title.localeCompare(right.title))
  const create = () => navigation.navigate({ page: { page: 'teams', view: 'new' }, overlays: [], query: {} })
  return withDeleteDialog(<div className="stack"><ScreenHeader eyebrow="Buildcrafting" title="Teams" description="Group up to four Builds for planning and sharing independently of any Playthrough." actions={<Button onClick={create} icon="plus">New Team</Button>}/>{teams.length === 0 ? <EmptyState title="Plan a Team" description="Create members or choose saved build checkpoints. Tracking is optional." icon="team"><Button onClick={create}>Create Team</Button></EmptyState> : teams.map(team => <section className="panel team-list-card" key={team.id}><header className="panel__header"><h2>{team.title}</h2><div className="cluster"><Button tone="secondary" onClick={() => navigation.navigate({ page: { page: 'teams', view: 'team', teamId: team.id }, overlays: [], query: {} })}>Open Team</Button><Button icon="trash" onClick={() => requestDelete(team)} tone="quiet" type="button">Delete Team</Button></div></header><div className="panel__body"><TeamOverview catalogs={props.catalogs} compact localData={props.localData} slots={team.slots}/></div></section>)}</div>)
}
