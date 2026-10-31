import { afterEach, expect, it } from 'vitest'
import { randomBytes, createHash } from 'node:crypto'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { createServiceContext, type ServiceContext } from '../context'
import { nativeFixtureHost } from '../testing/native-loopback'
import { appendRevocation, initializeRevocationLedger, prepareRevocationLiabilities, readRevocation, readRevocationLiabilities, readRevocationHead, verifyRevocationLedgerPage, type RevocationEvent, type LedgerScan, type ClosedLiabilityPage } from './ledger'

type R2Bucket = NonNullable<ServiceContext['env']['REVOCATION_LEDGER']>

const fixtures: Miniflare[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.dispose())) })
const id = () => randomBytes(16).toString('base64url')
const event = (): RevocationEvent => ({ version: 1, kind: 'share-stopped', accountId: id(), shareId: id(), intentId: id(), sessionEpoch: 1, timestamp: 1700000000000 })
async function fixture() {
  const mf = new Miniflare(convertV4MiniflareOptions({ host: nativeFixtureHost(), modules: true, script: 'export default { fetch() { return new Response("fixture") } }', compatibilityDate: '2026-09-28', r2Buckets: ['REVOCATION_LEDGER'] }))
  fixtures.push(mf)
  const bucket = await mf.getR2Bucket('REVOCATION_LEDGER') as unknown as R2Bucket
  const context = () => createServiceContext(new Request('http://localhost'), { REVOCATION_LEDGER: bucket }, { emit() {}, now: () => 1700000000000 })
  await initializeRevocationLedger(context())
  return { bucket, context }
}
async function scan(context: ReturnType<Awaited<ReturnType<typeof fixture>>['context']>) {
  let cursor: LedgerScan | undefined
  const events: RevocationEvent[] = []
  do { const page = await verifyRevocationLedgerPage(context, cursor); events.push(...page.events); cursor = page.next ?? undefined } while (cursor)
  return events
}
it('acknowledges exact independent event, index and head coverage and replays without growth', async () => {
  const f = await fixture(), input = event()
  await appendRevocation(input, f.context())
  expect(await readRevocation(input.intentId, f.context())).toEqual(input)
  expect((await readRevocationHead(f.context())).sequence).toBe(1)
  expect(await scan(f.context())).toEqual([input])
  const before = (await f.bucket.list()).objects.map(o => o.key)
  await appendRevocation(input, f.context())
  expect((await f.bucket.list()).objects.map(o => o.key)).toEqual(before)
  await expect(appendRevocation({ ...input, timestamp: input.timestamp + 1 }, f.context())).rejects.toMatchObject({ code: 'LEDGER_INTENT_MISMATCH' })
})

