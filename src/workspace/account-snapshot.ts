import type { AccountFence } from '../persistence/account-database'
import type { AccountDatabase } from '../persistence/account-database'
import type { ProfileToken } from '../account/profile'
import type { OpenAccountWorkspace } from './account-graph'
import { ARCHIVAL_DOCUMENT_KINDS, inspectWorkspaceClosure } from './closure'
import { archiveWorkspaceUnit } from './pending-content'
import { blobIdentity } from './blobs'
import { splitWorkspace } from './documents'
import { backupMetadataDigest, disposeWorkspaceSnapshot, ownWorkspaceSnapshot, validateWorkspaceSnapshot, type WorkspaceSnapshot } from './snapshot'

export async function captureAccountSnapshot(workspace: OpenAccountWorkspace, fence: AccountFence, assertSource: () => Promise<void>, source?: { readonly database: AccountDatabase; readonly token: ProfileToken }): Promise<WorkspaceSnapshot> {
  await assertSource()
  const output = new Map(workspace.state.blobs.map(blob => [blobIdentity(blob.ref), blob]))
  const units: NonNullable<WorkspaceSnapshot['sourceEvidence']>['units'] = []
  const projected = new Map(splitWorkspace(workspace.state).map(document => [document.key, document]))
  for (const entry of workspace.entries) {
    if (!(ARCHIVAL_DOCUMENT_KINDS as readonly string[]).includes(entry.kind) || ['blob', 'tombstone', 'unit-index', 'directory', 'directory-page'].includes(entry.kind)) continue
    const current = projected.get(entry.key)
    if (!current) throw new Error('Captured current unit has no projected record')
    const closure = await archiveWorkspaceUnit(workspace, entry.key, output)
    units.push({ key: entry.key, source: { ...entry.ref, digest: entry.digest }, projectedDigest: await backupMetadataDigest(current), closure })
  }
  const state = { ...workspace.state, blobs: [...output.values()] }
  const retained = new Set<string>()
  for (const unit of units) for (const id of (await inspectWorkspaceClosure(state, unit.closure)).refs) retained.add(id)
  const snapshot: WorkspaceSnapshot = { version: 1, snapshotId: crypto.randomUUID(), capturedAt: new Date().toISOString(), revisionVector: { committed: JSON.stringify([fence.headRevision, fence.head.documentId, fence.head.revisionId]), entries: await backupMetadataDigest(workspace.entries) }, state, sourceEvidence: { version: 1, units, blobs: [...retained].map(id => output.get(id)!.ref) } }
  await validateWorkspaceSnapshot(snapshot)
  let disposed = false
  const check = async () => {
    if (disposed) throw new Error('Backup snapshot was released')
    await assertSource()
  }
  await check()
  const current = ownWorkspaceSnapshot(snapshot, { check, async dispose() { disposed = true } })
  if (!workspace.inheritedEvidence) return current
  if (!source) { await disposeWorkspaceSnapshot(current); throw new Error('Account historical evidence requires its encrypted source') }
  const { accountInheritedSources, openAccountInheritedEvidence } = await import('./account-evidence-snapshots')
  const { joinWorkspaceSnapshotEvidence } = await import('../interchange/workspace-backup-evidence')
  const inherited = await openAccountInheritedEvidence(source.database, source.token, workspace.inheritedEvidence)
  let joined: WorkspaceSnapshot | undefined
  try {
    joined = await joinWorkspaceSnapshotEvidence(current, await accountInheritedSources(inherited))
    await check(); await inherited.check()
    return joined
  } catch (error) { await disposeWorkspaceSnapshot(joined ?? current); throw error }
  finally { await inherited.dispose() }
}
