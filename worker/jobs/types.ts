import type { ServiceContext } from '../context'
import type { D1PreparedStatement } from '@cloudflare/workers-types/experimental'
import { runGuardedBatch } from '../db/guarded-batch'

export const serviceBatchLimit = 100
export const serviceLeaseMs = 60_000
export const maxServiceJobs = 10
export interface ServiceJob {
  id: string; type: 'deletion' | 'cleanup'; phase: string; account_id: string | null; actor_id: string | null
  expected_revision: number; attempts: number; lease_token: string | null; lease_until: number | null
  next_at: number; outcome: 'pending' | 'complete'; code: string | null; request_id: string; created_at: number; cursor: string
}
export function jobGuard(job: ServiceJob, context: ServiceContext) {
  return { sql: `SELECT 1 FROM service_jobs WHERE id = ? AND phase = ? AND outcome = 'pending' AND lease_token = ? AND lease_until > ?${job.type === 'deletion' ? " AND EXISTS (SELECT 1 FROM accounts WHERE id = service_jobs.account_id AND access = 'deleting' AND revision = service_jobs.expected_revision)" : ''}`, bindings: [job.id, job.phase, job.lease_token, context.now()] }
}
export async function jobBatch(job: ServiceJob, statements: D1PreparedStatement[], context: ServiceContext) {
  return runGuardedBatch(context.env.DB!, jobGuard(job, context), statements)
}
export async function advanceJob(job: ServiceJob, phase: string, context: ServiceContext, statements: D1PreparedStatement[] = []) {
  await jobBatch(job, [...statements, context.env.DB!.prepare("UPDATE service_jobs SET phase = ?,cursor = '',code = NULL WHERE id = ?").bind(phase, job.id)], context)
}
