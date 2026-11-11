import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useBuildInput, useBuildInputState } from './build-input-session'
import type { DraftActions, DraftChangeHandler } from './drafts'
import type { CopiedCheckpointEdit, CopiedCheckpointRef } from '../interchange/public-checkpoint-edit'
import type { PublicNotes } from '../interchange/public-share-schema'
import { decodePublicSnapshot } from '../interchange/public-share'
import { readPublishedSnapshot } from '../account/shares-client'
import type { PublicShare } from '../account/shares-protocol'
import type { PublicSnapshot } from '../interchange/public-share-schema'
import { Button, Field, InlineNotice, ScreenHeader } from './components'
import { useOptionalWorkspace } from './WorkspaceProvider'
import type { WorkspaceState } from '../workspace/documents'
import type { WorkspaceRepository } from '../workspace/repository'
import { enrichPublicSnapshot, copyPublicSnapshot, publicReadOnlyPreview } from '../interchange/public-share-enrichment'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { modSourceMatch } from '../domain/mod-source-match'
import type { ModSourceReceipt } from '../domain/types'
import { importLibrarySource } from '../workspace/mod-repository'
import { PublicShareSources } from './PublicShareSources'
import { PublicShareLoadout, PublicShareRoster, publicMemberName } from './PublicShareLoadout'
import './public-share.css'
import { SharedBuild } from './SharedBuild'
import { publicSnapshotFromCheckpoint } from '../domain/public-source-context'
import type { BuildRevision, TeamRevision, GameSetupRevision } from '../domain/types'
import { formatAppRoute, writeNavigationRoute } from './navigation'

type SavePublicSnapshot = (snapshot: PublicSnapshot) => Promise<{ buildId?: import('../domain/types').BuildId; teamId?: import('../domain/types').TeamId }>

const MAX_MATCHING_FILE_BYTES = 32 * 1024 * 1024

// Public receipts resolve only against exact source identities in the viewer's workspace
export function PublicSharedView({ encoded, onSave }: { readonly encoded: string; readonly onSave?: SavePublicSnapshot }) {
  const result = useMemo(() => { try { return { snapshot: decodePublicSnapshot(encoded) } } catch (error) { return { error: error instanceof Error ? error.message : 'Invalid public snapshot' } } }, [encoded])
  if (!result.snapshot) return <InlineNotice title="Shared snapshot unavailable" tone="danger">{result.error}</InlineNotice>
  // A new link owns its member selection, inspection, and pending operations
  return <PublicSnapshotView key={encoded} snapshot={result.snapshot} onSave={onSave}/>
}

export function HostedSharedView({ shareId, onSave }: { readonly shareId: string; readonly onSave?: SavePublicSnapshot }) {
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ id: string; value?: PublicShare; failed?: boolean; deferred?: boolean }>()
  useEffect(() => {
    const controller = new AbortController()
    void readPublishedSnapshot(shareId, controller.signal).then(value => { if (!controller.signal.aborted) setResult({ id: shareId, value }) }, error => { if (!controller.signal.aborted) setResult({ id: shareId, failed: true, deferred: error instanceof Error && ['RATE_LIMITED', 'SERVICE_PAUSED'].includes(error.message) }) })
    return () => controller.abort()
  }, [shareId, attempt])
  if (!result || result.id !== shareId) return <p role="status">Opening shared snapshot...</p>
  if (!result.value) return <InlineNotice title="Shared snapshot unavailable" tone="danger"><p>{result.deferred ? 'Cloud requests are temporarily paused. Check the service notice, then retry this link.' : 'This link is unavailable. Check your connection or ask its owner for a new link.'}</p><Button onClick={() => { setResult(undefined); setAttempt(value => value + 1) }}>Retry shared link</Button></InlineNotice>
  return <>{result.value.attribution && <p>Shared by {result.value.attribution.username}</p>}<PublicSnapshotView snapshot={result.value.snapshot} onSave={onSave}/></>
}

