import { captureProfileEpoch } from '../account/profile'
import { joinWorkspaceSnapshotEvidence } from '../interchange/workspace-backup-evidence'
import type { GuestCoordinatorDatabase } from './guest-coordinator'
import { createGuestLocalStore, type GuestManagedManifest } from './guest-local-store'
import { admitLocalRoot } from './local-root'
import { readLocalEvidence } from './local-evidence'
import { guestEvidenceSources, validateGuestCurrentBodies } from './guest-evidence'
import { ownWorkspaceSnapshot, validateWorkspaceSnapshot, type WorkspaceSnapshotV1, type WorkspaceSnapshot } from './snapshot'

// Export reopens actual durable records instead of certifying a prepared view as storage health
// The captured pointer and profile remain fixed even if the ordinary planner wrapper advances
export async function captureManagedGuestSnapshot(database: GuestCoordinatorDatabase, manifest: GuestManagedManifest, assertRetainedReady: () => void): Promise<WorkspaceSnapshot> {
  const profile = captureProfileEpoch()
  let disposed = false
  const alive = () => { profile.assertCurrent(); assertRetainedReady(); if (disposed) throw new Error('Managed backup capture was released') }
  const store = createGuestLocalStore(database, alive)
  const check = async () => { alive(); await store.assertCurrent(manifest); alive() }
  const dispose = async () => { disposed = true }
  try {
    await check()
    const fresh = await admitLocalRoot(store.adapter, manifest.root, { check: alive, assertCurrent: check })
    const inherited = await readLocalEvidence(store.adapter, fresh.root.inheritedEvidence, check)
    if (inherited) await validateGuestCurrentBodies(fresh.state, inherited)
    const state = { ...fresh.state, blobs: fresh.state.blobs.map(body => ({ ref: body.ref, content: { byteLength: body.content.byteLength, async *open() {
      await check()
      for await (const bytes of body.content.open()) { await check(); yield bytes }
      await check()
    } } })) }
    const value: WorkspaceSnapshotV1 = { version: 1, snapshotId: crypto.randomUUID(), capturedAt: new Date().toISOString(), revisionVector: { guest: manifest.id, managedRoot: JSON.stringify(manifest.root), managedRevision: String(manifest.revision) }, state }
    await validateWorkspaceSnapshot(value); await check()
    const current = ownWorkspaceSnapshot(value, { check, dispose })
    return inherited ? await joinWorkspaceSnapshotEvidence(current, guestEvidenceSources(inherited), { signal: profile.signal }) : current
  } catch (error) { await dispose(); throw error }
}
