import { CommitContinuationSchema, CommitRequestSchema, type CommitContinuation } from '../protocol'
import { SyncError } from './client'

export class CommitProgress extends SyncError {
  constructor(retryAfterMs: number) { super('SERVICE_UNAVAILABLE', retryAfterMs); this.message = 'COMMIT_CONTINUING' }
}
export async function commitRequestDigest(request: string): Promise<string> {
  // Match the accepted server idempotency digest without changing the exact saved/replayed request
  const canonical = JSON.stringify(CommitRequestSchema.parse(JSON.parse(request)))
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
export async function checkCommitProgress(request: string, previous: CommitContinuation | undefined, input: unknown, now: number): Promise<boolean> {
  const parsed = CommitContinuationSchema.safeParse(input)
  if (!parsed.success) throw new SyncError('INTEGRITY_FAILED')
  const next = parsed.data
  if (next.mutationId !== JSON.parse(request).mutationId || next.requestDigest !== await commitRequestDigest(request)) throw new SyncError('INTEGRITY_FAILED')
  if (previous && previous.workId === next.workId && previous.expiresAt !== next.expiresAt) throw new SyncError('INTEGRITY_FAILED')
  // A new server incarnation cannot restart an already-observed command's automatic progress allowance
  return next.expiresAt > now && next.processed > (previous?.processed ?? 0) && (!previous || previous.workId === next.workId)
}
