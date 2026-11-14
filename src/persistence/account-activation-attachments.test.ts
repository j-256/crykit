import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it } from 'vitest'
import { AccountDatabase, activateLocalAccountCommit } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId, openAccountJson } from '../workspace/account-cache'
import { prepareAccountWorkspace } from '../workspace/account-graph'
import { editorClosureFixture } from '../workspace/test-helpers'
import { z } from 'zod'

let database: AccountDatabase | undefined
afterEach(async () => { invalidateProfile(); await database?.delete() })

it('installs an encrypted decision atomically with the selected head and rejects stale receipt authority', async () => {
  const attachments = await import('./account-activation-attachments')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const workspace = await prepareAccountWorkspace(database, token, (await editorClosureFixture()).state)
  const prepared = { version: 1 as const, id: accountLocalId(), expected: undefined, head: workspace.head, records: workspace.records }
  const receipt = await attachments.prepareAccountReceiptAttachment(database, token, prepared, { id: 'signin-receipt:decision', expected: undefined, value: { version: 1, choice: 'copy' } })
  const before = await Promise.all(database.tables.map(async table => ({ name: table.name, rows: await table.toArray() })))
  let activationChecks = 0
  await expect(activateLocalAccountCommit(database, token, prepared, () => {
    activationChecks++
    if (activationChecks === 2) {
      expect(Dexie.currentTransaction?.active).toBe(true)
      throw new Error('rollback after attachment installation')
    }
  }, receipt)).rejects.toThrow('rollback after attachment installation')
  expect(activationChecks).toBe(2)
  expect(await Promise.all(database.tables.map(async table => ({ name: table.name, rows: await table.toArray() })))).toEqual(before)
  expect(await database.syncState.get('signin-receipt:decision')).toBeUndefined()
  expect(await database.profileMeta.get('active')).toBeUndefined()
  await activateLocalAccountCommit(database, token, prepared, undefined, receipt)
  const row = (await database.syncState.get('signin-receipt:decision'))!
  expect(await openAccountJson(database, token, row.ref, z.unknown())).toEqual({ version: 1, choice: 'copy' })
  const fence = (await database.profileMeta.get('active'))!
  const stale = await attachments.prepareAccountReceiptAttachment(database, token, { expected: fence, head: fence.head }, { id: row.id, expected: row, value: { choice: 'account' } })
  await database.profileMeta.put({ ...fence, headRevision: fence.headRevision + 1 })
  await expect(attachments.commitAccountReceipt(database, token, stale)).rejects.toThrow('LOCAL_REVISION_CONFLICT')
  expect(await database.syncState.get(row.id)).toEqual(row)
})

it('records a head-bound account-only decision without creating an intent or incrementing its fence', async () => {
  const attachments = await import('./account-activation-attachments')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const workspace = await prepareAccountWorkspace(database, token, (await editorClosureFixture()).state)
  const fence = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: workspace.head, records: workspace.records })
  const receipt = await attachments.prepareAccountReceiptAttachment(database, token, { expected: fence, head: fence.head }, { id: 'signin-receipt:account', expected: undefined, value: { choice: 'account' } })
  await attachments.commitAccountReceipt(database, token, receipt)
  expect(await database.profileMeta.get('active')).toEqual(fence)
  expect(await database.outbox.count()).toBe(0)
  expect(await database.syncState.get('signin-receipt:account')).toBeDefined()
})
