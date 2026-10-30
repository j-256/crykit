import { describe, expect, it } from 'vitest'
import { base64urlSchema, digestBytes, keyEnvelopeNonceBytes, opaqueFieldBytes, opaqueIdBytes, secretStreamHeaderBytes, wrappedKeyCipherBytes } from './protocol'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const WIRE_WIDTHS = [...new Set([1, 2, 3, opaqueIdBytes, digestBytes, keyEnvelopeNonceBytes, wrappedKeyCipherBytes, secretStreamHeaderBytes, ...Object.values(opaqueFieldBytes)])]

function canonicalRoundTrip(value: string, bytes: number): boolean {
  if (value.length !== Math.ceil(bytes * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return false
  try {
    const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
    return decoded.length === bytes && btoa(decoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === value
  } catch { return false }
}

describe('canonical account encodings', () => {
  it('matches the decoding oracle for every final symbol at every wire width', () => {
    // Nonzero padding bits can alias the same decoded identity; alphabet membership alone is insufficient
    for (const bytes of WIRE_WIDTHS) {
      const schema = base64urlSchema(bytes)
      for (const fill of [0, 85, 170, 255]) {
        const encoded = btoa(String.fromCharCode(...new Uint8Array(bytes).fill(fill))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        const candidates = [...ALPHABET].map(tail => encoded.slice(0, -1) + tail)
        expect(candidates.map(value => schema.safeParse(value).success)).toEqual(candidates.map(value => canonicalRoundTrip(value, bytes)))
        expect(schema.parse(encoded)).toBe(encoded)
      }
    }
  })

  it('accepts the complete one-byte and two-byte domains without changing their text', () => {
    for (const bytes of [1, 2]) {
      const schema = base64urlSchema(bytes)
      for (let value = 0; value < 2 ** (bytes * 8); value++) {
        const binary = bytes === 1 ? String.fromCharCode(value) : String.fromCharCode(value >> 8, value & 255)
        const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        if (schema.parse(encoded) !== encoded) throw new Error('Canonical text changed during admission')
      }
    }
  })

  it('rejects padding, whitespace, foreign alphabets, wrong widths and non-string inputs', () => {
    const invalid: unknown[] = [null, undefined, 0, {}, [], new Uint8Array(16)]
    for (const bytes of WIRE_WIDTHS) {
      const schema = base64urlSchema(bytes)
      const valid = 'A'.repeat(Math.ceil(bytes * 4 / 3))
      const candidates = ['', valid + '=', valid + '==', valid.slice(1), valid + 'A', ...invalid]
      for (const character of ['+', '/', '=', '\n', '\r', '\t', ' ', '\u00a0', '\u2028', '\u0000', '\ud800']) {
        candidates.push(character + valid.slice(1), valid.slice(0, -1) + character, valid[0] + character + valid.slice(2))
      }
      expect(candidates.map(value => schema.safeParse(value).success)).toEqual(candidates.map(() => false))
    }
  })
})
