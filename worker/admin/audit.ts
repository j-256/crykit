import type { D1PreparedStatement } from '@cloudflare/workers-types/experimental'
import type { SqlGuard } from '../db/guarded-batch'
import type { ApiErrorCode } from '../../src/account/protocol'
import { ApiFailure } from '../http'
import type { AdminCommand } from '../../src/account/admin-protocol'
import { AdminAuditPolicySchema, adminLimits, type AdminAuditPolicy } from '../../src/account/admin-protocol'
import { guarded, randomId } from '../auth/identity'
import type { ServiceContext } from '../context'
import type { OperatorPrincipal } from './session'

// Only authored action/reason/outcome codes and opaque identifiers enter this audit
// Payloads, emails, queries and private graph metadata are deliberately absent
export function adminAuditStatement(
  actor: OperatorPrincipal,
  input: Pick<AdminCommand, 'target' | 'actionId' | 'reason' | 'caseId'>,
  action: string,
  outcome: 'complete' | 'queued' | 'denied' | 'read',
  context: ServiceContext,
  policies?: { before: AdminAuditPolicy; after: AdminAuditPolicy },
) {
  return context.env
    .DB!.prepare(
      'INSERT INTO admin_audit(id,actor_id,action,target_kind,target_id,action_id,reason,case_id,outcome,policy_before,policy_after,request_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .bind(
      randomId(),
      actor.operatorId,
      action,
      input.target.kind,
      input.target.id,
      input.actionId,
      input.reason,
      input.caseId ?? null,
      outcome,
      policies ? JSON.stringify(AdminAuditPolicySchema.parse(policies.before)) : null,
      policies ? JSON.stringify(AdminAuditPolicySchema.parse(policies.after)) : null,
      context.requestId,
      context.now(),
    )
}
export async function cleanupAdminCommands(context: ServiceContext): Promise<void> {
  const db = context.env.DB!
  await db.batch([
    db
      .prepare(
        'DELETE FROM admin_audit WHERE id IN (SELECT id FROM admin_audit WHERE created_at<? ORDER BY created_at,id LIMIT ?)',
      )
      .bind(context.now() - adminLimits.retentionMs, adminLimits.maxPage),
    db
      .prepare(
        'DELETE FROM admin_previews WHERE id IN (SELECT id FROM admin_previews WHERE expires_at<=? ORDER BY expires_at,id LIMIT ?)',
      )
      .bind(context.now(), adminLimits.maxPage),
  ])
}

// The failure code identifies the audited transaction, not an invented per-statement outcome
export async function commitAdminBatch(
  actorGuard: SqlGuard,
  statements: readonly D1PreparedStatement[],
  context: ServiceContext,
  denied: ApiErrorCode = 'HEAD_CONFLICT',
) {
  try {
    await guarded(context, actorGuard, statements, denied)
  } catch (error) {
    if (error instanceof ApiFailure && error.code === 'SERVICE_UNAVAILABLE')
      context.emit({ operation: 'admin', stage: 'audit-transaction', code: 'AUDIT_TRANSACTION_UNAVAILABLE' })
    throw error
  }
}
