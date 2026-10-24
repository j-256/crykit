import { expect, it } from 'vitest'
import { fixture, customer, prepared, command, post, direct, id } from './testing'
import { previewCleanup, executeCleanup } from './cleanup'
const DAY = 24 * 60 * 60 * 1000
async function candidate() {
  const f = await fixture(), signed = await customer(f), original = await prepared(f, signed, { protected: true })
  const first = await prepared(f, signed, { dependencies: [{ documentId: original.descriptor.documentId, revisionId: original.descriptor.revisionId }] })
  const initial = command([original.descriptor, first.descriptor], [{ documentId: first.descriptor.documentId, revisionId: first.descriptor.revisionId }])
  expect((await post(f, 'sync/commits', initial, signed.headers)).status).toBe(200)
  let parent = first.descriptor.revisionId
  for (let n = 0; n < 20; n++) {
    const next = await prepared(f, signed, { documentId: first.descriptor.documentId, parents: [parent] })
    expect((await post(f, 'sync/commits', command([next.descriptor], undefined, [{ documentId: first.descriptor.documentId, revisionId: parent }]), signed.headers)).status).toBe(200)
    parent = next.descriptor.revisionId
  }
  const { context, principal } = await direct(f, signed)
  // Only the tested generation is aged; live session authority stays real and unchanged
  await f.db.prepare('UPDATE storage_generations SET expires_at=? WHERE upload_id=?').bind(context.now() - 31 * DAY, first.descriptor.uploadId).run()
  return { f, signed, original, first, context, principal, ref: { documentId: first.descriptor.documentId, revisionId: first.descriptor.revisionId } }
}
it('reclaims only the eligible envelope, retaining original bytes and permanent marker liabilities', async () => {
  const c = await candidate(), preview = await previewCleanup(c.principal, c.ref, c.context)
  expect(preview.eligible).toBe(true)
  expect(preview.dependencies).toEqual(c.first.descriptor.dependencies)
  const before = await c.f.db.prepare('SELECT payload_bytes FROM quota_counters WHERE scope=?').bind(c.signed.accountId).first<number>('payload_bytes')
  const result = await executeCleanup(c.principal, preview, c.context)
  expect(result.state).toBe('complete')
  expect(result.releasedBytes).toBeGreaterThan(0)
  const after = await c.f.db.prepare('SELECT payload_bytes FROM quota_counters WHERE scope=?').bind(c.signed.accountId).first<number>('payload_bytes')
  expect(before! - after!).toBe(result.releasedBytes)
  expect((await c.f.request(`/api/v1/sync/revisions/${c.original.descriptor.revisionId}/chunks/0`, { headers: c.signed.headers })).status).toBe(200)
  expect((await c.f.request(`/api/v1/sync/revisions/${c.first.descriptor.revisionId}`, { headers: c.signed.headers })).status).toBe(200)
  expect((await c.f.request(`/api/v1/sync/revisions/${c.first.descriptor.revisionId}/chunks/0`, { headers: c.signed.headers })).status).toBe(404)
  expect((await executeCleanup(c.principal, preview, c.context)).state).toBe('complete')
  expect(await c.f.db.prepare('SELECT COUNT(*) AS n FROM publication_pins WHERE account_id=? AND revision_id=?').bind(c.signed.accountId, c.original.descriptor.revisionId).first<number>('n')).toBeGreaterThan(0)
})
it('preserves pins for stale epoch and exact shared retaining dependency', async () => {
  const c = await candidate(), preview = await previewCleanup(c.principal, c.ref, c.context)
  expect((await executeCleanup(c.principal, { ...preview, publicationEpoch: preview.publicationEpoch - 1 }, c.context)).state).toBe('blocked')
  const held = await prepared(c.f, c.signed, { protected: true, dependencies: [c.ref] })
  expect((await post(c.f, 'sync/commits', command([held.descriptor]), c.signed.headers)).status).toBe(200)
  expect((await previewCleanup(c.principal, c.ref, c.context)).reasons).toContain('referenced')
  const row = await c.f.db.prepare('SELECT state FROM storage_generations WHERE id=?').bind(preview.generation).first<string>('state')
  expect(row).toBe('ready')
})
it('blocks protected, young and latest twenty revisions without altering payloads', async () => {
  const f = await fixture(), signed = await customer(f), value = await prepared(f, signed, { protected: true })
  expect((await post(f, 'sync/commits', command([value.descriptor]), signed.headers)).status).toBe(200)
  const { principal, context } = await direct(f, signed)
  const preview = await previewCleanup(principal, { documentId: value.descriptor.documentId, revisionId: value.descriptor.revisionId }, context)
  expect(preview.eligible).toBe(false)
  expect(preview.reasons).toEqual(expect.arrayContaining(['protected', 'young', 'recent', 'current']))
  expect((await executeCleanup(principal, preview, context)).state).toBe('blocked')
  expect((await executeCleanup(principal, { ...preview, generation: id() }, context)).state).toBe('blocked')
})

