import { cancelAccountSnapshots } from './service-backup'
import { z } from 'zod'
import { deletionConfirmation, deletionStatusHeader } from '../../src/account/deletion-protocol'
import { base64urlSchema, digestBytes } from '../../src/account/protocol'
import { randomId } from '../auth/identity'
import { assertOrigin, liveSessionSql, recentAuthenticationMs, requireCustomer, requireRecent, type CustomerPrincipal } from '../auth/session'
import type { ServiceContext } from '../context'
import { runGuardedBatch } from '../db/guarded-batch'
import { emailAccountInvalidationStatement } from '../email/jobs'
import { ApiFailure, jsonResponse, readJson } from '../http'
import { controlBodyBytes, decode, digest, encoder, fenceGeneration, generationCleanupStatements, prepareClosedLiabilityTransfer } from '../sync/storage'
import { appendRevocation, ledgerLimits, prepareRevocationLiabilities, RevocationEventSchema, type ClosedLiabilityPage, type RevocationEvent } from './ledger'
import { advanceJob, jobBatch, jobGuard, serviceBatchLimit, type ServiceJob } from './types'

const statusTokenSchema = base64urlSchema(digestBytes)
const confirmationSchema = z.strictObject({ confirmation: z.literal(deletionConfirmation) })
const metadataTables = ['publication_borrows','publication_certificates','publication_pins','publication_progress','publication_work','mutation_receipts','head_history','scan_leases','sync_dependencies','sync_revisions','sync_documents','account_sequences','share_snapshots','share_mutations','shares','storage_generations','upload_reservations','device_approvals','credential_registrations','pending_email_changes','account_security_notices','pending_registrations','auth_attempts','auth_transactions','customer_sessions','devices'] as const
async function tokenDigest(token: string) {
  if (!statusTokenSchema.safeParse(token).success) throw new ApiFailure('NOT_FOUND')
  return digest(encoder.encode(`deletion-status:v1:${token}`))
}
export async function deletionStatus(token: string, context: ServiceContext) {
  const row = await context.env.DB!.prepare('SELECT j.outcome,j.phase,j.code FROM deletion_status s JOIN service_jobs j ON j.id = s.job_id WHERE s.token_digest = ?').bind(await tokenDigest(token)).first<{outcome:string;phase:string;code:string|null}>()
  if (!row) throw new ApiFailure('NOT_FOUND')
  // This capability never returns account identity, content, email or a session grant
  return { state: row.outcome, phase: row.phase, ...(row.code ? { code: row.code } : {}) }
}
// Prepared destruction is not authority: callers must atomically guard the live actor,
// exact account revision/epoch and their own audit/receipt alongside these statements
export function prepareAccountDeletion(accountId: string, actorId: string, revision: number, sessionEpoch: number, context: ServiceContext) {
  const db = context.env.DB!, now = context.now(), jobId = randomId(), intentId = randomId()
  if (!Number.isSafeInteger(sessionEpoch + 1) || !Number.isSafeInteger(revision + 1)) throw new ApiFailure('INTEGRITY_FAILED')
  const event: RevocationEvent = { version: 1, kind: 'account-deleted', intentId, accountId, sessionEpoch: sessionEpoch + 1, timestamp: now }
  return { jobId, statements: [
    db.prepare("INSERT INTO service_jobs(id,type,phase,account_id,actor_id,expected_revision,next_at,request_id,created_at) VALUES (?,'deletion','ledger',?,?,?,?,?,?)").bind(jobId, accountId, actorId, revision + 1, now, context.requestId, now),
    db.prepare('INSERT INTO revocation_intents(id,job_id,event) VALUES (?,?,?)').bind(intentId, jobId, JSON.stringify(event)),
    db.prepare("INSERT INTO service_audit(id,job_id,stage,created_at) VALUES (?,?,'blocked',?)").bind(randomId(), jobId, now),
    db.prepare("UPDATE accounts SET access = 'deleting',revision = revision + 1,session_epoch = session_epoch + 1 WHERE id = ?").bind(accountId),
    db.prepare('UPDATE customer_sessions SET revoked_at = COALESCE(revoked_at,?) WHERE account_id = ?').bind(now, accountId),
    db.prepare('UPDATE devices SET revoked_at = COALESCE(revoked_at,?) WHERE account_id = ?').bind(now, accountId),
    db.prepare("UPDATE shares SET state = 'stopping',updated_at = ? WHERE account_id = ? AND state = 'active'").bind(now, accountId),
    db.prepare("UPDATE device_approvals SET state = 'rejected',sealed_payload = NULL,completion_hash = NULL,capability_hash = '' WHERE account_id = ?").bind(accountId),
    emailAccountInvalidationStatement(db, accountId),
    // Consumers must become terminal before invalidating their accepted certificate sources
    db.prepare("UPDATE publication_work SET state = 'abandoned' WHERE account_id = ? AND state IN ('validating','complete')").bind(accountId),
    db.prepare("UPDATE publication_certificates SET state = 'invalidated' WHERE account_id = ? AND state = 'intact'").bind(accountId),
  ] }
}
export async function beginDeletion(principal: CustomerPrincipal, token: string, context: ServiceContext) {
  requireRecent(principal, context.now())
  const db = context.env.DB!, now = context.now(), hash = await tokenDigest(token)
  const account = await db.prepare('SELECT revision,session_epoch FROM accounts WHERE id = ?').bind(principal.accountId).first<{revision:number;session_epoch:number}>()
  if (!account || !Number.isSafeInteger(account.session_epoch + 1) || !Number.isSafeInteger(account.revision + 1)) throw new ApiFailure('FORBIDDEN')
  const prepared = prepareAccountDeletion(principal.accountId, principal.accountId, account.revision, account.session_epoch, context)
  context.checkpoint('deletion.block.before')
  await runGuardedBatch(db, { sql: `${liveSessionSql} AND a.revision = ? AND a.session_epoch = ? AND s.authenticated_at > ? AND s.authenticated_at <= ?`, bindings: [principal.sessionId, principal.accountId, now, now, account.revision, account.session_epoch, now - recentAuthenticationMs, now] }, [
    ...prepared.statements,
    db.prepare('INSERT INTO deletion_status(token_digest,job_id) VALUES (?,?)').bind(hash, prepared.jobId),
  ])
  context.checkpoint('deletion.block.after')
  return deletionStatus(token, context)
}
interface Intent { id: string; event: string; liabilities: string | null; cursor: string; acknowledged: number }
async function acknowledge(job: ServiceJob, intent: Intent, context: ServiceContext) {
  await prepareRevocationLiabilities(intent.id, intent.liabilities ? JSON.parse(intent.liabilities) as ClosedLiabilityPage[] : [], context)
  await appendRevocation(RevocationEventSchema.parse(JSON.parse(intent.event)), context)
  context.checkpoint('deletion.ledger.acknowledged')
  await jobBatch(job, [context.env.DB!.prepare('UPDATE revocation_intents SET acknowledged = 1 WHERE id = ? AND event = ?').bind(intent.id, intent.event)], context)
}
export async function runDeletion(job: ServiceJob, context: ServiceContext): Promise<void> {
  const db = context.env.DB!, accountId = job.account_id!
  if (job.phase === 'ledger') {
    // A partial Stop append already owns independent bytes; account-wide revocation cannot replace its exact recovery authority
    const stop = await db.prepare("SELECT m.mutation_id,m.share_id,m.digest,m.event,s.revision,s.state FROM share_mutations m JOIN shares s ON s.id = m.share_id WHERE m.account_id = ? AND m.kind = 'stop' AND m.receipt IS NULL ORDER BY m.share_id LIMIT 1").bind(accountId).first<{mutation_id:string;share_id:string;digest:string;event:string;revision:number;state:string}>()
    if (stop) {
      const event = RevocationEventSchema.parse(JSON.parse(stop.event))
      if (event.kind !== 'share-stopped' || event.accountId !== accountId || event.shareId !== stop.share_id || stop.state !== 'stopping' || !Number.isSafeInteger(stop.revision + 1)) throw new ApiFailure('INTEGRITY_FAILED')
      await appendRevocation(event, context)
      context.checkpoint('deletion.share-ledger.acknowledged')
      const lease = jobGuard(job, context)
      const receipt = JSON.stringify({shareId:stop.share_id,revision:stop.revision+1,active:false,url:`${context.env.SERVICE_ORIGIN}/#/s/${stop.share_id}`})
      await runGuardedBatch(db, {sql:`SELECT EXISTS (${lease.sql}) AND EXISTS (SELECT 1 FROM share_mutations m JOIN shares s ON s.id = m.share_id WHERE m.account_id = ? AND m.mutation_id = ? AND m.digest = ? AND m.event = ? AND m.receipt IS NULL AND s.state = 'stopping' AND s.revision = ?)`,bindings:[...lease.bindings,accountId,stop.mutation_id,stop.digest,stop.event,stop.revision]},[
        db.prepare("UPDATE shares SET state = 'stopped',revision = revision + 1,updated_at = ? WHERE id = ?").bind(context.now(),stop.share_id),
        db.prepare('UPDATE share_mutations SET receipt = ? WHERE account_id = ? AND mutation_id = ?').bind(receipt,accountId,stop.mutation_id),
      ])
      return
    }
    const intent = await db.prepare('SELECT * FROM revocation_intents WHERE job_id = ? AND acknowledged = 0 LIMIT 1').bind(job.id).first<Intent>()
    if (intent) await acknowledge(job, intent, context)
    else await advanceJob(job, 'fence', context)
    return
  }
  if (job.phase === 'fence') {
    // Cancel and permanently fence unfinished backup copies before their source authority disappears
    if (!await cancelAccountSnapshots(accountId, context)) return
    const row = await db.prepare("SELECT id,state FROM storage_generations WHERE account_id = ? AND state <> 'closed' ORDER BY id LIMIT 1").bind(accountId).first<{id:string;state:string}>()
    if (!row) { await advanceJob(job, 'liabilities', context); return }
    if (row.state === 'unsafe') throw new ApiFailure('INTEGRITY_FAILED')
    if (row.state !== 'closing') await jobBatch(job, generationCleanupStatements(row.id, context), context)
    await fenceGeneration(row.id, context)
    return
  }
  if (job.phase === 'liabilities') {
    const pending = await db.prepare('SELECT * FROM revocation_intents WHERE job_id = ? AND acknowledged = 0 LIMIT 1').bind(job.id).first<Intent>()
    if (pending) { await acknowledge(job, pending, context); await jobBatch(job, [db.prepare('UPDATE service_jobs SET cursor = ? WHERE id = ?').bind(pending.cursor, job.id)], context); return }
    // The last acknowledged page also repairs a lost cursor response without allocating another intent
    const last = await db.prepare("SELECT MAX(cursor) AS cursor FROM revocation_intents WHERE job_id = ? AND acknowledged = 1").bind(job.id).first<string>('cursor') ?? ''
    const rows = await db.prepare("SELECT object_key,marker FROM upload_chunks WHERE account_id = ? AND object_key > ? AND state = 'closed' AND released = 1 ORDER BY object_key LIMIT ?").bind(accountId, last, ledgerLimits.pageEntries).all<{object_key:string;marker:string}>()
    if (!rows.results.length) { await advanceJob(job, 'transfer', context); return }
    const intentId = randomId(), original = await db.prepare('SELECT event FROM revocation_intents WHERE job_id = ? ORDER BY cursor LIMIT 1').bind(job.id).first<string>('event')
    const event = { ...RevocationEventSchema.parse(JSON.parse(original!)), intentId }
    const page: ClosedLiabilityPage = { version: 1, intentId, page: 0, entries: await Promise.all(rows.results.map(async row => ({ managedKey: row.object_key, markerIdentity: row.marker, markerDigest: await digest(decode(row.marker)), retainedBytes: controlBodyBytes, closed: true as const, payloadReleased: true as const }))) }
    await jobBatch(job, [db.prepare('INSERT INTO revocation_intents(id,job_id,event,liabilities,cursor) VALUES (?,?,?,?,?)').bind(intentId, job.id, JSON.stringify(event), JSON.stringify([page]), rows.results.at(-1)!.object_key)], context)
    return
  }
  if (job.phase === 'transfer') {
    const transfer = prepareClosedLiabilityTransfer(accountId, context)
    const guard = { sql: `SELECT (${transfer.guard.sql}) AND EXISTS (SELECT 1 FROM service_jobs WHERE id = ? AND phase = 'transfer' AND lease_token = ? AND lease_until > ?) AND NOT EXISTS (SELECT 1 FROM revocation_intents WHERE job_id = ? AND acknowledged = 0) AND NOT EXISTS (SELECT 1 FROM upload_chunks c WHERE c.account_id = ? AND NOT EXISTS (SELECT 1 FROM revocation_intents i,json_each(i.liabilities,'$[0].entries') p WHERE i.job_id = ? AND i.acknowledged = 1 AND json_extract(p.value,'$.managedKey') = c.object_key AND json_extract(p.value,'$.markerIdentity') = c.marker))`, bindings: [...transfer.guard.bindings, job.id, job.lease_token, context.now(), job.id, accountId, job.id] }
    context.checkpoint('deletion.transfer.before')
    await runGuardedBatch(db, guard, [...transfer.statements, db.prepare("UPDATE service_jobs SET phase = 'metadata',cursor = '' WHERE id = ?").bind(job.id)])
    return
  }
  if (job.phase === 'metadata') {
    // Authored dependency order and bounded row deletion preserve FK and certificate lifetimes
    const index = job.cursor ? Number(job.cursor) : 0
    if (index >= metadataTables.length) { await advanceJob(job, 'envelopes', context); return }
    const table = metadataTables[index]
    const row = await db.prepare(`SELECT rowid FROM ${table} WHERE account_id = ? LIMIT 1`).bind(accountId).first()
    if (row) {
      context.checkpoint('deletion.metadata.before')
      const statements = []
      if (table === 'upload_reservations') statements.push(db.prepare('UPDATE quota_counters SET reserved_metadata = reserved_metadata - (SELECT COALESCE(SUM(descriptor_reserve),0) FROM upload_reservations WHERE rowid IN (SELECT rowid FROM upload_reservations WHERE account_id = ? LIMIT ?)) WHERE scope IN (?,\'global\')').bind(accountId, serviceBatchLimit, accountId))
      statements.push(db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE account_id = ? LIMIT ?)`).bind(accountId, serviceBatchLimit))
      await jobBatch(job, statements, context)
    } else await jobBatch(job, [db.prepare('UPDATE service_jobs SET cursor = ? WHERE id = ?').bind(String(index + 1), job.id)], context)
    return
  }
  if (job.phase === 'envelopes') {
    context.checkpoint('deletion.envelopes.before')
    await advanceJob(job, 'account', context, [db.prepare('DELETE FROM credentials WHERE account_id = ?').bind(accountId)])
    return
  }
  if (job.phase === 'account') {
    context.checkpoint('deletion.account.before')
    await jobBatch(job, [
      db.prepare('DELETE FROM accounts WHERE id = ? AND access = \'deleting\' AND revision = ?').bind(accountId, job.expected_revision),
      db.prepare("INSERT INTO transaction_guards(id,passed) VALUES (?,CASE WHEN NOT EXISTS (SELECT 1 FROM accounts WHERE id = ?) AND NOT EXISTS (SELECT 1 FROM quota_counters WHERE scope = ? AND (payload_bytes <> 0 OR reserved_metadata <> 0 OR metadata_bytes <> 0)) THEN 1 ELSE 0 END)").bind(job.id, accountId, accountId),
      db.prepare('DELETE FROM transaction_guards WHERE id = ?').bind(job.id),
      db.prepare('DELETE FROM quota_counters WHERE scope = ?').bind(accountId),
      db.prepare("UPDATE service_jobs SET phase = 'complete',outcome = 'complete',code = NULL WHERE id = ?").bind(job.id),
      db.prepare("INSERT INTO service_audit(id,job_id,stage,created_at) VALUES (?,?,'complete',?)").bind(randomId(), job.id, context.now()),
    ], context)
  }
}
export async function deletionRoute(request: Request, context: ServiceContext): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/api/v1/account/deletion') return null
  if (url.search) throw new ApiFailure('INVALID_REQUEST')
  const token = request.headers.get(deletionStatusHeader) ?? ''
  if (request.method === 'GET') return jsonResponse(await deletionStatus(token, context))
  if (request.method !== 'POST') throw new ApiFailure('INVALID_REQUEST')
  assertOrigin(request, context)
  await readJson(request, confirmationSchema, 1024)
  // The caller retains this independent random grant before submitting, so a lost response can be reconciled after session revocation
  try { return jsonResponse(await deletionStatus(token, context), 202) } catch (error) { if (!(error instanceof ApiFailure) || error.code !== 'NOT_FOUND') throw error }
  return jsonResponse(await beginDeletion(await requireCustomer(request, context), token, context), 202)
}
