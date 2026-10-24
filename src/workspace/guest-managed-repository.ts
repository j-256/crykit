import { GuestManagedRecoverySelectionSchema } from './guest-managed-contract'
import Dexie from 'dexie'
import { asAppDataError } from '../interchange/errors'
import { isImmutableCatalogSnapshot } from '../interchange/native'
import { captureManagedRecovery, inspectManagedRecovery, exportManagedRecovery, prepareManagedRecoveryCopy, withManagedRecoverySource, type ManagedRecoveryCapture } from './guest-managed-recovery'
import type { LegacyExportSink } from './guest-recovery'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'
import { prepareWorkspaceImport, prepareWorkspaceModSetup } from './import-commands'
import { prepareGuestRestorePlanner, requirePreparedGuestPlanner } from './guest-planner'
import { managedGuestPlannerTuple } from './managed-guest-planner'
import { validateWorkspaceClosure } from './closure'
import { blobIdentity } from './blobs'
import { GUEST_ACTIVATED_EVENT } from './guest-workspace'
import { readManagedSources, readManagedModSource } from './managed-planner-read'
import { createGuestManagedMonitor, type GuestManagedMonitor, type GuestMonitorState } from './guest-managed-monitor'
import type { GuestRecoveryNotice } from './guest-recovery'
import { registerWorkspaceCapture, ownWorkspaceSnapshot, projectWorkspaceSnapshotV1, type WorkspaceSnapshotV2 } from './snapshot'
import { captureManagedGuestSnapshot } from './guest-managed-snapshot'
import { readLocalEvidence, prepareLocalEvidence } from './local-evidence'
import { validateGuestCurrentBodies, compareGuestEvidence, guestEvidenceFromSnapshot, guestEvidenceFromFrozenCurrent, mergeGuestEvidence, emptyPlannerEvidence } from './guest-evidence'
import type { GuestCoordinatorDatabase } from './guest-coordinator'
import { createGuestLocalStore, GuestManagedManifestSchema, type GuestManagedManifest } from './guest-local-store'
import { admitLocalRoot, prepareLocalWorkspace, captureManagedPlannerInput, type AdmittedLocalSnapshot, type CapturedLocalLifetime } from './local-root'
import { nowTimestamp, randomId } from '../interchange/util'
import { captureProfileEpoch } from '../account/profile'
import { WorkspaceError, type WorkspaceRepository } from './repository'
import { prepareManagedPlannerSave } from './managed-planner'
import type { LocalDataNotification } from '../interchange/types'
import type { LocalData } from '../domain/types'
import type { WorkspaceState } from './documents'
import { changedLocalDataWithSharedUnits, previewImport, prepareModCatalogs, subscribeLocalData, exportPlannerSnapshot } from '../persistence/local-data'
import { ownedFileReceipt, registerOwnedFileCommitter, reconcilableFileOutcome, type OwnedFileOutcome } from './owned-file-command'

