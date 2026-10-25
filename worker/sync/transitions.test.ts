import { createHash, createHmac, hkdfSync } from 'node:crypto'
import { expect, it } from 'vitest'
import { CommitRequestSchema, MutationTransitionResponseSchema, type CommitRequest, type CommitReceipt, type MutationTransition, type RevisionDescriptor, type SafeEvent } from '../../src/account/protocol'
import { command, customer, direct, fixture, id, measuredDatabase, measurement, post, prepared } from './testing'

type Fixture = Awaited<ReturnType<typeof fixture>>
type Customer = Awaited<ReturnType<typeof customer>>
const head = (r: RevisionDescriptor) => ({ documentId: r.documentId, revisionId: r.revisionId })
async function accept(f: Fixture, signed: Customer, input: CommitRequest): Promise<CommitReceipt> {
  const response = await post(f, 'sync/commits', input, signed.headers)
  expect(response.status).toBe(200)
  return await response.json() as CommitReceipt
}
function url(mutationId: string, documents: readonly string[]) { return `/api/v1/sync/mutations/${mutationId}/transition?${new URLSearchParams(documents.map(document => ['document', document]))}` }
async function transition(f: Fixture, signed: Customer, input: CommitRequest, documents: readonly string[]): Promise<MutationTransition> {
  const response = await f.request(url(input.mutationId, documents), { headers: signed.headers })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const value = MutationTransitionResponseSchema.parse(await response.json())
  expect(value.kind).toBe('mutation-transition')
  if (value.kind !== 'mutation-transition') throw new Error(value.reason)
  expect(value.mutationId).toBe(input.mutationId)
  expect(value.accountId).toBe(signed.accountId)
  expect(value.requestDigest).toBe(createHash('sha256').update(JSON.stringify(CommitRequestSchema.parse(input))).digest('base64url'))
  expect(value.documents.map(row => row.documentId)).toEqual(documents)
  return value
}
it('reads actual direct two-parent transitions with unchanged control and exact predecessor epoch', async () => {
  const f = await fixture(), signed = await customer(f)
  const initial = await prepared(f, signed)
  const l = initial.descriptor, c = (await prepared(f, signed)).descriptor
  const genesis = command([l, c])
  await accept(f, signed, genesis)
  expect((await transition(f, signed, genesis, [l.documentId])).documents).toEqual([{ documentId: l.documentId, before: null, after: l.revisionId }])
  const r = (await prepared(f, signed, { documentId: l.documentId, parents: [l.revisionId] })).descriptor
  const registration = command([r], [], [])
  await accept(f, signed, registration)
  expect((await transition(f, signed, registration, [l.documentId])).previousPublicationEpoch).toBe(1)
  for (let index = 0; index < 8; index++) await accept(f, signed, command([r], [], []))
  for (const sameBody of [false, true]) {
    const current = await f.db.prepare('SELECT head FROM sync_documents WHERE document_id = ?').bind(l.documentId).first<string>('head')
    const s = (await prepared(f, signed, { documentId: l.documentId, parents: [r.revisionId, current!] }, sameBody ? initial.bytes : undefined)).descriptor
    const publish = command([s], [head(s), head(c)], [{ documentId: l.documentId, revisionId: current }, head(c)])
    const receipt = await accept(f, signed, publish)
    if (sameBody) {
      const body = await f.request(`/api/v1/sync/revisions/${s.revisionId}/chunks/0`, { headers: signed.headers })
      expect(new Uint8Array(await body.arrayBuffer())).toEqual(new Uint8Array(initial.bytes))
      expect(s.parents).toEqual([r.revisionId, current])
    }
    const value = await transition(f, signed, publish, [c.documentId, l.documentId])
    expect(value).toMatchObject({ receipt, previousPublicationEpoch: receipt.publicationEpoch - 1, documents: [{ documentId: c.documentId, before: c.revisionId, after: c.revisionId }, { documentId: l.documentId, before: current, after: s.revisionId }] })
  }
  const unchanged = command([], [head(c)], [head(c)])
  const receipt = await accept(f, signed, unchanged)
  expect((await transition(f, signed, unchanged, [c.documentId])).previousPublicationEpoch).toBe(receipt.publicationEpoch)
})
it('reports N rather than the never-current registered Q even when generic Worker accepts parents R,Q', async () => {
  const f = await fixture(), signed = await customer(f)
  const l = (await prepared(f, signed)).descriptor
  await accept(f, signed, command([l]))
  const q = (await prepared(f, signed, { documentId: l.documentId, parents: [l.revisionId], protected: true })).descriptor
  const r = (await prepared(f, signed, { documentId: l.documentId, parents: [l.revisionId] })).descriptor
  await accept(f, signed, command([q, r], [], []))
  const n = (await prepared(f, signed, { documentId: l.documentId, parents: [l.revisionId] })).descriptor
  await accept(f, signed, command([n], [head(n)], [head(l)]))
  const s = (await prepared(f, signed, { documentId: l.documentId, parents: [r.revisionId, q.revisionId], dependencies: [head(q)] })).descriptor
  const publish = command([s], [head(s)], [head(n)])
  await accept(f, signed, publish)
  expect((await transition(f, signed, publish, [l.documentId])).documents).toEqual([{ documentId: l.documentId, before: n.revisionId, after: s.revisionId }])
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM head_history WHERE revision_id = ?').bind(q.revisionId).first('n')).toBe(0)
  expect((await f.request(`${url(publish.mutationId, [l.documentId])}&before=${q.revisionId}`, { headers: signed.headers })).status).toBe(400)
})
it('preserves null or old physical heads through seed and headless bulk control transitions', async () => {
  const f = await fixture(), signed = await customer(f)
  const q = (await prepared(f, signed, { protected: true })).descriptor, h = (await prepared(f, signed)).descriptor
  await accept(f, signed, command([q], [], []))
  await accept(f, signed, command([h]))
  const c = (await prepared(f, signed, { protected: true, dependencies: [head(q), head(h)] })).descriptor
  await accept(f, signed, command([c]))
  const s = (await prepared(f, signed, { documentId: q.documentId, parents: [q.revisionId] })).descriptor
  const g = (await prepared(f, signed)).descriptor
  await accept(f, signed, command([s, g], [], []))
  const n = (await prepared(f, signed, { documentId: c.documentId, parents: [c.revisionId], protected: true, dependencies: [head(s), head(g)] })).descriptor
  const publish = { ...command([n], [head(n)], [head(c)]), expectedPublicationEpoch: 2 }
  const receipt = await accept(f, signed, publish)
  const value = await transition(f, signed, publish, [q.documentId, h.documentId, c.documentId, g.documentId])
  expect(value).toMatchObject({ receipt, previousPublicationEpoch: 2, documents: [{ documentId: q.documentId, before: null, after: null }, { documentId: h.documentId, before: h.revisionId, after: h.revisionId }, { documentId: c.documentId, before: c.revisionId, after: n.revisionId }, { documentId: g.documentId, before: null, after: null }] })
  const a = (await prepared(f, signed, { documentId: c.documentId, parents: [c.revisionId], protected: true, dependencies: [head(q)] })).descriptor
  const later = { ...command([a], [head(a)], [head(n)]), expectedPublicationEpoch: 3 }
  await accept(f, signed, later)
  expect((await transition(f, signed, later, [c.documentId])).documents[0].before).toBe(n.revisionId)
  expect(await transition(f, signed, publish, [q.documentId, h.documentId, c.documentId, g.documentId])).toEqual(value)
})

