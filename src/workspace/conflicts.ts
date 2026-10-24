import type { ConflictAuthority } from './conflict-authority'
import { accountLocalId } from './account-cache'
import type { OpenAccountWorkspace } from './account-graph'
import { archivePersonalLineage } from './lineage-closure'
import { personalLineageChains } from '../account/sync/lineage'
import { archiveWorkspaceUnit } from './pending-content'
import { blobIdentity } from './blobs'
import { splitWorkspace, type WorkspaceState, type WorkspaceConflict } from './documents'
import { validateWorkspaceClosure } from './closure'

export interface CapturedConflictInput {
  readonly base: OpenAccountWorkspace
  readonly local: OpenAccountWorkspace
  readonly remote: OpenAccountWorkspace
  readonly privateKey: string
  readonly authority?: ConflictAuthority
}
export async function createWorkspaceConflict(input: CapturedConflictInput): Promise<{ readonly conflict: WorkspaceConflict; readonly blobs: WorkspaceState['blobs'] }> {
  const { base, local, remote, privateKey } = input
  if (input.authority && (input.authority.unit.kind !== 'record' || input.authority.unit.privateKey !== privateKey)) throw new Error('Conflict authority unit mismatch')
  const lineage = input.authority?.branches[0].publication.lineage !== undefined
  const ancestor = lineage ? personalLineageChains(base.state.planner.localData).get(privateKey) : base.entries.find(entry => entry.key === privateKey)
  const archive = lineage ? archivePersonalLineage : archiveWorkspaceUnit
  // An incomplete captured index cannot turn a lost original into an initial absence
  if (!ancestor && (base.allocations.some(entry => entry.key === privateKey) || splitWorkspace(base.state).some(entry => entry.key === privateKey))) throw new Error('Common ancestor evidence is unavailable')
  if (input.authority && input.authority.commonAncestor.kind !== (ancestor ? 'present' : 'absent')) throw new Error('Conflict ancestor authority mismatch')
  const blobs = new Map<string, WorkspaceState['blobs'][number]>()
  for (const state of [base.state, local.state, remote.state]) for (const blob of state.blobs) {
    const prior = blobs.get(blobIdentity(blob.ref))
    if (prior && JSON.stringify(prior.ref) !== JSON.stringify(blob.ref)) throw new Error('Contradictory conflict body identity')
    blobs.set(blobIdentity(blob.ref), blob)
  }
  const conflict: WorkspaceConflict = {
    version: 1, id: accountLocalId(), unit: { kind: 'record', privateKey },
    commonAncestor: ancestor ? { kind: 'present', closure: await archive(base, privateKey, blobs, input.authority?.commonAncestor.kind === 'present' ? input.authority.commonAncestor.publication : undefined) } : { kind: 'absent' },
    branches: [{ role: 'local-pending', closure: await archive(local, privateKey, blobs, input.authority?.branches[0].publication) }, { role: 'accepted-cloud', closure: await archive(remote, privateKey, blobs, input.authority?.branches[1].publication) }],
    disposition: { kind: 'unresolved' },
  }
  const result = { conflict, blobs: [...blobs.values()] }
  // Alternatives validate inside their own captured closures, never by inserting incompatible immutable IDs in one active graph
  await validateWorkspaceClosure({ ...remote.state, conflicts: [...remote.state.conflicts, conflict], blobs: result.blobs })
  return result
}

export async function resolveConflict(token: import('../account/profile').ProfileToken, id: string, choice: 'this' | 'other' | 'both', expectedLocalRevision: number): Promise<void> {
  await (await import('../account/sync/resolution')).resolveAccountConflict(token, id, choice, expectedLocalRevision)
}
