import { CopiedPublicCheckpointView, type SaveCopiedCheckpoint } from './PublicSharedView'
import { retainOutOfContextSelections } from '../domain/retained-selections'
import { checkpointBuildView, teamMemberName, teamSlots, withTeamBuildViews } from '../domain/team-checkpoints'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createId, entityDefinitionKey, requirePlaythrough, selectedPlaythrough, validateScenario } from '../domain'
import { createScenario, TEAM_SIZE } from '../domain/scenarios'
import { buildBehavior, saveBuildBehavior, sameBuildBehavior, type BuildBehavior } from '../domain/build-behavior'
import type { DraftActions, DraftChangeHandler } from './drafts'
import { ValidationPanel } from './BuildReadiness'
import type { SaveTeamInput } from '../domain/teams'
import type { BuildId, BuildRevisionId, CatalogSnapshot, CharacterId, GameSetupRevisionId, LocalData, ScenarioId, Team, TeamId, TeamRevisionId } from '../domain/types'
import { BuildCharacterComparison } from './BuildCharacterComparison'
import { BuildLoadoutSummary } from './BuildLoadoutSummary'
import { TeamBuildEditor, type BuildDraft, type RevisionDraft } from './BuildsView'
import { TeamCheckpointComparison } from './TeamCheckpointComparison'
import { TeamCheckpointPicker } from './TeamCheckpointPicker'
import { TeamOverview } from './TeamOverview'
import { TeamReview, newerTeamCheckpoint } from './TeamReview'
import './team-workflow.css'
import { BuildBehaviorEditor } from './BuildBehaviorEditor'
import { useBuildInput, useBuildInputState } from './build-input-session'
import { Button, EmptyState, Field, InlineNotice, ScreenHeader } from './components'
import { formatAppError } from './model'
import { ShareButton } from './ShareButton'
import { Sheet } from './Sheet'
import { useNavigation, useNavigationBlocker } from './navigation'
import { useNavigationNotice } from './useNavigationNotice'
import { WorkspacePrimaryAction } from './WorkspaceHeader'

const emptyTeamSlots = (): readonly (BuildRevisionId | null)[] => Array.from({ length: TEAM_SIZE }, () => null)
const TEAM_EXIT_MESSAGE = 'Save or discard your Team and member changes before leaving.'

interface Props {
  readonly onEditCopiedCheckpoint?: SaveCopiedCheckpoint
  readonly localData: LocalData
  readonly catalogs: readonly CatalogSnapshot[]
  readonly onDraftChange: DraftChangeHandler
  readonly onSave: (input: SaveTeamInput) => Promise<TeamId>
  readonly onSaveAsBuild: (revisionId: TeamRevisionId, slot: 0 | 1 | 2 | 3, title: string) => Promise<void>
  readonly onAdopt: (id: TeamId, characterIds: readonly CharacterId[]) => Promise<void>
  readonly onDelete: (id: TeamId) => Promise<void>
  readonly onSaveMember: (input: { readonly team: SaveTeamInput; readonly slotIndex: number; readonly build?: BuildDraft; readonly buildTitle?: string; readonly revision: RevisionDraft; readonly sourceRevisionId?: BuildRevisionId }) => Promise<{ buildId: BuildId; revisionId: BuildRevisionId }>
}

