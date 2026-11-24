import { expect, it, vi } from 'vitest'
import { BackupJsonReader, encodeBackupJson } from './workspace-backup-json'
import { metadataSource, readBackupMetadata } from './workspace-backup-evidence'
import { WORKSPACE_BACKUP_LIMITS } from './workspace-backup-schema'
import { createHash } from 'node:crypto'

it.each([
  { packed: false, digest: '57f5ed1eef04698550098fc8e0218d9f4dff771cc4be311706f692d3a3988006' },
  { packed: true, digest: '326d9fb1bb85a7c6022bd88e8b8e511627f6f37e95960d383903faeb46736337' },
])('preserves exact token page bytes and boundaries with packed=$packed', ({ packed, digest }) => {
  const value = { empty: [{}, []], scalars: [null, false, true, -3.5, 0], text: 'a'.repeat(8191) + '\ud83d\ude00\ud800', rows: Array.from({ length: 32 }, (_, index) => ({ index, name: `ASCII ${index} \u00e9 \u96ea`, nested: { value: '\ud800' } })) }
  const hash = createHash('sha256')
  for (const page of encodeBackupJson(value, 1024, packed ? { packByBytes: true } : undefined)) {
    const length = Buffer.alloc(4)
    length.writeUInt32LE(page.length)
    hash.update(length); hash.update(page)
  }
  expect(hash.digest('hex')).toBe(digest)
})

it('keeps moderate metadata from becoming hundreds of separately encrypted records', async () => {
  const value = { entries: Array.from({ length: 4096 }, (_, index) => ({ name: `Synthetic ${index}`, description: 'x'.repeat(2048) })), unfinished: '\ud800' }
  const pages: Uint8Array[] = []
  for await (const page of metadataSource(value).open()) pages.push(page)
  expect(pages.length).toBeGreaterThan(1)
  expect(pages.length).toBeLessThan(16)
  const reader = new BackupJsonReader()
  for (const page of pages) {
    expect(page.byteLength).toBeLessThanOrEqual(WORKSPACE_BACKUP_LIMITS.payload)
    reader.consume(page)
  }
  expect(reader.finish()).toEqual(value)
})

it('fills new UTF-8 pages within their byte bound while preserving legacy packing', () => {
  const value = Array.from({ length: 1000 }, (_, index) => `${index} ASCII \u00e9 \u96ea \ud83d\ude00 \ud800`)
  const target = 1024, legacy = [...encodeBackupJson(value, target)], packed = [...encodeBackupJson(value, target, { packByBytes: true })]
  expect(packed.length).toBeLessThan(legacy.length / 2)
  for (const pages of [legacy, packed]) {
    const reader = new BackupJsonReader()
    for (const page of pages) { expect(page.length).toBeLessThanOrEqual(target); reader.consume(page) }
    expect(reader.finish()).toEqual(value)
  }
  expect([...encodeBackupJson(value, target, { packByBytes: false })]).toEqual(legacy)
})

it('reads complete token pages after encrypted transport splits and coalesces them', async () => {
  const { plainChunkBytes } = await import('../account/protocol')
  const { readBlob } = await import('../workspace/blobs')
  const value = { rows: Array.from({ length: 1200 }, () => 'x'.repeat(4096)), text: 'brackets [ ] and escaped \" quote \\ and 雪' }
  const source = metadataSource(value), bytes = await readBlob(source, source.byteLength)
  const transported = { byteLength: bytes.length, async *open() { for (let offset = 0; offset < bytes.length; offset += plainChunkBytes) yield bytes.subarray(offset, offset + plainChunkBytes) } }
  await expect(readBackupMetadata(transported)).resolves.toEqual(value)
})

it('preserves UTF-8 and JSON escapes across every stream boundary', async () => {
  const value = { text: 'brackets [ ] and escaped \" quote \\ and 雪😀', end: [] }
  const pages = [...encodeBackupJson(value, 64)]
  const bytes = new Uint8Array(pages.reduce((length, page) => length + page.length, 0))
  let offset = 0
  for (const page of pages) { bytes.set(page, offset); offset += page.length }
  const transported = { byteLength: bytes.length, async *open() { for (const byte of bytes) { const chunk = new Uint8Array([byte]); yield chunk; chunk.fill(0) } } }
  await expect(readBackupMetadata(transported)).resolves.toEqual(value)
})

