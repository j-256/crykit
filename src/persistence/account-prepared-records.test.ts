import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import Dexie from 'dexie'
import { installProfile, invalidateProfile } from '../account/profile'
import { plainChunkBytes } from '../account/protocol'
import { accountLocalId, cipherRef, openAccountJson, readAccountBytes, readAccountRecordBytes, stageAccountBytes, stageAccountJson } from '../workspace/account-cache'
import { stageAccountSource, openAccountSource } from '../workspace/account-streams'
import { createAccountPreparationOwner, resolveAccountRecord, runAccountStage } from '../workspace/account-prepared-records'
import { reserveFreshPullPayload } from '../account/sync/pull'
import { memoryBlob, readBlob } from '../workspace/blobs'
import { AccountDatabase } from './account-database'

let database: AccountDatabase | undefined
afterEach(async () => { invalidateProfile(); await database?.delete(); database = undefined })

it('authenticates prepared bytes, JSON, and a streamed source without installing their descriptors', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const owner = createAccountPreparationOwner(database, token)
  const root = await stageAccountJson(database, token, { version: 1, marker: 'synthetic-private-root' }, [], undefined, owner)
  const sourceBytes = new Uint8Array(plainChunkBytes + 7).fill(71)
  const source = await stageAccountSource(database, token, memoryBlob(sourceBytes), [], undefined, undefined, owner)
  await expect(readAccountBytes(database, token, cipherRef(root))).rejects.toThrow()
  await expect(openAccountSource(database, token, cipherRef(source))).rejects.toThrow()
  expect(await openAccountJson(database, token, cipherRef(root), z.object({ version: z.literal(1), marker: z.string() }), owner)).toEqual({ version: 1, marker: 'synthetic-private-root' })
  expect(await readBlob(await openAccountSource(database, token, cipherRef(source), owner), sourceBytes.length)).toEqual(sourceBytes)
  expect(await database.encryptedRevisions.count()).toBe(0)
  expect(await database.profileMeta.count()).toBe(0)
  expect(JSON.stringify(await database.stagedCipherChunks.toArray())).not.toContain('synthetic-private-root')
  await owner.releaseReaders()
  await expect(readAccountBytes(database, token, cipherRef(root), undefined, owner)).rejects.toThrow()
  await owner.abandon()
  expect(await database.stagedCipherChunks.count()).toBe(0)
})

it('abandons a reserved partial stage after a source failure without touching installed rows', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const retained = await stageAccountBytes(database, token, new Uint8Array([7, 8]), [])
  await database.encryptedRevisions.add(retained)
  const before = await Promise.all(database.tables.map(async table => [table.name, await table.toArray()]))
  const owner = createAccountPreparationOwner(database, token)
  const source = { byteLength: plainChunkBytes + 1, async *open() { yield new Uint8Array(plainChunkBytes).fill(37); throw new Error('synthetic source failure') } }
  await expect(stageAccountSource(database, token, source, [], undefined, undefined, owner)).rejects.toThrow('synthetic source failure')
  expect(await database.stagedCipherChunks.count()).toBeGreaterThan(1)
  await owner.abandon()
  expect(await database.stagedCipherChunks.toArray()).toEqual([{ payloadId: retained.payloadId, index: 0, bytes: expect.any(Uint8Array) }])
  expect(await database.encryptedRevisions.toArray()).toEqual([retained])
  expect(await Promise.all(database.tables.map(async table => [table.name, await table.toArray()]))).toEqual(before)
  expect(await readAccountBytes(database, token, cipherRef(retained))).toEqual(new Uint8Array([7, 8]))
  await owner.abandon()
})

