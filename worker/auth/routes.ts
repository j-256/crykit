import { z } from 'zod'
import { devicePage, deviceRoute } from './devices'
import { credentialRoute } from './credentials'
import { credentialIdForRole, defaultAccountCapacityBytes, LoginFinishSchema, LoginStartSchema, LogoutSchema, maxAuthJsonBytes, ResendSchema, SignupFinishSchema, SignupStartSchema, VerifySchema } from '../../src/account/protocol'
import type { ServiceContext } from '../context'
import { emailInvalidationStatement, prepareServiceEmailEnqueue } from '../email/jobs'
import { serviceEmailAvailable } from '../email/native'
import { ApiFailure, jsonResponse, readJson } from '../http'
import { assertUsername, dummyCredentialId, guarded, keyedHash, loginAttemptMs, normalizedEmail, pendingRegistrationMs, randomId, randomToken, verificationMs } from './identity'
import { finishServerLogin, registrationResponse, startServerLogin } from './opaque'
import { limitAuth } from './rate-limits'
import { assertOrigin, incomingSessionHash, liveSessionSql, newSession, requireCustomer, sessionCsrf, sessionPolicy, sessionResponse, type SessionRow } from './session'

interface Pending { id: string; account_id: string; normalized_email: string; delivery_email: string; username: string; registration_record: string | null; account_envelope: string | null; transaction_id: string | null; verification_revision: number; expires_at: number }
interface Attempt { id: string; account_id: string | null; role: 'password' | 'recovery'; credential_revision: number | null; server_state: string; expires_at: number; session_id: string | null }
async function requireSignup(context: ServiceContext): Promise<void> {
  if (!await context.env.DB!.prepare("SELECT 1 FROM service_settings WHERE id='service' AND registration_paused=0").first() || context.env.SIGNUP_ACTIVE !== 'true' || !serviceEmailAvailable(context)) throw new ApiFailure('SERVICE_UNAVAILABLE')
}
async function prepareVerification(pending: Pick<Pending, 'id' | 'delivery_email' | 'expires_at'>, context: ServiceContext) {
  const capability = randomToken()
  const rootJobId = randomId()
  const expiresAt = Math.min(pending.expires_at, context.now() + verificationMs)
  const hash = await keyedHash(context.env.CAPABILITY_SECRET, 'verification', capability)
  const email = await prepareServiceEmailEnqueue({ kind: 'verify-account', recipient: pending.delivery_email, capability, expiresAt, correlationId: context.requestId }, rootJobId, context)
  return { email, statement: context.env.DB!.prepare('INSERT INTO verification_capabilities (token_hash, pending_id, root_job_id, expires_at) VALUES (?, ?, ?, ?)').bind(hash, pending.id, rootJobId, expiresAt) }
}
async function signupStart(request: Request, context: ServiceContext): Promise<Response> {
  await requireSignup(context)
  const input = await readJson(request, SignupStartSchema, maxAuthJsonBytes)
  assertUsername(input.username)
  const email = normalizedEmail(input.email)
  await limitAuth(request, email, context, 'start')
  const db = context.env.DB!
  const now = context.now()
  const accountId = randomId(), attemptId = randomId()
  const credentialId = credentialIdForRole(accountId, 'password')
  let response: string
  try { response = await registrationResponse(context.env.OPAQUE_SERVER_SETUP!, credentialId, input.registrationRequest) }
  catch { throw new ApiFailure('INVALID_REQUEST') }
  // Expired reservations release names and invalidate outstanding delivery in the same batch
  const expired = await db.prepare('SELECT v.root_job_id FROM verification_capabilities v JOIN pending_registrations p ON p.id = v.pending_id WHERE v.consumed_at IS NULL AND p.expires_at <= ? AND (p.normalized_email = ? OR p.username = ?)').bind(now, email, input.username).all<{ root_job_id: string }>()
  await guarded(context, { sql: `SELECT NOT EXISTS (SELECT 1 FROM accounts WHERE normalized_email = ? OR username = ?) AND NOT EXISTS (SELECT 1 FROM pending_registrations WHERE expires_at > ? AND (normalized_email = ? OR username = ?))`, bindings: [email, input.username, now, email, input.username] }, [
    ...expired.results.map(row => emailInvalidationStatement(db, row.root_job_id)),
    db.prepare('DELETE FROM pending_registrations WHERE expires_at <= ? AND (normalized_email = ? OR username = ?)').bind(now, email, input.username),
    db.prepare('INSERT INTO pending_registrations (id, account_id, normalized_email, delivery_email, username, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(attemptId, accountId, email, input.email, input.username, now + pendingRegistrationMs, now),
  ])
  return jsonResponse({ attemptId, accountId, credentialId, registrationResponse: response, expiresAt: now + pendingRegistrationMs })
}
async function signupFinish(request: Request, context: ServiceContext): Promise<Response> {
  const input = await readJson(request, SignupFinishSchema, maxAuthJsonBytes)
  await limitAuth(request, `signup:${input.attemptId}`, context, 'finish')
  const db = context.env.DB!
  const digest = await keyedHash(context.env.CAPABILITY_SECRET, 'signup-command', JSON.stringify([input.attemptId, input.registrationRecord, input.accountEnvelope, input.remember]))
  const prior = await db.prepare('SELECT request_digest, receipt FROM auth_transactions WHERE id = ?').bind(input.transactionId).first<{ request_digest: string; receipt: string }>()
  if (prior) {
    if (prior.request_digest !== digest) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
    return jsonResponse(JSON.parse(prior.receipt))
  }
  await requireSignup(context)
  const pending = await db.prepare('SELECT * FROM pending_registrations WHERE id = ?').bind(input.attemptId).first<Pending>()
  if (!pending || pending.expires_at <= context.now()) throw new ApiFailure('INVALID_REQUEST')
  if (pending.transaction_id) {
    const raced = await db.prepare('SELECT request_digest, receipt FROM auth_transactions WHERE id = ?').bind(input.transactionId).first<{ request_digest: string; receipt: string }>()
    if (!raced) throw new ApiFailure('INVALID_REQUEST')
    if (raced.request_digest !== digest) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
    return jsonResponse(JSON.parse(raced.receipt))
  }
  const prepared = await prepareVerification(pending, context)
  const receipt = { pending: true, transactionId: input.transactionId }
  // The prepared email guard comes first so its bindings retain their SQL order
  // Credential material, authority, root linkage, outbox and retry receipt commit together
  context.checkpoint('auth.signup.before-batch')
  try {
    await guarded(context, { sql: `SELECT (${prepared.email.guard.sql}) AND EXISTS (SELECT 1 FROM pending_registrations WHERE id = ? AND expires_at > ? AND transaction_id IS NULL) AND NOT EXISTS (SELECT 1 FROM auth_transactions WHERE id = ?) AND EXISTS (SELECT 1 FROM service_settings WHERE id='service' AND registration_paused=0)`, bindings: [...prepared.email.guard.bindings, pending.id, context.now(), input.transactionId] }, [
      db.prepare('UPDATE pending_registrations SET registration_record = ?, account_envelope = ?, transaction_id = ?, verification_revision = 1 WHERE id = ?').bind(input.registrationRecord, JSON.stringify(input.accountEnvelope), input.transactionId, pending.id),
      prepared.statement, ...prepared.email.statements,
      db.prepare("INSERT INTO auth_transactions (id, account_id, attempt_id, kind, request_digest, receipt, created_at) VALUES (?, ?, ?, 'signup', ?, ?, ?)").bind(input.transactionId, pending.account_id, pending.id, digest, JSON.stringify(receipt), context.now()),
    ])
  } catch (error) {
    // A concurrent exact finish owns the same receipt; do not issue another capability
    if (!(error instanceof ApiFailure) || error.code !== 'INVALID_REQUEST') throw error
    const raced = await db.prepare('SELECT request_digest, receipt FROM auth_transactions WHERE id = ?').bind(input.transactionId).first<{ request_digest: string; receipt: string }>()
    if (!raced) throw error
    if (raced.request_digest !== digest) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
    return jsonResponse(JSON.parse(raced.receipt))
  }
  return jsonResponse(receipt)
}
async function verify(request: Request, context: ServiceContext): Promise<Response> {
  const input = await readJson(request, VerifySchema, maxAuthJsonBytes)
  await limitAuth(request, input.capability, context, 'verify')
  const hash = await keyedHash(context.env.CAPABILITY_SECRET, 'verification', input.capability)
  const db = context.env.DB!, now = context.now()
  const record = await db.prepare('SELECT p.*, v.root_job_id FROM verification_capabilities v JOIN pending_registrations p ON p.id = v.pending_id WHERE v.token_hash = ?').bind(hash).first<Pending & { root_job_id: string }>()
  if (!record) throw new ApiFailure('INVALID_REQUEST')
  context.checkpoint('auth.verify.before-batch')
  await guarded(context, { sql: `SELECT 1 FROM verification_capabilities v JOIN pending_registrations p ON p.id = v.pending_id WHERE v.token_hash = ? AND v.consumed_at IS NULL AND v.expires_at > ? AND p.expires_at > ? AND p.registration_record IS NOT NULL AND p.account_envelope IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE id = p.account_id OR normalized_email = p.normalized_email OR username = p.username)`, bindings: [hash, now, now] }, [
    db.prepare("INSERT INTO accounts (id, normalized_email, delivery_email, username, verified_at, capacity_bytes, created_at) SELECT account_id, normalized_email, delivery_email, username, ?, MIN(?,?,COALESCE((SELECT max_account_bytes FROM service_settings WHERE id='service'),?)), ? FROM pending_registrations WHERE id = ?").bind(now, defaultAccountCapacityBytes, Number(context.env.STORAGE_CAP_BYTES), Number(context.env.STORAGE_CAP_BYTES), now, record.id),
    db.prepare("INSERT INTO credentials (account_id, role, credential_id, record, account_envelope) SELECT account_id, 'password', ?, registration_record, account_envelope FROM pending_registrations WHERE id = ?").bind(credentialIdForRole(record.account_id, 'password'), record.id),
    db.prepare('UPDATE verification_capabilities SET consumed_at = ? WHERE token_hash = ?').bind(now, hash),
    emailInvalidationStatement(db, record.root_job_id),
    // Keep consumed hashes for replay rejection, but erase duplicated encrypted roots
    db.prepare('UPDATE pending_registrations SET registration_record = NULL, account_envelope = NULL WHERE id = ?').bind(record.id),
  ])
  return jsonResponse({ verified: true })
}
// Admin callers compose this same generation/recipient authority with their own final guard
export async function prepareVerificationResend(accountId: string, context: ServiceContext) {
  const db=context.env.DB!,now=context.now()
  const pending=await db.prepare('SELECT id,account_id,delivery_email,expires_at,verification_revision FROM pending_registrations WHERE account_id=? AND expires_at>? AND registration_record IS NOT NULL').bind(accountId,now).first<Pending>()
  if (!pending) throw new ApiFailure('NOT_FOUND')
  return preparePendingVerificationResend(pending,context)
}
async function preparePendingVerificationResend(pending:Pick<Pending,'id'|'account_id'|'delivery_email'|'expires_at'|'verification_revision'>,context:ServiceContext){
  const db=context.env.DB!,now=context.now()
  const old = await db.prepare('SELECT root_job_id FROM verification_capabilities WHERE pending_id = ? AND consumed_at IS NULL').bind(pending.id).all<{ root_job_id: string }>()
  const prepared = await prepareVerification(pending, context)
  return { revision:pending.verification_revision, jobId:prepared.email.jobId,
    guard:{sql:`SELECT (${prepared.email.guard.sql}) AND EXISTS (SELECT 1 FROM pending_registrations WHERE id=? AND expires_at>? AND registration_record IS NOT NULL AND verification_revision=?) AND NOT EXISTS (SELECT 1 FROM accounts WHERE id=?)`,bindings:[...prepared.email.guard.bindings,pending.id,now,pending.verification_revision,pending.account_id]},
    statements:[db.prepare('UPDATE pending_registrations SET verification_revision=verification_revision+1 WHERE id=?').bind(pending.id),db.prepare('UPDATE verification_capabilities SET consumed_at=? WHERE pending_id=? AND consumed_at IS NULL').bind(now,pending.id),...old.results.map(row=>emailInvalidationStatement(db,row.root_job_id)),prepared.statement,...prepared.email.statements],
  }
}
async function resend(request: Request, context: ServiceContext): Promise<Response> {
  await requireSignup(context)
  const input = await readJson(request, ResendSchema, maxAuthJsonBytes)
  const email = normalizedEmail(input.email)
  await limitAuth(request, email, context, 'resend')
  const db = context.env.DB!, now = context.now()
  const pending = await db.prepare('SELECT * FROM pending_registrations WHERE normalized_email = ? AND expires_at > ? AND registration_record IS NOT NULL').bind(email, now).first<Pending>()
  if (pending) {
    const prepared=await preparePendingVerificationResend(pending,context)
    // The generation guard prevents a delayed resend from missing a newer lineage
    // A raced activation or resend returns the same neutral pending receipt
    try {
      await guarded(context,prepared.guard,prepared.statements)
    } catch (error) { if (!(error instanceof ApiFailure) || error.code !== 'INVALID_REQUEST') throw error }
  }
  return jsonResponse({ pending: true })
}
async function loginStart(request: Request, context: ServiceContext): Promise<Response> {
  const input = await readJson(request, LoginStartSchema, maxAuthJsonBytes)
  const email = normalizedEmail(input.email)
  await limitAuth(request, email, context, 'start')
  const db = context.env.DB!, now = context.now()
  // Resolve identity independently of role existence so comparing role suffixes cannot reveal missing credentials
  // A missing role retains a null OPAQUE record and revision, never authentication authority
  const known = await db.prepare(`SELECT a.id AS account_id, c.record, c.revision FROM accounts a LEFT JOIN credentials c ON c.account_id = a.id AND c.role = ? WHERE a.normalized_email = ?`).bind(input.role, email).first<{ account_id: string; record: string | null; revision: number | null }>()
  const credentialId = known ? credentialIdForRole(known.account_id, input.role) : await dummyCredentialId(email, input.role, context)
  let login: { state: string; response: string }
  // Canonical byte lengths do not establish that a submitted group point is valid
  try { login = await startServerLogin(context.env.OPAQUE_SERVER_SETUP!, credentialId, known?.record ?? null, input.startLoginRequest) }
  catch { throw new ApiFailure('INVALID_REQUEST') }
  const attemptId = randomId()
  await db.batch([
    db.prepare('DELETE FROM auth_attempts WHERE expires_at <= ?').bind(now),
    db.prepare('INSERT INTO auth_attempts (id, account_id, role, credential_revision, server_state, expires_at) VALUES (?, ?, ?, ?, ?, ?)').bind(attemptId, known?.account_id ?? null, input.role, known?.revision ?? null, login.state, now + loginAttemptMs),
  ])
  return jsonResponse({ attemptId, credentialId, loginResponse: login.response, expiresAt: now + loginAttemptMs })
}
async function loginFinish(request: Request, context: ServiceContext): Promise<Response> {
  const input = await readJson(request, LoginFinishSchema, maxAuthJsonBytes)
  await limitAuth(request, `login:${input.attemptId}`, context, 'finish')
  const db = context.env.DB!, now = context.now()
  // Atomic consumption precedes expensive proof verification, including invalid finishes
  // A concurrent finish cannot reuse server state or create a second session
  const attempt = await db.prepare('DELETE FROM auth_attempts WHERE id = ? RETURNING *').bind(input.attemptId).first<Attempt>()
  if (!attempt || attempt.session_id !== null || attempt.expires_at <= now) throw new ApiFailure('AUTH_FAILED')
  await finishServerLogin(attempt.server_state, input.finishLoginRequest)
  if (!attempt.account_id) throw new ApiFailure('AUTH_FAILED')
  const deviceId = randomId()
  const prepared = await newSession(attempt.account_id, deviceId, input.remember, context)
  const incomingHash = await incomingSessionHash(request, context)
  context.checkpoint('auth.login.before-batch')
  await guarded(context, { sql: `SELECT 1 FROM accounts a JOIN credentials c ON c.account_id = a.id WHERE a.id = ? AND a.access IN ('active', 'read-only') AND c.role = ? AND c.revision = ?`, bindings: [attempt.account_id, attempt.role, attempt.credential_revision] }, [
    db.prepare('UPDATE customer_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').bind(now, incomingHash),
    db.prepare('INSERT INTO devices (id, account_id, created_at) VALUES (?, ?, ?)').bind(deviceId, attempt.account_id, now),
    prepared.statement,
  ], 'AUTH_FAILED')
  const credential = await db.prepare('SELECT account_envelope FROM credentials WHERE account_id = ? AND role = ? AND revision = ?').bind(attempt.account_id, attempt.role, attempt.credential_revision).first<{ account_envelope: string }>()
  if (!credential) throw new ApiFailure('AUTH_FAILED')
  return sessionResponse(prepared.session, prepared.token, context, JSON.parse(credential.account_envelope))
}
export async function authRoute(request: Request, context: ServiceContext): Promise<Response | null> {
  const deviceResponse = await deviceRoute(request, context)
  if (deviceResponse) return deviceResponse
  const credentialResponse = await credentialRoute(request, context)
  if (credentialResponse) return credentialResponse
  const path = new URL(request.url).pathname
  if (path.startsWith('/api/v1/auth/') && request.method === 'POST') {
    assertOrigin(request, context)
    switch (path) {
      case '/api/v1/auth/signup/start': return signupStart(request, context)
      case '/api/v1/auth/signup/finish': return signupFinish(request, context)
      case '/api/v1/auth/login/start': return loginStart(request, context)
      case '/api/v1/auth/login/finish': return loginFinish(request, context)
      case '/api/v1/auth/verify': return verify(request, context)
      case '/api/v1/auth/resend': return resend(request, context)
    }
  }
  if (path === '/api/v1/account' && request.method === 'GET') {
    const principal = await requireCustomer(request, context)
    const account = await context.env.DB!.prepare('SELECT username, delivery_email, verified_at, revision, capacity_bytes FROM accounts WHERE id = ?').bind(principal.accountId).first<{ username: string; delivery_email: string; verified_at: number; revision: number; capacity_bytes: number }>()
    const devices = await devicePage(principal, context)
    const revisions = await context.env.DB!.prepare('SELECT role, revision FROM credentials WHERE account_id = ?').bind(principal.accountId).all<{ role: string; revision: number }>()
    const credentials = { passwordRevision: revisions.results.find(row => row.role === 'password')!.revision, recoveryRevision: revisions.results.find(row => row.role === 'recovery')?.revision ?? null }
    return jsonResponse({ credentials, ...principal, username: account!.username, email: account!.delivery_email, verified: true, revision: account!.revision, quota: { capacityBytes: account!.capacity_bytes }, policy: sessionPolicy, devicePage: devices, csrf: await sessionCsrf(principal.sessionId, context) })
  }
  if (path === '/api/v1/account/sessions/revoke' && request.method === 'POST') {
    const principal = await requireCustomer(request, context)
    const input = await readJson(request, LogoutSchema, maxAuthJsonBytes)
    const db = context.env.DB!, now = context.now()
    // Ownership is neutral for foreign/missing targets and is checked again in the mutation batch
    const owned = await db.prepare('SELECT 1 FROM customer_sessions WHERE id = ? AND account_id = ?').bind(input.sessionId, principal.accountId).first()
    if (!owned) throw new ApiFailure('NOT_FOUND')
    await guarded(context, {
      sql: `${liveSessionSql} AND EXISTS (SELECT 1 FROM customer_sessions target WHERE target.id = ? AND target.account_id = ?)`,
      bindings: [principal.sessionId, principal.accountId, now, now, input.sessionId, principal.accountId],
    }, [db.prepare('UPDATE customer_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND account_id = ?').bind(now, input.sessionId, principal.accountId)], 'AUTH_REQUIRED')
    return jsonResponse({ revoked: true })
  }
  if (['/api/v1/auth/renew', '/api/v1/auth/logout'].includes(path) && request.method === 'POST') {
    const principal = await requireCustomer(request, context)
    const db = context.env.DB!, now = context.now()
    if (path.endsWith('/logout')) {
      const input = await readJson(request, LogoutSchema, maxAuthJsonBytes)
      if (input.sessionId !== principal.sessionId) return jsonResponse({ revoked: false })
      await guarded(context, { sql: liveSessionSql, bindings: [principal.sessionId, principal.accountId, now, now] }, [db.prepare('UPDATE customer_sessions SET revoked_at = ? WHERE id = ?').bind(now, principal.sessionId)], 'AUTH_REQUIRED')
      // A delayed clearing header could delete another tab's newer session cookie
      // Revocation removes authority; the residual HttpOnly cookie is replaced by the next login
      return jsonResponse({ revoked: true })
    }
    await readJson(request, z.strictObject({}), maxAuthJsonBytes)
    const previous = await db.prepare('SELECT * FROM customer_sessions WHERE id = ?').bind(principal.sessionId).first<SessionRow>()
    const prepared = await newSession(principal.accountId, principal.deviceId, !!previous!.remembered, context, previous!)
    await guarded(context, { sql: liveSessionSql, bindings: [principal.sessionId, principal.accountId, now, now] }, [db.prepare('UPDATE customer_sessions SET revoked_at = ? WHERE id = ?').bind(now, principal.sessionId), prepared.statement], 'AUTH_REQUIRED')
    return sessionResponse(prepared.session, prepared.token, context)
  }
  return null
}
