import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountDatabase } from '../persistence/account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId, cipherRef, readAccountRecordBytes, stageAccountBytes } from './account-cache'
import { openAccountSource } from './account-streams'

afterEach(() => { vi.restoreAllMocks(); invalidateProfile() })

for (const kind of ['materialized', 'streamed'] as const) for (const revoke of [false, true]) it(`releases the native reader before ${kind} plaintext and checks completion-time revocation: ${revoke}`, async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32))
  let pending = 0, observed = 0, armed = false
  const native = IDBDatabase.prototype.transaction
  // Install before Dexie opens and captures the native method
  vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args) {
    const transaction = native.apply(this, args)
    if (transaction.mode === 'readonly' && transaction.objectStoreNames.contains('stagedCipherChunks')) {
      pending++; observed++
      transaction.addEventListener('complete', () => { pending--; if (revoke && armed) invalidateProfile() }, { once: true })
      transaction.addEventListener('abort', () => { pending-- }, { once: true })
    }
    return transaction
  })
  const database = new AccountDatabase(token.accountId)
  try {
    const expected = new TextEncoder().encode('Exact private bytes'), record = await stageAccountBytes(database, token, expected, [])
    await database.encryptedRevisions.add(record)
    armed = true
    if (kind === 'materialized') {
      if (revoke) {
        await expect(readAccountRecordBytes(database, token, cipherRef(record), record)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
        return
      }
      const bytes = await readAccountRecordBytes(database, token, cipherRef(record), record)
      try { expect(bytes).toEqual(expected); expect(observed).toBeGreaterThan(0); expect(pending).toBe(0) }
      finally { bytes.fill(0) }
    } else {
      const iterator = (await openAccountSource(database, token, cipherRef(record))).open()[Symbol.asyncIterator]()
      try {
        if (revoke) {
          await expect(iterator.next()).rejects.toThrow()
          expect(pending).toBe(0)
          return
        }
        const next = await iterator.next()
        expect(next.done).toBe(false); expect(next.value).toEqual(expected)
        expect(observed).toBeGreaterThan(0); expect(pending).toBe(0)
      } finally { await iterator.return?.() }
    }
  } finally { database.close() }
})