export function PublicSnapshotView({ snapshot, copied = false, onSave, copiedActions }: { readonly snapshot: PublicSnapshot; readonly copied?: boolean; readonly onSave?: SavePublicSnapshot; readonly copiedActions?: (viewer: WorkspaceState) => ReactNode }) {
  const workspace = useOptionalWorkspace()
  const buildInput = useBuildInput()
  const repository = workspace?.repository
  const [loaded, setLoaded] = useState<{ repository: WorkspaceRepository; state: WorkspaceState }>()
  const [failure, setFailure] = useState<{ repository: WorkspaceRepository | undefined; message: string; library?: true }>()
  const setError = (message?: string) => setFailure(message ? { repository, message } : undefined)
  const error = failure?.repository === repository ? failure?.message : undefined
  const [pending, setPending] = useState<{ repository: WorkspaceRepository; id: symbol }>()
  const currentOperation = useRef<typeof pending>(undefined)
  const libraryReadEpoch = useRef(0)
  const refreshLibrary = useRef<{ repository: WorkspaceRepository; refresh: () => void }>(undefined)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const sourcesRef = useRef<HTMLDetailsElement>(null)
  const [selectedMember, setSelectedMember] = useState(0)
  const openSources = () => {
    setSourcesOpen(true)
    if (sourcesRef.current) {
      sourcesRef.current.open = true
      sourcesRef.current.scrollIntoView?.({ block: 'start' })
      sourcesRef.current.focus({ preventScroll: true })
    }
  }
  const currentRepository = useRef(repository)
  if (currentRepository.current !== repository) { currentOperation.current = undefined; libraryReadEpoch.current++ }
  currentRepository.current = repository
  const busy = pending?.repository === repository && pending === currentOperation.current
  const startOperation = () => {
    const operation = { repository: repository!, id: Symbol() }
    libraryReadEpoch.current++
    currentOperation.current = operation; setPending(operation); setError(undefined)
    return () => currentRepository.current === repository && currentOperation.current === operation
  }
  useEffect(() => {
    if (!repository) return
    let live = true
    let requested = false
    let running = false
    const refresh = async () => {
      // Notifications are hints, not new authority: serialize captures and avoid decrypting the
      // same library beside an owned transaction that will install or reread its exact result
      if (!live || currentOperation.current?.repository === repository) return
      requested = true
      if (running) return
      running = true
      try {
        while (live && requested && currentOperation.current?.repository !== repository) {
          requested = false
          const captured = libraryReadEpoch.current
          try {
            const state = await repository.readWorkspace()
            // A later hint cannot invalidate a read that passed its repository capture fence
            // A profile or owned operation can, and the queued hint still gets a later fresh read
            if (live && captured === libraryReadEpoch.current) setLoaded({ repository, state })
          } catch { if (live && captured === libraryReadEpoch.current) setFailure({ repository, message: 'Your library could not be read. Retry to load the current workspace.', library: true }) }
        }
      } finally { running = false }
    }
    refreshLibrary.current = { repository, refresh: () => { void refresh() } }
    void refresh()
    const unsubscribe = repository.subscribe(() => { void refresh() })
    return () => { live = false; unsubscribe() }
  }, [repository])
  // Hide the old profile synchronously, before effect cleanup or a successor read completes
  const viewer = loaded?.repository === repository ? loaded?.state : undefined
  const enrichment = useMemo(() => viewer ? enrichPublicSnapshot(snapshot, viewer) : undefined, [snapshot, viewer])
  const importMatching = async (layer: PublicSnapshot['setup']['layers'][number], file: File) => {
    if (!repository || !viewer) return
    const operationIsCurrent = startOperation()
    try {
      if (file.size > MAX_MATCHING_FILE_BYTES) throw new Error('Choose matching JSON up to 32 MB.')
      const preview = await previewCrystalEdit(new Uint8Array(await file.arrayBuffer()), file.name)
      const catalog = preview.proposed.catalogs[0]
      const receipt: ModSourceReceipt = { ...layer, catalogId: layer.catalogId as ModSourceReceipt['catalogId'], catalogRevisionId: layer.catalogRevisionId as ModSourceReceipt['catalogRevisionId'], checksum: layer.checksum ?? '' }
      if (!catalog || !modSourceMatch(receipt, catalog)) throw new Error('This file does not match the saved project and content. Choose the exact shared source version.')
      if (!operationIsCurrent()) return
      if (copied && buildInput && workspace) {
        // Copied notes use the same owned input capsule as ordinary Build and Team drafts
        // Its receipt transfers unfinished input through source-only publication without saving a checkpoint
        await workspace.importBuildSource(preview, { id: viewer.planner.localData.id, revision: viewer.planner.localData.revision })
        return
      }
      await importLibrarySource(repository, preview, { inReference: !viewer?.planner.localData.referenceLibrary?.excludedMods.includes(catalog.id), futureDefault: false })
      const state = await repository.readWorkspace()
      if (operationIsCurrent()) setLoaded({ repository, state })
    } catch (reason) { if (operationIsCurrent()) setError(reason instanceof Error ? reason.message : 'Matching files could not be saved.') }
    finally { if (operationIsCurrent()) { currentOperation.current = undefined; setPending(undefined) } }
  }
  const preview = useMemo(() => viewer && enrichment && !enrichment.unresolvedCalculations ? publicReadOnlyPreview(snapshot, viewer, enrichment) : undefined, [snapshot, viewer, enrichment])
  const [savedCopy, setSaved] = useState<{ repository: WorkspaceRepository; buildId?: import('../domain/types').BuildId; teamId?: import('../domain/types').TeamId }>()
  const saved = savedCopy?.repository === repository ? savedCopy : undefined
  const save = async () => {
    if (!repository) return
    const operationIsCurrent = startOperation()
    try { const result = await (onSave ? onSave(snapshot) : copyPublicSnapshot(repository, snapshot)); if (operationIsCurrent()) { setSaved({ ...result, repository }); writeNavigationRoute({ page: result.teamId ? { page: 'teams', view: 'team', teamId: result.teamId } : { page: 'builds', view: 'build', buildId: result.buildId! }, overlays: [], query: {} }, 'push') } }
    catch (reason) {
      if (operationIsCurrent()) {
        setError(reason instanceof Error ? reason.message : 'The copy could not be saved.')
        currentOperation.current = undefined; setPending(undefined)
        if (refreshLibrary.current && refreshLibrary.current.repository === repository) refreshLibrary.current.refresh()
      }
    }
    finally { if (operationIsCurrent()) { currentOperation.current = undefined; setPending(undefined) } }
  }
  const memberIndex = snapshot.kind === 'team' ? Math.min(selectedMember, snapshot.slots.length - 1) : 0
  const revision = preview?.revisions[memberIndex]
  const member = snapshot.slots[memberIndex]
  const loadout = revision && preview ? <section aria-label="Read-only calculations"><section aria-label={snapshot.kind === 'team' ? `Slot ${memberIndex + 1} calculations` : 'Build calculations'}><SharedBuild key={memberIndex} revision={revision} preview={preview} onUploadMod={openSources} onReviewSetup={openSources}/></section></section> : <PublicShareLoadout key={memberIndex} snapshot={snapshot} index={memberIndex} enrichment={enrichment}/>
  return <div className="stack shared-preview public-shared-preview">
    <ScreenHeader description={snapshot.kind === 'team' ? 'Shared Team' : 'Shared Build'} title={snapshot.title} actions={repository && !copied ? <Button disabled={busy || !viewer} onClick={() => void save()}>{busy ? 'Saving...' : 'Save a copy'}</Button> : undefined}/>
    {copied && <p className="share-copy-notice" role="status"><strong>Independent saved copy</strong><span>Your changes stay separate from the original.</span></p>}
    {saved && <InlineNotice title="Copy saved" tone="positive"><a href={formatAppRoute({ page: saved.teamId ? { page: 'teams', view: 'team', teamId: saved.teamId } : { page: 'builds', view: 'build', buildId: saved.buildId! }, overlays: [], query: {} })}>Open your independent copy</a></InlineNotice>}
    {error && <InlineNotice title="Shared view could not finish" tone="danger">{error}{failure?.library && !busy && <Button onClick={() => { setError(undefined); if (refreshLibrary.current && refreshLibrary.current.repository === repository) refreshLibrary.current.refresh() }}>Retry library read</Button>}</InlineNotice>}
    {enrichment?.adaptedProjections.length ? <InlineNotice title="Adapted interpretation" tone="warning">Your matching source uses a different parser projection. These details are a read-only interpretation; the shared historical pins remain unchanged.</InlineNotice> : null}
    {snapshot.kind === 'team' ? <>
      <PublicShareRoster snapshot={snapshot} enrichment={enrichment} selected={memberIndex} onSelect={setSelectedMember}/>
      <section aria-label="Selected Team member" className="share-member"><header className="share-member__heading"><h2>{member ? publicMemberName(snapshot, memberIndex) : `Empty slot ${memberIndex + 1}`}</h2><span>Member {memberIndex + 1} of {snapshot.slots.length}</span></header>{loadout}</section>
    </> : <section aria-label="Shared build loadout"><h2 className="sr-only">Loadout</h2>{loadout}</section>}
    {enrichment?.unresolvedCalculations && <InlineNotice title="Calculations unavailable">Exact source definitions and the saved setup lock are required. Missing mechanics remain unknown.</InlineNotice>}
    {repository && snapshot.setup.layers.length > 0 && (!enrichment || enrichment.unresolvedCalculations) && <div><Button tone="secondary" onClick={openSources}>{repository.kind === 'account' ? 'Choose from my library' : 'Add matching files'}</Button></div>}
    {snapshot.notes?.checkpoint && <section className="share-notes"><h2>{snapshot.kind === 'team' ? 'Team notes' : 'Notes'}</h2><p>{snapshot.notes.checkpoint}</p></section>}
    {viewer && copiedActions && <details className="share-copy-controls"><summary>Edit your copy</summary>{copiedActions(viewer)}</details>}
    <PublicShareSources snapshot={snapshot} enrichment={enrichment} open={sourcesOpen} onToggle={setSourcesOpen} detailsRef={sourcesRef} canImport={Boolean(repository)} busy={Boolean(busy)} ready={Boolean(viewer)} onImport={(layer, file) => void importMatching(layer, file)}/>
  </div>
}


