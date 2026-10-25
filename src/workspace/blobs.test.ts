import { expect, it } from 'vitest'
import { hashBlob, memoryBlob, readBlob, verifiedBlob } from './blobs'
import { getSodium } from '../account/crypto/sodium'
import { plainChunkBytes } from '../account/protocol'

it('retains identical native and streaming digests around the bounded materialization boundary', async () => {
  const sodium = await getSodium()
  for (const length of [0, 1, plainChunkBytes, plainChunkBytes + 1]) {
    const bytes = Uint8Array.from({ length }, (_, index) => index % 251), source = memoryBlob(bytes)
    const expected = sodium.crypto_hash_sha256(bytes, 'hex')
    expect(await hashBlob(source)).toBe(expected)
    expect(Buffer.compare(await readBlob(verifiedBlob(source, expected), length), bytes)).toBe(0)
    await expect(readBlob(verifiedBlob(source, '0'.repeat(64)), length)).rejects.toThrow('Verified blob digest mismatch')
  }
})
it('rejects short and trailing metadata and releases a partially consumed verified source', async () => {
  for (const [byteLength, expected] of [[1, 'Trailing blob bytes'], [3, 'Truncated blob bytes']] as const) {
    const source = { byteLength, async *open() { yield new Uint8Array([1, 2]) } }
    await expect(hashBlob(source)).rejects.toThrow(expected)
    await expect(readBlob(verifiedBlob(source, '0'.repeat(64)), 3)).rejects.toThrow(/length mismatch|truncated/)
  }
  let released = false
  const input = verifiedBlob({ byteLength: 2, async *open() { try { yield new Uint8Array([1]); yield new Uint8Array([2]) } finally { released = true } } }, '0'.repeat(64)).open()[Symbol.asyncIterator]()
  expect((await input.next()).value).toEqual(new Uint8Array([1]))
  await input.return?.()
  expect(released).toBe(true)
})
