import type { ProfileToken } from '../profile'
import type { AccountDatabase, CipherRef } from '../../persistence/account-database'
import type { OpenAccountWorkspace, AccountWorkspaceEntry } from '../../workspace/account-graph'
import { accountLocalId, cipherRef } from '../../workspace/account-cache'
import { blobIdentity } from '../../workspace/blobs'
import type { WorkspaceState, WorkspaceConflict } from '../../workspace/documents'
import type { ConflictAuthority } from '../../workspace/conflict-authority'
import { validateWorkspaceClosure } from '../../workspace/closure'
import { directoryShard } from '../../workspace/directory'
import { stagePublicationDirectory, stagePublicationRecord } from './publication'
import { readMappingPublication } from './mapping-publication'
import { archiveDirectoryMapping } from './mapping-archive'
import type { RemoteProjection } from './projection'
import { SyncError } from './client'
import { captureMappingContext } from './mapping-context'
import { assertPublicationDescendant } from './projection'

export async function createMappingConflict(database: AccountDatabase, token: ProfileToken, base: RemoteProjection | undefined, local: OpenAccountWorkspace, remote: RemoteProjection, mine: AccountWorkspaceEntry, retained: WorkspaceState, candidate?: CipherRef) {
  const key = mine.key, shard = await directoryShard(key), before = base?.directories.get(shard), accepted = remote.directories.get(shard), other = remote.units.get(key)
  if (!base || !before || !accepted || !other || base.units.has(key) || before.allocations.some(entry => entry.key === key)) throw new SyncError('HEAD_CONFLICT')
  await assertPublicationDescendant(database, token, remote.control, base.control)
  await assertPublicationDescendant(database, token, accepted.ref, before.ref)
  const context = base.lineageId !== remote.lineageId || !accepted.allocations.some(entry => entry.key === key)
  const record = candidate ?? cipherRef(await stagePublicationRecord(database, token, mine, base.lineageId))
  if (candidate) {
    const original = await (await import('./conflict-authority')).readOriginalPublication(database, token, candidate)
    if (original.parents.length || original.privateKey !== key || original.valueKind !== mine.kind || original.digest !== mine.digest || JSON.stringify(original.body) !== JSON.stringify(mine.ref) || JSON.stringify(original.sourceBookkeeping) !== JSON.stringify(mine.sourceBookkeeping)) throw new SyncError('INTEGRITY_FAILED')
  }
  const allocation = await stagePublicationDirectory(database, token, base.lineageId, shard, [...before.allocations, { key, documentId: mine.ref.documentId }], before.ref)
  const ancestor = await readMappingPublication(database, token, before.ref, key, undefined, context ? await captureMappingContext(database, token, base, key) : undefined, remote.control)
  const pending = await readMappingPublication(database, token, allocation, key, record)
  const cloud = await readMappingPublication(database, token, accepted.ref, key, other.ref, context ? await captureMappingContext(database, token, remote, key) : undefined, remote.control)
  const authority: ConflictAuthority = { version: 1, unit: { kind: 'directory-mapping', privateKey: key, shard }, lineageId: base.lineageId, commonAncestor: { kind: 'present', publication: ancestor }, branches: [{ role: 'local-pending', publication: pending }, { role: 'accepted-cloud', publication: cloud }] }
  const blobs = new Map([...retained.blobs, ...local.state.blobs].map(blob => [blobIdentity(blob.ref), blob]))
  const conflict: WorkspaceConflict = { version: 1, id: accountLocalId(), unit: authority.unit, commonAncestor: { kind: 'present', closure: await archiveDirectoryMapping(database, token, base.workspace, ancestor, blobs) }, branches: [{ role: 'local-pending', closure: await archiveDirectoryMapping(database, token, local, pending, blobs) }, { role: 'accepted-cloud', closure: await archiveDirectoryMapping(database, token, remote.workspace, cloud, blobs) }], disposition: { kind: 'unresolved' } }
  const state = { ...retained, conflicts: [...retained.conflicts, conflict], blobs: [...blobs.values()] }
  await validateWorkspaceClosure(state)
  return { state, conflict, authority, binding: { body: mine.ref, publication: record } }
}
