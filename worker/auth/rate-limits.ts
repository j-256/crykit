import type { ServiceContext } from '../context'
import { guarded, keyedHash } from './identity'
import { withRateLimitRetry } from '../rate-limit-retry'

const minute = 60_000
const day = 24 * 60 * minute
const deviceStatusBudget = Object.freeze({ windowMs: 10 * minute, perRequest: 150, perNetwork: 600 })
export async function limitAuth(request: Request, target: string, context: ServiceContext, kind: 'start' | 'resend' | 'finish' | 'verify' | 'device-status' | 'device-complete'): Promise<void> {
  const now = context.now()
  const db = context.env.DB!
  // A missing ingress IP shares a bounded unknown bucket instead of bypassing limits
  // Daily purpose rotation and keyed storage avoid retaining raw network addresses
  const network = request.headers.get('cf-connecting-ip') ?? 'unknown-network'
  const limits = kind === 'device-status' ? [
    // Five-second visible polling fits a ten-minute approval without spending its start budget
    { key: `device-status:${target}`, window: deviceStatusBudget.windowMs, max: deviceStatusBudget.perRequest },
    { key: `device-status-network:${Math.floor(now / day)}:${network}`, window: deviceStatusBudget.windowMs, max: deviceStatusBudget.perNetwork },
  ] : kind === 'start' ? [
    { key: `target:${target}`, window: 10 * minute, max: 10 },
    { key: `network:${Math.floor(now / day)}:${network}`, window: 10 * minute, max: 30 },
  ] : kind === 'resend' ? [
    { key: `resend-minute:${target}`, window: minute, max: 1 },
    { key: `resend-hour:${target}`, window: 60 * minute, max: 5 },
    { key: `resend-network:${Math.floor(now / day)}:${network}`, window: 10 * minute, max: 30 },
  ] : [
    { key: `${kind}-target:${target}`, window: 10 * minute, max: 10 },
    { key: `${kind}-network:${Math.floor(now / day)}:${network}`, window: 10 * minute, max: 30 },
  ]
  // Finish and verify budgets precede authority reads, including retries and invalid opaque targets
  // Rejected access rolls back all counter writes and leaves the route's authority untouched
  const counters = await Promise.all(limits.map(async limit => {
    const policy = limit.key.split(':')[0]
    return { ...limit, id: await keyedHash(context.env.SESSION_SECRET, 'rate-counter', limit.key), windowMs: limit.window, limiter: `auth-${kind}-${policy}`, scope: policy.includes('network') ? 'network' as const : 'target' as const }
  }))
  const predicates = counters.map(() => 'NOT EXISTS (SELECT 1 FROM rate_counters WHERE id = ? AND expires_at > ? AND attempts >= ?)')
  await withRateLimitRetry(context, counters, () => guarded(context, { sql: `SELECT ${predicates.join(' AND ')}`, bindings: counters.flatMap(c => [c.id, now, c.max]) }, [
    db.prepare('DELETE FROM rate_counters WHERE expires_at <= ?').bind(now),
    ...counters.map(c => db.prepare('INSERT INTO rate_counters (id, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(id) DO UPDATE SET attempts = attempts + 1').bind(c.id, now + c.window)),
  ], 'RATE_LIMITED'))
}
