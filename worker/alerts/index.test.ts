import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, Response as LocalResponse, type V4ModuleDefinition } from 'miniflare'
import alertWorker, { alertObservations } from './index'
import { nativeFixtureHost } from '../testing/native-loopback'

const startedAt = Date.UTC(2026, 9, 20)
const requestId = 'd679dff4-91ad-4e87-951a-d5198a772870'
function trace(extra: Partial<TraceItem> = {}): TraceItem {
  return { event: null, eventTimestamp: startedAt, logs: [], exceptions: [], diagnosticsChannelEvents: [], scriptName: 'producer', outcome: 'ok', executionModel: 'stateless', truncated: false, cpuTime: 1, wallTime: 1, ...extra }
}
const observation = (code = 'RATE_LIMITED') => ({ code, stage: 'account', requestId, occurredAt: startedAt, observations: 1 })
it('extractsOnlyAuthoredSafeFieldsAndGroupsEachInvocationOnce', () => {
  const privateFields = { url: 'https://example.test/?capability=synthetic-private', password: 'synthetic-private', ciphertext: 'synthetic-private' }
  const log = { timestamp: startedAt, level: 'log', message: [JSON.stringify({ operation: 'admission', ...observation(), ...privateFields })] }
  const result = alertObservations([trace({ logs: [log, log] }), trace({ scriptName: 'unrelated', logs: [log] })], 'producer')
  expect(result).toEqual([observation()])
  expect(JSON.stringify(result)).not.toContain('synthetic-private')
})
it('observesACoalesced429WithoutCopyingItsHeadersOrUrl', () => {
  const result = alertObservations([trace({ event: { request: { url: 'https://example.test/?capability=synthetic-private', method: 'POST', headers: { authorization: 'synthetic-private' }, getUnredacted() { return this } }, response: { status: 429 } } })], 'producer')
  expect(result).toEqual([{ code: 'RATE_LIMITED', stage: 'unspecified', occurredAt: startedAt, observations: 1, route: 'unmatched', method: 'POST' }])
})

it('keepsBlockingPolicyDetailsWhenTheRouteAlsoReportsTheSameFailure', () => {
  const details = { route: '/api/public/v1/shares/:shareId', method: 'GET', limiter: 'public-share-network', scope: 'network', limit: 60, windowMs: 60_000, observedCount: 60, counter: 'admitted', retryAfterSeconds: 42 }
  const logs = [
    { timestamp: startedAt, level: 'log', message: [JSON.stringify({ operation: 'limiter', ...observation(), ...details, stage: 'route', url: 'synthetic-private', network: 'synthetic-private' })] },
    { timestamp: startedAt, level: 'log', message: [JSON.stringify({ operation: 'shares', ...observation(), stage: 'route' })] },
  ]
  expect(alertObservations([trace({ logs })], 'producer')).toEqual([{ ...observation(), stage: 'route', ...details }])
})

