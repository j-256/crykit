import type { ServiceContext } from './context'
import { ApiFailure } from './http'
import type { LimitDiagnostic } from '../src/account/protocol'

interface RateCounter extends LimitDiagnostic { readonly id: string; readonly max: number }
export async function withRateLimitRetry(context: ServiceContext, counters: readonly RateCounter[], work: () => Promise<void>): Promise<void> {
  try { await work() } catch (error) {
    if (!(error instanceof ApiFailure) || error.code !== 'RATE_LIMITED') throw error
    // Admission has already rolled back; read only the blocking windows to give honest retry guidance
    // This extra query belongs to denied actions, never the successful request path
    try {
      const now = context.now()
      const rows = await context.env.DB!.prepare(`SELECT id,attempts,expires_at FROM rate_counters WHERE expires_at>? AND (${counters.map(() => '(id=? AND attempts>=?)').join(' OR ')})`).bind(now, ...counters.flatMap(counter => [counter.id, counter.max])).all<{ id: string; attempts: number; expires_at: number }>()
      for (const row of rows.results) {
        const counter = counters.find(counter => counter.id === row.id)!
        context.emit({ operation: 'limiter', stage: 'route', code: 'RATE_LIMITED', limiter: counter.limiter, scope: counter.scope, limit: counter.max, windowMs: counter.windowMs, observedCount: row.attempts, counter: 'admitted', retryAfterSeconds: Math.max(1, Math.ceil((row.expires_at - now) / 1000)) })
      }
      if (rows.results.length) throw new ApiFailure('RATE_LIMITED', Math.max(1, Math.ceil((Math.max(...rows.results.map(row => row.expires_at)) - now) / 1000)))
    } catch (failure) {
      if (failure instanceof ApiFailure) throw failure
      // A diagnostic read failure must not turn a denied action into an admitted one or invent a reset time
    }
    throw error
  }
}
