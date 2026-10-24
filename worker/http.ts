import type { z } from 'zod'
import { apiErrorStatuses, type ApiErrorCode, type CommitContinuation } from '../src/account/protocol'

export class ApiFailure extends Error {
  constructor(readonly code: ApiErrorCode, readonly retryAfterSeconds?: number, readonly continuation?: CommitContinuation) { super(code) }
}
export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
}
export function errorResponse(error: unknown, requestId: string): Response {
  const failure = error instanceof ApiFailure ? error : new ApiFailure('SERVICE_UNAVAILABLE')
  const response = jsonResponse({ error: { code: failure.code, requestId, ...(failure.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: failure.retryAfterSeconds }), ...(failure.continuation ? { continuation: failure.continuation } : {}) } }, apiErrorStatuses[failure.code])
  // Edge-compatible clients can retain a support reference without trusting or parsing an error body
  response.headers.set('x-crykit-request-id', requestId)
  if (failure.retryAfterSeconds !== undefined) response.headers.set('retry-after', String(failure.retryAfterSeconds))
  return response
}
export async function readJson<T>(request: Request, schema: z.ZodType<T>, maxBytes: number): Promise<T> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new ApiFailure('INVALID_REQUEST')
  const length = request.headers.get('content-length')
  if (length && !/^\d+$/.test(length)) throw new ApiFailure('INVALID_REQUEST')
  if (length && Number(length) > maxBytes) throw new ApiFailure('PAYLOAD_TOO_LARGE')
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || !request.body) throw new ApiFailure('INVALID_REQUEST')
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      // Enforce the bound while streaming; Content-Length is only an early rejection hint
      if (size > maxBytes) {
        // Cancellation cleanup must not replace the size violation with an unrelated stream error
        await reader.cancel().catch(() => {})
        throw new ApiFailure('PAYLOAD_TOO_LARGE')
      }
      parts.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) } catch { throw new ApiFailure('INVALID_REQUEST') }
  if (value && typeof value === 'object' && 'version' in value && value.version !== 1) throw new ApiFailure('UNSUPPORTED_VERSION')
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  return parsed.data
}
