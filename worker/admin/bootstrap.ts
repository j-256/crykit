import { OpaqueIdSchema } from '../../src/account/protocol'
import { guarded, randomId } from '../auth/identity'
import type { ServiceContext } from '../context'
import { ApiFailure } from '../http'
import { requireRecoveryOpen } from '../jobs/service-restore'
import { assertVerifiedIdentity, type AccessIdentity } from './auth'

// Deployment-only entry: no HTTP route and no email/directory candidate can construct verified authority
export async function bootstrapOwner(
  principal: AccessIdentity,
  intentId: string,
  context: ServiceContext,
): Promise<void> {
  assertVerifiedIdentity(principal, context)
  if (!OpaqueIdSchema.safeParse(intentId).success) throw new ApiFailure('INVALID_REQUEST')
  await requireRecoveryOpen(context)
  const db = context.env.DB!
  const id = randomId()
  // Exact retries are neutral; any different intent or identity fails even after audit retention
  await guarded(
    context,
    {
      sql: `SELECT (NOT EXISTS (SELECT 1 FROM operators) AND NOT EXISTS (SELECT 1 FROM admin_bootstrap_intents)) OR EXISTS (SELECT 1 FROM admin_bootstrap_intents i JOIN operators o ON o.id=i.operator_id WHERE i.id=? AND i.issuer=? AND i.subject=? AND o.state='active' AND o.role='owner')`,
      bindings: [intentId, principal.issuer, principal.subject],
    },
    [
      db
        .prepare(
          "INSERT INTO operators (id,issuer,subject,email,role,state,revision,created_at) SELECT ?,?,?,?,'owner','active',1,? WHERE NOT EXISTS (SELECT 1 FROM admin_bootstrap_intents WHERE id=?)",
        )
        .bind(id, principal.issuer, principal.subject, principal.email, context.now(), intentId),
      db
        .prepare(
          "INSERT INTO admin_security_audit (id,actor_id,action,target_id,request_id,created_at) SELECT ?,?,'owner-bootstrap',?,?,? WHERE NOT EXISTS (SELECT 1 FROM admin_bootstrap_intents WHERE id=?)",
        )
        .bind(randomId(), id, intentId, context.requestId, context.now(), intentId),
      db
        .prepare(
          'INSERT INTO admin_bootstrap_intents (id,operator_id,issuer,subject) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM admin_bootstrap_intents WHERE id=?)',
        )
        .bind(intentId, id, principal.issuer, principal.subject, intentId),
    ],
    'FORBIDDEN',
  )
}
