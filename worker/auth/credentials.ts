import { CredentialCommitSchema, credentialIdForRole, CredentialStartSchema, EmailChangeSchema, maxAuthJsonBytes, OpaqueIdSchema, ReauthFinishSchema, ReauthStartSchema, UsernameChangeSchema, VerifySchema } from '../../src/account/protocol'
import type { ServiceContext } from '../context'
import { emailInvalidationStatement, prepareServiceEmailEnqueue } from '../email/jobs'
import { serviceEmailAvailable } from '../email/native'
import { ApiFailure, jsonResponse, readJson } from '../http'
import { assertUsername, guarded, keyedHash, loginAttemptMs, normalizedEmail, randomId, randomToken, verificationMs } from './identity'
import { finishServerLogin, registrationResponse, startServerLogin } from './opaque'
import { limitAuth } from './rate-limits'
import { liveSessionSql, recentAuthenticationMs, requireCustomer, requireRecent, type CustomerPrincipal } from './session'

interface Registration { transaction_id: string; account_id: string; session_id: string; role: 'password' | 'recovery'; credential_revision: number; request_digest: string; response: string; expires_at: number }
interface Transaction { account_id: string; kind: string; request_digest: string; receipt: string }
function authority(principal: CustomerPrincipal, context: ServiceContext, recent = true) {
  const now = context.now()
  // Recheck time and moderation in the same transaction as activation, not only at route entry
  return { sql: `${liveSessionSql} AND a.access = 'active'${recent ? ' AND s.authenticated_at <= ? AND s.authenticated_at > ?' : ''}`, bindings: [principal.sessionId, principal.accountId, now, now, ...(recent ? [now, now - recentAuthenticationMs] : [])] }
}
async function digest(input: object, context: ServiceContext): Promise<string> { return keyedHash(context.env.CAPABILITY_SECRET, 'account-command', JSON.stringify(input)) }
async function priorReceipt(transactionId: string, principal: CustomerPrincipal, kind: string, hash: string, context: ServiceContext) {
  const prior = await context.env.DB!.prepare('SELECT account_id, kind, request_digest, receipt FROM auth_transactions WHERE id = ?').bind(transactionId).first<Transaction>()
  if (!prior) return null
  if (prior.account_id !== principal.accountId || prior.kind !== kind || prior.request_digest !== hash) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
  return jsonResponse(JSON.parse(prior.receipt))
}
function receiptStatement(transactionId: string, principal: CustomerPrincipal, kind: string, hash: string, receipt: object, context: ServiceContext) {
  return context.env.DB!.prepare('INSERT INTO auth_transactions (id, account_id, attempt_id, kind, request_digest, receipt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(transactionId, principal.accountId, transactionId, kind, hash, JSON.stringify(receipt), context.now())
}
async function credentialStart(request: Request, principal: CustomerPrincipal, context: ServiceContext) {
  requireRecent(principal, context.now())
  const input = await readJson(request, CredentialStartSchema, maxAuthJsonBytes)
  await limitAuth(request, principal.accountId, context, 'start')
  const db = context.env.DB!, hash = await digest(input, context)
  const previous = await db.prepare('SELECT * FROM credential_registrations WHERE transaction_id = ?').bind(input.transactionId).first<Registration>()
  if (previous) {
    if (previous.account_id !== principal.accountId || previous.session_id !== principal.sessionId || previous.request_digest !== hash) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
    if (previous.expires_at <= context.now()) throw new ApiFailure('INVALID_REQUEST')
    return jsonResponse(JSON.parse(previous.response))
  }
  const revision = await db.prepare('SELECT revision FROM credentials WHERE account_id = ? AND role = ?').bind(principal.accountId, input.role).first<number>('revision') ?? 0
  const credentialId = credentialIdForRole(principal.accountId, input.role)
  let response: string
  try { response = await registrationResponse(context.env.OPAQUE_SERVER_SETUP!, credentialId, input.registrationRequest) }
  catch { throw new ApiFailure('INVALID_REQUEST') }
  const receipt = { credentialId, registrationResponse: response }, guard = authority(principal, context)
  await guarded(context, { sql: `SELECT EXISTS (${guard.sql}) AND NOT EXISTS (SELECT 1 FROM auth_transactions WHERE id = ?) AND COALESCE((SELECT revision FROM credentials WHERE account_id = ? AND role = ?), 0) = ?`, bindings: [...guard.bindings, input.transactionId, principal.accountId, input.role, revision] }, [
    db.prepare('INSERT INTO credential_registrations (transaction_id, account_id, session_id, role, credential_revision, request_digest, response, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(input.transactionId, principal.accountId, principal.sessionId, input.role, revision, hash, JSON.stringify(receipt), context.now() + loginAttemptMs),
  ], 'HEAD_CONFLICT')
  return jsonResponse(receipt)
}
async function credentialCommit(request: Request, principal: CustomerPrincipal, context: ServiceContext) {
  const input = await readJson(request, CredentialCommitSchema, maxAuthJsonBytes)
  const hash = await digest(input, context), kind = `credential:${input.role}`
  const prior = await priorReceipt(input.transactionId, principal, kind, hash, context)
  if (prior) return prior
  requireRecent(principal, context.now())
  const db = context.env.DB!, receipt = { transactionId: input.transactionId, credentialRevision: input.expectedCredentialRevision + 1, completed: true }
  context.checkpoint('auth.credentials.before-batch')
  const guard = authority(principal, context)
  try {
    await guarded(context, { sql: `SELECT EXISTS (${guard.sql}) AND EXISTS (SELECT 1 FROM credential_registrations WHERE transaction_id = ? AND account_id = ? AND session_id = ? AND role = ? AND credential_revision = ? AND expires_at > ?) AND COALESCE((SELECT revision FROM credentials WHERE account_id = ? AND role = ?), 0) = ? AND NOT EXISTS (SELECT 1 FROM auth_transactions WHERE id = ?)`, bindings: [...guard.bindings, input.transactionId, principal.accountId, principal.sessionId, input.role, input.expectedCredentialRevision, context.now(), principal.accountId, input.role, input.expectedCredentialRevision, input.transactionId] }, [
      db.prepare('INSERT INTO credentials (account_id, role, credential_id, record, account_envelope, revision) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, role) DO UPDATE SET record = excluded.record, account_envelope = excluded.account_envelope, revision = excluded.revision').bind(principal.accountId, input.role, credentialIdForRole(principal.accountId, input.role), input.registrationRecord, JSON.stringify(input.accountEnvelope), receipt.credentialRevision),
      db.prepare('UPDATE customer_sessions SET revoked_at = ? WHERE account_id = ? AND id != ? AND revoked_at IS NULL').bind(context.now(), principal.accountId, principal.sessionId),
      receiptStatement(input.transactionId, principal, kind, hash, receipt, context),
    ], 'HEAD_CONFLICT')
  } catch (error) {
    if (!(error instanceof ApiFailure) || error.code !== 'HEAD_CONFLICT') throw error
    const raced = await priorReceipt(input.transactionId, principal, kind, hash, context)
    if (raced) return raced
    throw error
  }
  context.checkpoint('auth.credentials.after-batch')
  return jsonResponse(receipt)
}
async function reauthenticate(request: Request, principal: CustomerPrincipal, context: ServiceContext, finish: boolean) {
  const db = context.env.DB!
  if (!finish) {
    const input = await readJson(request, ReauthStartSchema, maxAuthJsonBytes)
    await limitAuth(request, principal.accountId, context, 'start')
    const credential = await db.prepare('SELECT record, revision FROM credentials WHERE account_id = ? AND role = ?').bind(principal.accountId, input.role).first<{ record: string; revision: number }>()
    const credentialId = credentialIdForRole(principal.accountId, input.role)
    let login: { state: string; response: string }
    try { login = await startServerLogin(context.env.OPAQUE_SERVER_SETUP!, credentialId, credential?.record ?? null, input.startLoginRequest) }
    catch { throw new ApiFailure('INVALID_REQUEST') }
    const attemptId = randomId(), expiresAt = context.now() + loginAttemptMs, guard = authority(principal, context, false)
    await guarded(context, guard, [db.prepare('INSERT INTO auth_attempts (id, account_id, role, credential_revision, server_state, expires_at, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(attemptId, principal.accountId, input.role, credential?.revision ?? null, login.state, expiresAt, principal.sessionId)], 'AUTH_REQUIRED')
    return jsonResponse({ attemptId, credentialId, loginResponse: login.response, expiresAt })
  }
  const input = await readJson(request, ReauthFinishSchema, maxAuthJsonBytes)
  await limitAuth(request, principal.accountId, context, 'finish')
  const attempt = await db.prepare('DELETE FROM auth_attempts WHERE id = ? AND session_id = ? AND account_id = ? RETURNING *').bind(input.attemptId, principal.sessionId, principal.accountId).first<{ role: string; credential_revision: number | null; server_state: string; expires_at: number }>()
  if (!attempt || attempt.expires_at <= context.now()) throw new ApiFailure('AUTH_FAILED')
  await finishServerLogin(attempt.server_state, input.finishLoginRequest)
  context.checkpoint('auth.reauth.before-batch')
  const guard = authority(principal, context, false), authenticatedAt = context.now()
  await guarded(context, { sql: `SELECT EXISTS (${guard.sql}) AND EXISTS (SELECT 1 FROM credentials WHERE account_id = ? AND role = ? AND revision = ?)`, bindings: [...guard.bindings, principal.accountId, attempt.role, attempt.credential_revision] }, [db.prepare('UPDATE customer_sessions SET authenticated_at = ? WHERE id = ?').bind(authenticatedAt, principal.sessionId)], 'AUTH_FAILED')
  return jsonResponse({ authenticatedAt })
}
async function usernameChange(request: Request, principal: CustomerPrincipal, context: ServiceContext) {
  const input = await readJson(request, UsernameChangeSchema, maxAuthJsonBytes), hash = await digest(input, context)
  const prior = await priorReceipt(input.transactionId, principal, 'username', hash, context)
  if (prior) return prior
  requireRecent(principal, context.now()); assertUsername(input.username)
  const guard = authority(principal, context), db = context.env.DB!
  const receipt = { transactionId: input.transactionId, revision: input.expectedRevision + 1, username: input.username, completed: true }
  try {
    await guarded(context, { sql: `SELECT EXISTS (${guard.sql}) AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND revision = ?) AND NOT EXISTS (SELECT 1 FROM accounts WHERE username = ? AND id != ?) AND NOT EXISTS (SELECT 1 FROM pending_registrations WHERE username = ? AND expires_at > ?) AND NOT EXISTS (SELECT 1 FROM auth_transactions WHERE id = ?)`, bindings: [...guard.bindings, principal.accountId, input.expectedRevision, input.username, principal.accountId, input.username, context.now(), input.transactionId] }, [
      // Strict normalized names make equality authoritative; reusing a withheld name cannot clear moderation
      db.prepare('UPDATE accounts SET username_withheld = CASE WHEN username <> ? THEN 0 ELSE username_withheld END, username = ?, revision = revision + 1 WHERE id = ?').bind(input.username, input.username, principal.accountId), receiptStatement(input.transactionId, principal, 'username', hash, receipt, context),
    ], 'HEAD_CONFLICT')
  } catch (error) {
    if (!(error instanceof ApiFailure) || error.code !== 'HEAD_CONFLICT') throw error
    const raced = await priorReceipt(input.transactionId, principal, 'username', hash, context)
    if (raced) return raced
    throw error
  }
  return jsonResponse(receipt)
}
async function emailStart(request: Request, principal: CustomerPrincipal, context: ServiceContext) {
  const input = await readJson(request, EmailChangeSchema, maxAuthJsonBytes), hash = await digest(input, context)
  const prior = await priorReceipt(input.transactionId, principal, 'email', hash, context)
  if (prior) return jsonResponse({ pending: true })
  requireRecent(principal, context.now())
  if (!serviceEmailAvailable(context)) throw new ApiFailure('SERVICE_UNAVAILABLE')
  await limitAuth(request, principal.accountId, context, 'resend')
  const db = context.env.DB!, capability = randomToken(), rootJobId = randomId(), expiresAt = context.now() + verificationMs
  const tokenHash = await keyedHash(context.env.CAPABILITY_SECRET, 'email-change', capability)
  const email = await prepareServiceEmailEnqueue({ kind: 'verify-email', recipient: input.email, capability, expiresAt, correlationId: context.requestId }, rootJobId, context)
  const old = await db.prepare('SELECT transaction_id, root_job_id FROM pending_email_changes WHERE account_id = ? AND consumed_at IS NULL').bind(principal.accountId).all<{ transaction_id: string; root_job_id: string }>()
  context.checkpoint('auth.email.before-batch')
  const guard = authority(principal, context)
  // Advancing account revision reserves a generation, so a racing replacement cannot miss a lineage
  try {
    await guarded(context, { sql: `SELECT (${email.guard.sql}) AND EXISTS (${guard.sql}) AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND revision = ? AND normalized_email != ?) AND NOT EXISTS (SELECT 1 FROM accounts WHERE normalized_email = ?) AND NOT EXISTS (SELECT 1 FROM pending_registrations WHERE normalized_email = ? AND expires_at > ?) AND NOT EXISTS (SELECT 1 FROM auth_transactions WHERE id = ?)`, bindings: [...email.guard.bindings, ...guard.bindings, principal.accountId, input.expectedRevision, normalizedEmail(input.email), normalizedEmail(input.email), normalizedEmail(input.email), context.now(), input.transactionId] }, [
      db.prepare('UPDATE accounts SET revision = revision + 1 WHERE id = ?').bind(principal.accountId),
      db.prepare('UPDATE pending_email_changes SET consumed_at = ? WHERE account_id = ? AND consumed_at IS NULL').bind(context.now(), principal.accountId),
      ...old.results.map(row => emailInvalidationStatement(db, row.root_job_id)),
      db.prepare('INSERT INTO pending_email_changes (transaction_id, account_id, account_revision, normalized_email, delivery_email, token_hash, root_job_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(input.transactionId, principal.accountId, input.expectedRevision + 1, normalizedEmail(input.email), input.email, tokenHash, rootJobId, expiresAt),
      ...email.statements, receiptStatement(input.transactionId, principal, 'email', hash, { pending: true }, context),
    ], 'HEAD_CONFLICT')
  } catch (error) {
    if (!(error instanceof ApiFailure) || error.code !== 'HEAD_CONFLICT') throw error
    const raced = await priorReceipt(input.transactionId, principal, 'email', hash, context)
    if (raced) return jsonResponse({ pending: true })
    throw error
  }
  return jsonResponse({ pending: true })
}
async function emailConfirm(request: Request, principal: CustomerPrincipal, context: ServiceContext) {
  requireRecent(principal, context.now())
  const input = await readJson(request, VerifySchema, maxAuthJsonBytes)
  await limitAuth(request, principal.accountId, context, 'verify')
  const hash = await keyedHash(context.env.CAPABILITY_SECRET, 'email-change', input.capability), db = context.env.DB!
  const pending = await db.prepare('SELECT p.*, a.delivery_email AS old_email, a.revision AS current_revision FROM pending_email_changes p JOIN accounts a ON a.id = p.account_id WHERE p.token_hash = ? AND p.account_id = ?').bind(hash, principal.accountId).first<{ transaction_id: string; account_revision: number; current_revision: number; normalized_email: string; delivery_email: string; old_email: string; root_job_id: string; consumed_at: number | null }>()
  if (!pending || pending.consumed_at !== null) throw new ApiFailure('INVALID_REQUEST')
  const noticeId = randomId()
  const notice = await prepareServiceEmailEnqueue({ kind: 'security-notice', recipient: pending.old_email, correlationId: context.requestId }, noticeId, context)
  context.checkpoint('auth.email-confirm.before-batch')
  const guard = authority(principal, context), receipt = { transactionId: pending.transaction_id, revision: pending.current_revision + 1, completed: true }
  await guarded(context, { sql: `SELECT (${notice.guard.sql}) AND EXISTS (${guard.sql}) AND EXISTS (SELECT 1 FROM pending_email_changes WHERE token_hash = ? AND account_id = ? AND consumed_at IS NULL AND expires_at > ?) AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND revision = ?) AND NOT EXISTS (SELECT 1 FROM accounts WHERE normalized_email = ? AND id != ?) AND NOT EXISTS (SELECT 1 FROM pending_registrations WHERE normalized_email = ? AND expires_at > ?)`, bindings: [...notice.guard.bindings, ...guard.bindings, hash, principal.accountId, context.now(), principal.accountId, pending.current_revision, pending.normalized_email, principal.accountId, pending.normalized_email, context.now()] }, [
    db.prepare('UPDATE accounts SET normalized_email = ?, delivery_email = ?, revision = revision + 1 WHERE id = ?').bind(pending.normalized_email, pending.delivery_email, principal.accountId),
    db.prepare('UPDATE pending_email_changes SET consumed_at = ? WHERE token_hash = ?').bind(context.now(), hash), emailInvalidationStatement(db, pending.root_job_id),
    db.prepare('INSERT INTO account_security_notices (transaction_id, account_id, root_job_id, created_at) VALUES (?, ?, ?, ?)').bind(pending.transaction_id, principal.accountId, noticeId, context.now()), ...notice.statements,
    db.prepare('UPDATE auth_transactions SET receipt = ? WHERE id = ? AND account_id = ?').bind(JSON.stringify(receipt), pending.transaction_id, principal.accountId),
  ], 'HEAD_CONFLICT')
  return jsonResponse(receipt)
}
export async function credentialRoute(request: Request, context: ServiceContext): Promise<Response | null> {
  const path = new URL(request.url).pathname
  const transactionPrefix = '/api/v1/account/transactions/'
  const routes = ['credentials/start', 'credentials/commit', 'reauth/start', 'reauth/finish', 'email/start', 'email/confirm']
  const route = path.slice('/api/v1/account/'.length)
  if (!(path.startsWith(transactionPrefix) && request.method === 'GET') && !(path.startsWith('/api/v1/account/') && routes.includes(route) && request.method === 'POST') && !(path === '/api/v1/account/username' && request.method === 'PATCH')) return null
  const principal = await requireCustomer(request, context)
  if (path.startsWith(transactionPrefix)) {
    const parsed = OpaqueIdSchema.safeParse(path.slice(transactionPrefix.length))
    if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
    const receipt = await context.env.DB!.prepare('SELECT receipt FROM auth_transactions WHERE id = ? AND account_id = ? AND kind != ?').bind(parsed.data, principal.accountId, 'signup').first<string>('receipt')
    if (!receipt) throw new ApiFailure('NOT_FOUND')
    return jsonResponse(JSON.parse(receipt))
  }
  switch (route) {
    case 'credentials/start': return credentialStart(request, principal, context)
    case 'credentials/commit': return credentialCommit(request, principal, context)
    case 'reauth/start': return reauthenticate(request, principal, context, false)
    case 'reauth/finish': return reauthenticate(request, principal, context, true)
    case 'email/start': return emailStart(request, principal, context)
    case 'email/confirm': return emailConfirm(request, principal, context)
    case 'username': return usernameChange(request, principal, context)
  }
  return null
}
