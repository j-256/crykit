import { expect, it } from 'vitest'
import { BackupJsonReader, encodeBackupJson } from './workspace-backup-json'
import { metadataSource } from './workspace-backup-evidence'
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
