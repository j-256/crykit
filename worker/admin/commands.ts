import { adminRevocationStatement } from './revocations'
import type { D1PreparedStatement } from '@cloudflare/workers-types/experimental'
import {
  AdminCommandSchema,
  AdminReceiptSchema,
  adminCommandPolicy,
  adminLimits,
  requiresAdminConfirmation,
  type AdminAuditPolicy,
  type AdminCommand,
  type AdminPreview,
  type AdminReceipt,
} from '../../src/account/admin-protocol'
import { guarded, randomId } from '../auth/identity'
import { prepareVerificationResend } from '../auth/routes'
import type { ServiceContext } from '../context'
import type { SqlGuard } from '../db/guarded-batch'
import {
  emailAccountInvalidationStatement,
  emailInvalidationStatement,
  prepareEmailRetry,
} from '../email/jobs'
import { ApiFailure, jsonResponse, readJson } from '../http'
import { prepareAccountDeletion } from '../jobs/deletion'
import type { ServiceJob } from '../jobs/types'
import { digest, encoder } from '../sync/storage'
import { adminAuditStatement, commitAdminBatch } from './audit'
import { adminSettings, assertLiveOperator } from './queries'
import { actionConfirmationGuard, operatorGuard, type OperatorPrincipal } from './session'

export interface PreparedAdminEffect {
  readonly guard: SqlGuard
  readonly statements: readonly D1PreparedStatement[]
  readonly targetRevision: number
  readonly jobId?: string
  readonly policies?: { before: AdminAuditPolicy; after: AdminAuditPolicy }
}
// Invitation integration supplies prepared authority/outbox writes, never a separate mutation
// The command layer still owns permission, confirmation, revision, audit and receipt
export type InvitationCommandPreparer = (
  actor: OperatorPrincipal,
  input: AdminCommand,
  context: ServiceContext,
) => Promise<PreparedAdminEffect>
export interface AdminCommandDependencies {
  readonly prepareInvitation?: InvitationCommandPreparer
}
const and = (...guards: SqlGuard[]): SqlGuard => ({
  sql: `SELECT ${guards.map((g) => `COALESCE((${g.sql}),0)`).join(' AND ')}`,
  bindings: guards.flatMap((g) => g.bindings),
})
const deletionRetryPhases = [
  'ledger',
  'fence',
  'liabilities',
  'transfer',
  'metadata',
  'envelopes',
  'account',
] as const
// These predicates describe durable journal eligibility, not captured actor authority
// The command transaction still checks the live operator and exact job revision
export function canRetryJob(actor: OperatorPrincipal, job: ServiceJob, now = Date.now()): boolean {
  return (
    (actor.role === 'owner' || actor.role === 'administrator') &&
    actor.tokenExpiresAt > now &&
    job.outcome === 'pending' &&
    job.code !== null &&
    (job.lease_until === null || job.lease_until <= now) &&
    Number.isSafeInteger(job.attempts) &&
    job.attempts >= 0 &&
    job.attempts < Number.MAX_SAFE_INTEGER &&
    (job.type === 'cleanup'
      ? job.phase === 'cleanup'
      : job.type === 'deletion' && deletionRetryPhases.some((phase) => phase === job.phase))
  )
}
export function canCancelJob(_actor: OperatorPrincipal, _job: ServiceJob): boolean {
  // Every persisted service journal is cleanup or an already accepted irreversible deletion
  return false
}
const trueGuard: SqlGuard = { sql: 'SELECT 1', bindings: [] }
function parse(input: AdminCommand): AdminCommand {
  const parsed = AdminCommandSchema.safeParse(input)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  return parsed.data
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}
export const adminCommandDigest = (input: AdminCommand) =>
  digest(encoder.encode(JSON.stringify(canonical(parse(input)))))
