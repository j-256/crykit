import { adminRevocationStatement } from './revocations'
import { z } from 'zod'
import { base64urlSchema, digestBytes, OpaqueIdSchema } from '../../src/account/protocol'
import { keyedHash, normalizedEmail, randomId, randomToken } from '../auth/identity'
import type { ServiceContext } from '../context'
import { emailInvalidationStatement, prepareServiceEmailEnqueue } from '../email/jobs'
import { ApiFailure, jsonResponse, readJson } from '../http'
import { adminAuditStatement, commitAdminBatch } from './audit'
import { adminLimits, assertVerifiedIdentity, type AccessIdentity } from './auth'
import type { InvitationCommandPreparer } from './commands'
import { adminCookieName, adminCsrf, requireAccessSession, type OperatorPrincipal } from './session'

export const adminInvitationMs = 24 * 60 * 60 * 1000
const capabilitySchema = base64urlSchema(digestBytes)
const acceptanceJsonBytes = 2048
const acceptanceSchema = z.strictObject({ capability: capabilitySchema })
const invitationHash = (capability: string, context: ServiceContext) =>
  keyedHash(context.env.CAPABILITY_SECRET, 'admin-invitation', capability)

export const prepareAdminInvitation: InvitationCommandPreparer = async (actor, input, context) => {
  const db = context.env.DB!,
    now = context.now(),
    id = input.target.id
  if (input.command.type === 'operators.invitation.cancel') {
    const row = await db
      .prepare('SELECT root_job_id,created_by FROM admin_invitations WHERE id=?')
      .bind(id)
      .first<{ root_job_id: string; created_by: string }>()
    if (!row) throw new ApiFailure('NOT_FOUND')
    return {
      guard: {
        sql: "SELECT 1 FROM admin_invitations WHERE id=? AND state='pending' AND revision=? AND root_job_id=?",
        bindings: [id, input.expectedRevision, row.root_job_id],
      },
      statements: [
        db.prepare("UPDATE admin_invitations SET state='cancelled',revision=revision+1 WHERE id=?").bind(id),
        emailInvalidationStatement(db, row.root_job_id),
        adminRevocationStatement(
          {
            version: 1,
            kind: 'invitation-revoked',
            intentId: input.actionId,
            invitationId: id,
            operatorId: row.created_by,
            sessionEpoch: input.expectedRevision + 1,
            timestamp: now,
          },
          input.actionId,
          context,
        ),
      ],
      targetRevision: input.expectedRevision + 1,
      jobId: input.actionId,
    }
  }
  if (input.command.type !== 'operators.invite') throw new ApiFailure('INVALID_REQUEST')
  const email = normalizedEmail(input.command.email),
    capability = randomToken(),
    jobId = randomId(),
    expiresAt = now + adminInvitationMs
  const prepared = await prepareServiceEmailEnqueue(
    {
      kind: 'admin-invite',
      recipient: input.command.email,
      capability,
      expiresAt,
      correlationId: context.requestId,
    },
    jobId,
    context,
  )
  return {
    guard: {
      sql: `SELECT COALESCE((${prepared.guard.sql}),0) AND NOT EXISTS (SELECT 1 FROM admin_invitations WHERE normalized_email=? AND state='pending') AND NOT EXISTS (SELECT 1 FROM operators WHERE lower(email)=? AND state='active')`,
      bindings: [...prepared.guard.bindings, email, email],
    },
    statements: [
      db
        .prepare(
          "INSERT INTO admin_invitations(id,normalized_email,delivery_email,role,state,token_hash,root_job_id,created_by,created_at,expires_at) VALUES (?,?,?,'administrator','pending',?,?,?,?,?)",
        )
        .bind(
          id,
          email,
          input.command.email,
          await invitationHash(capability, context),
          jobId,
          actor.operatorId,
          now,
          expiresAt,
        ),
      ...prepared.statements,
    ],
    targetRevision: 1,
    // The command's immutable receipt must name the actual new root for actor revocation
    jobId,
  }
}

