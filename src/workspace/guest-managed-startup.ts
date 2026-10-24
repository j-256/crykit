import { captureProfileEpoch } from '../account/profile'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { createStarterLocalData } from '../persistence/local-data'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'
import type { WorkspaceState } from './documents'
import Dexie from 'dexie'
import type { CryKitDatabase } from '../persistence/database'
import { GuestCoordinatorDatabase } from './guest-coordinator'
import { GuestManagedManifestSchema, requireGuestManagedMigration, type GuestManagedManifest } from './guest-managed-contract'
import { openGuestBindings, type GuestBindings } from './guest-workspace'
import { migrateGuestWorkspace, reconcileGuestManagedMigration } from './guest-managed-migration'
import { checkGuestRecovery } from './guest-recovery'
import { createGuestLocalStore } from './guest-local-store'
import { admitLocalRoot, prepareLocalWorkspace } from './local-root'

// Fresh preparation is a startup operation, never the first ordinary save
// Its one head CAS cannot overwrite a concurrent initializer or a restored selection
export async function prepareFreshGuestWorkspace(database: GuestCoordinatorDatabase) {
  const profile = captureProfileEpoch()
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

type GuestStartup = { readonly kind: 'managed'; readonly coordinator: GuestCoordinatorDatabase; readonly manifest: GuestManagedManifest } | { readonly kind: 'legacy-recovery'; readonly binding: GuestBindings }
const pendingStartups = new Map<string, { readonly signal: AbortSignal; readonly result: Promise<GuestStartup> }>()

// Only unfinished preparation is coalesced within one captured profile epoch
// Each caller opens its own repository after the durable selection; no writable view or admission is cached
export async function prepareGuestStartup(original: CryKitDatabase, purpose: 'edit' | 'capture' = 'edit'): Promise<GuestStartup> {
  const profile = captureProfileEpoch(), key = JSON.stringify([original.name, purpose])
  const existing = pendingStartups.get(key) ?? (purpose === 'capture' ? pendingStartups.get(JSON.stringify([original.name, 'edit'])) : undefined)
  if (existing?.signal === profile.signal) { const result = await existing.result; profile.assertCurrent(); return result }
  const result = prepare().finally(() => { if (pendingStartups.get(key)?.result === result) pendingStartups.delete(key) })
  pendingStartups.set(key, { signal: profile.signal, result })
  return result
  async function prepare(): Promise<GuestStartup> {
    const primary = original.name === 'crykit'
    const coordinator = new GuestCoordinatorDatabase(primary ? undefined : `${original.name}-coordinator`)
    try {
      const active = await coordinator.active.get('active')
      profile.assertCurrent()
      if ((active?.manifest as { version?: unknown } | undefined)?.version === 3) return { kind: 'managed', coordinator, manifest: GuestManagedManifestSchema.parse(active!.manifest) }
      if (!active) {
        const names = [original.name, primary ? 'crykit-mod-inspector-v1' : `${original.name}-inspector`, `${original.name}-workspace-files-v1`]
        const present = await Promise.all(names.map(name => Dexie.exists(name)))
        profile.assertCurrent()
        if (present.every(value => !value)) return { kind: 'managed', coordinator, manifest: await prepareFreshGuestWorkspace(coordinator) }
        if (!present[0]) throw new Error('The saved guest planner is missing. Existing local data was retained.')
      }
      coordinator.close()
      const binding = await openGuestBindings(original)
      profile.assertCurrent()
      // Interrupted migration may have acquired barriers without publishing; reconcile its exact operation first
      for (const value of await binding.coordinator.table('managedMigrations').toArray()) {
        const row = requireGuestManagedMigration(value)
        if (row.phase !== 'published' && row.phase !== 'failed' && guestPlannerValuesEqual(row.expected, binding.manifest)) await reconcileGuestManagedMigration(binding, row.id)
        profile.assertCurrent()
      }
      const recovery = await checkGuestRecovery(binding, profile.signal)
      // Copy-only reads use the frozen native capture; creating a managed successor would add
      // another full original and migration before the user's explicit source-copy operation
      if (purpose === 'capture' || recovery.length) return { kind: 'legacy-recovery', binding }
      const manifest = await migrateGuestWorkspace(binding)
      profile.assertCurrent()
      return { kind: 'managed', coordinator: binding.coordinator, manifest }
    } catch (error) { coordinator.close(); throw error }
  }
}
