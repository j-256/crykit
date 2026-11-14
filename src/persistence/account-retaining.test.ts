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

it('restages unchanged archived bytes when their expanded retention edges become active and then reuses stable edges', async () => {
  const { prepareAccountWorkspace, openAccountWorkspace } = await import('../workspace/account-graph')
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const { blobIdentity } = await import('../workspace/blobs')
  const { privateRecordKey } = await import('../workspace/documents')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    const fixture = await editorClosureFixture()
    const inert = await prepareAccountWorkspace(database, token, { ...fixture.state, retainedContent: [] })
    await database.encryptedRevisions.bulkAdd(inert.records)
    const key = privateRecordKey('blob', blobIdentity(fixture.closure.index)), before = inert.entries.find(entry => entry.key === key)!
    const active = await prepareAccountWorkspace(database, token, fixture.state, inert.opened)
    await database.encryptedRevisions.bulkAdd(active.records)
    const after = active.entries.find(entry => entry.key === key)!
    expect(after.digest).toBe(before.digest)
    expect(after.ref.documentId).toBe(before.ref.documentId)
    expect(after.ref.revisionId).not.toBe(before.ref.revisionId)
    expect((await database.encryptedRevisions.get(after.ref.revisionId))!.descriptor.parents).toEqual([before.ref.revisionId])
    const reopened = await openAccountWorkspace(database, token, active.head)
    expect(reopened.state.retainedContent).toEqual(fixture.state.retainedContent)
    const unchanged = await prepareAccountWorkspace(database, token, fixture.state, reopened)
    expect(unchanged.entries.find(entry => entry.key === key)!.ref).toEqual(after.ref)
  } finally { invalidateProfile(); await database.delete() }
})
