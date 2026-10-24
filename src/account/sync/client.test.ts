import { afterEach, expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile, setProfileSession, profileAccess } from '../profile'
import { SyncClient, SyncError } from './client'

const accountId = 'AAAAAAAAAAAAAAAAAAAAAA'
const session = { accountId, username: 'synthetic', sessionId: 'BBBBBBBBBBBBBBBBBBBBBA', deviceId: 'CCCCCCCCCCCCCCCCCCCCCA', csrf: 'synthetic', authenticatedAt: 1 }
afterEach(() => { invalidateProfile(); vi.restoreAllMocks() })
it('backsOffAfterAnEdgeRateLimitWithoutTreatingItsHtmlAsCorruptAccountData', async () => {
  const token = installProfile(accountId, new Uint8Array(32), session)
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>Too many requests</html>', { status: 429, headers: { 'retry-after': '10' } }))
  await expect(new SyncClient(token, new AbortController().signal).changes(null)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 10_000 })
  expect(profileAccess(token)).toBe('connected')
})
it('retainsSyncRateLimitReferencesForSupport', async () => {
  const token = installProfile(accountId, new Uint8Array(32), session)
  const requestId = 'd679dff4-91ad-4e87-951a-d5198a772870'
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>Too many requests</html>', { status: 429, headers: { 'retry-after': '60', 'x-crykit-request-id': requestId } }))
  await expect(new SyncClient(token, new AbortController().signal).changes(null)).rejects.toMatchObject({ code: 'RATE_LIMITED', requestId, retryAfterMs: 60_000 })
})
it('reportsABodylessEdgeRateLimitWithoutCallingAccountDataCorrupt', async () => {
  const token = installProfile(accountId, new Uint8Array(32), session)
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 429, headers: { 'retry-after': '30', 'x-crykit-request-id': 'synthetic-support' } }))
  await expect(new SyncClient(token, new AbortController().signal).changes(null)).rejects.toMatchObject({ code: 'RATE_LIMITED', requestId: 'synthetic-support', retryAfterMs: 30_000 })
})
it('boundsAndValidatesUntrustedPullResponses', async () => {
  const token = installProfile(accountId, new Uint8Array(32), session)
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ version: 2 })))
  await expect(new SyncClient(token, new AbortController().signal).changes(null)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
  expect(fetch).toHaveBeenCalledWith('/api/v1/sync/changes', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }))
  await expect(new SyncClient(token, new AbortController().signal).changes(null, 101)).rejects.toThrow()
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('retainsRetryAfterAndNeverPublishesAStaleSessionResult', async () => {
  const token = installProfile(accountId, new Uint8Array(32), session)
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', requestId: 'synthetic', retryAfterSeconds: 4 } }), { status: 429, headers: { 'retry-after': '7' } }))
  await expect(new SyncClient(token, new AbortController().signal).changes(null)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 7000 })
  let finish!: (response: Response) => void
  vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const pending = new SyncClient(token, new AbortController().signal).changes(null)
  setProfileSession(token, { ...session, sessionId: 'DDDDDDDDDDDDDDDDDDDDDA' })
  finish(new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED', requestId: 'synthetic' } }), { status: 401 }))
  await expect(pending).rejects.toThrow('PROFILE_SESSION_CHANGED')
  expect(profileAccess(token)).toBe('connected')
})
it('rejectsOversizedStreamBeforeMaterializingIt', async () => {
  const token = installProfile(accountId, new Uint8Array(32), session)
  let cancelled = false
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) }, cancel() { cancelled = true } })))
  await expect(new SyncClient(token, new AbortController().signal).receipt(accountId)).rejects.toBeInstanceOf(SyncError)
  expect(cancelled).toBe(true)
})
it('strictContinuationIsAcceptedOnlyOnCommitUnavailableResponses', async () => {
  const token = installProfile(accountId, new Uint8Array(32), session)
  const client = new SyncClient(token, new AbortController().signal)
  const continuation = { mutationId: accountId, requestDigest: 'A'.repeat(43), workId: session.sessionId, expiresAt: 10000, processed: 48 }
  const response = (code: string, evidence: unknown) => new Response(JSON.stringify({ error: { code, requestId: 'synthetic', retryAfterSeconds: 1, continuation: evidence } }), { status: 503 })
  const mock = vi.spyOn(globalThis, 'fetch')
  mock.mockResolvedValueOnce(response('SERVICE_UNAVAILABLE', continuation))
  await expect(client.commit({ version: 1, mutationId: accountId, revisions: [], heads: [{ documentId: accountId, revisionId: session.sessionId }], expected: [{ documentId: accountId, revisionId: null }] })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', continuation, retryAfterMs: 1000 })
  for (const [code, evidence] of [['SERVICE_UNAVAILABLE', { ...continuation, extra: true }], ['QUOTA_EXCEEDED', continuation]] as const) {
    mock.mockResolvedValueOnce(response(code, evidence))
    await expect(client.commit({ version: 1, mutationId: accountId, revisions: [], heads: [{ documentId: accountId, revisionId: session.sessionId }], expected: [{ documentId: accountId, revisionId: null }] })).rejects.toThrow('INTEGRITY_FAILED')
  }
  mock.mockResolvedValueOnce(response('SERVICE_UNAVAILABLE', continuation))
  await expect(client.receipt(accountId)).rejects.toThrow('INTEGRITY_FAILED')
})

const documentId = session.deviceId
const transition = { version: 1, kind: 'mutation-transition', accountId, mutationId: accountId, requestDigest: 'A'.repeat(43), receipt: { version: 1, mutationId: accountId, sequence: 1, publicationEpoch: 1, heads: [] }, previousPublicationEpoch: 0, documents: [{ documentId, before: null, after: null }, { documentId: accountId, before: null, after: null }] }
it('associates transition account, mutation and ordered complete coverage', async () => {
  const token = installProfile(accountId, new Uint8Array(32), session)
  const client = new SyncClient(token, new AbortController().signal)
  const mock = vi.spyOn(globalThis, 'fetch')
  for (const patch of [{ accountId: documentId }, { mutationId: documentId, receipt: { ...transition.receipt, mutationId: documentId } }, { documents: [...transition.documents].reverse() }, { documents: transition.documents.slice(1) }, { documents: [...transition.documents, transition.documents[0]] }, { extra: true }, { version: 2 }]) {
    mock.mockResolvedValueOnce(new Response(JSON.stringify({ ...transition, ...patch })))
    await expect(client.mutationTransition(accountId, [documentId, accountId])).rejects.toThrow('INTEGRITY_FAILED')
  }
  mock.mockResolvedValueOnce(new Response(JSON.stringify(transition)))
  await expect(client.mutationTransition(accountId, [documentId, accountId])).resolves.toEqual(transition)
  expect(mock).toHaveBeenLastCalledWith(`/api/v1/sync/mutations/${accountId}/transition?document=${documentId}&document=${accountId}`, expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }))
  for (const reason of ['unknown-mutation', 'history-unavailable']) {
    const response = { version: 1, kind: 'mutation-transition-unavailable', mutationId: accountId, reason }
    mock.mockResolvedValueOnce(new Response(JSON.stringify(response)))
    await expect(client.mutationTransition(accountId, [documentId])).resolves.toEqual(response)
    mock.mockResolvedValueOnce(new Response(JSON.stringify({ ...response, mutationId: documentId })))
    await expect(client.mutationTransition(accountId, [documentId])).rejects.toThrow('INTEGRITY_FAILED')
  }
  const count = mock.mock.calls.length
  for (const ids of [[], [documentId, documentId], ['bad'], Array(33).fill(documentId)]) await expect(client.mutationTransition(accountId, ids)).rejects.toThrow()
  await expect(client.mutationTransition('bad', [documentId])).rejects.toThrow()
  expect(mock).toHaveBeenCalledTimes(count)
})
it('bounds transition streaming, permits exact byte budget and rejects cold offline', async () => {
  const token = installProfile(accountId, new Uint8Array(32), session)
  const client = new SyncClient(token, new AbortController().signal)
  const mock = vi.spyOn(globalThis, 'fetch')
  const body = JSON.stringify(transition)
  mock.mockResolvedValueOnce(new Response(body.padEnd(8192)))
  await expect(client.mutationTransition(accountId, [documentId, accountId])).resolves.toEqual(transition)
  let cancelled = false
  mock.mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(8193)) }, cancel() { cancelled = true } })))
  await expect(client.mutationTransition(accountId, [documentId])).rejects.toThrow('INTEGRITY_FAILED')
  expect(cancelled).toBe(true)
  mock.mockRejectedValueOnce(new TypeError('offline'))
  await expect(client.mutationTransition(accountId, [documentId])).rejects.toThrow('offline')
})
it.each(['renew', 'switch', 'abort'] as const)('fences %s during transition streaming and after transport parsing', async mode => {
  for (const phase of ['stream', 'parse']) {
    const token = installProfile(accountId, new Uint8Array(32), session)
    const controller = new AbortController()
    const change = () => { if (mode === 'renew') setProfileSession(token, { ...session }); else if (mode === 'switch') invalidateProfile(); else controller.abort(new Error('caller aborted')) }
    const body = JSON.stringify(transition)
    const mock = vi.spyOn(globalThis, 'fetch')
    if (phase === 'stream') mock.mockResolvedValueOnce(new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode(body)) }, pull(stream) { change(); stream.close() } })))
    else {
      mock.mockResolvedValueOnce(new Response(body))
      const parse = JSON.parse
      vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => { const result = parse(text, reviver); if (text === body) change(); return result })
    }
    await expect(new SyncClient(token, controller.signal).mutationTransition(accountId, [documentId, accountId])).rejects.toThrow(mode === 'renew' ? 'PROFILE_SESSION_CHANGED' : mode === 'switch' ? 'PROFILE_CHANGED' : 'caller aborted')
    vi.restoreAllMocks()
    invalidateProfile()
  }
})
it('rejects renewal in the final return continuation after the outer session check', async () => {
  const token = installProfile(accountId, new Uint8Array(32), session)
  const body = JSON.stringify(transition), parse = JSON.parse
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(body))
  vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
    const result = parse(text, reviver)
    if (text === body) queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => setProfileSession(token, { ...session })))))
    return result
  })
  await expect(new SyncClient(token, new AbortController().signal).mutationTransition(accountId, [documentId, accountId])).rejects.toThrow('PROFILE_SESSION_CHANGED')
})
it('distinguishes structured remote upload failure from malformed local response evidence', async () => {
  const token = installProfile(accountId, new Uint8Array(32), session), client = new SyncClient(token, new AbortController().signal)
  const mock = vi.spyOn(globalThis, 'fetch')
  mock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'INTEGRITY_FAILED', requestId: 'synthetic' } }), { status: 409 }))
  await expect(client.finishUpload(accountId)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED', remoteResponse: true })
  for (const response of [new Response('{', { status: 409 }), new Response(JSON.stringify({ error: { code: 'INTEGRITY_FAILED' } }), { status: 409 }), new Response(JSON.stringify({ version: 2 }))]) {
    mock.mockResolvedValueOnce(response)
    await expect(client.finishUpload(accountId)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED', remoteResponse: false })
  }
})
