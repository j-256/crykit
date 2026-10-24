import type { AccountDatabase } from '../../persistence/account-database'
import type { ProfileToken } from '../profile'
import type { OpenAccountWorkspace } from '../../workspace/account-graph'
import type { MappedWorkspaceChange } from '../../workspace/account-intents'
import { publicationDocuments } from '../../workspace/closure'
import { directoryShard } from '../../workspace/directory'
import { assertPublicationDescendant, type RemoteProjection } from './projection'

// This admits only never-accepted additions for comparison, not old-lineage updates or replacements
export async function admitFirstAllocationComparison(database: AccountDatabase, token: ProfileToken, base: RemoteProjection | undefined, remote: RemoteProjection, target: OpenAccountWorkspace, changes: readonly MappedWorkspaceChange[], mode: string): Promise<boolean> {
  if (!base || mode !== 'additive') return false
  const eligible = new Set((await publicationDocuments(target.state)).map(document => document.key))
  const semantic = changes.filter(change => change.kind !== 'workspace-identity' && (eligible.has(change.key) || change.kind === 'tombstone'))
  if (!semantic.length || semantic.some(change => change.before !== null || !change.after || change.kind === 'tombstone' || base.units.has(change.key) || base.lineages.has(change.key) || base.baseline.some(entry => entry.kind !== 'directory' && entry.key === change.key))) return false
  await assertPublicationDescendant(database, token, remote.control, base.control)
  for (const shard of new Set(await Promise.all(semantic.map(change => directoryShard(change.key))))) {
    const before = base.directories.get(shard), accepted = remote.directories.get(shard)
    if (!before || !accepted || before.allocations.some(entry => semantic.some(change => change.key === entry.key))) return false
    await assertPublicationDescendant(database, token, accepted.ref, before.ref)
  }
  return true
}