async function accept(
  identity: AccessIdentity,
  capability: string,
  accessSessionId: string,
  context: ServiceContext,
) {
  assertVerifiedIdentity(identity, context)
  if (!capabilitySchema.safeParse(capability).success || !OpaqueIdSchema.safeParse(accessSessionId).success)
    throw new ApiFailure('INVALID_REQUEST')
  const db = context.env.DB!,
    now = context.now(),
    hash = await invitationHash(capability, context)
  const invitation = await db
    .prepare(
      'SELECT id,normalized_email,revision,root_job_id,state,expires_at,created_by FROM admin_invitations WHERE token_hash=?',
    )
    .bind(hash)
    .first<{
      id: string
      normalized_email: string
      revision: number
      root_job_id: string
      state: string
      expires_at: number
      created_by: string
    }>()
  if (!invitation || invitation.state !== 'pending' || invitation.expires_at <= now)
    throw new ApiFailure('INVALID_REQUEST')
  if (invitation.normalized_email !== normalizedEmail(identity.email)) throw new ApiFailure('FORBIDDEN')
  const session = await db
    .prepare(
      'SELECT expires_at FROM admin_access_sessions WHERE id=? AND issuer=? AND subject=? AND revoked_at IS NULL AND expires_at>?',
    )
    .bind(accessSessionId, identity.issuer, identity.subject, now)
    .first<{ expires_at: number }>()
  if (!session) throw new ApiFailure('FORBIDDEN')
  if (
    await db
      .prepare(
        "SELECT 1 FROM operators WHERE (issuer=? AND subject=?) OR (lower(email)=? AND state='active')",
      )
      .bind(identity.issuer, identity.subject, invitation.normalized_email)
      .first()
  )
    throw new ApiFailure('HEAD_CONFLICT')
  const token = randomToken(),
    expiresAt = Math.min(identity.tokenExpiresAt, session.expires_at, now + adminLimits.sessionMs)
  const principal: OperatorPrincipal = {
    operatorId: randomId(),
    issuer: identity.issuer,
    subject: identity.subject,
    role: 'administrator',
    membershipRevision: 1,
    adminSessionId: randomId(),
    tokenExpiresAt: expiresAt,
  }
  // Verified identity and pre-membership cookie/CSRF are captured by the route, then
  // their exact live authority is rechecked with consumption, audit and session grant
  // Revoked invitation creators lose capability authority even if mail already escaped
  context.checkpoint('admin.invitation.before-batch')
  await commitAdminBatch(
    {
      sql: `SELECT EXISTS (SELECT 1 FROM admin_access_sessions WHERE id=? AND issuer=? AND subject=? AND revoked_at IS NULL AND expires_at=? AND expires_at>?) AND ?>? AND EXISTS (SELECT 1 FROM admin_invitations i JOIN operators o ON o.id=i.created_by JOIN email_jobs j ON j.id=i.root_job_id WHERE i.id=? AND i.token_hash=? AND i.normalized_email=? AND i.state='pending' AND i.revision=? AND i.expires_at>? AND i.role='administrator' AND o.role='owner' AND o.state='active' AND j.eligible=1) AND NOT EXISTS (SELECT 1 FROM operators WHERE (issuer=? AND subject=?) OR (lower(email)=? AND state='active'))`,
      bindings: [
        accessSessionId,
        identity.issuer,
        identity.subject,
        session.expires_at,
        context.now(),
        identity.tokenExpiresAt,
        context.now(),
        invitation.id,
        hash,
        normalizedEmail(identity.email),
        invitation.revision,
        context.now(),
        identity.issuer,
        identity.subject,
        invitation.normalized_email,
      ],
    },
    [
      db
        .prepare(
          "INSERT INTO operators(id,issuer,subject,email,role,state,revision,created_at) VALUES (?,?,?,?,'administrator','active',1,?)",
        )
        .bind(principal.operatorId, identity.issuer, identity.subject, identity.email, now),
      db
        .prepare("UPDATE admin_invitations SET state='accepted',accepted_by=?,revision=revision+1 WHERE id=?")
        .bind(principal.operatorId, invitation.id),
      emailInvalidationStatement(db, invitation.root_job_id),
      db
        .prepare(
          'INSERT INTO admin_sessions(id,token_hash,operator_id,membership_revision,created_at,expires_at) VALUES (?,?,?,1,?,?)',
        )
        .bind(
          principal.adminSessionId,
          await keyedHash(context.env.SESSION_SECRET, adminCookieName, token),
          principal.operatorId,
          now,
          expiresAt,
        ),
      adminAuditStatement(
        principal,
        {
          actionId: invitation.id,
          target: { kind: 'invitation', id: invitation.id },
          reason: 'operations',
        },
        'operators.invitation.accept',
        'complete',
        context,
      ),
    ],
    context,
    'INVALID_REQUEST',
  )
  return { principal, token }
}
export async function acceptAdminInvitation(
  identity: AccessIdentity,
  capability: string,
  adminSessionId: string,
  context: ServiceContext,
): Promise<OperatorPrincipal> {
  return (await accept(identity, capability, adminSessionId, context)).principal
}
export async function acceptAdminInvitationRoute(
  request: Request,
  context: ServiceContext,
): Promise<Response> {
  if (new URL(request.url).search) throw new ApiFailure('INVALID_REQUEST')
  const { identity, sessionId } = await requireAccessSession(request, context)
  const { capability } = await readJson(request, acceptanceSchema, acceptanceJsonBytes)
  const { principal, token } = await accept(identity, capability, sessionId, context)
  const response = jsonResponse({
    role: principal.role,
    sessionId: principal.adminSessionId,
    csrf: await adminCsrf(principal.adminSessionId, context),
    expiresAt: principal.tokenExpiresAt,
  })
  // The token exists only in request memory and is exposed only after the batch commits
  response.headers.set(
    'set-cookie',
    `${adminCookieName}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor((principal.tokenExpiresAt - context.now()) / 1000))}`,
  )
  return response
}
