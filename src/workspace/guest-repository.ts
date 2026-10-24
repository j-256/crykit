import { GuestManagedManifestSchema } from './guest-managed-contract'
import { prepareGuestStartup } from './guest-managed-startup'
import { openGuestManagedRepository, managedGuestSelection, checkManagedGuestRecovery, managedGuestRecoveryNotices, observeManagedGuestRecovery, inspectManagedGuestRecovery, exportManagedGuestRecovery, copyManagedGuestRecovery } from './guest-managed-repository'
import { registerDeferredOwnedFileCommitter } from './owned-file-command'
import { registerWorkspaceCapture, type WorkspaceSnapshot } from './snapshot'
import { captureProfileEpoch } from '../account/profile'
import { validateWorkspaceClosure } from './closure'
import { assertOwnedInspectorCapture, reconcilableFileOutcome, registerOwnedFileCommitter, ownedFileReceipt, assertFileCommandResult, type OwnedFileReceipt } from './owned-file-command'
import { CryKitDatabase } from '../persistence/database'
import { GuestFilesDatabase } from './guest-files'
import { InspectorStorage as CapturedInspectorStorage } from '../mod-inspector/storage'
import { requireGuestPublicationJournal, requireGuestRestoreManifest, requireGuestSuccessorJournal, requireV1GuestJournal, requireV1GuestManifest, type GuestManifest, type GuestManifestV2 } from './guest-coordinator'
import type { WorkspaceState } from './documents'
import { checkGuestRecovery, captureGuestRecovery, exportGuestCapture, copyGuestRecovery, type GuestRecoveryNotice, type LegacyExportSink } from './guest-recovery'
import { prepareWorkspaceImport, prepareWorkspaceModSetup } from './import-commands'
import { getDatabase } from '../persistence/database'
import * as local from '../persistence/local-data'
import { readModSource } from '../persistence/mod-library'
import { NATIVE_BACKUP_ARCHIVE_LIMITS } from '../interchange/zip'
import { WorkspaceError, type WorkspaceRepository } from './repository'
import { readGuestWorkspace, commitGuestWorkspace, assertGuestCurrent, type GuestBindings } from './guest-workspace'
import { readBlob, blobIdentity } from './blobs'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-record'
import type { InspectorStorage } from '../mod-inspector/storage'
import type { OwnedFileCommand, OwnedFileOutcome } from './owned-file-command'

import { compareGuestEvidence, readGuestEvidence, databaseEvidenceRows, type CapturedGuestEvidence } from './guest-evidence'

