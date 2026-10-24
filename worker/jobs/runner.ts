import { reconcileAdminRevocation } from '../admin/revocations'
import { requireRecoveryOpen } from './service-restore'
import { LedgerFailure } from './ledger'
import { ApiFailure } from '../http'
import { randomId } from '../auth/identity'
import type { ServiceContext } from '../context'
import { runGuardedBatch } from '../db/guarded-batch'
import { runCleanup } from './cleanup'
import { runDeletion } from './deletion'
import { appendRevocation, RevocationEventSchema } from './ledger'
import { maxServiceJobs, serviceLeaseMs, type ServiceJob } from './types'
export { maxServiceJobs } from './types'

// Trusted service reconciliation completes only the exact event frozen by the owner Stop batch
// Deleted accounts are covered by their own journal, which removes the pointer after independent acknowledgement
export async function reconcileLedger(context: ServiceContext): Promise<void> {
  const db = context.env.DB!
  const row = await db.prepare("SELECT m.account_id,m.mutation_id,m.share_id,m.digest,m.event,s.revision FROM share_mutations m JOIN shares s ON s.id = m.share_id JOIN accounts a ON a.id = m.account_id WHERE m.kind = 'stop' AND m.receipt IS NULL AND s.state = 'stopping' AND a.access <> 'deleting' ORDER BY m.share_id LIMIT 1").first<{account_id:string;mutation_id:string;share_id:string;digest:string;event:string;revision:number}>()
  if (!row) return
  const event = RevocationEventSchema.parse(JSON.parse(row.event))
  if (event.kind !== 'share-stopped' || event.accountId !== row.account_id || event.shareId !== row.share_id || !Number.isSafeInteger(row.revision + 1)) throw new Error('Invalid pending revocation')
  await appendRevocation(event, context)
  context.checkpoint('jobs.share-ledger.acknowledged')
  const receipt = JSON.stringify({shareId:row.share_id,revision:row.revision+1,active:false,url:`${context.env.SERVICE_ORIGIN}/#/s/${row.share_id}`})
  await runGuardedBatch(db, {sql:"SELECT EXISTS (SELECT 1 FROM share_mutations m JOIN shares s ON s.id = m.share_id JOIN accounts a ON a.id = m.account_id WHERE m.account_id = ? AND m.mutation_id = ? AND m.digest = ? AND m.event = ? AND m.receipt IS NULL AND s.state = 'stopping' AND s.revision = ? AND a.access <> 'deleting')",bindings:[row.account_id,row.mutation_id,row.digest,row.event,row.revision]},[
    db.prepare("UPDATE shares SET state = 'stopped',revision = revision + 1,updated_at = ? WHERE id = ?").bind(context.now(),row.share_id),
    db.prepare('UPDATE share_mutations SET receipt = ? WHERE account_id = ? AND mutation_id = ?').bind(receipt,row.account_id,row.mutation_id),
  ])
}
export async function runServiceJobs(context: ServiceContext, limit: number): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxServiceJobs) throw new Error('Invalid service job limit')
  await requireRecoveryOpen(context)
  const db = context.env.DB!, now = context.now()
  // Reuse one opaque cleanup journal without accumulating an idle tombstone each tick
  await db.prepare("INSERT INTO service_jobs(id,type,phase,expected_revision,next_at,request_id,created_at) SELECT ?,'cleanup','cleanup',0,?,?,? WHERE NOT EXISTS (SELECT 1 FROM service_jobs WHERE type = 'cleanup')").bind(randomId(),now,context.requestId,now).run()
  await db.prepare("UPDATE service_jobs SET outcome = 'pending',phase = 'cleanup',next_at = ? WHERE type = 'cleanup' AND outcome = 'complete'").bind(now).run()
  const rows = await db.prepare("SELECT * FROM service_jobs WHERE outcome = 'pending' AND next_at <= ? AND (lease_until IS NULL OR lease_until <= ?) ORDER BY next_at,id LIMIT ?").bind(now,now,limit).all<ServiceJob>()
  for (const row of rows.results) {
    const lease = randomId()
    const result = await db.prepare("UPDATE service_jobs SET lease_token = ?,lease_until = ?,attempts = attempts + 1 WHERE id = ? AND outcome = 'pending' AND next_at <= ? AND (lease_until IS NULL OR lease_until <= ?) AND phase = ? AND cursor = ? AND attempts = ?").bind(lease,context.now()+serviceLeaseMs,row.id,context.now(),context.now(),row.phase,row.cursor,row.attempts).run()
    if (!result.meta.changes) continue
    const job = {...row,lease_token:lease,lease_until:context.now()+serviceLeaseMs,attempts:row.attempts+1}, started = performance.now()
    try {
      if (job.type === 'deletion') await runDeletion(job,context)
      else await runCleanup(job,context)
      await db.prepare('UPDATE service_jobs SET lease_token = NULL,lease_until = NULL,next_at = ?,code = NULL WHERE id = ? AND lease_token = ?').bind(context.now(),job.id,lease).run()
      context.emit({operation:'service-job',stage:job.phase,jobId:job.id,attempt:job.attempts,durationMs:performance.now()-started,code:'PROGRESSED'})
    } catch (error) {
      const code = error instanceof LedgerFailure ? error.code : error instanceof ApiFailure && error.code === 'INTEGRITY_FAILED' ? error.code : 'RETRY_PENDING'
      // Provider messages may carry private values; persist only an authored recovery code
      await db.prepare("UPDATE service_jobs SET lease_token = NULL,lease_until = NULL,next_at = ?,code = ? WHERE id = ? AND lease_token = ?").bind(context.now()+serviceLeaseMs,code,job.id,lease).run()
      context.emit({operation:'service-job',stage:job.phase,jobId:job.id,attempt:job.attempts,durationMs:performance.now()-started,code})
    }
  }
  await reconcileAdminRevocation(context)
  try { await reconcileLedger(context) } catch { context.emit({operation:'service-job',stage:'share-ledger',code:'RETRY_PENDING'}) }
}
