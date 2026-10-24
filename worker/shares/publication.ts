import { PublishedShareSchema, PublishSnapshotSchema, UpdateSnapshotSchema, StopSharingSchema, shareListLimit, type PublishSnapshot, type UpdateSnapshot, type StopSharing, type PublishedShare } from '../../src/account/shares-protocol'
import { validatePublicSnapshot } from '../../src/interchange/public-share-schema'
import { randomId } from '../auth/identity'
import { assertCustomerWrite, type CustomerPrincipal } from '../auth/session'
import type { ServiceContext } from '../context'
import { ApiFailure } from '../http'
import { appendRevocation, RevocationEventSchema } from '../jobs/ledger'
import { authority, digest, encoder, syncBatch } from '../sync/storage'

interface Mutation { digest: string; share_id: string; kind: string; event: string | null; receipt: string | null }
export const publicUsernameSql = 'CASE WHEN a.username_withheld = 0 THEN a.username ELSE NULL END'
const shareUrl = (id: string, context: ServiceContext) => `${context.env.SERVICE_ORIGIN}/#/s/${id}`
function receipt(shareId: string, revision: number, active: boolean, context: ServiceContext): PublishedShare { return { shareId, revision, active, url: shareUrl(shareId, context) } }
async function live(principal: CustomerPrincipal, context: ServiceContext, write: boolean) {
  const guard = authority(principal, context, write, 'publish')
  if (!await context.env.DB!.prepare(guard.sql).bind(...guard.bindings).first()) throw new ApiFailure(write ? 'FORBIDDEN' : 'AUTH_REQUIRED')
}
async function previous(principal: CustomerPrincipal, mutationId: string, hash: string, context: ServiceContext): Promise<Mutation | null> {
  const prior = await context.env.DB!.prepare('SELECT digest,share_id,kind,event,receipt FROM share_mutations WHERE account_id = ? AND mutation_id = ?').bind(principal.accountId, mutationId).first<Mutation>()
  if (prior && prior.digest !== hash) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
  return prior
}
const commandDigest = (kind: string, shareId: string | null, input: unknown) => digest(encoder.encode(JSON.stringify([kind, shareId, input])))

export async function publishSnapshot(principal: CustomerPrincipal, input: PublishSnapshot | UpdateSnapshot, context: ServiceContext, shareId?: string): Promise<PublishedShare> {
  const parsed = shareId ? UpdateSnapshotSchema.safeParse(input) : PublishSnapshotSchema.safeParse(input)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  input = parsed.data
  await assertCustomerWrite(principal, 'publish', context)
  const kind = shareId ? 'update' : 'publish', hash = await commandDigest(kind, shareId ?? null, input)
  const prior = await previous(principal, input.mutationId, hash, context)
  if (prior?.receipt) { await live(principal, context, true); return PublishedShareSchema.parse(JSON.parse(prior.receipt)) }
  const db = context.env.DB!, id = shareId ?? randomId(), expected = shareId ? (input as UpdateSnapshot).expectedRevision : 0, next = expected + 1, now = context.now()
  if (!Number.isSafeInteger(next)) throw new ApiFailure('INVALID_REQUEST')
  const result = receipt(id, next, true, context)
  const condition = `NOT EXISTS (SELECT 1 FROM share_mutations WHERE account_id = ? AND mutation_id = ?)${shareId ? " AND EXISTS (SELECT 1 FROM shares WHERE id = ? AND account_id = ? AND state = 'active' AND revision = ?)" : ''}`
  context.checkpoint('shares.publish.before-batch')
  try {
    await syncBatch(principal, condition, [principal.accountId, input.mutationId, ...(shareId ? [id, principal.accountId, expected] : [])], [
      shareId ? db.prepare('UPDATE shares SET revision = ?, snapshot_revision = ?, include_attribution = ?, updated_at = ? WHERE id = ?').bind(next, next, Number(input.includeAttribution), now, id)
        : db.prepare("INSERT INTO shares(id,account_id,revision,snapshot_revision,state,include_attribution,created_at,updated_at) VALUES (?,?,1,1,'active',?,?,?)").bind(id, principal.accountId, Number(input.includeAttribution), now, now),
      db.prepare('INSERT INTO share_snapshots(share_id,account_id,revision,snapshot) VALUES (?,?,?,?)').bind(id, principal.accountId, next, JSON.stringify(input.snapshot)),
      db.prepare('INSERT INTO share_mutations(account_id,mutation_id,share_id,digest,kind,receipt) VALUES (?,?,?,?,?,?)').bind(principal.accountId, input.mutationId, id, hash, kind, JSON.stringify(result)),
    ], context, 'HEAD_CONFLICT', true, true, 'publish')
  } catch (error) {
    const raced = await previous(principal, input.mutationId, hash, context)
    if (!raced?.receipt) throw error
    await live(principal, context, true)
    return PublishedShareSchema.parse(JSON.parse(raced.receipt))
  }
  context.checkpoint('shares.publish.after-batch')
  return result
}

