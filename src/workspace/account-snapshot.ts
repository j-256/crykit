import { captureCompactCatalogSnapshot } from './catalog-capture'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import type { AccountFence } from '../persistence/account-database'
import type { AccountDatabase } from '../persistence/account-database'
import type { ProfileToken } from '../account/profile'
import type { OpenAccountWorkspace } from './account-graph'
import type { AccountInheritedEvidence } from './account-evidence-snapshots'
import { ARCHIVAL_DOCUMENT_KINDS, inspectWorkspaceClosures } from './closure'
import { archiveWorkspaceUnit } from './pending-content'
import { blobIdentity } from './blobs'
import { splitWorkspace } from './documents'
import { backupMetadataDigest, backupWorkspaceDocumentDigest, disposeWorkspaceSnapshot, ownWorkspaceSnapshot, validateWorkspaceSnapshot, type WorkspaceSnapshot } from './snapshot'

export async function captureAccountSnapshot(workspace: OpenAccountWorkspace, fence: AccountFence, assertSource: () => Promise<void>, source?: { readonly database: AccountDatabase; readonly token: ProfileToken; readonly validatedEvidence?: AccountInheritedEvidence }): Promise<WorkspaceSnapshot> {
  await assertSource()
  if (source?.validatedEvidence) {
    // Even a nonmatching root must come from a real live owner before it can accompany this capture
    const { assertAccountInheritedEvidenceOwner } = await import('./account-evidence-snapshots')
    await assertAccountInheritedEvidenceOwner(source.validatedEvidence, source.database, source.token)
  }
  const output = new Map(workspace.state.blobs.map(blob => [blobIdentity(blob.ref), blob]))
  const units: NonNullable<WorkspaceSnapshot['sourceEvidence']>['units'] = []
  const projected = new Map(splitWorkspace(workspace.state).map(document => [document.key, document]))
  for (const entry of workspace.entries) {
    if (!(ARCHIVAL_DOCUMENT_KINDS as readonly string[]).includes(entry.kind) || ['blob', 'tombstone', 'unit-index', 'directory', 'directory-page'].includes(entry.kind)) continue
    const current = projected.get(entry.key)
    if (!current) throw new Error('Captured current unit has no projected record')
    const closure = await archiveWorkspaceUnit(workspace, entry.key, output)
    units.push({ key: entry.key, source: { ...entry.ref, digest: entry.digest }, projectedDigest: await backupWorkspaceDocumentDigest(current, assertSource), closure })
  }
  const state = { ...workspace.state, blobs: [...output.values()] }
  const retained = new Set<string>()
  for (const inspected of await inspectWorkspaceClosures(state, units.map(unit => unit.closure))) for (const id of inspected.refs) retained.add(id)
  const snapshot: WorkspaceSnapshot = { dataGeneration: LAUNCH_DATA_GENERATION, version: 1, snapshotId: crypto.randomUUID(), capturedAt: new Date().toISOString(), revisionVector: { committed: JSON.stringify([fence.headRevision, fence.head.documentId, fence.head.revisionId]), entries: await backupMetadataDigest(workspace.entries) }, state, sourceEvidence: { version: 1, units, blobs: [...retained].map(id => output.get(id)!.ref) } }
  await validateWorkspaceSnapshot(snapshot, undefined, assertSource)
  let disposed = false
  const check = async () => {
    if (disposed) throw new Error('Backup snapshot was released')
    await assertSource()
  }
  await check()
  const current = await captureCompactCatalogSnapshot(ownWorkspaceSnapshot(snapshot, { check, async dispose() { disposed = true } }))
  if (!workspace.inheritedEvidence) return current
  if (!source) { await disposeWorkspaceSnapshot(current); throw new Error('Account historical evidence requires its encrypted source') }
  const { accountInheritedSources, openAccountInheritedEvidence } = await import('./account-evidence-snapshots')
  const { joinWorkspaceSnapshotEvidence } = await import('../interchange/workspace-backup-evidence')
  // A fresh review can retain the exact archive already authenticated by its sync capture
  // Borrow only that root, and leave its lifetime with the caller through joined construction
  const verified = source.validatedEvidence
  const borrowed = verified?.root.documentId === workspace.inheritedEvidence.documentId && verified.root.revisionId === workspace.inheritedEvidence.revisionId ? verified : undefined
  let inherited: AccountInheritedEvidence | undefined
  let joined: WorkspaceSnapshot | undefined
  try {
    inherited = borrowed ?? await openAccountInheritedEvidence(source.database, source.token, workspace.inheritedEvidence)
    joined = await joinWorkspaceSnapshotEvidence(current, await accountInheritedSources(inherited))
    await check(); await inherited.check()
    return joined
  } catch (error) { await disposeWorkspaceSnapshot(joined ?? current); throw error }
  finally { if (!borrowed) await inherited?.dispose() }
}
