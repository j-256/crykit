import { CleanupPreviewSchema, CleanupResultSchema, type CleanupRequest } from '../storage-protocol'
import { z } from 'zod'
import { serviceNoticeRequest } from '../service-notice'
import { onProfileSessionChange, ProfileSessionChangedError, profileSignal, withProfileSession, type ProfileToken } from '../profile'
import { MutationTransitionDocumentsSchema, MutationTransitionResponseSchema, maxMutationTransitionResponseBytes, type MutationTransitionResponse, ApiErrorSchema, ChangePageSchema, CommitReceiptSchema, CommitRequestSchema, OpaqueIdSchema, RevisionDescriptorSchema, UploadReadySchema, UploadStartSchema, maxChangePageRevisions, maxChunks, maxCommitJsonBytes, maxCursorBytes, plainChunkBytes, streamOverheadBytes, type ChangePage, type CommitReceipt, type CommitRequest, type RevisionDescriptor, type UploadReady, type UploadStart } from '../protocol'

export const SYNC_REQUEST_TIMEOUT_MS = 30_000
const MAX_CHANGE_RESPONSE_BYTES = maxChangePageRevisions * maxCommitJsonBytes
const MAX_CHUNK_BYTES = plainChunkBytes + streamOverheadBytes
const utf8 = new TextEncoder()
const EDGE_RATE_LIMIT_RETRY_MS = 10_000
export class SyncError extends Error {
  constructor(readonly code: string, readonly retryAfterMs = 0, readonly continuation?: import('../protocol').CommitContinuation, readonly remoteResponse = false, readonly requestId?: string) { super(code) }
}
async function boundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.body) throw new SyncError('INTEGRITY_FAILED')
  const reader = response.body.getReader(), parts: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maximum) throw new SyncError('INTEGRITY_FAILED')
      parts.push(next.value)
    }
    const result = new Uint8Array(length)
    let offset = 0
    for (const part of parts) { result.set(part, offset); offset += part.length }
    return result
  } finally { await reader.cancel(); reader.releaseLock() }
}
function indexPath(index: number): number { return z.number().int().min(0).max(maxChunks - 1).parse(index) }
function retryAfter(response: Response): number {
  const value = response.headers.get('retry-after')
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0
}

