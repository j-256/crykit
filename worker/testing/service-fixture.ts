// Scoped vendor types avoid merging Worker globals into the Node/browser test DOM
import type { D1Database, R2Bucket } from '@cloudflare/workers-types/experimental'
import { randomBytes } from 'node:crypto'
import { ready, server } from '@serenity-kit/opaque'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Miniflare, convertV4MiniflareOptions, Response as LocalResponse, type Request as LocalRequest, type V4ModuleDefinition } from 'miniflare'
// Node-only fixture uses the installed pinned Wrangler migration parser
import { unstable_splitSqlQuery as splitSqlQuery } from 'wrangler'
import { localProjectCapacityBytes, type SafeEvent } from '../../src/account/protocol'
import type { ServiceEmail } from '../email/types'
import { captureStepPath, type CaptureStepOutcome, type CaptureStepResult } from './capture-step-contract'
import { databaseRequestPath, requestDatabase } from './database-request'
import { fixtureClockHeader, fixtureEventsPath } from './fixture-control'

export interface FixtureOptions {
  readonly databaseTransport?: 'binding' | 'request'
  readonly cloudRequestBudget?: { readonly daily: number; readonly monthly: number }
  readonly cloudWorkBudget?: { readonly daily: number; readonly monthly: number }
  readonly admissionLimits?: Partial<Record<'network' | 'account' | 'auth' | 'location', number>>
  readonly onLog?: (value: unknown) => void
  readonly migrationThrough?: string
  readonly assets?: { readonly directory: string; readonly run_worker_first: boolean | string[] }
  readonly production?: boolean
  readonly runtimeProbes?: boolean
  readonly serviceOrigin?: string
  readonly adminConfig?: string
  readonly accessKeys?: (url: string) => Promise<Response>
  readonly recoverySecrets?: Partial<Record<'OPAQUE_SERVER_SETUP'|'DUMMY_IDENTITY_SECRET'|'SESSION_SECRET'|'CURSOR_SECRET'|'CAPABILITY_SECRET'|'EMAIL_STATE_SECRET'|'SERVICE_BACKUP_KEY',string>>
  readonly recoveryPolicy?: string
  readonly opaqueSetup?: string; readonly emailReady?: boolean; readonly now?: number; readonly active?: boolean; readonly localIdentity?: boolean; readonly storageCapBytes?: number
  readonly emailResponses?: readonly { readonly status: number; readonly retryAfter?: string; readonly code?: string }[]
}
export interface ServiceFixture {
  request(path: string, init?: RequestInit): Promise<Response>
  // Context overrides and binding/callback faults must stay in direct Node calls instead of being serialized
  captureStep(snapshot: string): Promise<CaptureStepResult>
  advance(ms: number): void
  readonly env: {readonly DB:D1Database; readonly OBJECTS:R2Bucket; readonly LEDGER_BACKUPS:R2Bucket; readonly REVOCATION_LEDGER:R2Bucket; readonly SERVICE_BACKUP_KEY:string; readonly SERVICE_BACKUP_POLICY:string; readonly OPAQUE_SERVER_SETUP:string; readonly DUMMY_IDENTITY_SECRET:string; readonly SESSION_SECRET:string; readonly CURSOR_SECRET:string; readonly CAPABILITY_SECRET:string; readonly EMAIL_STATE_SECRET:string; readonly ACCOUNTS_ACTIVE:string; readonly SERVICE_ORIGIN:string; readonly STORAGE_CAP_BYTES:string}
  readonly backups: R2Bucket
  readonly db: D1Database
  readonly objects: R2Bucket
  readonly revocations: R2Bucket
  emails(): Promise<readonly ServiceEmail[]>
  emailCaptureStats(): { readonly outboundNetworkMessages: number }
  events(): Promise<readonly SafeEvent[]>
  failNext(stage: string): void
  runJobs(): Promise<void>
  dispose(): Promise<void>
}
export async function createServiceFixture(options: FixtureOptions = {}): Promise<ServiceFixture> {
  const runtimeProbes = options.runtimeProbes === true || options.production === true
  const root = resolve('.account-tests')
  const local = JSON.parse(await readFile(resolve(root, 'local/manifest.json'), 'utf8')) as { modules: V4ModuleDefinition[] }
  const production = JSON.parse(await readFile(resolve(root, 'production/manifest.json'), 'utf8')) as { modules: V4ModuleDefinition[] }
  const wasm = JSON.parse(await readFile(resolve(root, 'wasm/manifest.json'), 'utf8')) as { modules: V4ModuleDefinition[] }
  const adapter = JSON.parse(await readFile(resolve(root, 'opaque-adapter/manifest.json'), 'utf8')) as { modules: V4ModuleDefinition[] }
  let now = options.now ?? Date.now()
  const faults: string[] = []
  const emails: ServiceEmail[] = []
  const emailResponses = [...options.emailResponses ?? []]
  let outboundNetworkMessages = 0
  await ready
  const bindings = {
    ADMIN_ACCESS_CONFIG: options.adminConfig ?? '',
    SERVICE_BACKUP_KEY: randomBytes(32).toString('base64url'), SERVICE_BACKUP_POLICY: options.recoveryPolicy ?? '',
    OPAQUE_SERVER_SETUP: options.opaqueSetup ?? server.createSetup(),
    ACCOUNTS_ACTIVE: options.active === false ? 'false' : 'true', SIGNUP_ACTIVE: 'true', SERVICE_ORIGIN: options.serviceOrigin ?? 'http://127.0.0.1', STORAGE_CAP_BYTES: String(options.storageCapBytes ?? localProjectCapacityBytes),
    DUMMY_IDENTITY_SECRET: randomBytes(32).toString('base64url'),
    SESSION_SECRET: randomBytes(32).toString('base64url'), CURSOR_SECRET: randomBytes(32).toString('base64url'), CAPABILITY_SECRET: randomBytes(32).toString('base64url'),
    EMAIL_STATE_SECRET: options.emailReady === false ? '' : randomBytes(32).toString('base64url'), EMAIL_SENDING_ACTIVE: 'true', EMAIL_HEADROOM: 'available',
    ...options.recoverySecrets,
    ...(options.cloudRequestBudget ? { CLOUD_DAILY_REQUEST_BUDGET: String(options.cloudRequestBudget.daily), CLOUD_MONTHLY_REQUEST_BUDGET: String(options.cloudRequestBudget.monthly) } : {}),
    ...(options.cloudWorkBudget ? { CLOUD_DAILY_WORK_BUDGET: String(options.cloudWorkBudget.daily), CLOUD_MONTHLY_WORK_BUDGET: String(options.cloudWorkBudget.monthly) } : {}),
  }
  const localConfiguration = JSON.parse(await readFile('wrangler.local.jsonc', 'utf8')) as { ratelimits: { name: string; namespace_id: string; simple: { limit: number; period: 10 | 60 } }[] }
  const roles = { CLOUD_NETWORK_LIMITER: 'network', CLOUD_ACCOUNT_LIMITER: 'account', CLOUD_AUTH_LIMITER: 'auth', CLOUD_LOCATION_LIMITER: 'location' } as const
  const ratelimits = Object.fromEntries(localConfiguration.ratelimits.map(binding => [binding.name, { namespace_id: binding.namespace_id, simple: { ...binding.simple, limit: options.admissionLimits?.[roles[binding.name as keyof typeof roles]] ?? binding.simple.limit } }]))
  const shared = {
    compatibilityDate: '2026-09-28', bindings, ratelimits, d1Databases: { DB: 'fixture-db' }, r2Buckets: { OBJECTS: 'fixture-objects', LEDGER_BACKUPS: 'fixture-ledger-backups', REVOCATION_LEDGER: 'fixture-revocations' },
    // Count and refuse every ordinary outbound fetch; service bindings stay local
    outboundService: async (request: LocalRequest) => {
      if (options.accessKeys) {
        const response = await options.accessKeys(request.url)
        return new LocalResponse(await response.arrayBuffer(), {
          status: response.status,
          headers: Object.fromEntries(response.headers),
        })
      }
      outboundNetworkMessages++
      return new LocalResponse('Outbound network disabled', { status: 503 })
    },
    serviceBindings: {
      ASSETS: async (request: LocalRequest) => {
        const path = new URL(request.url).pathname
        const admin = path === '/admin' || path.startsWith('/admin/')
        return new LocalResponse(
          admin ? 'Synthetic admin asset' : path === '/' ? '<!doctype html><title>Guest planner</title>' : 'Not found',
          { status: admin || path === '/' ? 200 : 404, headers: { 'content-type': 'text/html' } },
        )
      },
      EMAIL: async (request: LocalRequest) => {
        const message = await request.json() as ServiceEmail
        if (!/^[^@]+@example\.(com|org|net)$/.test(message.recipient)) return LocalResponse.json({ code: 'RECIPIENT_NOT_ALLOWED' }, { status: 400 })
        const failure = emailResponses.shift()
        if (failure) return LocalResponse.json({ code: failure.code }, { status: failure.status, headers: failure.retryAfter ? { 'retry-after': failure.retryAfter } : {} })
        emails.push(message)
        return LocalResponse.json({ messageId: `local-${emails.length}` })
      },
    },
  }
  // The pinned Miniflare 5 exposes its verified V4 conversion adapter; no config autoload is used
  const mf = new Miniflare(convertV4MiniflareOptions({
    handleStructuredLogs: options.onLog,
    host: '127.0.0.1', port: 0, workers: [
      // Ordinary fixtures use the real local Worker; dedicated runtime proofs also own the auxiliary entries
      { ...shared, name: 'local', modules: local.modules, modulesRoot: resolve(root, 'local'), bindings: { ...bindings, LOCAL_REQUEST_CONTEXT: 'true', LOCAL_IDENTITY: String(options.localIdentity ?? false), LOCAL_RETAIN_EVENTS: 'true' }, serviceBindings: { ...shared.serviceBindings, ...(runtimeProbes ? { PRODUCTION: 'production', WASM_PROBE: 'wasm-probe', OPAQUE_ADAPTER: 'opaque-adapter' } : {}) } },
      ...(runtimeProbes ? [
        { ...shared, name: 'production', modules: production.modules, modulesRoot: resolve(root, 'production'), ...(options.assets ? { assets: { ...options.assets, binding: 'ASSETS', routerConfig: { has_user_worker: true } }, serviceBindings: { EMAIL: shared.serviceBindings.EMAIL } } : {}) },
        { ...shared, name: 'opaque-adapter', modules: adapter.modules, modulesRoot: resolve(root, 'opaque-adapter') },
        { name: 'wasm-probe', compatibilityDate: '2026-09-28', modules: wasm.modules, modulesRoot: resolve(root, 'wasm') },
      ] : []),
    // Named-worker fetch redirects can return to the default entry, so production proofs own that entry too
    ].sort((left, right) => options.production ? Number(right.name === 'production') - Number(left.name === 'production') : 0),
  }))
  try {
    await mf.ready
    const binding = await mf.getD1Database('DB', 'local')
    const localWorker = options.production ? await mf.getWorker('local') : undefined
    const db = options.databaseTransport === 'binding' ? binding : requestDatabase(binding, async body => {
      const url = `http://127.0.0.1${databaseRequestPath}`
      const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body }
      return await (localWorker ? localWorker.fetch(url, init) : mf.dispatchFetch(url, init)) as unknown as Response
    })
    // Each fixture owns a fresh database and applies the authored migrations in filename order
    const migrations = resolve('worker/migrations')
    for (const name of (await readdir(migrations)).filter(name => /^\d+[-\w]*\.sql$/.test(name) && (!options.migrationThrough || name <= options.migrationThrough)).sort()) {
      // D1 exec executes individual lines, including standalone comments; Wrangler's splitter retains SQL boundaries
      await db.batch(splitSqlQuery(await readFile(resolve(migrations, name), 'utf8')).map(sql => db.prepare(sql)))
    }
    let controlTail = Promise.resolve()
    const request = async (path: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(path, options.serviceOrigin ?? 'http://127.0.0.1')
      // An absent probe must not turn a production-exclusion assertion into a false passing 404
      if (!runtimeProbes && (url.pathname.startsWith('/__accounts/production/') || url.pathname === '/__accounts/probe/wasm' || url.pathname === '/__accounts/probe/opaque-adapter')) throw new Error('Runtime probe requests require runtimeProbes: true')
      // Queue local control writes before requests; the Worker consumes each fault synchronously
      if (faults.length) {
        const batch = faults.splice(0)
        controlTail = controlTail.then(async () => {
          const response = await mf.dispatchFetch('http://127.0.0.1/__accounts/control/faults', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch) })
          if (!response.ok) throw new Error('Local fault injection failed')
        })
      }
      await controlTail
      // Miniflare uses Undici types; the fixture retains the standard Worker/browser fetch surface
      const headers = new Headers(init?.headers)
      headers.set(fixtureClockHeader, String(now))
      return await mf.dispatchFetch(url.href, { ...init, headers: Object.fromEntries(headers) } as unknown as Parameters<Miniflare['dispatchFetch']>[1]) as unknown as Response
    }
    return {
      request,
      async captureStep(snapshot) {
        const response = await request(captureStepPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snapshot }) })
        if (!response.ok) throw new Error(`Local capture step rejected (${response.status})`)
        // Both ends use the same excluded fixture build; no production or user-provided endpoint is accepted
        const outcome = await response.json() as CaptureStepOutcome & { events: SafeEvent[] }
        if (!outcome.ok) throw Object.assign(new Error(outcome.error.message), { name: outcome.error.name, code: outcome.error.code })
        return { receipt: outcome.receipt, measurements: outcome.measurements, events: outcome.events }
      },
      backups: await mf.getR2Bucket('LEDGER_BACKUPS','local') as unknown as R2Bucket,
      env: {...bindings, DB: db, OBJECTS: await mf.getR2Bucket('OBJECTS','local'), LEDGER_BACKUPS: await mf.getR2Bucket('LEDGER_BACKUPS','local'), REVOCATION_LEDGER: await mf.getR2Bucket('REVOCATION_LEDGER','local')} as unknown as ServiceFixture['env'],
      advance(ms) { if (!Number.isFinite(ms) || ms < 0) throw new Error('Clock advance must be nonnegative'); now += ms },
      db,
      objects: await mf.getR2Bucket('OBJECTS', 'local') as unknown as R2Bucket,
      revocations: await mf.getR2Bucket('REVOCATION_LEDGER', 'local') as unknown as R2Bucket,
      emails: async () => [...emails],
      async events() {
        const response = localWorker ? await localWorker.fetch(`http://127.0.0.1${fixtureEventsPath}`) : await request(fixtureEventsPath)
        if (!response.ok) throw new Error(`Local events rejected (${response.status})`)
        return await response.json() as SafeEvent[]
      },
      failNext: stage => { faults.push(stage) },
      emailCaptureStats: () => ({ outboundNetworkMessages }),
      runJobs: async () => {
        // Production routing does not expose the local scheduler endpoint
        const response = options.production
          ? await localWorker!.fetch('http://127.0.0.1/__accounts/jobs', { method: 'POST', headers: { [fixtureClockHeader]: String(now) } })
          : await request('/__accounts/jobs', { method: 'POST' })
        if (!response.ok) throw new Error('Local jobs failed')
      },
      dispose: () => mf.dispose(),
    }
  } catch (error) { await mf.dispose(); throw error }
}
