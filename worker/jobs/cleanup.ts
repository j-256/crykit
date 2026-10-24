import { cleanupAdminCommands } from '../admin/audit'
import { cleanupAdminSessions } from '../admin/session'
import type { ServiceContext } from '../context'
import { reconcileExpiredPublicationWork } from '../sync/commit'
import { cleanupExpiredUploads } from '../sync/storage'
import { advanceJob, type ServiceJob, serviceBatchLimit } from './types'

const auditRetentionMs = 90 * 24 * 60 * 60 * 1000
export async function runCleanup(job: ServiceJob, context: ServiceContext): Promise<void> {
  // Accepted pins and unfinished commits remain authority; age alone never retires history
  await reconcileExpiredPublicationWork(context)
  await cleanupExpiredUploads(context)
  await context.env.DB!.prepare('DELETE FROM service_audit WHERE rowid IN (SELECT rowid FROM service_audit WHERE created_at < ? LIMIT ?)').bind(context.now() - auditRetentionMs, serviceBatchLimit).run()
  await cleanupAdminSessions(context)
  await cleanupAdminCommands(context)
  await advanceJob(job, 'complete', context, [context.env.DB!.prepare("UPDATE service_jobs SET outcome = 'complete' WHERE id = ?").bind(job.id)])
}