it('keeps observed but unreserved collisions foreign and makes deletion failure retryable', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const orphanId = accountLocalId(), original = new Uint8Array([23, 24])
  await database.stagedCipherChunks.add({ payloadId: orphanId, index: 3, bytes: original })
  const loser = createAccountPreparationOwner(database, token)
  await expect(runAccountStage(database, token, orphanId, loser, async lease => { await lease.write(0, new Uint8Array([1])); throw new Error('unreachable') })).rejects.toThrow('reused')
  await loser.abandon()
  expect((await database.stagedCipherChunks.get([orphanId, 3]))?.bytes).toEqual(original)

  const owner = createAccountPreparationOwner(database, token)
  await expect(runAccountStage(database, token, accountLocalId(), owner, async lease => { await lease.write(0, new Uint8Array([9])); throw new Error('synthetic staged failure') })).rejects.toThrow('synthetic staged failure')
  const reserved = (await database.stagedCipherChunks.toArray()).find(row => row.payloadId !== orphanId)!.payloadId
  const transaction = vi.spyOn(database, 'transaction').mockRejectedValueOnce(new Error('synthetic deletion failure'))
  await expect(owner.abandon(new Error('synthetic staged failure'))).rejects.toMatchObject({ errors: [expect.any(Error), expect.any(Error)] })
  transaction.mockRestore()
  expect(await database.stagedCipherChunks.get([reserved, 0])).toBeDefined()
  await owner.abandon()
  expect(await database.stagedCipherChunks.get([reserved, 0])).toBeUndefined()
  expect((await database.stagedCipherChunks.get([orphanId, 3]))?.bytes).toEqual(original)
})

it('abandons a partially written bounded byte stage after a later quota failure', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const owner = createAccountPreparationOwner(database, token)
  const { IDBObjectStore } = await import('fake-indexeddb')
  const originalAdd = IDBObjectStore.prototype.add
  const add = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (this.name === 'stagedCipherChunks' && (value as { index: number }).index === 1) throw new DOMException('synthetic quota', 'QuotaExceededError')
    return originalAdd.call(this, value, key)
  })
  try {
    await expect(stageAccountBytes(database, token, new Uint8Array(plainChunkBytes + 1).fill(46), [], undefined, owner)).rejects.toThrow('synthetic quota')
    expect(await database.stagedCipherChunks.count()).toBe(1)
  } finally { add.mockRestore() }
  await owner.abandon()
  expect(await database.stagedCipherChunks.count()).toBe(0)
})

it('rejects a later missing chunk after streaming an authenticated early chunk and clears it on release', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const owner = createAccountPreparationOwner(database, token)
  const record = await stageAccountSource(database, token, memoryBlob(new Uint8Array(plainChunkBytes + 1).fill(18)), [], undefined, undefined, owner)
  await database.stagedCipherChunks.delete([record.payloadId, 1])
  await expect(readAccountBytes(database, token, cipherRef(record), undefined, owner)).rejects.toThrow()
  const source = await openAccountSource(database, token, cipherRef(record), owner)
  const iterator = source.open()[Symbol.asyncIterator]()
  const first = (await iterator.next()).value as Uint8Array
  expect(first[0]).toBe(18)
  await expect(iterator.next()).rejects.toThrow()
  expect(first.every(byte => byte === 0)).toBe(true)
  await owner.releaseReaders()
  await owner.abandon()
})

it('revokes an open prepared iterator before abandonment and rejects busy child adoption', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const parent = createAccountPreparationOwner(database, token)
  const child = createAccountPreparationOwner(database, token)
  const record = await stageAccountSource(database, token, memoryBlob(new Uint8Array(plainChunkBytes + 1).fill(61)), [], undefined, undefined, child)
  const source = await openAccountSource(database, token, cipherRef(record), child)
  const iterator = source.open()[Symbol.asyncIterator]()
  const first = (await iterator.next()).value as Uint8Array
  await expect(parent.adopt(child)).rejects.toThrow('busy')
  await child.releaseReaders()
  expect(first.every(byte => byte === 0)).toBe(true)
  expect(await iterator.next()).toEqual({ value: undefined, done: true })
  await parent.adopt(child)
  await child.abandon()
  expect(await database.stagedCipherChunks.where('payloadId').equals(record.payloadId).count()).toBe(2)
  expect((await readBlob(await openAccountSource(database, token, cipherRef(record), parent), plainChunkBytes + 1))[0]).toBe(61)
  await parent.abandon()
  expect(await database.stagedCipherChunks.where('payloadId').equals(record.payloadId).count()).toBe(0)
})

