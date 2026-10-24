import { afterEach, expect, it, vi } from 'vitest'
import { clearServiceNotice, readServiceNotice, serviceNoticeRequest, serviceSupportLink } from './service-notice'
import { installProfile, invalidateProfile, setProfileSession } from './profile'

const requestId = 'd679dff4-91ad-4e87-951a-d5198a772870'
afterEach(() => { invalidateProfile(); clearServiceNotice(); vi.restoreAllMocks() })
it('usesTheLaterServerRetryFloorAndPreservesOnlySafeSupportMetadata', () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 20))
  const response = new Response('', { status: 503, headers: { 'retry-after': '120' } })
  serviceNoticeRequest('synthetic').failure(response, 'SERVICE_PAUSED', requestId, 180)
  const notice = readServiceNotice()!
  expect(notice).toMatchObject({ code: 'SERVICE_PAUSED', requestId, retryAt: Date.now() + 180_000 })
  const body = new URL(serviceSupportLink(notice, 'synthetic-preview')).searchParams.get('body')!
  expect(body).toContain(`Reference: ${requestId}`)
  expect(body).toContain('App version: synthetic-preview')
  expect(body).not.toContain('synthetic\n')
})
it('supportsHttpDatesWithoutInventingAnUnknownResetTime', () => {
  const now = Date.UTC(2026, 9, 20)
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const request = serviceNoticeRequest('synthetic')
  request.failure(new Response('', { status: 429, headers: { 'retry-after': new Date(now + 90_000).toUTCString() } }), 'RATE_LIMITED')
  expect(readServiceNotice()?.retryAt).toBe(now + 90_000)
  request.failure(new Response('', { status: 429, headers: { 'retry-after': '99999999999999999999999999', 'x-crykit-request-id': 'untrusted?private=secret' } }), 'RATE_LIMITED')
  expect(readServiceNotice()).toMatchObject({ requestId: undefined, retryAt: undefined })
})
it('doesNotLetAnEarlierSuccessfulRequestEraseALaterRejection', () => {
  const earlier = serviceNoticeRequest('same-action'), later = serviceNoticeRequest('same-action')
  later.failure(new Response('', { status: 429 }), 'RATE_LIMITED', requestId)
  earlier.succeeded()
  expect(readServiceNotice()?.requestId).toBe(requestId)
  serviceNoticeRequest('different-action').succeeded()
  expect(readServiceNotice()?.requestId).toBe(requestId)
  serviceNoticeRequest('same-action').succeeded()
  expect(readServiceNotice()).toBeUndefined()
})
it('doesNotReplaceANewerNoticeWithAnOlderOrCancelledFailure', () => {
  const earlier = serviceNoticeRequest('earlier'), later = serviceNoticeRequest('later')
  later.failure(new Response('', { status: 429 }), 'RATE_LIMITED', 'newer-reference')
  earlier.failure(new Response('', { status: 429 }), 'RATE_LIMITED', 'older-reference')
  expect(readServiceNotice()?.requestId).toBe('newer-reference')
  const controller = new AbortController()
  const cancelled = serviceNoticeRequest('cancelled', controller.signal)
  controller.abort()
  cancelled.failure(new Response('', { status: 429 }), 'RATE_LIMITED', 'cancelled-reference')
  expect(readServiceNotice()?.requestId).toBe('newer-reference')
})
it.each(['profile', 'session'])('ignoresLateRejectionsAfterA%sChange', change => {
  const accountId = 'AAAAAAAAAAAAAAAAAAAAAA'
  const session = { accountId, username: 'synthetic', sessionId: 'BBBBBBBBBBBBBBBBBBBBBA', deviceId: 'CCCCCCCCCCCCCCCCCCCCCA', csrf: 'synthetic', authenticatedAt: 1 }
  const token = installProfile(accountId, new Uint8Array(32), session)
  const old = serviceNoticeRequest('old-action')
  if (change === 'profile') invalidateProfile()
  else setProfileSession(token, { ...session, sessionId: session.deviceId })
  old.failure(new Response('', { status: 429 }), 'RATE_LIMITED', requestId)
  expect(readServiceNotice()).toBeUndefined()
})
