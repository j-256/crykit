import type { AccountDatabase, CipherRef } from '../../persistence/account-database'
import type { ProfileToken } from '../profile'
import type { MappingContext } from '../../workspace/conflict-authority'
import { openAccountJson } from '../../workspace/account-cache'
import { openAccountSource } from '../../workspace/account-streams'
import { hashBlob } from '../../workspace/blobs'
import { sameCipherRefs } from '../../workspace/account-retaining'
import { PublicationControlSchema, BaselinePageSchema } from './publication'
import { assertPublicationDescendant, readPublicationPages, type RemoteProjection } from './projection'
import { directoryShard } from '../../workspace/directory'
import { SyncError } from './client'

export async function captureMappingContext(database: AccountDatabase, token: ProfileToken, projection: RemoteProjection, key: string): Promise<MappingContext> {
  const row = await database.encryptedRevisions.get(projection.control.revisionId)
  if (!row) throw new SyncError('INTEGRITY_FAILED')
  const record = projection.units.get(key)
  // The same selected seed can arise from two different physical heads; retain the captured one
  return { kind: 'control-baseline', control: { ref: projection.control, digest: await hashBlob(await openAccountSource(database, token, projection.control)), parents: [...row.descriptor.parents] }, directoryPhysicalHead: projection.directories.get(await directoryShard(key))!.physical, ...(record ? { recordPhysicalHead: record.physical } : {}) }
}

export async function readMappingContext(database: AccountDatabase, token: ProfileToken, context: MappingContext, acceptedControl: CipherRef) {
  // A retained/prepared control is not accepted authority merely because a conflict names it
  await assertPublicationDescendant(database, token, acceptedControl, context.control.ref)
  const row = await database.encryptedRevisions.get(context.control.ref.revisionId)
  const control = await openAccountJson(database, token, context.control.ref, PublicationControlSchema)
  if (!row || row.descriptor.accountId !== token.accountId || row.descriptor.documentId !== acceptedControl.documentId || JSON.stringify(row.descriptor.parents) !== JSON.stringify(context.control.parents) || !sameCipherRefs(row.descriptor.dependencies, [control.baseline, ...(control.recovery ? [control.recovery] : [])]) || await hashBlob(await openAccountSource(database, token, context.control.ref)) !== context.control.digest) throw new SyncError('INTEGRITY_FAILED')
  const baseline = await readPublicationPages(database, token, control.baseline, BaselinePageSchema, entry => [entry.seed])
  return { control, baseline }
}
