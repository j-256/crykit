import { expect, it, vi } from 'vitest'
import { randomShareId } from './identity'
import { SHARE_ID_ALPHABET } from '../../src/account/share-identity'

it('maps every random byte uniformly to the complete URL-safe alphabet', () => {
  const seen = new Map<string, number>()
  let offset = 0
  vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => {
    const bytes = array as Uint8Array
    for (let index = 0; index < bytes.length; index++) bytes[index] = offset++ % 256
    return array
  })
  for (let index = 0; index < 256; index++) {
    const value = randomShareId()
    expect(value).toMatch(/^[A-Za-z0-9_-]{11}$/)
    for (const symbol of value) seen.set(symbol, (seen.get(symbol) ?? 0) + 1)
  }
  expect([...seen.keys()].sort()).toEqual([...SHARE_ID_ALPHABET].sort())
  expect(new Set(seen.values())).toEqual(new Set([44]))
})
