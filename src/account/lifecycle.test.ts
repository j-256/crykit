import { activateTestProfile as activateProfile } from './testing/session'
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { startAccountDeviceApproval, waitForAccountDeviceApproval, cancelAccountDeviceApproval, removeProfileFromDevice, lockProfile, reconnectProfile, signOutProfile, updateOfflinePassword, unlockCachedProfile } from './lifecycle'
import { readDeviceProfile } from './device-store'
import { profileAccess, withAccountKey } from './profile'
const accountId = 'GGGGGGGGGGGGGGGGGGGGGA'
const sessionId = 'HHHHHHHHHHHHHHHHHHHHHA'
const unlocked = () => ({ accountId, username: 'person', key: new Uint8Array(32).fill(5), sessionId, deviceId: 'IIIIIIIIIIIIIIIIIIIIIA', csrf: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', authenticatedAt: 0 })
it('offlineSignoutDurablyBindsOriginalSessionAndRemovesRememberedMaterial', async () => {
  const token = await activateProfile(unlocked(), true, 'synthetic old password')
  expect(await signOutProfile(token)).toEqual({ revocationPending: true })
  const stored = await readDeviceProfile(accountId)
  expect(stored?.remembered).toBeUndefined()
  expect(stored?.pendingRevocations).toContain(sessionId)
  expect(stored?.passwordEnvelope).toBeDefined()
})
it('lockPreservesEncryptedPendingWorkAndOfflinePasswordReplacement', async () => {
  const token = await activateProfile(unlocked(), false, 'synthetic old password')
  const before = await readDeviceProfile(accountId)
  await lockProfile(token)
  expect(await readDeviceProfile(accountId)).toEqual(before)
  const reopened = await unlockCachedProfile(accountId, 'synthetic old password')
  await updateOfflinePassword(reopened, 'synthetic new password')
  await lockProfile(reopened)
  await expect(unlockCachedProfile(accountId, 'synthetic old password')).rejects.toThrow()
  const fresh = await unlockCachedProfile(accountId, 'synthetic new password')
  expect(await withAccountKey(fresh, async key => key[0])).toBe(5)
  await lockProfile(fresh)
})

it('failedSignoutWriteLocksImmediatelyAndPreservesThePreviousDurableRecord', async () => {
  const token = await activateProfile(unlocked(), true)
  const before = await readDeviceProfile(accountId)
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = () => { throw new DOMException('synthetic quota', 'QuotaExceededError') }
  try {
    const signingOut = signOutProfile(token)
    await expect(withAccountKey(token, async key => key[0])).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
    await expect(signingOut).rejects.toMatchObject({ name: 'QuotaExceededError' })
  } finally { IDBObjectStore.prototype.put = put }
  expect(await readDeviceProfile(accountId)).toEqual(before)
})

afterEach(() => vi.unstubAllGlobals())

it('guestApprovalWaitAbortsImmediatelyOnProfileActivationAndExposesOnlyPublicMetadata', async () => {
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let transportSignal: AbortSignal | undefined
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (path.endsWith('/start')) {
      const body = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ requestId: body.requestId, pairingContext: 'AAAAAAAAAAAAAAAAAAAAAA', expiresAt: Date.now() + 600_000 }))
    }
    transportSignal = init.signal as AbortSignal
    entered()
    return new Promise<Response>(() => {})
  })
  const view = await startAccountDeviceApproval('guest@example.org')
  expect(Object.keys(view).sort()).toEqual(['expiresAt', 'fingerprint', 'handle', 'requestId'])
  const pending = waitForAccountDeviceApproval(view.handle)
  const cancelled = expect(pending).rejects.toThrow('DEVICE_APPROVAL_CANCELLED')
  await started
  const token = await activateProfile(unlocked(), false)
  expect(transportSignal?.aborted).toBe(true)
  await cancelled
  await expect(waitForAccountDeviceApproval(view.handle)).rejects.toThrow('DEVICE_APPROVAL_CANCELLED')
  cancelAccountDeviceApproval(view.handle)
  await lockProfile(token)
})
it('cacheRemovalRequiresConfirmationAndCompletesBackupBeforeRemovingWork', async () => {
  const token = await activateProfile(unlocked(), true, 'synthetic backup password')
  const events: string[] = []
  const review = { pendingWork: true, exportBackup: async () => { events.push('backup') }, removeEncryptedData: async () => { events.push('remove') } }
  await expect(removeProfileFromDevice(token, review, { confirmed: false, recovery: 'discard' } as never)).rejects.toThrow('DEVICE_REMOVAL_CONFIRMATION_REQUIRED')
  expect(events).toEqual([])
  await removeProfileFromDevice(token, review, { confirmed: true, recovery: 'backup' })
  expect(events).toEqual(['backup', 'remove'])
  expect((await readDeviceProfile(accountId))?.passwordEnvelope).toBeUndefined()
  expect((await readDeviceProfile(accountId))?.remembered).toBeUndefined()
})

it('offlineUnlockAfterRestartRetainsExactSessionRevocationTargetWithoutOnlineAuthority', async () => {
  const token = await activateProfile(unlocked(), false, 'synthetic restart password')
  await lockProfile(token)
  const cached = await unlockCachedProfile(accountId, 'synthetic restart password')
  expect(await signOutProfile(cached)).toEqual({ revocationPending: true })
  expect((await readDeviceProfile(accountId))?.pendingRevocations).toContain(sessionId)
})

it('profileSwitchCannotPublishAnOldOfflinePasswordDerivation', async () => {
  const token = await activateProfile(unlocked(), false, 'synthetic prior password')
  const before = await readDeviceProfile(accountId)
  const updating = updateOfflinePassword(token, 'synthetic discarded password')
  const rejection = expect(updating).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  await lockProfile(token)
  await rejection
  expect(await readDeviceProfile(accountId)).toEqual(before)
})

it('lateGuestApprovalStartCannotPublishSecretsAfterLock', async () => {
  const token = await activateProfile(unlocked(), false)
  let resolve!: (response: Response) => void, requestId = ''
  vi.stubGlobal('fetch', (_path: string, init: RequestInit) => { requestId = JSON.parse(init.body as string).requestId; return new Promise<Response>(done => { resolve = done }) })
  const pending = startAccountDeviceApproval('guest@example.org')
  const rejected = expect(pending).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  await vi.waitFor(() => expect(resolve).toBeDefined())
  await lockProfile(token)
  resolve(new Response(JSON.stringify({ requestId, pairingContext: 'AAAAAAAAAAAAAAAAAAAAAA', expiresAt: Date.now() + 600_000 })))
  await rejected
})

it('revokedOnlineAuthorityLeavesTheUnlockedLocalCopyReadable', async () => {
  const token = await activateProfile(unlocked(), false, 'synthetic readable password')
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED', requestId: 'synthetic-revoked-session' } }), { status: 401 }))
  await expect(reconnectProfile(token)).rejects.toThrow('AUTH_REQUIRED')
  expect(profileAccess(token)).toBe('disconnected')
  expect(await withAccountKey(token, async key => key[0])).toBe(5)
  expect((await readDeviceProfile(accountId))?.passwordEnvelope).toBeDefined()
  await lockProfile(token)
})
