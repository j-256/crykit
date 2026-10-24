import { expect, it } from 'vitest'
import { createServiceFixture } from '../testing/service-fixture'
import { createServiceContext, type SafeEvent } from '../context'
import { keyedHash } from './identity'
import { limitAuth } from './rate-limits'

it('returnsTheActualBlockingWindowWithoutChangingDeniedCounters', async () => {
  const f = await createServiceFixture()
  try {
    let now = Date.UTC(2026, 9, 20)
    const request = new Request('http://127.0.0.1/api/v1/auth/login/start', { headers: { 'cf-connecting-ip': '192.0.2.20' } })
    const id = await keyedHash(f.env.SESSION_SECRET, 'rate-counter', 'target:synthetic')
    await f.db.prepare('INSERT INTO rate_counters(id,attempts,expires_at) VALUES (?,?,?)').bind(id, 10, now + 420_000).run()
    const events: SafeEvent[] = []
    const context = () => createServiceContext(request, { DB: f.db, SESSION_SECRET: f.env.SESSION_SECRET }, { now: () => now, emit: event => { events.push(event) } })
    await expect(limitAuth(request, 'synthetic', context(), 'start')).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 420 })
    expect(events).toEqual([expect.objectContaining({ operation: 'limiter', stage: 'route', code: 'RATE_LIMITED', limiter: 'auth-start-target', scope: 'target', limit: 10, windowMs: 600_000, observedCount: 10, counter: 'admitted', retryAfterSeconds: 420, route: '/api/v1/auth/login/start', method: 'GET' })])
    expect(JSON.stringify(events)).not.toContain('192.0.2.20')
    expect(JSON.stringify(events)).not.toContain(id)
    expect(await f.db.prepare('SELECT attempts FROM rate_counters WHERE id=?').bind(id).first('attempts')).toBe(10)
    now += 420_000
    await expect(limitAuth(request, 'synthetic', context(), 'start')).resolves.toBeUndefined()
    expect(await f.db.prepare('SELECT attempts FROM rate_counters WHERE id=?').bind(id).first('attempts')).toBe(1)
  } finally { await f.dispose() }
})