it('accepts JSON whitespace around complete token pages', async () => {
  const { memoryBlob } = await import('../workspace/blobs')
  const bytes = new TextEncoder().encode(' \t\r\n[["array"]]\n[["text-value","kept"]] [["end"]]\t ')
  await expect(readBackupMetadata(memoryBlob(bytes))).resolves.toEqual(['kept'])
})

it.each([
  '[["text-value","kept"]]garbage',
  '[["array"]][["end"]',
  '[["text-value","unterminated]]',
  '[["array"]]{"invalid":true}',
  '[["object"],["key","__proto__"],["value",1],["end"]]',
  '[["object"],["key","duplicate"],["value",1],["key","duplicate"],["value",2],["end"]]',
])('rejects malformed or incomplete concatenated metadata: %s', async input => {
  const { memoryBlob } = await import('../workspace/blobs')
  await expect(readBackupMetadata(memoryBlob(new TextEncoder().encode(input)))).rejects.toThrow()
})

it.each([-1, 1])('rejects a declared metadata length differing from its bytes by %s', async delta => {
  const bytes = new TextEncoder().encode('[["text-value","kept"]]')
  await expect(readBackupMetadata({ byteLength: bytes.length + delta, async *open() { yield bytes } })).rejects.toThrow('metadata length mismatch')
})

it('accepts the existing page bound and rejects larger pages and total claims', async () => {
  const { memoryBlob } = await import('../workspace/blobs')
  const value = 'x'.repeat(WORKSPACE_BACKUP_LIMITS.payload - JSON.stringify([['text-value', '']]).length)
  const bytes = new TextEncoder().encode(JSON.stringify([['text-value', value]]))
  expect(bytes.length).toBe(WORKSPACE_BACKUP_LIMITS.payload)
  await expect(readBackupMetadata(memoryBlob(bytes))).resolves.toBe(value)
  await expect(readBackupMetadata(memoryBlob(new TextEncoder().encode(JSON.stringify([['text-value', value + 'x']]))))).rejects.toThrow('page limit exceeded')
  await expect(readBackupMetadata({ byteLength: WORKSPACE_BACKUP_LIMITS.bytes + 1, async *open() { throw new Error('Source must not open') } })).rejects.toThrow('byte limit exceeded')
})

it('exhausts authenticated sources before returning decoded metadata', async () => {
  const { memoryBlob, verifiedBlob } = await import('../workspace/blobs')
  const bytes = new TextEncoder().encode('[["text-value","kept"]]')
  await expect(readBackupMetadata(verifiedBlob(memoryBlob(bytes), '0'.repeat(64)))).rejects.toThrow('Verified blob digest mismatch')
  await expect(readBackupMetadata({ byteLength: bytes.length, async *open() { yield bytes; throw new Error('Authentication failed at EOF') } })).rejects.toThrow('Authentication failed at EOF')
})

it('rejects invalid UTF-8 in a complete token page', async () => {
  const { memoryBlob } = await import('../workspace/blobs')
  const bytes = new TextEncoder().encode('[["text-value","kept"]]')
  bytes[bytes.indexOf('k'.charCodeAt(0))] = 0xff
  await expect(readBackupMetadata(memoryBlob(bytes))).rejects.toThrow()
})

it('observes exact produced and consumed stream bytes without changing codec output', async () => {
  const { observeBackupJsonWork } = await import('./workspace-backup-json')
  const value = { text: 'Synthetic 雪 \ud800', repeated: ['a', 'b'] }
  const expected = [...encodeBackupJson(value, 64)]
  const counters: Record<string, number> = {}
  const stop = observeBackupJsonWork((counter, bytes) => { counters[counter] = (counters[counter] ?? 0) + bytes })
  try {
    const actual = [...encodeBackupJson(value, 64)]
    expect(actual).toEqual(expected)
    const reader = new BackupJsonReader()
    for (const page of actual) reader.consume(page)
    expect(reader.finish()).toEqual(value)
    const byteLength = actual.reduce((sum, page) => sum + page.byteLength, 0)
    expect(counters).toEqual({ encodedOutputBytes: byteLength, decodedInputBytes: byteLength })
  } finally { stop() }
})

