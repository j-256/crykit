import type { WorkspaceRepository } from './repository'
import { capturedManagedGuestRepository, guestRepositoryBindings } from './guest-repository'
import { managedGuestSelection, managedGuestRecoveryNotices, stageManagedGuestWorkspaceRestore } from './guest-managed-repository'
import type { GuestManagedManifest } from './guest-managed-contract'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'
import { assertOwnedWorkspaceSnapshot, backupMetadataDigest, disposeWorkspaceSnapshot, snapshotMetadata, validateWorkspaceSnapshot, type WorkspaceSnapshot, type WorkspaceSnapshotV2 } from './snapshot'
import { inheritWorkspaceSnapshot } from '../interchange/workspace-backup-evidence'
import { guestEvidenceFromSnapshot, guestEvidenceSources, emptyPlannerEvidence } from './guest-evidence'
import { hashBlob } from './blobs'
import * as legacy from './restore'
export type { GuestRestorePreview } from './restore'

interface ManagedPreview {
  readonly repository: WorkspaceRepository
  readonly input: WorkspaceSnapshot
  readonly snapshot: WorkspaceSnapshotV2
  readonly selected: NonNullable<ReturnType<typeof managedGuestSelection>>
  readonly expected: GuestManagedManifest
  readonly digest: string
  id?: string
  stage?: Awaited<ReturnType<typeof stageManagedGuestWorkspaceRestore>>
}
const previews = new WeakMap<legacy.GuestRestorePreview, ManagedPreview>()

async function check(preview: legacy.GuestRestorePreview, authority: ManagedPreview) {
  authority.selected.assertProfile()
  if (previews.get(preview) !== authority) throw new Error('The restore preview was released')
  const active = await authority.selected.coordinator.active.get('active')
  authority.selected.assertProfile()
  if (!guestPlannerValuesEqual(active?.manifest, authority.expected)) throw new Error('The selected restore workspace changed')
  await assertOwnedWorkspaceSnapshot(authority.snapshot)
  authority.selected.assertProfile()
  if (previews.get(preview) !== authority) throw new Error('The restore preview was released')
}

export async function previewGuestWorkspaceRestore(repository: WorkspaceRepository, input: WorkspaceSnapshot): Promise<legacy.GuestRestorePreview> {
  const managed = await capturedManagedGuestRepository(repository)
  if (!managed) return legacy.previewGuestWorkspaceRestore(await guestRepositoryBindings(repository), input)
  const selected = managedGuestSelection(managed)!
  const snapshot = input.version === 2 ? input : await inheritWorkspaceSnapshot(input, [])
  try {
    await assertOwnedWorkspaceSnapshot(snapshot)
    await validateWorkspaceSnapshot(snapshot)
    const inherited = guestEvidenceSources(await guestEvidenceFromSnapshot(snapshot, emptyPlannerEvidence()))
    for (const member of inherited.members) await hashBlob(member.metadata)
    for (const body of inherited.bodies) if (await hashBlob(body.content) !== body.ref.sha256) throw new Error('Historical restore body changed')
    if ((await managedGuestRecoveryNotices(managed))!.length) throw new Error('Retained local data needs recovery before restore')
    const state = snapshot.state
    const preview: legacy.GuestRestorePreview = Object.freeze({ target: 'guest', selectedProfileId: selected.manifest.id, effect: 'replace-selected-profile', categories: Object.freeze({ planner: 1, editor: state.editorDocuments.length, save: state.saveDocuments.length, asset: state.assets.length, history: state.planner.history.length + snapshot.historicalEvidence.snapshots.length }), privateBytes: snapshot.historicalEvidence.blobs.reduce((sum, ref) => sum + ref.byteLength, 0) })
    const authority: ManagedPreview = { repository: managed, selected, expected: selected.manifest, input, snapshot, digest: await backupMetadataDigest(snapshotMetadata(snapshot)) }
    previews.set(preview, authority)
    try { await check(preview, authority); return preview }
    catch (error) { previews.delete(preview); throw error }
  } catch (error) { if (snapshot !== input) await disposeWorkspaceSnapshot(snapshot); throw error }
}

export async function releaseGuestWorkspaceRestorePreview(preview: legacy.GuestRestorePreview): Promise<void> {
  const authority = previews.get(preview)
  if (!authority) return legacy.releaseGuestWorkspaceRestorePreview(preview)
  // Only this private preview may use its prepared target; release never removes durable original/staged rows
  previews.delete(preview)
  if (authority.snapshot !== authority.input) await disposeWorkspaceSnapshot(authority.snapshot)
}

export async function beginGuestWorkspaceRestore(preview: legacy.GuestRestorePreview): Promise<{ readonly id: string }> {
  const authority = previews.get(preview)
  if (!authority) return legacy.beginGuestWorkspaceRestore(preview)
  await check(preview, authority)
  if (authority.id) throw new Error('The restore preview is already registered')
  authority.id = crypto.randomUUID()
  return { id: authority.id }
}

export async function stageGuestWorkspaceRestore(preview: legacy.GuestRestorePreview, id: string): Promise<{ readonly id: string }> {
  const authority = previews.get(preview)
  if (!authority) return legacy.stageGuestWorkspaceRestore(preview, id)
  await check(preview, authority)
  if (authority.id !== id || authority.stage) throw new Error('A fresh registered restore operation is required')
  if (await backupMetadataDigest(snapshotMetadata(authority.snapshot)) !== authority.digest) throw new Error('The restore input changed')
  authority.stage = await stageManagedGuestWorkspaceRestore(authority.repository, authority.snapshot, authority.expected, id, () => check(preview, authority))
  await check(preview, authority)
  return { id }
}

export async function activateGuestWorkspaceRestore(preview: legacy.GuestRestorePreview, id: string, assertMayActivate: () => void = () => {}) {
  const authority = previews.get(preview)
  if (!authority) return legacy.activateGuestWorkspaceRestore(preview, id, assertMayActivate)
  await check(preview, authority)
  if (authority.id !== id || !authority.stage) throw new Error('A completely staged restore is required')
  // The existing coordinator activation inserts complete immutable rows, the exact receipt and head atomically
  // A crash before that transaction leaves the old head selected; no startup code promotes staged preparation
  return authority.stage.activate(assertMayActivate)
}
