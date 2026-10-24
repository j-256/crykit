import type { z } from 'zod'
import { serviceNoticeRequest } from './service-notice'
import { ApiErrorSchema, OpaqueIdSchema } from './protocol'
import { onProfileSessionChange, profileSignal, ProfileSessionChangedError, withProfileSession, type ProfileToken } from './profile'
import { PublishedShareSchema, PublicShareSchema, OwnSharesSchema, PublishSnapshotSchema, UpdateSnapshotSchema, StopSharingSchema, shareRequestBytes, shareListLimit, type PublishSnapshot, type UpdateSnapshot, type StopSharing } from './shares-protocol'

const requestTimeoutMs = 30_000
async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  if (!response.body) throw new Error('INTEGRITY_FAILED')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) throw new Error('INTEGRITY_FAILED')
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } finally { await reader.cancel(); reader.releaseLock() }
}
async function responseValue<T>(response: Response, schema: z.ZodType<T>, maximum: number, notice: ReturnType<typeof serviceNoticeRequest>): Promise<T> {
  if (response.status === 429) {
    // An edge response contains no accepted snapshot and can use an unrelated body format
    void response.body?.cancel().catch(() => {})
    throw notice.failure(response, 'RATE_LIMITED')
  }
  const value = await boundedJson(response, response.ok ? maximum : 4096)
  if (!response.ok) { const error = ApiErrorSchema.parse(value).error; throw notice.failure(response, error.code, error.requestId, error.retryAfterSeconds) }
  notice.succeeded()
  return schema.parse(value)
}
async function request<T>(token: ProfileToken, path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown, maximum = shareRequestBytes, cancellation?: AbortSignal): Promise<T> {
  const changed = new AbortController()
  const signal = AbortSignal.any([profileSignal(token), changed.signal, AbortSignal.timeout(requestTimeoutMs), ...(cancellation ? [cancellation] : [])])
  const notice = serviceNoticeRequest(`shares:${method}:${path}`, signal)
  const stop = onProfileSessionChange(token, () => changed.abort(new ProfileSessionChangedError()))
  try {
    return await withProfileSession(token, async session => {
      signal.throwIfAborted()
      const response = await fetch(`/api/v1/shares${path}`, { method, signal, cache: 'no-store', credentials: 'same-origin', headers: body ? { 'content-type': 'application/json', 'x-csrf-token': session.csrf } : {}, ...(body ? { body: JSON.stringify(body) } : {}) })
      signal.throwIfAborted()
      const value = await responseValue(response, schema, maximum, notice)
      signal.throwIfAborted()
      return value
    })
  } finally { stop() }
}
// No private source identity is sent or inferred; the owner explicitly chooses the hosted link
export const publishSnapshot = (token: ProfileToken, input: PublishSnapshot, signal?: AbortSignal) => request(token, '', PublishedShareSchema, 'POST', PublishSnapshotSchema.parse(input), undefined, signal)
export const updatePublishedSnapshot = (token: ProfileToken, shareId: string, input: UpdateSnapshot, signal?: AbortSignal) => request(token, `/${OpaqueIdSchema.parse(shareId)}`, PublishedShareSchema, 'PATCH', UpdateSnapshotSchema.parse(input), undefined, signal)
export const stopSharing = (token: ProfileToken, shareId: string, input: StopSharing, signal?: AbortSignal) => request(token, `/${OpaqueIdSchema.parse(shareId)}`, PublishedShareSchema, 'DELETE', StopSharingSchema.parse(input), undefined, signal)
export const listPublishedSnapshots = (token: ProfileToken, after?: string, signal?: AbortSignal) => request(token, after ? `?after=${OpaqueIdSchema.parse(after)}` : '', OwnSharesSchema, 'GET', undefined, shareListLimit * 8192, signal)
export async function readPublishedSnapshot(shareId: string, cancellation: AbortSignal) {
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(requestTimeoutMs)])
  const notice = serviceNoticeRequest(`public-share:${shareId}`, signal)
  const response = await fetch(`/api/public/v1/shares/${OpaqueIdSchema.parse(shareId)}`, { signal, credentials: 'omit', cache: 'no-store' })
  signal.throwIfAborted()
  const result = await responseValue(response, PublicShareSchema, shareRequestBytes, notice)
  signal.throwIfAborted()
  return result
}