it('isolates retired codec readers and generators from successor observers', async () => {
  const { observeBackupJsonWork } = await import('./workspace-backup-json')
  let oldBytes = 0, newBytes = 0
  const stopOld = observeBackupJsonWork((_counter, bytes) => { oldBytes += bytes })
  const oldReader = new BackupJsonReader(), oldGenerator = encodeBackupJson(['one', 'two', 'three'], 32)
  oldGenerator.next()
  const before = oldBytes
  const stopNew = observeBackupJsonWork((_counter, bytes) => { newBytes += bytes })
  stopOld()
  try {
    oldReader.consume(new TextEncoder().encode('[ ["value",1] ]'))
    Array.from(oldGenerator)
    expect(oldBytes).toBe(before)
    expect(newBytes).toBe(0)
    Array.from(encodeBackupJson(null))
    expect(newBytes).toBeGreaterThan(0)
  } finally { stopNew() }
  const stopped = newBytes
  Array.from(encodeBackupJson(true))
  expect(newBytes).toBe(stopped)
})

it('keeps observer exceptions outside codec success and failure semantics', async () => {
  const { observeBackupJsonWork } = await import('./workspace-backup-json')
  const stop = observeBackupJsonWork(() => { throw new Error('Synthetic observer failure') })
  try {
    const reader = new BackupJsonReader()
    for (const page of encodeBackupJson({ kept: true })) reader.consume(page)
    expect(reader.finish()).toEqual({ kept: true })
    expect(() => reader.consume(new Uint8Array([0xff]))).toThrow()
  } finally { stop() }
})

it('consumes a complete original page once and leaves parse misses untouched', async () => {
  const { observeBackupJsonWork } = await import('./workspace-backup-json')
  const counters: Record<string, number> = {}, reader = new BackupJsonReader()
  let pages = 0
  const reservePage = () => { pages++ }
  const stop = observeBackupJsonWork((counter, bytes) => { counters[counter] = (counters[counter] ?? 0) + bytes })
  // Readers capture their observer at construction, so use this interval's own reader
  const observed = new BackupJsonReader()
  const encode = (text: string) => new TextEncoder().encode(text)
  try {
    for (const text of ['[["array"]', '[["array"]][["end"]]']) expect(observed.tryConsumeCompletePage(encode(text), reservePage)).toBe(false)
    expect(pages).toBe(0)
    expect(counters).toEqual({})
    const bytes = encode('[["object"],["key","kept"],["text-value","value"],["end"]]')
    expect(observed.tryConsumeCompletePage(bytes, reservePage)).toBe(true)
    bytes.fill(0)
    expect(observed.finish()).toEqual({ kept: 'value' })
    expect(Object.getPrototypeOf(observed.finish())).toBe(null)
    expect(pages).toBe(1)
    expect(counters).toEqual({ decodedInputBytes: bytes.length })
    expect(() => reader.tryConsumeCompletePage(encode('[["value",1]]'), () => { throw new Error('Frame budget') })).toThrow('Frame budget')
    reader.consume(encode('[["value",2]]'))
    expect(reader.finish()).toBe(2)
  } finally { stop() }
})

it('shares complete-page token rejection without falling back after mutation', async () => {
  const { observeBackupJsonWork } = await import('./workspace-backup-json')
  const page = new TextEncoder().encode('[["array"],["value",1],["unknown"]]')
  let decoded = 0
  const stop = observeBackupJsonWork((counter, bytes) => { if (counter === 'decodedInputBytes') decoded += bytes })
  const reader = new BackupJsonReader()
  try {
    expect(() => reader.tryConsumeCompletePage(page, () => {})).toThrow('Unknown backup token')
    expect(decoded).toBe(page.length)
    reader.consume(new TextEncoder().encode('[["end"]]'))
    expect(reader.finish()).toEqual([1])
  } finally { stop() }
})