it('preserves latest twenty distinct revisions even when a head was published repeatedly', async () => {
  const c = await candidate()
  const latest = (await c.f.db.prepare('SELECT revision_id FROM head_history WHERE account_id=? AND document_id=? ORDER BY sequence DESC LIMIT 1').bind(c.signed.accountId, c.ref.documentId).first<string>('revision_id'))!
  for (let n = 0; n < 21; n++) await c.f.db.prepare('INSERT INTO head_history(account_id,document_id,sequence,revision_id) VALUES (?,?,?,?)').bind(c.signed.accountId, c.ref.documentId, 100 + n, latest).run()
  expect((await previewCleanup(c.principal, c.ref, c.context)).eligible).toBe(true)
})
it('work and live scan exclusion preserve every exact candidate pin', async () => {
  const c = await candidate(), before = await c.f.db.prepare('SELECT * FROM publication_pins WHERE account_id=?').bind(c.signed.accountId).all()
  const work = id()
  await c.f.db.prepare("INSERT INTO publication_work(account_id,mutation_id,digest,state,expires_at) VALUES (?,?,?,'validating',0)").bind(c.signed.accountId, work, id()).run()
  let preview = await previewCleanup(c.principal, c.ref, c.context)
  expect(preview.reasons).toContain('work')
  expect((await executeCleanup(c.principal, preview, c.context)).state).toBe('blocked')
  await c.f.db.prepare('DELETE FROM publication_work WHERE mutation_id=?').bind(work).run()
  expect((await c.f.request('/api/v1/sync/changes?limit=1', { headers: c.signed.headers })).status).toBe(200)
  preview = await previewCleanup(c.principal, c.ref, c.context)
  expect(preview.reasons).toContain('scan')
  expect((await executeCleanup(c.principal, preview, c.context)).state).toBe('blocked')
  expect((await c.f.db.prepare('SELECT * FROM publication_pins WHERE account_id=?').bind(c.signed.accountId).all()).results).toEqual(before.results)
})
it('full quota and upload pause permit cleanup while read-only authority cannot retire pins', async () => {
  const c = await candidate(), preview = await previewCleanup(c.principal, c.ref, c.context)
  await c.f.db.prepare('UPDATE accounts SET capacity_bytes=1 WHERE id=?').bind(c.signed.accountId).run()
  await c.f.db.prepare('UPDATE service_settings SET uploads_paused=1').run()
  await c.f.db.prepare("UPDATE accounts SET access='read-only' WHERE id=?").bind(c.signed.accountId).run()
  await expect(executeCleanup(c.principal, preview, c.context)).rejects.toThrow('FORBIDDEN')
  await c.f.db.prepare("UPDATE accounts SET access='active' WHERE id=?").bind(c.signed.accountId).run()
  expect((await executeCleanup(c.principal, preview, c.context)).state).toBe('complete')
})
it('rolls back certificates and pins when closing fails inside the same transaction', async () => {
  const c = await candidate(), preview = await previewCleanup(c.principal, c.ref, c.context)
  const beforePins = (await c.f.db.prepare('SELECT * FROM publication_pins WHERE account_id=?').bind(c.signed.accountId).all()).results
  const beforeCertificates = (await c.f.db.prepare('SELECT * FROM publication_certificates WHERE account_id=?').bind(c.signed.accountId).all()).results
  expect(beforeCertificates.length).toBeGreaterThan(0)
  await c.f.db.exec("CREATE TRIGGER reject_cleanup BEFORE UPDATE ON storage_generations WHEN NEW.state='closing' BEGIN SELECT RAISE(ABORT,'synthetic_cleanup_failure'); END")
  await expect(executeCleanup(c.principal, preview, c.context)).rejects.toThrow('synthetic_cleanup_failure')
  expect((await c.f.db.prepare('SELECT * FROM publication_pins WHERE account_id=?').bind(c.signed.accountId).all()).results).toEqual(beforePins)
  expect((await c.f.db.prepare('SELECT * FROM publication_certificates WHERE account_id=?').bind(c.signed.accountId).all()).results).toEqual(beforeCertificates)
  expect(await c.f.db.prepare('SELECT state FROM storage_generations WHERE id=?').bind(preview.generation).first('state')).toBe('ready')
})
it('routes require customer Origin/CSRF and return observed metadata without private categories', async () => {
  const f = await fixture(), signed = await customer(f), { context } = await direct(f, signed)
  const input = { version: 1, ref: { documentId: id(), revisionId: id() } }
  const denied = await f.request('/api/v1/sync/cleanup/preview', { method: 'POST', headers: { ...signed.headers, 'content-type': 'application/json' }, body: JSON.stringify(input) })
  expect(denied.status).toBe(403)
  expect(await denied.json()).toMatchObject({ error: { code: 'CSRF_FAILED' } })
  const response = await f.request('/api/v1/account/storage', { headers: signed.headers })
  expect(await response.json()).toEqual({ version: 1, source: 'application-database', observedAt: context.now(), capacityBytes: expect.any(Number), usedBytes: 0 })
})