function withBucket(f: Awaited<ReturnType<typeof fixture>>, replacement: R2Bucket) {
  return { ...f.context(), env: { REVOCATION_LEDGER: replacement } }
}
function intercept(bucket: R2Bucket, method: 'put' | 'list', replacement: (...args: unknown[]) => unknown): R2Bucket {
  return new Proxy(bucket, { get(target, key) { if (key === method) return replacement; const member = Reflect.get(target, key); return typeof member === 'function' ? member.bind(target) : member } })
}
it.each(['events/', 'index/', 'head'])('recovers a lost actual R2 PUT response at %s in a fresh context', async part => {
  const f = await fixture(), input = event()
  let lost = false
  const bucket = intercept(f.bucket, 'put', async (...args) => {
    const result = await f.bucket.put(...args as Parameters<R2Bucket['put']>)
    if (!lost && String(args[0]).includes(part)) { lost = true; throw new Error('private upstream response must not escape') }
    return result
  })
  await expect(appendRevocation(input, withBucket(f, bucket))).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE' })
  await appendRevocation(input, f.context())
  expect(await scan(f.context())).toEqual([input])
  expect((await readRevocationHead(f.context())).sequence).toBe(1)
})
it('keeps an orphan event pending and refuses to initialize over lost retained state', async () => {
  const f = await fixture(), input = event()
  const context = { ...f.context(), checkpoint(stage: string) { if (stage === 'ledger.event.written') throw new Error('interrupted') } }
  await expect(appendRevocation(input, context)).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE' })
  await expect(readRevocation(input.intentId, f.context())).rejects.toMatchObject({ code: 'LEDGER_INCOMPLETE' })
  await expect(scan(f.context())).rejects.toMatchObject({ code: 'LEDGER_INCOMPLETE' })
  await f.bucket.delete('revocations/v1/head')
  await expect(initializeRevocationLedger(f.context())).rejects.toMatchObject({ code: 'LEDGER_NOT_READY' })
})
it('preserves every competing intent and one logical membership for simultaneous same-intent retry', async () => {
  const f = await fixture(), inputs = Array.from({ length: 6 }, event)
  const results = await Promise.allSettled([...inputs, inputs[0], inputs[0]].map(input => appendRevocation(input, f.context())))
  for (const [index, result] of results.entries()) if (result.status === 'rejected') {
    expect(result.reason).toMatchObject({ code: 'LEDGER_CONTENTION' })
    await appendRevocation([...inputs, inputs[0], inputs[0]][index], f.context())
  }
  expect((await scan(f.context())).map(e => e.intentId).sort()).toEqual(inputs.map(e => e.intentId).sort())
  expect((await readRevocationHead(f.context())).sequence).toBe(6)
})
it('rejects a stale actual R2 head CAS without losing the winning append', async () => {
  const f = await fixture(), first = event(), second = event()
  const before = await f.bucket.get('revocations/v1/head')
  const text = await before!.text()
  await appendRevocation(first, f.context())
  expect(await f.bucket.put('revocations/v1/head', text, { onlyIf: { etagMatches: before!.etag } })).toBeNull()
  await appendRevocation(second, f.context())
  expect((await scan(f.context())).map(e => e.intentId).sort()).toEqual([first.intentId, second.intentId].sort())
})
it('bounds real head CAS contention and resumes its already retained slot', async () => {
  const f = await fixture(), input = event()
  const stale = (await f.bucket.get('revocations/v1/head'))!.etag
  await appendRevocation(event(), f.context())
  const proxy = intercept(f.bucket, 'put', (...args) => {
    if (args[0] === 'revocations/v1/head') args[2] = { onlyIf: { etagMatches: stale } }
    return f.bucket.put(...args as Parameters<R2Bucket['put']>)
  })
  await expect(appendRevocation(input, withBucket(f, proxy))).rejects.toMatchObject({ code: 'LEDGER_CONTENTION' })
  await expect(readRevocation(input.intentId, f.context())).rejects.toMatchObject({ code: 'LEDGER_INCOMPLETE' })
  await appendRevocation(input, f.context())
  expect((await readRevocationHead(f.context())).sequence).toBe(2)
})
it('rejects missing bindings without exposing provider details or personal data', async () => {
  const f = await fixture(), events: unknown[] = []
  const context = createServiceContext(new Request('http://localhost'), {}, { now: () => 1, emit: e => events.push(e) })
  await expect(appendRevocation(event(), context)).rejects.toMatchObject({ code: 'LEDGER_NOT_READY' })
  expect(JSON.stringify(events)).toContain('LEDGER_NOT_READY')
  const input = { ...event(), email: 'private@example.com' }
  await expect(appendRevocation(input, f.context())).rejects.toMatchObject({ code: 'LEDGER_INVALID' })
  expect((await readRevocationHead(f.context())).sequence).toBe(0)
  expect(JSON.stringify(events)).not.toContain('private')
})
it.each(['events', 'index', 'head'])('rejects corrupt or truncated %s coverage', async family => {
  const f = await fixture(), input = event()
  await appendRevocation(input, f.context())
  const item = (await f.bucket.list()).objects.find(o => o.key.includes(`/${family}`))!
  await f.bucket.put(item.key, '{')
  await expect(readRevocation(input.intentId, f.context())).rejects.toMatchObject({ code: 'LEDGER_CORRUPT' })
  await expect(scan(f.context())).rejects.toMatchObject({ code: 'LEDGER_CORRUPT' })
})
it('rejects head regression against a retained baseline and unacknowledged trailing index', async () => {
  const f = await fixture()
  await appendRevocation(event(), f.context())
  const old = await (await f.bucket.get('revocations/v1/head'))!.text()
  await appendRevocation(event(), f.context())
  const floor = await readRevocationHead(f.context())
  await f.bucket.put('revocations/v1/head', old)
  await expect(readRevocationHead(f.context(), floor)).rejects.toMatchObject({ code: 'LEDGER_REGRESSED' })
  await expect(scan(f.context())).rejects.toMatchObject({ code: 'LEDGER_INCOMPLETE' })
})
it('paginates the real listing and refuses an omitted event despite readable index coverage', async () => {
  const f = await fixture(), inputs = Array.from({ length: 4 }, event)
  for (const input of inputs) await appendRevocation(input, f.context())
  const first = await verifyRevocationLedgerPage(f.context())
  expect(first.next).not.toBeNull()
  expect((await scan(f.context())).map(e => e.intentId).sort()).toEqual(inputs.map(e => e.intentId).sort())
  const proxy = intercept(f.bucket, 'list', async (...args) => {
    const result = await f.bucket.list(...args as Parameters<R2Bucket['list']>)
    if ((args[0] as { prefix?: string }).prefix !== 'revocations/v1/') return result
    return { ...result, objects: result.objects.filter(o => o.key !== `revocations/v1/events/${inputs[0].intentId}`) }
  })
  await expect(scan(withBucket(f, proxy))).rejects.toMatchObject({ code: 'LEDGER_INCOMPLETE' })
})
it('refuses continuation across a head change and missing predecessor coverage', async () => {
  const f = await fixture()
  for (let i = 0; i < 3; i++) await appendRevocation(event(), f.context())
  const first = await verifyRevocationLedgerPage(f.context())
  await appendRevocation(event(), f.context())
  await expect(verifyRevocationLedgerPage(f.context(), first.next!)).rejects.toMatchObject({ code: 'LEDGER_CHANGED' })
  await f.bucket.delete('revocations/v1/index/0000000000000002')
  await expect(scan(f.context())).rejects.toMatchObject({ code: 'LEDGER_INCOMPLETE' })
})
function liabilityPage(intentId: string, page = 0): ClosedLiabilityPage {
  const bytes = randomBytes(32); bytes[0] = 1; bytes[1] = 1
  return { version: 1, intentId, page, entries: [{ managedKey: `sync/${id()}`, markerIdentity: bytes.toString('base64url'), markerDigest: createHash('sha256').update(bytes).digest('base64url'), retainedBytes: 32, closed: true, payloadReleased: true }] }
}
it('binds account deletion to exact separate pages, rejects missing pages and changed association replay', async () => {
  const f = await fixture(), input: RevocationEvent = { version: 1, kind: 'account-deleted', accountId: id(), intentId: id(), sessionEpoch: 2, timestamp: 1700000000000 }
  await expect(appendRevocation(input, f.context())).rejects.toMatchObject({ code: 'LEDGER_INCOMPLETE' })
  const pages = [liabilityPage(input.intentId), liabilityPage(input.intentId, 1)]
  await prepareRevocationLiabilities(input.intentId, pages, f.context())
  await appendRevocation(input, f.context())
  expect(await scan(f.context())).toEqual([input])
  expect(await readRevocationLiabilities(input.intentId, f.context())).toEqual(pages)
  await expect(prepareRevocationLiabilities(input.intentId, [pages[0]], f.context())).rejects.toMatchObject({ code: 'LEDGER_INTENT_MISMATCH' })
  await f.bucket.delete(`revocations/v1/manifests/${input.intentId}/0000`)
  await expect(readRevocation(input.intentId, f.context())).rejects.toMatchObject({ code: 'LEDGER_INCOMPLETE' })
  await expect(appendRevocation(input, f.context())).rejects.toMatchObject({ code: 'LEDGER_INCOMPLETE' })
})
it('rejects oversized, noncontiguous and invalid-marker liability evidence', async () => {
  const f = await fixture(), intent = id()
  await expect(prepareRevocationLiabilities(intent, Array.from({ length: 33 }, (_, page) => liabilityPage(intent, page)), f.context())).rejects.toMatchObject({ code: 'LEDGER_INVALID' })
  await expect(prepareRevocationLiabilities(intent, [liabilityPage(intent, 1)], f.context())).rejects.toMatchObject({ code: 'LEDGER_INVALID' })
  const page = liabilityPage(intent)
  page.entries[0].markerDigest = randomBytes(32).toString('base64url')
  await expect(prepareRevocationLiabilities(intent, [page], f.context())).rejects.toMatchObject({ code: 'LEDGER_CORRUPT' })
  expect((await f.bucket.list({ prefix: `revocations/v1/manifests/${intent}/` })).objects).toEqual([])
})

