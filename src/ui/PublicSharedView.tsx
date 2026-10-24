import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useBuildInput, useBuildInputState } from './build-input-session'
import type { DraftActions, DraftChangeHandler } from './drafts'
import type { CopiedCheckpointEdit, CopiedCheckpointRef } from '../interchange/public-checkpoint-edit'
import type { PublicNotes } from '../interchange/public-share-schema'
import { decodePublicSnapshot } from '../interchange/public-share'
import { publicRefKey, type PublicRef } from '../interchange/public-share-schema'
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
import { PrivateArtwork } from './mods/PrivateArtwork'
import { KnowledgeValue } from './KnowledgeValue'
import { decisionFacts } from './build-evidence'
import { SharedBuild } from './SharedView'
import { publicSnapshotFromCheckpoint } from '../domain/public-source-context'
import type { BuildRevision, TeamRevision, GameSetupRevision } from '../domain/types'
import { formatAppRoute, writeNavigationRoute } from './navigation'

type SavePublicSnapshot = (snapshot: PublicSnapshot) => Promise<{ buildId?: import('../domain/types').BuildId; teamId?: import('../domain/types').TeamId }>

const MAX_MATCHING_FILE_BYTES = 32 * 1024 * 1024

// Receipt-only rendering must not fall through to legacy mechanics or the viewer's Reference defaults
export function PublicSharedView({ encoded, onSave }: { readonly encoded: string; readonly onSave?: SavePublicSnapshot }) {
  const result = useMemo(() => { try { return { snapshot: decodePublicSnapshot(encoded) } } catch (error) { return { error: error instanceof Error ? error.message : 'Invalid public snapshot' } } }, [encoded])
  if (!result.snapshot) return <InlineNotice title="Shared snapshot unavailable" tone="danger">{result.error}</InlineNotice>
  return <PublicSnapshotView snapshot={result.snapshot} onSave={onSave}/>
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
  const name = (ref: PublicRef | null) => ref ? snapshot.receipts.find(receipt => publicRefKey(receipt.ref) === publicRefKey(ref))!.name : 'Unselected'
  return <div className="stack shared-preview public-shared-preview">
    <ScreenHeader eyebrow={snapshot.kind === 'team' ? 'Shared team' : 'Shared build'} title={snapshot.title} description="Saved selections and source requirements. Private definitions and artwork are not included." actions={repository && !copied ? <Button disabled={busy || !viewer} onClick={() => void save()}>{busy ? 'Saving...' : 'Save a copy'}</Button> : undefined}/>
    {copied && <InlineNotice title="Independent saved copy">The original checkpoint keeps its saved sources. Save your own notes or create an editable checkpoint with a local Game Setup.</InlineNotice>}
    {viewer && copiedActions?.(viewer)}
    {saved && <InlineNotice title="Copy saved" tone="positive"><a href={formatAppRoute({ page: saved.teamId ? { page: 'teams', view: 'team', teamId: saved.teamId } : { page: 'builds', view: 'build', buildId: saved.buildId! }, overlays: [], query: {} })}>Open your independent copy</a></InlineNotice>}
    {enrichment?.resolved ? <InlineNotice title="Matching definitions available" tone="positive">Definitions below come from your own files.</InlineNotice> : <InlineNotice title="Definitions required">Missing definitions remain unknown. Add matching files to inspect their effects.</InlineNotice>}
    {enrichment?.adaptedProjections.length ? <InlineNotice title="Adapted interpretation" tone="warning">Your matching source uses a different parser projection. These details are a read-only interpretation; the shared historical pins remain unchanged.</InlineNotice> : null}
    {error && <InlineNotice title="Shared view could not finish" tone="danger">{error}{failure?.library && !busy && <Button onClick={() => { setError(undefined); if (refreshLibrary.current && refreshLibrary.current.repository === repository) refreshLibrary.current.refresh() }}>Retry library read</Button>}</InlineNotice>}
    {repository && snapshot.setup.layers.length > 0 && <><Button tone="secondary" onClick={() => setSourcesOpen(value => !value)}>{repository.kind === 'account' ? 'Choose from my library' : 'Add matching files'}</Button>{sourcesOpen && <section className="panel" aria-label="Matching sources"><div className="panel__body stack">{snapshot.setup.layers.map(layer => <div key={JSON.stringify([layer.catalogId, layer.catalogRevisionId])}><h3>{layer.title}</h3><p>{layer.catalogId} · {layer.catalogRevisionId}</p><p>{!enrichment ? 'Reading your library...' : enrichment.missingSources.some(source => source.catalogId === layer.catalogId && source.catalogRevisionId === layer.catalogRevisionId) ? 'This exact source is missing from your library.' : 'Matching content is available in your library.'}</p><Field label={`Matching JSON for ${layer.title}`}><input type="file" accept=".json,application/json" disabled={busy || !viewer} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importMatching(layer, file) }}/></Field></div>)}{busy && <p role="status">Saving matching source...</p>}<p>Files are saved to your own library. Your active Playthrough and enabled mods stay unchanged.</p></div></section>}</>}
    {enrichment && <section aria-label="Your matching definitions">{enrichment.entries.map(entry => <details key={publicRefKey(entry.receipt.ref)}><summary>{entry.receipt.name}</summary>{entry.definition ? <div className="stack">{entry.viewerRef?.kind === 'catalog' && entry.artwork && <PrivateArtwork catalogId={entry.viewerRef.catalogId} catalogRevisionId={entry.viewerRef.catalogRevisionId} entity={{ ...entry.definition, id: entry.viewerRef.entityId }} detailed fallback={null}/>}<p>Definition from your library</p>{entry.definition.rawDescription && <p>{entry.definition.rawDescription}</p>}<dl className="definition-list">{decisionFacts(entry.definition).map(({ label, value }) => <div key={label}><dt>{label}</dt><dd><KnowledgeValue value={value}/></dd></div>)}</dl></div> : <p>Definition unavailable. The saved name supplies no mechanics.</p>}</details>)}</section>}
    <section className="panel"><div className="panel__body"><h2>Required sources</h2>{snapshot.setup.baseline && <p>Baseline: {snapshot.setup.baseline.catalogId} · {snapshot.setup.baseline.catalogRevisionId}</p>}{snapshot.setup.layers.map((layer, index) => <p key={index}>{index + 1}. {layer.title} · {layer.catalogId} · {layer.catalogRevisionId}</p>)}{snapshot.receipts.some(receipt => receipt.origin.kind === 'personal') && <p>Selected personal definitions require matching content fingerprints.</p>}</div></section>
    <div className={snapshot.kind === 'team' ? 'share-team-grid' : 'share-build-grid'}>{snapshot.slots.map((slot, index) => <section aria-label={snapshot.kind === 'team' ? `Shared team slot ${index + 1}` : 'Shared build loadout'} className="panel" key={index}><div className="panel__body stack"><h2>{slot?.name ?? `Slot ${index + 1}`}</h2>{slot ? <><p>Class: {name(slot.primaryClass)}</p><p>Subclass: {name(slot.secondaryClass)}</p><ul>{slot.equipment.map(entry => <li key={entry.slotId}>{snapshot.setup.slots.find(display => display.id === entry.slotId)?.label ?? entry.slotId}: {name(entry.ref)}</li>)}</ul>{slot.equipmentGroups.map((group, groupIndex) => <p key={groupIndex}>Shared equipment selection: {group.join(', ')}</p>)}<ul>{slot.passives.map((ref, passiveIndex) => <li key={passiveIndex}>{name(ref)}</li>)}</ul>{snapshot.notes?.slots[index] && <div className="share-notes">{snapshot.notes.slots[index]?.checkpoint && <p>{snapshot.notes.slots[index]?.checkpoint}</p>}{snapshot.notes.slots[index]?.rotationNotes && <p>{snapshot.notes.slots[index]?.rotationNotes}</p>}{snapshot.notes.slots[index]?.contextAssumptions.map((note, noteIndex) => <p key={noteIndex}>{note}</p>)}</div>}</> : <p>Empty slot</p>}</div></section>)}</div>
    {enrichment?.unresolvedCalculations && <InlineNotice title="Calculations unavailable">Exact source definitions and the saved setup lock are required. Missing mechanics remain unknown.</InlineNotice>}
    {preview && <section aria-label="Read-only calculations"><h2>Loadout and calculations</h2>{preview.revisions.map((revision, index) => revision ? <section key={index} aria-label={`Slot ${index + 1} calculations`}><SharedBuild revision={revision} preview={preview} onUploadMod={() => setSourcesOpen(true)}/></section> : null)}</section>}
    <details><summary>Selected entry requirements</summary>{snapshot.receipts.map(receipt => <p key={publicRefKey(receipt.ref)}>{receipt.name} · {receipt.origin.projectId} · {receipt.origin.sourceRevisionId} · {receipt.origin.catalogRevisionId}{receipt.origin.modelKey ? ` · ${receipt.origin.modelKey}` : ''}</p>)}</details>
    {snapshot.notes?.checkpoint && <p className="share-notes">{snapshot.notes.checkpoint}</p>}
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
