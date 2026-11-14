import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { AccountDatabase } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId, cipherRef, stageAccountJson } from '../workspace/account-cache'
import { stagePublicationPages } from '../account/sync/publication'
import { writeSyncState } from '../account/sync/outbox'
import { maxDependencies } from '../account/protocol'
import { pauseReviewedReplacement } from '../workspace/reviewed-replacement'

let database: AccountDatabase | undefined
afterEach(async () => { invalidateProfile(); await database?.delete() })
it('retains a complete reviewed head set through its paged root without exceeding the encrypted dependency bound', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const heads = []
  for (let i = 0; i <= maxDependencies; i++) {
    const record = await stageAccountJson(database, token, { synthetic: i }, [])
    await database.encryptedRevisions.add(record)
    heads.push(cipherRef(record))
  }
  const root = await stagePublicationPages(database, token, 'local-remote-heads', heads, ref => [ref])
  const operationId = accountLocalId()
  const value = { version: 1 as const, kind: 'reviewed-replacement' as const, operationId, intentId: accountLocalId(), recoveryOperationId: operationId, reviewedEpoch: 1, reviewedHeads: heads, reviewedHeadRoot: root, state: 'active' as const }
  const row = await writeSyncState(database, token, 'reviewed-replacement', value, undefined, [root])
  const paused = await pauseReviewedReplacement(database, token, { row, value }, 'remote-advanced')
  expect(paused.value.reviewedHeads).toEqual(heads)
  const descriptor = (await database.encryptedRevisions.get(paused.row.ref.revisionId))!.descriptor
  expect(descriptor.dependencies).toEqual([root])
})
