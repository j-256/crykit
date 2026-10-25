import { expect, it, vi } from 'vitest'
import { digestSha256 } from './sha256'
import { getSodium } from './sodium'

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
it.each([
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
])('matches the published SHA-256 vector for %j', async (text, expected) => {
  expect(hex(await digestSha256(new TextEncoder().encode(text)))).toBe(expected)
})
it('snapshots only the supplied view before an asynchronous digest can observe caller mutation', async () => {
  const backing = new Uint8Array([0, 97, 98, 99, 0])
  const pending = digestSha256(backing.subarray(1, 4))
  backing.fill(0)
  expect(hex(await pending)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
it('accepts a shared-backed view through an owned native input snapshot', async () => {
  const bytes = new Uint8Array(new SharedArrayBuffer(3))
  bytes.set([97, 98, 99])
  const pending = digestSha256(bytes)
  bytes.fill(0)
  expect(hex(await pending)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
it('preserves the pinned sodium digest for bounded cipher and metadata buffers', async () => {
  const sodium = await getSodium()
  for (const length of [1, 64 * 1024, 4 * 1024 * 1024 + 17]) {
    const bytes = Uint8Array.from({ length }, (_, index) => index % 251)
    expect(await digestSha256(bytes)).toEqual(sodium.crypto_hash_sha256(bytes))
  }
})
it('retains a snapshot when native hashing is unavailable in an insecure local guest context', async () => {
  const sodium = await getSodium(), original = crypto
  vi.stubGlobal('crypto', { getRandomValues: original.getRandomValues.bind(original) })
  try {
    const bytes = new TextEncoder().encode('abc'), expected = sodium.crypto_hash_sha256(bytes)
    const pending = digestSha256(bytes)
    bytes.fill(0)
    expect(await pending).toEqual(expected)
  } finally { vi.unstubAllGlobals() }
})