async function permitted(actor: OperatorPrincipal, input: AdminCommand, context: ServiceContext) {
  await assertLiveOperator(actor, context)
  if (adminCommandPolicy[input.command.type].owner && actor.role !== 'owner') {
    await guarded(
      context,
      operatorGuard(actor, context),
      [adminAuditStatement(actor, input, input.command.type, 'denied', context)],
      'FORBIDDEN',
    )
    throw new ApiFailure('FORBIDDEN')
  }
}
async function targetGuard(input: AdminCommand, context: ServiceContext): Promise<SqlGuard> {
  const { id, kind } = input.target,
    revision = input.expectedRevision,
    db = context.env.DB!
  if (input.command.type === 'operators.invite')
    return {
      sql: 'SELECT ?=0 AND NOT EXISTS (SELECT 1 FROM admin_invitations WHERE id=?)',
      bindings: [revision, id],
    }
  if (input.command.type === 'accounts.verification.resend')
    return {
      sql: 'SELECT 1 FROM pending_registrations WHERE account_id=? AND verification_revision=? AND expires_at>? AND registration_record IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE id=?)',
      bindings: [id, revision, context.now(), id],
    }
  if (kind === 'job') {
    const service = await db.prepare('SELECT id FROM service_jobs WHERE id=?').bind(id).first()
    return {
      sql: `SELECT 1 FROM ${service ? 'service_jobs' : 'email_jobs'} WHERE id=? AND admin_revision=?`,
      bindings: [id, revision],
    }
  }
  const table = {
    account: 'accounts',
    share: 'shares',
    operator: 'operators',
    invitation: 'admin_invitations',
    service: 'service_settings',
  }[kind]
  return {
    sql: `SELECT 1 FROM ${table} WHERE id=? AND revision=?${kind === 'account' ? " AND access<>'deleting'" : ''}`,
    bindings: [id, revision],
  }
}
export async function previewAdminCommand(
  actor: OperatorPrincipal,
  input: AdminCommand,
  context: ServiceContext,
): Promise<AdminPreview> {
  input = parse(input)
  await permitted(actor, input, context)
  const settings = await adminSettings(context),
    hash = await adminCommandDigest(input),
    target = await targetGuard(input, context)
  const expiresAt = Math.min(context.now() + adminLimits.previewMs, actor.tokenExpiresAt)
  // An action ID cannot be rebound to another input, actor, session or newer configuration
  await guarded(
    context,
    and(operatorGuard(actor, context), target, {
      sql: 'SELECT NOT EXISTS (SELECT 1 FROM admin_previews WHERE id=?) OR EXISTS (SELECT 1 FROM admin_previews WHERE id=? AND actor_id=? AND session_id=? AND digest=? AND settings_revision=? AND expires_at>?)',
      bindings: [
        input.actionId,
        input.actionId,
        actor.operatorId,
        actor.adminSessionId,
        hash,
        settings.revision,
        context.now(),
      ],
    }),
    [
      context.env
        .DB!.prepare(
          'INSERT INTO admin_previews(id,actor_id,session_id,digest,settings_revision,expires_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
        )
        .bind(input.actionId, actor.operatorId, actor.adminSessionId, hash, settings.revision, expiresAt),
    ],
    'HEAD_CONFLICT',
  )
  const deadline = await context.env
    .DB!.prepare('SELECT expires_at FROM admin_previews WHERE id=?')
    .bind(input.actionId)
    .first<number>('expires_at')
  const command = input.command
  const impact: string[] = []
  switch (command.type) {
    case 'accounts.delete':
      impact.push(
        `Permanently delete account ${input.target.id} through its deletion journal.`,
        'Existing local copies cannot be erased.',
      )
      break
    case 'accounts.restrict':
      impact.push(
        `Set cloud access to ${command.policy}.`,
        command.policy === 'blocked'
          ? 'Revoke existing sessions and pending approvals.'
          : 'Preserve stored records and existing revocations.',
      )
      break
    case 'accounts.quota':
      impact.push(
        `Set the account quota to ${command.quotaBytes} bytes.`,
        'Keep existing data; reject capacity increases above the new quota.',
      )
      break
    case 'accounts.sessions.revoke':
      impact.push(
        command.all
          ? 'Revoke all customer sessions.'
          : `Revoke the selected ${command.sessionIds!.length} customer sessions.`,
        command.revokePendingApprovals
          ? 'Reject pending device approvals.'
          : 'Keep pending device approvals.',
      )
      break
    case 'accounts.verification.resend':
      impact.push('Replace the pending verification capability and queue mail to the stored recipient.')
      break
    case 'accounts.username.withhold':
      impact.push('Hide public attribution until the account chooses a different available username.')
      break
    case 'shares.revoke':
      impact.push('Disable this public link; complete independent revocation recording in the background.')
      break
    case 'jobs.retry':
      impact.push('Retry only eligible work using its original authority and remaining attempt budget.')
      break
    case 'jobs.cancel':
      impact.push('Cancel only an eligible email lineage before any attempt starts.')
      break
    case 'service.settings':
      impact.push(...Object.entries(command.patch).map(([key, value]) => `${key}: ${String(value)}`))
      break
    case 'operators.remove':
      impact.push(
        'Revoke this administrator membership, sessions, confirmations and unstarted staff-created mail.',
      )
      break
    case 'operators.invite':
      impact.push(
        'Allow the invited email through the admin Access policy before acceptance.',
        'Queue a single-use administrator invitation valid for 24 hours.',
      )
      break
    case 'operators.invitation.cancel':
      impact.push('Cancel the selected invitation and invalidate its email lineage.')
      break
  }
  return {
    version: 1,
    commandDigest: hash,
    target: input.target,
    expectedRevision: input.expectedRevision,
    settingsRevision: settings.revision,
    impact,
    requiresConfirmation: requiresAdminConfirmation(input.command),
    expiresAt: deadline!,
  }
}
async function previous(
  actor: OperatorPrincipal,
  input: AdminCommand,
  hash: string,
  context: ServiceContext,
): Promise<AdminReceipt | null> {
  const row = await context.env
    .DB!.prepare('SELECT actor_id,digest,receipt FROM admin_actions WHERE id=?')
    .bind(input.actionId)
    .first<{ actor_id: string; digest: string; receipt: string }>()
  if (!row) return null
  if (row.actor_id !== actor.operatorId || row.digest !== hash) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
  await assertLiveOperator(actor, context)
  return AdminReceiptSchema.parse(JSON.parse(row.receipt))
}
async function effect(
  actor: OperatorPrincipal,
  input: AdminCommand,
  context: ServiceContext,
  dependencies: AdminCommandDependencies,
): Promise<PreparedAdminEffect> {
  const db = context.env.DB!,
    id = input.target.id,
    now = context.now(),
    command = input.command,
    next = input.expectedRevision + 1
  let policies: PreparedAdminEffect['policies']
  if (input.target.kind === 'account' && command.type !== 'accounts.verification.resend') {
    const before = await db
      .prepare('SELECT access,capacity_bytes,username_withheld FROM accounts WHERE id=?')
      .bind(id)
      .first<{
        access: AdminAuditPolicy['access']
        capacity_bytes: number
        username_withheld: number
      }>()
    if (!before) throw new ApiFailure('NOT_FOUND')
    const policy = {
      access: before.access,
      quotaBytes: before.capacity_bytes,
      usernameWithheld: !!before.username_withheld,
    }
    policies = {
      before: policy,
      after: {
        ...policy,
        ...(command.type === 'accounts.restrict' ? { access: command.policy } : {}),
        ...(command.type === 'accounts.quota' ? { quotaBytes: command.quotaBytes } : {}),
        ...(command.type === 'accounts.username.withhold' ? { usernameWithheld: true } : {}),
        ...(command.type === 'accounts.delete' ? { access: 'deleting' as const } : {}),
      },
    }
  }
  const statements: D1PreparedStatement[] = []
  let guard = trueGuard,
    jobId: string | undefined
  const bump = () =>
    statements.push(db.prepare('UPDATE accounts SET revision=revision+1 WHERE id=?').bind(id))
  switch (command.type) {
    case 'accounts.restrict':
      statements.push(
        db.prepare('UPDATE accounts SET access=?,revision=revision+1 WHERE id=?').bind(command.policy, id),
      )
      if (command.policy === 'blocked') {
        statements.push(
          db
            .prepare('UPDATE customer_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE account_id=?')
            .bind(now, id),
          db.prepare('UPDATE accounts SET session_epoch=session_epoch+1 WHERE id=?').bind(id),
          emailAccountInvalidationStatement(db, id),
        )
        statements.push(
          db
            .prepare(
              "UPDATE device_approvals SET state='rejected',sealed_payload=NULL,completion_hash=NULL,capability_hash='' WHERE account_id=? AND state IN ('pending','approved')",
            )
            .bind(id),
        )
      }
      break
    case 'accounts.quota': {
      const settings = await adminSettings(context)
      if (command.quotaBytes > settings.maxAccountBytes) throw new ApiFailure('INVALID_REQUEST')
      guard = {
        sql: "SELECT 1 FROM service_settings WHERE id='service' AND revision=? AND COALESCE(max_account_bytes,?)>=?",
        bindings: [settings.revision, Number(context.env.STORAGE_CAP_BYTES), command.quotaBytes],
      }
      statements.push(
        db
          .prepare('UPDATE accounts SET capacity_bytes=?,revision=revision+1 WHERE id=?')
          .bind(command.quotaBytes, id),
      )
      break
    }
    case 'accounts.sessions.revoke': {
      if (command.all)
        statements.push(
          db
            .prepare('UPDATE customer_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE account_id=?')
            .bind(now, id),
          db.prepare('UPDATE accounts SET session_epoch=session_epoch+1 WHERE id=?').bind(id),
        )
      else {
        const ids = command.sessionIds!
        // One JSON binding keeps the maximum selection inside D1's per-statement variable bound
        const selection = JSON.stringify(ids)
        guard = {
          sql: 'SELECT count(*)=? FROM customer_sessions WHERE account_id=? AND id IN (SELECT value FROM json_each(?))',
          bindings: [ids.length, id, selection],
        }
        statements.push(
          db
            .prepare(
              'UPDATE customer_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE account_id=? AND id IN (SELECT value FROM json_each(?))',
            )
            .bind(now, id, selection),
        )
      }
      if (command.revokePendingApprovals)
        statements.push(
          db
            .prepare(
              "UPDATE device_approvals SET state='rejected',sealed_payload=NULL,completion_hash=NULL,capability_hash='' WHERE account_id=? AND state IN ('pending','approved')",
            )
            .bind(id),
        )
      bump()
      break
    }
    case 'accounts.username.withhold':
      statements.push(
        db.prepare('UPDATE accounts SET username_withheld=1,revision=revision+1 WHERE id=?').bind(id),
      )
      break
    case 'accounts.verification.resend': {
      const prepared = await prepareVerificationResend(id, context)
      return { ...prepared, targetRevision: next }
    }
    case 'accounts.delete': {
      const account = await db
        .prepare('SELECT revision,session_epoch FROM accounts WHERE id=?')
        .bind(id)
        .first<{ revision: number; session_epoch: number }>()
      if (!account) throw new ApiFailure('NOT_FOUND')
      const prepared = prepareAccountDeletion(
        id,
        actor.operatorId,
        input.expectedRevision,
        account.session_epoch,
        context,
      )
      return {
        ...prepared,
        policies,
        guard: {
          sql: "SELECT 1 FROM accounts WHERE id=? AND revision=? AND session_epoch=? AND access<>'deleting'",
          bindings: [id, input.expectedRevision, account.session_epoch],
        },
        targetRevision: next,
      }
    }
    case 'shares.revoke': {
      const row = await db
        .prepare(
          "SELECT s.account_id,a.session_epoch FROM shares s JOIN accounts a ON a.id=s.account_id WHERE s.id=? AND s.state='active' AND a.access<>'deleting'",
        )
        .bind(id)
        .first<{ account_id: string; session_epoch: number }>()
      if (!row) throw new ApiFailure('HEAD_CONFLICT')
      const mutationId = randomId()
      const event = JSON.stringify({
        version: 1,
        kind: 'share-stopped',
        intentId: randomId(),
        accountId: row.account_id,
        shareId: id,
        sessionEpoch: row.session_epoch,
        timestamp: now,
      })
      // Reuse the actual pending Stop journal; trusted reconciliation owns independent acknowledgment
      // The queued receipt never claims that the independent ledger already committed
      guard = {
        sql: "SELECT 1 FROM shares s JOIN accounts a ON a.id=s.account_id WHERE s.id=? AND s.state='active' AND s.revision=? AND a.id=? AND a.session_epoch=? AND a.access<>'deleting'",
        bindings: [id, input.expectedRevision, row.account_id, row.session_epoch],
      }
      statements.push(
        db.prepare("UPDATE shares SET state='stopping',updated_at=? WHERE id=?").bind(now, id),
        db
          .prepare(
            "INSERT INTO share_mutations(account_id,mutation_id,share_id,digest,kind,event) VALUES (?,?,?,?,'stop',?)",
          )
          .bind(row.account_id, mutationId, id, await adminCommandDigest(input), event),
      )
      return {
        guard,
        statements,
        targetRevision: input.expectedRevision,
        jobId: mutationId,
      }
    }
    case 'jobs.retry':
    case 'jobs.cancel': {
      const service = await db.prepare('SELECT * FROM service_jobs WHERE id=?').bind(id).first<ServiceJob>()
      if (service) {
        // Deletion acceptance already crosses its irreversible boundary; cancellation must never undo it
        if (
          command.type === 'jobs.cancel' ? !canCancelJob(actor, service) : !canRetryJob(actor, service, now)
        )
          throw new ApiFailure('INVALID_REQUEST')
        guard = {
          sql: "SELECT 1 FROM service_jobs WHERE id=? AND outcome='pending' AND code IS NOT NULL AND (lease_until IS NULL OR lease_until<=?)",
          bindings: [id, now],
        }
        statements.push(db.prepare('UPDATE service_jobs SET next_at=?,code=NULL WHERE id=?').bind(now, id))
        jobId = id
      } else if (command.type === 'jobs.retry') {
        const prepared = await prepareEmailRetry(id, context)
        guard = prepared.guard
        statements.push(...prepared.statements)
        jobId = id
      } else {
        // Cancellation is lineage-wide and safe only before any attempt starts
        guard = {
          sql: "SELECT 1 FROM email_jobs j WHERE j.id=? AND j.resend_of IS NULL AND j.eligible=1 AND j.state IN ('queued','waiting') AND j.attempts=0 AND NOT EXISTS (SELECT 1 FROM email_jobs child WHERE child.resend_of=j.id AND child.attempts>0)",
          bindings: [id],
        }
        statements.push(emailInvalidationStatement(db, id))
      }
      break
    }
    case 'operators.remove':
      if (await db.prepare("SELECT 1 FROM operators WHERE id=? AND role='owner'").bind(id).first())
        throw new ApiFailure('FORBIDDEN')
      guard = {
        sql: "SELECT 1 FROM operators WHERE id=? AND role='administrator' AND state='active'",
        bindings: [id],
      }
      statements.push(
        db.prepare("UPDATE operators SET state='revoked',revision=revision+1 WHERE id=?").bind(id),
        adminRevocationStatement(
          { version: 1, kind: 'operator-revoked', intentId: input.actionId, operatorId: id, sessionEpoch: next, timestamp: now },
          input.actionId,
          context,
        ),
      )
      jobId = input.actionId
      break
    case 'operators.invite':
    case 'operators.invitation.cancel':
      if (!dependencies.prepareInvitation) throw new ApiFailure('SERVICE_UNAVAILABLE')
      return dependencies.prepareInvitation(actor, input, context)
    case 'service.settings': {
      const old = await adminSettings(context),
        updated = { ...old, ...command.patch }
      const { revision: _revision, deploymentCapacity: _capacity, ...before } = old
      const { revision: _nextRevision, deploymentCapacity: _nextCapacity, ...after } = updated
      policies = { before, after }
      if (
        updated.maxAccountBytes > old.deploymentCapacity ||
        updated.projectCapacityBytes > old.deploymentCapacity
      )
        throw new ApiFailure('INVALID_REQUEST')
      statements.push(
        db
          .prepare(
            "UPDATE service_settings SET revision=revision+1,registration_paused=?,uploads_paused=?,sharing_paused=?,email_paused=?,max_account_bytes=?,project_capacity_bytes=? WHERE id='service'",
          )
          .bind(
            Number(updated.registrationPaused),
            Number(updated.uploadsPaused),
            Number(updated.sharingPaused),
            Number(updated.emailPaused),
            updated.maxAccountBytes,
            updated.projectCapacityBytes,
          ),
      )
      break
    }
  }
  return {
    guard,
    statements,
    policies,
    targetRevision: next,
    ...(jobId ? { jobId } : {}),
  }
}
export async function executeAdminCommand(
  actor: OperatorPrincipal,
  input: AdminCommand,
  context: ServiceContext,
  dependencies: AdminCommandDependencies = {},
): Promise<AdminReceipt> {
  input = parse(input)
  await permitted(actor, input, context)
  const hash = await adminCommandDigest(input),
    prior = await previous(actor, input, hash, context)
  if (prior) return prior
  // Another exact action can commit while effect preparation is reading its target
  try {
    const prepared = await effect(actor, input, context, dependencies),
      target = await targetGuard(input, context)
    const receipt: AdminReceipt = {
      version: 1,
      actionId: input.actionId,
      targetRevision: prepared.targetRevision,
      state: prepared.jobId ? 'queued' : 'complete',
      ...(prepared.jobId ? { jobId: prepared.jobId } : {}),
      requestId: context.requestId,
    }
    const live = requiresAdminConfirmation(input.command)
      ? actionConfirmationGuard(actor, hash, context)
      : operatorGuard(actor, context)
    const preview: SqlGuard = {
      sql: "SELECT 1 FROM admin_previews p JOIN service_settings s ON s.id='service' AND s.revision=p.settings_revision WHERE p.id=? AND p.actor_id=? AND p.session_id=? AND p.digest=? AND p.expires_at>?",
      bindings: [input.actionId, actor.operatorId, actor.adminSessionId, hash, context.now()],
    }
    context.checkpoint('admin.command.before-batch')
    await commitAdminBatch(
      and(live, target, preview, prepared.guard, {
        sql: 'SELECT NOT EXISTS (SELECT 1 FROM admin_actions WHERE id=?)',
        bindings: [input.actionId],
      }),
      [
        ...prepared.statements,
        adminAuditStatement(actor, input, input.command.type, receipt.state, context, prepared.policies),
        context.env
          .DB!.prepare(
            'INSERT INTO admin_actions(id,actor_id,action,digest,target_kind,target_id,receipt,created_at) VALUES (?,?,?,?,?,?,?,?)',
          )
          .bind(
            input.actionId,
            actor.operatorId,
            input.command.type,
            hash,
            input.target.kind,
            input.target.id,
            JSON.stringify(receipt),
            context.now(),
          ),
      ],
      context,
      'HEAD_CONFLICT',
    )
    return receipt
  } catch (error) {
    const raced = await previous(actor, input, hash, context)
    if (raced) return raced
    throw error
  }
}
export async function adminCommandRoute(
  request: Request,
  actor: OperatorPrincipal,
  context: ServiceContext,
  dependencies: AdminCommandDependencies = {},
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname
  if (url.search) return null
  if (
    request.method === 'POST' &&
    (path === '/api/admin/v1/actions/preview' || path === '/api/admin/v1/actions')
  ) {
    const input = await readJson(request, AdminCommandSchema, adminLimits.jsonBytes)
    return jsonResponse(
      path.endsWith('/preview')
        ? await previewAdminCommand(actor, input, context)
        : await executeAdminCommand(actor, input, context, dependencies),
    )
  }
  const match = /^\/api\/admin\/v1\/actions\/([A-Za-z0-9_-]+)$/.exec(path)
  if (request.method === 'GET' && match) {
    await assertLiveOperator(actor, context)
    const row = await context.env
      .DB!.prepare('SELECT receipt FROM admin_actions WHERE id=? AND actor_id=?')
      .bind(match[1], actor.operatorId)
      .first<{ receipt: string }>()
    if (!row) throw new ApiFailure('NOT_FOUND')
    return jsonResponse(AdminReceiptSchema.parse(JSON.parse(row.receipt)))
  }
  return null
}
