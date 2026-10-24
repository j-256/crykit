import type { D1Database } from '@cloudflare/workers-types/experimental'
import type { RevisionDescriptor } from '../../src/account/protocol'
import type { CustomerPrincipal } from '../auth/session'
import type { ServiceContext } from '../context'
import { runGuardedBatch } from '../db/guarded-batch'
import { ApiFailure } from '../http'
import { syncBatch } from './storage'

export interface WorkIdentity { readonly accountId: string; readonly mutationId: string; readonly digest: string; readonly workId: string; readonly expiresAt: number }
interface Certificate { mutation_id: string; digest: string; work_id: string; head_document: string; head_revision: string; head_generation: string }
export const workIdentityGuard = `EXISTS (
  SELECT 1 FROM publication_work w JOIN publication_progress p USING(account_id,mutation_id)
  WHERE w.account_id = ? AND w.mutation_id = ? AND w.digest = ? AND p.work_id = ? AND w.expires_at = ?
)`
export const workIdentityBindings = (work: WorkIdentity) => [work.accountId, work.mutationId, work.digest, work.workId, work.expiresAt]

// Group predicate clauses to stay within D1's expression-depth budget
// Single-head retained propagation is the member-to-head proof, only while its concrete journal is intact
const eligible = `FROM publication_certificates c
  JOIN publication_work w ON w.account_id = c.account_id AND w.mutation_id = c.mutation_id
  JOIN publication_progress progress ON progress.account_id = c.account_id AND progress.mutation_id = c.mutation_id
  JOIN mutation_receipts receipt ON receipt.account_id = c.account_id AND receipt.mutation_id = c.mutation_id
  JOIN publication_pins head ON head.account_id = c.account_id AND head.mutation_id = c.mutation_id AND head.revision_id = c.head_revision
  JOIN publication_pins member ON member.account_id = c.account_id AND member.mutation_id = c.mutation_id
  JOIN sync_revisions revision ON revision.account_id = member.account_id AND revision.revision_id = member.revision_id
  JOIN upload_reservations upload ON upload.account_id = revision.account_id AND upload.upload_id = revision.upload_id
  JOIN storage_generations generation ON generation.id = upload.generation AND generation.account_id = c.account_id
  JOIN storage_generations head_generation ON head_generation.id = head.generation AND head_generation.account_id = c.account_id
  JOIN sync_revisions head_revision ON head_revision.account_id = c.account_id AND head_revision.revision_id = c.head_revision
  JOIN upload_reservations head_upload ON head_upload.account_id = c.account_id AND head_upload.upload_id = head_revision.upload_id
  WHERE (c.account_id = ? AND c.version = 1 AND c.state = 'intact'
    AND w.state = 'accepted' AND w.digest = c.digest AND progress.work_id = c.work_id AND receipt.digest = c.digest)
  AND (json_array_length(receipt.receipt,'$.heads') = 1
    AND json_extract(receipt.receipt,'$.heads[0].documentId') = c.head_document
    AND json_extract(receipt.receipt,'$.heads[0].revisionId') = c.head_revision)
  AND (head.document_id = c.head_document AND head.done = 1 AND head.retained = 1 AND head.generation = c.head_generation
    AND head_generation.state = 'ready' AND head_upload.generation = c.head_generation AND head_revision.document_id = c.head_document)
  AND (member.document_id = ? AND member.revision_id = ? AND member.generation = ? AND member.done = 1 AND member.retained = 1
    AND revision.document_id = member.document_id AND revision.descriptor = ?)
  AND (upload.document_id = member.document_id AND upload.revision_id = member.revision_id
    AND upload.generation = member.generation AND generation.state = 'ready')
  AND NOT EXISTS (SELECT 1 FROM publication_borrows b WHERE b.account_id = c.account_id AND b.mutation_id = c.mutation_id)`

