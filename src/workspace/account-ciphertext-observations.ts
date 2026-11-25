import type { AccountDatabase, CipherRecord, CipherChunk } from '../persistence/account-database'
import { RevisionDescriptorSchema } from '../account/protocol'

export interface Observation { readonly record: CipherRecord; readonly chunks: readonly CipherChunk[] }
// Fixed wrapper order preserves equality across equivalent IndexedDB records and retains the complete authenticated descriptor
const normalizedRecord = (value: CipherRecord) => ({ revisionId: value.revisionId, payloadId: value.payloadId, descriptor: RevisionDescriptorSchema.parse(value.descriptor) })
export const sameCipherRecord = (a: CipherRecord, b: CipherRecord) => JSON.stringify(normalizedRecord(a)) === JSON.stringify(normalizedRecord(b))

export function sameObservation(a: Observation, b: Observation) {
  return sameCipherRecord(a.record, b.record) && a.chunks.length === b.chunks.length
    && a.chunks.every((chunk, index) => { const other = b.chunks[index]; return chunk.payloadId === other.payloadId && chunk.index === other.index && sameCiphertext(chunk.bytes, other.bytes) })
}

export function sameCiphertext(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export async function recheckCiphertextObservations(database: AccountDatabase, observations: Iterable<Observation>) {
  for (const { record, chunks } of observations) {
    const actualRecord = await database.encryptedRevisions.get(record.revisionId)
    // Schema parsing normalizes field order without dropping any authenticated descriptor field
    if (!actualRecord || !sameCipherRecord(actualRecord, record)) throw new Error('Consumed encrypted descriptor changed')
    for (const captured of chunks) {
      const actual = await database.stagedCipherChunks.get([captured.payloadId, captured.index])
      if (!actual || !sameCiphertext(actual.bytes, captured.bytes)) throw new Error('Consumed encrypted bytes changed')
    }
  }
}
