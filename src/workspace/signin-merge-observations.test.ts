import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { AccountDatabase } from '../persistence/account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId, stageAccountJson } from './account-cache'
import { createAccountPreparationOwner } from './account-prepared-records'
import { observeMergeCiphertext, recheckMergeCiphertext } from './signin-merge-observations'

it('observes actual full ciphertext and refuses same-size edits and extra chunk indexes', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32)), database = new AccountDatabase(token.accountId)
  const owner = createAccountPreparationOwner(database, token, { operationId: accountLocalId(), check() {} })
  try {
    const record = await stageAccountJson(database, token, { private: 'fixture' }, [], undefined, owner)
    const observations = await observeMergeCiphertext(database, token, [record], () => owner.check())
    await recheckMergeCiphertext(database, observations)
    const chunk = (await database.stagedCipherChunks.get([record.payloadId, 0]))!
    const altered = chunk.bytes.slice(); altered[0] ^= 1
    await database.stagedCipherChunks.put({ ...chunk, bytes: altered })
    await expect(recheckMergeCiphertext(database, observations)).rejects.toThrow()
    await expect(observeMergeCiphertext(database, token, [record], () => owner.check())).rejects.toThrow()
    await database.stagedCipherChunks.put(chunk)
    await database.stagedCipherChunks.add({ ...chunk, index: record.descriptor.chunks.length })
    await expect(observeMergeCiphertext(database, token, [record], () => owner.check())).rejects.toThrow()
  } finally { await owner.abandon(); await database.delete(); invalidateProfile() }
})

it('reports the real first over-limit descriptor prefix before any ciphertext observation', async () => {
  const { vi } = await import('vitest')
  const { plainChunkBytes, streamOverheadBytes, RevisionDescriptorSchema } = await import('../account/protocol')
  const { collectMergeClosure, mergeObservationBudget } = await import('./signin-merge-observations')
  const { signinMergeResourceFailure, SIGNIN_MERGE_LIMITS } = await import('./signin-merge-protocol')
  const token = installProfile(accountLocalId(), new Uint8Array(32)), database = new AccountDatabase(token.accountId)
  const owner = createAccountPreparationOwner(database, token, { operationId: accountLocalId(), check() {} })
  try {
    const template = await stageAccountJson(database, token, { synthetic: true }, [], undefined, owner)
    // Valid bounded descriptors reach the real pre-observation guard without allocating large bodies
    // They are structural inputs only, not a claim that their absent payloads authenticate
    const chunks = Array.from({ length: 16 }, (_, index) => ({ ...template.descriptor.chunks[0], index, cipherBytes: plainChunkBytes + streamOverheadBytes }))
    const records = Array.from({ length: 3 }, () => {
      const revisionId = accountLocalId()
      return { revisionId, payloadId: accountLocalId(), descriptor: RevisionDescriptorSchema.parse({ ...template.descriptor, documentId: accountLocalId(), revisionId, plainBytes: plainChunkBytes * chunks.length, chunks }) }
    })
    let observed: ReturnType<typeof signinMergeResourceFailure>
    try { mergeObservationBudget(records) } catch (error) { observed = signinMergeResourceFailure(error) }
    const prefix = SIGNIN_MERGE_LIMITS.observationBytes / plainChunkBytes * (plainChunkBytes + streamOverheadBytes)
    expect(observed!).toEqual({ dimension: 'observationBytes', value: prefix, limit: SIGNIN_MERGE_LIMITS.observationBytes, basis: 'counted-byte-prefix', records: records.length })
    expect(prefix).toBeLessThan(records.reduce((sum, record) => sum + record.descriptor.chunks.reduce((total, chunk) => total + chunk.cipherBytes, 0), 0))
    const reads = vi.spyOn(database.stagedCipherChunks, 'where')
    await expect(observeMergeCiphertext(database, token, records, () => owner.check())).rejects.toThrow('SIGNIN_MERGE_RESOURCE_LIMIT')
    await expect(collectMergeClosure(database, token, records.map(record => ({ documentId: record.descriptor.documentId, revisionId: record.revisionId })), records, () => owner.check())).rejects.toThrow('SIGNIN_MERGE_RESOURCE_LIMIT')
    expect(reads).not.toHaveBeenCalled()
    reads.mockRestore()
  } finally { await owner.abandon(); await database.delete(); invalidateProfile() }
})