const guestProfiles = new WeakMap<WorkspaceRepository, ReturnType<typeof captureProfileEpoch>>()
const bindings = new WeakMap<WorkspaceRepository, Promise<GuestBindings>>()
async function commitOwnedGuestSuccessor(binding: GuestBindings, before: WorkspaceState, next: WorkspaceState, command: OwnedFileCommand): Promise<OwnedFileOutcome> {
  const profile = captureProfileEpoch()
  let target: GuestManifestV2 | undefined, expected: WorkspaceState | undefined, expectedEvidence: CapturedGuestEvidence | undefined, failure: unknown
  let receipt: OwnedFileReceipt | undefined, verified: WorkspaceRepository | undefined
  let resolving: Promise<unknown> = Promise.resolve()
  try {
    command.assertMayActivate()
    await checkGuestRecovery(binding)
    assertFileCommandResult(before, await readGuestWorkspace(binding))
    await commitGuestWorkspace(binding, next, before.planner.localData.revision, 'additive', {
      assertPreparedInspector: storage => assertOwnedInspectorCapture(command, storage), operationId: command.id,
      assertMayActivate: command.assertMayActivate,
      onPreparedV2: (manifest, state, evidence) => { target = manifest; expected = state; expectedEvidence = evidence },
    })
  } catch (error) { failure = error }
  const reconcile = async (): Promise<OwnedFileOutcome> => {
    try {
      const manifest = target, result = expected, inherited = expectedEvidence
      if (manifest && result && inherited) {
        const assertCurrent = async () => {
          profile.assertCurrent()
          const active = await binding.coordinator.active.get('active')
          const row = requireGuestSuccessorJournal(await binding.coordinator.journal.get(manifest.id))
          if (!active || !guestPlannerValuesEqual(requireGuestRestoreManifest(active.manifest), manifest)
            || row.phase !== 'published' || row.commandId !== command.id
            || !guestPlannerValuesEqual(row.expected, binding.manifest) || !guestPlannerValuesEqual(row.target, manifest)) throw new Error('The saved file successor changed')
          if (!row.targetCapture || !guestPlannerValuesEqual(await binding.coordinator.captures.get(row.targetCapture.id), row.targetCapture)) throw new Error('The saved file capture changed')
          if (row.recoveryCapture && !guestPlannerValuesEqual(await binding.coordinator.captures.get(row.recoveryCapture.id), row.recoveryCapture)) throw new Error('The saved file recovery capture changed')
          profile.assertCurrent()
        }
        try { await assertCurrent() } catch (error) {
          const active = await binding.coordinator.active.get('active')
          if (active && guestPlannerValuesEqual(active.manifest, binding.manifest)) return { status: 'not-saved', error: failure ?? error }
          return reconcilableFileOutcome({ status: 'uncertain', error: failure ?? error }, reconcile)
        }
        receipt ??= ownedFileReceipt(command, () => {
          const attempt = resolving.then(async () => {
            command.assertMayActivate(); await assertCurrent()
            const candidate = verified ? undefined : { coordinator: binding.coordinator, manifest,
              planner: new CryKitDatabase(manifest.planner, { plannerFormatRequirement: 'journaled' }),
              inspector: new CapturedInspectorStorage(manifest.inspector, { requiredGuestTarget: true }),
              files: new GuestFilesDatabase(manifest.files, { requiredGuestTarget: true }) }
            const successor = verified ?? guestRepository(Promise.resolve(candidate!))
            let accepted = false
            try {
              const state = await successor.readWorkspace()
              await validateWorkspaceClosure(state); await assertCurrent(); command.assertMayActivate()
              const evidenceBinding = candidate ?? await guestRepositoryBindings(successor)
              await compareGuestEvidence(inherited, await readGuestEvidence(databaseEvidenceRows(evidenceBinding.files), assertCurrent))
              assertFileCommandResult(result, state)
              verified = successor; accepted = true
              return { repository: successor, state, assertCurrent }
            } finally { if (candidate && !accepted) { candidate.planner.close(); candidate.inspector.close(); candidate.files.close() } }
          })
          resolving = attempt.catch(() => {})
          return attempt
        }, async () => {
          await assertCurrent()
          const candidate = { coordinator: binding.coordinator, manifest,
            planner: new CryKitDatabase(manifest.planner, { plannerFormatRequirement: 'journaled' }),
            inspector: new CapturedInspectorStorage(manifest.inspector, { requiredGuestTarget: true }),
            files: new GuestFilesDatabase(manifest.files, { requiredGuestTarget: true }) }
          try {
            const state = await readGuestWorkspace(candidate)
            await validateWorkspaceClosure(state)
            await compareGuestEvidence(inherited, await readGuestEvidence(databaseEvidenceRows(candidate.files), assertCurrent))
            assertFileCommandResult(result, state); await assertCurrent()
          } finally { candidate.planner.close(); candidate.inspector.close(); candidate.files.close() }
        })
        return { status: 'saved', receipt, ...(failure ? { error: failure } : {}) }
      }
      const active = await binding.coordinator.active.get('active')
      if (active && guestPlannerValuesEqual(active.manifest, binding.manifest)) return { status: 'not-saved', error: failure ?? new Error('File command did not activate') }
      return reconcilableFileOutcome({ status: 'uncertain', error: failure ?? new Error('The active workspace changed during file completion') }, reconcile)
    } catch (error) { return reconcilableFileOutcome({ status: 'uncertain', error }, reconcile) }
  }
  return reconcile()
}
// Managed admission already incorporated every legacy Inspector row into typed containers
// This exact captured repository check never authorizes an old wrapper to follow a newer head
export async function usesManagedGuestStorage(repository: WorkspaceRepository): Promise<boolean> {
  const selected = await (deferredGuests.get(repository)?.() ?? repository)
  return checkManagedGuestRecovery(selected)
}
export async function guestInspectorFor(repository: WorkspaceRepository): Promise<InspectorStorage> {
  const deferred = deferredGuests.get(repository)
  if (deferred) return guestInspectorFor(await deferred())
  const captured = bindings.get(repository)
  if (!captured) throw new WorkspaceError('ACCOUNT_CAPABILITY_UNAVAILABLE', 'Account editor storage is not available yet.')
  const binding = await captured
  await assertGuestCurrent(binding)
  return binding.inspector
}
export function guestRepositoryBindings(repository: WorkspaceRepository): Promise<GuestBindings> {
  const deferred = deferredGuests.get(repository)
  if (deferred) return deferred().then(guestRepositoryBindings)
  const captured = bindings.get(repository)
  if (!captured) throw new Error('A captured guest repository is required')
  return captured
}
export async function capturedManagedGuestRepository(repository: WorkspaceRepository): Promise<WorkspaceRepository | undefined> {
  const selected = await (deferredGuests.get(repository)?.() ?? repository)
  return managedGuestSelection(selected) ? selected : undefined
}
export async function guestRepositorySelection(repository: WorkspaceRepository) {
  const selected = await (deferredGuests.get(repository)?.() ?? repository)
  const managed = managedGuestSelection(selected)
  const profile = managed ? { assertCurrent: managed.assertProfile } : guestProfiles.get(selected)
  if (!profile) throw new Error('A captured guest repository is required')
  profile.assertCurrent()
  const captured = managed ?? await guestRepositoryBindings(selected)
  profile.assertCurrent()
  return { manifest: captured.manifest, async readSelected() {
    profile.assertCurrent()
    const row = await captured.coordinator.active.get('active')
    profile.assertCurrent()
    if (!row) return undefined
    const version = (row.manifest as { version?: unknown }).version
    return version === 3 ? GuestManagedManifestSchema.parse(row.manifest) : version === 2 ? requireGuestRestoreManifest(row.manifest) : requireV1GuestManifest(row.manifest)
  } }
}
const deferredGuests = new WeakMap<WorkspaceRepository, () => Promise<WorkspaceRepository>>()
export async function observeGuestRecovery(repository: WorkspaceRepository, listener: Parameters<typeof observeManagedGuestRecovery>[1]) {
  return observeManagedGuestRecovery(await (deferredGuests.get(repository)?.() ?? repository), listener)
}
export async function guestRecoveryNotices(repository: WorkspaceRepository, signal?: AbortSignal) {
  const selected = await (deferredGuests.get(repository)?.() ?? repository)
  const managed = await managedGuestRecoveryNotices(selected, signal)
  if (managed) return managed
  return checkGuestRecovery(await guestRepositoryBindings(selected), signal)
}
// Recovery actions keep the repository captured by the caller, including through deferred startup
export async function inspectRepositoryGuestRecovery(repository: WorkspaceRepository, notice: GuestRecoveryNotice) {
  const selected = await (deferredGuests.get(repository)?.() ?? repository)
  const managed = await inspectManagedGuestRecovery(selected, notice)
  if (managed) return managed
  const binding = await guestRepositoryBindings(selected), capture = await captureGuestRecovery(binding, notice)
  let plannerRecords = 0, editorRecords = 0
  await binding.coordinator.records.where('captureId').equals(capture.id).each(record => {
    if (record.kind === 'record' && record.participant === 'planner') plannerRecords++
    if (record.kind === 'record' && record.participant === 'inspector') editorRecords++
  })
  await assertGuestCurrent(binding)
  return { plannerRecords, editorRecords }
}
export async function exportRepositoryGuestRecovery(repository: WorkspaceRepository, notice: GuestRecoveryNotice, sink: LegacyExportSink): Promise<void> {
  const selected = await (deferredGuests.get(repository)?.() ?? repository)
  if (await exportManagedGuestRecovery(selected, notice, sink)) return
  const binding = await guestRepositoryBindings(selected), capture = await captureGuestRecovery(binding, notice)
  await exportGuestCapture(binding, capture, sink)
}
export async function copyRepositoryGuestRecovery(repository: WorkspaceRepository, notice: GuestRecoveryNotice, canReplace: () => boolean): Promise<void> {
  const selected = await (deferredGuests.get(repository)?.() ?? repository)
  if (await copyManagedGuestRecovery(selected, notice, canReplace)) return
  const binding = await guestRepositoryBindings(selected), capture = await captureGuestRecovery(binding, notice)
  await copyGuestRecovery(binding, capture, canReplace)
}
export function createGuestRepository(original?: CryKitDatabase): WorkspaceRepository {
  const profile = captureProfileEpoch()
  let opening: Promise<WorkspaceRepository> | undefined
  // Account entry does not consume local data, so constructing its guest facade must not migrate it
  // First use chooses one captured repository; the original profile fence still rejects stale callbacks before IO
  const captured = () => {
    if (!opening) {
      opening = (async () => {
        profile.assertCurrent()
        const startup = await prepareGuestStartup(original ?? getDatabase())
        profile.assertCurrent()
        return startup.kind === 'managed' ? openGuestManagedRepository(startup.coordinator, startup.manifest) : guestRepository(Promise.resolve(startup.binding))
      })()
      void opening.catch(() => {})
    }
    return opening
  }
  const repository: WorkspaceRepository = {
    kind: 'guest',
    readWorkspace: async () => (await captured()).readWorkspace(),
    commitWorkspace: async (...args) => (await captured()).commitWorkspace(...args),
    load: async () => (await captured()).load(), save: async (...args) => (await captured()).save(...args), undo: async (...args) => (await captured()).undo(...args),
    previewImport: local.previewImport, prepareModCatalogs: local.prepareModCatalogs,
    commitImport: async (...args) => (await captured()).commitImport(...args), commitModSetup: async (...args) => (await captured()).commitModSetup(...args),
    readModSource: async (...args) => (await captured()).readModSource(...args), readSources: async () => (await captured()).readSources(), readHistory: async () => (await captured()).readHistory(),
    exportPlannerBackup: async (...args) => (await captured()).exportPlannerBackup(...args),
    subscribe: listener => { let disposed = false, unsubscribe: (() => void) | undefined; void captured().then(value => { if (!disposed) unsubscribe = value.subscribe(listener) }).catch(() => {}); return () => { disposed = true; unsubscribe?.() } },
  }
  deferredGuests.set(repository, captured)
  registerDeferredOwnedFileCommitter(repository, captured)
  registerWorkspaceCapture(repository, async () => { const { captureWorkspaceSnapshot } = await import('./snapshot'); return captureWorkspaceSnapshot(await captured()) })
  return repository
}

