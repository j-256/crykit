import { GUEST_PLANNER_DATABASE, isPrelaunchGuestDatabase } from '../persistence/storage-names'
import { captureGuestWorkspaceEpoch } from '../account/profile'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { createStarterLocalData } from '../persistence/local-data'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'
import type { WorkspaceState } from './documents'
import type { CryKitDatabase } from '../persistence/database'
import { GuestCoordinatorDatabase } from './guest-coordinator'
import { GuestManagedManifestSchema, type GuestManagedManifest } from './guest-managed-contract'
import { createGuestLocalStore } from './guest-local-store'
import { admitLocalRoot, prepareLocalWorkspace } from './local-root'

// Fresh preparation is a startup operation, never the first ordinary save
// Its one head CAS cannot overwrite a concurrent initializer or a restored selection
export async function prepareFreshGuestWorkspace(database: GuestCoordinatorDatabase) {
  const profile = captureGuestWorkspaceEpoch()
  if (await database.active.get('active')) throw new Error('A guest workspace is already selected')
  profile.assertCurrent()
  const localData = createStarterLocalData()
  const state: WorkspaceState = {
    planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: BUNDLED_CATALOGS, sources: [], evidence: [], history: [] },
    editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] },
  }
  const id = crypto.randomUUID(), store = createGuestLocalStore(database, profile.assertCurrent)
  const lifetime = { check: profile.assertCurrent, assertCurrent: async () => profile.assertCurrent() }
  const prepared = await prepareLocalWorkspace(store.adapter, id, state, lifetime)
  await store.flush(id)
  const reader = createGuestLocalStore(database, profile.assertCurrent)
  const admitted = await admitLocalRoot(reader.adapter, prepared.head, lifetime)
  if (!guestPlannerValuesEqual(admitted.state, state)) throw new Error('The prepared fresh guest changed')
  const receipt = await store.activate(id, prepared.head, undefined, profile.assertCurrent)
  await store.assertCurrent(receipt.target)
  return receipt.target
}

type GuestStartup = { readonly kind: 'managed'; readonly coordinator: GuestCoordinatorDatabase; readonly manifest: GuestManagedManifest }
const pendingStartups = new Map<string, { readonly signal: AbortSignal; readonly result: Promise<GuestStartup> }>()

// Only unfinished preparation is coalesced within one captured profile epoch
// Each caller opens its own repository after the durable selection; no writable view or admission is cached
export async function prepareGuestStartup(original: CryKitDatabase, purpose: 'edit' | 'capture' = 'edit'): Promise<GuestStartup> {
  const profile = captureGuestWorkspaceEpoch(), key = JSON.stringify([original.name, purpose])
  const existing = pendingStartups.get(key) ?? (purpose === 'capture' ? pendingStartups.get(JSON.stringify([original.name, 'edit'])) : undefined)
  if (existing?.signal === profile.signal) { const result = await existing.result; profile.assertCurrent(); return result }
  const result = prepare().finally(() => { if (pendingStartups.get(key)?.result === result) pendingStartups.delete(key) })
  pendingStartups.set(key, { signal: profile.signal, result })
  return result
  async function prepare(): Promise<GuestStartup> {
    const primary = original.name === GUEST_PLANNER_DATABASE
    const coordinator = new GuestCoordinatorDatabase(primary ? undefined : `${original.name}-coordinator`)
    try {
      // Enumerating names never opens an old database or runs its schema upgrades
      // A partially prepared new namespace is not consent to abandon a prelaunch workspace
      if (!globalThis.indexedDB?.databases) throw new Error('Browser storage cannot be inspected safely. Keep the existing data and use a browser that supports database enumeration.')
      const names = (await indexedDB.databases()).flatMap(value => value.name ? [value.name] : [])
      profile.assertCurrent()
      const active = names.includes(coordinator.name) ? await coordinator.active.get('active') : undefined
      profile.assertCurrent()
      if (active) return { kind: 'managed', coordinator, manifest: GuestManagedManifestSchema.parse(active.manifest) }
      const prelaunch = primary ? names.some(isPrelaunchGuestDatabase) : names.some(name => [original.name, `${original.name}-inspector`, `${original.name}-workspace-files-v1`].includes(name))
      if (prelaunch) throw new PrelaunchGuestDataError()
      return { kind: 'managed', coordinator, manifest: await prepareFreshGuestWorkspace(coordinator) }
    } catch (error) { coordinator.close(); throw error }
  }
}

export class PrelaunchGuestDataError extends Error {
  readonly code = 'PRELAUNCH_GUEST_DATA'
  constructor() { super('This browser has data from a prelaunch CryKit format. Start a new workspace to use the new source catalog. The prelaunch data will remain stored in this browser.') }
}

// Only the explicit startup action calls this when prelaunch data exists
// Publication retains the normal profile fence and compare-and-swap against an absent selection
export async function startLaunchGuestWorkspace(supplied?: GuestCoordinatorDatabase): Promise<GuestManagedManifest> {
  const database = supplied ?? new GuestCoordinatorDatabase()
  try {
    const profile = captureGuestWorkspaceEpoch()
    const active = await database.active.get('active')
    profile.assertCurrent()
    return active ? GuestManagedManifestSchema.parse(active.manifest) : await prepareFreshGuestWorkspace(database)
  } finally { if (!supplied) database.close() }
}
