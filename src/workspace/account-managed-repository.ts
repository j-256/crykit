import { exportAccountPlannerSnapshot } from './account-planner-export'
import { isImmutableCatalogSnapshot } from '../interchange/native'
import { IncrementalWorkspaceIntentSchema } from './account-mapping-origin'
import { requestSync } from '../account/sync/scheduler'
import { withAccountForeground } from '../account/background-work'
import { recordWorkspaceStartup, WORKSPACE_STARTUP_PHASE } from '../diagnostics/workspace-startup'
import { z } from 'zod'
import { type ConflictResolutionIntent } from './conflict-authority'
import { prepareWorkspaceImport, prepareWorkspaceModSetup } from './import-commands'
import { afterLocalCommand } from './planner-journal'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'
import { validateWorkspaceClosure } from './closure'
import { assertActiveProfile, registerProfileCleanup, type ProfileToken } from '../account/profile'
import { activateLocalAccountCommit, type AccountDatabase, type AccountFence } from '../persistence/account-database'
import { createAccountLocalStore } from './account-local-store'
import { admitLocalRoot, prepareLocalWorkspace, captureManagedPlannerInput, type AdmittedLocalSnapshot } from './local-root'
import { memoryBlob } from './blobs'
import { checkLocalEvidenceRoot } from './local-evidence'
import { readManagedSources, readManagedModSource } from './managed-planner-read'
import { registerWorkspaceCapture } from './snapshot'
import { captureManagedAccountSnapshot } from './account-managed-snapshot'
import { nowTimestamp, randomId } from '../interchange/util'
import { changedLocalDataWithSharedUnits, changedLocalData, historyEntry, validateLocalDataForStorage, previewImport, prepareModCatalogs } from '../persistence/local-data'
import { ownedFileReceipt, registerOwnedFileCommitter, reconcilableFileOutcome, type OwnedFileOutcome } from './owned-file-command'
import { WorkspaceError, type WorkspaceRepository } from './repository'
import { prepareManagedPlannerSave } from './managed-planner'
import { accountLocalId } from './account-cache'
import type { LocalData } from '../domain/types'
import type { LocalDataNotification } from '../interchange/types'
import type { WorkspaceState } from './documents'

