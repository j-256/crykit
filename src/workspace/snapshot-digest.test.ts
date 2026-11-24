import { afterEach, expect, it, vi } from 'vitest'
import { SYNTHETIC_RETAINED_CATALOG } from '../domain/retained-catalog.test-helpers'
import { observeBackupJsonWork } from '../interchange/workspace-backup-json'
import { getSodium } from '../account/crypto/sodium'
import { assertActiveProfile, installProfile, invalidateProfile } from '../account/profile'
import { backupMetadataDigest, backupWorkspaceDocumentDigest } from './snapshot'
import { captureWorkspaceDocument, type WorkspaceDocument } from './documents'

const document = (key = 'synthetic-catalog') => captureWorkspaceDocument('catalog', key, SYNTHETIC_RETAINED_CATALOG)
afterEach(() => { vi.restoreAllMocks(); invalidateProfile() })
const forceSlices = () => { let time = 0; vi.spyOn(performance, 'now').mockImplementation(() => time += 20) }
const liveCheckpoint = async () => {}

async function observeDigest(input: WorkspaceDocument, check = liveCheckpoint) {
  const initialize = vi.spyOn(await getSodium(), 'crypto_hash_sha256_init')
  let encodedOutputBytes = 0
  const stop = observeBackupJsonWork((counter, bytes) => { if (counter === 'encodedOutputBytes') encodedOutputBytes += bytes })
  try {
    const digest = await backupWorkspaceDocumentDigest(input, check)
    return { digest, encodedOutputBytes, shaInitializations: initialize.mock.calls.length }
  } finally { stop(); initialize.mockRestore() }
}

async function expectFreshDigest(input: WorkspaceDocument, check = liveCheckpoint, legacyInput = input) {
  const expected = await backupMetadataDigest(legacyInput)
  const actual = await observeDigest(input, check)
  expect(actual.digest).toBe(expected)
  expect(actual.encodedOutputBytes).toBeGreaterThan(0)
  expect(actual.shaInitializations).toBe(1)
  return actual.digest
}

it('reuses completed immutable catalog digests across freshly captured wrappers', async () => {
  const first = document('completed-reuse'), second = document('completed-reuse')
  const expected = await backupMetadataDigest(first)
  expect(first).not.toBe(second)
  expect(first.value).toBe(second.value)
  const cold = await observeDigest(first)
  expect(cold.digest).toBe(expected)
  expect(cold.encodedOutputBytes).toBeGreaterThan(0)
  expect(cold.shaInitializations).toBe(1)

  const check = vi.fn(liveCheckpoint)
  const timer = setTimeout(() => { Reflect.set(second, 'key', 'mutated-repeat-wrapper') }, 0)
  try {
    expect(await observeDigest(second, check)).toEqual({ digest: expected, encodedOutputBytes: 0, shaInitializations: 0 })
    expect(check).toHaveBeenCalledTimes(2)
    expect(second.key).toBe('mutated-repeat-wrapper')
  } finally { clearTimeout(timer) }
})

it('yields real tasks while preserving exact legacy token-page digest and immutable input', async () => {
  const input = document('legacy-task-yield'), expected = await backupMetadataDigest(input), check = vi.fn(async () => {})
  forceSlices()
  let timerRan = false
  setTimeout(() => { timerRan = true; (input as { key: string }).key = 'mutated-caller-wrapper' }, 0)
  const actual = await backupWorkspaceDocumentDigest(input, check)
  expect(timerRan).toBe(true)
  expect(actual).toBe(expected)
  expect(check.mock.calls.length).toBeGreaterThan(2)
  expect(Reflect.set(SYNTHETIC_RETAINED_CATALOG, 'id', 'mutated-catalog')).toBe(false)
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
  await expect(backupWorkspaceDocumentDigest(document(`cold-${cause}`), async () => { assertActiveProfile(token); signal.signal.throwIfAborted(); if (!alive) throw new Error('synthetic owner released') })).rejects.toThrow()
  expect(releases).toBe(1)
  expect(cleared).toBe(true)
})

