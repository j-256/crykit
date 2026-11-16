import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { selectedAccountCiphertext } from '../../e2e/accounts/signin-qualification-storage'
import type { Page } from '../../e2e/accounts/test-fixture'
import { AccountDatabase, activateLocalAccountCommit } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId, stageAccountJson } from '../workspace/account-cache'
import { prepareAccountWorkspace } from '../workspace/account-graph'
import { editorClosureFixture } from '../workspace/test-helpers'

const databases: AccountDatabase[] = []
afterEach(async () => { for (const database of databases.splice(0)) await database.delete(); invalidateProfile() })
// Execute the same browser callback against real IndexedDB requests in the isolated IDB implementation
const page = { evaluate: async (callback: () => Promise<unknown>) => callback() } as unknown as Page
async function fixture() {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  databases.push(database)
  const value = await editorClosureFixture()
  const prepared = await prepareAccountWorkspace(database, token, { ...value.state, editorDocuments: [value.file] })
  const root = prepared.records.find(record => record.revisionId === prepared.head.revisionId)!
  const original = prepared.records.find(record => record.revisionId !== root.revisionId && record.descriptor.dependencies.length === 0)!
  await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records })
  return { token, database, original, root }
}

it('observes every selected dependency and exact chunk while allowing unrelated inert records after key retirement', async () => {
  const { token, database, original, root } = await fixture(), before = await selectedAccountCiphertext(page)
  expect(before.rows.map(row => row.record.revisionId)).toEqual(expect.arrayContaining([original.revisionId, root.revisionId]))
  expect(before.rows.length).toBeGreaterThan(2)
  expect(before.rows.map(row => row.record.revisionId).sort()).toEqual((await database.encryptedRevisions.toArray()).map(row => row.revisionId).sort())
  expect(before.rows.every(row => row.chunks.length === row.record.descriptor.chunks.length && row.chunks.every(chunk => /^[a-f0-9]{64}$/.test(chunk.sha256)))).toBe(true)
  const inert = await stageAccountJson(database, token, { unrelated: true }, [])
  await database.encryptedRevisions.add(inert)
  invalidateProfile()
  expect(await selectedAccountCiphertext(page)).toEqual(before)
})

it.each(['revision', 'chunk'] as const)('rejects a missing reachable %s instead of returning a partial graph', async kind => {
  const { database, original } = await fixture()
  if (kind === 'revision') await database.encryptedRevisions.delete(original.revisionId)
  else await database.stagedCipherChunks.delete([original.payloadId, 0])
  await expect(selectedAccountCiphertext(page)).rejects.toThrow(kind === 'revision' ? 'Missing or contradictory selected revision' : 'Missing or contradictory selected ciphertext chunk')
})

it.each(['bytes', 'dependencies'] as const)('exposes changed reachable %s with unchanged selected pointer and row counts', async kind => {
  const { database, original, root } = await fixture(), before = await selectedAccountCiphertext(page)
  const counts = [await database.encryptedRevisions.count(), await database.stagedCipherChunks.count()]
  if (kind === 'bytes') {
    const chunk = (await database.stagedCipherChunks.get([original.payloadId, 0]))!
    chunk.bytes[0] ^= 1
    await database.stagedCipherChunks.put(chunk)
  } else await database.encryptedRevisions.put({ ...root, descriptor: { ...root.descriptor, dependencies: [] } })
  const after = await selectedAccountCiphertext(page)
  expect([await database.encryptedRevisions.count(), await database.stagedCipherChunks.count()]).toEqual(counts)
  expect(after.fence).toEqual(before.fence)
  expect(after).not.toEqual(before)
})
