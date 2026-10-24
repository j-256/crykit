import type { ProfileToken } from '../profile'
import type { AccountDatabase } from '../../persistence/account-database'
import { cloneBuild } from '../../domain/builds'
import { prepareAccountWorkspace, type OpenAccountWorkspace } from '../../workspace/account-graph'
import type { WorkspaceConflict, WorkspaceConflictClosure, WorkspaceBlobRef, WorkspaceConflictClosureEntry, WorkspaceState } from '../../workspace/documents'
import type { OriginalPublication } from '../../workspace/conflict-authority'
import { archiveWorkspaceUnit } from '../../workspace/pending-content'
import { blobIdentity, memoryBlob, hashBlob } from '../../workspace/blobs'
import { accountLocalId, cipherRef } from '../../workspace/account-cache'
import { buildCopyRoots, type BuildCopyRelation } from '../../workspace/build-copy'
import { inspectWorkspaceClosure } from '../../workspace/closure'
import { selectCapturedBranch } from './branch-selection'
import { stagePublicationRecord } from './publication'
import { readOriginalPublication } from './conflict-authority'
import { SyncError } from './client'

export async function prepareBuildConfigurationCopy(database: AccountDatabase, token: ProfileToken, local: OpenAccountWorkspace, source: OpenAccountWorkspace, pending: OriginalPublication, accepted: OriginalPublication, conflict: WorkspaceConflict): Promise<{ workspace: OpenAccountWorkspace; result: WorkspaceConflictClosure }> {
  if (pending.valueKind !== 'build' || accepted.valueKind !== 'build' || pending.privateKey !== accepted.privateKey) throw new SyncError('COPY_UNAVAILABLE')
  const pendingBranch = await selectCapturedBranch(local, source, pending)
  const sourceId = JSON.parse(pending.privateKey)[1] as import('../../domain/types').BuildId
  const clonedData = cloneBuild(pendingBranch.state.planner.localData, { sourceBuildId: sourceId })
  const copy = Object.values(clonedData.builds).find(value => !pendingBranch.state.planner.localData.builds[value.id])!
  const { journal: _journal, ...planner } = pendingBranch.state.planner
  const candidate = await prepareAccountWorkspace(database, token, { ...pendingBranch.state, planner: { ...planner, localData: clonedData } }, pendingBranch)
  await database.encryptedRevisions.bulkAdd(candidate.records)
  const copyKey = JSON.stringify(['build', copy.id])
  const copyEnvelope = await stagePublicationRecord(database, token, candidate.entries.find(entry => entry.key === copyKey)!, pending.lineageId)
  const kept = await selectCapturedBranch(local, source, accepted)
  const active = await selectCapturedBranch(kept, candidate.opened, await readOriginalPublication(database, token, cipherRef(copyEnvelope)))
  const prepared = await prepareAccountWorkspace(database, token, active.state, active)
  await database.encryptedRevisions.bulkAdd(prepared.records)
  const output = new Map(active.state.blobs.map(blob => [blobIdentity(blob.ref), blob]))
  const copied = await archiveWorkspaceUnit(prepared.opened, copyKey, output)
  const relation: BuildCopyRelation = { kind: 'build-copy', privateKey: pending.privateKey, keptRole: 'accepted-cloud', copySourceRole: 'local-pending', kept: conflict.branches[1].closure, copy: copied, source: conflict.branches[0].closure }
  async function json(value: unknown): Promise<WorkspaceBlobRef> {
    const content = memoryBlob(new TextEncoder().encode(JSON.stringify(value)))
    const ref: WorkspaceBlobRef = { documentId: accountLocalId(), revisionId: accountLocalId(), byteLength: content.byteLength, sha256: await hashBlob(content), encoding: 'utf8' }
    output.set(blobIdentity(ref), { ref, content }); return ref
  }
  const roots = buildCopyRoots(relation)
  const root = await json({ version: 1, kind: 'unit-index', roots, relation })
  const entry: WorkspaceConflictClosureEntry = { version: 1, ref: root, documentVersion: 1, kind: 'unit-index', key: JSON.stringify(['unit-index', blobIdentity(root)]), encoding: 'json', dependencies: roots }
  const index = await json({ version: 1, kind: 'conflict-closure-page', entries: [entry], children: [] })
  const result: WorkspaceConflictClosure = { version: 1, root, index }
  const state: WorkspaceState = { ...active.state, blobs: [...output.values()] }
  await inspectWorkspaceClosure(state, result)
  return { workspace: { ...prepared.opened, state }, result }
}