// Each request captures current session authority through body settlement; renewal alone changes that fence
export class SyncClient {
  constructor(private readonly token: ProfileToken, private readonly signal: AbortSignal) {}
  private async request(path: string, method = 'GET', body?: string | Uint8Array, maximum = maxCommitJsonBytes): Promise<Uint8Array> {
    const signal = AbortSignal.any([this.signal, profileSignal(this.token), AbortSignal.timeout(SYNC_REQUEST_TIMEOUT_MS)])
    const notice = serviceNoticeRequest(`sync:${method}:${path}`, signal)
    signal.throwIfAborted()
    return withProfileSession(this.token, async session => {
      const response = await fetch(`/api/v1/sync/${path}`, { method, signal, credentials: 'same-origin', cache: 'no-store', headers: { ...(body === undefined ? {} : { 'content-type': typeof body === 'string' ? 'application/json' : 'application/octet-stream' }), ...(method === 'GET' ? {} : { 'x-csrf-token': session.csrf }) }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : new Uint8Array(body) }) })
      signal.throwIfAborted()
      // A proxy can reject without a body; the HTTP status still establishes rate limiting
      const bytes = response.status === 429 && !response.body ? new Uint8Array() : await boundedBody(response, response.ok ? maximum : maxCommitJsonBytes)
      signal.throwIfAborted()
      if (!response.ok) {
        let value: z.infer<typeof ApiErrorSchema>
        try { value = ApiErrorSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) }
        catch {
          // Edge rejection happens before CryKit and can return HTML or a different JSON body
          // Keep its retry floor without treating private stored content as corrupt
          if (response.status === 429) {
            const error = notice.failure(response, 'RATE_LIMITED')
            throw new SyncError('RATE_LIMITED', retryAfter(response) || EDGE_RATE_LIMIT_RETRY_MS, undefined, true, error.requestId)
          }
          throw new SyncError('INTEGRITY_FAILED')
        }
        if (value.error.continuation && (path !== 'commits' || method !== 'POST')) throw new SyncError('INTEGRITY_FAILED')
        const error = notice.failure(response, value.error.code, value.error.requestId, value.error.retryAfterSeconds)
        throw new SyncError(value.error.code, Math.max(retryAfter(response), (value.error.retryAfterSeconds ?? 0) * 1000), value.error.continuation, true, error.requestId)
      }
      notice.succeeded()
      return bytes
    })
  }
  private async json<T>(path: string, schema: z.ZodType<T>, method = 'GET', input?: unknown, maximum = maxCommitJsonBytes): Promise<T> {
    const body = input === undefined ? undefined : JSON.stringify(input)
    if (body && utf8.encode(body).length > maxCommitJsonBytes) throw new SyncError('PAYLOAD_TOO_LARGE')
    const bytes = await this.request(path, method, body, maximum)
    try { return schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) }
    catch { throw new SyncError('INTEGRITY_FAILED') }
  }
  previewCleanup(ref: import('../../persistence/account-database').CipherRef) { return this.json('cleanup/preview', CleanupPreviewSchema, 'POST', { version: 1, ref }) }
  cleanup(input: CleanupRequest) { return this.json('cleanup', CleanupResultSchema, 'POST', input) }
  startUpload(input: UploadStart): Promise<UploadReady> { UploadStartSchema.parse(input); return this.json('uploads', UploadReadySchema, 'POST', input) }
  async putChunk(uploadId: string, index: number, bytes: Uint8Array): Promise<void> {
    OpaqueIdSchema.parse(uploadId); indexPath(index)
    if (bytes.length < streamOverheadBytes || bytes.length > MAX_CHUNK_BYTES) throw new SyncError('PAYLOAD_TOO_LARGE')
    const response = await this.request(`uploads/${uploadId}/chunks/${index}`, 'PUT', bytes)
    try { z.strictObject({ version: z.literal(1), uploadId: z.literal(uploadId), index: z.literal(index) }).parse(JSON.parse(new TextDecoder().decode(response))) }
    catch { throw new SyncError('INTEGRITY_FAILED') }
  }
  finishUpload(uploadId: string): Promise<UploadReady> { return this.json(`uploads/${OpaqueIdSchema.parse(uploadId)}/finish`, UploadReadySchema, 'POST', { version: 1 }) }
  commit(input: CommitRequest): Promise<CommitReceipt> { CommitRequestSchema.parse(input); return this.json('commits', CommitReceiptSchema, 'POST', input) }
  async receipt(mutationId: string): Promise<CommitReceipt | null> {
    const value = await this.json(`mutations/${OpaqueIdSchema.parse(mutationId)}`, z.union([CommitReceiptSchema, z.strictObject({ unknown: z.literal(true) })]))
    return 'unknown' in value ? null : value
  }
  async mutationTransition(mutationId: string, documentIds: readonly string[]): Promise<MutationTransitionResponse> {
    OpaqueIdSchema.parse(mutationId)
    const documents = MutationTransitionDocumentsSchema.parse(documentIds)
    const query = new URLSearchParams(documents.map(id => ['document', id]))
    const signal = AbortSignal.any([this.signal, profileSignal(this.token)])
    // Renewal keeps the profile token, and can also occur between the outer fence and final return
    let sessionChanged = false
    const stop = onProfileSessionChange(this.token, () => { sessionChanged = true })
    try {
      // The transport fence ends before JSON parsing; retain exact session identity through association
      const result = await withProfileSession(this.token, async () => {
        const value = await this.json(`mutations/${mutationId}/transition?${query}`, MutationTransitionResponseSchema, 'GET', undefined, maxMutationTransitionResponseBytes)
        if (value.mutationId !== mutationId || (value.kind === 'mutation-transition' && (value.accountId !== this.token.accountId
          || value.documents.length !== documents.length || value.documents.some((row, index) => row.documentId !== documents[index])))) throw new SyncError('INTEGRITY_FAILED')
        signal.throwIfAborted()
        return value
      })
      signal.throwIfAborted()
      if (sessionChanged) throw new ProfileSessionChangedError()
      return result
    } finally { stop() }
  }
  async changes(cursor: string | null, limit?: number): Promise<ChangePage> {
    const query = new URLSearchParams()
    if (cursor !== null) { if (utf8.encode(cursor).length > maxCursorBytes) return Promise.reject(new SyncError('INVALID_REQUEST')); query.set('cursor', cursor) }
    if (limit !== undefined) query.set('limit', String(z.number().int().min(1).max(maxChangePageRevisions).parse(limit)))
    return this.json(`changes${query.size ? `?${query}` : ''}`, ChangePageSchema, 'GET', undefined, MAX_CHANGE_RESPONSE_BYTES)
  }
  revision(revisionId: string): Promise<RevisionDescriptor> { return this.json(`revisions/${OpaqueIdSchema.parse(revisionId)}`, RevisionDescriptorSchema) }
  chunk(revisionId: string, index: number): Promise<Uint8Array> { return this.request(`revisions/${OpaqueIdSchema.parse(revisionId)}/chunks/${indexPath(index)}`, 'GET', undefined, MAX_CHUNK_BYTES) }
}
