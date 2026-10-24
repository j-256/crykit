import { activateTestProfile as activateProfile } from './testing/session'
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultRemember, lockProfile, unlockCachedProfile } from './lifecycle'
import { assertActiveProfile, profileSignal, registerProfileCleanup, trackProfileUrl, withAccountKey } from './profile'
import type { UnlockResult } from './auth-client'
import { readDeviceProfile } from './device-store'
const accountId = 'AAAAAAAAAAAAAAAAAAAAAA'
const password = 'synthetic offline password'
const unlocked = (): UnlockResult => ({ accountId, username: 'person', key: new Uint8Array(32).fill(7), sessionId: 'BBBBBBBBBBBBBBBBBBBBBA', deviceId: 'CCCCCCCCCCCCCCCCCCCCCA', csrf: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', authenticatedAt: 0 })
let token: Awaited<ReturnType<typeof activateProfile>> | undefined
afterEach(async () => { if (token) { try { await lockProfile(token) } catch {} }; token = undefined; vi.unstubAllGlobals() })
it('rememberIsOptionalAndOfflinePasswordUnlockWorks', async () => {
  expect(defaultRemember).toBe(false)
  token = await activateProfile(unlocked(), false, password)
  expect((await readDeviceProfile(accountId))?.remembered).toBeUndefined()
  await lockProfile(token)
  expect(() => assertActiveProfile(token!)).toThrow('PROFILE_CHANGED')
  token = await unlockCachedProfile(accountId, password)
  expect(token.accountId).toBe(accountId)
  expect(await withAccountKey(token, async key => key[0])).toBe(7)
})
it('oldAsyncCompletionCannotEnterNewProfile', async () => {
  token = await activateProfile(unlocked(), false)
  let finish!: () => void
  const pending = withAccountKey(token, async () => { await new Promise<void>(resolve => { finish = resolve }); return 'old projection' })
  const signal = profileSignal(token)
  let cleared = false
  registerProfileCleanup(token, () => { cleared = true })
  const oldUrl = URL.createObjectURL(new Blob(['synthetic old projection']))
  trackProfileUrl(token, oldUrl)
  expect(await (await fetch(oldUrl)).text()).toBe('synthetic old projection')
  const old = token
  token = await activateProfile({ ...unlocked(), accountId: 'DDDDDDDDDDDDDDDDDDDDDA' }, false)
  finish()
  await expect(pending).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  expect(signal.aborted).toBe(true)
  expect(cleared).toBe(true)
  await expect(fetch(oldUrl)).rejects.toThrow()
  expect(() => assertActiveProfile(old)).toThrow('PROFILE_CHANGED')
})

it('lockingWipesScratchKeysBeforeHungConsumersComplete', async () => {
  token = await activateProfile(unlocked(), false)
  let scratch!: Uint8Array, finish!: () => void
  const work = withAccountKey(token, async key => { scratch = key; await new Promise<void>(resolve => { finish = resolve }) })
  await lockProfile(token)
  expect(scratch.every(byte => byte === 0)).toBe(true)
  const stale = expect(work).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  finish(); await stale
})

it('lockPreservesEncryptedPendingWorkOwnedByTheRepository', async () => {
  const { default: Dexie } = await import('dexie')
  const { wrapSecret } = await import('./crypto/envelopes')
  // A test-owned repository proves the lifecycle boundary without inventing S01 production persistence
  const repository = new Dexie('synthetic-pending-work-proof')
  repository.version(1).stores({ pending: 'id' })
  try {
    token = await activateProfile(unlocked(), false)
    const pendingCiphertext = await withAccountKey(token, key => wrapSecret(new Uint8Array(32).fill(3), key, [1, accountId]))
    await repository.table('pending').put({ id: 'pending', pendingCiphertext })
    let projection: string | undefined = 'synthetic unlocked title'
    registerProfileCleanup(token, () => { projection = undefined })
    await lockProfile(token)
    expect(projection).toBeUndefined()
    expect((await repository.table('pending').get('pending')).pendingCiphertext).toEqual(pendingCiphertext)
  } finally { await repository.delete() }
})
