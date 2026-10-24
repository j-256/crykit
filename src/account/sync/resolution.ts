import { assertActiveProfile, type ProfileToken } from '../profile'
import { AccountDatabase } from '../../persistence/account-database'
import { openAccountRepository } from '../../workspace/account-repository'
import { captureAccountSyncWorkspace } from '../../workspace/account-sync-capture'
import { archiveWorkspaceUnit } from '../../workspace/pending-content'
import { blobIdentity } from '../../workspace/blobs'
import { openAccountJson } from '../../workspace/account-cache'
import { openRemoteProjection } from './projection'
import { validateConflictAuthority, assertUnchangedPublicationContinuation } from './conflict-authority'
import { SyncError } from './client'
import { requestSync } from './scheduler'
import { selectCapturedBranch } from './branch-selection'

export async function resolveAccountConflict(token: ProfileToken, id: string, choice: 'this' | 'other' | 'both', expectedLocalRevision: number): Promise<void> {
  assertActiveProfile(token)
  const database = new AccountDatabase(token.accountId)
  let captured: Awaited<ReturnType<typeof captureAccountSyncWorkspace>> | undefined
  try {
    const fence = await database.profileMeta.get('active')
    if (!fence) throw new SyncError('LOCAL_INTEGRITY_FAILED')
    captured = await captureAccountSyncWorkspace(database, token, fence)
    const local = { ...captured.workspace, state: { ...captured.workspace.state, planner: captured.operativePlanner } }, state = local.state
    if (state.planner.localData.revision !== expectedLocalRevision) throw new SyncError('LOCAL_REVISION_CONFLICT')
    const conflict = state.conflicts.find(value => value.id === id)
    if (!conflict || conflict.disposition.kind !== 'unresolved') throw new SyncError('LOCAL_REVISION_CONFLICT')
    const applied = await database.syncState.get('projection')
    if (!applied) throw new SyncError('HEAD_CONFLICT')
    const { RemoteStateSchema, readRemoteHeads } = await import('./pull')
    const snapshot = await openAccountJson(database, token, applied.ref, RemoteStateSchema)
    // The projection consumes the captured native mapping; the selected managed fence still guards publication
    const remote = await openRemoteProjection(database, token, await readRemoteHeads(database, token, snapshot.heads), local.head, expectedLocalRevision)
    const conflictUnit = remote?.units.get(JSON.stringify(['conflict', id])), authority = conflictUnit?.conflictAuthority
    if (!remote || !conflictUnit || !authority) throw new SyncError('HEAD_CONFLICT')
    await validateConflictAuthority(database, token, state, conflict, authority, remote.control)
    const anchor = remote.lineages.get(conflict.unit.privateKey)
    const mapping = conflict.unit.kind === 'directory-mapping'
    const directory = mapping ? remote.directories.get(conflict.unit.shard) : undefined
    const current = directory ? { ref: directory.ref, body: { ref: authority.branches[1].publication.body } } : anchor ? { ref: anchor.ref, body: { ref: anchor.value.selected } } : remote.units.get(conflict.unit.privateKey)
    if (!current) throw new SyncError('STALE_CONFLICT_CHOICE')
    const saveIntent = async (next: typeof state, accepted: typeof current.ref) => {
      assertActiveProfile(token)
      if (JSON.stringify(await database.profileMeta.get('active')) !== JSON.stringify(fence)) throw new SyncError('LOCAL_REVISION_CONFLICT')
      const repository = await openAccountRepository(token)
      await repository.commitWorkspace(next, expectedLocalRevision, { conflictResolution: { version: 1, conflictId: id, conflict: conflictUnit.ref, privateKey: conflict.unit.privateKey, choice, local: authority.branches[0].publication.ref, remote: accepted } })
      requestSync(token, 'save')
    }
    try {
      if (mapping) await (await import('./mapping-continuation')).assertUnchangedMappingContinuation(database, token, remote, authority.branches[1].publication)
      else {
        if (JSON.stringify(current.body.ref) !== JSON.stringify(authority.branches[1].publication.body)) throw new SyncError('STALE_CONFLICT_CHOICE')
        await assertUnchangedPublicationContinuation(database, token, current.ref, authority.branches[1].publication.ref)
      }
    } catch (error) {
      if (!(error instanceof SyncError && error.code === 'STALE_CONFLICT_CHOICE')) throw error
      // Persist the rejected captured choice without selecting it; outbox review publishes its authenticated successor first
      if (!mapping) await saveIntent(state, authority.branches[1].publication.ref)
      throw error
    }
    if ((anchor || mapping) && choice === 'both') throw new SyncError('CONFLICT_COPY_UNAVAILABLE')
    const selected = authority.branches[choice === 'this' ? 0 : 1].publication
    const copied = choice === 'both' ? await (await import('./build-copy')).prepareBuildConfigurationCopy(database, token, local, remote.workspace, authority.branches[0].publication, authority.branches[1].publication, conflict) : undefined
    const chosen = copied?.workspace ?? await selectCapturedBranch(local, remote.workspace, selected.mapping?.record ?? selected)
    const next = chosen.state
    const blobs = new Map(next.blobs.map(blob => [blobIdentity(blob.ref), blob]))
    const result = copied?.result ?? (mapping ? conflict.branches[choice === 'this' ? 0 : 1].closure : anchor ? await (await import('../../workspace/lineage-closure')).archivePersonalLineage(chosen, conflict.unit.privateKey, blobs) : await archiveWorkspaceUnit(chosen, conflict.unit.privateKey, blobs))
    const resolved = { ...next, conflicts: next.conflicts.map(value => value.id === id ? { ...value, disposition: { kind: 'resolved' as const, choice, result } } : value), blobs: [...blobs.values()] }
    await saveIntent(resolved, current.ref)
  } finally { try { await captured?.dispose() } finally { database.close() } }
}
