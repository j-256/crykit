import { expect, it } from 'vitest'
import { customer, fixture, id, post, direct } from '../sync/testing'
import type { PublicSnapshot } from '../../src/interchange/public-share-schema'
import { initializeRevocationLedger, readRevocation, readRevocationHead } from '../jobs/ledger'

const snapshot = (title = 'Published build'): PublicSnapshot => ({ version: 5, kind: 'build', title, setup: { catalogLock: { 'exact-public-baseline': 'historical-source-v1' }, baseline: null, layers: [], mode: { state: 'unknown' }, ppCostsNonNegative: { state: 'unknown' }, slots: [] }, slots: [{ primaryClass: null, secondaryClass: null, equipment: [], equipmentGroups: [], passives: [] }], receipts: [] })
async function setup() { const f = await fixture(); const owner = await customer(f); return { f, owner } }
const publish = (f: Awaited<ReturnType<typeof fixture>>, owner: Awaited<ReturnType<typeof customer>>, value = snapshot(), includeAttribution = false, mutationId = id()) => post(f, 'shares', { mutationId, snapshot: value, includeAttribution }, owner.headers)
const mutate = (f: Awaited<ReturnType<typeof fixture>>, owner: Awaited<ReturnType<typeof customer>>, shareId: string, method: string, body: object) => f.request(`/api/v1/shares/${shareId}`, { method, headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json', ...owner.headers }, body: JSON.stringify(body) })
async function created(f: Awaited<ReturnType<typeof fixture>>, owner: Awaited<ReturnType<typeof customer>>, includeAttribution = false) { const response = await publish(f, owner, snapshot(), includeAttribution); expect(response.status).toBe(200); return await response.json() as { shareId: string; revision: number; url: string; active: boolean } }
const read = (f: Awaited<ReturnType<typeof fixture>>, shareId: string) => f.request(`/api/public/v1/shares/${shareId}`)

it('draftEditsStayPrivateUntilExplicitUpdate', async () => {
  const { f, owner } = await setup(), initial = await created(f, owner)
  const first = await (await read(f, initial.shareId)).json()
  const draft = snapshot('Private changed draft')
  expect(await (await read(f, initial.shareId)).json()).toEqual(first)
  expect((await mutate(f, owner, initial.shareId, 'PATCH', { mutationId: id(), expectedRevision: 1, snapshot: draft, includeAttribution: false })).status).toBe(200)
  expect(await (await read(f, initial.shareId)).json()).toEqual({ snapshot: draft, revision: 2 })
})
it('failedUpdateKeepsPreviousSnapshot', async () => {
  const { f, owner } = await setup(), initial = await created(f, owner)
  f.failNext('shares.publish.before-batch')
  expect((await mutate(f, owner, initial.shareId, 'PATCH', { mutationId: id(), expectedRevision: 1, snapshot: snapshot('Failed'), includeAttribution: false })).status).toBe(503)
  expect(await (await read(f, initial.shareId)).json()).toEqual({ snapshot: snapshot(), revision: 1 })
})
it('stopPreventsRetrievalAndNeverReusesId', async () => {
  const { f, owner } = await setup(), initial = await created(f, owner)
  const { context } = await direct(f, owner)
  await initializeRevocationLedger({ ...context, env: { ...context.env, REVOCATION_LEDGER: f.revocations as unknown as R2Bucket } })
  expect((await mutate(f, owner, initial.shareId, 'DELETE', { mutationId: id(), expectedRevision: 1 })).status).toBe(200)
  const stopped = await read(f, initial.shareId)
  expect(stopped.status).toBe(404)
  expect(stopped.headers.get('Cache-Control')).toContain('no-store')
  expect(stopped.headers.get('X-Robots-Tag')).toContain('noindex')
  expect((await created(f, owner)).shareId).not.toBe(initial.shareId)
})
it('attributionIsOptInAndTracksCurrentName', async () => {
  const { f, owner } = await setup(), anonymous = await created(f, owner), attributed = await created(f, owner, true)
  expect(await (await read(f, anonymous.shareId)).json()).not.toHaveProperty('attribution')
  await f.db.prepare('UPDATE accounts SET username = ? WHERE id = ?').bind('renamed_user', owner.accountId).run()
  expect(await (await read(f, attributed.shareId)).json()).toMatchObject({ attribution: { username: 'renamed_user' } })
  await f.db.prepare('UPDATE accounts SET username_withheld = 1 WHERE id = ?').bind(owner.accountId).run()
  expect(await (await read(f, attributed.shareId)).json()).not.toHaveProperty('attribution')
})

it('guards ownership, CSRF, expected revision, strict nested input and exact replay', async () => {
  const { f, owner } = await setup(), other = await customer(f, 'other'), mutationId = id()
  const first = await publish(f, owner, snapshot(), false, mutationId), value = await first.json() as { shareId: string }
  expect(first.status).toBe(200)
  expect(await (await publish(f, owner, snapshot(), false, mutationId)).json()).toEqual(value)
  expect((await publish(f, owner, snapshot('Different'), false, mutationId)).status).toBe(409)
  const input = { mutationId: id(), expectedRevision: 1, snapshot: snapshot('Changed'), includeAttribution: false }
  expect((await mutate(f, other, value.shareId, 'PATCH', input)).status).toBe(409)
  expect(await (await f.request('/api/v1/shares', { headers: other.headers })).json()).toEqual({ shares: [], next: null })
  expect((await mutate(f, owner, value.shareId, 'PATCH', { ...input, expectedRevision: 2 })).status).toBe(409)
  expect((await post(f, 'shares', { mutationId: id(), snapshot: snapshot(), includeAttribution: false }, { cookie: owner.headers.cookie })).status).toBe(403)
  expect((await publish(f, owner, { ...snapshot(), slots: [{ ...snapshot().slots[0]!, private: 'PRIVATE_NESTED_SENTINEL' }] } as unknown as PublicSnapshot)).status).toBe(400)
  const publicRead = await read(f, value.shareId), text = await publicRead.text()
  for (const secret of [owner.accountId, 'sync@example.org', 'PRIVATE_NESTED_SENTINEL', mutationId]) expect(text).not.toContain(secret)
  expect(publicRead.headers.get('cache-control')).toContain('no-store')
  expect(publicRead.headers.get('x-robots-tag')).toContain('noindex')
  expect((await read(f, id())).status).toBe(404)
})
it('rolls back pointer, snapshot and receipt when authoritative quota fails', async () => {
  const { f, owner } = await setup(), initial = await created(f, owner)
  await f.db.prepare('UPDATE accounts SET capacity_bytes = 1 WHERE id = ?').bind(owner.accountId).run()
  // The deliberate quota edit changes globally charged account metadata before the failing publication
  const before = await f.db.prepare('SELECT * FROM quota_counters ORDER BY scope').all()
  expect((await mutate(f, owner, initial.shareId, 'PATCH', { mutationId: id(), expectedRevision: 1, snapshot: snapshot('Oversized'), includeAttribution: true })).status).toBe(413)
  expect(await (await read(f, initial.shareId)).json()).toEqual({ snapshot: snapshot(), revision: 1 })
  expect((await f.db.prepare('SELECT * FROM quota_counters ORDER BY scope').all()).results).toEqual(before.results)
  expect(await f.db.prepare('SELECT COUNT(*) FROM share_snapshots').first('COUNT(*)')).toBe(1)
})
it('read-only owners can Stop while publish and Update retain live verified write guards', async () => {
  const { f, owner } = await setup(), initial = await created(f, owner), { context } = await direct(f, owner)
  await initializeRevocationLedger({ ...context, env: { ...context.env, REVOCATION_LEDGER: f.revocations as unknown as R2Bucket } })
  await f.db.prepare("UPDATE accounts SET access = 'read-only', capacity_bytes = 1 WHERE id = ?").bind(owner.accountId).run()
  expect((await publish(f, owner)).status).toBe(403)
  expect((await mutate(f, owner, initial.shareId, 'PATCH', { mutationId: id(), expectedRevision: 1, snapshot: snapshot(), includeAttribution: false })).status).toBe(403)
  expect((await mutate(f, owner, initial.shareId, 'DELETE', { mutationId: id(), expectedRevision: 1 })).status).toBe(200)
})
it('pending Stop blocks reads, advertises exact retry metadata and cannot claim success without the independent ledger', async () => {
  const { f, owner } = await setup(), initial = await created(f, owner), mutationId = id()
  const command = { mutationId, expectedRevision: 1 }
  expect((await mutate(f, owner, initial.shareId, 'DELETE', command)).status).toBe(503)
  expect((await read(f, initial.shareId)).status).toBe(404)
  const row = await f.db.prepare('SELECT event,receipt FROM share_mutations WHERE mutation_id = ?').bind(mutationId).first<{ event: string; receipt: string | null }>()
  expect(row!.receipt).toBeNull()
  const own = await (await f.request('/api/v1/shares', { headers: owner.headers })).json()
  expect(own).toMatchObject({ shares: [{ state: 'stopping', stopMutationId: mutationId, stopExpectedRevision: 1 }] })
  const { context } = await direct(f, owner), ledger = { ...context, env: { ...context.env, REVOCATION_LEDGER: f.revocations as unknown as R2Bucket } }
  await initializeRevocationLedger(ledger)
  expect((await mutate(f, owner, initial.shareId, 'DELETE', command)).status).toBe(200)
  const event = JSON.parse(row!.event)
  expect(await readRevocation(event.intentId, ledger)).toEqual(event)
  expect((await readRevocationHead(ledger)).sequence).toBe(1)
  expect((await mutate(f, owner, initial.shareId, 'DELETE', command)).status).toBe(200)
  expect((await readRevocationHead(ledger)).sequence).toBe(1)
})
it.each(['events/', 'index/', 'head'])('retries exact pending Stop after a lost real ledger PUT response at %s', async part => {
  const { stopSharing } = await import('./publication')
  const { f, owner } = await setup(), initial = await created(f, owner), { context, principal } = await direct(f, owner)
  const bucket = f.revocations as unknown as R2Bucket
  const ledger = { ...context, env: { ...context.env, SERVICE_ORIGIN: 'http://127.0.0.1', REVOCATION_LEDGER: bucket } }
  await initializeRevocationLedger(ledger)
  let lost = false
  const proxy = new Proxy(bucket, { get(target, key) {
    if (key === 'put') return async (...args: Parameters<R2Bucket['put']>) => { const result = await target.put(...args); if (!lost && String(args[0]).includes(part)) { lost = true; throw new Error('PRIVATE_PROVIDER_FAILURE') }; return result }
    const member = Reflect.get(target, key); return typeof member === 'function' ? member.bind(target) : member
  } })
  const input = { mutationId: id(), expectedRevision: 1 }
  await expect(stopSharing(principal, initial.shareId, input, { ...ledger, env: { ...ledger.env, REVOCATION_LEDGER: proxy } })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  expect(lost).toBe(true)
  expect((await read(f, initial.shareId)).status).toBe(404)
  const pending = await f.db.prepare('SELECT event,receipt FROM share_mutations WHERE mutation_id = ?').bind(input.mutationId).first<{ event: string; receipt: string | null }>()
  expect(pending!.receipt).toBeNull()
  await expect(stopSharing(principal, initial.shareId, input, ledger)).resolves.toMatchObject({ active: false, revision: 2 })
  expect(await readRevocation(JSON.parse(pending!.event).intentId, ledger)).toEqual(JSON.parse(pending!.event))
  expect((await readRevocationHead(ledger)).sequence).toBe(1)
})
it('a policy race blocks publish in the batch and revoked session blocks final Stop receipt after ledger acknowledgment', async () => {
  const { publishSnapshot, stopSharing } = await import('./publication')
  const { f, owner } = await setup(), initial = await created(f, owner), { context, principal } = await direct(f, owner)
  const ledger = { ...context, env: { ...context.env, SERVICE_ORIGIN: 'http://127.0.0.1', REVOCATION_LEDGER: f.revocations as unknown as R2Bucket } }
  await initializeRevocationLedger(ledger)
  // Intercept the actual guarded batch boundary after the preflight permission read
  const original = f.db.batch.bind(f.db)
  let restricted = false
  const db = new Proxy(f.db, { get(target, key) {
    if (key === 'batch') return async (...args: Parameters<typeof f.db.batch>) => { if (!restricted) { restricted = true; await f.db.prepare("UPDATE accounts SET access = 'read-only' WHERE id = ?").bind(owner.accountId).run() }; return original(...args) }
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
  await expect(publishSnapshot(principal, { mutationId: id(), snapshot: snapshot(), includeAttribution: false }, { ...ledger, env: { ...ledger.env, DB: db } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  const input = { mutationId: id(), expectedRevision: 1 }
  let revoke = false
  const stopDb = new Proxy(f.db, { get(target, key) {
    if (key === 'batch') return async (...args: Parameters<typeof f.db.batch>) => { if (revoke) await f.db.prepare('UPDATE customer_sessions SET revoked_at = 1 WHERE id = ?').bind(principal.sessionId).run(); return original(...args) }
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
  await expect(stopSharing(principal, initial.shareId, input, { ...ledger, env: { ...ledger.env, DB: stopDb }, checkpoint: stage => { if (stage === 'shares.stop.after-ledger') revoke = true } })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
  expect((await readRevocationHead(ledger)).sequence).toBe(1)
  expect(await f.db.prepare('SELECT receipt FROM share_mutations WHERE mutation_id = ?').bind(input.mutationId).first('receipt')).toBeNull()
  expect((await read(f, initial.shareId)).status).toBe(404)
})
it('withheld names remain withheld on identical rename and clear only for a different permitted name', async () => {
  const { f, owner } = await setup(), initial = await created(f, owner, true)
  const rename = (username: string, expectedRevision: number) => f.request('/api/v1/account/username', { method: 'PATCH', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json', ...owner.headers }, body: JSON.stringify({ username, expectedRevision, transactionId: id() }) })
  expect((await rename('moderated_name', 1)).status).toBe(200)
  await f.db.prepare('UPDATE accounts SET username_withheld = 1 WHERE id = ?').bind(owner.accountId).run()
  expect((await rename('moderated_name', 2)).status).toBe(200)
  expect(await (await read(f, initial.shareId)).json()).not.toHaveProperty('attribution')
  expect((await rename('allowed_name', 3)).status).toBe(200)
  expect(await (await read(f, initial.shareId)).json()).toMatchObject({ attribution: { username: 'allowed_name' } })
})
it('Stop survives a lost final D1 response and preserves exact epoch and event across retry', async () => {
  const { f, owner } = await setup(), initial = await created(f, owner), { context } = await direct(f, owner)
  await f.db.prepare('UPDATE accounts SET session_epoch = 7 WHERE id = ?').bind(owner.accountId).run()
  const ledger = { ...context, env: { ...context.env, REVOCATION_LEDGER: f.revocations as unknown as R2Bucket } }
  await initializeRevocationLedger(ledger)
  const input = { mutationId: id(), expectedRevision: 1 }
  f.failNext('shares.stop.after-batch')
  expect((await mutate(f, owner, initial.shareId, 'DELETE', input)).status).toBe(503)
  expect((await mutate(f, owner, initial.shareId, 'DELETE', input)).status).toBe(200)
  const value = await f.db.prepare('SELECT event FROM share_mutations WHERE mutation_id = ?').bind(input.mutationId).first<string>('event')
  const event = JSON.parse(value!)
  expect(event.sessionEpoch).toBe(7)
  expect(await readRevocation(event.intentId, ledger)).toEqual(event)
  expect((await readRevocationHead(ledger)).sequence).toBe(1)
  expect(await f.db.prepare('SELECT session_epoch FROM accounts WHERE id = ?').bind(owner.accountId).first('session_epoch')).toBe(7)
})
it('retains hosted-sized snapshots beyond portable capacity and enforces the decoded JSON bound', async () => {
  const { f, owner } = await setup()
  const large = { ...snapshot(), notes: { slots: [{ contextAssumptions: Array.from({ length: 8 }, () => 'N'.repeat(16_384)) }] } }
  const response = await publish(f, owner, large)
  expect(response.status).toBe(200)
  const value = await response.json() as { shareId: string }
  expect(await (await read(f, value.shareId)).json()).toMatchObject({ snapshot: large })
  const oversized = { ...large, notes: { slots: [{ contextAssumptions: Array.from({ length: 17 }, () => 'N'.repeat(16_384)) }] } }
  expect((await publish(f, owner, oversized)).status).toBe(413)
})
it('charges exact generated share metadata and preserves every immutable original snapshot', async () => {
  const { f, owner } = await setup()
  const beforeGlobal = await f.db.prepare("SELECT metadata_bytes FROM quota_counters WHERE scope = 'global'").first<number>('metadata_bytes')
  const beforeAccount = await f.db.prepare('SELECT metadata_bytes FROM quota_counters WHERE scope = ?').bind(owner.accountId).first<number>('metadata_bytes') ?? 0
  const first = await created(f, owner)
  expect((await mutate(f, owner, first.shareId, 'PATCH', { mutationId: id(), expectedRevision: 1, snapshot: snapshot('Next'), includeAttribution: false })).status).toBe(200)
  const bytes = await f.db.prepare('SELECT (SELECT SUM(metadata_bytes) FROM shares) + (SELECT SUM(metadata_bytes) FROM share_snapshots) + (SELECT SUM(metadata_bytes) FROM share_mutations) AS bytes').first<number>('bytes')
  // Share deltas remain exact while unrelated auth, email and admin metadata retain their own charge
  expect(await f.db.prepare("SELECT metadata_bytes FROM quota_counters WHERE scope = 'global'").first('metadata_bytes')).toBe(beforeGlobal! + bytes!)
  expect(await f.db.prepare('SELECT metadata_bytes FROM quota_counters WHERE scope = ?').bind(owner.accountId).first('metadata_bytes')).toBe(beforeAccount + bytes!)
  expect(JSON.parse((await f.db.prepare('SELECT snapshot FROM share_snapshots WHERE share_id = ? AND revision = 1').bind(first.shareId).first<string>('snapshot'))!)).toEqual(snapshot())
  await expect(f.db.prepare("UPDATE share_snapshots SET snapshot = '{}' WHERE share_id = ?").bind(first.shareId).run()).rejects.toThrow('share_snapshot_immutable')
})
it('competing Updates advance one pointer and same-mutation publication races allocate one identity', async () => {
  const { f, owner } = await setup(), mutationId = id()
  const publications = await Promise.all([publish(f, owner, snapshot(), false, mutationId), publish(f, owner, snapshot(), false, mutationId)])
  expect(publications.map(response => response.status)).toEqual([200, 200])
  const created = await Promise.all(publications.map(response => response.json())) as { shareId: string }[]
  expect(created[0]).toEqual(created[1])
  const updates = await Promise.all(['One', 'Two'].map(title => mutate(f, owner, created[0].shareId, 'PATCH', { mutationId: id(), expectedRevision: 1, snapshot: snapshot(title), includeAttribution: false })))
  expect(updates.map(response => response.status).sort()).toEqual([200, 409])
  expect(await f.db.prepare('SELECT COUNT(*) FROM share_snapshots').first('COUNT(*)')).toBe(2)
  expect(await f.db.prepare('SELECT COUNT(*) FROM share_mutations').first('COUNT(*)')).toBe(2)
  expect(await (await read(f, created[0].shareId)).json()).toMatchObject({ revision: 2 })
})

it('reads exact empty Team locks and preserves older v5 snapshots', async () => {
  const { f, owner } = await setup()
  const emitted: PublicSnapshot = { ...snapshot('Empty public Team'), kind: 'team', slots: [null, null, null, null] }
  const published = await publish(f, owner, emitted), value = await published.json() as { shareId: string }
  expect(published.status).toBe(200)
  expect(await (await read(f, value.shareId)).json()).toEqual({ snapshot: emitted, revision: 1 })
  const { catalogLock: _lock, ...oldSetup } = emitted.setup
  const old = { ...emitted, setup: oldSetup }
  const older = await publish(f, owner, old), prior = await older.json() as { shareId: string }
  expect(older.status).toBe(200)
  expect(await (await read(f, prior.shareId)).json()).toEqual({ snapshot: old, revision: 1 })
})
