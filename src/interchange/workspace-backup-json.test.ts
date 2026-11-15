import { expect, it } from 'vitest'
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
