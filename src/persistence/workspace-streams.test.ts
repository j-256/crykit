import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { installProfile, invalidateProfile } from '../account/profile'
import { AccountDatabase } from './account-database'
import { accountLocalId, cipherRef } from '../workspace/account-cache'
import { stageAccountSource, openAccountSource } from '../workspace/account-streams'
import { memoryBlob, hashBlob } from '../workspace/blobs'

it('reopens exact encrypted source chunks and rejects stale captured readers', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  try {
    const bytes = new Uint8Array(5 * 1024 * 1024).fill(179)
    const source = memoryBlob(bytes)
    const record = await stageAccountSource(database, token, source, [])
    // A binary stream fixture is installed for reads, never selected as a workspace root
    await database.encryptedRevisions.add(record)
    const lazy = await openAccountSource(database, token, cipherRef(record))
    expect(await hashBlob(lazy)).toBe(await hashBlob(source))
    expect(await hashBlob(lazy)).toBe(await hashBlob(source))
    const reader = lazy.open()[Symbol.asyncIterator]()
    expect((await reader.next()).value).toBeInstanceOf(Uint8Array)
    invalidateProfile()
    await expect(reader.next()).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
    await expect(hashBlob(lazy)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  } finally { invalidateProfile(); await database.delete() }
})
