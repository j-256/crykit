import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types/experimental'
import { OpaqueIdSchema, base64urlSchema, type JobReceipt } from '../../src/account/protocol'
import type { ServiceContext } from '../context'
import { runGuardedBatch, type SqlGuard } from '../db/guarded-batch'
import { ApiFailure } from '../http'
import { EmailSendFailure, serviceEmailAvailable, serviceEmailSecretBytes, serviceEmailTransport, validEmailMessageId } from './native'
import { validateServiceEmail } from './templates'
import type { ServiceEmail } from './types'

export const maxEmailAttempts = 3
export const emailLeaseMs = 60_000
export const maxEmailDispatchJobs = 50
const defaultEmailLifetimeMs = 24 * 60 * 60 * 1000
const emailAuditRetentionMs = 90 * 24 * 60 * 60 * 1000
const emailJobRetentionMs = 7 * 24 * 60 * 60 * 1000
const emailNonceBytes = 12
const maxEncryptedPayloadCharacters = 8192
const initialRetrySeconds = 60
const quotaRetrySeconds = 60 * 60
const encoder = new TextEncoder()
const rootEligible = `eligible = 1 AND NOT EXISTS (SELECT 1 FROM email_jobs root WHERE root.id = email_jobs.resend_of AND root.eligible = 0)`