export interface GuestCopySource { readonly snapshot: WorkspaceSnapshot; readonly originals?: CapturedGuestEvidence }
export async function captureGuestWorkspaceForCopy(original = getDatabase()): Promise<GuestCopySource> {
  const profile = captureProfileEpoch(), startup = await prepareGuestStartup(original, 'capture')
  profile.assertCurrent()
  if (startup.kind === 'managed') {
    const repository = await openGuestManagedRepository(startup.coordinator, startup.manifest)
    profile.assertCurrent()
    const { captureWorkspaceSnapshot } = await import('./snapshot')
    profile.assertCurrent()
    return Object.freeze({ snapshot: await captureWorkspaceSnapshot(repository) })
  }
  const { captureGuestNativeForCopy } = await import('./guest-managed-migration')
  profile.assertCurrent()
  return captureGuestNativeForCopy(startup.binding)
}

function guestRepository(captured: Promise<GuestBindings>): WorkspaceRepository {
  const exportProfile = captureProfileEpoch()
  // This promise captures named handles once; activation opens a successor instead of retargeting queued work
  // Construction may precede the first consumer; the original promise still rejects for every caller
  void captured.catch(() => {})
  const database = async () => { const binding = await captured; await assertGuestCurrent(binding); await checkGuestRecovery(binding); return binding.planner }
  const repository: WorkspaceRepository = {
    kind: 'guest',
    readWorkspace: async () => { const binding = await captured; await checkGuestRecovery(binding); return readGuestWorkspace(binding) },
    commitWorkspace: async (state, revision) => { const binding = await captured; await checkGuestRecovery(binding); return commitGuestWorkspace(binding, state, revision) },
    load: async () => local.loadLocalData(await database()),
    save: async (data, revision) => {
      const binding = await captured
      if (binding.manifest.version === 1) return local.saveLocalDataWithStatus(data, revision, await database(), true)
      // Selected v2 targets are captured publication results; planner edits must publish a fresh successor
      await checkGuestRecovery(binding)
      const before = await readGuestWorkspace(binding)
      if (before.planner.localData.revision !== revision) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'The local workspace changed. Keep your draft and reload.')
      const catalogs = await local.prepareModCatalogs(data, before.planner.catalogs)
      const saved = await commitGuestWorkspace(binding, { ...before, planner: { ...before.planner, localData: data, catalogs } }, revision, 'additive', { command: 'save-localData' })
      return { localData: saved.localData, canUndo: saved.canUndo }
    },
    undo: async revision => {
      const binding = await captured
      if (binding.manifest.version === 1) return local.undoLocalDataWithStatus(revision, await database(), true)
      await checkGuestRecovery(binding)
      const before = await readGuestWorkspace(binding)
      if (before.planner.localData.revision !== revision) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'The local workspace changed. Keep your draft and reload.')
      const latest = before.planner.journal?.undoable ? before.planner.journal.checkpoints.at(-1) : undefined
      if (!latest) throw new Error('There is no saved change to undo')
      const saved = await commitGuestWorkspace(binding, { ...before, planner: { ...before.planner, localData: latest.before } }, revision, 'additive', { command: `undo:${latest.command}` })
      return { localData: saved.localData, canUndo: saved.canUndo }
    },
    previewImport: local.previewImport,
    commitImport: async (preview, options) => {
      const binding = await captured
      await checkGuestRecovery(binding)
      const before = await readGuestWorkspace(binding)
      const prepared = await prepareWorkspaceImport(before, preview, options)
      return commitGuestWorkspace(binding, prepared.state, before.planner.localData.revision, prepared.mode)
    },
    commitModSetup: async (previews, revision, skip) => {
      const binding = await captured
      await checkGuestRecovery(binding)
      const before = await readGuestWorkspace(binding)
      return commitGuestWorkspace(binding, await prepareWorkspaceModSetup(before, previews, revision, skip), revision)
    },
    prepareModCatalogs: local.prepareModCatalogs,
    readModSource: async pin => readModSource(pin, await database()),
    readSources: async () => {
      const state = await readGuestWorkspace(await captured)
      const total = state.planner.sources.reduce((bytes, source) => bytes + source.original.byteLength, 0)
      if (total > NATIVE_BACKUP_ARCHIVE_LIMITS.maxTotalUncompressedBytes) throw new WorkspaceError('LOCAL_MATERIALIZATION_LIMIT', 'These sources require a streamed full-workspace backup.')
      const registry = new Map(state.blobs.map(blob => [blobIdentity(blob.ref), blob.content]))
      const result = []
      for (const { original, ...source } of state.planner.sources) result.push({ ...source, bytes: await readBlob(registry.get(blobIdentity(original))!, original.byteLength) })
      return result
    },
    readHistory: async () => {
      const selected = await database(), loaded = await local.loadLocalData(selected)
      return selected.history.where('localDataId').equals(loaded.localData.id).sortBy('nextRevision')
    },
    exportPlannerBackup: async override => {
      const draft = override && structuredClone(override)
      const binding = await captured
      exportProfile.assertCurrent()
      // An explicit inert draft export reads its captured planner even after retirement
      // It never adopts the successor; ordinary backups still require current recovery admission
      if (!draft) await checkGuestRecovery(binding)
      exportProfile.assertCurrent()
      const bytes = await local.exportBackup(draft, binding.planner)
      try { exportProfile.assertCurrent(); return bytes }
      catch (error) { bytes.fill(0); throw error }
    },
    subscribe: local.subscribeLocalData,
  }
  guestProfiles.set(repository, exportProfile)
  bindings.set(repository, captured)
  registerWorkspaceCapture(repository, async () => { const { captureGuestSnapshot } = await import('./guest-snapshot'); return captureGuestSnapshot(await captured) })
  registerOwnedFileCommitter(repository, async (before, next, command) => {
    const profile = captureProfileEpoch()
    const binding = await captured
    if (binding.manifest.version === 2) return commitOwnedGuestSuccessor(binding, before, next, command)
    let expectedEvidence: CapturedGuestEvidence | undefined
    let expected: WorkspaceState | undefined, target: GuestManifest | undefined, error: unknown
    let receipt: OwnedFileReceipt | undefined, verifiedSuccessor: WorkspaceRepository | undefined
    let resolving: Promise<unknown> = Promise.resolve()
    try {
      command.assertMayActivate()
      await checkGuestRecovery(binding)
      assertFileCommandResult(before, await readGuestWorkspace(binding))
      await commitGuestWorkspace(binding, next, before.planner.localData.revision, 'additive', { assertPreparedInspector: storage => assertOwnedInspectorCapture(command, storage), operationId: command.id, assertMayActivate: command.assertMayActivate, onPrepared: (manifest, state, evidence) => { target = manifest; expected = state; expectedEvidence = evidence } })
    } catch (reason) { error = reason }
    const reconcile = async (): Promise<import('./owned-file-command').OwnedFileOutcome> => {
      try {
        const journal = await binding.coordinator.journal.get(command.id)
        const active = await binding.coordinator.active.get('active')
        if (journal) requireV1GuestJournal(journal)
        if (active) requireV1GuestManifest(active.manifest)
        if (target && expected && expectedEvidence && journal?.localStatus === 'published' && journal.target.id === target.id) {
          const result = expected, manifest = target, inherited = expectedEvidence
          receipt ??= ownedFileReceipt(command, () => {
            // Shared source handles stay alive; only a failed newly-owned candidate can be closed here
            const attempt = resolving.then(async () => {
              const assertCurrent = async () => {
                const actual = await binding.coordinator.active.get('active')
                if (!actual || JSON.stringify(requireV1GuestManifest(actual.manifest)) !== JSON.stringify(manifest)) throw new Error('The saved file successor is no longer selected')
                const row = await binding.coordinator.journal.get(command.id)
                if (!row || requireV1GuestJournal(row).localStatus !== 'published' || JSON.stringify(row.expected) !== JSON.stringify(binding.manifest) || JSON.stringify(row.target) !== JSON.stringify(manifest)) throw new Error('The saved file journal is no longer available')
              }
              command.assertMayActivate()
              await assertCurrent()
              const candidate = verifiedSuccessor ? undefined : { coordinator: binding.coordinator, manifest, planner: new CryKitDatabase(manifest.planner), inspector: new CapturedInspectorStorage(manifest.inspector), files: new GuestFilesDatabase(manifest.files) }
              const successor = verifiedSuccessor ?? guestRepository(Promise.resolve(candidate!))
              let accepted = false
              try {
                const state = await successor.readWorkspace()
                command.assertMayActivate()
                // Metadata equality cannot detect corrupted unchanged bodies in a lazily read guest workspace
                await validateWorkspaceClosure(state)
                await assertCurrent()
                command.assertMayActivate()
                const evidenceBinding = candidate ?? await guestRepositoryBindings(successor)
                await compareGuestEvidence(inherited, await readGuestEvidence(databaseEvidenceRows(evidenceBinding.files), assertCurrent))
                assertFileCommandResult(result, state)
                verifiedSuccessor = successor
                accepted = true
                return { repository: successor, state, assertCurrent }
              } finally {
                if (candidate && !accepted) { candidate.planner.close(); candidate.inspector.close(); candidate.files.close() }
              }
            })
            resolving = attempt.catch(() => {})
            return attempt
          }, async () => {
            const assertSaved = async () => {
              profile.assertCurrent()
              const journal = await binding.coordinator.journal.get(command.id)
              const active = await binding.coordinator.active.get('active')
              profile.assertCurrent()
              if (!journal || !active || requireV1GuestJournal(journal).localStatus !== 'published' || JSON.stringify(journal.target) !== JSON.stringify(manifest) || JSON.stringify(journal.expected) !== JSON.stringify(binding.manifest) || JSON.stringify(requireV1GuestManifest(active.manifest)) !== JSON.stringify(manifest)) throw new Error('The saved file result is no longer selected')
            }
            await assertSaved()
            // These handles belong only to verification; no shared or continuation handle is closed
            const candidate = { coordinator: binding.coordinator, manifest, planner: new CryKitDatabase(manifest.planner), inspector: new CapturedInspectorStorage(manifest.inspector), files: new GuestFilesDatabase(manifest.files) }
            try {
              const state = await readGuestWorkspace(candidate)
              await validateWorkspaceClosure(state)
              await compareGuestEvidence(inherited, await readGuestEvidence(databaseEvidenceRows(candidate.files), assertSaved))
              assertFileCommandResult(result, state)
              await assertSaved()
            } finally { candidate.planner.close(); candidate.inspector.close(); candidate.files.close() }
          })
          return { status: 'saved', receipt, ...(error ? { error } : {}) }
        }
        if (active?.manifest.id === binding.manifest.id) return { status: 'not-saved', error: error ?? new Error('File command did not activate') }
        return reconcilableFileOutcome({ status: 'uncertain', error: error ?? new Error('The active workspace changed during file completion') }, reconcile)
      } catch (reason) { return reconcilableFileOutcome({ status: 'uncertain', error: reason }, reconcile) }
    }
    return reconcile()
  })
  return repository
}