it.each(['owner', 'profile', 'cancel'] as const)('checks the current caller after %s revocation during a completed hit', async cause => {
  const input = document(`completed-${cause}`)
  await expectFreshDigest(input)
  const token = installProfile('synthetic-account', new Uint8Array(32))
  const signal = new AbortController()
  const reason = new Error(`synthetic ${cause} revoked`)
  let alive = true
  const check = vi.fn(async () => {
    assertActiveProfile(token)
    signal.signal.throwIfAborted()
    if (!alive) throw reason
  })
  setTimeout(() => {
    if (cause === 'profile') invalidateProfile()
    else if (cause === 'cancel') signal.abort(reason)
    else alive = false
  }, 0)
  await expect(backupWorkspaceDocumentDigest({ ...input }, check)).rejects.toThrow(cause === 'profile' ? 'PROFILE_CHANGED' : reason.message)
  expect(check).toHaveBeenCalledTimes(2)
})

it.each([
  ['key', (input: WorkspaceDocument) => ({ ...input, key: 'new-catalog-key' })],
  ['insertion order', ({ version, kind, key, value }: WorkspaceDocument) => ({ kind, version, key, value })],
] as const)('replaces a completed digest when the wrapper %s changes', async (name, vary) => {
  const input = document(`completed-variant-${name}`)
  const original = await expectFreshDigest(input)
  const variant = vary(input)
  const changed = await expectFreshDigest(variant)
  expect(changed).not.toBe(original)
  expect(await observeDigest(variant)).toEqual({ digest: changed, encodedOutputBytes: 0, shaInitializations: 0 })
  expect(await expectFreshDigest(input)).toBe(original)
})

it('rehashes distinct admitted catalogs with equal pins and contents', async () => {
  const input = document('completed-distinct-catalog')
  const original = await expectFreshDigest(input)
  const distinct = captureWorkspaceDocument('catalog', input.key, structuredClone(SYNTHETIC_RETAINED_CATALOG))
  expect(distinct.value).not.toBe(input.value)
  expect(await expectFreshDigest(distinct)).toBe(original)
})

it.each([
  ['an extra enumerable field', (input: WorkspaceDocument) => ({ ...input, extra: true }), false],
  ['an extra hidden field', (input: WorkspaceDocument) => Object.defineProperty({ ...input }, 'extra', { value: true }), true],
  ['an extra symbol field', (input: WorkspaceDocument) => ({ ...input, [Symbol('extra')]: true }), true],
  ['an accessor', (input: WorkspaceDocument) => ({ ...input, get key() { return input.key } }), true],
  ['an unusual prototype', (input: WorkspaceDocument) => Object.assign(Object.create(null) as WorkspaceDocument, input), true],
  ['another document kind', (input: WorkspaceDocument): WorkspaceDocument => ({ ...input, kind: 'history' }), false],
  ['another document version', (input: WorkspaceDocument) => ({ ...input, version: 2 }) as unknown as WorkspaceDocument, true],
  ['a nonstring key', (input: WorkspaceDocument) => ({ ...input, key: 2 }) as unknown as WorkspaceDocument, true],
] as const)('rehashes a wrapper with %s and preserves its scheduling', async (name, wrap, scheduled) => {
  const input = document(`unsupported-wrapper-${name}`)
  await expectFreshDigest(input)
  const fallback = wrap(input)
  const check = vi.fn(liveCheckpoint)
  const expected = await expectFreshDigest(fallback, check)
  expect(await expectFreshDigest(fallback, check)).toBe(expected)
  if (scheduled) expect(check.mock.calls.length).toBeGreaterThan(2)
  else expect(check).not.toHaveBeenCalled()
})