it('snapshot retention and foreign identity block cleanup, while failed fencing retains liabilities', async () => {
  const c = await candidate(), preview = await previewCleanup(c.principal, c.ref, c.context), snapshot = id()
  await c.f.db.prepare("INSERT INTO service_snapshots(id,source_generation,state,created_at,ledger,secrets,rows,bytes,reserve) VALUES (?,?,'complete',?,'{}','{}',0,0,0)").bind(snapshot, id(), c.context.now()).run()
  await c.f.db.prepare('INSERT INTO service_snapshot_pins(snapshot_id,generation) VALUES (?,?)').bind(snapshot, preview.generation).run()
  expect((await previewCleanup(c.principal, c.ref, c.context)).reasons).toContain('snapshot')
  expect((await executeCleanup(c.principal, preview, c.context)).state).toBe('blocked')
  await expect(previewCleanup({ ...c.principal, accountId: id() }, c.ref, c.context)).rejects.toThrow('NOT_FOUND')
  await c.f.db.prepare("UPDATE service_snapshots SET state='expired' WHERE id=?").bind(snapshot).run()
  const before = await c.f.db.prepare('SELECT payload_bytes FROM quota_counters WHERE scope=?').bind(c.signed.accountId).first('payload_bytes')
  const objects = new Proxy(c.context.env.OBJECTS!, { get(target, key) { if (key === 'get') return async () => null; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value } })
  expect((await executeCleanup(c.principal, preview, { ...c.context, env: { ...c.context.env, OBJECTS: objects } })).state).toBe('pending')
  expect(await c.f.db.prepare('SELECT payload_bytes FROM quota_counters WHERE scope=?').bind(c.signed.accountId).first('payload_bytes')).toBe(before)
  expect((await executeCleanup(c.principal, preview, c.context)).state).toBe('pending')
})
