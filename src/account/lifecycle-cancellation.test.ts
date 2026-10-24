import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { activateProfile, lockProfile, signOutProfile, startAccountDeviceApproval, unlockCachedProfile } from './lifecycle'
import { invalidateProfile, withAccountKey } from './profile'
import { readDeviceProfile } from './device-store'
import * as localUnlock from './crypto/local-unlock'
import { getSodium } from './crypto/sodium'
import { activateTestProfile } from './testing/session'

const accountId = 'JJJJJJJJJJJJJJJJJJJJJA'
const otherId = 'KKKKKKKKKKKKKKKKKKKKKA'
const unlocked = (owner = accountId) => ({ accountId: owner, username: 'person', key: new Uint8Array(32).fill(owner === accountId ? 6 : 8), sessionId: 'LLLLLLLLLLLLLLLLLLLLLA', deviceId: 'MMMMMMMMMMMMMMMMMMMMMA', csrf: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', authenticatedAt: 0 })
afterEach(() => { invalidateProfile(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('cancellingPendingActivationWipesItsOwnedKeyBeforeDerivationSettles', async () => {
  let owned!: Uint8Array, finish!: () => void
  vi.spyOn(localUnlock, 'createLocalPasswordEnvelope').mockImplementation(async key => {
    owned = key
    await new Promise<void>(resolve => { finish = resolve })
    return {} as localUnlock.LocalPasswordEnvelope
  })
  const input = unlocked()
  const result = activateProfile(input, false, 'synthetic pending password').catch(error => error)
  await vi.waitFor(() => expect(finish).toBeDefined())
  expect(input.key.every(byte => byte === 0)).toBe(true)
  invalidateProfile()
  try { expect(owned.every(byte => byte === 0)).toBe(true) }
  finally { finish() }
  expect(await result).toMatchObject({ code: 'PROFILE_CHANGED' })
  expect(await readDeviceProfile(accountId)).toBeUndefined()
})

it('cancellingApprovalStartWipesOwnedBuffersAndAbortsTransportBeforeItSettles', async () => {
  const sodium = await getSodium()
  // Instrument the binary overloads used by approval start, without replacing the underlying key generation
  const binary: { crypto_box_keypair(): { publicKey: Uint8Array; privateKey: Uint8Array; keyType: string }; randombytes_buf(size: number): Uint8Array } = sodium
  const keypair = binary.crypto_box_keypair.bind(binary), random = binary.randombytes_buf.bind(binary)
  let privateKey!: Uint8Array, capabilityBytes!: Uint8Array, transportSignal: AbortSignal | undefined
  let finish!: (response: Response) => void
  vi.spyOn(binary, 'crypto_box_keypair').mockImplementation(() => { const keys = keypair(); privateKey = keys.privateKey; return keys })
  vi.spyOn(binary, 'randombytes_buf').mockImplementation((size: number) => { const bytes = random(size); if (size === 32) capabilityBytes = bytes; return bytes })
  vi.stubGlobal('fetch', (_path: string, init: RequestInit) => { transportSignal = init.signal as AbortSignal; return new Promise<Response>(resolve => { finish = resolve }) })
  const result = startAccountDeviceApproval('synthetic@example.org').catch(error => error)
  await vi.waitFor(() => expect(finish).toBeDefined())
  invalidateProfile()
  try {
    expect(privateKey.every(byte => byte === 0)).toBe(true)
    expect(capabilityBytes.every(byte => byte === 0)).toBe(true)
    expect(transportSignal?.aborted).toBe(true)
  } finally { finish(new Response('{}', { status: 500 })) }
  expect(await result).toMatchObject({ code: 'PROFILE_CHANGED' })
})

it('signoutRejectsStaleGenerationAndKeepsItsOriginalDurableTarget', async () => {
  const other = await activateTestProfile(unlocked(otherId), false, 'synthetic other password')
  await lockProfile(other)
  const input = unlocked(), token = await activateTestProfile(input, true)
  let finish!: (response: Response) => void, transportSignal!: AbortSignal
  vi.stubGlobal('fetch', (_path: string, init: RequestInit) => { transportSignal = init.signal as AbortSignal; return new Promise<Response>(resolve => { finish = resolve }) })
  const result = signOutProfile(token).catch(error => error)
  await vi.waitFor(() => expect(finish).toBeDefined())
  const before = await readDeviceProfile(accountId)
  expect(before?.pendingRevocations).toContain(input.sessionId)
  const successor = await unlockCachedProfile(otherId, 'synthetic other password')
  expect(transportSignal.aborted).toBe(true)
  finish(new Response('{}', { status: 401 }))
  expect(await result).toMatchObject({ code: 'PROFILE_CHANGED' })
  expect(await withAccountKey(successor, async key => key[0])).toBe(8)
  expect(await readDeviceProfile(accountId)).toEqual(before)
})
it('transition reasons preserve default callbacks and identical pagehide cleanup', async () => {
  const profile = await import('./profile')
  const reasons: string[] = []
  let legacyCalls = 0
  const stop = profile.onProfileTransition(reason => reasons.push(reason))
  const stopLegacy = profile.onProfileTransition(() => { legacyCalls++ })
  try {
    const key = new Uint8Array(32).fill(9)
    const token = profile.installProfile(accountId, key)
    const signal = profile.profileSignal(token)
    let cleaned = false
    profile.registerProfileCleanup(token, () => { cleaned = true })
    profile.invalidateProfile('pagehide')
    expect(key.every(byte => byte === 0)).toBe(true)
    expect(signal.aborted).toBe(true)
    expect(cleaned).toBe(true)
    expect(profile.currentProfileToken()).toBeUndefined()
    profile.invalidateProfile()
    expect(reasons).toEqual(['pagehide', 'transition'])
    expect(legacyCalls).toBe(2)
  } finally { stop(); stopLegacy() }
})
