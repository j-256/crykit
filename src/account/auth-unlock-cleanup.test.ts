import { afterEach, expect, it, vi } from 'vitest'
import { loginAccount, loginWithRecovery } from './auth-client'
import { credentialIdForRole, keyEnvelopeAlgorithm } from './protocol'
import { invalidateProfile } from './profile'

const owned = vi.hoisted(() => ({ key: new Uint8Array(32) }))
vi.mock('./crypto/opaque', () => ({
  startLogin: async () => ({ state: 'synthetic', request: 'synthetic' }),
  finishLogin: async () => ({ request: 'synthetic', exportKey: new Uint8Array(64).fill(3) }),
}))
vi.mock('./crypto/envelopes', () => ({ deriveWrappingKey: async () => new Uint8Array(32).fill(4), unwrapSecret: async () => owned.key }))
vi.mock('./recovery', () => ({ parseRecoveryCode: async () => new Uint8Array(32).fill(5), recoveryCredentialSecret: () => 'synthetic' }))
vi.mock('./auth-coordinator', () => ({
  // Exercise the rejection boundary after a successful callback has returned its owned raw key
  withAuthLock: async (operation: (run: (request: (signal: AbortSignal) => Promise<unknown>) => Promise<unknown>) => Promise<unknown>) => {
    await operation(request => request(new AbortController().signal))
    const { invalidateProfile, ProfileChangedError } = await import('./profile')
    invalidateProfile()
    throw new ProfileChangedError()
  },
}))
afterEach(() => { vi.unstubAllGlobals(); invalidateProfile() })
for (const role of ['password', 'recovery'] as const) {
  it(`${role}UnlockWipesItsOwnedKeyWhenCoordinatorRejectsAfterCallbackResolution`, async () => {
    owned.key = new Uint8Array(32).fill(7)
    const bytes = (size: number) => Buffer.alloc(size).toString('base64url')
    const accountId = bytes(16), deviceId = bytes(16)
    const session = { accountId, username: 'synthetic', sessionId: bytes(16), deviceId, csrf: bytes(32), authenticatedAt: 0 }
    const device = { id: deviceId, createdAt: 0, revokedAt: null }
    const metadata = { ...session, absoluteExpiresAt: 86_400_000, access: 'active', email: 'synthetic@example.org', verified: true, revision: 1, quota: { capacityBytes: 1024 }, policy: { ordinary: { idleMs: 28_800_000, absoluteMs: 86_400_000 }, remembered: { idleMs: 604_800_000, absoluteMs: 2_592_000_000 } }, devicePage: { devices: [device], currentDevice: device, hasMore: false, nextCursor: null }, credentials: { passwordRevision: 1, recoveryRevision: 1 } }
    vi.stubGlobal('fetch', async (path: string) => new Response(JSON.stringify(path.endsWith('/start')
      ? { attemptId: bytes(16), credentialId: credentialIdForRole(accountId, role), loginResponse: bytes(320), expiresAt: 1 }
      : path.endsWith('/finish') ? { ...session, accountEnvelope: { version: 1, algorithm: keyEnvelopeAlgorithm, nonce: bytes(24), ciphertext: bytes(48) } } : metadata)))
    const result = role === 'password' ? loginAccount({ email: 'synthetic@example.org', password: 'synthetic cleanup password', remember: false }) : loginWithRecovery('synthetic@example.org', 'synthetic', false)
    await expect(result).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
    expect(owned.key.every(byte => byte === 0)).toBe(true)
  })
}
