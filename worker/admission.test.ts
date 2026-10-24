import { afterEach, expect, it } from 'vitest'
import { createServiceFixture, type FixtureOptions, type ServiceFixture } from './testing/service-fixture'
import { adminFixture } from './testing/admin-fixture'
import { command, customer, id, post, prepared } from './sync/testing'
import { AdmissionDenied, admitCloudRequest, admitIngress, reportAdmissionDenied } from './admission'
import { createServiceContext, type SafeEvent } from './context'

const fixtures: ServiceFixture[] = []
const dayMs = 24 * 60 * 60 * 1000
async function fixture(options: FixtureOptions = {}) {
  const value = await createServiceFixture(options)
  fixtures.push(value)
  return value
}
afterEach(async () => { await Promise.all(fixtures.splice(0).map(value => value.dispose())) })

it('reportsTheActualServiceBudgetWithoutLoggingCounterIdentities', async () => {
  const f = await fixture()
  const events: SafeEvent[] = []
  const request = new Request('https://example.test/api/v1/account?synthetic-private')
  const context = createServiceContext(request, { DB: f.db, SESSION_SECRET: f.env.SESSION_SECRET, CLOUD_DAILY_REQUEST_BUDGET: '1' }, { now: () => Date.UTC(2026, 9, 21), emit: event => { events.push(event) } })
  await admitCloudRequest(context)
  try { await admitCloudRequest(context); expect.fail('The exhausted service allowance must reject') } catch (error) {
    expect(error).toBeInstanceOf(AdmissionDenied)
    reportAdmissionDenied(error as AdmissionDenied, context)
  }
  expect(events).toEqual([expect.objectContaining({ code: 'SERVICE_PAUSED', limiter: 'cloud-request-daily', scope: 'service', limit: 1, observedCount: 1, counter: 'admitted', windowMs: dayMs, retryAfterSeconds: dayMs / 1000, route: '/api/v1/account', method: 'GET' })])
  expect(JSON.stringify(events)).not.toContain('synthetic-private')
})

it('reportsNativePolicyIdentityWithoutInventingItsCountOrThreshold', async () => {
  const events: SafeEvent[] = []
  const request = new Request('https://example.test/api/v1/account?synthetic-private')
  const context = createServiceContext(request, { CLOUD_LOCATION_LIMITER: { limit: async () => ({ success: false }) } as RateLimit }, { now: () => Date.UTC(2026, 9, 22), emit: event => { events.push(event) } })
  try { await admitIngress(request, context); expect.fail('Native admission must reject') } catch (error) {
    expect(error).toBeInstanceOf(AdmissionDenied)
    reportAdmissionDenied(error as AdmissionDenied, context)
  }
  expect(events).toEqual([expect.objectContaining({ code: 'RATE_LIMITED', limiter: 'cloud-location', scope: 'location', counter: 'unavailable', retryAfterSeconds: 60 })])
  expect(events[0]).not.toHaveProperty('limit')
  expect(events[0]).not.toHaveProperty('observedCount')
  expect(JSON.stringify(events)).not.toContain('synthetic-private')
})

it('pausesConcurrentCloudRequestsWithoutOverspendingTheServiceBudget', async () => {
  const f = await fixture({ cloudRequestBudget: { daily: 1, monthly: 3 } })
  await f.objects.put('retained-original', 'synthetic exact original')
  const responses = await Promise.all(Array.from({ length: 12 }, () => f.request('/api/v1/account')))
  expect(responses.filter(response => response.status === 401)).toHaveLength(1)
  const paused = responses.filter(response => response.status === 503)
  expect(paused).toHaveLength(11)
  for (const response of paused) {
    expect(await response.json()).toMatchObject({ error: { code: 'SERVICE_PAUSED' } })
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
  }
  expect((await f.request('/')).status).toBe(200)
  expect(await (await f.objects.get('retained-original'))!.text()).toBe('synthetic exact original')
})