it('sees nested mutations in shallow-frozen unbranded catalogs', async () => {
  const value = Object.freeze(structuredClone(SYNTHETIC_RETAINED_CATALOG))
  const input = { ...document('shallow-frozen'), value: value as unknown as WorkspaceDocument['value'] }
  const check = vi.fn(liveCheckpoint)
  const before = await expectFreshDigest(input, check)
  expect(Reflect.set(value.entities['synthetic:class:1'], 'name', 'Changed nested name')).toBe(true)
  expect(await expectFreshDigest(input, check)).not.toBe(before)
  expect(check).not.toHaveBeenCalled()
})

it('rehashes a format-owned catalog when a frozen nested getter changes', async () => {
  const catalog = structuredClone(SYNTHETIC_RETAINED_CATALOG)
  const entity = catalog.entities['synthetic:class:1']
  let name = entity.name
  Object.defineProperty(entity, 'name', { enumerable: true, get: () => name })
  const input = captureWorkspaceDocument('catalog', 'completed-live-nested-getter', catalog)
  expect(input.value).toBe(catalog)
  expect(Object.isFrozen(entity)).toBe(true)

  const before = await expectFreshDigest(input)
  name = 'Changed getter value'
  expect(await backupMetadataDigest(input)).not.toBe(before)
  expect(await expectFreshDigest({ ...input })).not.toBe(before)
})

it('rehashes a format-owned catalog when a frozen proxy reorders nested fields', async () => {
  const catalog = structuredClone(SYNTHETIC_RETAINED_CATALOG)
  const entityId = 'synthetic:class:1'
  let reversed = false
  const entity = new Proxy(catalog.entities[entityId], {
    ownKeys(target) {
      const keys = Reflect.ownKeys(target)
      return reversed ? keys.reverse() : keys
    },
  })
  const input = captureWorkspaceDocument('catalog', 'completed-live-key-order', { ...catalog, entities: { ...catalog.entities, [entityId]: entity } })
  expect(Object.isFrozen(entity)).toBe(true)

  const before = await expectFreshDigest(input)
  reversed = true
  expect(await backupMetadataDigest(input)).not.toBe(before)
  expect(await expectFreshDigest({ ...input })).not.toBe(before)
})

it.each(['owner', 'profile', 'cancel'] as const)('rejects %s revocation during eligibility reflection after SHA finalization', async cause => {
  const catalog = structuredClone(SYNTHETIC_RETAINED_CATALOG)
  const entityId = 'synthetic:class:1'
  const token = installProfile('synthetic-account', new Uint8Array(32))
  const signal = new AbortController()
  const reason = new Error(`synthetic ${cause} revoked during proof`)
  let finalized = false, revoked = false, alive = true
  const entity = new Proxy(catalog.entities[entityId], {
    ownKeys(target) {
      if (finalized && !revoked) {
        revoked = true
        if (cause === 'profile') queueMicrotask(() => queueMicrotask(invalidateProfile))
        else if (cause === 'cancel') signal.abort(reason)
        else alive = false
      }
      return Reflect.ownKeys(target)
    },
  })
  const input = captureWorkspaceDocument('catalog', `completed-proof-${cause}`, { ...catalog, entities: { ...catalog.entities, [entityId]: entity } })
  const sodium = await getSodium()
  const finalize = sodium.crypto_hash_sha256_final.bind(sodium)
  const final = vi.spyOn(sodium, 'crypto_hash_sha256_final').mockImplementationOnce((state, format) => {
    const digest = finalize(state, format)
    finalized = true
    return digest
  })
  await expect(backupWorkspaceDocumentDigest(input, async () => {
    assertActiveProfile(token)
    signal.signal.throwIfAborted()
    if (!alive) throw reason
  })).rejects.toThrow(cause === 'profile' ? 'PROFILE_CHANGED' : reason.message)
  expect(final).toHaveBeenCalledTimes(1)
  expect(revoked).toBe(true)
  final.mockRestore()
  await expectFreshDigest({ ...input })
})