it('lets another writer finish an interrupted index winner and rejects its delayed stale head overwrite', async () => {
  const f = await fixture(), first = event(), second = event()
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>(resolve => { entered = resolve })
  const resumed = new Promise<void>(resolve => { release = resolve })
  let held = false
  const proxy = intercept(f.bucket, 'put', async (...args) => {
    if (args[0] === 'revocations/v1/head' && !held) { held = true; entered(); await resumed }
    return f.bucket.put(...args as Parameters<R2Bucket['put']>)
  })
  const pending = appendRevocation(first, withBucket(f, proxy))
  await blocked
  try {
    await appendRevocation(second, f.context())
    expect((await readRevocationHead(f.context())).sequence).toBe(2)
  } finally { release() }
  await pending
  expect((await scan(f.context())).map(e => e.intentId).sort()).toEqual([first.intentId, second.intentId].sort())
})
it('rejects a truncated listing that falsely reports the end or repeats its cursor', async () => {
  const f = await fixture()
  for (let i = 0; i < 4; i++) await appendRevocation(event(), f.context())
  const truncated = intercept(f.bucket, 'list', async (...args) => {
    const result = await f.bucket.list(...args as Parameters<R2Bucket['list']>)
    return { ...result, truncated: false }
  })
  await expect(scan(withBucket(f, truncated))).rejects.toMatchObject({ code: 'LEDGER_INCOMPLETE' })
  const repeated = intercept(f.bucket, 'list', async (...args) => {
    const result = await f.bucket.list(...args as Parameters<R2Bucket['list']>)
    return { ...result, truncated: true, cursor: (args[0] as { cursor?: string }).cursor ?? (result.truncated ? result.cursor : 'unused') }
  })
  const first = await verifyRevocationLedgerPage(withBucket(f, repeated))
  await expect(verifyRevocationLedgerPage(withBucket(f, repeated), first.next!)).rejects.toMatchObject({ code: 'LEDGER_INCOMPLETE' })
})
it('does not acknowledge a lost liability page write until exact fresh-context completion', async () => {
  const f = await fixture(), intent = id(), pages = [liabilityPage(intent), liabilityPage(intent, 1)]
  let lost = false
  const proxy = intercept(f.bucket, 'put', async (...args) => {
    const result = await f.bucket.put(...args as Parameters<R2Bucket['put']>)
    if (!lost && String(args[0]).endsWith('/0000')) { lost = true; throw new Error('uncertain page response') }
    return result
  })
  const input: RevocationEvent = { version: 1, kind: 'account-deleted', intentId: intent, accountId: id(), sessionEpoch: 1, timestamp: 1700000000000 }
  await expect(prepareRevocationLiabilities(intent, pages, withBucket(f, proxy))).rejects.toMatchObject({ code: 'LEDGER_UNAVAILABLE' })
  await expect(appendRevocation(input, f.context())).rejects.toMatchObject({ code: 'LEDGER_INCOMPLETE' })
  await prepareRevocationLiabilities(intent, pages, f.context())
  await appendRevocation(input, f.context())
  expect(await readRevocationLiabilities(intent, f.context())).toEqual(pages)
  const pageKey = `revocations/v1/manifests/${intent}/0000`
  const text = await (await f.bucket.get(pageKey))!.text()
  await f.bucket.put(pageKey, text.slice(0, -1))
  await expect(appendRevocation(input, f.context())).rejects.toMatchObject({ code: 'LEDGER_CORRUPT' })
})
it('retains an explicit empty account manifest and rejects extra fields or duplicate managed keys', async () => {
  const f = await fixture(), intent = id()
  const input: RevocationEvent = { version: 1, kind: 'account-deleted', intentId: intent, accountId: id(), sessionEpoch: 0, timestamp: 1700000000000 }
  await prepareRevocationLiabilities(intent, [], f.context())
  await appendRevocation(input, f.context())
  expect(await readRevocationLiabilities(intent, f.context())).toEqual([])
  const second = id(), page = liabilityPage(second)
  await expect(prepareRevocationLiabilities(second, [{ ...page, filename: 'private' } as ClosedLiabilityPage], f.context())).rejects.toMatchObject({ code: 'LEDGER_INVALID' })
  await expect(prepareRevocationLiabilities(second, [page, { ...page, page: 1 }], f.context())).rejects.toMatchObject({ code: 'LEDGER_CORRUPT' })
})
it('accepts the bounded complete liability envelope without expanding RevocationEvent', async () => {
  const f = await fixture(), intent = id()
  const pages = Array.from({ length: 32 }, (_, page) => ({ ...liabilityPage(intent, page), entries: Array.from({ length: 32 }, () => liabilityPage(intent).entries[0]) }))
  const input: RevocationEvent = { version: 1, kind: 'account-deleted', intentId: intent, accountId: id(), sessionEpoch: 0, timestamp: 1700000000000 }
  await prepareRevocationLiabilities(intent, pages, f.context())
  await appendRevocation(input, f.context())
  expect(await readRevocation(input.intentId, f.context())).toEqual(input)
  expect(await readRevocationLiabilities(intent, f.context())).toEqual(pages)
})
it('does not acknowledge an append whose exact event is absent from discovery', async () => {
  const f = await fixture(), input = event()
  const proxy = intercept(f.bucket, 'list', async (...args) => {
    const result = await f.bucket.list(...args as Parameters<R2Bucket['list']>)
    return { ...result, objects: result.objects.filter(o => o.key !== `revocations/v1/events/${input.intentId}`) }
  })
  await expect(appendRevocation(input, withBucket(f, proxy))).rejects.toMatchObject({ code: 'LEDGER_INCOMPLETE' })
  await appendRevocation(input, f.context())
  expect(await readRevocation(input.intentId, f.context())).toEqual(input)
})
