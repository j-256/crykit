import { base64urlSchema, digestBytes } from '../../src/account/protocol'
import type { ServiceContext } from '../context'
import { ApiFailure, jsonResponse } from '../http'
import { admitAccount } from '../admission'
import { guarded, keyedHash, randomId, randomToken } from './identity'

export const customerCookieName = '__Host-crykit-session'
const hour = 60 * 60 * 1000
const day = 24 * hour
export const recentAuthenticationMs = 10 * 60 * 1000
export const sessionPolicy = Object.freeze({ ordinary: { idleMs: 8 * hour, absoluteMs: day }, remembered: { idleMs: 7 * day, absoluteMs: 30 * day } })
export interface CustomerPrincipal {
  readonly accountId: string; readonly sessionId: string; readonly deviceId: string
  readonly authenticatedAt: number; readonly absoluteExpiresAt: number; readonly access: 'active' | 'read-only'
}
export interface SessionRow {
  id: string; token_hash: string; account_id: string; device_id: string; authenticated_at: number
  idle_expires_at: number; absolute_expires_at: number; remembered: number; revoked_at: number | null
}
// Reuse this complete predicate inside every later data mutation's guarded batch
// A principal is a captured identity, not durable authority after revocation
export const liveSessionSql = `SELECT 1 FROM customer_sessions s JOIN accounts a ON a.id = s.account_id JOIN devices d ON d.id = s.device_id AND d.account_id = a.id WHERE s.id = ? AND s.account_id = ? AND s.revoked_at IS NULL AND d.revoked_at IS NULL AND s.idle_expires_at > ? AND s.absolute_expires_at > ? AND a.access IN ('active', 'read-only')`
export function assertOrigin(request: Request, context: ServiceContext): void {
  const origin = request.headers.get('origin')
  if (origin !== context.env.SERVICE_ORIGIN) throw new ApiFailure('CSRF_FAILED')
}
export async function incomingSessionHash(request: Request, context: ServiceContext): Promise<string | null> {
  const values = (request.headers.get('cookie') ?? '').split(';').map(c => c.trim()).filter(c => c.startsWith(`${customerCookieName}=`))
  if (values.length !== 1) return null
  const token = values[0].slice(customerCookieName.length + 1)
  if (!base64urlSchema(digestBytes).safeParse(token).success) return null
  return keyedHash(context.env.SESSION_SECRET, 'customer-session', token)
}
export async function sessionCsrf(sessionId: string, context: ServiceContext): Promise<string> { return keyedHash(context.env.SESSION_SECRET, 'customer-csrf', sessionId) }
export async function requireCustomer(request: Request, context: ServiceContext): Promise<CustomerPrincipal> {
  const hash = await incomingSessionHash(request, context)
  if (!hash) throw new ApiFailure('AUTH_REQUIRED')
  const now = context.now()
  const row = await context.env.DB!.prepare(`SELECT s.*, a.access FROM customer_sessions s JOIN accounts a ON a.id = s.account_id JOIN devices d ON d.id = s.device_id AND d.account_id = a.id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND d.revoked_at IS NULL AND s.idle_expires_at > ? AND s.absolute_expires_at > ?`).bind(hash, now, now).first<SessionRow & { access: string }>()
  if (!row) {
    // Retained revoked cookies receive a restricted response while destruction is pending
    const deleting = await context.env.DB!.prepare("SELECT 1 FROM customer_sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND a.access = 'deleting'").bind(hash).first()
    throw new ApiFailure(deleting ? 'ACCOUNT_RESTRICTED' : 'AUTH_REQUIRED')
  }
  if (row.access !== 'active' && row.access !== 'read-only') throw new ApiFailure('ACCOUNT_RESTRICTED')
  if (!['GET', 'HEAD'].includes(request.method)) {
    assertOrigin(request, context)
    if (request.headers.get('x-csrf-token') !== await sessionCsrf(row.id, context)) throw new ApiFailure('CSRF_FAILED')
  } else if (request.headers.has('origin') && request.headers.get('origin') !== context.env.SERVICE_ORIGIN) throw new ApiFailure('CSRF_FAILED')
  await admitAccount(row.account_id, context)
  const policy = row.remembered ? sessionPolicy.remembered : sessionPolicy.ordinary
  await guarded(context, { sql: liveSessionSql, bindings: [row.id, row.account_id, now, now] }, [
    context.env.DB!.prepare('UPDATE customer_sessions SET idle_expires_at = MIN(?, absolute_expires_at) WHERE id = ?').bind(now + policy.idleMs, row.id),
  ], 'AUTH_REQUIRED')
  return { accountId: row.account_id, sessionId: row.id, deviceId: row.device_id, authenticatedAt: row.authenticated_at, absoluteExpiresAt: row.absolute_expires_at, access: row.access }
}
export function requireRecent(principal: CustomerPrincipal, now: number): void {
  if (now < principal.authenticatedAt || now - principal.authenticatedAt >= recentAuthenticationMs) throw new ApiFailure('AUTH_REQUIRED')
}
export async function assertCustomerWrite(principal: CustomerPrincipal, operation: 'upload' | 'commit' | 'publish', context: ServiceContext): Promise<void> {
  if (!['upload', 'commit', 'publish'].includes(operation)) throw new ApiFailure('FORBIDDEN')
  const now = context.now()
  const allowed = await context.env.DB!.prepare(`${liveSessionSql} AND a.access = 'active' AND a.verified_at IS NOT NULL AND EXISTS (SELECT 1 FROM service_settings WHERE id='service' AND ${operation === 'publish' ? 'sharing_paused' : 'uploads_paused'}=0)`).bind(principal.sessionId, principal.accountId, now, now).first()
  if (!allowed) throw new ApiFailure('FORBIDDEN')
}
export async function newSession(accountId: string, deviceId: string, remembered: boolean, context: ServiceContext, previous?: SessionRow) {
  const policy = remembered ? sessionPolicy.remembered : sessionPolicy.ordinary
  const now = context.now()
  const token = randomToken()
  const session: SessionRow = { id: randomId(), token_hash: await keyedHash(context.env.SESSION_SECRET, 'customer-session', token), account_id: accountId, device_id: deviceId, authenticated_at: previous?.authenticated_at ?? now, idle_expires_at: Math.min(now + policy.idleMs, previous?.absolute_expires_at ?? now + policy.absoluteMs), absolute_expires_at: previous?.absolute_expires_at ?? now + policy.absoluteMs, remembered: remembered ? 1 : 0, revoked_at: null }
  return { session, token, statement: context.env.DB!.prepare('INSERT INTO customer_sessions (id, token_hash, account_id, device_id, authenticated_at, idle_expires_at, absolute_expires_at, remembered) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(session.id, session.token_hash, accountId, deviceId, session.authenticated_at, session.idle_expires_at, session.absolute_expires_at, session.remembered) }
}
export async function sessionResponse(row: SessionRow, token: string, context: ServiceContext, accountEnvelope?: unknown): Promise<Response> {
  const account = await context.env.DB!.prepare('SELECT username FROM accounts WHERE id = ?').bind(row.account_id).first<{ username: string }>()
  const response = jsonResponse({ accountId: row.account_id, username: account!.username, sessionId: row.id, deviceId: row.device_id, csrf: await sessionCsrf(row.id, context), authenticatedAt: row.authenticated_at, ...(accountEnvelope ? { accountEnvelope } : {}) })
  const lifetime = row.remembered ? `; Max-Age=${Math.max(0, Math.floor((row.absolute_expires_at - context.now()) / 1000))}` : ''
  response.headers.set('set-cookie', `${customerCookieName}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/${lifetime}`)
  return response
}