const runtimes: Miniflare[] = []
const directories: string[] = []
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture(persistence?: string, uncertain = false) {
  const manifest = JSON.parse(await readFile(resolve('.account-tests/alerts/manifest.json'), 'utf8')) as { modules: V4ModuleDefinition[] }
  const emails: { from: string; to: string; subject: string; text: string }[] = []
  const diagnostics: Record<string, unknown>[] = []
  const alertEvents: Record<string, unknown>[] = []
  let accepted!: () => void
  const receipt = new Promise<void>(resolve => { accepted = resolve })
  const options = convertV4MiniflareOptions({ resourcePersistencePath: persistence, host: nativeFixtureHost(), port: 0, workers: [
    { name: 'producer', compatibilityDate: '2026-09-28', modules: true, script: `export default { fetch(request) { const code = new URL(request.url).searchParams.get('pause') ? 'SERVICE_PAUSED' : 'RATE_LIMITED'; console.log(JSON.stringify({operation:'admission',stage:code === 'RATE_LIMITED' ? 'account' : 'cloud-budget',code,requestId:'${requestId}',route:'/api/public/v1/shares/:shareId',method:'GET',limiter:'public-share-network',scope:'network',limit:60,windowMs:60000,observedCount:60,counter:'admitted',retryAfterSeconds:42,url:request.url,password:'synthetic-private'})); return new Response(null,{status:code === 'RATE_LIMITED' ? 429 : 503}) } }` },
    { name: 'alerts', compatibilityDate: '2026-09-28', modules: manifest.modules, modulesRoot: resolve('.account-tests/alerts'), bindings: { ALERTS_ENABLED: 'true', DIAGNOSTICS_ENABLED: 'true', ALERT_EMAIL_TO: 'owner@example.org', EMAIL_FROM: 'noreply@example.org', SERVICE_ORIGIN: 'https://example.test', ALERT_SOURCE_WORKER: 'producer' }, durableObjects: { ALERTS: { className: 'OwnerAlertState', useSQLite: true } }, ratelimits: { ALERT_PROCESSING_LIMITER: { namespace_id: '1', simple: { limit: 1, period: 60 } } }, serviceBindings: { NATIVE_EMAIL: 'email' } },
    { name: 'email', compatibilityDate: '2026-09-28', modules: true, script: `import {WorkerEntrypoint} from 'cloudflare:workers'; export default class extends WorkerEntrypoint { async send(message) { const response = await this.env.CAPTURE.fetch('https://capture.invalid',{method:'POST',body:JSON.stringify(message)}); if(!response.ok) throw new Error('Uncertain provider outcome'); return await response.json() } }`, serviceBindings: { CAPTURE: async request => { emails.push(await request.json() as typeof emails[number]); accepted(); return LocalResponse.json({ messageId: 'synthetic-accepted' }, { status: uncertain ? 503 : 200 }) } } },
  ] })
  options.handleStructuredLogs = log => {
    try {
      const row = JSON.parse(log.message) as Record<string, unknown>
      if (row.sourceWorker === 'producer') diagnostics.push(row)
      if (row.operation === 'operator-alert') alertEvents.push(row)
    } catch { /* Runtime setup messages are not application diagnostics */ }
  }
  // V4 conversion drops Tail consumers; use the pinned V5 field so this exercises real runtime tail delivery
  options.workers![0].config.tailConsumers = [{ worker: 'alerts' }]
  const runtime = new Miniflare(options)
  runtimes.push(runtime)
  const namespace = await runtime.getDurableObjectNamespace('ALERTS', 'alerts')
  const notify = (code = 'RATE_LIMITED') => namespace.getByName('owner').fetch('https://alerts.invalid/notice', { method: 'POST', body: JSON.stringify(observation(code)) })
  return { runtime, emails, diagnostics, alertEvents, notify, receipt, async dispose() { runtimes.splice(runtimes.indexOf(runtime), 1); await runtime.dispose() } }
}
it.each(['RATE_LIMITED', 'SERVICE_PAUSED'])('deliversReal%sTailEventsWithoutDependingOnTheCustomerDatabaseOrQueue', async code => {
  const f = await fixture()
  const response = await f.runtime.dispatchFetch(`https://example.test/?capability=synthetic-private${code === 'SERVICE_PAUSED' ? '&pause=1' : ''}`, { headers: { authorization: 'synthetic-private' } })
  expect(response.status).toBe(code === 'RATE_LIMITED' ? 429 : 503)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([f.receipt, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Owner alert was not observed')), 5000) })]) } finally { clearTimeout(timeout) }
  expect(f.emails).toHaveLength(1)
  expect(f.emails[0].text).toContain(requestId)
  expect(f.emails[0].text).toContain('Open admin panel: https://example.test/admin')
  expect(f.emails[0].text).toContain("Find this reference in the private diagnostic Worker's Logs")
  expect(f.emails[0].text).not.toContain('Administration:')
  expect(f.emails[0].text).toContain('Affected route: GET /api/public/v1/shares/:shareId')
  expect(f.emails[0].text).toContain('Blocking policy: public-share-network; scope: network')
  expect(f.emails[0].text).toContain('60 requests per 60 seconds')
  expect(f.emails[0].text).toContain('60 admitted requests')
  expect(f.emails[0].text).toContain('42 seconds')
  await expect.poll(() => f.diagnostics).toHaveLength(1)
  expect(f.alertEvents.filter(event => event.stage === 'acknowledgment')).toEqual([
    { operation: 'operator-alert', stage: 'acknowledgment', code: 'ACCEPTED', requestId },
  ])
  expect(f.diagnostics[0]).toMatchObject({ requestId, sourceWorker: 'producer', code, limiter: 'public-share-network', limit: 60 })
  expect(JSON.stringify(f.diagnostics)).not.toContain('synthetic-private')
  expect(f.diagnostics[0]).not.toHaveProperty('url')
  expect(f.diagnostics[0]).not.toHaveProperty('headers')
  expect(JSON.stringify(f.emails)).not.toContain('synthetic-private')
  const helper = await f.runtime.getWorker('alerts')
  expect((await helper.fetch('https://alerts.invalid/notice')).status).toBe(404)
})
it('doesNotAcknowledgeOrLogGroupedNotificationsAsAnotherAcceptedSend', async () => {
  const f = await fixture()
  expect(await (await f.notify()).json()).toEqual({ status: 'accepted' })
  expect((await f.runtime.dispatchFetch('https://example.test/')).status).toBe(429)
  await expect.poll(() => f.diagnostics).toHaveLength(1)
  expect(f.emails).toHaveLength(1)
  expect(f.alertEvents.filter(event => event.stage === 'acknowledgment')).toEqual([])
})
it('doesNotAcknowledgeUncertainSendsOrReleaseTheirReservedAllowance', async () => {
  const f = await fixture(undefined, true)
  expect((await f.runtime.dispatchFetch('https://example.test/')).status).toBe(429)
  await expect.poll(() => f.diagnostics).toHaveLength(1)
  expect(f.alertEvents).toContainEqual({ operation: 'operator-alert', stage: 'dispatch', code: 'ALERT_UNAVAILABLE', requestId })
  expect(f.alertEvents.filter(event => event.stage === 'acknowledgment')).toEqual([])
  expect(await (await f.notify()).json()).toEqual({ status: 'grouped' })
  expect(f.emails).toHaveLength(1)
})
it.each(['unknown', 'malformed'])('rejectsA%sReplyWithoutRecordingAcceptanceOrItsContents', async kind => {
  const env = {
    ALERTS_ENABLED: 'true', ALERT_SOURCE_WORKER: 'producer',
    ALERT_PROCESSING_LIMITER: { async limit() { return { success: true } } },
    ALERTS: { getByName() { return { async fetch() { return new Response(kind === 'unknown' ? JSON.stringify({ status: 'queued', detail: 'synthetic-private' }) : 'synthetic-private') } } } },
  } as unknown as Parameters<typeof alertWorker.tail>[1]
  const log = { timestamp: startedAt, level: 'log', message: [JSON.stringify({ operation: 'admission', ...observation() })] }
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await alertWorker.tail([trace({ logs: [log] })], env)
    expect(logs.mock.calls.map(([message]) => JSON.parse(message as string))).toEqual([
      { operation: 'operator-alert', stage: 'dispatch', code: 'ALERT_UNAVAILABLE', requestId },
    ])
  } finally { logs.mockRestore() }
})
it('atomicallyCoalescesConcurrentDeliveryAndKeepsPauseAllowanceSeparate', async () => {
  const f = await fixture()
  const results = await Promise.all(Array.from({ length: 12 }, () => f.notify()))
  expect(results.every(result => result.status === 200)).toBe(true)
  expect(f.emails).toHaveLength(1)
  expect((await f.notify('SERVICE_PAUSED')).status).toBe(200)
  expect(f.emails).toHaveLength(2)
})
it('preservesNotificationClaimsAcrossRuntimeRestarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-alert-state-'))
  directories.push(directory)
  const first = await fixture(directory)
  expect((await first.notify()).status).toBe(200)
  expect(first.emails).toHaveLength(1)
  await first.dispose()
  const reopened = await fixture(directory)
  expect(await (await reopened.notify()).json()).toEqual({ status: 'grouped' })
  expect(reopened.emails).toHaveLength(0)
})
it('retainsTheClaimWhenEmailAcceptanceIsUncertain', async () => {
  const f = await fixture(undefined, true)
  expect((await f.notify()).status).toBe(503)
  expect(await (await f.notify()).json()).toEqual({ status: 'grouped' })
  expect(f.emails).toHaveLength(1)
})