export async function borrowCertifiedMember(principal: CustomerPrincipal, work: WorkIdentity, revision: RevisionDescriptor, generation: string, context: ServiceContext): Promise<boolean> {
  if (work.accountId !== principal.accountId || revision.accountId !== principal.accountId) throw new ApiFailure('INTEGRITY_FAILED')
  const db = context.env.DB!, args = [work.accountId, revision.documentId, revision.revisionId, generation, JSON.stringify(revision)]
  const source = await db.prepare(`SELECT c.mutation_id,c.digest,c.work_id,c.head_document,c.head_revision,c.head_generation ${eligible} ORDER BY c.mutation_id LIMIT 1`).bind(...args).first<Certificate>()
  if (!source) return false
  context.checkpoint('sync.certificate.candidate')
  const sourceValues = [source.mutation_id, source.digest, source.work_id, source.head_document, source.head_revision, source.head_generation]
  const exactSource = ' AND c.mutation_id = ? AND c.digest = ? AND c.work_id = ? AND c.head_document = ? AND c.head_revision = ? AND c.head_generation = ?'
  // Lookup supplies no authority: bind the exact source again beside the real 0-to-1 transition
  await syncBatch(principal, `${workIdentityGuard}
    AND EXISTS (SELECT 1 FROM publication_work WHERE account_id = ? AND mutation_id = ? AND state = 'validating')
    AND EXISTS (SELECT 1 ${eligible}${exactSource})
    AND NOT EXISTS (SELECT 1 FROM publication_borrows WHERE account_id = ? AND mutation_id = ? AND work_id = ? AND revision_id = ?)
    AND EXISTS (SELECT 1 FROM publication_pins WHERE account_id = ? AND mutation_id = ? AND revision_id = ? AND document_id = ? AND done = 0 AND retained = 0)`,
  [...workIdentityBindings(work), work.accountId, work.mutationId, ...args, ...sourceValues, work.accountId, work.mutationId, work.workId, revision.revisionId, work.accountId, work.mutationId, revision.revisionId, revision.documentId], [
    db.prepare(`INSERT INTO publication_borrows(account_id,mutation_id,work_id,digest,revision_id,document_id,generation,source_mutation,source_digest,source_work,source_head_document,source_head_revision,source_head_generation)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(work.accountId, work.mutationId, work.workId, work.digest, revision.revisionId, revision.documentId, generation, ...sourceValues),
    db.prepare('UPDATE publication_pins SET generation = ?,done = 1 WHERE account_id = ? AND mutation_id = ? AND revision_id = ? AND done = 0').bind(generation, work.accountId, work.mutationId, revision.revisionId),
  ], context, 'SERVICE_UNAVAILABLE')
  context.checkpoint('sync.certificate.claimed')
  return true
}

export function issueCertificate(db: D1Database, work: WorkIdentity, head: { documentId: string; revisionId: string }) {
  return db.prepare(`INSERT INTO publication_certificates(account_id,mutation_id,digest,work_id,head_document,head_revision,head_generation,version,state)
    SELECT ?,?,?,?,?,?,pin.generation,1,'intact' FROM publication_pins pin
    WHERE pin.account_id = ? AND pin.mutation_id = ? AND pin.document_id = ? AND pin.revision_id = ? AND pin.done = 1 AND pin.retained = 1 AND pin.generation IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM publication_borrows WHERE account_id = ? AND mutation_id = ?)`)
    .bind(work.accountId, work.mutationId, work.digest, work.workId, head.documentId, head.revisionId, work.accountId, work.mutationId, head.documentId, head.revisionId, work.accountId, work.mutationId)
}

// Retention/deletion owners compose their own authorization; an expired unfinished consumer still blocks retirement
export async function invalidateClosureCertificate(accountId: string, mutationId: string, context: ServiceContext): Promise<boolean> {
  const db = context.env.DB!
  try {
    await runGuardedBatch(db, { sql: "SELECT NOT EXISTS (SELECT 1 FROM publication_work WHERE account_id = ? AND state IN ('validating','complete'))", bindings: [accountId] }, [db.prepare("UPDATE publication_certificates SET state = 'invalidated' WHERE account_id = ? AND mutation_id = ? AND state = 'intact'").bind(accountId, mutationId)])
    return true
  } catch (error) { if (String(error).includes('transaction_guard_passed')) return false; throw error }
}
