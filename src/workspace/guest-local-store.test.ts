import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { GuestCoordinatorDatabase } from './guest-coordinator'
import { createGuestLocalStore } from './guest-local-store'
import { memoryBlob, readBlob } from './blobs'

const MAX_QUEUED_CHUNK_READS = 32

it('atomically publishes one managed head and rejects stale heads or revoked command owners', async () => {
  const database = new GuestCoordinatorDatabase(`synthetic-managed-${crypto.randomUUID()}`)
  const check = () => {}
  const store = createGuestLocalStore(database, check)
  const source = memoryBlob(new Uint8Array([1, 2, 3]))
  const first = await store.adapter.stage('first', source, [])
  const initial = await store.activate('first', first, undefined, check)
  expect((await database.active.get('active'))?.manifest).toEqual(initial.target)
  expect(await readBlob(await store.adapter.read(first), 3)).toEqual(new Uint8Array([1, 2, 3]))
  const second = await store.adapter.stage('second', source, [first])
  const loser = await store.adapter.stage('loser', source, [first])
  const next = await store.activate('second', second, initial.target, check)
  await expect(store.activate('loser', loser, initial.target, check)).rejects.toThrow(/changed/)
  expect(await store.receipt('second')).toEqual(next)
  expect(await store.receipt('loser')).toBeUndefined()
  const changed = await store.adapter.stage('changed', source, [second])
  expect(await database.table('managedRecords').get(changed.revisionId)).toBeUndefined()
  await expect(store.activate('changed', changed, next.target, () => { throw new Error('Owner changed') })).rejects.toThrow(/changed/)
  expect((await database.active.get('active'))?.manifest).toEqual(next.target)
  database.close()
})

it('detects same-length corruption in a durable metadata frame before interpreting it', async () => {
  const database = new GuestCoordinatorDatabase(`synthetic-managed-integrity-${crypto.randomUUID()}`)
  const store = createGuestLocalStore(database, () => {})
  const bytes = new TextEncoder().encode('{"version":1,"value":"original"}')
  const ref = await store.adapter.stage('metadata', memoryBlob(bytes), [])
  await store.activate('metadata', ref, undefined, () => {})
  const reopened = createGuestLocalStore(database, () => {})
  expect(await readBlob(await reopened.adapter.read(ref), bytes.length)).toEqual(bytes)
  const chunk = await database.table('managedChunks').get([ref.revisionId, 0])
  chunk.bytes[chunk.bytes.length - 3] ^= 1
  await database.table('managedChunks').put(chunk)
  await expect(readBlob(await reopened.adapter.read(ref), bytes.length)).rejects.toThrow()
  database.close()
})

it('reads bounded recovery evidence and its exact head in one readonly window before hashing', async () => {
  const transaction = IDBDatabase.prototype.transaction
  let reads = 0
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    if (!args[1] || args[1] === 'readonly') reads++
    return Reflect.apply(transaction, this, args)
  }
  const database = new GuestCoordinatorDatabase(`synthetic-managed-read-window-${crypto.randomUUID()}`)
  try {
    let owned = true
    const check = () => { if (!owned) throw new Error('Owner changed') }
    const store = createGuestLocalStore(database, check)
    const bytes = new Uint8Array(128 * 1024 + 7).fill(19)
    const ref = await store.adapter.stage('evidence', memoryBlob(bytes), [])
    const receipt = await store.activate('evidence', ref, undefined, check)
    reads = 0
    expect(await store.readBounded(ref, bytes.length, receipt.target, check)).toEqual(bytes)
    expect(reads).toBe(1)
    const record = await database.table('managedRecords').get(ref.revisionId)
    expect(Buffer.compare(await store.readBounded(ref, bytes.length, receipt.target, check, record.sha256), bytes)).toBe(0)
    await expect(store.readBounded(ref, bytes.length, receipt.target, check, '0'.repeat(64))).rejects.toThrow(/digest/)
    await expect(store.readBounded(ref, bytes.length - 1, receipt.target, check)).rejects.toThrow(/bound/)
    await expect(store.readBounded(ref, bytes.length, { ...receipt.target, revision: 99 }, check)).rejects.toThrow(/changed/)
    owned = false
    await expect(store.readBounded(ref, bytes.length, receipt.target, check)).rejects.toThrow(/Owner/)
    owned = true
    const chunk = await database.table('managedChunks').get([ref.revisionId, 1])
    chunk.bytes[0] ^= 1
    await database.table('managedChunks').put(chunk)
    await expect(store.readBounded(ref, bytes.length, receipt.target, check)).rejects.toThrow(/digest/)
  } finally { database.close(); IDBDatabase.prototype.transaction = transaction }
})

