import { GuestManagedManifestSchema } from './guest-managed-contract'
import { prepareGuestStartup } from './guest-managed-startup'
import { recordWorkspaceStartup, WORKSPACE_STARTUP_PHASE } from '../diagnostics/workspace-startup'
import { openGuestManagedRepository, managedGuestSelection, managedGuestRecoveryNotices, observeManagedGuestRecovery, inspectManagedGuestRecovery, exportManagedGuestRecovery, copyManagedGuestRecovery } from './guest-managed-repository'
import { registerDeferredOwnedFileCommitter } from './owned-file-command'
import { registerWorkspaceCapture, type WorkspaceSnapshot } from './snapshot'
import { captureGuestWorkspaceEpoch } from '../account/profile'
import { getDatabase, type CryKitDatabase } from '../persistence/database'
import type { GuestRecoveryNotice, LegacyExportSink } from './guest-recovery'
import * as local from '../persistence/local-data'
import type { WorkspaceRepository } from './repository'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-record'
import type { CapturedGuestEvidence } from './guest-evidence'

const deferredGuests = new WeakMap<WorkspaceRepository, () => Promise<WorkspaceRepository>>()
export async function capturedManagedGuestRepository(repository: WorkspaceRepository): Promise<WorkspaceRepository | undefined> {
  const selected = await (deferredGuests.get(repository)?.() ?? repository)
  return managedGuestSelection(selected) ? selected : undefined
}
async function requireManagedGuest(repository: WorkspaceRepository): Promise<WorkspaceRepository> {
  const selected = await capturedManagedGuestRepository(repository)
  if (!selected) throw new Error('A captured managed guest is required')
  return selected
}
export async function guestRepositorySelection(repository: WorkspaceRepository) {
  const captured = managedGuestSelection(await requireManagedGuest(repository))!
  captured.assertProfile()
  return { manifest: captured.manifest, async readSelected() {
    captured.assertProfile()
    const row = await captured.coordinator.active.get('active')
    captured.assertProfile()
    return row ? GuestManagedManifestSchema.parse(row.manifest) : undefined
  } }
}
export async function observeGuestRecovery(repository: WorkspaceRepository, listener: Parameters<typeof observeManagedGuestRecovery>[1]) {
  return observeManagedGuestRecovery(await requireManagedGuest(repository), listener)
}
export async function guestRecoveryNotices(repository: WorkspaceRepository, signal?: AbortSignal) {
  return (await managedGuestRecoveryNotices(await requireManagedGuest(repository), signal))!
}
// Recovery actions keep the repository captured by the caller, including through deferred startup
export async function inspectRepositoryGuestRecovery(repository: WorkspaceRepository, notice: GuestRecoveryNotice) {
  return (await inspectManagedGuestRecovery(await requireManagedGuest(repository), notice))!
}
export async function exportRepositoryGuestRecovery(repository: WorkspaceRepository, notice: GuestRecoveryNotice, sink: LegacyExportSink): Promise<void> {
  await exportManagedGuestRecovery(await requireManagedGuest(repository), notice, sink)
}
export async function copyRepositoryGuestRecovery(repository: WorkspaceRepository, notice: GuestRecoveryNotice, canReplace: () => boolean): Promise<void> {
  await copyManagedGuestRecovery(await requireManagedGuest(repository), notice, canReplace)
}
export function createGuestRepository(original?: CryKitDatabase): WorkspaceRepository {
  const profile = captureGuestWorkspaceEpoch()
  let opening: Promise<WorkspaceRepository> | undefined
  // Account entry does not consume local data, so constructing its guest facade must not migrate it
  // First use chooses one captured repository; the original profile fence still rejects stale callbacks before IO
  const captured = () => {
    if (!opening) {
      opening = (async () => {
        profile.assertCurrent()
        recordWorkspaceStartup(WORKSPACE_STARTUP_PHASE.guest)
        const startup = await prepareGuestStartup(original ?? getDatabase())
        profile.assertCurrent()
        recordWorkspaceStartup(WORKSPACE_STARTUP_PHASE.guestPrepared)
        return openGuestManagedRepository(startup.coordinator, startup.manifest)
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
  const profile = captureGuestWorkspaceEpoch(), startup = await prepareGuestStartup(original, 'capture')
  profile.assertCurrent()
  const repository = await openGuestManagedRepository(startup.coordinator, startup.manifest)
  profile.assertCurrent()
  const { captureWorkspaceSnapshot } = await import('./snapshot')
  profile.assertCurrent()
  return Object.freeze({ snapshot: await captureWorkspaceSnapshot(repository) })
}

export async function readGuestSaveRecovery(repository: WorkspaceRepository, expected: import('./documents').SaveWorkspaceDocument) {
  const captured = managedGuestSelection(await requireManagedGuest(repository))!
  captured.assertProfile()
  const active = await captured.coordinator.active.get('active')
  captured.assertProfile()
  if (!active) throw new Error('The selected local workspace is unavailable')
  const manifest = GuestManagedManifestSchema.parse(active.manifest)
  const { createGuestLocalStore } = await import('./guest-local-store')
  const { admitLocalRoot } = await import('./local-root')
  const { readSaveContent } = await import('./save-repository')
  const store = createGuestLocalStore(captured.coordinator, captured.assertProfile)
  const check = () => store.assertCurrent(manifest)
  // Recovery can inspect a committed successor, but only the exact requested file and captured profile
  // It creates no writable wrapper and cannot authorize old callbacks against the selected head
  await check()
  const snapshot = await admitLocalRoot(store.adapter, manifest.root, { check: captured.assertProfile, assertCurrent: check })
  if (!guestPlannerValuesEqual(snapshot.state.saveDocuments.find(value => value.id === expected.id), expected)) throw new Error('The saved recovery file changed')
  const content = await readSaveContent(snapshot.state, expected)
  try { await check(); return content }
  catch (error) { content.originalBytes.fill(0); content.workingBytes.fill(0); throw error }
}
