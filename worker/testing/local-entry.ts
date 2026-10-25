import { initializeRevocationLedger } from '../jobs/ledger'
import { runServiceJobs, maxServiceJobs } from '../jobs/runner'
import { opaqueProbe, storeOpaqueProof } from './opaque-probe'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { z } from 'zod'
import { maxAuthJsonBytes, OpaqueIdSchema, UsernameSchema } from '../../src/account/protocol'
import { createServiceContext, servicePhaseIdentifier, type SafeEvent, type ServiceEnv, type ServiceRuntime } from '../context'
import { ApiFailure, errorResponse, jsonResponse, readJson } from '../http'
import { handleRequest, runScheduled } from '../index'
import type { ServiceEmail } from '../email/types'
import { dispatchEmailJobs, enqueueServiceEmail, getEmailJob, maxEmailDispatchJobs, resendServiceEmail, retryEmailJob } from '../email/jobs'
import { ServiceEmailSchema } from '../email/templates'
import { capturedEmailTransport } from './email-capture'
import { captureServiceSnapshotStep } from './capture-step'
import { captureStepPath, CaptureStepRequestSchema } from './capture-step-contract'
import { databaseRequestPath, executeDatabaseRequest } from './database-request'
import { fixtureClockHeader, fixtureEvents, fixtureEventsPath, fixtureMeasurement, fixtureMeasurementPath, recordFixtureEvent } from './fixture-control'

