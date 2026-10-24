import { afterEach, expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile, setProfileSession } from './profile'
import { publishSnapshot, readPublishedSnapshot } from './shares-client'
import type { PublicSnapshot } from '../interchange/public-share-schema'
const accountId = 'AAAAAAAAAAAAAAAAAAAAAA', sessionId = 'BBBBBBBBBBBBBBBBBBBBBA'
const session = { accountId, username: 'person', sessionId, deviceId: 'CCCCCCCCCCCCCCCCCCCCCA', csrf: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', authenticatedAt: 0 }
const snapshot: PublicSnapshot = { version: 5, kind: 'build', title: 'Safe build', setup: { baseline: null, layers: [], mode: { state: 'unknown' }, ppCostsNonNegative: { state: 'unknown' }, slots: [] }, slots: [{ primaryClass: null, secondaryClass: null, equipment: [], equipmentGroups: [], passives: [] }], receipts: [] }
afterEach(() => { invalidateProfile(); vi.unstubAllGlobals() })
it('reportsAnAnonymousEdgeRateLimitWithoutParsingItAsASnapshot', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Rate limited</html>', { status: 429 })))
  await expect(readPublishedSnapshot(accountId, new AbortController().signal)).rejects.toThrow('RATE_LIMITED')
})
it('retainsAnonymousSharingSupportDetailsWithoutReadingAnEdgeBody', async () => {
  const requestId = 'd679dff4-91ad-4e87-951a-d5198a772870'
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Rate limited</html>', { status: 429, headers: { 'retry-after': '90', 'x-crykit-request-id': requestId } })))
  const before = Date.now()
  const error = await readPublishedSnapshot(accountId, new AbortController().signal).catch(error => error)
  expect(error).toMatchObject({ message: 'RATE_LIMITED', requestId })
  expect(error.retryAt).toBeGreaterThanOrEqual(before + 90_000)
})
it.each(['profile', 'session'])('rejects late publication response after %s replacement', async change => {
  const token = installProfile(accountId, new Uint8Array(32), session)
  let finish!: (value: Response) => void
  const mocked = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
  vi.stubGlobal('fetch', mocked)
  const work = publishSnapshot(token, { mutationId: accountId, snapshot, includeAttribution: false })
  const assertion = expect(work).rejects.toThrow(change === 'profile' ? 'PROFILE_CHANGED' : 'PROFILE_SESSION_CHANGED')
  if (change === 'profile') { invalidateProfile(); installProfile(sessionId, new Uint8Array(32), { ...session, accountId: sessionId }) }
  else setProfileSession(token, { ...session, sessionId: session.deviceId })
  finish(Response.json({ shareId: accountId, revision: 1, active: true, url: `https://example.test/#/s/${accountId}` }))
  await assertion
  expect(mocked.mock.calls[0]).toBeDefined()
})
it('anonymous read omits credentials and rejects any private output field', async () => {
  const mocked = vi.fn(async () => Response.json({ snapshot, revision: 1, ownerId: 'PRIVATE_OWNER' }))
  vi.stubGlobal('fetch', mocked)
  await expect(readPublishedSnapshot(accountId, new AbortController().signal)).rejects.toThrow()
  expect(mocked).toHaveBeenCalledWith(`/api/public/v1/shares/${accountId}`, expect.objectContaining({ credentials: 'omit', cache: 'no-store' }))
})
it('cancels oversized anonymous bodies before rendering any snapshot', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(300_000))))
  await expect(readPublishedSnapshot(accountId, new AbortController().signal)).rejects.toThrow('INTEGRITY_FAILED')
})
it('rejects a response after the captured repository caller cancels', async () => {
  const token = installProfile(accountId, new Uint8Array(32), session), controller = new AbortController()
  let finish!: (value: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
  const work = publishSnapshot(token, { mutationId: accountId, snapshot, includeAttribution: false }, controller.signal)
  const rejection = expect(work).rejects.toThrow()
  controller.abort()
  finish(Response.json({ shareId: accountId, revision: 1, active: true, url: `https://example.test/#/s/${accountId}` }))
  await rejection
})
