import { z } from 'zod'
import type { SendEmail } from '@cloudflare/workers-types/experimental'
import { validEmailMessageId } from '../email/native'
import { alertCooldownMs, claimAlert, dailyAlertLimits } from './policy'
import { diagnosticEvents, limitDiagnosticSchema, type DiagnosticEvent } from '../diagnostics'

interface AlertEnv {
  readonly ALERTS: DurableObjectNamespace
  readonly ALERT_PROCESSING_LIMITER: RateLimit
  readonly NATIVE_EMAIL?: SendEmail
  readonly ALERTS_ENABLED?: string
  readonly DIAGNOSTICS_ENABLED?: string
  readonly ALERT_EMAIL_TO?: string
  readonly EMAIL_FROM?: string
  readonly SERVICE_ORIGIN?: string
  readonly ALERT_SOURCE_WORKER?: string
}
const observationSchema = z.strictObject({
  ...limitDiagnosticSchema.shape,
  code: z.enum(['RATE_LIMITED', 'SERVICE_PAUSED']),
  stage: z.enum(['ingress', 'account', 'cloud-budget', 'cloud-work-budget', 'route', 'unspecified']),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  occurredAt: z.number().int().min(0).max(8_640_000_000_000_000),
  observations: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
})
type Observation = z.infer<typeof observationSchema>
const notificationStatus = Object.freeze({ accepted: 'accepted', grouped: 'grouped' })
const notificationResultSchema = z.object({ status: z.enum([notificationStatus.accepted, notificationStatus.grouped]) })
const mailbox = z.email().max(254).regex(/^[\x21-\x7e]+$/)
const stateKey = 'notification-policy-v1'
function configured(env: AlertEnv): boolean {
  try { return env.ALERTS_ENABLED === 'true' && !!env.NATIVE_EMAIL && mailbox.safeParse(env.ALERT_EMAIL_TO).success && mailbox.safeParse(env.EMAIL_FROM).success && new URL(env.SERVICE_ORIGIN!).origin === env.SERVICE_ORIGIN && env.SERVICE_ORIGIN!.startsWith('https://') } catch { return false }
}
function report(stage: string, code: string, requestId?: string): void { console.log(JSON.stringify({ operation: 'operator-alert', stage, code, ...(requestId ? { requestId } : {}) })) }

export function alertObservations(events: readonly TraceItem[], source: string): Observation[] {
  const found = new Map<Observation['code'], Observation>()
  for (const event of events) {
    const perInvocation = new Map<Observation['code'], Observation>()
    for (const row of diagnosticEvents([event], source)) {
      if (!['admission', 'request', 'auth', 'shares', 'sync', 'limiter'].includes(row.operation)) continue
      const { operation: _operation, sourceWorker: _worker, sourceVersionId: _version, durationMs: _duration, attempt: _attempt, bytes: _bytes, rowsRead: _read, rowsWritten: _written, jobId: _job, mutationId: _mutation, ...notice } = row
      const parsed = observationSchema.safeParse({ ...notice, observations: 1 })
      if (!parsed.success) continue
      const previous = perInvocation.get(parsed.data.code)
      // A route catch reports the same denial later; retain the blocking policy rather than replacing it
      if (!previous || (!previous.limiter && parsed.data.limiter)) perInvocation.set(parsed.data.code, parsed.data)
    }
    for (const [code, observation] of perInvocation) {
      const previous = found.get(code)
      found.set(code, previous ? { ...previous, observations: Math.min(Number.MAX_SAFE_INTEGER, previous.observations + observation.observations) } : observation)
    }
  }
  return [...found.values()]
}