it('counts complete and split pages once while borrowed input is cleared on advance', async () => {
  const { observeBackupJsonWork } = await import('./workspace-backup-json')
  const value = { text: 'Snow 雪 [ ] \\"', rows: [1, 2], end: [] }
  const pages = [...encodeBackupJson(value, 64)]
  const chunks = pages.flatMap((page, index) => index % 2 ? [page.slice(0, 7), page.slice(7)] : [page])
  const total = pages.reduce((sum, page) => sum + page.length, 0)
  let decoded = 0
  const stop = observeBackupJsonWork((counter, bytes) => { if (counter === 'decodedInputBytes') decoded += bytes })
  try {
    await expect(readBackupMetadata({ byteLength: total, async *open() { for (const chunk of chunks) { yield chunk; chunk.fill(0) } } })).resolves.toEqual(value)
    expect(decoded).toBe(total)
    expect(chunks.every(chunk => chunk.every(byte => byte === 0))).toBe(true)
  } finally { stop() }
})

it.each(['constructor', 'prototype', '__proto__'])('rejects unsafe complete-page keys: %s', async key => {
  const bytes = new TextEncoder().encode(JSON.stringify([['object'], ['key', key], ['value', 1], ['end']]))
  await expect(readBackupMetadata({ byteLength: bytes.length, async *open() { yield bytes } })).rejects.toThrow('Duplicate or invalid backup key')
})

it.each([
  { tokens: [['array', 'extra']], reason: 'arity' },
  { tokens: [['value', {}]], reason: 'primitive' },
  { tokens: [['object'], ['key', 'unfinished'], ['end']], reason: 'container end' },
  { tokens: Array.from({ length: WORKSPACE_BACKUP_LIMITS.depth + 2 }, () => ['array']), reason: 'deeply nested' },
])('keeps complete-page token and depth checks: $reason', async ({ tokens, reason }) => {
  const bytes = new TextEncoder().encode(JSON.stringify(tokens))
  await expect(readBackupMetadata({ byteLength: bytes.length, async *open() { yield bytes } })).rejects.toThrow(reason)
})

it('retains whitespace prefixes in the following page byte bound', async () => {
  const first = new TextEncoder().encode('[["array"]] ')
  const tokens = [['text-value', 'x'.repeat(WORKSPACE_BACKUP_LIMITS.payload - JSON.stringify([['text-value', '']]).length)]]
  const second = new TextEncoder().encode(JSON.stringify(tokens))
  expect(second.length).toBe(WORKSPACE_BACKUP_LIMITS.payload)
  await expect(readBackupMetadata({ byteLength: first.length + second.length, async *open() { yield first; yield second } })).rejects.toThrow('page limit exceeded')
})

it('keeps node and frame budgets before complete-page publication', async () => {
  vi.resetModules()
  vi.doMock('./workspace-backup-schema', async importOriginal => {
    const original = await importOriginal<typeof import('./workspace-backup-schema')>()
    return { ...original, WORKSPACE_BACKUP_LIMITS: { ...original.WORKSPACE_BACKUP_LIMITS, bytes: 256, frames: 2 } }
  })
  try {
    const { BackupJsonReader: BoundedReader } = await import('./workspace-backup-json')
    const { readBackupMetadata: boundedRead } = await import('./workspace-backup-evidence')
    const reader = new BoundedReader()
    const nodes = new TextEncoder().encode(JSON.stringify([['array'], ...Array.from({ length: 256 }, () => ['value', 0])]))
    expect(() => reader.tryConsumeCompletePage(nodes, () => {})).toThrow('node limit exceeded')
    const pages = ['[["array"]]', '[["value",0]]', '[["end"]]'].map(text => new TextEncoder().encode(text))
    await expect(boundedRead({ byteLength: pages.reduce((sum, page) => sum + page.length, 0), async *open() { yield* pages } })).rejects.toThrow('page count exceeded')
  } finally { vi.doUnmock('./workspace-backup-schema'); vi.resetModules() }
})
