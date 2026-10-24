import type { ProfileToken } from '../profile'
import type { AccountDatabase } from '../../persistence/account-database'
import { accountLocalId } from '../../workspace/account-cache'
import { prepareAccountWorkspace } from '../../workspace/account-graph'
import type { WorkspaceConflict } from '../../workspace/documents'
import { archiveWorkspaceUnit } from '../../workspace/pending-content'
import { blobIdentity } from '../../workspace/blobs'
import { validateWorkspaceClosure } from '../../workspace/closure'
import { mappedChanges } from '../../workspace/account-intents'
import type { ConflictAuthority, ConflictResolutionIntent } from '../../workspace/conflict-authority'
import { readOriginalPublication, validateConflictAuthority } from './conflict-authority'
import type { RemoteProjection } from './projection'
import type { ConvergenceResult } from './convergence'
import { SyncError } from './client'
import { archivePersonalLineage } from '../../workspace/lineage-closure'
import { captureOriginalUnit, captureOriginalLineage } from './captured-unit'

export async function prepareRefreshedConflict(database: AccountDatabase, token: ProfileToken, remote: RemoteProjection, choice: ConflictResolutionIntent): Promise<ConvergenceResult> {
  const old = remote.workspace.state.conflicts.find(conflict => conflict.id === choice.conflictId)
  const original = remote.units.get(JSON.stringify(['conflict', choice.conflictId]))
  const current = remote.lineages.get(choice.privateKey) ?? remote.units.get(choice.privateKey)
  if (!old || old.disposition.kind !== 'unresolved' || !original?.conflictAuthority || !current || remote.supersededConflictIds.has(old.id)) throw new SyncError('STALE_CONFLICT_CHOICE')
  await validateConflictAuthority(database, token, remote.workspace.state, old, original.conflictAuthority, remote.control)
  const source = original.conflictAuthority.branches[0].publication
  if (JSON.stringify(source.ref) !== JSON.stringify(choice.local)) throw new SyncError('INTEGRITY_FAILED')
  const id = accountLocalId(), prior = await readOriginalPublication(database, token, original.ref)
  const blobs = new Map(remote.workspace.state.blobs.map(blob => [blobIdentity(blob.ref), blob]))
  const local = source.lineage ? await captureOriginalLineage(database, token, remote.workspace, source) : await captureOriginalUnit(remote.workspace, source)
  const archive = source.lineage ? archivePersonalLineage : archiveWorkspaceUnit
  const accepted = await readOriginalPublication(database, token, current.ref)
  const conflict: WorkspaceConflict = { version: 1, id, unit: old.unit, commonAncestor: old.commonAncestor, branches: [
    { role: 'local-pending', closure: await archive(local, choice.privateKey, blobs, source, { kind: 'conflict-successor', conflictId: id, priorId: old.id, prior, unit: old.unit }) },
    { role: 'accepted-cloud', closure: await archive(remote.workspace, choice.privateKey, blobs, accepted) },
  ], disposition: { kind: 'unresolved' } }
  const state = { ...remote.workspace.state, conflicts: [...remote.workspace.state.conflicts, conflict], blobs: [...blobs.values()] }
  await validateWorkspaceClosure(state)
  const authority: ConflictAuthority = { ...original.conflictAuthority, supersedes: { id: old.id, ref: original.ref }, branches: [{ role: 'local-pending', publication: source }, { role: 'accepted-cloud', publication: accepted }] }
  await validateConflictAuthority(database, token, state, conflict, authority, remote.control)
  const prepared = await prepareAccountWorkspace(database, token, state, remote.workspace)
  await database.encryptedRevisions.bulkAdd(prepared.records)
  return { target: prepared.opened, changes: mappedChanges(remote.workspace, prepared.opened), authorities: new Map([[JSON.stringify(['conflict', id]), authority]]), archivedBindings: [] }
}