export type SaveCopiedCheckpoint = (viewer: WorkspaceState, input: CopiedCheckpointEdit) => Promise<CopiedCheckpointRef>

function CopiedCheckpointActions({ snapshot, checkpoint, viewer, onEdit, onDraftChange }: { readonly snapshot: PublicSnapshot; readonly checkpoint: CopiedCheckpointRef; readonly viewer: WorkspaceState; readonly onEdit: SaveCopiedCheckpoint; readonly onDraftChange?: DraftChangeHandler }) {
  const input = useBuildInput()
  const initialNotes = useMemo<PublicNotes>(() => ({ ...snapshot.notes, slots: snapshot.slots.map((slot, index) => slot ? { contextAssumptions: [], ...snapshot.notes?.slots[index] } : null) }), [snapshot])
  const [notes, setNotes] = useBuildInputState('copiedNotes', initialNotes)
  const setups = Object.values(viewer.planner.localData.gameSetups).filter(setup => !setup.publicSourceContext)
  const [setupId, setSetupId] = useBuildInputState('copiedSetup', () => setups.find(setup => setup.id === viewer.planner.localData.planningGameSetupRevisionId)?.id ?? setups[0]?.id)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState<string>()
  const live = useRef(false)
  const dirty = useRef(input?.controller.snapshot().dirty ?? false)
  const latest = useRef<{ save(): Promise<boolean>; discard(): boolean }>({ save: async () => false, discard: () => false })
  const notify = (value: boolean) => {
    input?.controller.dirty(input.view, value)
    dirty.current = value; onDraftChange?.(value, actions.current)
  }
  const actions = useRef<DraftActions>({ owner: input?.controller.owner, save: () => latest.current.save(), discard: () => latest.current.discard() })
  useEffect(() => { live.current = true; if (dirty.current) onDraftChange?.(true, actions.current); return () => { live.current = false } }, [])
  const save = async (adapt = false) => {
    if (!live.current || pending.current || input?.pending) return false
    pending.current = true; setBusy(true); setError(undefined)
    try {
      // Capture visible input before yielding; repository and App retain their own profile/head guards
      const request: CopiedCheckpointEdit = { checkpoint, notes: structuredClone(notes), ...(adapt && setupId ? { gameSetupRevisionId: setupId } : {}) }
      if (adapt && !setupId) throw new Error('Choose an available local Game Setup first')
      const result = await onEdit(viewer, request)
      // A successful optimistic Team transition can unmount this form before durability
      // Clear its dirty state only while its exact input owner still exists
      if (!live.current) {
        if (input) { try { input.controller.assertView(input.view); notify(false) } catch { /* A successor owns its own input */ } }
        return true
      }
      notify(false)
      const local = viewer.planner.localData
      if (result.kind === 'build' && checkpoint.kind === 'build') writeNavigationRoute({ page: { page: 'builds', view: 'revision-edit', buildId: local.buildRevisions[checkpoint.revisionId]!.buildId, revisionId: result.revisionId }, overlays: [], query: {} }, 'replace')
      if (result.kind === 'team' && checkpoint.kind === 'team') writeNavigationRoute({ page: { page: 'teams', view: 'team', teamId: local.teamRevisions[checkpoint.revisionId]!.teamId }, overlays: [], query: {} }, 'replace')
      return true
    } catch (reason) { if (live.current) setError(reason instanceof Error ? reason.message : 'The checkpoint could not be saved.'); return false }
    finally { pending.current = false; if (live.current) setBusy(false) }
  }
  latest.current = { save: () => save(), discard: () => { if (pending.current) return false; setNotes(initialNotes); notify(false); return true } }
  const change = (next: PublicNotes) => { notify(true); setNotes(next) }
  return <section aria-label="Edit copied checkpoint" className="panel"><div className="panel__body stack"><fieldset disabled={busy || input?.pending} className="stack"><legend>Your checkpoint</legend>
    <details><summary>Edit notes</summary><div className="stack">
      {snapshot.kind === 'team' && <Field label="Team checkpoint note"><textarea aria-label="Team checkpoint note" value={notes.checkpoint ?? ''} onChange={event => change({ ...notes, checkpoint: event.target.value })}/></Field>}
      {notes.slots.map((slot, index) => slot && <section className="stack" key={index} aria-label={`Slot ${index + 1} notes`}><Field label={`Slot ${index + 1} checkpoint note`}><textarea aria-label={`Slot ${index + 1} checkpoint note`} value={slot.checkpoint ?? ''} onChange={event => change({ ...notes, slots: notes.slots.map((value, position) => position === index ? { ...slot, checkpoint: event.target.value } : value) })}/></Field><Field label={`Slot ${index + 1} rotation notes`}><textarea aria-label={`Slot ${index + 1} rotation notes`} value={slot.rotationNotes ?? ''} onChange={event => change({ ...notes, slots: notes.slots.map((value, position) => position === index ? { ...slot, rotationNotes: event.target.value } : value) })}/></Field><Field label={`Slot ${index + 1} assumptions`}><textarea aria-label={`Slot ${index + 1} assumptions`} value={slot.contextAssumptions.join('\n')} onChange={event => change({ ...notes, slots: notes.slots.map((value, position) => position === index ? { ...slot, contextAssumptions: event.target.value === '' ? [] : event.target.value.split('\n') } : value) })}/></Field></section>)}
      <Button onClick={() => void save()} disabled={!dirty.current}>Save notes</Button>
    </div></details>
    <Field label="Local Game Setup"><select value={setupId ?? ''} onChange={event => setSetupId(event.target.value as GameSetupRevision['id'])}><option value="">Choose a local Game Setup</option>{setups.map(setup => <option key={setup.id} value={setup.id}>{setup.label}</option>)}</select></Field><p>The new checkpoint uses these local rules. Exact matching sources must be available and enabled.</p><Button onClick={() => void save(true)} disabled={!setupId}>Create editable checkpoint</Button>
  </fieldset>{busy && <p role="status">Saving checkpoint...</p>}{error && <InlineNotice title="Checkpoint not saved" tone="danger">{error}</InlineNotice>}</div></section>
}

export function CopiedPublicCheckpointView({ checkpoint, setup, title, onEdit, onDraftChange }: { readonly checkpoint: BuildRevision | TeamRevision; readonly setup: GameSetupRevision; readonly title: string; readonly onEdit?: SaveCopiedCheckpoint; readonly onDraftChange?: DraftChangeHandler }) {
  const snapshot = useMemo(() => publicSnapshotFromCheckpoint(setup, checkpoint, title), [setup, checkpoint, title])
  const ref: CopiedCheckpointRef = 'slots' in checkpoint ? { kind: 'team', revisionId: checkpoint.id } : { kind: 'build', revisionId: checkpoint.id }
  return <PublicSnapshotView snapshot={snapshot} copied copiedActions={onEdit ? viewer => <CopiedCheckpointActions snapshot={snapshot} checkpoint={ref} viewer={viewer} onEdit={onEdit} onDraftChange={onDraftChange}/> : undefined}/>
}