export class OwnerAlertState {
  constructor(private readonly context: DurableObjectState, private readonly env: AlertEnv) {}
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/notice') return new Response(null, { status: 404 })
    if (!configured(this.env)) { report('configuration', 'ALERT_UNAVAILABLE'); return new Response(null, { status: 503 }) }
    const parsed = observationSchema.safeParse(await request.json())
    if (!parsed.success) return new Response(null, { status: 400 })
    const notice = parsed.data
    try {
      const decision = await this.context.storage.transaction(async transaction => {
        const next = claimAlert(await transaction.get(stateKey), notice.code, Date.now(), notice.observations)
        // Commit the allowance before external delivery; restart or an uncertain send cannot duplicate a notice
        await transaction.put(stateKey, next.state)
        return next
      })
      if (!decision.send) return Response.json({ status: notificationStatus.grouped })
      const text = [
        `${notice.code === 'RATE_LIMITED' ? 'Traffic protection tripped' : 'Customer cloud operations paused'} on ${this.env.ALERT_SOURCE_WORKER}.`,
        `Category: ${notice.stage}`, `Observed at: ${new Date(notice.occurredAt).toISOString()}`,
        `Affected route: ${notice.method ?? 'unknown method'} ${notice.route ?? 'unavailable'}`,
        `Blocking policy: ${notice.limiter ?? 'unavailable'}; scope: ${notice.scope ?? 'unavailable'}`,
        `Allowance: ${notice.limit === undefined || notice.windowMs === undefined ? 'not reported by this limiter' : `${notice.limit} ${notice.counter === 'work-units' ? 'work units' : 'requests'} per ${notice.windowMs / 1000} seconds`}`,
        `Observed counter: ${notice.observedCount === undefined ? (notice.counter === 'unavailable' ? 'unavailable; native admission counters are approximate' : 'unavailable for this sample') : `${notice.observedCount} ${notice.counter === 'work-units' ? 'charged work units' : 'admitted requests'} in the blocking window; denied attempts are excluded`}`,
        `Retry guidance: ${notice.retryAfterSeconds === undefined ? 'unavailable' : `${notice.retryAfterSeconds} seconds`}`,
        ...(notice.requestId ? [`Support reference: ${notice.requestId}`] : []),
        `Observed alert samples since the previous notice: ${decision.observations}. Samples are grouped and are not an exact request count.`,
        `Open admin panel: ${this.env.SERVICE_ORIGIN}/admin (management link, not the affected route)`,
        "Find this reference in the private diagnostic Worker's Logs by filtering requestId. Retained diagnostics are rate-limited samples, not a complete traffic history.",
        `Repeat notices have a ${alertCooldownMs / 60_000}-minute cooldown. Daily limits: ${dailyAlertLimits.RATE_LIMITED} traffic notices and ${dailyAlertLimits.SERVICE_PAUSED} service-pause notices, with separate reserved allowances.`,
      ].join('\n\n')
      const result = await this.env.NATIVE_EMAIL!.send({ from: this.env.EMAIL_FROM!, to: this.env.ALERT_EMAIL_TO!, subject: `CryKit ${notice.code === 'RATE_LIMITED' ? 'traffic protection' : 'cloud pause'}: ${this.env.ALERT_SOURCE_WORKER}`, text })
      if (!result || !validEmailMessageId(result.messageId)) { report('delivery', 'TRANSPORT_UNCERTAIN', notice.requestId); return new Response(null, { status: 503 }) }
      report('delivery', 'ACCEPTED', notice.requestId)
      return Response.json({ status: notificationStatus.accepted })
    } catch {
      // Native sending has no idempotency key; an ambiguous outcome retains its allowance and is never blindly resent
      report('delivery', 'ALERT_UNAVAILABLE', notice.requestId)
      return new Response(null, { status: 503 })
    }
  }
}

export default {
  fetch() { return new Response(null, { status: 404 }) },
  async tail(events: TraceItem[], env: AlertEnv): Promise<void> {
    if (env.ALERTS_ENABLED === 'true' && env.ALERT_SOURCE_WORKER) {
      for (const observation of alertObservations(events, env.ALERT_SOURCE_WORKER)) {
        try {
          // Reserve notification admission before optional diagnostic processing can consume the CPU budget
          if (!(await env.ALERT_PROCESSING_LIMITER.limit({ key: observation.code })).success) continue
          const response = await env.ALERTS.getByName('owner').fetch('https://alerts.invalid/notice', { method: 'POST', body: JSON.stringify(observation) })
          if (!response.ok) { report('dispatch', 'ALERT_UNAVAILABLE', observation.requestId); continue }
          const result = notificationResultSchema.safeParse(await response.json())
          if (!result.success) { report('dispatch', 'ALERT_UNAVAILABLE', observation.requestId); continue }
          // Hosted DO receipts can be absent from stored logs; keep a second receipt in the Tail invocation
          // Grouped replies add no log, so acknowledgments follow the globally reserved sends
          if (result.data.status === notificationStatus.accepted) report('acknowledgment', 'ACCEPTED', observation.requestId)
        } catch { report('dispatch', 'ALERT_UNAVAILABLE', observation.requestId) }
      }
    }
    if (env.DIAGNOSTICS_ENABLED === 'true' && env.ALERT_SOURCE_WORKER) {
      for (const diagnostic of diagnosticEvents(events, env.ALERT_SOURCE_WORKER)) {
        try {
          // Persist sanitized Tail output, never the producer's request-enriched log envelope
          // Reuse the native limiter with separate bounded keys so logs cannot spend email admission
          const key = diagnosticKey(diagnostic)
          if ((await env.ALERT_PROCESSING_LIMITER.limit({ key })).success) console.log(JSON.stringify(diagnostic))
        } catch { /* Diagnostics must not interrupt the independent notification path */ }
      }
    }
  },
} satisfies ExportedHandler<AlertEnv>

function diagnosticKey(event: DiagnosticEvent): string {
  return `diagnostic:${event.operation}:${event.stage ?? 'none'}:${event.code ?? 'none'}:${event.limiter ?? 'none'}`
}
