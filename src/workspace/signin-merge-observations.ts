import { assertActiveProfile, profileSignal, type ProfileToken } from '../account/profile'
import { accountWorkCheckpoint } from '../account/background-work'
import { RevisionDescriptorSchema } from '../account/protocol'
import { encodeBytes, getSodium } from '../account/crypto/sodium'
import type { AccountDatabase, CipherChunk, CipherRecord, CipherRef } from '../persistence/account-database'
import { jsonEqual } from '../persistence/local-data'
import { assertSigninMergeBudget } from './signin-merge-protocol'

export interface MergeCipherObservation { readonly record: CipherRecord; readonly chunks: readonly CipherChunk[] }
export const mergeRecordEqual = (left: CipherRecord, right: CipherRecord) => jsonEqual({ ...left, descriptor: RevisionDescriptorSchema.parse(left.descriptor) }, { ...right, descriptor: RevisionDescriptorSchema.parse(right.descriptor) })
export function uniqueMergeRecords(input: readonly CipherRecord[]): CipherRecord[] {
  const records = new Map<string, CipherRecord>(), payloads = new Map<string, string>()
  for (const value of input) {
    const record = { ...value, descriptor: RevisionDescriptorSchema.parse(value.descriptor) }
    if (record.revisionId !== record.descriptor.revisionId || records.has(record.revisionId) && !mergeRecordEqual(records.get(record.revisionId)!, record) || payloads.has(record.payloadId) && payloads.get(record.payloadId) !== record.revisionId) throw new Error('SIGNIN_RECEIPT_MISMATCH')
    records.set(record.revisionId, record); payloads.set(record.payloadId, record.revisionId)
    assertSigninMergeBudget(0, records.size, 0)
  }
  return [...records.values()]
}
export function mergeObservationBudget(records: readonly CipherRecord[]): void {
  let bytes = 0
  for (const record of records) for (const chunk of record.descriptor.chunks) { bytes += chunk.cipherBytes; assertSigninMergeBudget(0, records.length, bytes) }
}

// Descriptor resolution is only structural membership, never semantic or physical admission
// Callers retain the owners which validated domain bodies while both realms observe every chunk
export async function collectMergeClosure(database: AccountDatabase, token: ProfileToken, roots: readonly CipherRef[], supplied: readonly CipherRecord[], check: () => void): Promise<CipherRecord[]> {
  const records = new Map(uniqueMergeRecords(supplied).map(record => [record.revisionId, record])), found = new Map<string, CipherRecord>()
  const pending: CipherRef[] = [], queued = new Map<string, string>()
  const enqueue = (ref: CipherRef) => {
    const prior = queued.get(ref.revisionId)
    if (prior) { if (prior !== ref.documentId) throw new Error('SIGNIN_RECEIPT_MISMATCH'); return }
    assertSigninMergeBudget(0, queued.size + 1, 0)
    queued.set(ref.revisionId, ref.documentId); pending.push(ref)
  }
  for (const ref of roots) enqueue(ref)
  while (pending.length) {
    check(); assertActiveProfile(token)
    const ref = pending.pop()!, known = found.get(ref.revisionId)
    const record = known ?? records.get(ref.revisionId) ?? await database.encryptedRevisions.get(ref.revisionId)
    if (!record || record.descriptor.documentId !== ref.documentId || record.descriptor.accountId !== token.accountId) throw new Error('SIGNIN_RECEIPT_MISMATCH')
    if (known) continue
    assertSigninMergeBudget(0, found.size + 1, 0)
    found.set(ref.revisionId, record)
    for (const dependency of record.descriptor.dependencies) enqueue(dependency)
    await accountWorkCheckpoint(token)
  }
  const result = uniqueMergeRecords([...found.values()]); mergeObservationBudget(result); return result
}
export async function observeMergeCiphertext(database: AccountDatabase, token: ProfileToken, input: readonly CipherRecord[], check: () => void): Promise<MergeCipherObservation[]> {
  const records = uniqueMergeRecords(input); mergeObservationBudget(records)
  const sodium = await getSodium(), observations: MergeCipherObservation[] = []
  try {
    for (const record of records) {
      check(); assertActiveProfile(token); profileSignal(token).throwIfAborted()
      if (record.descriptor.accountId !== token.accountId || await database.stagedCipherChunks.where('payloadId').equals(record.payloadId).count() !== record.descriptor.chunks.length) throw new Error('SIGNIN_RECEIPT_MISMATCH')
      const chunks: CipherChunk[] = []
      observations.push({ record, chunks })
      for (const part of record.descriptor.chunks) {
        check(); profileSignal(token).throwIfAborted()
        const chunk = await database.stagedCipherChunks.get([record.payloadId, part.index])
        if (!chunk || chunk.bytes.length !== part.cipherBytes || encodeBytes(sodium, sodium.crypto_hash_sha256(chunk.bytes)) !== part.cipherDigest) throw new Error('SIGNIN_RECEIPT_MISMATCH')
        chunks.push(chunk); await accountWorkCheckpoint(token)
      }
    }
    check(); return observations
  } catch (error) { clearMergeCiphertext(observations); throw error }
}
export async function recheckMergeCiphertext(database: AccountDatabase, observations: readonly MergeCipherObservation[]): Promise<void> {
  for (const { record, chunks } of observations) {
    if (await database.stagedCipherChunks.where('payloadId').equals(record.payloadId).count() !== chunks.length) throw new Error('SIGNIN_RECEIPT_MISMATCH')
    for (const observed of chunks) {
      const actual = await database.stagedCipherChunks.get([record.payloadId, observed.index])
      if (!actual || actual.bytes.length !== observed.bytes.length || actual.bytes.some((byte, index) => byte !== observed.bytes[index])) throw new Error('SIGNIN_RECEIPT_MISMATCH')
    }
  }
}
export function clearMergeCiphertext(observations: readonly MergeCipherObservation[]): void { for (const observation of observations) for (const chunk of observation.chunks) chunk.bytes.fill(0) }
