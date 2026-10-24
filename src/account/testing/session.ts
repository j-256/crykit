import { vi } from 'vitest'
import type { UnlockResult } from '../auth-client'
import { activateProfile } from '../lifecycle'

// Test-owned transport adapter; production activation always checks real metadata under the browser lock
export function activateTestProfile(unlocked: UnlockResult, remember: boolean, password?: string) {
  const previous = globalThis.fetch
  vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
    if (path !== '/api/v1/account') return previous(path, init)
    const { key: _key, ...session } = unlocked
    const device = { id: unlocked.deviceId, createdAt: 0, revokedAt: null }
    return Promise.resolve(new Response(JSON.stringify({ ...session, absoluteExpiresAt: 86_400_000, access: 'active', email: 'synthetic@example.org', verified: true, revision: 1, quota: { capacityBytes: 1024 }, policy: { ordinary: { idleMs: 28_800_000, absoluteMs: 86_400_000 }, remembered: { idleMs: 604_800_000, absoluteMs: 2_592_000_000 } }, devicePage: { devices: [device], currentDevice: device, hasMore: false, nextCursor: null }, credentials: { passwordRevision: 1, recoveryRevision: null } })))
  })
  return activateProfile(unlocked, remember, password)
}