export { IncrementalWorkspaceIntentSchema } from './account-mapping-origin'
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// An owned receipt creates a fresh wrapper for exactly its committed encrypted root
// Background projection is pending until its separately bound outbox operation is mapped
export async function openAccountManagedRepository(database: AccountDatabase, token: ProfileToken, fence: AccountFence): Promise<WorkspaceRepository> {
  recordWorkspaceStartup(WORKSPACE_STARTUP_PHASE.managed)
  const store = createAccountLocalStore(database, token)
  const check = async (captured: AccountFence) => {
    assertActiveProfile(token)
    if (!same(await database.profileMeta.get('active'), captured)) throw new Error('The managed account changed')
    assertActiveProfile(token)
  }
  const listeners = new Set<(event: LocalDataNotification) => void>()
  let channel: BroadcastChannel | undefined, observedFence = fence.headRevision
  let latestRemote: LocalDataNotification | undefined
  let pendingHint: Promise<void> | undefined
  const refreshHint = async () => {
    try {
      assertActiveProfile(token)
      const selected = await database.profileMeta.get('active')
      if (!selected || selected.headRevision <= observedFence) return
      const reader = createAccountLocalStore(database, token)
      try {
        const admitted = await admitLocalRoot(reader.adapter, selected.head, reader.lifetime)
        await check(selected)
        if (selected.headRevision <= observedFence) return
        observedFence = selected.headRevision
        latestRemote = { localDataId: admitted.state.planner.localData.id, revision: admitted.state.planner.localData.revision, reason: 'sync' }
        // An authenticated hint offers explicit reopening but never changes a captured wrapper's authority
        for (const listener of listeners) listener(latestRemote)
      } finally { await reader.dispose() }
    } catch { /* Hints confer no authority; explicit reopening surfaces integrity failures */ }
  }
  const hint = () => {
    if (pendingHint) return
    pendingHint = refreshHint().finally(() => { pendingHint = undefined })
  }
  const stopHints = () => {
    channel?.close(); channel = undefined
    if (typeof window !== 'undefined') window.removeEventListener('crykit-account-sync-applied', hint)
  }
  const unregister = registerProfileCleanup(token, () => { stopHints(); listeners.clear(); void store.dispose().finally(() => database.close()).catch(() => {}) })
  try {
    await check(fence)
    const initial = await admitLocalRoot(store.adapter, fence.head, store.lifetime)
    recordWorkspaceStartup(WORKSPACE_STARTUP_PHASE.root)
    await checkLocalEvidenceRoot(store.adapter, initial.root.inheritedEvidence, () => check(fence))
    recordWorkspaceStartup(WORKSPACE_STARTUP_PHASE.evidence)
    await check(fence); store.finishAdmission()
    return wrapper(initial, fence)
  } catch (error) { unregister(); await store.dispose(); database.close(); throw error }
  async function publish(operationId: string, prepared: Awaited<ReturnType<typeof prepareLocalWorkspace>>, before: AdmittedLocalSnapshot, captured: AccountFence, assertMayActivate: () => void, operation: z.infer<typeof IncrementalWorkspaceIntentSchema>['operation'] = 'workspace-command', mode: 'additive' | 'replace' = 'additive', conflictResolution?: ConflictResolutionIntent) {
    assertMayActivate()
    const projection = await database.syncState.get('projection')
    assertMayActivate()
    const intent = IncrementalWorkspaceIntentSchema.parse({ version: 1, kind: 'incremental-workspace-intent', operationId, operation, mode, ...(conflictResolution ? { conflictResolution } : {}), sequence: captured.headRevision + 1, before: captured.head, after: prepared.head, ...(projection ? { publicationBase: projection.ref } : {}) })
    const encoded = new TextEncoder().encode(JSON.stringify(intent))
    let intentRef
    try { intentRef = await store.adapter.stage(operationId, memoryBlob(encoded), [captured.head, prepared.head, ...(projection ? [projection.ref] : []), ...(conflictResolution ? [conflictResolution.conflict, conflictResolution.local, conflictResolution.remote] : [])]) }
    finally { encoded.fill(0) }
    assertMayActivate()
    const activation = await store.prepareActivation(operationId, prepared, captured, before, intentRef, projection)
    const target = await activateLocalAccountCommit(database, token, activation, assertMayActivate)
    store.committed(operationId)
    observedFence = target.headRevision; latestRemote = undefined
    channel?.postMessage({ headRevision: target.headRevision })
    requestSync(token, 'quiet')
    return target
  }
  function wrapper(snapshot: AdmittedLocalSnapshot, captured: AccountFence): WorkspaceRepository {
    let retired = false
    const assertCurrent = async () => {
      assertActiveProfile(token)
      if (retired) throw new Error('The managed account repository is retired')
      await check(captured)
      // An owned receipt can retire this wrapper while its captured fence read is pending
      if (retired) throw new Error('The managed account repository is retired')
    }
    const loaded = () => { const { localData, catalogs, lineage, evidence } = snapshot.state.planner; return { localData, catalogs, lineage, evidence, revision: localData.revision, canUndo: snapshot.state.planner.journal?.undoable ?? false } }
    const plannerSave = async (proposed: LocalData, expectedRevision: number, reason: 'save' | 'undo' = 'save') => withAccountForeground(token, async () => {
      const input = captureManagedPlannerInput(proposed), before = snapshot, expected = captured
      const assertOwned = () => {
        assertActiveProfile(token)
        if (retired || snapshot !== before || captured !== expected) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'The captured account workspace changed. Keep your draft and reload.')
      }
      await assertCurrent(); assertOwned()
      if (expectedRevision !== before.state.planner.localData.revision) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'The account workspace changed. Keep your draft and reload.')
      const planner = await prepareManagedPlannerSave(before.state.planner, input, before.destinationChanges)
      assertOwned()
      const operationId = accountLocalId(), prepared = await prepareLocalWorkspace(store.adapter, operationId, { ...before.state, planner }, store.lifetime, before)
      const target = await publish(operationId, prepared, before, expected, assertOwned, reason)
      await check(target); assertOwned()
      // A planner queue keeps its wrapper but each command captures the new exact encrypted fence
      // Background mapping may consume the immutable intent without replacing this foreground view
      snapshot = prepared.snapshot; captured = target
      for (const listener of listeners) listener({ localDataId: planner.localData.id, revision: planner.localData.revision, reason })
      return loaded()
    })
    const bulkCommit = async (before: AdmittedLocalSnapshot, expected: AccountFence, input: WorkspaceState, revision: number, operation: 'workspace-command' | 'import' | 'mod-setup', mode: 'additive' | 'replace', conflictResolution?: ConflictResolutionIntent) => withAccountForeground(token, async () => {
      const assertOwned = () => { assertActiveProfile(token); if (retired || snapshot !== before || captured !== expected) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'The account workspace changed. Keep your draft and reload.') }
      await assertCurrent(); assertOwned()
      if (revision !== before.state.planner.localData.revision) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'The account workspace changed. Keep your draft and reload.')
      // Bulk import retains the established native command and exact historical merge semantics
      // Its complete byte admission is separate from ordinary saves and never certifies cached bodies
      const timestamp = nowTimestamp(), localData = changedLocalData(before.state.planner.localData, input.planner.localData, 'workspace-command', timestamp)
      const catalogs = await prepareModCatalogs(localData, input.planner.catalogs)
      validateLocalDataForStorage(localData, catalogs)
      const history = new Map(before.state.planner.history.map(value => [value.id, value]))
      for (const entry of input.planner.history) {
        if (history.has(entry.id) && !guestPlannerValuesEqual(history.get(entry.id), entry)) throw new Error('Historical planner identity conflicts')
        history.set(entry.id, entry)
      }
      const entry = historyEntry(before.state.planner.localData, localData, 'workspace-command', timestamp)
      history.set(entry.id, entry)
      const operative = { ...before.state.planner, journal: before.state.planner.journal ?? { version: 1 as const, changes: before.state.planner.localData.changes, checkpoints: [], undoable: false } }
      const state = { ...input, planner: afterLocalCommand(operative, { ...input.planner, localData, catalogs, history: [...history.values()] }, entry) }
      await validateWorkspaceClosure(state); assertOwned()
      const current = await admitLocalRoot(store.adapter, expected.head, { check: assertOwned, assertCurrent })
      assertBulkMetadata(before.state, current.state)
      const operationId = accountLocalId(), prepared = await prepareLocalWorkspace(store.adapter, operationId, state, store.lifetime, before)
      const admitted = await admitLocalRoot(store.adapter, prepared.head, { check: assertOwned, assertCurrent })
      assertBulkMetadata(prepared.snapshot.state, admitted.state)
      await assertCurrent(); assertOwned()
      const target = await publish(operationId, prepared, before, expected, assertOwned, operation, mode, conflictResolution)
      await check(target); assertOwned()
      snapshot = prepared.snapshot; captured = target
      for (const listener of listeners) listener({ localDataId: localData.id, revision: localData.revision, reason: 'save' })
      return loaded()
    })
    const repository: WorkspaceRepository = {
      kind: 'account', readWorkspace: async () => { await assertCurrent(); return snapshot.state }, load: async () => { await assertCurrent(); return loaded() },
      commitWorkspace: (state, revision, options) => bulkCommit(snapshot, captured, captureBulkInput(state), revision, 'workspace-command', 'additive', options?.conflictResolution && structuredClone(options.conflictResolution)), save: plannerSave, undo: async expectedRevision => {
        const latest = snapshot.state.planner.journal?.undoable && snapshot.state.planner.journal.checkpoints.at(-1)
        if (!latest) throw new Error('There is no saved change to undo')
        return plannerSave(changedLocalDataWithSharedUnits(snapshot.state.planner.localData, latest.before, `undo:${latest.command}`, nowTimestamp()), expectedRevision, 'undo')
      }, previewImport, prepareModCatalogs,
      commitImport: async (preview, options = {}) => {
        const input = structuredClone(preview), intent = structuredClone(options), before = snapshot, expected = captured
        await assertCurrent()
        const prepared = await prepareWorkspaceImport(before.state, input, intent)
        return bulkCommit(before, expected, prepared.state, before.state.planner.localData.revision, 'import', prepared.mode)
      },
      commitModSetup: async (previews, revision, skip) => {
        const inputs = structuredClone(previews), before = snapshot, expected = captured
        await assertCurrent()
        return bulkCommit(before, expected, await prepareWorkspaceModSetup(before.state, inputs, revision, skip), revision, 'mod-setup', 'additive')
      },
      readModSource: async pin => { await assertCurrent(); return readManagedModSource(snapshot.state, pin, assertCurrent) },
      readSources: async () => { await assertCurrent(); return readManagedSources(snapshot.state, assertCurrent) },
      exportPlannerBackup: async override => {
        const draft = override && structuredClone(override), expected = captured, identity = snapshot.state.planner.localData.id
        // Explicit recovery export may read this exact retired root, but never retargets to a successor
        // Ordinary backups retain the current-head guard; both keep the original captured profile lifetime
        const alive = async () => { assertActiveProfile(token); if (!draft) await assertCurrent(); assertActiveProfile(token) }
        await alive()
        const reader = createAccountLocalStore(database, token)
        let bytes: Uint8Array | undefined
        let sources: Awaited<ReturnType<typeof readManagedSources>> = []
        try {
          const fresh = await admitLocalRoot(reader.adapter, expected.head, { check: () => assertActiveProfile(token), assertCurrent: alive })
          if (fresh.state.planner.localData.id !== identity) throw new Error('Captured account planner identity changed')
          sources = await readManagedSources(fresh.state, alive)
          bytes = await exportAccountPlannerSnapshot(fresh.state.planner, sources, draft)
          await alive(); return bytes
        } catch (error) { bytes?.fill(0); throw error }
        finally { for (const source of sources) source.bytes.fill(0); await reader.dispose() }
      },
      readHistory: async () => { await assertCurrent(); return snapshot.state.planner.history }, subscribe: listener => {
        listeners.add(listener)
        if (listeners.size === 1) {
          if (typeof BroadcastChannel !== 'undefined') { channel = new BroadcastChannel(`crykit-account-${token.accountId}`); channel.addEventListener('message', hint) }
          if (typeof window !== 'undefined') window.addEventListener('crykit-account-sync-applied', hint)
        }
        if (latestRemote) listener(latestRemote)
        hint()
        return () => { listeners.delete(listener); if (!listeners.size) stopHints() }
      },
    }
    registerWorkspaceCapture(repository, async () => { await assertCurrent(); return captureManagedAccountSnapshot(database, token, captured) })
    registerOwnedFileCommitter(repository, async (before, next, command) => withAccountForeground(token, async () => {
      const prior = snapshot, predecessor = captured
      let prepared: Awaited<ReturnType<typeof prepareLocalWorkspace>> | undefined, failure: unknown
      try {
        await assertCurrent(); command.assertMayActivate()
        if (before !== snapshot.state) throw new Error('File input is not the admitted encrypted head')
        const timestamp = nowTimestamp()
        const localData = changedLocalDataWithSharedUnits(before.planner.localData, next.planner.localData, command.operation, timestamp)
        const checkpoint = { id: randomId('history'), localDataId: localData.id, command: command.operation, previousRevision: before.planner.localData.revision, nextRevision: localData.revision, before: before.planner.localData, after: localData, recordedAt: timestamp }
        const result: WorkspaceState = { ...next, planner: { ...next.planner, localData, history: [...before.planner.history, checkpoint], savedChanges: [...(before.planner.savedChanges ?? before.planner.localData.changes), localData.changes.at(-1)!], journal: { version: 1, changes: localData.changes, checkpoints: [...(before.planner.journal?.checkpoints ?? []), checkpoint], undoable: true } } }
        prepared = await prepareLocalWorkspace(store.adapter, command.id, result, store.lifetime, prior)
        await publish(command.id, prepared, prior, predecessor, () => {
          assertActiveProfile(token); command.assertMayActivate()
          if (retired || snapshot !== prior || captured !== predecessor || before !== prior.state) throw new Error('The captured encrypted file workspace changed')
        })
      } catch (error) { failure = error }
      let successor: WorkspaceRepository | undefined
      const reconcile = async (): Promise<OwnedFileOutcome> => {
        try {
          assertActiveProfile(token)
          const receipt = await database.migrationJournal.get(command.id)
          if (!receipt || !prepared) return { status: 'not-saved', error: failure ?? new Error('Managed encrypted command did not activate') }
          if (!same(receipt.head, prepared.head) || receipt.headRevision !== predecessor.headRevision + 1) throw new Error('Managed encrypted receipt identity mismatch')
          const target: AccountFence = { key: 'active', headRevision: receipt.headRevision, head: receipt.head }
          const assertSaved = async () => { await check(target); if (!same(await database.migrationJournal.get(command.id), receipt)) throw new Error('Managed encrypted receipt changed'); assertActiveProfile(token) }
          await assertSaved()
          return { status: 'saved', receipt: ownedFileReceipt(command, async () => withAccountForeground(token, async () => {
            command.assertMayActivate(); await assertSaved()
            successor ??= wrapper(prepared!.snapshot, target); retired = true
            return { repository: successor, state: prepared!.snapshot.state, assertCurrent: assertSaved }
          }), async () => { await assertSaved(); await admitLocalRoot(store.adapter, target.head, store.lifetime); await assertSaved() }) }
        } catch (error) { return reconcilableFileOutcome({ status: 'uncertain', error }, reconcile) }
      }
      return reconcile()
    }))
    return repository
  }
}

function captureBulkInput(state: WorkspaceState): WorkspaceState {
  // Capture mutable metadata before yielding; only format-owned deeply immutable catalogs retain admission identity
  // Exact lazy body capabilities still pass complete digest validation and durable staging
  const catalogs = state.planner.catalogs.map(catalog => isImmutableCatalogSnapshot(catalog) ? catalog : structuredClone(catalog))
  const metadata = structuredClone({ ...state, planner: { ...state.planner, catalogs: [] }, blobs: state.blobs.map(value => value.ref) })
  return { ...metadata, planner: { ...metadata.planner, catalogs }, blobs: state.blobs.map((value, index) => ({ ref: metadata.blobs[index], content: { byteLength: value.content.byteLength, open: value.content.open.bind(value.content) } })) }
}
function assertBulkMetadata(expected: WorkspaceState, actual: WorkspaceState) {
  // Complete body validation owns bytes; function identity is not native persisted metadata
  const metadata = (state: WorkspaceState) => ({ ...state, blobs: state.blobs.map(value => value.ref) })
  if (!guestPlannerValuesEqual(metadata(expected), metadata(actual))) throw new Error('The staged encrypted workspace differs from its complete input')
}
