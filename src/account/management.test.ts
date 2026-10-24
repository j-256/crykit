import { afterEach, expect, it, vi } from 'vitest'
import { readAccountView } from './management'
import { currentProfileToken, installProfile, invalidateProfile } from './profile'

afterEach(() => { invalidateProfile(); vi.restoreAllMocks() })
it('abortsAuthenticatedManagementImmediatelyOnLock', async () => {
  const token = installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32), { accountId: 'AAAAAAAAAAAAAAAAAAAAAA', username: 'synthetic', sessionId: 'session', deviceId: 'device', csrf: 'secret', authenticatedAt: 1 })
  let captured: AbortSignal | undefined
  vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    captured = init?.signal as AbortSignal
    return new Promise((_resolve, reject) => captured!.addEventListener('abort', () => reject(captured!.reason)))
  })
  const pending = readAccountView(token)
  expect(captured?.aborted).toBe(false)
  invalidateProfile()
  expect(captured?.aborted).toBe(true)
  await expect(pending).rejects.toThrow('PROFILE_CHANGED')
  expect(currentProfileToken()).toBeUndefined()
})

it.each(['AUTH_REQUIRED', 'CSRF_FAILED'])('oldSessionFailureCannotDisconnectRenewedAuthority:%s', async code => {
  const { profileAccess, profileSessionIdentity, setProfileSession } = await import('./profile')
  const session = { accountId: 'AAAAAAAAAAAAAAAAAAAAAA', username: 'synthetic', sessionId: 'old-session', deviceId: 'device', csrf: 'secret', authenticatedAt: 1 }
  const token = installProfile(session.accountId, new Uint8Array(32), session)
  let reject!: (error: Error) => void
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
  const pending = readAccountView(token)
  const rejected = expect(pending).rejects.toThrow('PROFILE_SESSION_CHANGED')
  setProfileSession(token, { ...session, sessionId: 'new-session' })
  reject(new Error(code))
  await rejected
  expect(profileAccess(token)).toBe('connected')
  expect(profileSessionIdentity(token).sessionId).toBe('new-session')
})

it('oldSessionSuccessCannotPublishPrivateMetadata', async () => {
  const { setProfileSession, withProfileSession } = await import('./profile')
  const session = { accountId: 'AAAAAAAAAAAAAAAAAAAAAA', username: 'synthetic', sessionId: 'old-session', deviceId: 'device', csrf: 'secret', authenticatedAt: 1 }
  const token = installProfile(session.accountId, new Uint8Array(32), session)
  let finish!: () => void
  const pending = withProfileSession(token, async () => { await new Promise<void>(resolve => { finish = resolve }); return { username: 'obsolete' } })
  setProfileSession(token, { ...session, sessionId: 'new-session' })
  finish()
  await expect(pending).rejects.toThrow('PROFILE_SESSION_CHANGED')
})

it.each(['AUTH_REQUIRED', 'CSRF_FAILED'])('currentSessionFailureStillDisconnects:%s', async code => {
  const { profileAccess } = await import('./profile')
  const token = installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32), { accountId: 'AAAAAAAAAAAAAAAAAAAAAA', username: 'synthetic', sessionId: 'current-session', deviceId: 'device', csrf: 'secret', authenticatedAt: 1 })
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(code))
  await expect(readAccountView(token)).rejects.toThrow(code)
  expect(profileAccess(token)).toBe('disconnected')
})
