import { describe, expect, it } from 'vitest'
import { NATIVE_BACKUP_JSON_LIMITS, parseBoundedJson } from './json'

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

describe('bounded JSON parsing', () => {
  it('enforces an explicit node budget while retaining unknown and zero values', () => {
    const value = { quantity: null, raw: 0, confirmed: false }
    expect(() => parseBoundedJson(bytes(value), 'fixture', { maxNodes: 3 })).toThrow('complexity')
    expect(parseBoundedJson(bytes(value), 'fixture', { maxNodes: 4 })).toEqual(value)
  })

  it('preserves depth and unsafe-key guards with the native backup budget', () => {
    let nested: unknown = 0
    for (let depth = 0; depth < 65; depth++) nested = [nested]
    expect(() => parseBoundedJson(bytes(nested), 'fixture', NATIVE_BACKUP_JSON_LIMITS)).toThrow('complexity')
    const unsafe = new TextEncoder().encode('{"__proto__":{"polluted":true}}')
    expect(() => parseBoundedJson(unsafe, 'fixture', NATIVE_BACKUP_JSON_LIMITS)).toThrow('unsafe object key')
  })
})
