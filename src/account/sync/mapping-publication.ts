import type { ProfileToken } from '../profile'
import type { AccountDatabase, CipherRef } from '../../persistence/account-database'
import { openAccountJson } from '../../workspace/account-cache'
import { openAccountSource } from '../../workspace/account-streams'
import { hashBlob } from '../../workspace/blobs'
import { OriginalPublicationSchema, OriginalRecordPublicationSchema, type OriginalPublication, type MappingContext } from '../../workspace/conflict-authority'
import { DirectorySchema, DirectoryPageSchema } from './publication'
import { readPublicationPages, assertPublicationDescendant } from './projection'
import { readMappingContext } from './mapping-context'
import { validateMappingContext } from '../../workspace/mapping-context'
import { readOriginalPublication } from './conflict-authority'
import { directoryShard, directoryDocumentId } from '../../workspace/directory'
import { withAccountKey } from '../profile'
import { SyncError } from './client'

export async function readMappingPublication(database: AccountDatabase, token: ProfileToken, ref: CipherRef, privateKey: string, recordRef?: CipherRef, context?: MappingContext, acceptedControl?: CipherRef): Promise<OriginalPublication> {
  const value = await openAccountJson(database, token, ref, DirectorySchema)
  const descriptor = await database.encryptedRevisions.get(ref.revisionId)
  const expectedId = await withAccountKey(token, key => directoryDocumentId(key, token.accountId, value.shard))
  if (!descriptor || descriptor.descriptor.accountId !== token.accountId || descriptor.descriptor.revisionId !== ref.revisionId || descriptor.descriptor.documentId !== expectedId || ref.documentId !== expectedId || value.shard !== await directoryShard(privateKey) || JSON.stringify(descriptor.descriptor.dependencies) !== JSON.stringify([value.index])) throw new SyncError('INTEGRITY_FAILED')
  const entries = await readPublicationPages(database, token, value.index, DirectoryPageSchema, () => [])
  if (new Set(entries.map(entry => entry.key)).size !== entries.length || (await Promise.all(entries.map(entry => directoryShard(entry.key)))).some(shard => shard !== value.shard)) throw new SyncError('INTEGRITY_FAILED')
  const allocation = entries.find(entry => entry.key === privateKey)
  const record = recordRef ? OriginalRecordPublicationSchema.parse(await readOriginalPublication(database, token, recordRef)) : undefined
  if (!context && (allocation ? !record || record.privateKey !== privateKey || allocation.documentId !== record.ref.documentId : record !== undefined)) throw new SyncError('INTEGRITY_FAILED')
  const result = OriginalPublicationSchema.parse({ version: 1, ref, lineageId: value.lineageId, body: value.index, privateKey, valueKind: 'directory-mapping-unit', digest: await hashBlob(await openAccountSource(database, token, ref)), parents: descriptor.descriptor.parents, mapping: { shard: value.shard, index: value.index, ...(record ? { record } : {}), ...(context ? { context } : {}) } })
  if (context) {
    if (!acceptedControl) throw new SyncError('INTEGRITY_FAILED')
    const { control, baseline } = await readMappingContext(database, token, context, acceptedControl)
    const seeds = validateMappingContext(result, value, entries, control, baseline)
    await assertPublicationDescendant(database, token, ref, seeds.shardSeed)
    if (seeds.recordSeed) await assertPublicationDescendant(database, token, record!.ref, seeds.recordSeed)
  }
  return result
}
