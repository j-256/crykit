import type { ServiceContext } from '../context'
import { guarded, keyedHash } from '../auth/identity'
import { withRateLimitRetry } from '../rate-limit-retry'

const minute = 60_000
const day = 24 * 60 * minute
export const publicShareReadBudget = Object.freeze({ windowMs: minute, perNetwork: 60, perService: 1_200 })

export async function limitPublicShareRead(request: Request, context: ServiceContext): Promise<void> {
  const now = context.now(), db = context.env.DB!
  // No share ID enters limiter state; one missing-IP bucket also bounds unknown ingress
  // Daily keyed network identities retain neither raw addresses nor stable visitor identifiers
  const network = request.headers.get('cf-connecting-ip') ?? 'unknown-network'
  const limits = [
    { key: 'public-share-service', max: publicShareReadBudget.perService, limiter: 'public-share-service', scope: 'service' as const, windowMs: publicShareReadBudget.windowMs },
    { key: `public-share-network:${Math.floor(now / day)}:${network}`, max: publicShareReadBudget.perNetwork, limiter: 'public-share-network', scope: 'network' as const, windowMs: publicShareReadBudget.windowMs },
  ]
  const counters = await Promise.all(limits.map(async limit => ({ ...limit, id: await keyedHash(context.env.SESSION_SECRET, 'rate-counter', limit.key) })))
  // One atomic guard caps both expensive reads and network-row growth across isolates
  // Denied requests roll back all writes, including allocation of an unseen network bucket
  await withRateLimitRetry(context, counters, () => guarded(context, {
    sql: `SELECT ${counters.map(() => 'NOT EXISTS (SELECT 1 FROM rate_counters WHERE id = ? AND expires_at > ? AND attempts >= ?)').join(' AND ')}`,
    bindings: counters.flatMap(counter => [counter.id, now, counter.max]),
  }, [
    db.prepare('DELETE FROM rate_counters WHERE expires_at <= ?').bind(now),
    ...counters.map(counter => db.prepare('INSERT INTO rate_counters (id, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(id) DO UPDATE SET attempts = attempts + 1').bind(counter.id, now + publicShareReadBudget.windowMs)),
  ], 'RATE_LIMITED'))
}