export async function readGuestSaveRecovery(repository: WorkspaceRepository, expected: import('./documents').SaveWorkspaceDocument) {
  const selected = await (deferredGuests.get(repository)?.() ?? repository)
  const managed = managedGuestSelection(selected)
  const profile = managed ? { assertCurrent: managed.assertProfile } : guestProfiles.get(selected)
  if (!profile) throw new Error('A captured guest repository is required')
  profile.assertCurrent()
  const captured = managed ?? await guestRepositoryBindings(selected), active = await captured.coordinator.active.get('active')
  profile.assertCurrent()
  if (!active) throw new Error('The selected local workspace is unavailable')
  if ((active.manifest as { version?: unknown }).version === 3) {
    const manifest = GuestManagedManifestSchema.parse(active.manifest)
    const { createGuestLocalStore } = await import('./guest-local-store')
    const { admitLocalRoot } = await import('./local-root')
    const { readSaveContent } = await import('./save-repository')
    const store = createGuestLocalStore(captured.coordinator, profile.assertCurrent)
    const check = () => store.assertCurrent(manifest)
    // Recovery can inspect a committed successor, but only the exact requested file and captured profile
    // It creates no writable wrapper and cannot authorize old callbacks against the selected head
    await check()
    const snapshot = await admitLocalRoot(store.adapter, manifest.root, { check: profile.assertCurrent, assertCurrent: check })
    if (!guestPlannerValuesEqual(snapshot.state.saveDocuments.find(value => value.id === expected.id), expected)) throw new Error('The saved recovery file changed')
    const content = await readSaveContent(snapshot.state, expected)
    try { await check(); return content }
    catch (error) { content.originalBytes.fill(0); content.workingBytes.fill(0); throw error }
  }
  // Save recovery may read the pointer without the ordinary repository gate
  const manifest = (active.manifest as { version?: unknown }).version === 2 ? requireGuestRestoreManifest(active.manifest) : requireV1GuestManifest(active.manifest)
  if (manifest.version === 2) {
    const journal = requireGuestPublicationJournal(await captured.coordinator.journal.get(manifest.id))
    if (journal.phase !== 'published' || !guestPlannerValuesEqual(journal.target, manifest)) throw new Error('The selected save recovery journal changed')
    if (journal.kind === 'guest-successor' && journal.recoveryCapture) {
      const retained = await captured.coordinator.captures.get(journal.recoveryCapture.id)
      if (!retained || !guestPlannerValuesEqual(retained, journal.recoveryCapture)) throw new Error('The selected save recovery capture changed')
    }
  }
  const binding = { coordinator: captured.coordinator, manifest, planner: new CryKitDatabase(manifest.planner, manifest.version === 2 ? { plannerFormatRequirement: 'journaled' } : undefined), inspector: new CapturedInspectorStorage(manifest.inspector, manifest.version === 2 ? { requiredGuestTarget: true } : undefined), files: new GuestFilesDatabase(manifest.files, manifest.version === 2 ? { requiredGuestTarget: true } : undefined) }
  try {
    const fresh = guestRepository(Promise.resolve(binding)), state = await fresh.readWorkspace()
    await validateWorkspaceClosure(state)
    const file = state.saveDocuments.find(value => value.id === expected.id)
    if (JSON.stringify(file) !== JSON.stringify(expected)) throw new Error('The saved recovery file changed')
    const { readSaveContent } = await import('./save-repository')
    const content = await readSaveContent(state, expected)
    try { profile.assertCurrent(); await assertGuestCurrent(binding); profile.assertCurrent(); return content }
    catch (error) { content.originalBytes.fill(0); content.workingBytes.fill(0); throw error }
  } finally { binding.planner.close(); binding.inspector.close(); binding.files.close() }
}