it('keepsTheMonthlyBudgetWhenTheDailyWindowResets', async () => {
  const f = await fixture({ now: Date.UTC(2026, 0, 10), cloudRequestBudget: { daily: 1, monthly: 2 } })
  expect((await f.request('/api/v1/account')).status).toBe(401)
  expect((await f.request('/api/v1/account')).status).toBe(503)
  f.advance(dayMs)
  expect((await f.request('/api/v1/account')).status).toBe(401)
  f.advance(dayMs)
  const paused = await f.request('/api/v1/account')
  expect(await paused.json()).toMatchObject({ error: { code: 'SERVICE_PAUSED' } })
  expect(Number(paused.headers.get('retry-after'))).toBe(20 * 24 * 60 * 60)
  f.advance(20 * dayMs)
  expect((await f.request('/api/v1/account')).status).toBe(401)
})

it.each(['network', 'location', 'auth'] as const)('rejectsAtTheNative%sLimitBeforeTouchingAnUnavailableDatabase', async role => {
  const f = await fixture({ admissionLimits: { [role]: 2 } })
  const path = role === 'auth' ? '/api/v1/auth/login/start' : '/api/v1/service'
  const init = role === 'auth' ? { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1' }, body: '{}' } : undefined
  const acceptedStatus = role === 'auth' ? 400 : 200
  expect((await f.request(path, init)).status).toBe(acceptedStatus)
  expect((await f.request(path, init)).status).toBe(acceptedStatus)
  await f.db.exec('DROP TABLE recovery_control')
  const denied = await f.request(role === 'auth' ? path : '/api/v1/account', init)
  expect(denied.status).toBe(429)
  expect(await denied.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } })
  expect((await f.request('/')).status).toBe(200)
})

