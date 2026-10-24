import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'
import { recordWorkspaceStartup, WORKSPACE_STARTUP_PHASE } from '../diagnostics/workspace-startup'
import { createGuestCopyService } from '../workspace/guest-copy'
import { createBuildInputSession, type BuildInputActions } from './build-input-session'
import { importOwnedLibrarySource, previewLibrarySource, readLibrarySource } from '../workspace/mod-repository'
import { downloadCapturedWorkspace } from './download-stream'
import { createSaveSession, saveContentBase, type SaveWorkspaceActions } from './save-workspace'
import { readSaveContent, saveExportStatus } from '../workspace/save-repository'
import { parseSavePending } from '../workspace/save-pending'
import { emptySavePending } from '../workspace/save-input-controller'
import { parseAppRoute, writeNavigationRoute } from './navigation'
import { NAVIGATION_EVENT } from './navigation/history'
import { createEditorSession, type EditorWorkspaceActions } from './editor-session'
import { reconcileOwnedFileOutcome, resolveOwnedFileReceipt, verifyOwnedFileReceipt } from '../workspace/owned-file-command'
import { readEditorContent } from '../workspace/editor-document'
import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react'
import { assertActiveProfile, captureProfileEpoch, currentProfileToken, onProfileTransition, ProfileChangedError, type ProfileToken } from '../account/profile'
import { attachSyncScheduler, requestSync, subscribeSync, type SyncState } from '../account/sync/scheduler'
import { registerSyncProjectionGuard, runSyncIteration } from '../account/sync/outbox'
import { unlockRememberedProfile } from '../account/lifecycle'
import { listCachedProfiles } from '../account/device-store'
import { readDeviceSelection, writeDeviceSelection } from '../workspace/device-selection'
import { openAccountRepository, readAccountSaveRecovery } from '../workspace/account-repository'
import { createGuestRepository, captureGuestWorkspaceForCopy, guestRepositorySelection, readGuestSaveRecovery } from '../workspace/guest-repository'
import { GUEST_ACTIVATED_EVENT } from '../workspace/guest-workspace'
import { markWorkspaceAccess, readTabWorkspaceAccess, selectAccountPreferences, tabIsExplicitlyLocked, workspaceSelectionKey, type WorkspaceSelection } from '../workspace/profile-selection'
import type { WorkspaceRepository } from '../workspace/repository'
import { ErrorBoundary } from './ErrorBoundary'
import { GuestRecoveryNotice } from './GuestRecoveryNotice'
import { AccountView } from './account/AccountView'
import { LoadingScreen } from './components'

