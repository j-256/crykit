import type { ServiceContext, ServiceEnv } from './context'
import { keyedHash } from './auth/identity'
import { runGuardedBatch } from './db/guarded-batch'
import { ApiFailure } from './http'
import type { CommitRequest, LimitDiagnostic } from '../src/account/protocol'
import type { CustomerPrincipal } from './auth/session'

const minuteMs = 60_000
const dayMs = 24 * 60 * minuteMs
const retrySeconds = 60
const approvalStatusPath = '/api/v1/auth/devices/status'
const defaultBudgets = Object.freeze({ daily: 500_000, monthly: 5_000_000, dailyWork: 2_000_000, monthlyWork: 3_000_000 })
export const cloudWorkCost = Object.freeze({ uploadReservation: 1, uploadChunk: 2, finishUpload: 1, commit: 128, cleanup: 128 })
export function commitWorkUnits(input: CommitRequest): number {
  // Declared references add work to dense commands even when the request count is unchanged
  return cloudWorkCost.commit + input.heads.length + input.expected.length + input.revisions.reduce((total, revision) => total + revision.parents.length + revision.dependencies.length + revision.chunks.length, 0)
}
const bindingNames = ['CLOUD_NETWORK_LIMITER', 'CLOUD_ACCOUNT_LIMITER', 'CLOUD_AUTH_LIMITER', 'CLOUD_LOCATION_LIMITER'] as const
type AdmissionStage = 'ingress' | 'account' | 'cloud-budget' | 'cloud-work-budget'
interface BudgetWindow { readonly kind: 'request' | 'work'; readonly id: string; readonly end: number; readonly maximum: number; readonly charge: number; readonly limiter: string; readonly windowMs: number }

export class AdmissionDenied extends ApiFailure {
  constructor(readonly stage: AdmissionStage, code: 'RATE_LIMITED' | 'SERVICE_PAUSED', retryAfterSeconds: number, readonly diagnostics: readonly LimitDiagnostic[] = []) {
    super(code, retryAfterSeconds)
  }
}

function requestBudget(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return Number(value)
}

export function requireAdmissionBindings(env: ServiceEnv): void {
  if (!bindingNames.every(name => typeof env[name]?.limit === 'function')) throw new ApiFailure('SERVICE_UNAVAILABLE')
  requestBudget(env.CLOUD_DAILY_REQUEST_BUDGET, defaultBudgets.daily)
  requestBudget(env.CLOUD_MONTHLY_REQUEST_BUDGET, defaultBudgets.monthly)
  requestBudget(env.CLOUD_DAILY_WORK_BUDGET, defaultBudgets.dailyWork)
  requestBudget(env.CLOUD_MONTHLY_WORK_BUDGET, defaultBudgets.monthlyWork)
}

async function nativeLimit(binding: RateLimit | undefined, key: string, stage: AdmissionStage, limiter: string, scope: LimitDiagnostic['scope']): Promise<void> {
  if (!binding) throw new ApiFailure('SERVICE_UNAVAILABLE')
  // Native bindings expose only success, not the configured threshold, count or exact reset
  if (!(await binding.limit({ key })).success) throw new AdmissionDenied(stage, 'RATE_LIMITED', retrySeconds, [{ limiter, scope, counter: 'unavailable', retryAfterSeconds: retrySeconds }])
}

export async function admitIngress(request: Request, context: ServiceContext): Promise<void> {
  // Location counters are approximate, so they shed load but never authorize spending
  // Reject here before recovery, session, auth or service-budget queries reach D1
  await nativeLimit(context.env.CLOUD_LOCATION_LIMITER, 'cloud-api', 'ingress', 'cloud-location', 'location')
  const network = request.headers.get('cf-connecting-ip') ?? 'unknown-network'
  const key = await keyedHash(context.env.SESSION_SECRET, 'cloud-network', `${Math.floor(context.now() / dayMs)}:${network}`)
  await nativeLimit(context.env.CLOUD_NETWORK_LIMITER, key, 'ingress', 'cloud-network', 'network')
  const path = new URL(request.url).pathname
  // Approval polling has separate D1 budgets and must not spend credential-operation admission
  const approvalPolling = request.method === 'POST' && path === approvalStatusPath
  if (path.startsWith('/api/v1/auth/') && !approvalPolling) await nativeLimit(context.env.CLOUD_AUTH_LIMITER, key, 'ingress', 'cloud-auth-network', 'network')
}

export async function admitAccount(accountId: string, context: ServiceContext): Promise<void> {
  const key = await keyedHash(context.env.SESSION_SECRET, 'cloud-account', accountId)
  await nativeLimit(context.env.CLOUD_ACCOUNT_LIMITER, key, 'account', 'cloud-account', 'account')
}

async function budgetWindows(context: ServiceContext, kind: 'request' | 'work', charge: number): Promise<readonly BudgetWindow[]> {
  const date = new Date(context.now())
  const maxima = kind === 'request'
    ? [requestBudget(context.env.CLOUD_DAILY_REQUEST_BUDGET, defaultBudgets.daily), requestBudget(context.env.CLOUD_MONTHLY_REQUEST_BUDGET, defaultBudgets.monthly)]
    : [requestBudget(context.env.CLOUD_DAILY_WORK_BUDGET, defaultBudgets.dailyWork), requestBudget(context.env.CLOUD_MONTHLY_WORK_BUDGET, defaultBudgets.monthlyWork)]
  return Promise.all([
    { name: 'daily', start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()), end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) },
    { name: 'monthly', start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) },
  ].map(async (window, index) => ({ kind, end: window.end, maximum: maxima[index], charge, limiter: `cloud-${kind}-${window.name}`, windowMs: window.end - window.start, id: await keyedHash(context.env.SESSION_SECRET, `cloud-${kind}-budget`, window.name) })))
}