it('checks the immutable brand on the detached value after reading a wrapper', async () => {
  const input = document('detached-catalog-brand')
  const value = structuredClone(SYNTHETIC_RETAINED_CATALOG)
  const detached = { ...input, value: value as unknown as WorkspaceDocument['value'] }
  let valueReads = 0
  const wrapper = new Proxy(input, {
    get(target, key, receiver) {
      if (key === 'value' && ++valueReads % 2 === 0) return detached.value
      return Reflect.get(target, key, receiver)
    },
  })
  const check = vi.fn(liveCheckpoint)
  let timerRan = false
  const timer = setTimeout(() => { timerRan = true }, 0)
  try {
    const before = await expectFreshDigest(wrapper, check, detached)
    expect({ checkpoints: check.mock.calls.length, timerRan }).toEqual({ checkpoints: 0, timerRan: false })
    expect(Reflect.set(value.entities['synthetic:class:1'], 'name', 'Changed detached name')).toBe(true)
    expect(await expectFreshDigest(wrapper, check, detached)).not.toBe(before)
    expect(check).not.toHaveBeenCalled()
  } finally { clearTimeout(timer) }
})

it('keeps the completed digest when a different wrapper fails during hashing', async () => {
  const input = document('completed-before-failed-variant')
  const original = await expectFreshDigest(input)
  const variant = { ...input, key: 'failed-cold-variant' }
  const reason = new Error('synthetic digest caller retired')
  let active = true
  setTimeout(() => { active = false }, 0)
  await expect(backupWorkspaceDocumentDigest(variant, async () => { if (!active) throw reason })).rejects.toBe(reason)
  expect(await observeDigest(input)).toEqual({ digest: original, encodedOutputBytes: 0, shaInitializations: 0 })
  expect(await expectFreshDigest(variant)).not.toBe(original)
})

it('retains the completed digest when a different wrapper is revoked after SHA finalization', async () => {
  const input = document('completed-before-late-revocation')
  const original = await expectFreshDigest(input)
  const variant = { ...input, key: 'revoked-after-hash' }
  const reason = new Error('synthetic digest caller retired after hashing')
  const signal = new AbortController()
  const sodium = await getSodium()
  const finalize = sodium.crypto_hash_sha256_final.bind(sodium)
  const final = vi.spyOn(sodium, 'crypto_hash_sha256_final').mockImplementationOnce((state, format) => {
    const digest = finalize(state, format)
    signal.abort(reason)
    return digest
  })
  await expect(backupWorkspaceDocumentDigest(variant, async () => signal.signal.throwIfAborted())).rejects.toBe(reason)
  expect(final).toHaveBeenCalledTimes(1)
  final.mockRestore()
  expect(await observeDigest(input)).toEqual({ digest: original, encodedOutputBytes: 0, shaInitializations: 0 })
  expect(await expectFreshDigest(variant)).not.toBe(original)
})

it('keeps concurrent cold digests under their individual caller checkpoints', async () => {
  const input = document('concurrent-cold-digests')
  const expected = await backupMetadataDigest(input)
  const initialize = vi.spyOn(await getSodium(), 'crypto_hash_sha256_init')
  const reason = new Error('synthetic cold caller retired')
  const retired = backupWorkspaceDocumentDigest(input, async () => { throw reason })
  const live = backupWorkspaceDocumentDigest({ ...input }, liveCheckpoint)
  const results = await Promise.allSettled([retired, live])
  expect(results).toEqual([{ status: 'rejected', reason }, { status: 'fulfilled', value: expected }])
  expect(initialize).toHaveBeenCalledTimes(2)
})

it('retains scheduling for unbranded mutable catalogs and other document kinds', async () => {
  const check = vi.fn(async () => {}), input = document()
  const mutable = { ...input, value: structuredClone(SYNTHETIC_RETAINED_CATALOG) as never }
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