interface LocalEnv extends ServiceEnv { LOCAL_REQUEST_CONTEXT?: string; LOCAL_IDENTITY?: string; LOCAL_RETAIN_EVENTS?: string; PRODUCTION?: Fetcher; WASM_PROBE?: Fetcher; OPAQUE_ADAPTER?: Fetcher }
const capturedEmails: ServiceEmail[] = []
const pendingFaults: string[] = []
// Excluded browser harness: hold actual Worker responses so tests observe native header/body ordering
interface ResponseGate { path: string; phase: 'before-headers' | 'body'; arrived: boolean; released: boolean }
let responseGate: ResponseGate | undefined
let localServiceOrigin: string | undefined
let localNetworkIdentity: string | undefined
const defaultFixtureNetwork = '127.0.0.1'
const syntheticNetworkSuffixGroups = 6
let originFailureDiagnostics = 0
export class EmailCapture extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    const message = await request.json() as ServiceEmail
    if (!/^[^@]+@example\.(com|org|net)$/.test(message.recipient)) throw new ApiFailure('INVALID_REQUEST')
    capturedEmails.push(message)
    return jsonResponse({ messageId: crypto.randomUUID() })
  }
}
export default {
  async fetch(request: Request, env: LocalEnv, execution: ExecutionContext): Promise<Response> {
    // Fixture database administration has no application clock or fault checkpoints
    if (new URL(request.url).pathname === databaseRequestPath && request.method === 'POST' && env.DB) return executeDatabaseRequest(request, env.DB)
    if (new URL(request.url).pathname === fixtureEventsPath) return jsonResponse(fixtureEvents())
    if (new URL(request.url).pathname === fixtureMeasurementPath) return jsonResponse(fixtureMeasurement())
    // Test-only frontend connectivity toggles retain the same Worker state and exact Origin checks
    if (localServiceOrigin) env = { ...env, SERVICE_ORIGIN: localServiceOrigin }
    // Miniflare supplies a loopback header by default; explicit non-loopback network proofs retain their identity
    const network = request.headers.get('cf-connecting-ip')
    if (localNetworkIdentity && (!network || network === defaultFixtureNetwork)) {
      const headers = new Headers(request.headers)
      headers.set('cf-connecting-ip', localNetworkIdentity)
      request = new Request(request, { headers })
    }
    const events: SafeEvent[] = []
    // Only the Node fixture enables an injected clock; browser acceptance keeps real time
    // Carrying it on the owned request avoids a separate Node callback for every API operation
    const injectedNow = env.LOCAL_REQUEST_CONTEXT === 'true' ? request.headers.get(fixtureClockHeader) : null
    const state = { now: injectedNow === null ? Date.now() : Number(injectedNow), localIdentity: env.LOCAL_IDENTITY === 'true' }
    if (!Number.isFinite(state.now)) throw new TypeError('Invalid fixture clock')
    const runtime: ServiceRuntime = {
      now: () => state.now, emit: event => { events.push(event); recordFixtureEvent(event, env.LOCAL_RETAIN_EVENTS === 'true') },
      // Capture exists only in this excluded entry and rejects nonreserved domains
      emailTransport: capturedEmailTransport(env.EMAIL, () => state.now),
      fail(stage) {
        // One isolate owns this queue, so synchronous checkpoints consume faults exactly once
        const index = pendingFaults.indexOf(stage)
        if (index >= 0) { pendingFaults.splice(index, 1); throw new ApiFailure('SERVICE_UNAVAILABLE') }
      },
    }
    const context = createServiceContext(request, env, runtime)
    let response: Response
    try {
      const path = new URL(request.url).pathname
      if (path === captureStepPath && request.method === 'POST') {
        const input = await readJson(request, CaptureStepRequestSchema, maxAuthJsonBytes)
        response = jsonResponse({ ...await captureServiceSnapshotStep(context, input.snapshot), events })
      } else if (path === '/__accounts/control/initialize-revocations' && request.method === 'POST') {
        await readJson(request, z.strictObject({}), maxAuthJsonBytes)
        // Explicit fixture provisioning keeps production routes unable to initialize retained ledger state
        await initializeRevocationLedger(context)
        response = jsonResponse({ ready: true })
      } else if (path === '/__accounts/control/withhold-screen-name' && request.method === 'POST') {
        const input = await readJson(request, z.strictObject({ username: UsernameSchema }), maxAuthJsonBytes)
        // Synthetic browser moderation evidence only; actual audited commands belong to the admin producer
        await env.DB!.prepare('UPDATE accounts SET username_withheld = 1 WHERE username = ?').bind(input.username).run()
        response = jsonResponse({ ok: true })
      } else if (path === '/__accounts/probe/sync-progress' && request.method === 'POST') {
        const input = await readJson(request, z.strictObject({ mutationId: OpaqueIdSchema }), maxAuthJsonBytes)
        // Excluded fixture telemetry measures actual durable frontier progress without exposing encrypted or personal content
        const progress = await env.DB!.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(done),0) AS done FROM publication_pins WHERE mutation_id = ?').bind(input.mutationId).first()
        const work = await env.DB!.prepare('SELECT state FROM publication_work WHERE mutation_id = ?').bind(input.mutationId).first()
        const reachable = await env.DB!.prepare("WITH RECURSIVE closure(account_id,revision_id) AS (SELECT account_id,revision_id FROM publication_pins WHERE mutation_id = ? UNION SELECT c.account_id,json_extract(d.value,'$.revisionId') FROM closure c JOIN sync_revisions r ON r.account_id = c.account_id AND r.revision_id = c.revision_id, json_each(r.descriptor,'$.dependencies') d) SELECT COUNT(*) AS reachable FROM closure").bind(input.mutationId).first()
        response = jsonResponse({ ...progress, ...work, ...reachable })
      } else if (path === '/__accounts/control/reset-rate-counters' && request.method === 'POST') {
        // SQL cannot reset native counters, so independent journeys receive fresh documentation-range networks
        // Real limits remain active within each journey, including serial continuation cases that skip this reset
        await readJson(request, z.strictObject({}), maxAuthJsonBytes)
        await env.DB!.prepare('DELETE FROM rate_counters').run()
        const networkGroups = crypto.getRandomValues(new Uint16Array(syntheticNetworkSuffixGroups))
        localNetworkIdentity = `2001:db8:${Array.from(networkGroups, value => value.toString(16)).join(':')}`
        response = jsonResponse({ ok: true })
      } else if (path === '/__accounts/control/service-origin' && request.method === 'POST') {
        const input = await readJson(request, z.strictObject({ origin: z.string().regex(/^https?:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/).refine(value => Number(value.slice(value.lastIndexOf(':') + 1)) <= 65535).nullable() }), maxAuthJsonBytes)
        localServiceOrigin = input.origin ?? undefined
        response = jsonResponse({ ok: true })
      } else if (path === '/__accounts/control/response-gate' && request.method === 'POST') {
        const input = await readJson(request, z.strictObject({ path: z.enum(['/api/v1/auth/logout', '/api/v1/auth/renew', '/api/v1/auth/login/finish', '/api/v1/auth/devices/start', '/api/v1/account/sessions/revoke']), phase: z.enum(['before-headers', 'body']) }), maxAuthJsonBytes)
        if (responseGate) responseGate.released = true
        responseGate = { ...input, arrived: false, released: false }
        response = jsonResponse({ ok: true })
      } else if (path === '/__accounts/control/response-gate') response = jsonResponse({ arrived: responseGate?.arrived ?? false })
      else if (path === '/__accounts/control/release-response' && request.method === 'POST') { if (responseGate) responseGate.released = true; responseGate = undefined; response = jsonResponse({ ok: true }) }
      else if (path === '/__accounts/control/faults' && request.method === 'POST') {
        pendingFaults.push(...await readJson(request, z.array(z.string().regex(servicePhaseIdentifier)).max(128), maxAuthJsonBytes))
        response = jsonResponse({ ok: true })
      } else if (path === '/__accounts/probe/json') response = jsonResponse(await readJson(request, z.strictObject({ version: z.literal(1) }), maxAuthJsonBytes))
      else if (path === '/__accounts/email/enqueue' && request.method === 'POST') {
        const input = await readJson(request, z.strictObject({ jobId: OpaqueIdSchema, message: ServiceEmailSchema }), maxAuthJsonBytes)
        response = jsonResponse(await enqueueServiceEmail(input.message, input.jobId, context))
      } else if (path === '/__accounts/email/status' && request.method === 'POST') {
        const input = await readJson(request, z.strictObject({ jobId: OpaqueIdSchema }), maxAuthJsonBytes)
        response = jsonResponse(await getEmailJob(input.jobId, context))
      } else if (path === '/__accounts/email/retry' && request.method === 'POST') {
        const input = await readJson(request, z.strictObject({ jobId: OpaqueIdSchema }), maxAuthJsonBytes)
        response = jsonResponse(await retryEmailJob(input.jobId, context))
      } else if (path === '/__accounts/email/resend' && request.method === 'POST') {
        const input = await readJson(request, z.strictObject({ jobId: OpaqueIdSchema, resendId: OpaqueIdSchema }), maxAuthJsonBytes)
        response = jsonResponse(await resendServiceEmail(input.jobId, input.resendId, context))
      } else if (path === '/__accounts/probe/opaque-adapter' && env.OPAQUE_ADAPTER) response = await env.OPAQUE_ADAPTER.fetch(request)
      else if (path === '/__accounts/probe/opaque' && request.method === 'POST') response = await opaqueProbe(request, env)
      else if (path === '/__accounts/probe/opaque-storage' && (request.method === 'POST' || request.method === 'GET')) response = await storeOpaqueProof(request, env)
      else if (path === '/__accounts/probe/wasm' && env.WASM_PROBE) response = await env.WASM_PROBE.fetch(request)
      else if (path === '/__accounts/probe/ledger' && env.LEDGER_BACKUPS) response = jsonResponse({ keys: (await env.LEDGER_BACKUPS.list({ limit: 1 })).objects.map(object => object.key) })
      else if (path === '/__accounts/probe/clock') response = jsonResponse({ now: context.now() })
      else if (path === '/__accounts/probe/fault') { context.checkpoint('probe'); response = jsonResponse({ ok: true }) }
      else if (path === '/__accounts/probe/email' && request.method === 'POST') {
        if (!env.EMAIL) throw new ApiFailure('SERVICE_UNAVAILABLE')
        response = await env.EMAIL.fetch('http://email/send', { method: 'POST', body: JSON.stringify({ kind: 'verify-account', recipient: 'synthetic@example.org', correlationId: context.requestId }) })
      } else if (path === '/__accounts/emails') response = jsonResponse(capturedEmails)
      else if (path === '/__accounts/jobs' && request.method === 'POST') { await dispatchEmailJobs(context, maxEmailDispatchJobs); await runServiceJobs(context, maxServiceJobs); response = jsonResponse({ ok: true }) }
      else if (path === '/__accounts/scheduled' && request.method === 'POST') { await runScheduled(env, runtime); response = jsonResponse({ ok: true }) }
      else if (path.startsWith('/__accounts/production/auth/') && env.PRODUCTION) {
        const url = new URL(request.url)
        url.pathname = path.replace('/__accounts/production/auth/', '/api/v1/auth/')
        response = await env.PRODUCTION.fetch(new Request(url, request))
      } else if (path.startsWith('/__accounts/production/account/') && env.PRODUCTION) {
        const url = new URL(request.url)
        url.pathname = path.replace('/__accounts/production/account/', '/api/v1/account/')
        response = await env.PRODUCTION.fetch(new Request(url, request))
      } else if (path === '/__accounts/production/email' && env.PRODUCTION) {
        const url = new URL(request.url)
        url.pathname = '/__accounts/email/enqueue'
        response = await env.PRODUCTION.fetch(new Request(url, request))
      } else if ((path === '/__accounts/production/identity' || path === '/__accounts/production/opaque' || path === '/__accounts/production/service') && env.PRODUCTION) {
        const url = new URL(request.url)
        url.pathname = path.endsWith('/opaque') ? '/__accounts/probe/opaque' : path.endsWith('/service') ? '/api/v1/service' : '/api/v1/account'
        response = await env.PRODUCTION.fetch(new Request(url, request))
      } else if (path === '/__accounts/identity' && request.method === 'POST' && state.localIdentity) response = jsonResponse({ localIdentity: true })
      else if (path.startsWith('/__accounts/')) throw new ApiFailure('NOT_FOUND')
      else response = await handleRequest(request, env, execution, runtime)
    } catch (error) {
      context.emit({ operation: 'probe', stage: 'probe', code: error instanceof ApiFailure ? error.code : 'SERVICE_UNAVAILABLE' })
      response = errorResponse(error, context.requestId)
    }
    // Bounded local harness diagnostics omit cookies, bodies, capabilities, and user identifiers
    if (response.status === 403 && originFailureDiagnostics < 32) {
      originFailureDiagnostics++
      console.warn(JSON.stringify({ event: 'local-origin-rejection', requestId: context.requestId, path: new URL(request.url).pathname, origin: request.headers.get('origin'), serviceOrigin: env.SERVICE_ORIGIN }))
    }
    const gate = responseGate
    if (gate && new URL(request.url).pathname === gate.path && !gate.arrived) {
      gate.arrived = true
      // Keep request-owned I/O alive; a cross-request bare Promise can be abandoned by workerd
      const wait = async () => { while (!gate.released) await new Promise(resolve => setTimeout(resolve, 10)) }
      if (gate.phase === 'before-headers') await wait()
      else {
        const bytes = new Uint8Array(await response.arrayBuffer())
        response = new Response(new ReadableStream({ async start(controller) { controller.enqueue(bytes.slice(0, 1)); await wait(); controller.enqueue(bytes.slice(1)); controller.close() } }), response)
      }
    }
    return response
  },
}