async function claimBudget(context: ServiceContext, windows: readonly BudgetWindow[]): Promise<void> {
  const now = context.now(), db = context.env.DB!
  const tooLarge = windows.filter(window => window.charge > window.maximum)
  const detail = (window: BudgetWindow, observedCount?: number): LimitDiagnostic => ({ limiter: window.limiter, scope: 'service', limit: window.maximum, windowMs: window.windowMs, counter: window.kind === 'work' ? 'work-units' : 'admitted', ...(observedCount === undefined ? {} : { observedCount }), retryAfterSeconds: Math.ceil((window.end - now) / 1000) })
  if (tooLarge.length) throw new AdmissionDenied('cloud-work-budget', 'SERVICE_PAUSED', Math.ceil((Math.max(...tooLarge.map(window => window.end)) - now) / 1000), tooLarge.map(window => detail(window)))
  // Reuse fixed operational counter rows instead of adding a persisted user-data format
  // One guarded transaction also replaces the ordinary recovery-open read
  // Reserve before work and retain charges on failed or repeated attempts
  // Zero-charge windows only check saturation and never allocate a counter
  const cutoff = (window: BudgetWindow) => window.maximum - Math.max(0, window.charge - 1)
  const predicates = windows.map(() => 'NOT EXISTS (SELECT 1 FROM rate_counters WHERE id=? AND expires_at>? AND (attempts<0 OR attempts>=?))')
  try {
    await runGuardedBatch(db, {
      sql: `SELECT (SELECT state='open' FROM recovery_control WHERE id=1) AND ${predicates.join(' AND ')}`,
      bindings: windows.flatMap(window => [window.id, now, cutoff(window)]),
    }, windows.filter(window => window.charge > 0).map(window => db.prepare('INSERT INTO rate_counters(id,attempts,expires_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET attempts=CASE WHEN rate_counters.expires_at<=? THEN excluded.attempts ELSE rate_counters.attempts+excluded.attempts END,expires_at=excluded.expires_at').bind(window.id, window.charge, window.end, now)))
  } catch (error) {
    if (!String(error).includes('CHECK constraint failed: transaction_guard_passed')) throw error
    const control = await db.prepare('SELECT state FROM recovery_control WHERE id=1').first<{ state: string }>()
    if (!control) throw new ApiFailure('INTEGRITY_FAILED')
    if (control.state !== 'open') throw new ApiFailure('SERVICE_UNAVAILABLE')
    const rows = await db.prepare(`SELECT id,attempts,expires_at FROM rate_counters WHERE id IN (${windows.map(() => '?').join(',')})`).bind(...windows.map(window => window.id)).all<{ id: string; attempts: number; expires_at: number }>()
    const blocked = rows.results.filter(row => row.expires_at > now && (row.attempts < 0 || row.attempts >= cutoff(windows.find(window => window.id === row.id)!)))
    if (!blocked.length) throw new ApiFailure('SERVICE_UNAVAILABLE')
    const stage = blocked.some(row => windows.find(window => window.id === row.id)!.kind === 'work') ? 'cloud-work-budget' : 'cloud-budget'
    throw new AdmissionDenied(stage, 'SERVICE_PAUSED', Math.ceil((Math.max(...blocked.map(row => row.expires_at)) - now) / 1000), blocked.map(row => detail(windows.find(window => window.id === row.id)!, row.attempts)))
  }
}

export async function admitCloudRequest(context: ServiceContext): Promise<void> {
  const [requests, work] = await Promise.all([budgetWindows(context, 'request', 1), budgetWindows(context, 'work', 0)])
  await claimBudget(context, [...requests, ...work])
}

export async function admitCloudWork(principal: CustomerPrincipal, units: number, context: ServiceContext): Promise<void> {
  // A captured read-only identity cannot spend mutation allowance; later live write guards still apply
  if (principal.access !== 'active') throw new ApiFailure('FORBIDDEN')
  if (!Number.isSafeInteger(units) || units <= 0) throw new ApiFailure('SERVICE_UNAVAILABLE')
  // Weights distinguish bounded SQL-heavy work from reads; they are not a billing meter
  // Call only after customer authentication and schema validation, before data mutation
  await claimBudget(context, await budgetWindows(context, 'work', units))
}

const deniedReports = new Map<string, { startedAt: number; count: number }>()
export function reportAdmissionDenied(error: AdmissionDenied, context: ServiceContext): void {
  for (const diagnostic of error.diagnostics.length ? error.diagnostics : [{}]) {
    const key = diagnostic.limiter ?? error.stage
    const now = context.now(), previous = deniedReports.get(key)
    // Rejection must not amplify an attack into one billable log event per request
    // Summaries are per isolate and intentionally do not claim a global exact total
    if (!previous || now - previous.startedAt >= minuteMs || now < previous.startedAt) {
      context.emit({ ...diagnostic, operation: 'admission', stage: error.stage, code: error.code, attempt: (previous?.count ?? 0) + 1 })
      deniedReports.set(key, { startedAt: now, count: 0 })
    } else previous.count++
  }
}