it('revokes paused streamed plaintext when the profile is invalidated without consumer progress', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const owner = createAccountPreparationOwner(database, token)
  const record = await stageAccountSource(database, token, memoryBlob(new Uint8Array(plainChunkBytes * 3 + 1).fill(73)), [], undefined, undefined, owner)
  let blocked!: () => void
  const atBackpressure = new Promise<void>(resolve => { blocked = resolve })
  const originalWrite = WritableStreamDefaultWriter.prototype.write
  let writes = 0
  let pendingWrite!: Promise<void>
  const write = vi.spyOn(WritableStreamDefaultWriter.prototype, 'write').mockImplementation(function (this: WritableStreamDefaultWriter<Uint8Array>, bytes: Uint8Array) {
    const result = originalWrite.call(this, bytes)
    if (++writes === 2) { pendingWrite = result; blocked() }
    return result
  })
  try {
    const source = await openAccountSource(database, token, cipherRef(record), owner)
    const iterator = source.open()[Symbol.asyncIterator]()
    const first = (await iterator.next()).value as Uint8Array
    expect(first[0]).toBe(73)
    await atBackpressure
    invalidateProfile()
    expect(first.every(byte => byte === 0)).toBe(true)
    await expect(pendingWrite).rejects.toBeDefined()
  } finally { write.mockRestore() }
  await owner.releaseReaders()
  await owner.abandon()
})

it('keeps completed prepared descriptors private across resolution and adoption', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const parent = createAccountPreparationOwner(database, token)
  const child = createAccountPreparationOwner(database, token)
  const record = await stageAccountBytes(database, token, new Uint8Array([87]), [], undefined, child)
  const original = structuredClone(record)
  const ref = cipherRef(record)
  const direct = child.prepared(ref)!
  direct.descriptor.uploadId = accountLocalId()
  direct.descriptor.keyEnvelope.nonce = original.descriptor.streamHeader
  const resolved = await resolveAccountRecord(database, token, ref, child)
  expect(resolved).toEqual(original)
  const digest = original.descriptor.chunks[0].cipherDigest
  resolved.descriptor.chunks[0].cipherDigest = `${digest[0] === 'A' ? 'B' : 'A'}${digest.slice(1)}`
  expect(await resolveAccountRecord(database, token, ref, child)).toEqual(original)
  await parent.adopt(child)
  expect(await resolveAccountRecord(database, token, ref, parent)).toEqual(original)
  await database.encryptedRevisions.add(original)
  expect(await resolveAccountRecord(database, token, ref, parent)).toEqual(original)
  expect(await readAccountBytes(database, token, ref, undefined, parent)).toEqual(new Uint8Array([87]))
  await parent.abandon()
})

it('serializes local first-write and fresh-pull allocation in both orders', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const template = await stageAccountBytes(database, token, new Uint8Array([1]), [])
  const localFirst = accountLocalId()
  const owner = createAccountPreparationOwner(database, token)
  await expect(runAccountStage(database, token, localFirst, owner, async lease => { await lease.write(0, new Uint8Array([55])); throw new Error('synthetic stop') })).rejects.toThrow('synthetic stop')
  const remote = { ...template, revisionId: accountLocalId(), payloadId: localFirst, descriptor: { ...template.descriptor, revisionId: accountLocalId() } }
  await expect(reserveFreshPullPayload(database, token, { ...remote, revisionId: remote.descriptor.revisionId })).rejects.toThrow('INTEGRITY_FAILED')
  expect((await database.stagedCipherChunks.get([localFirst, 0]))?.bytes).toEqual(new Uint8Array([55]))
  await owner.abandon()

  const pullFirst = accountLocalId()
  const remoteFirst = { ...template, payloadId: pullFirst }
  await reserveFreshPullPayload(database, token, remoteFirst)
  const loser = createAccountPreparationOwner(database, token)
  await expect(runAccountStage(database, token, pullFirst, loser, async lease => { await lease.write(0, new Uint8Array([66])); throw new Error('unreachable') })).rejects.toThrow('reused')
  await loser.abandon()
  expect(await database.encryptedRevisions.get(remoteFirst.revisionId)).toEqual(remoteFirst)
  expect(await database.stagedCipherChunks.get([pullFirst, 0])).toBeUndefined()

  const orphan = accountLocalId()
  await database.stagedCipherChunks.add({ payloadId: orphan, index: 7, bytes: new Uint8Array([7]) })
  const orphanRevisionId = accountLocalId()
  await expect(reserveFreshPullPayload(database, token, { ...template, revisionId: orphanRevisionId, payloadId: orphan, descriptor: { ...template.descriptor, revisionId: orphanRevisionId } })).rejects.toThrow('INTEGRITY_FAILED')
  expect((await database.stagedCipherChunks.get([orphan, 7]))?.bytes).toEqual(new Uint8Array([7]))
})