function TeamEditor({ team, localData, catalogs, onSave, onSaveMember, onDraftChange }: Props & { readonly team?: Team }) {
  const formId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const navigation = useNavigation()
  const input = useBuildInput()
  const [id] = useBuildInputState('teamId', () => team?.id ?? createId<TeamId>('team'))
  const [title, setTitleState] = useBuildInputState('teamTitle', team?.title ?? '')
  const setTitle = (value: string) => { onDraftChange(true, registeredActions.current); setTitleState(value) }
  const [slots, setSlotsState] = useBuildInputState<readonly (BuildRevisionId | null)[]>('teamSlots', (team ? teamSlots(localData, team) : emptyTeamSlots()))
  const setSlots = (value: Parameters<typeof setSlotsState>[0]) => { onDraftChange(true, registeredActions.current); setSlotsState(value) }
  const initialCheckpoint = team?.kind === 'shared' ? localData.teamRevisions[team.latestRevisionId]! : undefined
  const initialSetup = initialCheckpoint?.gameSetupRevisionId
  const [setupId, setSetupId] = useBuildInputState<GameSetupRevisionId | undefined>('teamSetup', initialSetup)
  const [setupBehavior, setSetupBehavior] = useBuildInputState<BuildBehavior | undefined>('teamBehavior', () => initialSetup ? buildBehavior(localData.gameSetups[initialSetup]!) : undefined)
  const [setupBusy, setSetupBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const { noticeRef, revealNotice } = useNavigationNotice()
  const [member, setMember] = useBuildInputState<{ readonly index: number; readonly revisionId?: BuildRevisionId; readonly initialFieldKey?: string } | undefined>('teamMember', undefined)
  const returnPositionRef = useRef<{ readonly main: number; readonly window: number; readonly index: number } | undefined>(undefined)
  const openMember = (next: NonNullable<typeof member>) => {
    // A fresh slot editor owns new fields; the enclosing Team capsule survives only an exact library import
    if (input) input.controller.clearFields(input.view, ['behavior', 'draftIdentity', 'draft', 'assumptions', 'newTeamMember', 'teamMemberName'])
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
      document.querySelector<HTMLElement>(`[data-team-slot="${position.index}"] .team-slot-actions [data-member-action]`)?.focus({ preventScroll: true })
      returnPositionRef.current = undefined
    }
  }, [member])
  const [memberDirty, setMemberDirty] = useBuildInputState('teamMemberDirty', false)
  const [savedMemberTeamId, setSavedMemberTeamId] = useState<TeamId>()
  const memberActionsRef = useRef<DraftActions | undefined>(undefined)
  // Hydration re-registers actions without editing the strict input capsule during transfer
  const memberDraftChange = useCallback<DraftChangeHandler>((dirty, actions) => { if (dirty !== memberDirty) setMemberDirty(dirty); memberActionsRef.current = actions; if (dirty) onDraftChange(true, registeredActions.current) }, [memberDirty, onDraftChange])
  const teamDirty = setupId !== initialSetup || JSON.stringify(setupBehavior) !== JSON.stringify(initialSetup ? buildBehavior(localData.gameSetups[initialSetup]!) : undefined) || title !== (team?.title ?? '') || JSON.stringify(slots) !== JSON.stringify((team ? teamSlots(localData, team) : emptyTeamSlots()))
  const dirty = !savedMemberTeamId && (teamDirty || memberDirty)
  const actionsRef = useRef<DraftActions | undefined>(undefined)
  const registeredActions = useRef<DraftActions>({ owner: input?.controller.owner, save: () => actionsRef.current?.save() ?? Promise.resolve(false), discard: () => actionsRef.current?.discard() })
  // Cancelling a member must restore the enclosing Team's dirty state even when the aggregate stays true
  useEffect(() => { if (input) input.controller.dirty(input.view, dirty); onDraftChange(dirty, dirty ? registeredActions.current : undefined); return () => onDraftChange(false) }, [dirty, memberDirty, teamDirty, onDraftChange])
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  useEffect(() => {
    if (!savedMemberTeamId) return
    const savedTeam = localData.teams[savedMemberTeamId]
    if (!savedTeam || savedTeam.kind !== 'shared') return
    const savedSetup = localData.gameSetups[localData.teamRevisions[savedTeam.latestRevisionId]!.gameSetupRevisionId]!
    setSlotsState(teamSlots(localData, savedTeam)); setSetupId(savedSetup.id); setSetupBehavior(buildBehavior(savedSetup))
    dirtyRef.current = false
    navigation.navigate({ page: { page: 'teams', view: 'edit', teamId: savedMemberTeamId }, overlays: [], query: {} }, { replace: true })
    setSavedMemberTeamId(undefined)
  }, [navigation, savedMemberTeamId, localData])
  useNavigationBlocker(navigation.route, () => dirtyRef.current, () => { setError(TEAM_EXIT_MESSAGE); revealNotice() }, undefined, false, input?.controller.owner)
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
    if (busy || setupBusy || !setupId || !title.trim() || formRef.current && !formRef.current.reportValidity()) return false
    setBusy(true)
    setError(undefined)
    try {
      const saved = await onSave({ id, title, slots, gameSetupRevisionId: setupId, behavior: setupBehavior })
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
      setSlots((team ? teamSlots(localData, team) : emptyTeamSlots()))
      setSetupId(initialSetup); setSetupBehavior(initialSetup ? buildBehavior(localData.gameSetups[initialSetup]!) : undefined)
      dirtyRef.current = false
      onDraftChange(false)
      setError(undefined)
    },
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void save() }
  const [previewSetupId] = useBuildInputState('teamPreviewSetupId', () => createId<GameSetupRevisionId>('teamSetupDraft'))
  const draftContext = useMemo(() => {
    if (!setupBehavior || !setupId) return { localData, catalogLock: undefined }
    const configured = sameBuildBehavior(localData.gameSetups[setupId], setupBehavior) ? { localData, setup: localData.gameSetups[setupId]! } : saveBuildBehavior(localData, setupBehavior, localData.updatedAt, previewSetupId)
    // Checkpoint pins are independent of setup pins until an explicit context change chooses a new setup
    const effectiveLock = initialCheckpoint?.gameSetupRevisionId === configured.setup.id ? initialCheckpoint.catalogLock : configured.setup.catalogLock
    const effectiveSetup = { ...configured.setup, catalogLock: effectiveLock }
    const revisions = { ...localData.buildRevisions }
    for (const id of slots) {
      const source = id ? revisions[id] : undefined
      if (source) revisions[source.id] = { ...source, gameSetupRevisionId: configured.setup.id, catalogLock: effectiveLock, content: retainOutOfContextSelections(localData, source.content, effectiveSetup, effectiveLock) }
    }
    // This context is a render-only projection; repository callbacks receive only IDs and user input
    return { localData: { ...configured.localData, gameSetups: { ...configured.localData.gameSetups, [effectiveSetup.id]: effectiveSetup }, buildRevisions: revisions }, catalogLock: effectiveLock }
  }, [initialCheckpoint, localData, previewSetupId, setupBehavior, setupId, slots])
  const contextData = draftContext.localData
  const reusedSetup = setupId
  const sourceRevision = member?.revisionId ? contextData.buildRevisions[member.revisionId] : undefined
  const returnFromMember = () => { if (memberDirty) memberActionsRef.current?.discard(); closeMember() }
  if (member) return <div className="stack">
    <ScreenHeader unsavedObject={!sourceRevision} eyebrow={title.trim() || 'New Team'} title={sourceRevision ? `Edit ${teamMemberName(localData, sourceRevision.id)}` : `Create member ${member.index + 1}`} description="Saving creates a checkpoint for this Team. Other Teams keep theirs." breadcrumb={<Button disabled={busy} icon="arrow-left" onClick={returnFromMember} title={`Return to ${title.trim() || 'Team'}${memberDirty ? ' and discard this member edit' : ''}`} tone="quiet" type="button">{memberDirty ? 'Discard and return' : 'Return to Team'}</Button>}/>
    <section aria-label="Team member context" className="team-member-context" tabIndex={-1}>
      <strong>{title.trim() || 'New Team'} · Slot {member.index + 1}</strong>
      <p>{teamDirty ? 'Saving this member also saves your Team name and slot changes.' : 'Your Team stays open while you edit this member.'}</p>
      {!title.trim() && <p>The Team will be saved as "New Team". You can rename it on return.</p>}
      {!sourceRevision && reusedSetup && <p>Shared Team Game Setup: {localData.gameSetups[reusedSetup]?.label ?? 'Saved setup'}. Return to the Team to change it for all members.</p>}
    </section>
    {error && <div aria-label="Team navigation warning" ref={noticeRef} role="region" tabIndex={-1}><InlineNotice title={error === TEAM_EXIT_MESSAGE ? 'Team edits are still open' : 'Team not saved'} tone={error === TEAM_EXIT_MESSAGE ? 'warning' : 'danger'}><p>{error} Your selections remain available.</p><div className="cluster"><Button disabled={busy} onClick={() => void actionsRef.current?.save()} tone="secondary" type="button">Save pending changes</Button><Button disabled={busy} onClick={() => actionsRef.current?.discard()} tone="quiet" type="button">Discard pending changes</Button></div></InlineNotice></div>}
    <TeamBuildEditor memberNameFallback={`Team member ${member.index + 1}`} catalogs={catalogs} gameSetupRevisionId={reusedSetup} sharedBehavior={setupBehavior} sharedCatalogLock={draftContext.catalogLock} initialFieldKey={member.initialFieldKey} localData={contextData} onCancel={closeMember} onDraftChange={memberDraftChange} sourceRevision={sourceRevision} onSubmit={async (build, revision, buildTitle) => {
      setBusy(true)
      setError(undefined)
      try {
        const savedTitle = title.trim() || 'New Team'
        const saved = await onSaveMember({ team: { id, title: savedTitle, slots, gameSetupRevisionId: setupId, behavior: setupBehavior }, slotIndex: member.index, build, buildTitle, revision, sourceRevisionId: sourceRevision?.id })
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
    <ScreenHeader eyebrow="Buildcrafting" title={team ? `Edit ${team.title}` : 'New Team'} description="Create members or choose saved checkpoints. You can save an unfinished Team." breadcrumb={<Button disabled={busy} icon="arrow-left" onClick={back} tone="quiet" type="button">{team ? dirty ? 'Discard and return' : 'Return to Team' : dirty ? 'Discard and return' : 'All Teams'}</Button>} actions={team && <ShareButton disabled={team.kind !== 'shared' || busy || dirty} localData={localData} target={{ kind: 'team', teamId: team.id }}/>}/>
    {error && <div aria-label="Team navigation warning" ref={noticeRef} role="region" tabIndex={-1}><InlineNotice title={error === TEAM_EXIT_MESSAGE ? 'Team edits are still open' : 'Team not saved'} tone={error === TEAM_EXIT_MESSAGE ? 'warning' : 'danger'}><p>{error} Your selections remain available.</p><div className="cluster"><Button disabled={busy} onClick={() => void actionsRef.current?.save()} tone="secondary" type="button">Save pending changes</Button><Button disabled={busy} onClick={() => actionsRef.current?.discard()} tone="quiet" type="button">Discard pending changes</Button></div></InlineNotice></div>}
    <Field label="Team name" required><input disabled={busy} required value={title} onChange={event => setTitle(event.target.value)}/></Field>
    <section aria-label="Shared Team setup" className="panel"><div className="panel__body stack"><Field label="Choose shared setup" hint="One Game Setup applies to every occupied slot. Source Builds and Playthroughs keep their settings."><select value={setupId ?? ''} disabled={busy} onChange={event => { const next = event.target.value as GameSetupRevisionId; onDraftChange(true, registeredActions.current); setSetupId(next || undefined); setSetupBehavior(next ? buildBehavior(localData.gameSetups[next]!) : undefined) }}><option value="">Choose a shared Game Setup</option>{Object.values(localData.gameSetups).map(setup => <option key={setup.id} value={setup.id}>{setup.label} · r{setup.revision}</option>)}</select></Field>{!setupId && <p>{team?.kind === 'legacy-mixed' ? 'Historical member setups are preserved. Choose a shared setup before editing.' : 'Choose a shared setup before adding members or saving an empty Team.'}</p>}{setupBehavior && <BuildBehaviorEditor localData={localData} value={setupBehavior} onChange={value => { setSetupBehavior(value); onDraftChange(true, registeredActions.current) }} content={{ primaryClass: null, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] }} onModBusyChange={setSetupBusy}/>}</div></section>
    <TeamReview catalogs={catalogs} localData={contextData} saved={!!team && !dirty} slots={slots}/>
    <div className="share-team-grid">{slots.map((slotId, index) => {
      const revision = slotId ? contextData.buildRevisions[slotId] : undefined
      const setup = revision ? contextData.gameSetups[revision.gameSetupRevisionId] : undefined
      const memberName = slotId ? teamMemberName(localData, slotId, `Team member ${index + 1}`) : undefined
      const newer = revision ? newerTeamCheckpoint(localData, revision) : undefined
      return <section aria-label={`Team slot ${index + 1} loadout`} className="panel team-loadout-card" data-team-slot={index} key={index}>
        <header className="panel__header"><div><small>Slot {index + 1}</small><h2>{memberName ?? 'Add a member'}</h2></div></header>
        <div className="panel__body stack">
          {revision && <p className="team-slot-checkpoint">Selected checkpoint: {memberName} · r{revision.revision}{revision.note ? ` · ${revision.note}` : ''}</p>}
          <TeamCheckpointPicker catalogs={catalogs} disabled={busy || !setupId} localData={localData} onChange={id => setSlots(values => values.map((value, slotIndex) => slotIndex === index ? id : value))} slotNumber={index + 1} value={slotId}/>
          {revision && newer && <InlineNotice title={`Newer checkpoint available: r${newer.revision}`} tone="warning"><p>This slot keeps r{revision.revision} until you update it.</p><details><summary>Compare checkpoints</summary><TeamCheckpointComparison catalogs={catalogs} current={revision} next={newer} localData={localData}/></details><Button disabled={busy || !setupId} onClick={() => setSlots(values => values.map((value, slotIndex) => slotIndex === index ? newer.id : value))} tone="secondary" type="button">Update this slot to r{newer.revision}</Button><p>Save Team to retain the update.</p></InlineNotice>}
          {revision && <BuildLoadoutSummary content={revision.content} catalogs={catalogs} equipmentNames localData={contextData} gameSetup={setup} onEquipmentEdit={busy || !setupId ? undefined : slotId => openMember({ index, revisionId: revision.id, initialFieldKey: `slot:${slotId}` })}/>}
          <div className="team-slot-actions">{index > 0 && <Button disabled={busy || !setupId} type="button" tone="quiet" onClick={() => setSlots(values => { const next = [...values]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; return next })}>Move slot {index + 1} left</Button>}{revision && <Button data-member-action tone="secondary" type="button" disabled={busy || !setupId} onClick={() => openMember({ index, revisionId: revision.id })}>Edit member</Button>}<Button data-member-action disabled={busy || !setupId} icon="plus" onClick={() => openMember({ index })} tone={revision ? 'quiet' : 'secondary'} type="button">{revision ? 'Create replacement' : 'Create member'}</Button></div>
        </div>
      </section>
    })}</div>
    <WorkspacePrimaryAction><Button disabled={busy || setupBusy || !setupId || !title.trim() || !!team && !dirty} form={formId} icon="check" type="submit">{busy ? 'Saving...' : 'Save Team'}</Button></WorkspacePrimaryAction>
    {team && <details><summary>Use with Tracking</summary><div className="stack"><p>Compare these builds with tracked characters, then record the Team as their current loadouts.</p><Button disabled={busy || setupBusy || !setupId || slots.some(id => !id) || !title.trim()} onClick={() => dirty ? void save(true) : navigation.navigate({ page: { page: 'teams', view: 'adopt', teamId: team.id }, overlays: [], query: {} })} tone="secondary" type="button">{dirty ? 'Save and adopt Team' : 'Adopt Team'}</Button></div></details>}
  </form>
}

function SavedTeam({ team, localData, catalogs, onRequestDelete, onSaveAsBuild }: Props & { readonly team: Team; readonly onRequestDelete: (team: Team) => void }) {
  const navigation = useNavigation()
  const [checkpointId, setCheckpointId] = useState(team.kind === 'shared' ? team.latestRevisionId : undefined)
  const checkpoint = checkpointId ? localData.teamRevisions[checkpointId] : undefined
  const [copyError, setCopyError] = useState<string>()
  const history = Object.values(localData.teamRevisions).filter(revision => revision.teamId === team.id).sort((left, right) => right.revision - left.revision)
  const displayed = checkpoint && team.kind === 'shared' ? { ...team, latestRevisionId: checkpoint.id } : team
  return <div className="stack team-detail">
    <ScreenHeader eyebrow="Buildcrafting" title={team.title} description="Plan and share up to four pinned Build checkpoints." breadcrumb={<Button icon="arrow-left" onClick={() => navigation.navigate({ page: { page: 'teams', view: 'list' }, overlays: [], query: {} })} tone="quiet" type="button">All Teams</Button>} actions={<><Button onClick={() => navigation.navigate({ page: { page: 'teams', view: 'edit', teamId: team.id }, overlays: [], query: {} })} tone="secondary" type="button">Edit Team</Button><ShareButton disabled={team.kind !== 'shared'} localData={localData} target={{ kind: 'team', teamId: team.id, ...(checkpointId ? { teamRevisionId: checkpointId } : {}) }}/><Button icon="trash" onClick={() => onRequestDelete(team)} tone="quiet" type="button">Delete Team</Button></>}/>
    {checkpoint && <section aria-label="Team checkpoint history" className="stack"><p>Shared Game Setup: {localData.gameSetups[checkpoint.gameSetupRevisionId]?.label} · Team checkpoint r{checkpoint.revision}</p><Field label="Team checkpoint"><select value={checkpoint.id} onChange={event => setCheckpointId(event.target.value as TeamRevisionId)}>{history.map(revision => <option key={revision.id} value={revision.id}>r{revision.revision} · {localData.gameSetups[revision.gameSetupRevisionId]?.label}</option>)}</select></Field>{checkpoint.parentRevisionId && <details><summary>Compare all four slots with previous checkpoint</summary>{checkpoint.slots.map((slot, index) => { const previous = checkpointBuildView(localData, { kind: 'team-slot', teamRevisionId: checkpoint.parentRevisionId!, slot: index as 0 | 1 | 2 | 3 }); const current = slot ? checkpointBuildView(localData, { kind: 'team-slot', teamRevisionId: checkpoint.id, slot: index as 0 | 1 | 2 | 3 }) : undefined; return <section key={index}><h3>Slot {index + 1}</h3>{previous && current ? <TeamCheckpointComparison current={previous} next={current} localData={localData} catalogs={catalogs}/> : <p>{previous ? 'Member cleared' : current ? 'Member added' : 'Empty in both checkpoints'}</p>}</section> })}</details>}</section>}
    <TeamOverview catalogs={catalogs} localData={localData} slots={teamSlots(localData, displayed)}/>
    {checkpoint && <section aria-label="Save Team members as Builds">{checkpoint.slots.map((slot, index) => slot && <div key={index}><p>Slot {index + 1}{slot.sourceBuildRevisionId ? ` · Copied from ${localData.builds[localData.buildRevisions[slot.sourceBuildRevisionId]!.buildId]?.title ?? 'Build'} r${localData.buildRevisions[slot.sourceBuildRevisionId]!.revision}` : ' · Created in this Team'}</p><Button type="button" tone="secondary" onClick={() => { setCopyError(undefined); void onSaveAsBuild(checkpoint.id, index as 0 | 1 | 2 | 3, slot.name ?? `${team.title} - member ${index + 1}`).catch(reason => setCopyError(formatAppError(reason, 'Build could not be saved'))) }}>Save slot {index + 1} as Build</Button></div>)}{copyError && <InlineNotice title="Build not saved" tone="danger">{copyError}</InlineNotice>}</section>}
    <section className="team-detail__tracking"><div><h2>Use with Tracking</h2><p>Adopt this Team into a Playthrough to check whether your characters can use these Builds and you have enough gear for the whole party.</p></div><Button disabled={team.kind !== 'shared' || teamSlots(localData, team).some(id => !id)} onClick={() => navigation.navigate({ page: { page: 'teams', view: 'adopt', teamId: team.id }, overlays: [], query: {} })} tone="secondary" type="button">{team.kind === 'shared' && checkpointId !== team.latestRevisionId ? 'Adopt latest Team' : 'Adopt Team'}</Button></section>
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
  const complete = ids.every(id => !!playthrough.characters[id]) && new Set(ids).size === TEAM_SIZE && teamSlots(localData, team).every(id => !!id)
  const compatible = teamSlots(localData, team).every(id => {
    const first = localData.buildRevisions[teamSlots(localData, team)[0] ?? '']
    const revision = localData.buildRevisions[id ?? '']
    return first && revision && sameBuildBehavior(localData.gameSetups[first.gameSetupRevisionId], localData.gameSetups[revision.gameSetupRevisionId])
  })
  const preview = useMemo(() => {
    if (!complete) return undefined
    const first = localData.buildRevisions[teamSlots(localData, team)[0]!]!
    const id = previewId
    const data = createScenario(localData, { id, label: team.title, memberIds: ids as CharacterId[], gameSetupRevisionId: first.gameSetupRevisionId, catalogLock: first.catalogLock, assignments: Object.fromEntries(ids.map((id, index) => [id, team.kind === 'shared' ? { kind: 'team-slot' as const, teamRevisionId: team.latestRevisionId, slot: index as 0 | 1 | 2 | 3 } : team.slots[index]!])), inventoryPolicy: { enforceStock: true, includeProtected: true }, activate: false })
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
    {characters.length < TEAM_SIZE && <InlineNotice title="Tracked characters needed">Add four characters under Tracking to adopt this Team. You can keep planning without them.<Button type="button" tone="secondary" onClick={() => navigation.navigate({ page: { page: 'characters', view: 'new' }, overlays: [], query: {} })}>Add a tracked character</Button></InlineNotice>}
    {teamSlots(localData, team).map((id, index) => {
      const revision = id ? localData.buildRevisions[id] : undefined
      const character = playthrough.characters[ids[index]!]
      return <section className="panel" key={index}><header className="panel__header"><h2>{index + 1}. {revision ? localData.builds[revision.buildId]?.title : 'Empty slot'}</h2></header><div className="panel__body stack"><Field label={`Tracked character ${index + 1}`}><select disabled={busy} value={ids[index]} onChange={event => { setIds(values => values.map((id, position) => position === index ? event.target.value : id)); setConfirmed(false) }}><option value="">Choose character</option>{characters.map(character => <option disabled={ids.some((id, position) => position !== index && id === character.id)} key={character.id} value={character.id}>{character.name}</option>)}</select></Field>{revision && character && <details><summary>Compare with current loadout</summary><BuildCharacterComparison revision={revision} character={character} localData={localData} catalogs={catalogs}/></details>}</div></section>
    })}
    {!compatible && <InlineNotice title="Different Game Setups" tone="warning">These checkpoints use different rules. Choose compatible ones before recording the party.</InlineNotice>}
    {preview && <details><summary>Check party readiness and shared equipment</summary><ValidationPanel report={preview.report} scenario={preview.scenario} localData={preview.data} catalogs={catalogs}/></details>}
    <p>Recording adds character snapshots and keeps their history. Recapture in-game stats afterward. Learning, levels, and inventory stay unchanged.</p>
    <label className="check-row"><input type="checkbox" checked={confirmed} disabled={!complete || !compatible || busy} onChange={event => setConfirmed(event.target.checked)}/><span>I applied these builds in game</span></label>
    <Button disabled={!complete || !compatible || !confirmed || busy} type="submit">{busy ? 'Recording...' : 'Record Team as current'}</Button>
  </form>
}

export function TeamsView(input: Props) {
  const props = { ...input, localData: useMemo(() => withTeamBuildViews(input.localData), [input.localData]) }
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
  const copiedCheckpoint = team?.kind === 'shared' ? input.localData.teamRevisions[team.latestRevisionId] : undefined
  if (copiedCheckpoint?.publicSourceContext) return <><Button tone="secondary" onClick={() => navigation.navigate({ page: { page: 'teams', view: 'list' }, overlays: [], query: {} })}>All Teams</Button><CopiedPublicCheckpointView onEdit={input.onEditCopiedCheckpoint} onDraftChange={input.onDraftChange} checkpoint={copiedCheckpoint} setup={input.localData.gameSetups[copiedCheckpoint.gameSetupRevisionId]!} title={team!.title}/></>
  if (page.view === 'adopt' && team && !selectedPlaythrough(props.localData)) return <InlineNotice title="Choose a Playthrough">Create or select a Playthrough before adopting a Team.<Button onClick={() => navigation.navigate({ page: { page: 'settings', section: 'playthrough' }, overlays: [], query: { create: ['true'] } })}>Create or select Playthrough</Button></InlineNotice>
  if (page.view === 'adopt' && team) return withDeleteDialog(<AdoptTeam {...props} team={team} key={`${team.id}:${props.localData.selectedPlaythroughId}`}/>)
  if (page.view === 'team' && team) return withDeleteDialog(<SavedTeam {...props} onRequestDelete={requestDelete} team={team} key={team.id}/>)
  if (page.view !== 'list') return withDeleteDialog(<TeamEditor {...props} team={team} key={team?.id ?? 'new'}/>)
  const teams = Object.values(props.localData.teams).sort((left, right) => left.title.localeCompare(right.title))
  const create = () => navigation.navigate({ page: { page: 'teams', view: 'new' }, overlays: [], query: {} })
  return withDeleteDialog(<div className="stack"><ScreenHeader eyebrow="Buildcrafting" title="Teams" description="Plan and share up to four Builds. No Playthrough needed." actions={<Button onClick={create} icon="plus">New Team</Button>}/>{teams.length === 0 ? <EmptyState title="Plan a Team" description="Create members or choose saved build checkpoints. Tracking is optional." icon="team"><Button onClick={create}>Create Team</Button></EmptyState> : teams.map(team => <section className="panel team-list-card" key={team.id}><header className="panel__header"><h2>{team.title}</h2><div className="cluster"><Button tone="secondary" onClick={() => navigation.navigate({ page: { page: 'teams', view: 'team', teamId: team.id }, overlays: [], query: {} })}>Open Team</Button><Button icon="trash" onClick={() => requestDelete(team)} tone="quiet" type="button">Delete Team</Button></div></header><div className="panel__body"><TeamOverview catalogs={props.catalogs} compact localData={props.localData} slots={teamSlots(props.localData, team)}/></div></section>)}</div>)
}
