import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { AppDataError } from './errors'
import { inspectZip, safeUnzip } from './zip'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)

describe('safe ZIP handling', () => {
  it('checks metadata before extracting and verifies CRC output', () => {
    const archive = zipSync({ 'data/value.txt': bytes('synthetic value') }, { level: 0 })
    const directory = inspectZip(archive)
    expect(directory.entries).toHaveLength(1)
    const result = safeUnzip(archive)
    expect(new TextDecoder().decode(result.files.get('data/value.txt'))).toBe('synthetic value')

    const damaged = Uint8Array.from(archive)
    const entry = directory.entries[0]
    if (!entry) throw new Error('Expected a ZIP entry')
    damaged[entry.dataOffset] = (damaged[entry.dataOffset] ?? 0) ^ 0xff
    expect(() => safeUnzip(damaged)).toThrow(AppDataError)
  })

  it('rejects traversal before decompression', () => {
    const archive = zipSync({ '../outside.txt': bytes('blocked') })
    expect(() => inspectZip(archive)).toThrowError(
      expect.objectContaining({ code: 'unsafe-archive' }),
    )
  })

  it('rejects declared output beyond configured limits', () => {
    const boundary = zipSync({ 'boundary.txt': new Uint8Array(128) }, { level: 0 })
    const limits = {
      maxCompressedBytes: 1024,
      maxEntries: 4,
      maxEntryUncompressedBytes: 128,
      maxTotalUncompressedBytes: 128,
      maxInflationRatio: 100,
    }
    expect(inspectZip(boundary, limits).entries[0]?.uncompressedSize).toBe(128)

    const archive = zipSync({ 'large.txt': new Uint8Array(129) }, { level: 0 })
    expect(() =>
      inspectZip(archive, limits),
    ).toThrowError(expect.objectContaining({ code: 'unsafe-archive' }))
  })

  it('rejects duplicate normalized entry names', () => {
    const archive = zipSync({ 'a.txt': bytes('first'), 'b.txt': bytes('second') }, { level: 0 })
    const changed = Uint8Array.from(archive)
    const view = new DataView(changed.buffer)
    const centralOffsets: number[] = []
    for (let offset = 0; offset + 4 <= changed.byteLength; offset += 1) {
      if (view.getUint32(offset, true) === 0x02014b50) centralOffsets.push(offset)
    }
    const second = centralOffsets[1]
    if (second === undefined) throw new Error('Expected two central-directory entries')
    const localOffset = view.getUint32(second + 42, true)
    changed[second + 46] = 'a'.charCodeAt(0)
    changed[localOffset + 30] = 'a'.charCodeAt(0)
    expect(() => inspectZip(changed)).toThrowError(expect.objectContaining({ code: 'unsafe-archive' }))
  })
})