interface ReferenceRetry { readonly cardId: string; readonly included: boolean; readonly message: string }
interface ModLibraryResult { readonly saved: { readonly title: string; readonly unchanged: boolean; readonly warnings: readonly string[] }; readonly futureDefault: boolean }
function isAccountEntryRoute(): boolean {
  const page = parseAppRoute(window.location.hash).page
  return page.page === 'settings' && page.section === 'account'
}
const copyModLibraryResult = (value: ModLibraryResult): ModLibraryResult => ({ saved: { title: value.saved.title, unchanged: value.saved.unchanged, warnings: [...value.saved.warnings] }, futureDefault: value.futureDefault })
interface WorkspaceContextValue extends EditorWorkspaceActions, SaveWorkspaceActions, BuildInputActions {
  readonly repository: WorkspaceRepository
  readonly localCopy: ReturnType<typeof createGuestCopyService>
  readonly token?: ProfileToken
  openAccount(token: ProfileToken): Promise<void>
  continueLocal(): Promise<void>
  reopenGuest(preserveReferenceRetry?: boolean, completedModImport?: ModLibraryResult): Promise<void>
  readReferenceRetry(): ReferenceRetry | undefined
  rememberReferenceRetry(value: ReferenceRetry | undefined): void
  readModLibraryResult(): ModLibraryResult | undefined
  clearModLibraryResult(): void
  reopenAccount(): Promise<void>
  readonly syncState: SyncState
  retrySync(): void
  flushSync(): void
  registerDraftPresence(read: (exceptOwner?: symbol) => boolean): () => void
}
const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined)
export function useOptionalWorkspace(): WorkspaceContextValue | undefined { return useContext(WorkspaceContext) }
export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('A captured workspace is required')
  return value
}
export function WorkspaceProvider({ children }: { readonly children: ReactNode }) {
  const [accountEntry, setAccountEntry] = useState(isAccountEntryRoute)
  const [guest, setGuest] = useState(createGuestRepository)
  const [selection, setSelection] = useState<WorkspaceSelection>({ kind: 'opening', generation: 0 })
  const [repository, setRepository] = useState<WorkspaceRepository>(guest)
  const current = useRef(selection)
  const version = useRef(0)
  const draftReaders = useRef(new Set<(exceptOwner?: symbol) => boolean>())
  const draftPresence = useRef((owner?: symbol) => [...draftReaders.current].some(read => read(owner)))
  const editorSession = useRef(createEditorSession()).current
  const saveSession = useRef(createSaveSession()).current
  const buildInputSession = useRef(createBuildInputSession()).current
  const filePending = useRef(false)
  const localCopy = useRef(createGuestCopyService(() => captureGuestWorkspaceForCopy(), () => {
    if (filePending.current || draftPresence.current() || editorSession.controller.snapshot().dirty || saveSession.controller.snapshot().dirty || buildInputSession.controller.snapshot().dirty) throw new Error('Save or discard open drafts before copying local work')
  })).current
  useEffect(() => {
    if (!accountEntry) return
    // Only the initial account entry bypasses planner startup; later settings navigation keeps open drafts mounted
    const leave = () => { if (!isAccountEntryRoute()) setAccountEntry(false) }
    window.addEventListener('hashchange', leave); window.addEventListener('popstate', leave); window.addEventListener(NAVIGATION_EVENT, leave)
    return () => { window.removeEventListener('hashchange', leave); window.removeEventListener('popstate', leave); window.removeEventListener(NAVIGATION_EVENT, leave) }
  }, [accountEntry])
  const referenceRetry = useRef<ReferenceRetry>(undefined)
  const modLibraryResult = useRef<ModLibraryResult>(undefined)
  const [, refreshBuildPhase] = useState(0)
  const resetEditorSession = () => {
    referenceRetry.current = undefined
    modLibraryResult.current = undefined
    buildInputSession.controller.revoke()
    buildInputSession.view = undefined
    buildInputSession.scope = undefined
    buildInputSession.recovery = undefined
    buildInputSession.hydration = undefined
    buildInputSession.phase = 'idle'
    saveSession.controller.revoke()
    saveSession.navigation = undefined
    saveSession.recovery = undefined
    saveSession.document?.content.originalBytes.fill(0)
    saveSession.document?.content.workingBytes.fill(0)
    saveSession.document = undefined
    saveSession.sourceReads.clear()
    saveSession.hydration = undefined
    saveSession.transferView = undefined
    saveSession.captureFocus = undefined
    saveSession.sources = []
    saveSession.candidate = undefined
    saveSession.phase = 'idle'
    saveSession.operation = undefined
    editorSession.controller.revoke()
    editorSession.navigation = undefined
    editorSession.applyRequested = undefined
    editorSession.libraryResult = undefined
    editorSession.recovery = undefined
    editorSession.document = undefined
    editorSession.hydration = undefined
    editorSession.transferView = undefined
    editorSession.captureFocus = undefined
    editorSession.scroll = undefined
    editorSession.explorer = undefined
    editorSession.phase = 'idle'
    filePending.current = false
  }
  const currentRepository = useRef(repository)
  currentRepository.current = repository
  const [ownedGeneration, setOwnedGeneration] = useState(0)
  const [syncState, setSyncState] = useState<SyncState>('paused')
  const retrySync = useCallback(() => { const selected = current.current; if (selected.kind === 'account') requestSync(selected.token, 'retry') }, [])
  const flushSync = useCallback(() => { const selected = current.current; if (selected.kind === 'account') requestSync(selected.token, 'save') }, [])
  useEffect(() => {
    if (selection.kind !== 'account') return
    const token = selection.token
    const unregister = registerSyncProjectionGuard(token, () => current.current === selection && !filePending.current && !draftPresence.current() && !editorSession.controller.snapshot().dirty && !saveSession.controller.snapshot().dirty && !buildInputSession.controller.snapshot().dirty)
    const stop = attachSyncScheduler(token, runSyncIteration)
    const unsubscribe = subscribeSync(token, setSyncState)
    return () => { unsubscribe(); stop(); unregister() }
  }, [selection])
  const [successorPending, setSuccessorPending] = useState(false)
  const guestRefresh = useRef<{ repository: WorkspaceRepository; run: (preserveReferenceRetry?: boolean, completedModImport?: ModLibraryResult) => Promise<boolean> }>(undefined)
  const registerDraftPresence = useCallback((read: (exceptOwner?: symbol) => boolean) => {
    draftReaders.current.add(read)
    return () => { draftReaders.current.delete(read) }
  }, [])
  useEffect(() => {
    if (selection.kind !== 'guest' || repository.kind !== 'guest' || accountEntry) return
    let live = true
    const generation = version.current
    let pending: Promise<boolean> | undefined
    let preserveRetry = false
    let completedImport: ModLibraryResult | undefined
    const refreshSelection = async (): Promise<boolean> => {
      const previous = await guestRepositorySelection(repository)
      const active = await previous.readSelected()
      if (!active || guestPlannerValuesEqual(active, previous.manifest)) return false
      const successor = createGuestRepository(), nextBinding = await guestRepositorySelection(successor)
      const confirmed = await previous.readSelected()
      // Activation events carry no authority; a late guest result cannot replace a selected account
      if (!live || version.current !== generation || current.current.kind !== 'guest' || !guestPlannerValuesEqual(confirmed, nextBinding.manifest)) throw new Error('The selected workspace changed during reopening')
      if (filePending.current || draftPresence.current() || editorSession.controller.snapshot().dirty || saveSession.controller.snapshot().dirty || buildInputSession.controller.snapshot().dirty) {
        setSuccessorPending(true)
        throw new Error('Finish or recover open drafts before reopening the selected workspace')
      }
      // Only the explicit update action carries this inert requested choice; no callback survives reopening
      const retry = preserveRetry ? referenceRetry.current : undefined
      // Only a completed import's inert notice crosses this authenticated successor admission
      // Source files and callbacks remain attached to the retired owner
      const imported = completedImport
      resetEditorSession()
      referenceRetry.current = retry
      modLibraryResult.current = imported
      setSuccessorPending(false)
      const next: WorkspaceSelection = { kind: 'guest', generation: ++version.current }
      current.current = next
      setGuest(successor); setRepository(successor); setSelection(next)
      return true
    }
    const refresh = (preserveReferenceRetry = false, completedModImport?: ModLibraryResult): Promise<boolean> => {
      preserveRetry ||= preserveReferenceRetry
      if (completedModImport) completedImport = copyModLibraryResult(completedModImport)
      // A publication hint and its awaiting bulk caller share one complete successor admission
      if (pending) return pending
      const attempt = refreshSelection().catch(error => {
        if (live && version.current === generation && current.current.kind === 'guest') setSuccessorPending(true)
        throw error
      })
      const completed = attempt.finally(() => { if (pending === completed) { pending = undefined; preserveRetry = false; completedImport = undefined } })
      pending = completed
      return completed
    }
    const captured = { repository, run: refresh }
    guestRefresh.current = captured
    const hint = () => { void refresh().catch(() => { /* Explicit callers surface recovery errors */ }) }
    window.addEventListener(GUEST_ACTIVATED_EVENT, hint)
    const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(GUEST_ACTIVATED_EVENT)
    channel?.addEventListener('message', hint)
    hint()
    return () => {
      live = false
      if (guestRefresh.current === captured) guestRefresh.current = undefined
      window.removeEventListener(GUEST_ACTIVATED_EVENT, hint); channel?.close()
    }
  }, [repository, selection.kind, accountEntry])
  const reopenGuest = useCallback(async (preserveReferenceRetry = false, completedModImport?: ModLibraryResult) => {
    const captured = guestRefresh.current
    if (repository.kind !== 'guest' || current.current !== selection || captured?.repository !== repository) throw new Error('The captured guest workspace is no longer selected')
    const changed = await captured.run(preserveReferenceRetry, completedModImport)
    // An earlier hint may have observed the old pointer before this caller's publication
    // Recheck once after that shared attempt instead of accepting its pre-publication no-change result
    if (!changed && current.current === selection) await captured.run(preserveReferenceRetry, completedModImport)
    if (current.current.kind !== 'guest') throw new Error('The selected workspace changed during reopening')
  }, [repository, selection])
  useEffect(() => onProfileTransition(reason => {
    version.current++
    resetEditorSession()
    if (current.current.kind !== 'account') return
    const locked: WorkspaceSelection = { kind: 'locked', generation: version.current }
    current.current = locked
    selectAccountPreferences(true)
    // Pagehide clears the same keys and projections without recording a deliberate Lock
    if (reason !== 'pagehide') markWorkspaceAccess('account-locked')
    setSelection(locked)
  }), [])
  const openAccount = async (token: ProfileToken) => {
    assertActiveProfile(token)
    if (current.current.kind === 'account' && current.current.token === token) {
      window.location.hash = '#/builds'
      return
    }
    resetEditorSession()
    const captured = ++version.current
    const opened = await openAccountRepository(token)
    assertActiveProfile(token)
    if (version.current !== captured) throw new ProfileChangedError()
    await writeDeviceSelection({ key: 'selected', version: 1, kind: 'account', accountId: token.accountId }, () => assertActiveProfile(token))
    if (version.current !== captured) throw new ProfileChangedError()
    const next: WorkspaceSelection = { kind: 'account', token }
    current.current = next
    selectAccountPreferences(true)
    markWorkspaceAccess('account-open')
    setAccountEntry(false)
    // A keyed subtree discards every optimistic queue, recovery draft and old source URL together
    window.history.replaceState(null, '', '#/builds')
    setRepository(opened)
    setSelection(next)
  }
  const reopenAccount = useCallback(async () => {
    if (selection.kind !== 'account') throw new Error('The captured account workspace is no longer selected')
    const token = selection.token, generation = version.current
    const assertMayReopen = () => {
      assertActiveProfile(token)
      if (current.current !== selection || currentRepository.current !== repository || version.current !== generation) throw new Error('The captured account workspace is no longer selected')
      if (filePending.current || draftPresence.current() || editorSession.controller.snapshot().dirty || saveSession.controller.snapshot().dirty || buildInputSession.controller.snapshot().dirty) throw new Error('Finish or recover open drafts before reopening the selected workspace')
    }
    assertMayReopen()
    const opened = await openAccountRepository(token)
    assertMayReopen()
    // The fresh wrapper authenticates the selected head; old callbacks retain their original view and generation
    // Reopening preserves the route but remounts queues and volatile inputs only after complete admission
    await opened.load()
    assertMayReopen()
    resetEditorSession()
    version.current++
    const next: WorkspaceSelection = { kind: 'account', token }
    current.current = next
    currentRepository.current = opened
    setRepository(opened); setSelection(next); setOwnedGeneration(value => value + 1)
  }, [repository, selection])
  const continueLocal = async () => {
    const captured = ++version.current
    resetEditorSession()
    const epoch = captureProfileEpoch()
    // Explicit continuation owns a new profile lifetime; the earlier guest wrapper keeps its original profile fence
    const local = createGuestRepository()
    await writeDeviceSelection({ key: 'selected', version: 1, kind: 'guest' }, epoch.assertCurrent)
    epoch.assertCurrent()
    if (version.current !== captured) throw new ProfileChangedError()
    const next: WorkspaceSelection = { kind: 'guest', generation: captured }
    current.current = next
    selectAccountPreferences(false)
    markWorkspaceAccess('guest')
    setAccountEntry(false)
    window.history.replaceState(null, '', '#/builds')
    setGuest(local)
    setRepository(local)
    setSelection(next)
  }
  const startup = useRef<Promise<{ selection: WorkspaceSelection; repository?: WorkspaceRepository }>>(undefined)
  useEffect(() => {
    let live = true
    // StrictMode attaches twice; unlock only once so the second pass cannot invalidate its own key
    startup.current ??= (async () => {
      recordWorkspaceStartup(WORKSPACE_STARTUP_PHASE.begin)
      if (tabIsExplicitlyLocked()) return { selection: { kind: 'locked' as const, generation: 0 } }
      const epoch = captureProfileEpoch()
      const selected = await readDeviceSelection()
      recordWorkspaceStartup(WORKSPACE_STARTUP_PHASE.selection)
      epoch.assertCurrent()
      if (selected?.kind !== 'account' && readTabWorkspaceAccess()?.startsWith('account')) return { selection: { kind: 'locked' as const, generation: 0 } }
      if (selected?.kind === 'guest') return { selection: { kind: 'guest' as const, generation: 0 } }
      const cached = await listCachedProfiles()
      recordWorkspaceStartup(WORKSPACE_STARTUP_PHASE.profiles)
      epoch.assertCurrent()
      // Missing selection cannot choose among cached accounts or silently relabel their workspace
      if (!selected) return { selection: { kind: cached.length ? 'locked' as const : 'guest' as const, generation: 0 } }
      if (!cached.some(profile => profile.accountId === selected.accountId && profile.remembered)) return { selection: { kind: 'locked' as const, generation: 0 } }
      const token = currentProfileToken() ?? await unlockRememberedProfile(selected.accountId)
      recordWorkspaceStartup(WORKSPACE_STARTUP_PHASE.unlocked)
      if (token.accountId !== selected.accountId) throw new ProfileChangedError()
      const repository = await openAccountRepository(token)
      recordWorkspaceStartup(WORKSPACE_STARTUP_PHASE.repository)
      assertActiveProfile(token)
      return { selection: { kind: 'account' as const, token }, repository }
    })()
    void startup.current.then(result => {
      if (!live) return
      current.current = result.selection
      selectAccountPreferences(result.selection.kind !== 'guest')
      if (result.repository) setRepository(result.repository)
      setSelection(result.selection)
    }).catch(() => {
      if (!live) return
      recordWorkspaceStartup(WORKSPACE_STARTUP_PHASE.failed)
      const locked: WorkspaceSelection = { kind: 'locked', generation: ++version.current }
      current.current = locked
      selectAccountPreferences(true)
      setSelection(locked)
    })
    return () => { live = false }
  }, [])
  const capturedGeneration = version.current
  const isCurrent = () => version.current === capturedGeneration && currentRepository.current === repository && current.current === selection
  const editorActions: EditorWorkspaceActions = {
    editorSession,
    reopenEditorSavedVersion: async (view, documentId) => {
      const controller = editorSession.controller, input = controller.snapshot()
      const check = () => {
        controller.assertView(view)
        if (!isCurrent() || input.documentId !== documentId || editorSession.document?.file.id !== documentId || controller.snapshot().input !== input.input) throw new Error('The Editor changed before reopening its saved version')
        if (filePending.current || editorSession.phase !== 'idle' || !controller.canTransfer() || draftPresence.current(controller.owner) || saveSession.controller.snapshot().dirty || buildInputSession.controller.snapshot().dirty) throw new Error('Finish or recover other open drafts before reopening this file')
      }
      check()
      const opened = selection.kind === 'account' ? await openAccountRepository(selection.token) : createGuestRepository()
      const state = await opened.readWorkspace()
      check()
      const file = state.editorDocuments.find(value => value.id === documentId)
      if (!file) throw new Error('This saved file is unavailable. Keep or download the open draft before choosing another file.')
      const content = await readEditorContent(state, file)
      let installed = false
      try {
        check()
        await opened.load()
        check()
        // Explicit reopening may discard this Editor's input only after the selected file and all its bodies are admitted
        // Replacing the wrapper also retires old callbacks; reopening just the row would leave future saves fenced to the loser
        resetEditorSession()
        const nextView = controller.attach()
        controller.open(nextView, file.id, file.revision, { original: JSON.stringify(file.original), applied: JSON.stringify(file.lastApplied), reference: file.referenceId }, { text: content.unfinishedText, editedPath: file.unfinished.editedPath, fieldState: file.unfinished.fieldState, validation: file.unfinished.validation })
        editorSession.transferView = nextView
        editorSession.document = { file, content }
        const generation = ++version.current
        const next: WorkspaceSelection = selection.kind === 'account' ? { kind: 'account', token: selection.token } : { kind: 'guest', generation }
        current.current = next; currentRepository.current = opened
        setRepository(opened); setSelection(next); setOwnedGeneration(generation); setSuccessorPending(false)
        if (next.kind === 'guest') setGuest(opened)
        installed = true
      } finally {
        if (!installed) { content.originalBytes.fill(0); content.lastAppliedBytes.fill(0) }
      }
    },
    isCurrent,
    fileCommandPending: () => filePending.current,
    importEditorSource: async (preview, expected, owner, result) => {
      const session = editorSession, file = session.document?.file, view = session.transferView
      const input = session.controller.snapshot()
      const source = preview.proposed.sources[0]
      if (owner !== session.controller.owner || !file || !view || input.dirty || input.documentId !== file.id || input.revision !== file.revision || input.input?.text !== session.document!.content.lastAppliedText || !source || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source.bytes) !== input.input.text || source.filename !== file.filename) throw new Error('The applied Editor input changed before importing its source')
      const ticket = editorActions.beginEditorCommand(view, 'libraryImport')
      session.libraryResult = undefined
      try {
        const incoming = await previewLibrarySource(preview)
        ticket.command.assertMayActivate()
        const state = await repository.readWorkspace()
        ticket.command.assertMayActivate()
        if (state.planner.localData.id !== expected.id || state.planner.localData.revision !== expected.revision) throw new Error('The workspace changed before importing the Editor source')
        if (state.planner.catalogs.some(catalog => catalog.id === incoming.catalogId && catalog.revisionId === incoming.catalogRevisionId && catalog.checksum === `sha256:${incoming.originalDigest}`)) {
          const stored = await readLibrarySource(repository, incoming)
          ticket.command.assertMayActivate()
          // An identical original needs no new command or ownership transfer; pin equality alone is insufficient
          if (stored.bytes.byteLength === source.bytes.byteLength && stored.bytes.every((value, index) => value === source.bytes[index])) {
            filePending.current = false
            session.phase = 'idle'
            return
          }
        }
      } catch (error) {
        await editorActions.completeEditorCommand({ status: 'not-saved', error }, ticket, file)
        return
      }
      const outcome = await importOwnedLibrarySource(repository, preview, ticket.command, expected)
      // Only a saved owned command can carry this inert result through the exact file's remount
      if (outcome.status === 'saved') {
        session.libraryResult = { documentId: file.id, revision: file.revision, result: { ...result, warnings: [...result.warnings] } }
      }
      await editorActions.completeEditorCommand(outcome, ticket, file)
    },
    beginEditorCommand: (view, operation) => {
      if (filePending.current) throw new Error('Another file command is still being reconciled')
      const guard = () => {
        if (!isCurrent() || draftPresence.current(editorSession.controller.owner)) throw new Error('The workspace or another open draft changed during file saving')
      }
      const ticket = editorSession.controller.capture(view, operation, guard)
      if (operation !== 'libraryImport') editorSession.libraryResult = undefined
      filePending.current = true
      editorSession.phase = 'staging'
      return ticket
    },
    completeEditorCommand: async (outcome, ticket, file) => {
      // A completed old transaction cannot mutate recovery or pending flags belonging to a successor profile
      if (!isCurrent()) throw new Error(outcome.status === 'saved' ? 'The captured draft was saved; its editor owner was retired' : 'The editor command owner was retired')
      editorSession.recovery = { outcome, ticket, file }
      if (outcome.status !== 'saved' || !outcome.receipt) {
        if (outcome.status === 'not-saved') { filePending.current = false; editorSession.phase = 'idle'; editorSession.recovery = undefined }
        else editorSession.phase = 'recovery'
        throw outcome.error ?? new Error('File save outcome is uncertain. Keep your draft for recovery.')
      }
      try {
        ticket.command.assertMayActivate()
        editorSession.phase = 'reconciling'
        const completion = await resolveOwnedFileReceipt(outcome.receipt)
        ticket.command.assertMayActivate()
        const content = file ? await readEditorContent(completion.state, file) : undefined
        ticket.command.assertMayActivate()
        do {
          await editorSession.controller.waitForTransfer()
          ticket.command.assertMayActivate()
          await completion.assertCurrent()
          ticket.command.assertMayActivate()
          // Receipt I/O can overlap a new gesture or composition; transfer only after an idle recheck
          // Keep the final check and ownership transfer in one synchronous continuation
        } while (!editorSession.controller.canTransfer())
        editorSession.captureFocus?.()
        if (file?.id !== editorSession.document?.file.id) {
          editorSession.scroll = undefined
          editorSession.explorer = undefined
        }
        const view = editorSession.transferView
        if (!view) throw new Error('The file input owner is no longer mounted')
        if (file && content) {
          if (ticket.command.operation === 'saveUnfinished' || ticket.command.operation === 'libraryImport') editorSession.controller.acknowledge(ticket, file.revision)
          else editorSession.controller.open(view, file.id, file.revision, { original: JSON.stringify(file.original), applied: JSON.stringify(file.lastApplied), reference: file.referenceId }, { text: content.unfinishedText, editedPath: file.unfinished.editedPath, fieldState: file.unfinished.fieldState, validation: file.unfinished.validation })
          editorSession.document = { file, content }
        } else { editorSession.controller.close(view); editorSession.document = undefined }
        const transferred = editorSession.controller.transfer(view)
        editorSession.transferView = transferred
        const generation = ++version.current
        editorSession.phase = 'hydrating'
        editorSession.hydration = { view: transferred, completion, generation }
        currentRepository.current = completion.repository
        setRepository(completion.repository)
        if (selection.kind === 'guest') {
          const next: WorkspaceSelection = { kind: 'guest', generation }
          current.current = next; setSelection(next); setGuest(completion.repository)
        }
        setOwnedGeneration(generation)
        setSuccessorPending(false)
      } catch (reason) {
        if (isCurrent()) editorSession.phase = 'recovery'
        // Publication and UI continuation have separate outcomes; rejected completion cannot claim rollback
        throw new Error(`The captured draft was saved. Reopening is pending; keep or export your later edits. ${reason instanceof Error ? reason.message : String(reason)}`)
      }
    },
    captureEditorNavigation: (destination, owner) => {
      if (owner !== editorSession.controller.owner) return
      if (!isCurrent() || draftPresence.current(owner)) throw new Error('Another workspace owner blocks this navigation')
      const snapshot = editorSession.controller.snapshot()
      editorSession.navigation = { destination: structuredClone(destination), sourceHash: window.location.hash, documentId: snapshot.documentId, input: JSON.stringify(snapshot.input) }
    },
    retryEditorCommand: async view => {
      editorSession.controller.assertView(view)
      if (!isCurrent()) throw new Error('This editor recovery view was retired')
      if (editorSession.hydration) return editorActions.confirmEditorHydration(view)
      const recovery = editorSession.recovery
      if (!recovery) throw new Error('There is no file command awaiting reconciliation')
      const outcome = await reconcileOwnedFileOutcome(recovery.outcome)
      if (!isCurrent() || editorSession.recovery !== recovery) throw new Error('The file recovery owner changed')
      await editorActions.completeEditorCommand(outcome, recovery.ticket, recovery.file)
    },
    confirmEditorHydration: async view => {
      const hydration = editorSession.hydration
      try {
        editorSession.controller.assertView(view)
        if (hydration && (hydration.view !== view || hydration.generation !== version.current || !isCurrent() || draftPresence.current(editorSession.controller.owner))) throw new Error('The saved draft needs explicit reopening before more edits')
        // StrictMode can repeat readiness while this exact transferred view's receipt check is pending
        // Share its verification without granting another view or workspace authority
        if (hydration?.confirmation) return hydration.confirmation
        const confirm = async () => {
          if (hydration) {
            await hydration.completion.assertCurrent()
            if (hydration !== editorSession.hydration || hydration.generation !== version.current || !isCurrent() || draftPresence.current(editorSession.controller.owner)) throw new Error('Workspace changed during editor hydration')
          }
          editorSession.controller.hydrated(view)
          editorSession.hydration = undefined
          editorSession.recovery = undefined
          editorSession.phase = 'idle'
          filePending.current = false
          if (selection.kind === 'account') requestSync(selection.token, 'quiet')
          const navigation = editorSession.navigation
          editorSession.navigation = undefined
          const snapshot = editorSession.controller.snapshot()
          // Navigation belongs to the captured request, not an asynchronous callback from the retired App
          if (navigation && !snapshot.dirty && snapshot.documentId === navigation.documentId && JSON.stringify(snapshot.input) === navigation.input && window.location.hash === navigation.sourceHash) writeNavigationRoute(navigation.destination, 'push')
        }
        const pending = confirm()
        if (hydration) hydration.confirmation = pending
        await pending
      } catch (error) {
        if (isCurrent() && hydration === editorSession.hydration) { editorSession.phase = 'recovery'; if (hydration) hydration.confirmation = undefined }
        throw error
      }
    },
  }
  const saveActions: SaveWorkspaceActions = {
    saveSession,
    beginSaveCommand: (view, operation) => {
      if (saveSession.sourceReads.size) throw new Error('Save definitions are still being loaded')
      // A volatile display fallback for a newer form is never authority to overwrite its stored payload
      if (operation === 'savePending' && saveSession.document && parseSavePending(saveSession.document.file.pendingForm).kind === 'unsupported') throw new Error('Reset unsupported unfinished input explicitly before saving a replacement')
      if (['saveExport', 'saveImport', 'saveRemove'].includes(operation) && saveSession.controller.snapshot().dirty) throw new Error('Save unfinished input before this operation')
      if (filePending.current) throw new Error('Another file command is still being reconciled')
      const guard = () => {
        if (!isCurrent() || draftPresence.current(saveSession.controller.owner)) throw new Error('The workspace or another open draft changed during file saving')
      }
      const ticket = saveSession.controller.capture(view, operation, guard)
      filePending.current = true
      saveSession.phase = 'staging'
      saveSession.operation = operation
      return ticket
    },
    completeSaveCommand: async (outcome, ticket, file) => {
      // A completed old transaction cannot mutate recovery or pending flags belonging to a successor profile
      if (!isCurrent()) throw new Error(outcome.status === 'saved' ? 'The captured draft was saved; its save owner was retired' : 'The save command owner was retired')
      saveSession.recovery = { outcome, ticket, file }
      if (outcome.status !== 'saved' || !outcome.receipt) {
        if (outcome.status === 'not-saved') { filePending.current = false; saveSession.phase = 'idle'; saveSession.recovery = undefined }
        else saveSession.phase = 'recovery'
        throw outcome.error ?? new Error('File save outcome is uncertain. Keep your draft for recovery.')
      }
      try {
        ticket.command.assertMayActivate()
        saveSession.phase = 'reconciling'
        const completion = await resolveOwnedFileReceipt(outcome.receipt)
        ticket.command.assertMayActivate()
        if (file && JSON.stringify(completion.state.saveDocuments.find(value => value.id === file.id)) !== JSON.stringify(file)) throw new Error('Saved file container does not match the exact receipt result')
        const content = file ? await readSaveContent(completion.state, file) : undefined
        ticket.command.assertMayActivate()
        const exportStatus = file ? await saveExportStatus(completion.state, file) : 'never'
        ticket.command.assertMayActivate()
        await saveSession.controller.waitForTransfer()
        ticket.command.assertMayActivate()
        await completion.assertCurrent()
        ticket.command.assertMayActivate()
        saveSession.captureFocus?.()
        const view = saveSession.transferView
        if (!view) throw new Error('The file input owner is no longer mounted')
        if (file && content) {
          if (ticket.command.operation === 'savePending') saveSession.controller.acknowledge(ticket, file.revision)
          else { const parsed = parseSavePending(file.pendingForm); saveSession.controller.open(view, file.id, file.revision, saveContentBase(file), content.workingBytes, parsed.kind === 'supported' ? parsed.input : emptySavePending()) }
          saveSession.document = { file, content, exportStatus }
        } else { saveSession.controller.close(view); saveSession.document = undefined }
        const transferred = saveSession.controller.transfer(view)
        saveSession.transferView = transferred
        const generation = ++version.current
        saveSession.phase = 'hydrating'
        saveSession.hydration = { view: transferred, completion, generation }
        currentRepository.current = completion.repository
        setRepository(completion.repository)
        if (selection.kind === 'guest') {
          const next: WorkspaceSelection = { kind: 'guest', generation }
          current.current = next; setSelection(next); setGuest(completion.repository)
        }
        setOwnedGeneration(generation)
        setSuccessorPending(false)
      } catch (reason) {
        if (isCurrent()) saveSession.phase = 'recovery'
        // Publication and UI continuation have separate outcomes; rejected completion cannot claim rollback
        throw new Error(`The captured draft was saved. Reopening is pending; keep or export your later edits. ${reason instanceof Error ? reason.message : String(reason)}`)
      }
    },
    captureSaveNavigation: (destination, owner) => {
      if (owner !== saveSession.controller.owner) return
      if (!isCurrent() || draftPresence.current(owner)) throw new Error('Another workspace owner blocks this navigation')
      const snapshot = saveSession.controller.snapshot()
      saveSession.navigation = { destination: structuredClone(destination), sourceHash: window.location.hash, documentId: snapshot.documentId, input: JSON.stringify(snapshot.input) }
    },
    retrySaveCommand: async view => {
      saveSession.controller.assertView(view)
      if (!isCurrent()) throw new Error('This save recovery view was retired')
      if (saveSession.hydration) return saveActions.confirmSaveHydration(view)
      const recovery = saveSession.recovery
      if (!recovery) throw new Error('There is no file command awaiting reconciliation')
      const outcome = await reconcileOwnedFileOutcome(recovery.outcome)
      if (!isCurrent() || saveSession.recovery !== recovery) throw new Error('The file recovery owner changed')
      await saveActions.completeSaveCommand(outcome, recovery.ticket, recovery.file)
    },
    prepareSaveRecovery: async view => {
      const recovery = saveSession.recovery, input = saveSession.controller.snapshot().input
      const assertCurrent = () => {
        saveSession.controller.assertView(view)
        if (!isCurrent() || saveSession.recovery !== recovery || saveSession.phase !== 'recovery' || recovery?.outcome.status !== 'saved' || !recovery.outcome.receipt || !recovery.file || saveSession.sourceReads.size || draftPresence.current(saveSession.controller.owner) || saveSession.controller.snapshot().input !== input) throw new Error('The saved recovery owner or input changed')
        if (selection.kind === 'account') assertActiveProfile(selection.token)
      }
      const verify = async () => { assertCurrent(); await verifyOwnedFileReceipt(recovery!.outcome.receipt!); assertCurrent() }
      await verify()
      const file = recovery!.file!
      // Read the saved Apply result, never the older bytes still displayed by a rejected strict owner
      const content = selection.kind === 'account' ? await readAccountSaveRecovery(selection.token, file) : await readGuestSaveRecovery(repository, file)
      await verify()
      return { copy: { filename: file.filename, original: { byteLength: file.original.byteLength, sha256: file.original.sha256 }, working: { byteLength: file.working.byteLength, sha256: file.working.sha256 }, ...content, storedPending: file.pendingForm, livePending: input ? JSON.parse(JSON.stringify(input)) : null }, verify, assertCurrent }
    },
    reloadSaveRecovery: async (view, confirmDiscard) => {
      const recovery = saveSession.recovery, input = saveSession.controller.snapshot().input
      const assertCurrent = () => {
        saveSession.controller.assertView(view)
        if (!isCurrent() || saveSession.recovery !== recovery || saveSession.phase !== 'recovery' || recovery?.outcome.status !== 'saved' || !recovery.outcome.receipt || saveSession.sourceReads.size || draftPresence.current(saveSession.controller.owner) || saveSession.controller.snapshot().input !== input) throw new Error('Another workspace owner or draft blocks recovery reload')
        if (selection.kind === 'account') assertActiveProfile(selection.token)
      }
      assertCurrent()
      await verifyOwnedFileReceipt(recovery!.outcome.receipt!); assertCurrent()
      if (!confirmDiscard()) return
      // Confirmation cannot confer authority across a delayed profile, pointer or unrelated draft change
      await verifyOwnedFileReceipt(recovery!.outcome.receipt!); assertCurrent()
      window.location.reload()
    },
    confirmSaveHydration: async view => {
      const hydration = saveSession.hydration
      saveSession.controller.assertView(view)
      if (hydration && (hydration.view !== view || hydration.generation !== version.current || !isCurrent() || draftPresence.current(saveSession.controller.owner))) throw new Error('The saved draft needs explicit reopening before more edits')
      // StrictMode repeats readiness for the same transferred view before its receipt check settles
      // Coalescing belongs to that exact hydration; a different owner still fails the guards
      if (hydration?.confirmation) return hydration.confirmation
      const confirm = async () => {
        if (hydration) {
          await hydration.completion.assertCurrent()
          if (hydration !== saveSession.hydration || hydration.generation !== version.current || !isCurrent() || draftPresence.current(saveSession.controller.owner)) throw new Error('Workspace changed during save hydration')
        }
        saveSession.controller.hydrated(view)
        saveSession.hydration = undefined
        saveSession.recovery = undefined
        saveSession.phase = 'idle'
        filePending.current = false
        if (selection.kind === 'account') requestSync(selection.token, 'quiet')
        const navigation = saveSession.navigation
        saveSession.navigation = undefined
        const snapshot = saveSession.controller.snapshot()
        // Navigation belongs to the captured request, not an asynchronous callback from the retired App
        if (navigation && !snapshot.dirty && snapshot.documentId === navigation.documentId && JSON.stringify(snapshot.input) === navigation.input && window.location.hash === navigation.sourceHash) writeNavigationRoute(navigation.destination, 'push')
      }
      const pending = confirm()
      if (hydration) hydration.confirmation = pending
      try { await pending } catch (error) {
        if (isCurrent() && hydration === saveSession.hydration) { saveSession.phase = 'recovery'; if (hydration) hydration.confirmation = undefined }
        throw error
      }
    },
  }
  const finishBuildImport = async (outcome: import('../workspace/owned-file-command').OwnedFileOutcome, command: import('../workspace/owned-file-command').OwnedFileCommand) => {
    if (!isCurrent()) throw new Error('The import owner was retired. Reopen its workspace to inspect the saved library.')
    buildInputSession.recovery = { outcome, command }
    if (outcome.status !== 'saved' || !outcome.receipt) {
      if (outcome.status === 'not-saved') { filePending.current = false; buildInputSession.phase = 'idle'; buildInputSession.recovery = undefined }
      else buildInputSession.phase = 'recovery'
      refreshBuildPhase(value => value + 1)
      throw outcome.error ?? new Error('The library import outcome is uncertain. Keep the Build input and retry.')
    }
    try {
      // Keep the original input owner until receipt, selected successor and strict form version all agree
      const completion = await resolveOwnedFileReceipt(outcome.receipt)
      command.assertMayActivate()
      await completion.assertCurrent()
      command.assertMayActivate()
      const view = buildInputSession.view
      if (!view) throw new Error('The Build form is no longer mounted')
      buildInputSession.view = buildInputSession.controller.transfer(view)
      const generation = ++version.current
      buildInputSession.phase = 'hydrating'
      buildInputSession.hydration = { completion, generation }
      currentRepository.current = completion.repository
      setRepository(completion.repository)
      if (selection.kind === 'guest') {
        const next: WorkspaceSelection = { kind: 'guest', generation }
        current.current = next; setSelection(next); setGuest(completion.repository)
      }
      setOwnedGeneration(generation); setSuccessorPending(false)
    } catch (reason) {
      if (isCurrent()) { buildInputSession.phase = 'recovery'; refreshBuildPhase(value => value + 1) }
      throw new Error(`The mod was saved to the library. Build reopening is pending; keep your input for recovery. ${reason instanceof Error ? reason.message : String(reason)}`)
    }
  }
  const buildActions: BuildInputActions = {
    buildInputSession,
    importBuildSource: async (preview, expected) => {
      if (filePending.current || !buildInputSession.view) throw new Error('Another file command is pending or the Build form is closed')
      const command = buildInputSession.controller.capture(buildInputSession.view, () => {
        if (!isCurrent() || draftPresence.current(buildInputSession.controller.owner)) throw new Error('The workspace or another open draft changed during mod import')
      })
      filePending.current = true; buildInputSession.phase = 'staging'; refreshBuildPhase(value => value + 1)
      const outcome = await importOwnedLibrarySource(repository, preview, command, expected)
      await finishBuildImport(outcome, command)
    },
    retryBuildImport: async () => {
      if (!isCurrent()) throw new Error('The Build recovery owner was retired')
      if (buildInputSession.hydration && buildInputSession.view) return buildActions.confirmBuildHydration(buildInputSession.view)
      const recovery = buildInputSession.recovery
      if (!recovery) throw new Error('There is no Build import awaiting reconciliation')
      const outcome = await reconcileOwnedFileOutcome(recovery.outcome)
      if (!isCurrent() || buildInputSession.recovery !== recovery) throw new Error('The Build recovery owner changed')
      await finishBuildImport(outcome, recovery.command)
    },
    confirmBuildHydration: async view => {
      const hydration = buildInputSession.hydration
      const guard = () => {
        buildInputSession.controller.assertView(view)
        if (!isCurrent() || draftPresence.current(buildInputSession.controller.owner) || hydration !== buildInputSession.hydration || hydration && hydration.generation !== version.current) throw new Error('The workspace changed during Build reopening')
      }
      guard()
      // StrictMode can confirm the same transferred view twice while its receipt check is pending
      // Share only that exact hydration's work; every caller and completion still checks its captured owner
      if (hydration?.confirmation) return hydration.confirmation
      const confirm = async () => {
        if (hydration) { await hydration.completion.assertCurrent(); guard() }
        buildInputSession.controller.hydrated(view)
        buildInputSession.hydration = undefined; buildInputSession.recovery = undefined; buildInputSession.phase = 'idle'
        filePending.current = false
        if (selection.kind === 'account' && hydration) requestSync(selection.token, 'quiet')
      }
      const pending = confirm()
      if (hydration) hydration.confirmation = pending
      try { await pending }
      catch (error) {
        if (hydration && buildInputSession.hydration === hydration) hydration.confirmation = undefined
        throw error
      }
    },
  }
  if (selection.kind === 'opening') return <LoadingScreen detail="Opening saved workspace..."/>
  if (selection.kind === 'locked') return <main className="panel"><h1>Account workspace locked</h1><p>Unlock your account to reopen its saved data.</p><AccountView onOpenWorkspace={openAccount} onContinueLocal={continueLocal} localCopy={localCopy}/></main>
  if (selection.kind === 'guest' && accountEntry) return <main className="panel"><AccountView onOpenWorkspace={openAccount} onContinueLocal={continueLocal} localCopy={localCopy}/></main>
  return <WorkspaceContext.Provider value={{ repository, localCopy, ...(selection.kind === 'account' ? { token: selection.token } : {}), openAccount, continueLocal, reopenGuest, reopenAccount, readReferenceRetry: () => { if (!isCurrent()) throw new Error('The Reference retry owner was retired'); return referenceRetry.current }, rememberReferenceRetry: value => { if (!isCurrent()) throw new Error('The Reference retry owner was retired'); referenceRetry.current = value && { ...value } }, readModLibraryResult: () => { if (!isCurrent()) throw new Error('The mod import result owner was retired'); return modLibraryResult.current && copyModLibraryResult(modLibraryResult.current) }, clearModLibraryResult: () => { if (!isCurrent()) throw new Error('The mod import result owner was retired'); modLibraryResult.current = undefined }, registerDraftPresence, flushSync, syncState, retrySync, ...editorActions, ...saveActions, ...buildActions }}>{selection.kind === 'guest' && successorPending && <section className="panel" role="alert"><h2>A newer local workspace is ready</h2><p>Your open draft is still attached to its original workspace. Export or discard it before reopening the selected workspace.</p><button onClick={() => window.dispatchEvent(new Event(GUEST_ACTIVATED_EVENT))}>Reopen selected workspace</button></section>}{selection.kind === 'guest' && <GuestRecoveryNotice repository={repository} canReplace={() => current.current === selection && current.current.kind === 'guest' && !draftPresence.current()}/>}<ErrorBoundary key={`${workspaceSelectionKey(selection)}:${ownedGeneration}`} recoveryDownload={() => downloadCapturedWorkspace(repository)}>{children}</ErrorBoundary></WorkspaceContext.Provider>
}
