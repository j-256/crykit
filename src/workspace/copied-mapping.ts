import type { ProfileToken } from '../account/profile'
import type { AccountDatabase } from '../persistence/account-database'
import type { OpenAccountWorkspace } from './account-graph'
import type { RemoteProjection } from '../account/sync/projection'
import type { WorkspaceConflict, WorkspaceState } from './documents'
import type { ConflictAuthority } from './conflict-authority'
import { cipherRef } from './account-cache'
import { blobIdentity } from './blobs'
import { directoryShard } from './directory'
import { stagePublicationDirectory, stagePublicationRecord } from '../account/sync/publication'
import { readMappingPublication } from '../account/sync/mapping-publication'
import { captureMappingContext } from '../account/sync/mapping-context'
import { archiveDirectoryMapping } from '../account/sync/mapping-archive'
import { validateWorkspaceClosure } from './closure'

export async function reconstructCopiedMapping(database: AccountDatabase, token: ProfileToken, input: { id: string; key: string; pending: OpenAccountWorkspace; remote: RemoteProjection; retained: WorkspaceState }) {
  const { key, pending, remote, retained } = input
  const shard = await directoryShard(key), accepted = remote.directories.get(shard)!, current = remote.units.get(key)!
  const mine = pending.entries.find(entry => entry.key === key)!
  if (!accepted || !current || !mine || mine.ref.documentId === current.ref.documentId) throw new Error('Copied mapping requires distinct destination allocations')
  const record = cipherRef(await stagePublicationRecord(database, token, mine, remote.lineageId))
  // A bulk control can own effective allocations omitted from its physical shard
  // Rebuild from this destination's complete effective membership, never source sibling mappings
  const effective = new Map([...accepted.allocations, ...[...remote.units].map(([privateKey, unit]) => ({ key: privateKey, documentId: unit.ref.documentId })), ...[...remote.lineages].map(([privateKey, unit]) => ({ key: privateKey, documentId: unit.ref.documentId }))].map(allocation => [allocation.key, allocation]))
  effective.set(key, { key, documentId: mine.ref.documentId })
  const allocations = []
  for (const allocation of effective.values()) if (await directoryShard(allocation.key) === shard) allocations.push(allocation)
  const envelope = await stagePublicationDirectory(database, token, remote.lineageId, shard, allocations, accepted.ref)
  const context = accepted.allocations.some(allocation => allocation.key === key) ? undefined : await captureMappingContext(database, token, remote, key)
  const ancestor = await readMappingPublication(database, token, accepted.ref, key, current.ref, context, remote.control)
  const alternative = await readMappingPublication(database, token, envelope, key, record)
  const authority: ConflictAuthority = { version: 1, unit: { kind: 'directory-mapping', privateKey: key, shard }, lineageId: remote.lineageId, commonAncestor: { kind: 'present', publication: ancestor }, branches: [{ role: 'local-pending', publication: alternative }, { role: 'accepted-cloud', publication: ancestor }] }
  const blobs = new Map([...retained.blobs, ...pending.state.blobs].map(blob => [blobIdentity(blob.ref), blob]))
  const original = await archiveDirectoryMapping(database, token, remote.workspace, ancestor, blobs)
  const conflict: WorkspaceConflict = { version: 1, id: input.id, unit: authority.unit, commonAncestor: { kind: 'present', closure: original }, branches: [{ role: 'local-pending', closure: await archiveDirectoryMapping(database, token, pending, alternative, blobs) }, { role: 'accepted-cloud', closure: original }], disposition: { kind: 'unresolved' } }
  const state = { ...retained, conflicts: [...retained.conflicts, conflict], blobs: [...blobs.values()] }
  await validateWorkspaceClosure(state)
  return { state, authority, binding: { body: mine.ref, publication: record } }
}
