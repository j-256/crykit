import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { createBackupStaging } from '../workspace/backup-staging'

it('cancels a buffered source before writing and releases its borrowed input', async () => {
  const abort = new AbortController(), borrowed = new Uint8Array([1, 2, 3])
  const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction')
  const staging = await createBackupStaging(abort.signal)
  transactions.mockClear()
  let released = false
  const content = { byteLength: 6, async *open() {
    try { yield borrowed; abort.abort(); yield new Uint8Array([4, 5, 6]) }
    finally { borrowed.fill(0); released = true }
  } }
  try {
    await expect(staging.stage(1, content)).rejects.toThrow()
    expect(transactions.mock.calls.some(call => call[1] === 'readwrite')).toBe(false)
    expect(released).toBe(true)
    expect(borrowed).toEqual(new Uint8Array(3))
  } finally { await staging.dispose(); vi.restoreAllMocks() }
})

it('rejects truncated and oversized complete sources', async () => {
  const staging = await createBackupStaging()
  try {
    for (const byteLength of [2, 4]) {
      const content = { byteLength, async *open() { yield new Uint8Array([1, 2, 3]) } }
      await expect(staging.stage(byteLength, content)).rejects.toThrow('Backup source length mismatch')
    }
  } finally { await staging.dispose() }
})

it('bounds encrypted frame batches and durably flushes every original page', async () => {
  // Dexie binds the native transaction method while opening, before any writes
  const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction')
  const adds = vi.spyOn(IDBObjectStore.prototype, 'add')
  const staging = await createBackupStaging()
  transactions.mockClear(); adds.mockClear()
  const pages = Array.from({ length: 130 }, (_, index) => new Uint8Array([index, 255 - index]))
  const expected = pages.map(page => page.slice())
  try {
    const writer = staging.bufferedWriter()
    for (const [index, page] of pages.entries()) { await writer.write(1, index, page); page.fill(0) }
    const writes = () => transactions.mock.calls.filter(call => call[1] === 'readwrite').length
    // Tiny pages must drain bounded batches before EOF without a transaction for every frame
    expect(writes()).toBeGreaterThan(0)
    expect(writes()).toBeLessThan(pages.length / 8)
    await writer.flush()
    const actual: Uint8Array[] = []
    for await (const page of staging.source(1, pages.length, pages.length * 2).open()) actual.push(page.slice())
    expect(actual).toEqual(expected)
    expect(adds.mock.calls).toHaveLength(pages.length)
    for (const [row] of adds.mock.calls) expect(Object.keys(row).sort()).toEqual(['ciphertext', 'document', 'index', 'nonce'])
  } finally { await staging.dispose(); vi.restoreAllMocks() }
})

it('revokes a pending encrypted frame batch before it can be committed', async () => {
  const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction')
  const staging = await createBackupStaging()
  transactions.mockClear()
  try {
    const writer = staging.bufferedWriter()
    await writer.write(1, 0, new Uint8Array([1, 2, 3]))
    expect(transactions.mock.calls.some(call => call[1] === 'readwrite')).toBe(false)
    await staging.dispose()
    await expect(writer.flush()).rejects.toThrow()
    expect(transactions.mock.calls.some(call => call[1] === 'readwrite')).toBe(false)
  } finally { await staging.dispose(); vi.restoreAllMocks() }
})

it('reads staged chunks with bounded prefetch and fewer transactions than chunks', async () => {
  const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction')
  const gets = vi.spyOn(IDBObjectStore.prototype, 'get')
  const staging = await createBackupStaging()
  const chunks = Array.from({ length: 24 }, (_, index) => new Uint8Array([index + 1, 255 - index]))
  const iterator = staging.source(1, chunks.length, chunks.length * 2).open()[Symbol.asyncIterator]()
  try {
    for (const [index, bytes] of chunks.entries()) await staging.write(1, index, bytes)
    transactions.mockClear(); gets.mockClear()
    let next = await iterator.next()
    expect(next.done).toBe(false)
    expect(gets.mock.calls.length).toBeLessThan(chunks.length)
    const actual: number[] = []
    while (!next.done) {
      const yielded = next.value
      actual.push(...yielded)
      next = await iterator.next()
      expect(yielded.every(byte => byte === 0)).toBe(true)
    }
    expect(actual).toEqual(chunks.flatMap(bytes => [...bytes]))
    const reads = transactions.mock.calls.filter((call, index) => {
      const database = transactions.mock.contexts[index]
      return call[1] === 'readonly' && database instanceof IDBDatabase && database.name.startsWith('crykit-backup-staging-')
    })
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.length).toBeLessThan(chunks.length / 2)
  } finally { await iterator.return?.(); await staging.dispose(); vi.restoreAllMocks() }
})

it('revokes prefetched chunks on disposal and clears the last yielded plaintext', async () => {
  const staging = await createBackupStaging()
  const chunks = Array.from({ length: 12 }, (_, index) => new Uint8Array([index + 1]))
  const iterator = staging.source(1, chunks.length, chunks.length).open()[Symbol.asyncIterator]()
  try {
    for (const [index, bytes] of chunks.entries()) await staging.write(1, index, bytes)
    const first = await iterator.next()
    expect(first.value).toEqual(new Uint8Array([1]))
    const second = await iterator.next()
    expect(first.value).toEqual(new Uint8Array([0]))
    expect(second.value).toEqual(new Uint8Array([2]))
    await staging.dispose()
    await expect(iterator.next()).rejects.toThrow()
    expect(second.value).toEqual(new Uint8Array([0]))
  } finally { await iterator.return?.(); await staging.dispose() }
})

it('rejects a missing chunk without substituting another document', async () => {
  const staging = await createBackupStaging()
  const iterator = staging.source(1, 2, 2).open()[Symbol.asyncIterator]()
  try {
    await staging.write(1, 0, new Uint8Array([1]))
    await staging.write(2, 1, new Uint8Array([9]))
    const first = await iterator.next()
    expect(first.value).toEqual(new Uint8Array([1]))
    await expect(iterator.next()).rejects.toThrow('Incomplete encrypted backup staging')
    expect(first.value).toEqual(new Uint8Array([0]))
  } finally { await iterator.return?.(); await staging.dispose() }
})

it('rejects a trailing encrypted row after the declared chunk count', async () => {
  const staging = await createBackupStaging()
  const iterator = staging.source(1, 1, 1).open()[Symbol.asyncIterator]()
  try {
    await staging.write(1, 0, new Uint8Array([1]))
    await staging.write(1, 1, new Uint8Array([2]))
    const first = await iterator.next()
    expect(first.value).toEqual(new Uint8Array([1]))
    await expect(iterator.next()).rejects.toThrow('Backup staging length mismatch')
    expect(first.value).toEqual(new Uint8Array([0]))
  } finally { await iterator.return?.(); await staging.dispose() }
})
