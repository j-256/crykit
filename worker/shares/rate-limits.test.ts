import { expect, it } from 'vitest'
import { customer, fixture, id, post } from '../sync/testing'
import { keyedHash } from '../auth/identity'
import { createServiceContext } from '../context'
import { sharesRoute } from './routes'
import type { PublicSnapshot } from '../../src/interchange/public-share-schema'

const start = 1_800_000_000_000
const minute = 60_000
const day = 24 * 60 * minute
const networkBudget = 60
const serviceBudget = 1_200
const snapshot: PublicSnapshot = { version: 5, kind: 'build', title: 'Public read budget', setup: { catalogLock: { 'exact-public-baseline': 'historical-source-v1' }, baseline: null, layers: [], mode: { state: 'unknown' }, ppCostsNonNegative: { state: 'unknown' }, slots: [] }, slots: [{ primaryClass: null, secondaryClass: null, equipment: [], equipmentGroups: [], passives: [] }], receipts: [] }

async function setup() {
  const f = await fixture(), owner = await customer(f)
  const published = await post(f, 'shares', { mutationId: id(), snapshot, includeAttribution: false }, owner.headers)
  expect(published.status).toBe(200)
  const { shareId } = await published.json() as { shareId: string }
  await f.db.prepare('DELETE FROM rate_counters').run()
  let now = start, snapshotQueries = 0
  const db = new Proxy(f.db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => {
      if (sql.includes('FROM shares s JOIN share_snapshots')) snapshotQueries++
      return target.prepare(sql)
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const request = async (share: string, network?: string) => {
    const request = new Request(`http://127.0.0.1/api/public/v1/shares/${share}`, { headers: network === undefined ? {} : { 'cf-connecting-ip': network } })
    // Separate contexts share the real limiter store, not process-local admission state
    return (await sharesRoute(request, createServiceContext(request, { DB: db, SESSION_SECRET: f.env.SESSION_SECRET }, { now: () => now, emit() {} })))!
  }
  const counterId = (key: string) => keyedHash(f.env.SESSION_SECRET, 'rate-counter', key)
  const seed = async (key: string, attempts: number, expiresAt = now + minute) => {
    const counter = await counterId(key)
    await f.db.prepare('INSERT INTO rate_counters (id, attempts, expires_at) VALUES (?, ?, ?)').bind(counter, attempts, expiresAt).run()
    return counter
  }
  return { f, shareId, request, seed, counterId, queries: () => snapshotQueries, advance: (ms: number) => { now += ms }, networkKey: (network: string) => `public-share-network:${Math.floor(now / day)}:${network}` }
}

it('bounds concurrent active and missing reads before snapshot retrieval across request contexts', async () => {
  const s = await setup(), network = '192.0.2.11'
  const counter = await s.seed(s.networkKey(network), networkBudget - 1)
  const responses = await Promise.all([s.shareId, id(), s.shareId, id()].map(share => s.request(share, network)))
  expect(responses.filter(response => response.status === 200 || response.status === 404)).toHaveLength(1)
  expect(responses.filter(response => response.status === 429)).toHaveLength(3)
  expect(s.queries()).toBe(1)
  expect(await s.f.db.prepare('SELECT attempts FROM rate_counters WHERE id = ?').bind(counter).first('attempts')).toBe(networkBudget)
  for (const response of responses.filter(value => value.status === 429)) {
    expect(response.headers.get('retry-after')).toBe('60')
    expect(response.headers.get('x-crykit-request-id')).toBeTruthy()
    expect(await response.json()).toMatchObject({ error: { code: 'RATE_LIMITED', requestId: expect.any(String) } })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-robots-tag')).toContain('noindex')
  }
})

it('bounds service admission and counter growth when networks and missing share IDs vary', async () => {
  const s = await setup()
  const service = await s.seed('public-share-service', serviceBudget - 1)
  const requests = Array.from({ length: 8 }, (_, index) => ({ share: index % 2 ? id() : s.shareId, network: `192.0.2.${index + 20}` }))
  const responses = await Promise.all(requests.map(value => s.request(value.share, value.network)))
  expect(responses.filter(response => response.status === 429)).toHaveLength(7)
  expect(s.queries()).toBe(1)
  const counters = await s.f.db.prepare('SELECT * FROM rate_counters').all<{ id: string; attempts: number; expires_at: number }>()
  expect(counters.results).toHaveLength(2)
  expect(counters.results.find(row => row.id === service)?.attempts).toBe(serviceBudget)
  const saved = JSON.stringify(counters.results)
  for (const value of requests) { expect(saved).not.toContain(value.network); expect(saved).not.toContain(value.share) }
})

it('shares a bounded missing-network bucket and expires counters before the next admission', async () => {
  const s = await setup()
  const unknown = await s.seed(s.networkKey('unknown-network'), networkBudget - 1)
  expect((await s.request(id())).status).toBe(404)
  expect((await s.request(s.shareId)).status).toBe(429)
  expect(s.queries()).toBe(1)
  s.advance(minute)
  expect((await s.request(s.shareId)).status).toBe(200)
  expect(await s.f.db.prepare('SELECT attempts FROM rate_counters WHERE id = ?').bind(unknown).first('attempts')).toBe(1)
  const previous = unknown
  s.advance(day)
  expect((await s.request(id())).status).toBe(404)
  expect(await s.f.db.prepare('SELECT id FROM rate_counters WHERE id = ?').bind(previous).first('id')).toBeNull()
  expect(await s.f.db.prepare('SELECT COUNT(*) AS count FROM rate_counters').first('count')).toBe(2)
})

it('keeps ordinary production-entry active and missing reads available within the budget', async () => {
  const s = await setup()
  const active = await s.f.request(`/api/public/v1/shares/${s.shareId}`)
  expect(active.status).toBe(200)
  expect(await active.json()).toEqual({ snapshot, revision: 1 })
  expect((await s.f.request(`/api/public/v1/shares/${id()}`)).status).toBe(404)
  const service = await s.counterId('public-share-service')
  expect(await s.f.db.prepare('SELECT attempts FROM rate_counters WHERE id = ?').bind(service).first('attempts')).toBe(2)
})