it('rejects malformed query grammar, scopes unknown mutations and permits read-only accounts', async () => {
  const f = await fixture(), signed = await customer(f), foreign = await customer(f, 'foreign')
  const l = (await prepared(f, signed)).descriptor, input = command([l])
  await accept(f, signed, input)
  for (const query of ['', '?document=', '?document=bad', `?document=${l.documentId}&document=${l.documentId}`, `?document=${l.documentId}&account=${signed.accountId}`, `?document=${l.documentId}&sequence=1`, `?document=${l.documentId}&cursor=x`, `?document=${'x'.repeat(4096)}`, `?${new URLSearchParams(Array.from({ length: 33 }, () => ['document', id()]))}`, '?document=AAAAAAAAAAAAAAAAAAAAAB']) {
    expect((await f.request(`/api/v1/sync/mutations/${input.mutationId}/transition${query}`, { headers: signed.headers })).status).toBe(400)
  }
  expect((await f.request(url('bad', [l.documentId]), { headers: signed.headers })).status).toBe(404)
  expect((await post(f, `sync/mutations/${input.mutationId}/transition?document=${l.documentId}`, {}, signed.headers)).status).toBe(404)
  expect((await f.request(url(input.mutationId, [l.documentId]))).status).toBe(401)
  expect((await f.request(url(input.mutationId, [l.documentId]), { headers: { ...signed.headers, origin: 'https://foreign.invalid' } })).status).toBe(403)
  expect(await (await f.request(url(input.mutationId, [l.documentId]), { headers: foreign.headers })).json()).toEqual({ version: 1, kind: 'mutation-transition-unavailable', mutationId: input.mutationId, reason: 'unknown-mutation' })
  await f.db.prepare("UPDATE accounts SET access = 'read-only' WHERE id = ?").bind(signed.accountId).run()
  await transition(f, signed, input, [l.documentId])
  const encoded = [...l.documentId].map(char => `%${char.charCodeAt(0).toString(16)}`).join('')
  expect((await f.request(`/api/v1/sync/mutations/${input.mutationId}/transition?document=${encoded}`, { headers: signed.headers })).status).toBe(200)
  const boundary = `?document=${encoded}`.padEnd(4096, '&')
  expect((await f.request(`/api/v1/sync/mutations/${input.mutationId}/transition${boundary}`, { headers: signed.headers })).status).toBe(200)
  expect((await f.request(`/api/v1/sync/mutations/${input.mutationId}/transition${boundary}&`, { headers: signed.headers })).status).toBe(400)
})
it.each([
  "UPDATE devices SET revoked_at = 1", "UPDATE customer_sessions SET revoked_at = 1",
  "UPDATE customer_sessions SET absolute_expires_at = 1", "UPDATE customer_sessions SET idle_expires_at = 1",
  "UPDATE accounts SET access = 'deleting'", "UPDATE accounts SET access = 'blocked'",
])('denies initial route authority after %s', async sql => {
  const f = await fixture(), signed = await customer(f)
  await f.db.prepare(sql).run()
  expect([401, 403]).toContain((await f.request(url(id(), [id()]), { headers: signed.headers })).status)
})
it('fails closed on retained local inconsistencies instead of emitting partial or guessed nulls', async () => {
  const f = await fixture(), signed = await customer(f)
  const l = (await prepared(f, signed)).descriptor
  const genesis = command([l]); await accept(f, signed, genesis)
  const r = (await prepared(f, signed, { documentId: l.documentId, parents: [l.revisionId] })).descriptor
  const stage = command([r], [], []); await accept(f, signed, stage)
  const input = command([], [head(r)], [head(l)]); await accept(f, signed, input)
  const receipts = (await f.db.prepare('SELECT account_id,mutation_id,digest,sequence,receipt,group_json FROM mutation_receipts').all()).results
  const history = (await f.db.prepare('SELECT account_id,document_id,sequence,revision_id FROM head_history').all()).results
  const membership = (await f.db.prepare('SELECT account_id,document_id,head,first_sequence FROM sync_documents').all()).results
  // Explicit damaged-ledger fixture bypasses certificate guards only after real accepted writes
  await f.db.prepare('DROP TRIGGER certificate_mutation_receipts_update').run()
  await f.db.prepare('DROP TRIGGER certificate_mutation_receipts_delete').run()
  const corruptions: [string, (string | number)[]][] = [
    ['DELETE FROM head_history WHERE sequence = 1', []], ['DELETE FROM head_history WHERE sequence = 3', []],
    ['DELETE FROM mutation_receipts WHERE sequence = 2', []], ['DELETE FROM sync_documents', []],
    ['UPDATE sync_documents SET first_sequence = 2', []], ['UPDATE head_history SET revision_id = ?', ['bad']],
    ['UPDATE mutation_receipts SET digest = ? WHERE sequence = 3', ['bad']],
    ["UPDATE mutation_receipts SET receipt = json_set(receipt,'$.mutationId',?) WHERE sequence = 3", [id()]],
    ["UPDATE mutation_receipts SET receipt = json_set(receipt,'$.sequence',4) WHERE sequence = 3", []],
    ["UPDATE mutation_receipts SET receipt = json_set(receipt,'$.heads[0].revisionId',?) WHERE sequence = 3", [id()]],
    ["UPDATE mutation_receipts SET receipt = json_set(receipt,'$.publicationEpoch',7) WHERE sequence = 2", []],
    ['UPDATE mutation_receipts SET receipt = ? WHERE sequence = 3', [' '.repeat(8193)]],
    ['UPDATE mutation_receipts SET receipt = ? WHERE sequence = 2', ['{']],
  ]
  for (const [sql, bindings] of corruptions) {
    await f.db.prepare(sql).bind(...bindings).run()
    const response = await f.request(url(input.mutationId, [l.documentId, id()]), { headers: signed.headers })
    expect(response.status, sql).toBe(200)
    expect(await response.json(), sql).toEqual({ version: 1, kind: 'mutation-transition-unavailable', mutationId: input.mutationId, reason: 'history-unavailable' })
    await f.db.batch([
      f.db.prepare('DELETE FROM mutation_receipts'), f.db.prepare('DELETE FROM head_history'), f.db.prepare('DELETE FROM sync_documents'),
      ...receipts.map(row => f.db.prepare('INSERT INTO mutation_receipts(account_id,mutation_id,digest,sequence,receipt,group_json) VALUES (?,?,?,?,?,?)').bind(row.account_id, row.mutation_id, row.digest, row.sequence, row.receipt, row.group_json)),
      ...history.map(row => f.db.prepare('INSERT INTO head_history(account_id,document_id,sequence,revision_id) VALUES (?,?,?,?)').bind(row.account_id, row.document_id, row.sequence, row.revision_id)),
      ...membership.map(row => f.db.prepare('INSERT INTO sync_documents(account_id,document_id,head,first_sequence) VALUES (?,?,?,?)').bind(row.account_id, row.document_id, row.head, row.first_sequence)),
    ])
  }
  // Removing an intermediate interval can leave valid earlier rows; only lifecycle completeness excludes it
  // These checks deliberately do not claim to establish deployed provenance from surviving counts
  expect((await f.events()).filter(event => event.stage === 'mutation-transition' && event.code === 'INTEGRITY_FAILED').length).toBe(corruptions.length)
})
it.each(['known', 'unknown', 'history-unavailable'] as const)('rechecks final live authority for %s outcome and separates native database failure', async kind => {
  const { readMutationTransition } = await import('./transitions')
  const f = await fixture(), signed = await customer(f)
  const l = (await prepared(f, signed)).descriptor, input = command([l]); await accept(f, signed, input)
  if (kind === 'history-unavailable') await f.db.prepare('DELETE FROM head_history').run()
  const { context, principal } = await direct(f, signed)
  const events: SafeEvent[] = []
  const observed = { ...context, emit: (event: SafeEvent) => { events.push(event) } }
  const mutationId = kind === 'unknown' ? id() : input.mutationId
  await readMutationTransition(principal, mutationId, [l.documentId], observed)
  expect(events.filter(event => event.stage === 'mutation-transition')).toHaveLength(1)
  events.length = 0
  const measured = measuredDatabase(f.db)
  let checked = false
  const proxy = new Proxy(measured.db, { get(target, key) {
    if (key === 'batch') return async (...args: Parameters<typeof target.batch>) => {
      if (checked) await f.db.prepare('UPDATE customer_sessions SET revoked_at = 1 WHERE id = ?').bind(principal.sessionId).run()
      return target.batch(...args)
    }
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
  await expect(readMutationTransition(principal, mutationId, [l.documentId], { ...observed, env: { ...context.env, DB: proxy }, checkpoint(stage) { if (stage === 'sync.transition.before-authority') checked = true } })).rejects.toThrow('AUTH_REQUIRED')
  expect(checked).toBe(true)
  expect(events.filter(event => event.stage === 'mutation-transition')).toEqual([])
  await measurement('transition-revoked', { kind, ...measured.values })
  const failed = new Proxy(f.db, { get(target, key) { if (key === 'batch') return async () => { throw new Error('synthetic database fault') }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value } })
  await expect(readMutationTransition(principal, input.mutationId, [l.documentId], { ...context, env: { ...context.env, DB: failed } })).rejects.toThrow('SERVICE_UNAVAILABLE')
})
it('rolls back a late receipt failure, retries exact bytes and retains only one competing CAS transition', async () => {
  const f = await fixture(), signed = await customer(f)
  const l = (await prepared(f, signed)).descriptor
  await accept(f, signed, command([l]))
  const r = (await prepared(f, signed, { documentId: l.documentId, parents: [l.revisionId] })).descriptor
  const input = command([r], [head(r)], [head(l)])
  await f.db.prepare("CREATE TRIGGER reject_transition_receipt BEFORE INSERT ON mutation_receipts BEGIN SELECT RAISE(ABORT,'synthetic late receipt failure'); END").run()
  expect((await post(f, 'sync/commits', input, signed.headers)).status).toBe(503)
  expect(await f.db.prepare('SELECT sequence FROM account_sequences').first('sequence')).toBe(1)
  expect(await f.db.prepare('SELECT head FROM sync_documents').first('head')).toBe(l.revisionId)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM head_history').first('n')).toBe(1)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM mutation_receipts').first('n')).toBe(1)
  await f.db.prepare('DROP TRIGGER reject_transition_receipt').run()
  await accept(f, signed, input)
  const a = (await prepared(f, signed, { documentId: l.documentId, parents: [r.revisionId] })).descriptor
  const b = (await prepared(f, signed, { documentId: l.documentId, parents: [r.revisionId] })).descriptor
  const commands = [command([a], [head(a)], [head(r)]), command([b], [head(b)], [head(r)])]
  const responses = await Promise.all(commands.map(value => post(f, 'sync/commits', value, signed.headers)))
  expect(responses.map(response => response.status).sort()).toEqual([200, 409])
  const winner = commands[responses.findIndex(response => response.status === 200)]
  expect((await transition(f, signed, winner, [l.documentId])).documents[0]).toEqual({ documentId: l.documentId, before: r.revisionId, after: winner.heads[0].revisionId })
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM head_history').first('n')).toBe(3)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM mutation_receipts').first('n')).toBe(3)
})
it('reconciles lost acceptance through both receipt APIs without changing quota or history on replay', async () => {
  const f = await fixture(), signed = await customer(f)
  const l = (await prepared(f, signed)).descriptor, input = command([l])
  f.failNext('sync.commit.after')
  expect((await post(f, 'sync/commits', input, signed.headers)).status).toBe(503)
  const receipt = await (await f.request(`/api/v1/sync/mutations/${input.mutationId}`, { headers: signed.headers })).json()
  const before = await transition(f, signed, input, [l.documentId])
  expect(before.receipt).toEqual(receipt)
  const quota = (await f.db.prepare('SELECT * FROM quota_counters ORDER BY scope').all()).results
  expect(await accept(f, signed, input)).toEqual(receipt)
  expect(await transition(f, signed, input, [l.documentId])).toEqual(before)
  expect((await f.db.prepare('SELECT * FROM quota_counters ORDER BY scope').all()).results).toEqual(quota)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM head_history').first('n')).toBe(1)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM transaction_guards').first('n')).toBe(0)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM scan_leases').first('n')).toBe(0)
})
it('measures bounded indexed history reads and stable complete fixed-directory batches during later writes', async () => {
  const { readMutationTransition } = await import('./transitions')
  const f = await fixture(), signed = await customer(f), key = new Uint8Array(32).fill(7)
  // Mirror the fixed identity recipe in workspace/directory without importing its browser repository graph
  // This synthetic account fixture measures physical coverage; B2 must derive and validate encrypted allocation
  const directoryShards = 64
  const fixedId = (purpose: string, value: string) => createHmac('sha256', Buffer.from(hkdfSync('sha256', key, signed.accountId, purpose, 32))).update(value).digest().subarray(0, 16).toString('base64url')
  const directories = Array.from({ length: directoryShards }, (_, shard) => fixedId('crykit/directory-id/v1', `directory:${shard}`))
  const control = fixedId('crykit/workspace-root-id/v1', 'workspace:root')
  const documents = [control, ...directories, id(), id()]
  const originals: RevisionDescriptor[] = []
  for (const documentId of documents) originals.push((await prepared(f, signed, { documentId })).descriptor)
  const commands: CommitRequest[] = []
  for (let index = 0; index < originals.length; index += 32) {
    const input = command(originals.slice(index, index + 32)); await accept(f, signed, input); commands.push(input)
  }
  const target = commands[2], never = id()
  const future = (await prepared(f, signed)).descriptor
  await accept(f, signed, command([future]))
  const requested = [...documents].reverse(), batches: MutationTransition[] = []
  for (let index = 0; index < requested.length; index += 32) {
    batches.push(await transition(f, signed, target, requested.slice(index, index + 32)))
    const current = await f.db.prepare('SELECT head FROM sync_documents WHERE document_id = ?').bind(control).first<string>('head')
    const next = (await prepared(f, signed, { documentId: control, parents: [current!] })).descriptor
    await accept(f, signed, { ...command([next], [head(next)], [{ documentId: control, revisionId: current }]), expectedPublicationEpoch: 4 + index / 32 })
  }
  expect(batches).toHaveLength(3)
  for (const batch of batches) expect({ ...batch, documents: [] }).toEqual({ ...batches[0], documents: [] })
  expect(batches.flatMap(batch => batch.documents).find(row => row.documentId === control)).toEqual({ documentId: control, before: originals[0].revisionId, after: originals[0].revisionId })
  expect((await transition(f, signed, target, [future.documentId, never])).documents).toEqual([{ documentId: future.documentId, before: null, after: null }, { documentId: never, before: null, after: null }])
  const alternate: RevisionDescriptor[] = []
  for (const original of originals.slice(0, 32)) alternate.push((await prepared(f, signed, { documentId: original.documentId, parents: [original.revisionId] })).descriptor)
  await accept(f, signed, command(alternate, [], []))
  const { context, principal } = await direct(f, signed)
  const measured = measuredDatabase(f.db), sql: string[] = []
  const db = new Proxy(measured.db, { get(target, field) {
    if (field === 'prepare') return (query: string) => { sql.push(query); return target.prepare(query) }
    const value = Reflect.get(target, field); return typeof value === 'function' ? value.bind(target) : value
  } })
  for (let depth = 1; depth <= 24; depth++) {
    const next = depth % 2 ? alternate : originals.slice(0, 32)
    const expected = await Promise.all(next.map(async row => ({ documentId: row.documentId, revisionId: await f.db.prepare('SELECT head FROM sync_documents WHERE document_id = ?').bind(row.documentId).first<string>('head') })))
    const input = command([], next.map(head), expected); await accept(f, signed, input)
    if (![1, 8, 24].includes(depth)) continue
    const viaRoute = await transition(f, signed, input, next.map(row => row.documentId))
    expect(viaRoute.documents.every(row => row.before !== null && row.after !== null)).toBe(true)
    const quota = (await f.db.prepare('SELECT * FROM quota_counters ORDER BY scope').all()).results
    measured.reset(); const started = performance.now()
    const result = await readMutationTransition(principal, input.mutationId, next.map(row => row.documentId), { ...context, env: { ...context.env, DB: db } })
    const costs = { ...measured.values }
    expect(result.kind).toBe('mutation-transition')
    expect(costs.queries).toBe(7); expect(costs.maxBatchStatements).toBe(5)
    expect(costs.maxBindings).toBeLessThanOrEqual(5)
    expect(costs.rowsRead).toBeLessThan(1000)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192)
    expect((await f.db.prepare('SELECT * FROM quota_counters ORDER BY scope').all()).results).toEqual(quota)
    const query = sql.find(query => query.startsWith('WITH anchor'))!
    const plan = (await f.db.prepare(`EXPLAIN QUERY PLAN ${query}`).bind(signed.accountId, input.mutationId, JSON.stringify(next.map(row => row.documentId))).all()).results
    const details = plan.map(row => String(row.detail))
    expect(details.filter(detail => detail.includes('SEARCH h USING')).length).toBe(5)
    expect(details.some(detail => /SCAN (h|d|mutation_receipts)\b/.test(detail))).toBe(false)
    await measurement('transition-depth', { depth, documents: next.length, ...costs, elapsedMs: performance.now() - started, responseBytes: Buffer.byteLength(JSON.stringify(result)), queryBytes: Buffer.byteLength(new URL(url(input.mutationId, next.map(row => row.documentId)), 'http://localhost').search), historyRows: await f.db.prepare('SELECT COUNT(*) AS n FROM head_history').first('n'), plans: details, fixedDirectoryCalls: batches.length, middlewareStatements: 4, middlewareBasis: 'source inspection, not native metadata measurement' })
  }
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM transaction_guards').first('n')).toBe(0)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM scan_leases').first('n')).toBe(0)
}, 20_000)
it('cleanup retains physical proof metadata and accepted payload pins after later edits', async () => {
  const { claimGenerationCleanup, cleanupExpiredUploads } = await import('./storage')
  const { reconcileExpiredPublicationWork } = await import('./commit')
  const f = await fixture(), signed = await customer(f)
  const q = await prepared(f, signed, { protected: true })
  await accept(f, signed, command([q.descriptor], [], []))
  const c = await prepared(f, signed, { protected: true, dependencies: [head(q.descriptor)] })
  const input = command([c.descriptor]); await accept(f, signed, input)
  const n = await prepared(f, signed, { documentId: c.descriptor.documentId, parents: [c.descriptor.revisionId] })
  await accept(f, signed, command([n.descriptor], [head(n.descriptor)], [head(c.descriptor)]))
  const unretained = await prepared(f, signed)
  const registration = command([unretained.descriptor], [], []); await accept(f, signed, registration)
  const metadata = async () => ({ receipts: (await f.db.prepare('SELECT * FROM mutation_receipts ORDER BY sequence').all()).results, history: (await f.db.prepare('SELECT * FROM head_history ORDER BY document_id,sequence').all()).results, documents: (await f.db.prepare('SELECT * FROM sync_documents ORDER BY document_id').all()).results })
  const before = await metadata(), observed = await transition(f, signed, input, [q.descriptor.documentId, c.descriptor.documentId])
  f.advance(86_400_001)
  const { context } = await direct(f, signed, 1_800_000_000_000 + 86_400_001)
  await reconcileExpiredPublicationWork(context)
  for (let count = 0; count < 5; count++) await cleanupExpiredUploads(context)
  for (const item of [q, c]) {
    const generation = await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id = ?').bind(item.input.uploadId).first<string>('generation')
    expect(await claimGenerationCleanup(signed.accountId, generation!, context)).toBe(false)
    expect((await f.request(`/api/v1/sync/revisions/${item.descriptor.revisionId}`, { headers: signed.headers })).status).toBe(200)
    const body = await f.request(`/api/v1/sync/revisions/${item.descriptor.revisionId}/chunks/0`, { headers: signed.headers })
    expect(body.status).toBe(200); expect(new Uint8Array(await body.arrayBuffer())).toEqual(new Uint8Array(item.bytes))
  }
  expect((await f.request(`/api/v1/sync/revisions/${unretained.descriptor.revisionId}/chunks/0`, { headers: signed.headers })).status).toBe(404)
  expect(await metadata()).toEqual(before)
  expect(await transition(f, signed, input, [q.descriptor.documentId, c.descriptor.documentId])).toEqual(observed)
  expect((await transition(f, signed, registration, [unretained.descriptor.documentId])).documents).toEqual([{ documentId: unretained.descriptor.documentId, before: null, after: null }])
})
