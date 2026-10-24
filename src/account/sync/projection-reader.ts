import { assertActiveProfile, type ProfileToken } from '../profile'
import { CipherRefSchema } from '../../workspace/account-cache'
import type { CapturedRecordReader } from '../../workspace/account-evidence'
import { SyncError } from './client'

// Only one immutable projection read owns this memo; callers dispose it before returning any workspace reader
export function createProjectionReader(token: ProfileToken, source: CapturedRecordReader) {
  const records = new Map<string, ReturnType<CapturedRecordReader>>()
  let disposed = false
  const read: CapturedRecordReader = async input => {
    assertActiveProfile(token)
    if (disposed) throw new SyncError('LOCAL_INTEGRITY_FAILED')
    const ref = CipherRefSchema.parse(input), identity = JSON.stringify([ref.documentId, ref.revisionId])
    let record = records.get(identity)
    if (!record) { record = source(ref); records.set(identity, record) }
    const result = await record
    assertActiveProfile(token)
    if (disposed) throw new SyncError('LOCAL_INTEGRITY_FAILED')
    return result
  }
  return { read, dispose: () => { disposed = true; records.clear() } }
}