it('allows one first-write winner and never gives the losing owner deletion rights', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const payloadId = accountLocalId(), left = createAccountPreparationOwner(database, token), right = createAccountPreparationOwner(database, token)
  const race = (owner: typeof left, value: number) => runAccountStage(database!, token, payloadId, owner, async lease => { await lease.write(0, new Uint8Array([value])); throw new Error(`winner-${value}`) })
  const outcomes = await Promise.allSettled([race(left, 31), race(right, 41)])
  expect(outcomes.every(outcome => outcome.status === 'rejected')).toBe(true)
  const leftWon = outcomes[0].status === 'rejected' && String(outcomes[0].reason).includes('winner-31')
  const rightWon = outcomes[1].status === 'rejected' && String(outcomes[1].reason).includes('winner-41')
  expect(Number(leftWon) + Number(rightWon)).toBe(1)
  const winner = leftWon ? left : right, loser = winner === left ? right : left
  const bytes = (await database.stagedCipherChunks.get([payloadId, 0]))!.bytes
  await loser.abandon()
  expect((await database.stagedCipherChunks.get([payloadId, 0]))?.bytes).toEqual(bytes)
  await winner.abandon()
  expect(await database.stagedCipherChunks.get([payloadId, 0])).toBeUndefined()
})

it('waits for a paused owned source before deleting its reserved ciphertext', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const owner = createAccountPreparationOwner(database, token)
  const parent = createAccountPreparationOwner(database, token)
  let resume!: () => void, paused!: () => void
  const gate = new Promise<void>(resolve => { resume = resolve })
  const atPause = new Promise<void>(resolve => { paused = resolve })
  const source = { byteLength: plainChunkBytes + 1, async *open() { yield new Uint8Array(plainChunkBytes).fill(10); paused(); await gate; yield new Uint8Array([11]) } }
  const stage = stageAccountSource(database, token, source, [], undefined, undefined, owner)
  await atPause
  expect(await database.stagedCipherChunks.count()).toBe(1)
  await expect(parent.adopt(owner)).rejects.toThrow('busy')
  let cleaned = false
  const abandon = owner.abandon().then(() => { cleaned = true })
  await Promise.resolve()
  expect(cleaned).toBe(false)
  resume()
  await expect(stage).rejects.toThrow()
  await abandon
  expect(await database.stagedCipherChunks.count()).toBe(0)
  expect(cleaned).toBe(true)
})

it('settles a first IndexedDB add already in flight before abandonment returns', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const owner = createAccountPreparationOwner(database, token)
  const { IDBObjectStore } = await import('fake-indexeddb')
  const originalAdd = IDBObjectStore.prototype.add
  let queued!: () => void
  const atRequest = new Promise<void>(resolve => { queued = resolve })
  const add = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = originalAdd.call(this, value, key)
    if (this.name === 'stagedCipherChunks') queued()
    return request
  })
  try {
    const stage = stageAccountBytes(database, token, new Uint8Array([52]), [], undefined, owner)
    const settledStage = stage.then(() => undefined, error => error as Error)
    await atRequest
    // The request signal is raised within Dexie's transaction zone; the independent caller must
    // start its cleanup outside that zone, as it would from a separate user operation
    await Dexie.ignoreTransaction(() => owner.abandon())
    expect(await settledStage).toBeInstanceOf(Error)
    expect(await Dexie.ignoreTransaction(() => database!.stagedCipherChunks.count())).toBe(0)
  } finally { add.mockRestore() }
})

