import { z } from 'zod'
import type { LimitDiagnostic, SafeEvent } from '../src/account/protocol'

const staticRoutes = [
  '/api/v1/service', '/api/v1/account', '/api/v1/shares',
  ...['signup/start', 'signup/finish', 'login/start', 'login/finish', 'verify', 'resend', 'devices/start', 'devices/status', 'devices/complete'].map(path => `/api/v1/auth/${path}`),
  ...['sessions/revoke', 'devices', 'devices/requests', 'devices/approve', 'devices/reject', 'credentials/start', 'credentials/commit', 'reauth/start', 'reauth/finish', 'email/start', 'email/confirm', 'username', 'storage', 'deletion', 'recovery'].map(path => `/api/v1/account/${path}`),
  ...['uploads', 'commits', 'changes', 'cleanup', 'cleanup/preview'].map(path => `/api/v1/sync/${path}`),
] as const
const dynamicRoutes = [
  [/^\/api\/public\/v1\/shares\/[^/]+$/, '/api/public/v1/shares/:shareId'],
  [/^\/api\/v1\/shares\/[^/]+$/, '/api/v1/shares/:shareId'],
  [/^\/api\/v1\/account\/transactions\/[^/]+$/, '/api/v1/account/transactions/:transactionId'],
  [/^\/api\/v1\/sync\/uploads\/[^/]+\/finish$/, '/api/v1/sync/uploads/:uploadId/finish'],
  [/^\/api\/v1\/sync\/uploads\/[^/]+\/chunks\/[^/]+$/, '/api/v1/sync/uploads/:uploadId/chunks/:index'],
  [/^\/api\/v1\/sync\/revisions\/[^/]+\/chunks\/[^/]+$/, '/api/v1/sync/revisions/:revisionId/chunks/:index'],
  [/^\/api\/v1\/sync\/revisions\/[^/]+$/, '/api/v1/sync/revisions/:revisionId'],
  [/^\/api\/v1\/sync\/mutations\/[^/]+\/transition$/, '/api/v1/sync/mutations/:mutationId/transition'],
  [/^\/api\/v1\/sync\/mutations\/[^/]+$/, '/api/v1/sync/mutations/:mutationId'],
  [/^\/api\/admin\/v1(?:\/|$)/, '/api/admin/v1/:operation'],
  [/^\/admin(?:\/|$)/, '/admin/:page'],
] as const
const routeNames = [...staticRoutes, ...dynamicRoutes.map(([, route]) => route), 'unmatched', 'scheduled']
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'UNKNOWN'] as const
const identifier = /^[a-zA-Z0-9_.:-]{1,128}$/
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const diagnosticFields = {
  limiter: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  scope: z.enum(['network', 'account', 'target', 'service', 'location']),
  limit: count, windowMs: count, observedCount: count, retryAfterSeconds: count,
  counter: z.enum(['admitted', 'work-units', 'unavailable']),
  route: z.string().refine(value => routeNames.includes(value)), method: z.enum(methods),
}
export const limitDiagnosticSchema = z.object(diagnosticFields).partial()

export function safeLimitDiagnostic(value: Record<string, unknown>): LimitDiagnostic {
  const safe: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(diagnosticFields)) {
    if (value[key] === undefined) continue
    const parsed = schema.safeParse(value[key])
    if (parsed.success) safe[key] = parsed.data
  }
  return safe as LimitDiagnostic
}

export function requestDiagnostic(request: Pick<Request, 'url' | 'method'>): Pick<LimitDiagnostic, 'route' | 'method'> {
  const path = new URL(request.url).pathname
  // Match authored templates only; unknown paths, IDs, queries and fragments never become log values
  const route = staticRoutes.find(route => route === path) ?? dynamicRoutes.find(([pattern]) => pattern.test(path))?.[1] ?? 'unmatched'
  return { route, method: methods.includes(request.method as typeof methods[number]) ? request.method : 'UNKNOWN' }
}

export interface DiagnosticEvent extends SafeEvent {
  readonly occurredAt: number
  readonly requestId?: string
  readonly sourceWorker: string
  readonly sourceVersionId?: string
}
const maxLogCharacters = 2048
const maxLogsPerInvocation = 128
const maxDiagnosticsPerBatch = 64
const textFields = ['operation', 'stage', 'code', 'jobId', 'mutationId', 'requestId'] as const
const numberFields = ['durationMs', 'attempt', 'bytes', 'rowsRead', 'rowsWritten'] as const

export function diagnosticEvents(events: readonly TraceItem[], source: string): DiagnosticEvent[] {
  const result: DiagnosticEvent[] = []
  for (const event of events) {
    // The local Tail runtime omits scriptName; hosted attachment and source checks exclude unrelated producers
    if (event.scriptName !== null && event.scriptName !== source) continue
    let rateObserved = false
    for (const log of event.logs.slice(0, maxLogsPerInvocation)) {
      for (const message of log.message) {
        if (typeof message !== 'string' || message.length > maxLogCharacters) continue
        let value: unknown
        try { value = JSON.parse(message) } catch { continue }
        if (!value || typeof value !== 'object') continue
        const row = value as Record<string, unknown>
        if (typeof row.operation !== 'string' || !identifier.test(row.operation)) continue
        const safe: Record<string, unknown> = { ...safeLimitDiagnostic(row) }
        for (const key of textFields) if (typeof row[key] === 'string' && identifier.test(row[key])) safe[key] = row[key]
        for (const key of numberFields) if (typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0 && row[key] <= Number.MAX_SAFE_INTEGER) safe[key] = row[key]
        const occurredAt = event.eventTimestamp ?? log.timestamp
        if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) continue
        rateObserved ||= safe.code === 'RATE_LIMITED'
        result.push({ ...safe, occurredAt, sourceWorker: source, ...(event.scriptVersion?.id && /^[a-f0-9-]{36}$/.test(event.scriptVersion.id) ? { sourceVersionId: event.scriptVersion.id } : {}) } as DiagnosticEvent)
        if (result.length >= maxDiagnosticsPerBatch) return result
      }
    }
    // A coalesced producer rejection can have no authored log; retain a bounded, content-free fallback
    if (!rateObserved && event.event && 'response' in event.event && event.event.response?.status === 429 && event.eventTimestamp !== null) {
      result.push({ operation: 'request', stage: 'unspecified', code: 'RATE_LIMITED', occurredAt: event.eventTimestamp, sourceWorker: source, ...requestDiagnostic(event.event.request) })
      if (result.length >= maxDiagnosticsPerBatch) return result
    }
    // Raw exception messages and stacks may embed request values and are never forwarded
    if (event.outcome !== 'ok' || event.exceptions.length) {
      result.push({ operation: 'runtime', stage: 'execution', code: 'WORKER_FAILURE', occurredAt: event.eventTimestamp ?? 0, sourceWorker: source })
      if (result.length >= maxDiagnosticsPerBatch) return result
    }
  }
  return result
}
