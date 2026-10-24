import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { installProfile, invalidateProfile } from '../account/profile'
import { AccountDatabase } from './account-database'
import { accountLocalId, cipherRef, stageAccountJson } from '../workspace/account-cache'
import { readAccountRetainingEdges } from '../workspace/account-retaining'

for (const malformed of ['foreign', 'missing', 'duplicate', 'descriptor'] as const) it(`rejects authenticated malformed retaining pages: ${malformed}`, async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    const leaf = { documentId: accountLocalId(), revisionId: accountLocalId() }, privateKey = '["library-defaults"]'
    const page = { version: 1, kind: 'local-retaining-edges', privateKey: malformed === 'foreign' ? 'foreign' : privateKey, entries: malformed === 'missing' ? [] : malformed === 'duplicate' ? [leaf, leaf] : [leaf], children: malformed === 'missing' ? [leaf] : [] }
    const record = await stageAccountJson(database, token, page, malformed === 'descriptor' ? [] : [leaf])
    await database.encryptedRevisions.put(record)
    await expect(readAccountRetainingEdges(database, token, privateKey, cipherRef(record))).rejects.toThrow()
  } finally { invalidateProfile(); await database.delete() }
})