const MANAGED_HEAD_CHANNEL = 'crykit-managed-guest-head'
const managed = new WeakMap<WorkspaceRepository, { assertCurrent(): Promise<void>; monitor: GuestManagedMonitor; stageRestore(input: WorkspaceSnapshotV2, expected: GuestManagedManifest, operationId: string, checkInput: () => Promise<void>): Promise<{ activate(assertMayActivate: () => void): Promise<GuestManagedManifest> }>; selection(): { coordinator: GuestCoordinatorDatabase; manifest: GuestManagedManifest; assertProfile(): void }; copy(notice: GuestRecoveryNotice, canReplace: () => boolean): Promise<void>; recovery(notice: GuestRecoveryNotice): Promise<ManagedRecoveryCapture> }>()
// Selection hints may inspect a retired wrapper, but retain its construction-time profile lifetime
// They never grant read/write authority to the successor named by the active pointer
export function managedGuestSelection(repository: WorkspaceRepository) { return managed.get(repository)?.selection() }
export async function stageManagedGuestWorkspaceRestore(repository: WorkspaceRepository, input: WorkspaceSnapshotV2, expected: GuestManagedManifest, operationId: string, checkInput: () => Promise<void>) {
  const captured = managed.get(repository)
  if (!captured) throw new Error('A captured managed guest is required')
  return captured.stageRestore(input, expected, operationId, checkInput)
}
export async function checkManagedGuestRecovery(repository: WorkspaceRepository): Promise<boolean> {
  const check = managed.get(repository)
  if (!check) return false
  await check.assertCurrent(); return true
}
export async function observeManagedGuestRecovery(repository: WorkspaceRepository, listener: (state: GuestMonitorState) => void): Promise<(() => void) | undefined> {
  const captured = managed.get(repository)
  if (!captured) return undefined
  await captured.assertCurrent()
  return captured.monitor.observe(listener)
}
export async function managedGuestRecoveryNotices(repository: WorkspaceRepository, signal?: AbortSignal): Promise<readonly GuestRecoveryNotice[] | undefined> {
  const captured = managed.get(repository)
  if (!captured) return undefined
  await captured.assertCurrent()
  const notices = await captured.monitor.compare(signal)
  await captured.assertCurrent()
  return notices
}
export async function inspectManagedGuestRecovery(repository: WorkspaceRepository, notice: GuestRecoveryNotice) {
  const captured = managed.get(repository)
  return captured ? inspectManagedRecovery(await captured.recovery(notice)) : undefined
}
export async function exportManagedGuestRecovery(repository: WorkspaceRepository, notice: GuestRecoveryNotice, sink: LegacyExportSink): Promise<boolean> {
  const captured = managed.get(repository)
  if (!captured) return false
  await exportManagedRecovery(await captured.recovery(notice), sink)
  return true
}
export async function copyManagedGuestRecovery(repository: WorkspaceRepository, notice: GuestRecoveryNotice, canReplace: () => boolean): Promise<boolean> {
  const captured = managed.get(repository)
  if (!captured) return false
  await captured.copy(notice, canReplace)
  return true
}
// The managed entrypoint is connected only after legacy preparation has produced a selected v3 head
// Each wrapper captures one head; only an owned receipt constructs a wrapper for its exact successor
export async function openGuestManagedRepository(database: GuestCoordinatorDatabase, manifest: GuestManagedManifest): Promise<WorkspaceRepository> {
  const profile = captureProfileEpoch(), store = createGuestLocalStore(database, profile.assertCurrent)
  const lifetime: CapturedLocalLifetime = { check: profile.assertCurrent, assertCurrent: async () => profile.assertCurrent() }
  await store.assertCurrent(manifest)
  let unsubscribe = () => {}
  const monitor = createGuestManagedMonitor(database.name, manifest, () => unsubscribe())
  // Admission is bulk preparation; ordinary commands only check this captured monitor's readiness
  // A complete divergent result still permits inspecting the selected data, but cannot authorize a write
  const assertMayWrite = () => { profile.assertCurrent(); monitor.assertReady() }
  try {
    await monitor.compare(profile.signal)
    unsubscribe = subscribeLocalData(() => monitor.notifyStorageChange())
    const initial = await admitLocalRoot(store.adapter, manifest.root, lifetime)
    // Admission still validates the complete archive; bounded reads authenticate both digests in one native window
    const evidence = await readLocalEvidence(store.adapter, initial.root.inheritedEvidence, async () => profile.assertCurrent(), (ref, limit, digest) => store.readBounded(ref, limit, manifest, profile.assertCurrent, digest))
    if (evidence) await validateGuestCurrentBodies(initial.state, evidence)
    await store.assertCurrent(manifest)
    store.finishAdmission()
    return wrapper(initial, manifest)
  } catch (error) { monitor.dispose(); throw error }
  function wrapper(snapshot: AdmittedLocalSnapshot, captured: GuestManagedManifest): WorkspaceRepository {
    let retired = false
    let pendingPlannerSaves = 0
    const assertCurrent = async () => {
      profile.assertCurrent(); if (retired) throw new Error('The managed repository is retired')
      const expected = captured
      // A delayed check can fail after this wrapper adopts its own receipt or transfers the monitor to a successor
      // Reject that read, but only the wrapper that still owns the checked head may release the shared monitor
      try { await store.assertCurrent(expected) } catch (error) { if (!retired && captured === expected && pendingPlannerSaves === 0) monitor.dispose(); throw error }
    }
    const loaded = () => { const { localData, catalogs, lineage, evidence } = snapshot.state.planner; return { localData, catalogs, lineage, evidence, revision: localData.revision, canUndo: snapshot.state.planner.journal?.undoable ?? false } }
    const listeners = new Set<(event: LocalDataNotification) => void>()
    let hintChannel: BroadcastChannel | undefined, pendingHint: Promise<void> | undefined
    let observedHead = JSON.stringify(captured)
    const channelName = `${MANAGED_HEAD_CHANNEL}:${database.name}`
    const stopHints = () => { hintChannel?.close(); hintChannel = undefined; profile.signal.removeEventListener('abort', stopHints) }
    const refreshHint = async () => {
      try {
        profile.assertCurrent()
        const row = await database.active.get('active')
        profile.assertCurrent()
        if (!row || !listeners.size) return
        const selected = GuestManagedManifestSchema.parse(row.manifest), identity = JSON.stringify(selected)
        if (identity === observedHead) return
        observedHead = identity
        // The actual selected pointer only offers reopening; this wrapper and its planner values stay captured
        // Do not send this through retained-source monitoring or bulk automatic-adoption notifications
        const localData = snapshot.state.planner.localData
        for (const listener of listeners) listener({ localDataId: localData.id, revision: localData.revision, reason: 'sync' })
      } catch { /* Explicit reopening reports damaged or unavailable selected data */ }
    }
    const hint = () => { pendingHint ??= refreshHint().finally(() => { pendingHint = undefined }) }
    const publishHint = () => {
      if (typeof BroadcastChannel === 'undefined') return
      try {
        const channel = hintChannel ?? new BroadcastChannel(channelName)
        try { channel.postMessage({ version: 1 }) } finally { if (channel !== hintChannel) channel.close() }
      } catch { /* A notification failure cannot undo an already durable command */ }
    }
    const plannerSave = async (proposed: LocalData, expectedRevision: number, reason: 'save' | 'undo' = 'save') => {
      // Capture changed caller-owned branches before the first await; unchanged admitted units are immutable
      const input = captureManagedPlannerInput(proposed), before = snapshot, expected = captured
      pendingPlannerSaves++
      try {
        await assertCurrent(); assertMayWrite()
        if (expectedRevision !== before.state.planner.localData.revision || snapshot !== before) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'The local workspace changed. Keep your draft and reload.')
        const planner = await prepareManagedPlannerSave(before.state.planner, input, before.destinationChanges)
        const operationId = crypto.randomUUID()
        const prepared = await prepareLocalWorkspace(store.adapter, operationId, { ...before.state, planner }, lifetime, before)
        const receipt = await store.activate(operationId, prepared.head, expected, assertMayWrite, before)
        await store.assertCurrent(receipt.target)
        // Planner queues retain their stable wrapper, but every next command captures the new exact revision
        // File callbacks still capture their input state and use the owned retirement/remount path
        snapshot = prepared.snapshot; captured = receipt.target
        observedHead = JSON.stringify(captured); publishHint()
        for (const listener of listeners) listener({ localDataId: planner.localData.id, revision: planner.localData.revision, reason })
        return { localData: snapshot.state.planner.localData, canUndo: true }
      } catch (error) {
        // One storage error reaches both action and global recovery UI with the same diagnostic
        // Domain, profile and ownership guards retain their own errors and recovery instructions
        if (!(error instanceof Dexie.DexieError) && !(error instanceof DOMException)) throw error
        throw asAppDataError(error, { code: 'storage-failure', userMessage: 'Saving the planner change could not be confirmed. Keep your draft and retry', recoverable: true })
      } finally { pendingPlannerSaves-- }
    }
    const bulkCommit = async (before: AdmittedLocalSnapshot, expected: GuestManagedManifest, next: WorkspaceState, expectedRevision: number, mode: 'additive' | 'replace') => {
      await assertCurrent(); assertMayWrite()
      if (snapshot !== before || captured !== expected || expectedRevision !== before.state.planner.localData.revision) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'The local workspace changed. Keep your draft and reload.')
      if ((await monitor.compare(profile.signal)).length) throw new Error('Retained local data needs recovery before import')
      await assertCurrent(); assertMayWrite()
      // Bulk commands verify the actual old root and the complete staged successor independently
      // Ordinary saves retain their admitted view path and never pay this whole-workspace preparation cost
      const planner = before.state.planner
      const operative = { ...planner, journal: planner.journal ?? { version: 1 as const, changes: planner.localData.changes, checkpoints: [], undoable: false } }
      const projection = requirePreparedGuestPlanner(prepareGuestRestorePlanner(operative, next.planner, mode, managedGuestPlannerTuple(before), 'workspace-command'))
      const sources = new Set(projection.planner.sources.map(value => blobIdentity(value.original)))
      const blobs = new Map(next.blobs.map(value => [blobIdentity(value.ref), value]))
      for (const body of before.state.blobs) if (sources.has(blobIdentity(body.ref)) && !blobs.has(blobIdentity(body.ref))) blobs.set(blobIdentity(body.ref), body)
      const state = { ...next, planner: projection.planner, blobs: [...blobs.values()] }
      await validateWorkspaceClosure(state)
      const current = await admitLocalRoot(store.adapter, expected.root, lifetime)
      assertBulkMetadata(before.state, current.state)
      const operationId = crypto.randomUUID()
      const prepared = await prepareLocalWorkspace(store.adapter, operationId, state, lifetime, before, undefined, projection.record.operativePlanner.savedDestinationChanges)
      await store.flush(operationId)
      const reader = createGuestLocalStore(database, profile.assertCurrent)
      const reopened = await admitLocalRoot(reader.adapter, prepared.head, lifetime)
      assertBulkMetadata(prepared.snapshot.state, reopened.state)
      await assertCurrent(); assertMayWrite()
      const receipt = await store.activate(operationId, prepared.head, expected, assertMayWrite, before)
      await store.assertCurrent(receipt.target)
      retired = true; monitor.dispose()
      // A bulk successor invalidates old callbacks; the existing activation notice only asks UI to reopen
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(GUEST_ACTIVATED_EVENT))
      if (typeof BroadcastChannel !== 'undefined') { const channel = new BroadcastChannel(GUEST_ACTIVATED_EVENT); channel.postMessage({ version: 1 }); channel.close() }
      const { localData, catalogs, lineage, evidence } = reopened.state.planner
      return { localData, catalogs, lineage, evidence, revision: localData.revision, canUndo: reopened.state.planner.journal?.undoable ?? false }
    }
    const repository: WorkspaceRepository = {
      kind: 'guest',
      readWorkspace: async () => { await assertCurrent(); return snapshot.state },
      load: async () => { await assertCurrent(); return loaded() },
      commitWorkspace: (next, revision) => bulkCommit(snapshot, captured, captureBulkInput(next), revision, 'additive'), save: plannerSave, undo: async expectedRevision => {
        const latest = snapshot.state.planner.journal?.undoable && snapshot.state.planner.journal.checkpoints.at(-1)
        if (!latest) throw new Error('There is no saved change to undo')
        const restored = changedLocalDataWithSharedUnits(snapshot.state.planner.localData, latest.before, `undo:${latest.command}`, nowTimestamp())
        return plannerSave(restored, expectedRevision, 'undo')
      },
      previewImport, prepareModCatalogs,
      commitImport: async (preview, options = {}) => {
        const input = structuredClone(preview), intent = structuredClone(options), before = snapshot, expected = captured
        await assertCurrent(); assertMayWrite()
        const prepared = await prepareWorkspaceImport(before.state, input, intent)
        return bulkCommit(before, expected, prepared.state, before.state.planner.localData.revision, prepared.mode)
      },
      commitModSetup: async (previews, revision, skip) => {
        const inputs = structuredClone(previews), before = snapshot, expected = captured
        await assertCurrent(); assertMayWrite()
        return bulkCommit(before, expected, await prepareWorkspaceModSetup(before.state, inputs, revision, skip), revision, 'additive')
      },
      readModSource: async pin => { await assertCurrent(); return readManagedModSource(snapshot.state, pin, assertCurrent) },
      readSources: async () => { await assertCurrent(); return readManagedSources(snapshot.state, assertCurrent) },
      exportPlannerBackup: async override => {
        const draft = override && structuredClone(override), capturedSnapshot = snapshot, capturedHead = captured
        // Explicit inert draft export retains this owner's exact root, even after its owned successor retires it
        // No current lookup, migration or selection grants the retired wrapper write authority
        const check = async () => { profile.assertCurrent(); if (!draft) { await assertCurrent(); monitor.assertReady() } profile.assertCurrent() }
        profile.assertCurrent(); if (!draft) await assertCurrent()
        if (!draft && (await monitor.compare(profile.signal)).length) throw new Error('Retained local data needs recovery before backup')
        const reader = createGuestLocalStore(database, profile.assertCurrent)
        const fresh = await admitLocalRoot(reader.adapter, capturedHead.root, { check: profile.assertCurrent, assertCurrent: check })
        if (fresh.state.planner.localData.id !== capturedSnapshot.state.planner.localData.id) throw new Error('Captured planner identity changed')
        const sources = await readManagedSources(fresh.state, check)
        let bytes: Uint8Array | undefined
        try {
          bytes = await exportPlannerSnapshot(fresh.state.planner, sources, draft)
          await check(); return bytes
        } catch (error) { bytes?.fill(0); throw error }
        finally { for (const source of sources) source.bytes.fill(0) }
      },
      readHistory: async () => { await assertCurrent(); return snapshot.state.planner.history },
      subscribe: listener => {
        profile.assertCurrent()
        listeners.add(listener)
        if (listeners.size === 1) {
          if (typeof BroadcastChannel !== 'undefined') { hintChannel = new BroadcastChannel(channelName); hintChannel.addEventListener('message', hint) }
          profile.signal.addEventListener('abort', stopHints, { once: true })
        }
        hint()
        return () => { listeners.delete(listener); if (!listeners.size) stopHints() }
      },
    }
    managed.set(repository, { assertCurrent, monitor, stageRestore: async (input, expected, operationId, checkInput) => {
      const before = snapshot
      const assertCaptured = () => { assertMayWrite(); if (retired || snapshot !== before || !guestPlannerValuesEqual(captured, expected)) throw new Error('The selected restore workspace changed') }
      const check = async () => { assertCaptured(); await checkInput(); await assertCurrent(); assertCaptured() }
      await check()
      if ((await monitor.compare(profile.signal)).length) throw new Error('Retained local data needs recovery before restore')
      await check()
      const current = await admitLocalRoot(store.adapter, expected.root, { check: assertCaptured, assertCurrent: check })
      assertBulkMetadata(before.state, current.state)
      const planner = current.state.planner
      const operative = { ...planner, journal: planner.journal ?? { version: 1 as const, changes: planner.localData.changes, checkpoints: [], undoable: false } }
      const projection = requirePreparedGuestPlanner(prepareGuestRestorePlanner(operative, input.state.planner, 'replace', managedGuestPlannerTuple(current)))
      const sourceRefs = new Set(projection.planner.sources.map(value => blobIdentity(value.original)))
      const bodies = new Map(input.state.blobs.map(value => [blobIdentity(value.ref), value]))
      for (const body of current.state.blobs) if (sourceRefs.has(blobIdentity(body.ref)) && !bodies.has(blobIdentity(body.ref))) bodies.set(blobIdentity(body.ref), body)
      const state = { ...input.state, planner: projection.planner, blobs: [...bodies.values()] }
      await validateWorkspaceClosure(state)
      const inherited = await readLocalEvidence(store.adapter, current.root.inheritedEvidence, check)
      const incoming = await guestEvidenceFromSnapshot(input, emptyPlannerEvidence())
      const incomingCurrent = await guestEvidenceFromFrozenCurrent(ownWorkspaceSnapshot(projectWorkspaceSnapshotV1(input), { check: checkInput, dispose: async () => {} }))
      const original = ownWorkspaceSnapshot({ version: 1, snapshotId: `${operationId}-selected`, capturedAt: new Date().toISOString(), revisionVector: { guest: expected.id, root: JSON.stringify(expected.root) }, state: current.state }, { check, dispose: async () => {} })
      const selected = await guestEvidenceFromFrozenCurrent(original)
      const plannerEvidence = { ...emptyPlannerEvidence(), savedChanges: projection.planner.savedChanges ?? projection.planner.localData.changes }
      // Replacement removes active files, never their original bytes or the complete pre-restore graph
      let evidence = await mergeGuestEvidence(inherited ?? selected, incoming, plannerEvidence)
      evidence = await mergeGuestEvidence(evidence, selected, plannerEvidence)
      evidence = await mergeGuestEvidence(evidence, incomingCurrent, plannerEvidence)
      await validateGuestCurrentBodies(state, evidence)
      const evidenceRef = await prepareLocalEvidence(store.adapter, operationId, evidence)
      const prepared = await prepareLocalWorkspace(store.adapter, operationId, state, { check: assertCaptured, assertCurrent: check }, undefined, evidenceRef, projection.record.operativePlanner.savedDestinationChanges)
      await store.flush(operationId)
      const reader = createGuestLocalStore(database, assertCaptured)
      const reopened = await admitLocalRoot(reader.adapter, prepared.head, { check: assertCaptured, assertCurrent: check })
      assertBulkMetadata(prepared.snapshot.state, reopened.state)
      await compareGuestEvidence(evidence, (await readLocalEvidence(reader.adapter, evidenceRef, check, (ref, limit, digest) => reader.readBounded(ref, limit, expected, assertCaptured, digest)))!)
      await check()
      return { async activate(assertMayActivate) {
        await check(); assertMayActivate()
        if ((await monitor.compare(profile.signal)).length) throw new Error('Retained local data needs recovery before restore')
        await check(); assertMayActivate()
        const receipt = await store.activate(operationId, prepared.head, expected, () => { assertCaptured(); assertMayActivate() }, current)
        await store.assertCurrent(receipt.target)
        retired = true; monitor.dispose()
        if (typeof window !== 'undefined') window.dispatchEvent(new Event(GUEST_ACTIVATED_EVENT))
        if (typeof BroadcastChannel !== 'undefined') { const channel = new BroadcastChannel(GUEST_ACTIVATED_EVENT); channel.postMessage({ version: 1 }); channel.close() }
        return receipt.target
      } }
    }, selection: () => { profile.assertCurrent(); return { coordinator: database, manifest: captured, assertProfile: profile.assertCurrent } }, copy: async (notice, canReplace) => {
      const before = snapshot, expected = captured
      const assertReplace = () => { profile.assertCurrent(); if (retired || !canReplace()) throw new Error('Keep or export your open draft before copying retained data') }
      const assertCaptured = () => { assertReplace(); if (captured !== expected || snapshot !== before) throw new Error('The managed workspace changed') }
      const check = async () => { assertCaptured(); await store.assertCurrent(expected); assertCaptured() }
      await check()
      const recovery = await captureManagedRecovery(database, expected, notice, check, profile.signal)
      const copyLifetime = { check: assertReplace, assertCurrent: check }
      const current = await admitLocalRoot(store.adapter, expected.root, copyLifetime)
      assertBulkMetadata(before.state, current.state)
      const operationId = crypto.randomUUID()
      const copied = await prepareManagedRecoveryCopy(recovery, current, store.adapter, operationId, assertReplace)
      const inherited = await prepareLocalEvidence(store.adapter, operationId, copied.evidence)
      // Explicit restore clears operative undo, while complete native history lives in the new graph and evidence
      // Use full bulk admission instead of the ordinary append-only checkpoint reuse path
      const prepared = await prepareLocalWorkspace(store.adapter, operationId, copied.state, copyLifetime, undefined, inherited, copied.destinationChanges)
      await store.flush(operationId)
      const reader = createGuestLocalStore(database, assertReplace)
      const reopened = await admitLocalRoot(reader.adapter, prepared.head, { check: assertReplace, assertCurrent: check })
      assertBulkMetadata(prepared.snapshot.state, reopened.state)
      await compareGuestEvidence(copied.evidence, (await readLocalEvidence(reader.adapter, inherited, check, (ref, limit, digest) => reader.readBounded(ref, limit, expected, assertCaptured, digest)))!)
      const selection = GuestManagedRecoverySelectionSchema.parse({ version: 1, kind: 'selected-guest-recovery', branchId: recovery.branch.id, originalCaptureId: recovery.branch.original.id, previousCaptureId: recovery.branch.capture.id, capture: recovery.capture })
      await withManagedRecoverySource(recovery, async assertAlive => {
        const receipt = await store.activate(operationId, prepared.head, expected, () => { assertReplace(); assertAlive() }, current, undefined, selection)
        await store.assertCurrent(receipt.target)
      })
      // Explicit copying changes the comparison incarnation; old in-flight results cannot authorize it
      retired = true; monitor.dispose()
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(GUEST_ACTIVATED_EVENT))
      if (typeof BroadcastChannel !== 'undefined') { const channel = new BroadcastChannel(GUEST_ACTIVATED_EVENT); channel.postMessage({ version: 1 }); channel.close() }
    }, recovery: notice => {
      const expected = captured
      const check = async () => { await assertCurrent(); await store.assertCurrent(expected) }
      return captureManagedRecovery(database, expected, notice, check, profile.signal)
    } })
    registerWorkspaceCapture(repository, async () => {
      await assertCurrent()
      if ((await monitor.compare(profile.signal)).length) throw new Error('Retained local data needs recovery before complete export')
      await assertCurrent(); assertMayWrite()
      return captureManagedGuestSnapshot(database, captured, assertMayWrite)
    })
    registerOwnedFileCommitter(repository, async (before, next, command) => {
      const predecessor = captured, prior = snapshot
      let prepared: Awaited<ReturnType<typeof prepareLocalWorkspace>> | undefined, failure: unknown
      try {
        await assertCurrent(); command.assertMayActivate(); assertMayWrite()
        if (before !== snapshot.state) throw new Error('File input is not the admitted managed head')
        const timestamp = nowTimestamp()
        const localData = changedLocalDataWithSharedUnits(before.planner.localData, next.planner.localData, command.operation, timestamp)
        const checkpoint = { id: randomId('history'), localDataId: localData.id, command: command.operation, previousRevision: before.planner.localData.revision, nextRevision: localData.revision, before: before.planner.localData, after: localData, recordedAt: timestamp }
        const result: WorkspaceState = { ...next, planner: { ...next.planner, localData, history: [...before.planner.history, checkpoint], savedChanges: [...(before.planner.savedChanges ?? before.planner.localData.changes), localData.changes.at(-1)!], journal: { version: 1, changes: localData.changes, checkpoints: [...(before.planner.journal?.checkpoints ?? []), checkpoint], undoable: true } } }
        prepared = await prepareLocalWorkspace(store.adapter, command.id, result, lifetime, prior)
        await store.activate(command.id, prepared.head, predecessor, () => { command.assertMayActivate(); assertMayWrite() }, prior)
        publishHint()
      } catch (error) { failure = error }
      let successor: WorkspaceRepository | undefined
      const reconcile = async (): Promise<OwnedFileOutcome> => {
        try {
          profile.assertCurrent()
          const receipt = await store.receipt(command.id)
          if (!receipt || !prepared) return { status: 'not-saved', error: failure ?? new Error('Managed file command did not activate') }
          if (JSON.stringify(receipt.expected) !== JSON.stringify(predecessor) || JSON.stringify(receipt.target.root) !== JSON.stringify(prepared.head)) throw new Error('Managed receipt identity mismatch')
          const result = prepared.snapshot
          const assertSaved = async () => {
            profile.assertCurrent(); await store.assertCurrent(receipt.target)
            if (JSON.stringify(await store.receipt(command.id)) !== JSON.stringify(receipt)) throw new Error('Managed receipt changed')
            profile.assertCurrent()
          }
          await assertSaved()
          return { status: 'saved', receipt: ownedFileReceipt(command, async () => {
            command.assertMayActivate(); await assertSaved()
            successor ??= wrapper(result, receipt.target)
            retired = true
            return { repository: successor, state: result.state, assertCurrent: assertSaved }
          }, async () => { await assertSaved(); await admitLocalRoot(store.adapter, receipt.target.root, lifetime); await assertSaved() }) }
        } catch (error) { return reconcilableFileOutcome({ status: 'uncertain', error }, reconcile) }
      }
      return reconcile()
    })
    return repository
  }
}