it('isolatesIndependentSyntheticJourneysWithoutBypassingNativeAuthLimits', async () => {
  const f = await fixture({ admissionLimits: { auth: 2 } })
  const login = (network?: string) => f.request('/api/v1/auth/login/start', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1', ...(network ? { 'cf-connecting-ip': network } : {}) },
  })
  expect((await login()).status).toBe(400)
  expect((await login()).status).toBe(400)
  expect((await login()).status).toBe(429)
  expect((await login('127.0.0.1')).status).toBe(429)
  const explicitNetwork = '192.0.2.10'
  expect((await login(explicitNetwork)).status).toBe(400)
  expect((await login(explicitNetwork)).status).toBe(400)
  expect((await login(explicitNetwork)).status).toBe(429)
  expect((await f.request('/__accounts/control/reset-rate-counters', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200)
  expect((await login()).status).toBe(400)
  expect((await login('127.0.0.1')).status).toBe(400)
  expect((await login()).status).toBe(429)
  expect((await login(explicitNetwork)).status).toBe(429)
})

it('sharesAnAuthenticatedAccountLimitAcrossDifferentNetworks', async () => {
  const f = await fixture({ admissionLimits: { account: 2 } })
  const signed = await customer(f)
  for (const address of ['192.0.2.1', '192.0.2.2']) {
    expect((await f.request('/api/v1/account', { headers: { ...signed.headers, 'cf-connecting-ip': address } })).status).toBe(200)
  }
  const before = await f.db.prepare('SELECT idle_expires_at FROM customer_sessions').first('idle_expires_at')
  f.advance(1000)
  const denied = await f.request('/api/v1/account', { headers: { ...signed.headers, 'cf-connecting-ip': '192.0.2.3' } })
  expect(denied.status).toBe(429)
  expect(await f.db.prepare('SELECT idle_expires_at FROM customer_sessions').first('idle_expires_at')).toBe(before)
})

it('keepsOwnerAdministrationAvailableDuringAnAutomaticCloudPause', async () => {
  const admin = await adminFixture({ cloudRequestBudget: { daily: 1, monthly: 3 } })
  fixtures.push(admin.f)
  expect((await admin.f.request('/api/v1/account')).status).toBe(401)
  expect((await admin.f.request('/api/v1/account')).status).toBe(503)
  expect((await admin.f.request('/api/admin/v1/session', { headers: admin.headers })).status).toBe(200)
})

it('pausesScheduledEmailAndResumesItsOriginalQueuedJobAfterTheBudgetWindow', async () => {
  const f = await fixture({ now: Date.UTC(2026, 0, 10, 23, 59, 30), cloudRequestBudget: { daily: 1, monthly: 3 } })
  const jobId = id()
  const queued = await f.request('/__accounts/email/enqueue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId, message: { kind: 'security-notice', recipient: 'synthetic@example.org', correlationId: 'budget-regression' } }) })
  expect(queued.status).toBe(200)
  const original = await f.db.prepare('SELECT state,attempts FROM email_jobs WHERE id=?').bind(jobId).first()
  expect((await f.request('/api/v1/account')).status).toBe(401)
  expect((await f.request('/__accounts/scheduled', { method: 'POST' })).status).toBe(200)
  expect(await f.emails()).toHaveLength(0)
  expect(await f.db.prepare('SELECT state,attempts FROM email_jobs WHERE id=?').bind(jobId).first()).toEqual(original)
  // Cross the service window while preserving the email's independent expiry
  f.advance(60_000)
  expect((await f.request('/__accounts/scheduled', { method: 'POST' })).status).toBe(200)
  expect(await f.emails()).toHaveLength(1)
  expect(await f.db.prepare('SELECT state,delivery,attempts FROM email_jobs WHERE id=?').bind(jobId).first()).toEqual({ state: 'complete', delivery: 'accepted', attempts: 1 })
})

it('chargesAuthenticatedSyncWorkAndPreservesTheMonthlyWorkWindow', async () => {
  const f = await fixture({ now: Date.UTC(2026, 0, 10, 23, 59, 30), cloudWorkBudget: { daily: 136, monthly: 272 } })
  for (let attempt = 0; attempt < 3; attempt++) expect((await post(f, 'sync/commits', command([], [], []))).status).toBe(401)
  const signed = await customer(f)
  const first = await prepared(f, signed)
  await f.db.prepare("UPDATE accounts SET access='read-only' WHERE id=?").bind(signed.accountId).run()
  expect((await post(f, 'sync/commits', command([first.descriptor]), signed.headers)).status).toBe(403)
  expect((await f.request('/api/v1/account', { headers: signed.headers })).status).toBe(200)
  await f.db.prepare("UPDATE accounts SET access='active' WHERE id=?").bind(signed.accountId).run()
  const expensive = command([{ ...first.descriptor, dependencies: Array.from({ length: 3 }, () => ({ documentId: id(), revisionId: id() })) }])
  expect((await post(f, 'sync/commits', expensive, signed.headers)).status).toBe(503)
  expect(await f.db.prepare('SELECT COUNT(*) FROM sync_documents WHERE account_id=?').bind(signed.accountId).first('COUNT(*)')).toBe(0)
  const firstCommand = command([first.descriptor])
  expect((await post(f, 'sync/commits', firstCommand, signed.headers)).status).toBe(200)
  expect((await f.request('/api/v1/account', { headers: signed.headers })).status).toBe(503)
  f.advance(60_000)
  expect((await f.request('/api/v1/account', { headers: signed.headers })).status).toBe(200)
  const second = await prepared(f, signed)
  expect((await post(f, 'sync/commits', command([second.descriptor]), signed.headers)).status).toBe(200)
  f.advance(dayMs)
  const paused = await f.request('/api/v1/account', { headers: signed.headers })
  expect(await paused.json()).toMatchObject({ error: { code: 'SERVICE_PAUSED' } })
  expect(await f.db.prepare('SELECT head FROM sync_documents WHERE account_id=? ORDER BY head').bind(signed.accountId).all()).toMatchObject({ results: [first.descriptor.revisionId, second.descriptor.revisionId].sort().map(head => ({ head })) })
})
