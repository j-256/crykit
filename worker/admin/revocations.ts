import type { ServiceContext } from '../context'
import { runGuardedBatch } from '../db/guarded-batch'
import { appendRevocation, LedgerFailure, RevocationEventSchema, type RevocationEvent } from '../jobs/ledger'

// The command transaction freezes this event with its audit and immutable queued receipt
// Independent append happens afterward so a rolled-back command cannot revoke future restores
export function adminRevocationStatement(event: RevocationEvent, actionId: string, context: ServiceContext) {
  return context.env
    .DB!.prepare('INSERT INTO admin_revocations(id,action_id,event,created_at) VALUES (?,?,?,?)')
    .bind(event.intentId, actionId, JSON.stringify(RevocationEventSchema.parse(event)), context.now())
}

export async function reconcileAdminRevocation(context: ServiceContext): Promise<void> {
  const started = performance.now()
  const db = context.env.DB!
  const row = await db
    .prepare('SELECT id,event FROM admin_revocations WHERE acknowledged=0 ORDER BY created_at,id LIMIT 1')
    .first<{ id: string; event: string }>()
  if (!row) return
  const guard = {
    sql: "SELECT 1 FROM admin_revocations WHERE id=? AND event=? AND acknowledged=0 AND (SELECT state FROM recovery_control WHERE id=1)='open'",
    bindings: [row.id, row.event],
  }
  try {
    const event = RevocationEventSchema.parse(JSON.parse(row.event))
    if (event.intentId !== row.id || !['operator-revoked', 'invitation-revoked'].includes(event.kind))
      throw new LedgerFailure('LEDGER_INVALID')
    await appendRevocation(event, context)
    context.checkpoint('admin.revocation.acknowledged')
    await runGuardedBatch(db, guard, [
      db.prepare('UPDATE admin_revocations SET acknowledged=1,code=NULL WHERE id=?').bind(row.id),
    ])
    context.emit({
      operation: 'admin',
      stage: 'revocation-ledger',
      jobId: row.id,
      code: 'ACKNOWLEDGED',
      durationMs: performance.now() - started,
    })
  } catch (error) {
    const code = error instanceof LedgerFailure ? error.code : 'RETRY_PENDING'
    await runGuardedBatch(db, guard, [
      db.prepare('UPDATE admin_revocations SET code=? WHERE id=?').bind(code, row.id),
    ])
    context.emit({
      operation: 'admin',
      stage: 'revocation-ledger',
      jobId: row.id,
      code,
      durationMs: performance.now() - started,
    })
  }
}
