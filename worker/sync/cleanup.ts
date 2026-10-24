import type { CustomerPrincipal } from '../auth/session'
import { liveSessionSql, requireCustomer } from '../auth/session'
import type { ServiceContext } from '../context'
import { runGuardedBatch } from '../db/guarded-batch'
import { ApiFailure, jsonResponse, readJson } from '../http'
import { RevisionDescriptorSchema } from '../../src/account/protocol'
import { AUTOSAVE_RETENTION_MS, AUTOSAVE_RETAINED_VERSIONS, CleanupPreviewRequestSchema, CleanupRequestSchema, type CleanupPreview, type CleanupRequest } from '../../src/account/storage-protocol'
type CipherRef = CleanupRequest['ref']
import { controlBodyBytes, fenceGeneration, generationCleanupStatements } from './storage'
import { admitCloudWork, cloudWorkCost } from '../admission'

// Each incoming retaining edge blocks, even from an archived owner; ancestry alone is not retention
const exclusions = {
  protected: 'r.protected <> 0',
  young: `g.expires_at > ?`,
  recent: `r.revision_id IN (SELECT revision_id FROM head_history WHERE account_id=r.account_id AND document_id=r.document_id GROUP BY revision_id ORDER BY MAX(sequence) DESC LIMIT ${AUTOSAVE_RETAINED_VERSIONS})`,
  current: 'EXISTS (SELECT 1 FROM sync_documents d WHERE d.account_id=r.account_id AND d.document_id=r.document_id AND d.head=r.revision_id)',
  referenced: 'EXISTS (SELECT 1 FROM sync_dependencies d WHERE d.account_id=r.account_id AND d.document_id=r.document_id AND d.dependency_id=r.revision_id)',
  work: "EXISTS (SELECT 1 FROM publication_work w WHERE w.account_id=r.account_id AND w.state IN ('validating','complete'))",
  scan: 'EXISTS (SELECT 1 FROM scan_leases l WHERE l.account_id=r.account_id AND l.expires_at>?)',
  snapshot: "EXISTS (SELECT 1 FROM service_snapshot_pins p JOIN service_snapshots s ON s.id=p.snapshot_id WHERE p.generation=g.id AND s.state NOT IN ('expired','paused'))",
  borrow: "EXISTS (SELECT 1 FROM publication_borrows b JOIN publication_work w ON w.account_id=b.account_id AND w.mutation_id=b.mutation_id WHERE b.account_id=r.account_id AND w.state IN ('validating','complete'))",
  unavailable: "g.state<>'ready' OR NOT EXISTS (SELECT 1 FROM head_history h WHERE h.account_id=r.account_id AND h.document_id=r.document_id AND h.revision_id=r.revision_id)",
} as const
const from = 'sync_revisions r JOIN upload_reservations u ON u.account_id=r.account_id AND u.upload_id=r.upload_id AND u.document_id=r.document_id AND u.revision_id=r.revision_id JOIN storage_generations g ON g.id=u.generation AND g.account_id=r.account_id AND g.upload_id=r.upload_id'
const fields = 'r.account_id=? AND r.document_id=? AND r.revision_id=?'
const denied = Object.values(exclusions).map(sql => `(${sql})`).join(' OR ')
const live = `${liveSessionSql} AND a.access='active' AND a.verified_at IS NOT NULL`
function identity(principal: CustomerPrincipal, ref: CipherRef) { return [principal.accountId, ref.documentId, ref.revisionId] }
interface Candidate { descriptor: string; generation: string; publicationEpoch: number; state: string; reclaimableBytes: number }
async function candidate(principal: CustomerPrincipal, ref: CipherRef, context: ServiceContext): Promise<Candidate> {
  const row = await context.env.DB!.prepare(`SELECT r.descriptor,g.id generation,g.state,COALESCE((SELECT publication_epoch FROM account_sequences WHERE account_id=r.account_id),0) publicationEpoch,COALESCE((SELECT SUM(cipher_bytes+${controlBodyBytes}) FROM upload_chunks WHERE generation=g.id),0) reclaimableBytes FROM ${from} WHERE ${fields}`).bind(...identity(principal, ref)).first<Candidate>()
  if (!row) throw new ApiFailure('NOT_FOUND')
  const descriptor = RevisionDescriptorSchema.safeParse(JSON.parse(row.descriptor))
  if (!descriptor.success || descriptor.data.accountId !== principal.accountId || descriptor.data.documentId !== ref.documentId || descriptor.data.revisionId !== ref.revisionId) throw new ApiFailure('INTEGRITY_FAILED')
  return row
}
export async function previewCleanup(principal: CustomerPrincipal, ref: CipherRef, context: ServiceContext): Promise<CleanupPreview> {
  const row = await candidate(principal, ref, context)
  const flags = await context.env.DB!.prepare(`SELECT ${Object.entries(exclusions).map(([name, sql]) => `(${sql}) AS ${name}`).join(',')} FROM ${from} WHERE ${fields}`).bind(context.now() - AUTOSAVE_RETENTION_MS, context.now(), ...identity(principal, ref)).first<Record<string, number>>()
  const reasons = flags ? (Object.keys(exclusions) as (keyof typeof exclusions)[]).filter(key => flags[key]) : ['unavailable' as const]
  return { version: 1, ref, generation: row.generation, publicationEpoch: row.publicationEpoch, observedAt: context.now(), eligible: reasons.length === 0, reasons, reclaimableBytes: row.reclaimableBytes, dependencies: [...RevisionDescriptorSchema.parse(JSON.parse(row.descriptor)).dependencies] }
}
export async function executeCleanup(principal: CustomerPrincipal, input: CleanupRequest, context: ServiceContext) {
  const db = context.env.DB!, row = await candidate(principal, input.ref, context)
  const blocked = { version: 1 as const, state: 'blocked' as const, releasedBytes: 0 }
  const authBindings = [principal.sessionId, principal.accountId, context.now(), context.now()]
  if (!await db.prepare(live).bind(...authBindings).first()) throw new ApiFailure('FORBIDDEN')
  if (row.generation !== input.generation) return blocked
  if (row.state === 'ready') {
    try {
      // Proof retirement and the closing claim are indivisible; no writer can see unpinned ready bytes
      await runGuardedBatch(db, { sql: `SELECT EXISTS (${live}) AND EXISTS (SELECT 1 FROM ${from} WHERE ${fields} AND g.id=? AND r.descriptor=? AND NOT (${denied}) AND EXISTS (SELECT 1 FROM account_sequences a WHERE a.account_id=r.account_id AND a.publication_epoch=?))`, bindings: [...authBindings, ...identity(principal, input.ref), input.generation, row.descriptor, context.now() - AUTOSAVE_RETENTION_MS, context.now(), input.publicationEpoch] }, [
        db.prepare("UPDATE publication_certificates SET state='invalidated' WHERE account_id=? AND state='intact' AND mutation_id IN (SELECT mutation_id FROM publication_pins WHERE account_id=? AND revision_id=? AND document_id=?)").bind(principal.accountId, principal.accountId, input.ref.revisionId, input.ref.documentId),
        db.prepare("DELETE FROM publication_pins WHERE account_id=? AND revision_id=? AND document_id=? AND mutation_id IN (SELECT mutation_id FROM publication_work WHERE account_id=? AND state IN ('accepted','abandoned'))").bind(principal.accountId, input.ref.revisionId, input.ref.documentId, principal.accountId),
        ...generationCleanupStatements(input.generation, context),
      ])
    } catch (error) { if (String(error).includes('transaction_guard_passed')) return blocked; throw error }
  } else if (!['closing', 'closed', 'unsafe'].includes(row.state)) return blocked
  // A won exact-generation claim remains recoverable after a lost response; never fence a replacement
  const complete = row.state === 'closed' || await fenceGeneration(input.generation, context)
  context.emit({ operation: 'sync', stage: 'cleanup', code: complete ? undefined : 'SERVICE_UNAVAILABLE' })
  return { version: 1 as const, state: complete ? 'complete' as const : 'pending' as const, releasedBytes: complete ? row.reclaimableBytes : 0 }
}
export async function storageRoute(request: Request, context: ServiceContext): Promise<Response | null> {
  const url = new URL(request.url)
  if (!['/api/v1/account/storage', '/api/v1/sync/cleanup/preview', '/api/v1/sync/cleanup'].includes(url.pathname)) return null
  if (url.search) throw new ApiFailure('INVALID_REQUEST')
  const principal = await requireCustomer(request, context)
  if (url.pathname === '/api/v1/account/storage' && request.method === 'GET') {
    const row = await context.env.DB!.prepare('SELECT a.capacity_bytes capacityBytes,COALESCE(q.payload_bytes+q.reserved_metadata+q.metadata_bytes,0) usedBytes FROM accounts a LEFT JOIN quota_counters q ON q.scope=a.id WHERE a.id=?').bind(principal.accountId).first<{ capacityBytes: number; usedBytes: number }>()
    if (!row) throw new ApiFailure('NOT_FOUND')
    return jsonResponse({ version: 1, source: 'application-database', observedAt: context.now(), ...row })
  }
  if (request.method !== 'POST' || principal.access !== 'active') throw new ApiFailure('FORBIDDEN')
  if (url.pathname.endsWith('/preview')) return jsonResponse(await previewCleanup(principal, (await readJson(request, CleanupPreviewRequestSchema, 512)).ref, context))
  const input = await readJson(request, CleanupRequestSchema, 1024)
  await admitCloudWork(principal, cloudWorkCost.cleanup, context)
  return jsonResponse(await executeCleanup(principal, input, context))
}
