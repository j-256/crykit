import { assertActiveProfile, profileSignal, type ProfileToken } from '../account/profile'
import type { AccountDatabase, AccountFence } from '../persistence/account-database'
import { joinWorkspaceSnapshotEvidence } from '../interchange/workspace-backup-evidence'
import { createAccountLocalStore } from './account-local-store'
import { admitLocalRoot } from './local-root'
import { readLocalEvidence } from './local-evidence'
import { guestEvidenceSources, validateGuestCurrentBodies } from './guest-evidence'
import { ownWorkspaceSnapshot, validateWorkspaceSnapshot, type WorkspaceSnapshotV1, type WorkspaceSnapshot } from './snapshot'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'

// Complete export authenticates durable ciphertext again; an admitted foreground view is not a storage-health certificate
// This reader belongs to the captured account/head and cannot follow a later selection or survive a profile change
export async function captureManagedAccountSnapshot(database: AccountDatabase, token: ProfileToken, fence: AccountFence): Promise<WorkspaceSnapshot> {
  const captured = structuredClone(fence)
  return captureRetainedManagedAccountSnapshot(database, token, captured, async () => {
    assertActiveProfile(token)
    if (!guestPlannerValuesEqual(await database.profileMeta.get('active'), captured)) throw new Error('The captured account workspace changed')
    assertActiveProfile(token)
  })
}

// A saved encrypted copy owns an immutable read target after later edits or failed activation
// Its journal/profile lifetime grants read access only; this capture never selects or publishes that target
export async function captureRetainedManagedAccountSnapshot(database: AccountDatabase, token: ProfileToken, input: AccountFence, assertSource: () => Promise<void>): Promise<WorkspaceSnapshot> {
  const fence = structuredClone(input)
  let disposed = false
  const alive = () => { assertActiveProfile(token); if (disposed) throw new Error('Managed account backup capture was released') }
  const store = createAccountLocalStore(database, token)
  const check = async () => {
    alive()
    await assertSource()
    alive()
  }
  const dispose = async () => { disposed = true; await store.dispose() }
  try {
    await check()
    const fresh = await admitLocalRoot(store.adapter, fence.head, { check: alive, assertCurrent: check })
    const inherited = await readLocalEvidence(store.adapter, fresh.root.inheritedEvidence, check)
    if (inherited) await validateGuestCurrentBodies(fresh.state, inherited)
    const state = { ...fresh.state, blobs: fresh.state.blobs.map(body => ({ ref: body.ref, content: { byteLength: body.content.byteLength, async *open() {
      await check()
      for await (const bytes of body.content.open()) { await check(); yield bytes }
      await check()
    } } })) }
    const value: WorkspaceSnapshotV1 = { version: 1, snapshotId: crypto.randomUUID(), capturedAt: new Date().toISOString(), revisionVector: { committed: JSON.stringify([fence.headRevision, fence.head.documentId, fence.head.revisionId]) }, state }
    await validateWorkspaceSnapshot(value); await check()
    const current = ownWorkspaceSnapshot(value, { check, dispose })
    return inherited ? await joinWorkspaceSnapshotEvidence(current, guestEvidenceSources(inherited), { signal: profileSignal(token) }) : current
  } catch (error) { await dispose(); throw error }
}
