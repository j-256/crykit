import { assertActiveProfile, type ProfileToken } from '../profile'
import { AccountDatabase } from '../../persistence/account-database'
import { openAccountJson } from '../../workspace/account-cache'
import type { WorkspaceState } from '../../workspace/documents'
import { openRemoteProjection } from './projection'
import { isManagedAccountHead } from '../../workspace/account-sync-capture'
import { readIncrementalMappedRoot } from '../../workspace/account-mapping-origin'
import { guestPlannerValuesEqual } from '../../persistence/guest-planner-equality'

export async function publishedSupersededConflicts(token: ProfileToken, state: WorkspaceState): Promise<ReadonlySet<string>> {
  assertActiveProfile(token)
  if (!state.conflicts.some(conflict => conflict.disposition.kind === 'unresolved')) return new Set()
  const database = new AccountDatabase(token.accountId)
  try {
    const fence = await database.profileMeta.get('active'), row = await database.syncState.get('projection')
    if (!fence || !row) return new Set()
    // Display hints never start mapping or treat a compact selected root as a native projection
    const nativeHead = await isManagedAccountHead(database, token, fence) ? await readIncrementalMappedRoot(database, token, fence) : fence.head
    if (!nativeHead) return new Set()
    const { RemoteStateSchema, readRemoteHeads } = await import('./pull')
    const snapshot = await openAccountJson(database, token, row.ref, RemoteStateSchema)
    const remote = await openRemoteProjection(database, token, await readRemoteHeads(database, token, snapshot.heads), nativeHead, state.planner.localData.revision)
    const result = new Set<string>()
    for (const conflict of remote?.workspace.state.conflicts ?? []) {
      const authority = remote!.units.get(JSON.stringify(['conflict', conflict.id]))!.conflictAuthority!
      if (!authority.supersedes) continue
      const local = state.conflicts.find(value => value.id === conflict.id)
      // A locally staged relationship cannot hide an old choice; the exact frozen comparison must already be published
      const localPrior = state.conflicts.find(value => value.id === authority.supersedes!.id), remotePrior = remote!.workspace.state.conflicts.find(value => value.id === authority.supersedes!.id)
      if (local && localPrior && JSON.stringify(localPrior) === JSON.stringify(remotePrior) && JSON.stringify([local.unit, local.commonAncestor, local.branches]) === JSON.stringify([conflict.unit, conflict.commonAncestor, conflict.branches])) result.add(authority.supersedes.id)
    }
    assertActiveProfile(token)
    if (!guestPlannerValuesEqual(await database.profileMeta.get('active'), fence)) return new Set()
    assertActiveProfile(token)
    return result
  } finally { database.close() }
}