it('streams a durable frame through bounded read windows instead of a transaction per chunk', async () => {
  const databaseName = `synthetic-managed-frame-window-${crypto.randomUUID()}`
  const transaction = IDBDatabase.prototype.transaction
  let reads = 0, owned = true
  // Dexie captures native methods while opening, so the work observer must precede that opening
  IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
    if (this.name === databaseName && (!args[1] || args[1] === 'readonly')) reads++
    return Reflect.apply(transaction, this, args)
  }
  const database = new GuestCoordinatorDatabase(databaseName)
  const check = () => { if (!owned) throw new Error('Owner changed') }
  try {
    const bytes = new Uint8Array(4 * 1024 * 1024 + 7).fill(23)
    const writer = createGuestLocalStore(database, check)
    const ref = await writer.adapter.stage('frame', memoryBlob(bytes), [])
    await writer.activate('frame', ref, undefined, check)
    const reader = createGuestLocalStore(database, check)
    reads = 0
    // Preserve exact byte and length equality without the cost of a general deep matcher
    expect(Buffer.compare(await readBlob(await reader.adapter.read(ref), bytes.length), bytes)).toBe(0)
    expect(reads).toBeLessThanOrEqual(4)
    const opened = (await reader.adapter.read(ref)).open()[Symbol.asyncIterator]()
    await opened.next()
    owned = false
    await expect(opened.next()).rejects.toThrow(/Owner/)
    owned = true
    const chunk = await database.table('managedChunks').get([ref.revisionId, 10])
    chunk.bytes[0] ^= 1
    await database.table('managedChunks').put(chunk)
    await expect(readBlob(await reader.adapter.read(ref), bytes.length)).rejects.toThrow(/digest/)
  } finally { database.close(); IDBDatabase.prototype.transaction = transaction }
})

it('queues bounded native chunk reads together while checking consumed and staged bytes in the publication transaction', async () => {
  const databaseName = `synthetic-managed-publication-window-${crypto.randomUUID()}`
  const get = IDBObjectStore.prototype.get
  let measuring = false, queued = 0, maximumQueued = 0
  // Observe before Dexie opens, and count only the actual head publication's native requests
  IDBObjectStore.prototype.get = function (...args: Parameters<IDBObjectStore['get']>) {
    const request = Reflect.apply(get, this, args) as IDBRequest
    if (measuring && this.transaction.db.name === databaseName && this.transaction.mode === 'readwrite' && this.name === 'managedChunks') {
      maximumQueued = Math.max(maximumQueued, ++queued)
      request.addEventListener('success', () => { queued-- }, { once: true })
      request.addEventListener('error', () => { queued-- }, { once: true })
    }
    return request
  }
  const database = new GuestCoordinatorDatabase(databaseName)
  try {
    const bytes = new Uint8Array(4 * 1024 * 1024 + 7).fill(29)
    const writer = createGuestLocalStore(database, () => {})
    const first = await writer.adapter.stage('first', memoryBlob(bytes), [])
    const selected = await writer.activate('first', first, undefined, () => {})
    const reader = createGuestLocalStore(database, () => {})
    const consumed = await readBlob(await reader.adapter.read(first), bytes.length)
    expect(consumed.byteLength).toBe(bytes.byteLength)
    expect(consumed.every((byte, index) => byte === bytes[index])).toBe(true)
    const next = await reader.adapter.stage('second', memoryBlob(bytes), [first])
    await reader.flush('second')
    measuring = true
    const receipt = await reader.activate('second', next, selected.target, () => {})
    measuring = false
    expect(maximumQueued).toBeGreaterThan(1)
    expect(maximumQueued).toBeLessThanOrEqual(MAX_QUEUED_CHUNK_READS)
    expect((await database.active.get('active'))?.manifest).toEqual(receipt.target)
    const actual = await readBlob(await reader.adapter.read(next), bytes.length)
    expect(actual.byteLength).toBe(bytes.byteLength)
    expect(actual.every((byte, index) => byte === bytes[index])).toBe(true)
  } finally { database.close(); IDBObjectStore.prototype.get = get }
})

for (const fault of ['consumed', 'staged'] as const) it(`rejects changed ${fault} bytes in the exact managed publication transaction`, async () => {
  const database = new GuestCoordinatorDatabase(`synthetic-managed-publication-${fault}-${crypto.randomUUID()}`)
  try {
    const bytes = new Uint8Array(128 * 1024 + 7).fill(31)
    const writer = createGuestLocalStore(database, () => {})
    const first = await writer.adapter.stage('first', memoryBlob(bytes), [])
    const selected = await writer.activate('first', first, undefined, () => {})
    const reader = createGuestLocalStore(database, () => {})
    expect(await readBlob(await reader.adapter.read(first), bytes.length)).toEqual(bytes)
    const next = await reader.adapter.stage('second', memoryBlob(bytes), [first])
    await reader.flush('second')
    const revisionId = fault === 'consumed' ? first.revisionId : next.revisionId
    const original = await database.table('managedChunks').get([revisionId, 1])
    await database.table('managedChunks').put({ ...original, bytes: original.bytes.map((value: number) => value ^ 1) })
    await expect(reader.activate('second', next, selected.target, () => {})).rejects.toThrow(/bytes changed/)
    expect((await database.active.get('active'))?.manifest).toEqual(selected.target)
    expect(await reader.receipt('second')).toBeUndefined()
    await database.table('managedChunks').put(original)
    expect(await readBlob(await reader.adapter.read(first), bytes.length)).toEqual(bytes)
  } finally { database.close() }
})