export async function stopSharing(principal: CustomerPrincipal, shareId: string, input: StopSharing, context: ServiceContext): Promise<PublishedShare> {
  const parsed = StopSharingSchema.safeParse(input)
  if (!parsed.success || !Number.isSafeInteger(input.expectedRevision + 1)) throw new ApiFailure('INVALID_REQUEST')
  input = parsed.data
  await live(principal, context, false)
  const db = context.env.DB!, hash = await commandDigest('stop', shareId, input)
  let prior = await previous(principal, input.mutationId, hash, context)
  if (!prior) {
    // Capture the epoch and event bytes under the same guard that fences the public pointer
    const epoch = await db.prepare('SELECT session_epoch FROM accounts WHERE id = ?').bind(principal.accountId).first<number>('session_epoch')
    const event = JSON.stringify({ version: 1, kind: 'share-stopped', intentId: randomId(), accountId: principal.accountId, shareId, sessionEpoch: epoch, timestamp: context.now() })
    context.checkpoint('shares.stop.before-pending')
    try {
      // A revocation must remain possible at capacity; its bounded tombstone is still fully charged
      await syncBatch(principal, `EXISTS (SELECT 1 FROM shares WHERE id = ? AND account_id = ? AND state = 'active' AND revision = ?) AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND session_epoch = ?) AND NOT EXISTS (SELECT 1 FROM share_mutations WHERE account_id = ? AND mutation_id = ?)`, [shareId, principal.accountId, input.expectedRevision, principal.accountId, epoch!, principal.accountId, input.mutationId], [
        db.prepare("UPDATE shares SET state = 'stopping', updated_at = ? WHERE id = ?").bind(context.now(), shareId),
        db.prepare("INSERT INTO share_mutations(account_id,mutation_id,share_id,digest,kind,event) VALUES (?,?,?,?,'stop',?)").bind(principal.accountId, input.mutationId, shareId, hash, event),
      ], context, 'HEAD_CONFLICT', false, false)
    } catch (error) {
      prior = await previous(principal, input.mutationId, hash, context)
      if (!prior) throw error
    }
    prior ??= await previous(principal, input.mutationId, hash, context)
  }
  if (!prior || !prior.event) throw new ApiFailure('INTEGRITY_FAILED')
  if (prior.receipt) { await live(principal, context, false); return PublishedShareSchema.parse(JSON.parse(prior.receipt)) }
  const event = RevocationEventSchema.parse(JSON.parse(prior.event))
  context.checkpoint('shares.stop.pending')
  try { await appendRevocation(event, context) } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'LEDGER_UNAVAILABLE'
    context.emit({ operation: 'shares', stage: 'stop-ledger', code, mutationId: input.mutationId })
    throw new ApiFailure('SERVICE_UNAVAILABLE')
  }
  context.checkpoint('shares.stop.after-ledger')
  const result = receipt(shareId, input.expectedRevision + 1, false, context)
  // Ledger acknowledgment alone cannot mint a receipt after owner authority or pointer state changed
  try {
    await syncBatch(principal, `EXISTS (SELECT 1 FROM shares WHERE id = ? AND account_id = ? AND state = 'stopping' AND revision = ?) AND EXISTS (SELECT 1 FROM share_mutations WHERE account_id = ? AND mutation_id = ? AND digest = ? AND event = ? AND receipt IS NULL)`, [shareId, principal.accountId, input.expectedRevision, principal.accountId, input.mutationId, hash, prior.event], [
      db.prepare("UPDATE shares SET state = 'stopped', revision = ?, updated_at = ? WHERE id = ?").bind(result.revision, context.now(), shareId),
      db.prepare('UPDATE share_mutations SET receipt = ? WHERE account_id = ? AND mutation_id = ?').bind(JSON.stringify(result), principal.accountId, input.mutationId),
    ], context, 'HEAD_CONFLICT', false, false)
  } catch (error) {
    const raced = await previous(principal, input.mutationId, hash, context)
    if (!raced?.receipt) throw error
    await live(principal, context, false)
    return PublishedShareSchema.parse(JSON.parse(raced.receipt))
  }
  context.checkpoint('shares.stop.after-batch')
  return result
}

export async function publicSnapshot(shareId: string, context: ServiceContext) {
  const row = await context.env.DB!.prepare(`SELECT p.snapshot,s.revision,s.include_attribution,${publicUsernameSql} AS username FROM shares s JOIN share_snapshots p ON p.share_id = s.id AND p.revision = s.snapshot_revision JOIN accounts a ON a.id = s.account_id WHERE s.id = ? AND s.state = 'active' AND a.access IN ('active','read-only')`).bind(shareId).first<{ snapshot: string; revision: number; include_attribution: number; username: string | null }>()
  if (!row) throw new ApiFailure('NOT_FOUND')
  return { snapshot: validatePublicSnapshot(JSON.parse(row.snapshot)), ...(row.include_attribution && row.username ? { attribution: { username: row.username } } : {}), revision: row.revision }
}
export async function ownShares(principal: CustomerPrincipal, after: string | null, context: ServiceContext) {
  const guard = authority(principal, context, false)
  const rows = await context.env.DB!.prepare(`SELECT s.id,s.revision,s.state,s.include_attribution,json_extract(p.snapshot,'$.title') AS title,json_extract(p.snapshot,'$.kind') AS kind,m.mutation_id AS stop_mutation FROM shares s JOIN share_snapshots p ON p.share_id = s.id AND p.revision = s.snapshot_revision LEFT JOIN share_mutations m ON m.share_id = s.id AND m.kind = 'stop' AND m.receipt IS NULL WHERE s.account_id = ? AND s.id > ? AND EXISTS (${guard.sql}) ORDER BY s.id LIMIT ?`).bind(principal.accountId, after ?? '', ...guard.bindings, shareListLimit + 1).all<{ id: string; revision: number; state: 'active' | 'stopping' | 'stopped'; include_attribution: number; title: string; kind: 'build' | 'team'; stop_mutation: string | null }>()
  await live(principal, context, false)
  const page = rows.results.slice(0, shareListLimit)
  return { shares: page.map(row => ({ ...receipt(row.id, row.revision, row.state === 'active', context), title: row.title, kind: row.kind, includeAttribution: Boolean(row.include_attribution), state: row.state, ...(row.stop_mutation ? { stopMutationId: row.stop_mutation, stopExpectedRevision: row.revision } : {}) })), next: rows.results.length > shareListLimit ? page.at(-1)!.id : null }
}