function captureBulkInput(state: WorkspaceState): WorkspaceState {
  // Capture mutable metadata before yielding; native-owned immutable catalogs and exact lazy body capabilities can be retained
  // Complete digest validation and durable staging still reject a body that changes underneath this capture
  const catalogs = state.planner.catalogs.map(catalog => isImmutableCatalogSnapshot(catalog) ? catalog : structuredClone(catalog))
  const metadata = structuredClone({ ...state, planner: { ...state.planner, catalogs: [] }, blobs: state.blobs.map(value => value.ref) })
  return { ...metadata, planner: { ...metadata.planner, catalogs }, blobs: state.blobs.map((value, index) => ({ ref: metadata.blobs[index], content: { byteLength: value.content.byteLength, open: value.content.open.bind(value.content) } })) }
}

function assertBulkMetadata(expected: WorkspaceState, actual: WorkspaceState): void {
  // Both sides already passed complete body validation; compare exact metadata without allocating canonical graph copies
  // Array ordering and nested values remain significant, while lazy body functions are checked through their exact refs
  const metadata = (state: WorkspaceState) => ({ ...state, blobs: state.blobs.map(value => value.ref) })
  if (!guestPlannerValuesEqual(metadata(expected), metadata(actual))) throw new Error('The staged managed workspace differs from its complete input')
}
