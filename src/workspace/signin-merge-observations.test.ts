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
