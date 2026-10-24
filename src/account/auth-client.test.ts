import { afterEach, expect, it, vi } from 'vitest'
import { accountRequest } from './auth-client'
import { AccountMetadataSchema } from './protocol'

afterEach(() => { vi.unstubAllGlobals() })

it('retainsTheRateLimitReferenceAndServerRetryTime', async () => {
  const requestId = 'd679dff4-91ad-4e87-951a-d5198a772870'
  const before = Date.now()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Rate limited</html>', { status: 429, headers: { 'retry-after': '120', 'x-crykit-request-id': requestId } })))
  const error = await accountRequest('account', undefined, AccountMetadataSchema).catch(error => error)
  expect(error).toMatchObject({ message: 'RATE_LIMITED', requestId })
  expect(error.retryAt).toBeGreaterThanOrEqual(before + 120_000)
})

it.each(['<html>Rate limited</html>', '{"error":"Too many requests"}'])('reportsEdgeRateLimitingBeforeAccountJsonValidation: %s', async body => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 429 })))
  await expect(accountRequest('account', undefined, AccountMetadataSchema)).rejects.toThrow('RATE_LIMITED')
})