type Delivery = 'pending' | 'unsent' | 'accepted' | 'uncertain' | 'suppressed' | 'expired' | 'paused' | 'cancelled'
interface EmailJob {
  id: string; request_digest: string; request_id: string; payload: string | null
  state: JobReceipt['state']; delivery: Delivery; attempts: number; eligible: number
  next_attempt_at: number; expires_at: number; created_at: number; updated_at: number
  lease_token: string | null; lease_until: number | null; code: string | null; resend_of: string | null
}
export interface EmailJobStatus extends JobReceipt {
  readonly delivery: Delivery
  readonly attempts: number
  readonly nextAttemptAt: number
  readonly code?: string
}
export interface PreparedServiceEmailEnqueue {
  readonly guard: SqlGuard
  readonly statements: readonly D1PreparedStatement[]
  readonly jobId: string
  readonly requestDigest: string
}
function database(context: ServiceContext): D1Database {
  if (!context.env.DB) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return context.env.DB
}
function validId(jobId: string): void {
  if (!OpaqueIdSchema.safeParse(jobId).success) throw new ApiFailure('INVALID_REQUEST')
}
function encode(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
function decode(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0)) }
async function keys(context: ServiceContext) {
  const secret = context.env.EMAIL_STATE_SECRET
  if (!base64urlSchema(serviceEmailSecretBytes).safeParse(secret).success || [context.env.SESSION_SECRET, context.env.CURSOR_SECRET, context.env.CAPABILITY_SECRET, context.env.DUMMY_IDENTITY_SECRET].includes(secret)) throw new ApiFailure('SERVICE_UNAVAILABLE')
  // The sender must recover service capabilities without any customer account key
  // HKDF separates encryption and keyed request identity under a dedicated service secret
  const root = await crypto.subtle.importKey('raw', decode(secret!), 'HKDF', false, ['deriveKey'])
  const derive = (purpose: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('crykit/service-email/v1'), info: encoder.encode(purpose) })
  const encryption = await crypto.subtle.deriveKey(derive('payload'), root, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const identity = await crypto.subtle.deriveKey(derive('request-identity'), root, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'])
  return { encryption, identity }
}
async function seal(message: ServiceEmail, jobId: string, context: ServiceContext) {
  const { encryption, identity } = await keys(context)
  // Correlation changes on network retries; it is encrypted but is not command identity
  const digest = encode(new Uint8Array(await crypto.subtle.sign('HMAC', identity, encoder.encode(JSON.stringify([1, message.kind, message.recipient, message.capability ?? null, message.expiresAt ?? null])))))
  const nonce = crypto.getRandomValues(new Uint8Array(emailNonceBytes))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(JSON.stringify([1, jobId, digest])) }, encryption, encoder.encode(JSON.stringify(message)))
  return { digest, payload: JSON.stringify([1, encode(nonce), encode(new Uint8Array(ciphertext))]) }
}
async function unseal(job: EmailJob, context: ServiceContext): Promise<ServiceEmail> {
  try {
    const [version, nonce, ciphertext] = JSON.parse(job.payload ?? '') as [number, string, string]
    if (version !== 1 || typeof nonce !== 'string' || typeof ciphertext !== 'string' || decode(nonce).length !== emailNonceBytes || ciphertext.length > maxEncryptedPayloadCharacters) throw new Error('Invalid encrypted payload')
    const { encryption } = await keys(context)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(nonce), additionalData: encoder.encode(JSON.stringify([1, job.id, job.request_digest])) }, encryption, decode(ciphertext))
    return validateServiceEmail(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(plain)) as ServiceEmail)
  } catch { throw new EmailSendFailure('PAYLOAD_UNAVAILABLE', 'permanent') }
}
function receipt(job: EmailJob): JobReceipt { return { jobId: job.id, state: job.state, requestId: job.request_id } }
async function load(jobId: string, context: ServiceContext): Promise<EmailJob | null> {
  return database(context).prepare('SELECT * FROM email_jobs WHERE id = ?').bind(jobId).first<EmailJob>()
}
function audit(db: D1Database, jobId: string, stage: string, attempt: number, code: string | null, now: number): D1PreparedStatement {
  return db.prepare('INSERT INTO email_audit (id, job_id, stage, attempt, code, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), jobId, stage, attempt, code, now)
}
async function guarded(context: ServiceContext, sql: string, bindings: SqlGuard['bindings'], statements: readonly D1PreparedStatement[]): Promise<boolean> {
  try { await runGuardedBatch(database(context), { sql, bindings }, statements); return true } catch (error) {
    // Only our named CHECK means a competing command invalidated the predicate
    // Other SQL/audit failures must remain visible and must never authorize a send
    if (String(error).includes('CHECK constraint failed: transaction_guard_passed')) return false
    context.emit({ operation: 'email', stage: 'database', code: 'SERVICE_UNAVAILABLE' })
    throw new ApiFailure('SERVICE_UNAVAILABLE')
  }
}

// Add this statement to the caller's guarded authority-change batch, never run a
// preflight read followed by a separate update; linked authority stores stable jobId
// Invalidating either root or child invalidates the entire bounded resend lineage
export function emailInvalidationStatement(db: D1Database, jobId: string): D1PreparedStatement {
  validId(jobId)
  return db.prepare(`UPDATE email_jobs SET eligible = 0 WHERE id = (SELECT COALESCE(resend_of, id) FROM email_jobs WHERE id = ?) OR resend_of = (SELECT COALESCE(resend_of, id) FROM email_jobs WHERE id = ?)`).bind(jobId, jobId)
}

// Account deletion selects linked roots inside the authority batch, including a resend created concurrently
// Preserve attempts and accepted/uncertain outcomes while destroying retained transport material
export function emailAccountInvalidationStatement(db: D1Database, accountId: string): D1PreparedStatement {
  validId(accountId)
  return db.prepare(`UPDATE email_jobs SET eligible = 0,payload = NULL WHERE COALESCE(resend_of,id) IN (
    SELECT root_job_id FROM pending_email_changes WHERE account_id = ?
    UNION SELECT root_job_id FROM account_security_notices WHERE account_id = ?
    UNION SELECT v.root_job_id FROM verification_capabilities v JOIN pending_registrations p ON p.id = v.pending_id WHERE p.account_id = ?
  )`).bind(accountId,accountId,accountId)
}

async function prepareEnqueue(message: ServiceEmail, jobId: string, context: ServiceContext, resendOf: string | null): Promise<PreparedServiceEmailEnqueue> {
  validId(jobId)
  message = validateServiceEmail(message)
  const sealed = await seal(message, jobId, context)
  const db = database(context)
  const now = context.now()
  const expiresAt = message.expiresAt ?? now + defaultEmailLifetimeMs
  return {
    jobId, requestDigest: sealed.digest,
    // A matching retry is allowed but cannot rewrite existing outcome/history
    // Callers conjoin this trusted predicate with their authority predicate, then
    // include these statements in the SAME guarded D1 authority-change batch
    guard: {
      sql: `SELECT (NOT EXISTS (SELECT 1 FROM email_jobs WHERE id = ?) OR EXISTS (SELECT 1 FROM email_jobs WHERE id = ? AND request_digest = ? AND resend_of IS ?)) AND (? IS NULL OR EXISTS (SELECT 1 FROM email_jobs WHERE id = ? AND resend_of IS NULL AND eligible = 1 AND delivery IN ('accepted', 'uncertain') AND expires_at > ? AND NOT EXISTS (SELECT 1 FROM email_jobs child WHERE child.resend_of = ? AND child.id != ?)))`,
      bindings: [jobId, jobId, sealed.digest, resendOf, resendOf, resendOf, now, resendOf, jobId],
    },
    statements: [
      db.prepare(`INSERT INTO email_jobs (id, request_digest, request_id, payload, state, delivery, next_attempt_at, expires_at, created_at, updated_at, resend_of) VALUES (?, ?, ?, ?, 'queued', 'pending', ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).bind(jobId, sealed.digest, context.requestId, sealed.payload, now, expiresAt, now, now, resendOf),
      // Stable queued-audit identity makes exact retries a no-op, including after
      // later send attempts; no changes() dependency can leak from caller SQL
      db.prepare(`INSERT INTO email_audit (id, job_id, stage, attempt, code, created_at) SELECT ?, ?, 'queued', 0, NULL, ? WHERE EXISTS (SELECT 1 FROM email_jobs WHERE id = ? AND state = 'queued' AND attempts = 0) ON CONFLICT(id) DO NOTHING`).bind(`queued:${jobId}`, jobId, now, jobId),
    ],
  }
}
export async function prepareServiceEmailEnqueue(message: ServiceEmail, jobId: string, context: ServiceContext): Promise<PreparedServiceEmailEnqueue> {
  return prepareEnqueue(message, jobId, context, null)
}
async function enqueue(message: ServiceEmail, jobId: string, context: ServiceContext, resendOf: string | null): Promise<JobReceipt> {
  const prepared = await prepareEnqueue(message, jobId, context, resendOf)
  const applied = await guarded(context, prepared.guard.sql, prepared.guard.bindings, prepared.statements)
  const db = database(context)
  if (!applied && resendOf) {
    const existing = await db.prepare(`SELECT child.* FROM email_jobs child JOIN email_jobs root ON root.id = child.resend_of WHERE root.id = ? AND root.eligible = 1 AND child.eligible = 1 AND root.expires_at > ?`).bind(resendOf, context.now()).first<EmailJob>()
    if (existing) return receipt(existing)
  }
  const existing = await load(jobId, context)
  if (!existing) throw new ApiFailure('INVALID_REQUEST')
  if (existing.request_digest !== prepared.requestDigest || existing.resend_of !== resendOf) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
  if (!applied && resendOf) throw new ApiFailure('INVALID_REQUEST')
  context.emit({ operation: 'email', stage: 'enqueued', jobId })
  return receipt(existing)
}
export async function enqueueServiceEmail(message: ServiceEmail, jobId: string, context: ServiceContext): Promise<JobReceipt> {
  return enqueue(message, jobId, context, null)
}

// These helpers are internal service seams, not public authorization by knowledge of ID
// Future auth/admin routes must first authorize and link their authority record to jobId
export async function getEmailJob(jobId: string, context: ServiceContext): Promise<EmailJobStatus> {
  validId(jobId)
  const job = await load(jobId, context)
  if (!job) throw new ApiFailure('NOT_FOUND')
  return { ...receipt(job), delivery: job.delivery, attempts: job.attempts, nextAttemptAt: job.next_attempt_at, ...(job.code ? { code: job.code } : {}) }
}
// The caller supplies authority and receipt/audit writes in the same transaction
// Attempts are cumulative; manual retry cannot reset the automatic-send budget
export async function prepareEmailRetry(jobId: string, context: ServiceContext) {
  validId(jobId)
  const db=database(context),now=context.now(),job=await load(jobId,context)
  if (!job) throw new ApiFailure('NOT_FOUND')
  return {guard:{sql:`SELECT 1 FROM email_jobs WHERE id=? AND state='failed' AND delivery='unsent' AND ${rootEligible} AND attempts<? AND expires_at>? AND payload IS NOT NULL`,bindings:[jobId,maxEmailAttempts,now]},statements:[
    db.prepare("UPDATE email_jobs SET state='queued',next_attempt_at=?,updated_at=?,code=NULL WHERE id=?").bind(now,now,jobId),
    audit(db,jobId,'manual-retry',job.attempts,null,now),
  ]}
}
export async function retryEmailJob(jobId: string, context: ServiceContext): Promise<JobReceipt> {
  const prepared=await prepareEmailRetry(jobId,context)
  const restarted=await guarded(context,prepared.guard.sql,prepared.guard.bindings,prepared.statements)
  if (!restarted) throw new ApiFailure('INVALID_REQUEST')
  return receipt((await load(jobId,context))!)
}
export async function resendServiceEmail(sourceJobId: string, resendId: string, context: ServiceContext): Promise<JobReceipt> {
  validId(sourceJobId)
  validId(resendId)
  const root = await load(sourceJobId, context)
  if (!root) throw new ApiFailure('NOT_FOUND')
  if (root.resend_of || !root.eligible || root.expires_at <= context.now() || !['accepted', 'uncertain'].includes(root.delivery)) throw new ApiFailure('INVALID_REQUEST')
  // One explicit resend for the whole root, coalesced even when callers choose new IDs
  // Never erase the first outcome or invent idempotency at the provider boundary
  const message = await unseal(root, context)
  // Preserve the root's implicit lifetime for notices as well as capability mail
  return enqueue({ ...message, expiresAt: root.expires_at }, resendId, context, sourceJobId)
}

async function settle(job: EmailJob, context: ServiceContext, delivery: Delivery, code: string | null, messageId: string | null = null, retryAfterSeconds?: number, expectedAttemptStage?: 'leased' | 'sending'): Promise<void> {
  const db = database(context)
  const now = context.now()
  const retry = delivery === 'unsent' && retryAfterSeconds !== undefined && job.attempts < maxEmailAttempts && job.expires_at > now
  const state = delivery === 'accepted' ? 'complete' : retry ? 'waiting' : 'failed'
  // A longer provider delay may outlast the capability; wake only to expire it,
  // never shorten Retry-After and send earlier than the provider permitted
  const next = retry ? Math.min(job.expires_at, now + retryAfterSeconds * 1000) : now
  // Recovery's snapshot is not authority: compare the observed attempt stage in
  // the same transaction, or a competing send-start could become a duplicate retry
  const persisted = await guarded(context, `SELECT 1 FROM email_jobs WHERE id = ? AND state = 'running' AND lease_token = ? AND (? IS NULL OR EXISTS (SELECT 1 FROM email_attempts WHERE job_id = email_jobs.id AND attempt = email_jobs.attempts AND delivery = ?))`, [job.id, job.lease_token, expectedAttemptStage ?? null, expectedAttemptStage ?? null], [
    db.prepare('UPDATE email_jobs SET state = ?, delivery = ?, code = ?, message_id = ?, next_attempt_at = ?, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ?').bind(state, delivery, code, messageId, next, now, job.id),
    db.prepare('UPDATE email_attempts SET delivery = ?, code = ?, finished_at = ? WHERE job_id = ? AND attempt = ? AND lease_token = ?').bind(delivery, code, now, job.id, job.attempts, job.lease_token),
    audit(db, job.id, delivery, job.attempts, code, now),
  ])
  context.emit({ operation: 'email', stage: persisted ? delivery : 'lease-lost', code: persisted ? code ?? 'ACCEPTED' : 'LEASE_LOST', jobId: job.id, attempt: job.attempts })
}
async function finishUnsent(job: EmailJob, context: ServiceContext, delivery: 'expired' | 'cancelled'): Promise<void> {
  const db = database(context)
  const now = context.now()
  await guarded(context, `SELECT 1 FROM email_jobs WHERE id = ? AND state IN ('queued', 'waiting')`, [job.id], [
    db.prepare("UPDATE email_jobs SET state = 'failed', delivery = ?, payload = NULL, code = ?, updated_at = ? WHERE id = ?").bind(delivery, delivery === 'expired' ? 'CAPABILITY_EXPIRED' : 'AUTHORITY_INVALIDATED', now, job.id),
    audit(db, job.id, delivery, job.attempts, null, now),
  ])
  context.emit({ operation: 'email', stage: delivery, jobId: job.id, attempt: job.attempts })
}
async function dispatchOne(job: EmailJob, context: ServiceContext): Promise<void> {
  const db = database(context)
  const now = context.now()
  if (job.state === 'running') {
    if (job.lease_until === null || job.lease_until > now) return
    const attempt = await db.prepare('SELECT delivery FROM email_attempts WHERE job_id = ? AND attempt = ?').bind(job.id, job.attempts).first<{ delivery: string }>()
    // A persisted send-start may already have escaped to the provider, including
    // when an account is revoked or a capability expires while the send is in flight
    if (attempt?.delivery === 'sending') await settle(job, context, 'uncertain', 'LEASE_LOST', null, undefined, 'sending')
    else if (attempt?.delivery !== 'leased') await settle(job, context, 'uncertain', 'ATTEMPT_STATE_UNAVAILABLE')
    else if (!job.eligible) await settle(job, context, 'cancelled', 'AUTHORITY_INVALIDATED', null, undefined, 'leased')
    else if (job.expires_at <= now) await settle(job, context, 'expired', 'CAPABILITY_EXPIRED', null, undefined, 'leased')
    else await settle(job, context, 'unsent', 'LEASE_LOST_BEFORE_SEND', null, 1, 'leased')
    return
  }
  if (job.expires_at <= now) { await finishUnsent(job, context, 'expired'); return }
  if (!job.eligible) { await finishUnsent(job, context, 'cancelled'); return }
  const emailEnabled = await db.prepare("SELECT 1 FROM service_settings WHERE id='service' AND email_paused=0").first()
  const transport = emailEnabled ? serviceEmailTransport(context) : undefined
  if (!transport) {
    if (job.delivery !== 'paused') await guarded(context, `SELECT 1 FROM email_jobs WHERE id = ? AND state IN ('queued', 'waiting')`, [job.id], [
      db.prepare("UPDATE email_jobs SET state = 'waiting', delivery = 'paused', code = 'SENDER_PAUSED', updated_at = ? WHERE id = ?").bind(now, job.id),
      audit(db, job.id, 'paused', job.attempts, 'SENDER_PAUSED', now),
    ])
    context.emit({ operation: 'email', stage: 'paused', code: 'SENDER_PAUSED', jobId: job.id })
    return
  }
  const token = crypto.randomUUID()
  const claimed = await guarded(context, `SELECT 1 FROM email_jobs WHERE id = ? AND state IN ('queued', 'waiting') AND ${rootEligible} AND EXISTS (SELECT 1 FROM service_settings WHERE id='service' AND email_paused=0) AND next_attempt_at <= ? AND expires_at > ? AND attempts < ? AND attempts = ?`, [job.id, now, now, maxEmailAttempts, job.attempts], [
    db.prepare("UPDATE email_jobs SET state = 'running', attempts = attempts + 1, lease_token = ?, lease_until = ?, updated_at = ? WHERE id = ?").bind(token, now + emailLeaseMs, now, job.id),
    db.prepare("INSERT INTO email_attempts (job_id, attempt, lease_token, delivery, started_at) SELECT id, attempts, ?, 'leased', ? FROM email_jobs WHERE id = ?").bind(token, now, job.id),
    audit(db, job.id, 'leased', job.attempts + 1, null, now),
  ])
  if (!claimed) return
  const leased = await load(job.id, context)
  // Recovery may replace this generation before the reload; never borrow its
  // token and accidentally settle another sender when decrypt/checkpoint fails
  if (!leased || leased.state !== 'running' || leased.lease_token !== token) return
  let message: ServiceEmail
  try {
    message = await unseal(leased, context)
    context.checkpoint('email.before-send')
  } catch (error) {
    await settle(leased, context, 'unsent', error instanceof EmailSendFailure ? error.code : 'BEFORE_SEND_FAILED', null, undefined, 'leased')
    return
  }
  const startedAt = context.now()
  const started = await guarded(context, `SELECT 1 FROM email_jobs WHERE id = ? AND state = 'running' AND lease_token = ? AND ${rootEligible} AND EXISTS (SELECT 1 FROM service_settings WHERE id='service' AND email_paused=0) AND lease_until > ? AND expires_at > ?`, [job.id, token, startedAt, startedAt], [
    db.prepare("UPDATE email_attempts SET delivery = 'sending' WHERE job_id = ? AND attempt = ? AND lease_token = ?").bind(job.id, leased.attempts, token),
    audit(db, job.id, 'sending', leased.attempts, null, startedAt),
  ])
  if (!started) {
    const current = await load(job.id, context)
    if (current?.state === 'running' && current.lease_token === token) {
      if (current.expires_at <= context.now()) await settle(current, context, 'expired', 'CAPABILITY_EXPIRED', null, undefined, 'leased')
      else if (!current.eligible) await settle(current, context, 'cancelled', 'AUTHORITY_INVALIDATED', null, undefined, 'leased')
      else await settle(current, context, 'unsent', 'LEASE_LOST_BEFORE_SEND', null, 1, 'leased')
    }
    return
  }
  let result: { readonly messageId: string }
  try {
    result = await transport.send(message)
    if (!result || !validEmailMessageId(result.messageId)) throw new EmailSendFailure('TRANSPORT_UNCERTAIN', 'uncertain')
    // A dropped response after acceptance is indistinguishable from an unknown send
    context.checkpoint('email.after-send')
  } catch (error) {
    const failure = error instanceof EmailSendFailure ? error : new EmailSendFailure('TRANSPORT_UNCERTAIN', 'uncertain')
    const delivery = failure.disposition === 'uncertain' ? 'uncertain' : failure.disposition === 'suppressed' ? 'suppressed' : 'unsent'
    const fallback = failure.code === 'QUOTA_LIMITED' ? quotaRetrySeconds : initialRetrySeconds * 2 ** (leased.attempts - 1)
    const retry = failure.disposition === 'retryable' ? (Number.isSafeInteger(failure.retryAfterSeconds) && failure.retryAfterSeconds! >= 0 ? failure.retryAfterSeconds! : fallback) : undefined
    await settle(leased, context, delivery, failure.code, null, retry)
    return
  }
  // Result/audit persistence is outside the transport catch: a SQL failure here
  // leaves 'sending' durable for uncertain recovery, never a known-unsent retry
  await settle(leased, context, 'accepted', null, result.messageId)
  context.emit({ operation: 'email', stage: 'attempt', jobId: job.id, attempt: leased.attempts, durationMs: Math.max(0, context.now() - startedAt) })
}
export async function dispatchEmailJobs(context: ServiceContext, limit: number): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxEmailDispatchJobs) throw new ApiFailure('INVALID_REQUEST')
  const db = database(context)
  const now = context.now()
  const senderAvailable = serviceEmailAvailable(context) && await db.prepare("SELECT 1 FROM service_settings WHERE id='service' AND email_paused=0").first() ? 1 : 0
  // Safety work must outrank ordinary sends even when an older backlog is paused
  // Skip unchanged paused rows until readiness returns; expiry/invalidation and
  // lost leases remain selectable so they cannot wait behind sender availability
  const jobs = await db.prepare(`SELECT * FROM email_jobs
    WHERE (state IN ('queued', 'waiting') AND ((next_attempt_at <= ? AND (? = 1 OR delivery != 'paused')) OR expires_at <= ? OR eligible = 0))
      OR (state = 'running' AND lease_until <= ?)
    ORDER BY CASE WHEN state = 'running' OR expires_at <= ? OR eligible = 0 THEN 0 ELSE 1 END, created_at, id
    LIMIT ?`).bind(now, senderAvailable, now, now, now, limit).all<EmailJob>()
  for (const job of jobs.results) await dispatchOne(job, context)
  // Payload is no longer useful after expiry, including accepted/uncertain roots
  // Keep only nonsecret bounded job history; audit retains its independent horizon
  await db.batch([
    db.prepare('UPDATE email_jobs SET payload = NULL WHERE id IN (SELECT id FROM email_jobs WHERE expires_at <= ? AND payload IS NOT NULL LIMIT ?)').bind(now, maxEmailDispatchJobs),
    db.prepare('DELETE FROM email_audit WHERE id IN (SELECT id FROM email_audit WHERE created_at < ? LIMIT ?)').bind(now - emailAuditRetentionMs, maxEmailDispatchJobs * 4),
    db.prepare("DELETE FROM email_attempts WHERE rowid IN (SELECT a.rowid FROM email_attempts a JOIN email_jobs j ON j.id = a.job_id WHERE j.state IN ('failed', 'complete') AND j.updated_at < ? AND j.expires_at <= ? LIMIT ?)").bind(now - emailJobRetentionMs, now, maxEmailDispatchJobs * maxEmailAttempts),
    // Keep identity metadata while audit references it, then remove old children
    // before roots; a newer resend or remaining audit must not fail the whole sweep
    db.prepare("DELETE FROM email_jobs WHERE id IN (SELECT id FROM email_jobs WHERE resend_of IS NOT NULL AND state IN ('failed', 'complete') AND updated_at < ? AND expires_at <= ? AND NOT EXISTS (SELECT 1 FROM email_audit WHERE job_id = email_jobs.id) AND NOT EXISTS (SELECT 1 FROM email_attempts WHERE job_id = email_jobs.id) LIMIT ?)").bind(now - emailAuditRetentionMs, now, maxEmailDispatchJobs),
    db.prepare("DELETE FROM email_jobs WHERE id IN (SELECT id FROM email_jobs WHERE resend_of IS NULL AND state IN ('failed', 'complete') AND updated_at < ? AND expires_at <= ? AND NOT EXISTS (SELECT 1 FROM email_audit WHERE job_id = email_jobs.id) AND NOT EXISTS (SELECT 1 FROM email_attempts WHERE job_id = email_jobs.id) AND NOT EXISTS (SELECT 1 FROM email_jobs child WHERE child.resend_of = email_jobs.id) LIMIT ?)").bind(now - emailAuditRetentionMs, now, maxEmailDispatchJobs),
  ])
}
