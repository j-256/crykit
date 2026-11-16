import { afterEach, expect, it, vi } from 'vitest'
import { GUIDE_CATALOG } from '../catalog/bundled'
import { getSodium } from '../account/crypto/sodium'
import { assertActiveProfile, installProfile, invalidateProfile } from '../account/profile'
import { backupMetadataDigest, backupWorkspaceDocumentDigest } from './snapshot'
import { captureWorkspaceDocument } from './documents'

const document = () => captureWorkspaceDocument('catalog', 'synthetic-catalog', GUIDE_CATALOG)
afterEach(() => { vi.restoreAllMocks(); invalidateProfile() })
const forceSlices = () => { let time = 0; vi.spyOn(performance, 'now').mockImplementation(() => time += 20) }

it('yields real tasks while preserving exact legacy token-page digest and immutable input', async () => {
  const input = document(), expected = await backupMetadataDigest(input), check = vi.fn(async () => {})
  forceSlices()
  let timerRan = false
  setTimeout(() => { timerRan = true; (input as { key: string }).key = 'mutated-caller-wrapper' }, 0)
  const actual = await backupWorkspaceDocumentDigest(input, check)
  expect(timerRan).toBe(true)
  expect(actual).toBe(expected)
  expect(check.mock.calls.length).toBeGreaterThan(2)
  expect(Reflect.set(GUIDE_CATALOG, 'id', 'mutated-catalog')).toBe(false)
})

it.each(['owner', 'profile', 'cancel'] as const)('rejects %s revocation between task slices and clears its hash state once', async cause => {
  const sodium = await getSodium(), token = installProfile('synthetic-account', new Uint8Array(32)), signal = new AbortController()
  const raw = (sodium as unknown as { libsodium: { HEAPU8: Uint8Array; _crypto_hash_sha256_statebytes(): number; _free(address: number): void } }).libsodium
  const initialize = sodium.crypto_hash_sha256_init.bind(sodium), free = raw._free.bind(raw)
  let address: number | undefined, releases = 0, cleared = false, alive = true
  vi.spyOn(sodium, 'crypto_hash_sha256_init').mockImplementation(() => { const state = initialize(); address = state as unknown as number; return state })
  vi.spyOn(raw, '_free').mockImplementation(value => { if (value === address) { releases++; cleared = raw.HEAPU8.slice(value, value + raw._crypto_hash_sha256_statebytes()).every(byte => byte === 0) }; free(value) })
  forceSlices()
  setTimeout(() => { if (cause === 'profile') invalidateProfile(); else if (cause === 'cancel') signal.abort(new Error('synthetic cancellation')); else alive = false }, 0)
  await expect(backupWorkspaceDocumentDigest(document(), async () => { assertActiveProfile(token); signal.signal.throwIfAborted(); if (!alive) throw new Error('synthetic owner released') })).rejects.toThrow()
  expect(releases).toBe(1)
  expect(cleared).toBe(true)
})

it('retains scheduling for unbranded mutable catalogs and other document kinds', async () => {
  const check = vi.fn(async () => {}), input = document()
  const mutable = { ...input, value: structuredClone(GUIDE_CATALOG) as never }
  forceSlices()
  expect(await backupWorkspaceDocumentDigest(mutable, check)).toBe(await backupMetadataDigest(mutable))
  expect(await backupWorkspaceDocumentDigest({ version: 1, kind: 'history', key: 'synthetic-history', value: { text: 'unchanged' } }, check)).toBe(await backupMetadataDigest({ version: 1, kind: 'history', key: 'synthetic-history', value: { text: 'unchanged' } }))
  expect(check).not.toHaveBeenCalled()
})

it('keeps encoder failure cleanup single-owner without a final digest', async () => {
  const sodium = await getSodium(), raw = (sodium as unknown as { libsodium: { _free(address: number): void } }).libsodium
  const initialize = sodium.crypto_hash_sha256_init.bind(sodium), free = raw._free.bind(raw)
  let address: number | undefined, releases = 0
  vi.spyOn(sodium, 'crypto_hash_sha256_init').mockImplementation(() => { const state = initialize(); address = state as unknown as number; return state })
  vi.spyOn(raw, '_free').mockImplementation(value => { if (value === address) releases++; free(value) })
  const final = vi.spyOn(sodium, 'crypto_hash_sha256_final')
  await expect(backupMetadataDigest({ invalid: undefined })).rejects.toThrow('Unsupported backup metadata value')
  expect(final).not.toHaveBeenCalled()
  expect(releases).toBe(1)
})
