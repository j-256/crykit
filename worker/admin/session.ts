import { commitAdminBatch } from './audit'
import { adminCommandRoute } from './commands'
import { acceptAdminInvitationRoute, prepareAdminInvitation } from './invitations'
import { adminQuery } from './queries'
import { z } from 'zod'
import { base64urlSchema, digestBytes, OpaqueIdSchema } from '../../src/account/protocol'
import { guarded, keyedHash, randomId, randomToken } from '../auth/identity'
import { assertOrigin } from '../auth/session'
import type { ServiceContext } from '../context'
import type { SqlGuard } from '../db/guarded-batch'
import { ApiFailure, jsonResponse, readJson } from '../http'
import { adminConfig, adminLimits, verifyAccessIdentity, type AccessIdentity } from './auth'

export const adminCookieName = '__Host-crykit-admin-session'
export const accessCookieName = '__Host-crykit-admin-access'
export interface OperatorPrincipal {
  readonly operatorId: string
  readonly issuer: string
  readonly subject: string
  readonly role: 'owner' | 'administrator'
  readonly membershipRevision: number
  readonly adminSessionId: string
  readonly tokenExpiresAt: number
}
interface Membership {
  id: string
  issuer: string
  subject: string
  role: OperatorPrincipal['role']
  revision: number
}
interface Session {
  id: string
  expires_at: number
  issuer: string
  subject: string
}
const digestSchema = base64urlSchema(digestBytes)
const jsonBytes = 2048
const auditRetentionMs = 90 * 24 * 60 * 60 * 1000
const cleanupLimit = 100
// The command layer owns policy; these describe only the session capabilities implemented here
const sessionPermissions = Object.freeze(['session:read', 'confirmation:create'])
export async function adminCsrf(sessionId: string, context: ServiceContext): Promise<string> {
  return keyedHash(context.env.SESSION_SECRET, 'admin-csrf', sessionId)
}
async function cookieHash(request: Request, name: string, context: ServiceContext): Promise<string | null> {
  const cookies = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${name}=`))
  if (cookies.length !== 1) return null
  const token = cookies[0].slice(name.length + 1)
  if (!digestSchema.safeParse(token).success) return null
  return keyedHash(context.env.SESSION_SECRET, name, token)
}
async function membership(identity: AccessIdentity, context: ServiceContext): Promise<Membership> {
  const member = await context.env
    .DB!.prepare(
      "SELECT id,issuer,subject,role,revision FROM operators WHERE issuer=? AND subject=? AND state='active'",
    )
    .bind(identity.issuer, identity.subject)
    .first<Membership>()
  if (!member) throw new ApiFailure('FORBIDDEN')
  return member
}
async function csrf(request: Request, sessionId: string, context: ServiceContext): Promise<void> {
  if (!['GET', 'HEAD'].includes(request.method)) {
    assertOrigin(request, context)
    if (request.headers.get('x-csrf-token') !== (await adminCsrf(sessionId, context)))
      throw new ApiFailure('CSRF_FAILED')
  } else if (request.headers.has('origin')) assertOrigin(request, context)
}
// Commands must compose this captured authority into the command transaction, not trust an earlier read
export function operatorGuard(actor: OperatorPrincipal, context: ServiceContext): SqlGuard {
  return {
    sql: `SELECT 1 FROM operators o JOIN admin_sessions s ON s.operator_id=o.id WHERE o.id=? AND o.issuer=? AND o.subject=? AND o.role=? AND o.state='active' AND o.revision=? AND s.id=? AND s.membership_revision=o.revision AND s.revoked_at IS NULL AND s.expires_at>? AND ?>?`,
    bindings: [
      actor.operatorId,
      actor.issuer,
      actor.subject,
      actor.role,
      actor.membershipRevision,
      actor.adminSessionId,
      context.now(),
      actor.tokenExpiresAt,
      context.now(),
    ],
  }
}
async function existingOperator(
  request: Request,
  identity: AccessIdentity,
  context: ServiceContext,
): Promise<OperatorPrincipal> {
  const member = await membership(identity, context)
  const hash = await cookieHash(request, adminCookieName, context)
  const session =
    hash &&
    (await context.env
      .DB!.prepare(
        'SELECT id,expires_at FROM admin_sessions WHERE token_hash=? AND operator_id=? AND membership_revision=? AND revoked_at IS NULL AND expires_at>?',
      )
      .bind(hash, member.id, member.revision, context.now())
      .first<Session>())
  if (!session) throw new ApiFailure('FORBIDDEN')
  await csrf(request, session.id, context)
  return {
    operatorId: member.id,
    issuer: member.issuer,
    subject: member.subject,
    role: member.role,
    membershipRevision: member.revision,
    adminSessionId: session.id,
    tokenExpiresAt: Math.min(identity.tokenExpiresAt, session.expires_at),
  }
}
export async function requireOperator(request: Request, context: ServiceContext): Promise<OperatorPrincipal> {
  return existingOperator(request, await verifyAccessIdentity(request, context, 'admin'), context)
}
export async function requireAccessSession(request: Request, context: ServiceContext) {
  const identity = await verifyAccessIdentity(request, context, 'admin')
  const hash = await cookieHash(request, accessCookieName, context)
  const session =
    hash &&
    (await context.env
      .DB!.prepare(
        'SELECT id,expires_at FROM admin_access_sessions WHERE token_hash=? AND issuer=? AND subject=? AND revoked_at IS NULL AND expires_at>?',
      )
      .bind(hash, identity.issuer, identity.subject, context.now())
      .first<Session>())
  if (!session) throw new ApiFailure('FORBIDDEN')
  await csrf(request, session.id, context)
  return { identity, sessionId: session.id, expiresAt: Math.min(identity.tokenExpiresAt, session.expires_at) }
}
function setCookie(response: Response, name: string, token: string, expiresAt: number, context: ServiceContext) {
  response.headers.set(
    'set-cookie',
    `${name}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor((expiresAt - context.now()) / 1000))}`,
  )
}
async function openSession(request: Request, context: ServiceContext, preMembership: boolean): Promise<Response> {
  const identity = await verifyAccessIdentity(request, context, 'admin')
  const member = preMembership ? undefined : await membership(identity, context)
  if (request.headers.has('origin')) assertOrigin(request, context)
  const name = preMembership ? accessCookieName : adminCookieName
  const hash = await cookieHash(request, name, context)
  if (hash) {
    const existing = preMembership
      ? await requireAccessSession(request, context)
      : await existingOperator(request, identity, context)
    const sessionId = 'sessionId' in existing ? existing.sessionId : existing.adminSessionId
    return jsonResponse({
      sessionId,
      csrf: await adminCsrf(sessionId, context),
      expiresAt: 'expiresAt' in existing ? existing.expiresAt : existing.tokenExpiresAt,
      ...(member ? { role: member.role, permissions: sessionPermissions } : { invitationAcceptanceOnly: true }),
    })
  }
  const id = randomId(),
    token = randomToken(),
    expiresAt = Math.min(identity.tokenExpiresAt, context.now() + adminLimits.sessionMs)
  const tokenHash = await keyedHash(context.env.SESSION_SECRET, name, token)
  const db = context.env.DB!
  if (member) {
    await commitAdminBatch(
      {
        sql: "SELECT 1 FROM operators WHERE id=? AND issuer=? AND subject=? AND state='active' AND revision=?",
        bindings: [member.id, identity.issuer, identity.subject, member.revision],
      },
      [
        db
          .prepare(
            'INSERT INTO admin_sessions (id,token_hash,operator_id,membership_revision,created_at,expires_at) VALUES (?,?,?,?,?,?)',
          )
          .bind(id, tokenHash, member.id, member.revision, context.now(), expiresAt),
        // Only a newly authenticated app session creates an audit; routine refreshes reuse it
        db
          .prepare(
            "INSERT INTO admin_audit(id,actor_id,action,target_kind,target_id,outcome,request_id,created_at) VALUES (?,?,'session.login','operator',?,'complete',?,?)",
          )
          .bind(randomId(), member.id, member.id, context.requestId, context.now()),
      ],
      context,
      'FORBIDDEN',
    )
  } else
    await db
      .prepare(
        'INSERT INTO admin_access_sessions (id,token_hash,issuer,subject,created_at,expires_at) VALUES (?,?,?,?,?,?)',
      )
      .bind(id, tokenHash, identity.issuer, identity.subject, context.now(), expiresAt)
      .run()
  const response = jsonResponse({
    sessionId: id,
    csrf: await adminCsrf(id, context),
    expiresAt,
    ...(member ? { role: member.role, permissions: sessionPermissions } : { invitationAcceptanceOnly: true }),
  })
  setCookie(response, name, token, expiresAt, context)
  return response
}
export function actionConfirmationGuard(
  actor: OperatorPrincipal,
  commandDigest: string,
  context: ServiceContext,
): SqlGuard {
  if (!adminConfig(context).confirmationEnabled) throw new ApiFailure('FORBIDDEN')
  if (!digestSchema.safeParse(commandDigest).success) throw new ApiFailure('INVALID_REQUEST')
  const live = operatorGuard(actor, context)
  return {
    sql: `${live.sql} AND EXISTS (SELECT 1 FROM admin_confirmations c WHERE c.operator_id=o.id AND c.session_id=s.id AND c.membership_revision=o.revision AND c.command_digest=? AND c.confirmed_until>?)`,
    bindings: [...live.bindings, commandDigest, context.now()],
  }
}
export async function requireActionConfirmation(
  actor: OperatorPrincipal,
  commandDigest: string,
  context: ServiceContext,
): Promise<void> {
  const guard = actionConfirmationGuard(actor, commandDigest, context)
  if (
    !(await context.env
      .DB!.prepare(guard.sql)
      .bind(...guard.bindings)
      .first())
  )
    throw new ApiFailure('FORBIDDEN')
}
async function challenge(request: Request, context: ServiceContext): Promise<Response> {
  const actor = await requireOperator(request, context)
  if (!adminConfig(context).confirmationEnabled) throw new ApiFailure('FORBIDDEN')
  const input = await readJson(request, z.strictObject({ commandDigest: digestSchema }), jsonBytes)
  const id = randomId(),
    expiresAt = Math.min(context.now() + adminLimits.confirmationMs, actor.tokenExpiresAt)
  await guarded(
    context,
    operatorGuard(actor, context),
    [
      context.env
        .DB!.prepare(
          'INSERT INTO admin_confirmations (id,operator_id,session_id,membership_revision,command_digest,created_at,expires_at) VALUES (?,?,?,?,?,?,?)',
        )
        .bind(
          id,
          actor.operatorId,
          actor.adminSessionId,
          actor.membershipRevision,
          input.commandDigest,
          context.now(),
          expiresAt,
        ),
    ],
    'FORBIDDEN',
  )
  return jsonResponse({ challengeId: id, expiresAt, confirmationPath: '/admin/confirm/' })
}
async function complete(request: Request, context: ServiceContext): Promise<Response> {
  let identity: AccessIdentity
  try {
    identity = await verifyAccessIdentity(request, context, 'confirmation')
  } catch {
    throw new ApiFailure('FORBIDDEN')
  }
  const actor = await existingOperator(request, identity, context)
  const input = await readJson(request, z.strictObject({ challengeId: OpaqueIdSchema }), jsonBytes)
  const guard = operatorGuard(actor, context)
  // The challenge cannot move to a different actor, session, membership revision or command
  // Replays preserve the original deadline; a refreshed ordinary token cannot extend it
  await guarded(
    context,
    {
      sql: `${guard.sql} AND EXISTS (SELECT 1 FROM admin_confirmations WHERE id=? AND operator_id=o.id AND session_id=s.id AND membership_revision=o.revision AND expires_at>? AND (confirmed_until IS NULL OR confirmed_until>?))`,
      bindings: [...guard.bindings, input.challengeId, context.now(), context.now()],
    },
    [
      context.env
        .DB!.prepare(
          "INSERT INTO admin_security_audit (id,actor_id,action,target_id,request_id,created_at) SELECT ?,?,'action-confirmation',?,?,? WHERE EXISTS (SELECT 1 FROM admin_confirmations WHERE id=? AND confirmed_until IS NULL)",
        )
        .bind(randomId(), actor.operatorId, input.challengeId, context.requestId, context.now(), input.challengeId),
      context.env
        .DB!.prepare(
          'UPDATE admin_confirmations SET confirmed_until=COALESCE(confirmed_until,MIN(expires_at,?)) WHERE id=?',
        )
        .bind(Math.min(actor.tokenExpiresAt, context.now() + adminLimits.confirmationMs), input.challengeId),
    ],
    'FORBIDDEN',
  )
  const confirmedUntil = await context.env
    .DB!.prepare('SELECT confirmed_until FROM admin_confirmations WHERE id=?')
    .bind(input.challengeId)
    .first<number>('confirmed_until')
  return jsonResponse({ confirmedUntil })
}
export async function adminRoute(request: Request, context: ServiceContext): Promise<Response> {
  const path = new URL(request.url).pathname
  if (path === '/api/admin/v1/access-session' && request.method === 'GET')
    return openSession(request, context, true)
  if (path === '/api/admin/v1/invitations/accept' && request.method === 'POST')
    return acceptAdminInvitationRoute(request, context)
  if (path === '/api/admin/v1/session' && request.method === 'GET')
    return openSession(request, context, false)
  if (path === '/api/admin/v1/confirmations' && request.method === 'POST') return challenge(request, context)
  if (path === '/admin/confirm/api/v1/complete' && request.method === 'POST')
    return complete(request, context)
  let sessionResponse: Response | undefined
  if (
    (path === '/admin' || path.startsWith('/admin/')) &&
    !path.startsWith('/admin/confirm') &&
    ['GET', 'HEAD'].includes(request.method)
  )
    // Only acceptance assets admit verified pre-membership sessions
    sessionResponse = await openSession(
      request,
      context,
      path === '/admin/accept-invitation' || path.startsWith('/admin/accept-invitation/'),
    )
  else if (path === '/admin/confirm' || path.startsWith('/admin/confirm/'))
    await existingOperator(request, await verifyAccessIdentity(request, context, 'confirmation'), context)
  else {
    const actor = await requireOperator(request, context)
    const response =
      (await adminCommandRoute(request, actor, context, {
        prepareInvitation: prepareAdminInvitation,
      })) ?? (await adminQuery(request, actor, context))
    if (response) return response
  }
  if (
    (path === '/admin' || path.startsWith('/admin/')) &&
    ['GET', 'HEAD'].includes(request.method) &&
    context.env.ASSETS
  ) {
    const asset = await context.env.ASSETS.fetch(request)
    const response = new Response(asset.body, asset)
    if (sessionResponse?.headers.has('set-cookie'))
      response.headers.set('set-cookie', sessionResponse.headers.get('set-cookie')!)
    response.headers.set('cache-control', 'no-store')
    response.headers.set('x-content-type-options', 'nosniff')
    return response
  }
  throw new ApiFailure('NOT_FOUND')
}
export async function cleanupAdminSessions(context: ServiceContext): Promise<void> {
  const db = context.env.DB!,
    now = context.now()
  await db.batch([
    db
      .prepare(
        'DELETE FROM admin_confirmations WHERE id IN (SELECT id FROM admin_confirmations WHERE expires_at<=? LIMIT ?)',
      )
      .bind(now, cleanupLimit),
    db
      .prepare(
        'DELETE FROM admin_sessions WHERE id IN (SELECT s.id FROM admin_sessions s WHERE s.expires_at<=? AND NOT EXISTS (SELECT 1 FROM admin_confirmations c WHERE c.session_id=s.id) LIMIT ?)',
      )
      .bind(now, cleanupLimit),
    db
      .prepare(
        'DELETE FROM admin_access_sessions WHERE id IN (SELECT id FROM admin_access_sessions WHERE expires_at<=? LIMIT ?)',
      )
      .bind(now, cleanupLimit),
    db
      .prepare(
        'DELETE FROM admin_security_audit WHERE id IN (SELECT id FROM admin_security_audit WHERE created_at<? LIMIT ?)',
      )
      .bind(now - auditRetentionMs, cleanupLimit),
  ])
}
