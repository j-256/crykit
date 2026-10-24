import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { equalLegacyValue, encodeLegacyValue } from './legacy-value'
import { legacyCodecFixture } from './legacy-value.test-helpers'

it('retains exact version-one bytes and chunk boundaries while sharing non-overlapping backing storage', () => {
  const chunks = [...encodeLegacyValue(legacyCodecFixture())]
  const payload = createHash('sha256'), framed = createHash('sha256')
  for (const part of chunks) {
    payload.update(part)
    const length = new Uint8Array(4)
    new DataView(length.buffer).setUint32(0, part.length, true)
    framed.update(length); framed.update(part)
  }
  // Frozen receipts from the version-one encoder include cycles, aliases, typed views and repeated scalar records
  expect(payload.digest('hex')).toBe('c26146b5fc6b9c6675510731701feb6a5d429ab36d42e5113df635ff164e0dce')
  expect(framed.digest('hex')).toBe('ead5793434ca68bc35cadde5423c5c355b4b2eb4ab719cabf9346ef4d29bda50')
  expect(new Set(chunks.map(part => part.buffer)).size).toBeLessThan(chunks.length)
  const retained = chunks.slice(1).map(part => part.slice())
  chunks[0]![0] ^= 0xff
  expect(chunks.slice(1)).toEqual(retained)
})

it('compares exact typed legacy values including absent undefined null numbers and code units', () => {
  const original = { text: '\ud800', undefined: undefined, null: null, number: -0, nan: NaN, buffer: new Uint16Array([0x1234, 0xd800]), date: new Date('2020-01-01'), nested: new Map([['key', new Set([1, 2])]]) }
  expect(equalLegacyValue(original, structuredClone(original))).toBe(true)
  for (const changed of [{ ...original, text: '\ufffd' }, { ...original, number: 0 }, { ...original, buffer: new Uint8Array([0x34, 0x12, 0, 0xd8]) }, { ...original, undefined: null }]) expect(equalLegacyValue(original, changed)).toBe(false)
  expect(equalLegacyValue({ a: undefined }, {})).toBe(false)
  expect(equalLegacyValue([, undefined], [undefined, undefined])).toBe(false)
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic
  expect(equalLegacyValue(cyclic, structuredClone(cyclic))).toBe(true)
})
it('emits bounded chunks for a large logical record without a record byte ceiling', () => {
  const value = { text: 'x'.repeat(10 * 1024 * 1024) }
  let bytes = 0, peak = 0
  for (const chunk of encodeLegacyValue(value)) { bytes += chunk.length; peak = Math.max(peak, chunk.length) }
  expect(bytes).toBeGreaterThan(20 * 1024 * 1024)
  expect(peak).toBeLessThanOrEqual(65536)
  expect(equalLegacyValue(value, structuredClone(value))).toBe(true)
})
it('fails unsupported values explicitly instead of serializing placeholders', () => {
  expect(() => [...encodeLegacyValue({ callable: () => 0 })]).toThrow('Unsupported')
  expect(() => [...encodeLegacyValue(new Blob(['bytes']))]).toThrow('Unsupported')
})