it('preserves an exactly installed owner record when it is abandoned', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const owner = createAccountPreparationOwner(database, token)
  const record = await stageAccountBytes(database, token, new Uint8Array([80]), [], undefined, owner)
  await database.encryptedRevisions.add(record)
  await owner.abandon()
  expect(await readAccountBytes(database, token, cipherRef(record))).toEqual(new Uint8Array([80]))
})

it('authenticates a captured raw record with exact payload and full-ref checks', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const record = await stageAccountBytes(database, token, new Uint8Array([12, 13]), [])
  const ref = cipherRef(record)
  expect(await readAccountRecordBytes(database, token, ref, record)).toEqual(new Uint8Array([12, 13]))
  await expect(readAccountRecordBytes(database, token, ref, { ...record, payloadId: 'malformed' })).rejects.toThrow()
  await expect(readAccountRecordBytes(database, token, { ...ref, documentId: accountLocalId() }, record)).rejects.toThrow()
  await expect(readAccountRecordBytes(database, token, ref, { ...record, descriptor: { ...record.descriptor, accountId: accountLocalId() } })).rejects.toThrow()
  const chunk = (await database.stagedCipherChunks.get([record.payloadId, 0]))!
  await database.stagedCipherChunks.put({ ...chunk, bytes: new Uint8Array(chunk.bytes.length).fill(99) })
  await expect(readAccountRecordBytes(database, token, ref, record)).rejects.toThrow()
})

it('rejects a duplicate prepared revision and an installed record that conflicts with its overlay', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const owner = createAccountPreparationOwner(database, token)
  const record = await stageAccountBytes(database, token, new Uint8Array([27]), [], undefined, owner)
  const duplicatePayloadId = accountLocalId()
  await expect(runAccountStage(database, token, duplicatePayloadId, owner, async lease => {
    await lease.write(0, new Uint8Array([99]))
    return { ...record, payloadId: duplicatePayloadId }
  })).rejects.toThrow('reused')
  await database.encryptedRevisions.add({ ...record, payloadId: accountLocalId() })
  await expect(readAccountBytes(database, token, cipherRef(record), undefined, owner)).rejects.toThrow('conflicts')
  await owner.abandon()
})

it('constrains streamed resolution to a captured record without granting payload authority', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const owner = createAccountPreparationOwner(database, token), bytes = new Uint8Array([41, 42, 43])
  const record = await stageAccountBytes(database, token, bytes, [], undefined, owner)
  await expect(openAccountSource(database, token, cipherRef(record), undefined, record)).rejects.toThrow()
  const captured = { ...structuredClone(record) }
  const pending = openAccountSource(database, token, cipherRef(record), owner, captured)
  captured.payloadId = accountLocalId()
  expect(await readBlob(await pending, bytes.length)).toEqual(bytes)
  await database.encryptedRevisions.add(record)
  expect(await readBlob(await openAccountSource(database, token, cipherRef(record), undefined, record), bytes.length)).toEqual(bytes)
  const variants = [
    { ...record, revisionId: accountLocalId() },
    { ...record, payloadId: accountLocalId() },
    { ...record, descriptor: { ...record.descriptor, protected: false } },
    { ...record, descriptor: { ...record.descriptor, dependencies: [cipherRef(record)] } },
    { ...record, descriptor: { ...record.descriptor, chunks: record.descriptor.chunks.map(chunk => ({ ...chunk, cipherDigest: 'A'.repeat(43) })) } },
  ]
  for (const expected of variants) await expect(openAccountSource(database, token, cipherRef(record), undefined, expected)).rejects.toThrow(/changed/)
  await owner.abandon()
})
