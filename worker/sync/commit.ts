import type { CommitRequest, CommitReceipt, RevisionDescriptor } from '../../src/account/protocol'
import { uploadReservationMs, CommitRequestSchema, CommitContinuationSchema } from '../../src/account/protocol'
import { randomId } from '../auth/identity'
import { assertCustomerWrite, type CustomerPrincipal } from '../auth/session'
import type { ServiceContext } from '../context'
import { ApiFailure } from '../http'
import { digest, encodedBytes, encoder, syncBatch } from './storage'
import { reservation } from './uploads'
import { borrowCertifiedMember, issueCertificate, workIdentityGuard, workIdentityBindings, type WorkIdentity } from './certificates'

// A retry continues the same durable frontier; this is a work budget, not a graph-size limit
export const closureStepsPerCall = 48
export const closureRetryAfterSeconds = 1
interface RevisionRow { descriptor: string; document_id: string }
interface WorkRow { digest: string; state: string; expires_at: number; work_id: string | null; processed_steps: number | null }
export async function mutationReceipt(principal: CustomerPrincipal, mutationId: string, context: ServiceContext): Promise<CommitReceipt | null> {
  const row = await context.env.DB!.prepare('SELECT receipt FROM mutation_receipts WHERE account_id = ? AND mutation_id = ?').bind(principal.accountId, mutationId).first<{ receipt: string }>()
  return row ? JSON.parse(row.receipt) as CommitReceipt : null
}
export async function revisionDescriptor(principal: CustomerPrincipal, revisionId: string, context: ServiceContext): Promise<RevisionDescriptor> {
  const row = await context.env.DB!.prepare('SELECT descriptor FROM sync_revisions WHERE account_id = ? AND revision_id = ?').bind(principal.accountId, revisionId).first<RevisionRow>()
  if (!row) throw new ApiFailure('NOT_FOUND')
  return JSON.parse(row.descriptor) as RevisionDescriptor
}
async function validateDescriptors(principal: CustomerPrincipal, input: CommitRequest, context: ServiceContext): Promise<void> {
  const candidates = new Map(input.revisions.map(r => [r.revisionId, r]))
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string) => {
    if (visiting.has(id)) throw new ApiFailure('INTEGRITY_FAILED')
    if (visited.has(id)) return
    visiting.add(id)
    const r = candidates.get(id)
    if (r) for (const ref of [...r.dependencies.map(d => d.revisionId), ...r.parents]) if (candidates.has(ref)) visit(ref)
    visiting.delete(id); visited.add(id)
  }
  for (const revision of input.revisions) {
    if (revision.accountId !== principal.accountId) throw new ApiFailure('NOT_FOUND')
    visit(revision.revisionId)
    const old = await context.env.DB!.prepare('SELECT descriptor FROM sync_revisions WHERE account_id = ? AND revision_id = ?').bind(principal.accountId, revision.revisionId).first<RevisionRow>()
    if (old && old.descriptor !== JSON.stringify(revision)) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
    const upload = await reservation(principal, revision.uploadId, context), start = JSON.parse(upload.request_json)
    if (upload.document_id !== revision.documentId || upload.revision_id !== revision.revisionId || JSON.stringify(start.chunks) !== JSON.stringify(revision.chunks) || encodedBytes(revision) > start.metadataBytes) throw new ApiFailure('INTEGRITY_FAILED')
    for (const parent of revision.parents) {
      const row = candidates.get(parent) ?? await revisionDescriptor(principal, parent, context)
      if (row.documentId !== revision.documentId) throw new ApiFailure('INTEGRITY_FAILED')
    }
    const invalid = await context.env.DB!.prepare("SELECT 1 FROM json_each(?) d LEFT JOIN sync_revisions r ON r.account_id = ? AND r.revision_id = json_extract(d.value,'$.revisionId') LEFT JOIN json_each(?) proposed ON json_extract(proposed.value,'$.revisionId') = json_extract(d.value,'$.revisionId') WHERE COALESCE(json_extract(proposed.value,'$.documentId'),r.document_id) IS NOT json_extract(d.value,'$.documentId') LIMIT 1").bind(JSON.stringify(revision.dependencies),principal.accountId,JSON.stringify(input.revisions.map(r=>({documentId:r.documentId,revisionId:r.revisionId})))).first()
    if(invalid) throw new ApiFailure('NOT_FOUND')
  }
}
async function prepareClosure(principal: CustomerPrincipal, input: CommitRequest, requestDigest: string, context: ServiceContext): Promise<WorkIdentity> {
  const db = context.env.DB!, accountId = principal.accountId
  const readWork = () => db.prepare(`
    SELECT w.digest, w.state, w.expires_at, p.work_id, p.processed_steps
    FROM publication_work w
    LEFT JOIN publication_progress p ON p.account_id = w.account_id AND p.mutation_id = w.mutation_id
    WHERE w.account_id = ? AND w.mutation_id = ?
  `).bind(accountId, input.mutationId).first<WorkRow>()
  let work = await readWork()
  if (work && work.digest !== requestDigest) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
  const abandonedGuard = `EXISTS (
    SELECT 1 FROM publication_work w LEFT JOIN publication_progress p USING(account_id,mutation_id)
    WHERE w.account_id = ? AND w.mutation_id = ? AND w.state = 'abandoned' AND w.expires_at = ? AND p.work_id IS ?
  )`
  const abandonedBindings = work ? [accountId, input.mutationId, work.expires_at, work.work_id] : []
  if (work?.state === 'abandoned') {
    // Pin deletion releases its member binding in the same transaction, with a bounded row budget
    await syncBatch(principal, abandonedGuard, abandonedBindings, [db.prepare(`
      DELETE FROM publication_pins WHERE account_id = ? AND mutation_id = ? AND revision_id IN (
        SELECT revision_id FROM publication_pins WHERE account_id = ? AND mutation_id = ? LIMIT ?
      )
    `).bind(accountId, input.mutationId, accountId, input.mutationId, closureStepsPerCall)], context)
    if (await db.prepare('SELECT 1 FROM publication_pins WHERE account_id = ? AND mutation_id = ? LIMIT 1').bind(accountId, input.mutationId).first()) throw new ApiFailure('SERVICE_UNAVAILABLE', closureRetryAfterSeconds)
  }
  if (!work || work.state === 'abandoned') {
    const roots = [...input.revisions,...input.heads]
    const statements = [db.prepare(`INSERT INTO publication_work(account_id,mutation_id,digest,state,expires_at) VALUES (?,?,?,'validating',?) ON CONFLICT(account_id,mutation_id) DO UPDATE SET state = 'validating',expires_at = excluded.expires_at`).bind(accountId, input.mutationId, requestDigest, context.now() + uploadReservationMs)]
    statements.push(db.prepare('INSERT INTO publication_progress(account_id,mutation_id,work_id,processed_steps) VALUES (?,?,?,0) ON CONFLICT(account_id,mutation_id) DO UPDATE SET work_id = excluded.work_id,processed_steps = 0').bind(accountId,input.mutationId,randomId()))
    statements.push(db.prepare("INSERT INTO publication_pins(account_id,mutation_id,revision_id,document_id,retained) SELECT ?,?,json_extract(value,'$.revisionId'),json_extract(value,'$.documentId'),json_extract(value,'$.retained') FROM json_each(?) WHERE 1 ON CONFLICT(account_id,mutation_id,revision_id) DO UPDATE SET retained = MAX(retained,excluded.retained)").bind(accountId,input.mutationId,JSON.stringify(roots.map(root=>({documentId:root.documentId,revisionId:root.revisionId,retained:Number(input.heads.some(h=>h.revisionId===root.revisionId))})))))
    const emptyProof = `NOT EXISTS (SELECT 1 FROM publication_pins WHERE account_id = ? AND mutation_id = ?)
      AND NOT EXISTS (SELECT 1 FROM publication_borrows WHERE account_id = ? AND mutation_id = ?)`
    const initializationGuard = work ? `${abandonedGuard} AND ${emptyProof}` : 'NOT EXISTS (SELECT 1 FROM publication_work WHERE account_id = ? AND mutation_id = ?)'
    const initializationBindings = work ? [...abandonedBindings, accountId, input.mutationId, accountId, input.mutationId] : [accountId, input.mutationId]
    await syncBatch(principal, initializationGuard, initializationBindings, statements, context, 'SERVICE_UNAVAILABLE')
    work = (await readWork())!
  }
  if (!work.work_id) {
    // A pre-migration unfinished journal keeps its original fixed expiry and exact request digest
    await syncBatch(principal, "EXISTS (SELECT 1 FROM publication_work WHERE account_id = ? AND mutation_id = ? AND digest = ? AND state IN ('validating','complete')) AND NOT EXISTS (SELECT 1 FROM publication_progress WHERE account_id = ? AND mutation_id = ?)", [accountId,input.mutationId,requestDigest,accountId,input.mutationId], [db.prepare('INSERT INTO publication_progress(account_id,mutation_id,work_id,processed_steps) VALUES (?,?,?,0)').bind(accountId,input.mutationId,randomId())], context, 'SERVICE_UNAVAILABLE')
    work = (await readWork())!
  }
  const identity: WorkIdentity = { accountId, mutationId: input.mutationId, digest: requestDigest, workId: work.work_id!, expiresAt: work.expires_at }
  if (work.state === 'complete' || work.state === 'accepted') return identity
  // Every transition is conditional on the same durable incarnation inspected by this call
  const workGuard = `EXISTS (
    SELECT 1 FROM publication_work w
    JOIN publication_progress p ON p.account_id = w.account_id AND p.mutation_id = w.mutation_id
    WHERE w.account_id = ? AND w.mutation_id = ? AND w.digest = ?
      AND w.state = 'validating' AND p.work_id = ? AND w.expires_at = ?
  )`
  const workBindings = workIdentityBindings(identity)
  const candidates = new Map(input.revisions.map(r => [r.revisionId, r]))
  for (let step = 0; step <= closureStepsPerCall; step++) {
    const pin = await db.prepare('SELECT revision_id,document_id,retained FROM publication_pins WHERE account_id = ? AND mutation_id = ? AND done = 0 ORDER BY revision_id LIMIT 1').bind(accountId, input.mutationId).first<{ revision_id: string; document_id: string; retained:number }>()
    if (!pin) {
      await syncBatch(principal, `${workGuard} AND NOT EXISTS (
        SELECT 1 FROM publication_pins WHERE account_id = ? AND mutation_id = ? AND done = 0
      )`, [...workBindings, accountId, input.mutationId], [db.prepare("UPDATE publication_work SET state = 'complete' WHERE account_id = ? AND mutation_id = ?").bind(accountId, input.mutationId)], context)
      return identity
    }
    if (step === closureStepsPerCall) break
    const revision = candidates.get(pin.revision_id) ?? await revisionDescriptor(principal, pin.revision_id, context)
    if (revision.documentId !== pin.document_id) throw new ApiFailure('INTEGRITY_FAILED')
    const upload = await reservation(principal, revision.uploadId, context)
    if (!input.heads.length && await borrowCertifiedMember(principal, identity, revision, upload.generation, context)) {
      context.checkpoint('sync.closure.step')
      continue
    }
    const statements = [db.prepare('UPDATE publication_pins SET generation = ?,done = 1 WHERE account_id = ? AND mutation_id = ? AND revision_id = ?').bind(upload.generation, accountId, input.mutationId, pin.revision_id)]
    // Another retry can promote this node after the frontier read; propagate its transactional flag
    statements.push(db.prepare("INSERT INTO publication_pins(account_id,mutation_id,revision_id,document_id,retained) SELECT ?,?,json_extract(value,'$.revisionId'),json_extract(value,'$.documentId'),(SELECT retained FROM publication_pins WHERE account_id = ? AND mutation_id = ? AND revision_id = ?) FROM json_each(?) WHERE 1 ON CONFLICT(account_id,mutation_id,revision_id) DO UPDATE SET done = CASE WHEN excluded.retained > retained THEN 0 ELSE done END,retained = MAX(retained,excluded.retained)").bind(accountId,input.mutationId,accountId,input.mutationId,pin.revision_id,JSON.stringify(revision.dependencies)))
    await syncBatch(principal, `${workGuard} AND EXISTS (
      SELECT 1 FROM storage_generations g JOIN upload_reservations u ON u.generation = g.id
      WHERE g.id = ? AND u.account_id = ? AND u.upload_id = ? AND g.state = 'ready'
    )`, [...workBindings, upload.generation, accountId, revision.uploadId], statements, context)
    context.checkpoint('sync.closure.step')
  }
  context.emit({ operation: 'sync', stage: 'closure-budget', code: 'SERVICE_UNAVAILABLE', mutationId: input.mutationId })
  const observed = await readWork()
  const continuation = observed?.state === 'validating' && observed.expires_at > context.now() && observed.work_id === work.work_id ? CommitContinuationSchema.parse({ mutationId: input.mutationId, requestDigest, workId: observed.work_id, expiresAt: observed.expires_at, processed: observed.processed_steps }) : undefined
  throw new ApiFailure('SERVICE_UNAVAILABLE', closureRetryAfterSeconds, continuation)
}
export async function commitRevisions(principal: CustomerPrincipal, input: CommitRequest, context: ServiceContext): Promise<CommitReceipt> {
  input = CommitRequestSchema.parse(input)
  await assertCustomerWrite(principal, 'commit', context)
  const db = context.env.DB!, accountId = principal.accountId
  const requestDigest = await digest(encoder.encode(JSON.stringify(input)))
  const prior = await db.prepare('SELECT digest,receipt FROM mutation_receipts WHERE account_id = ? AND mutation_id = ?').bind(accountId, input.mutationId).first<{ digest: string; receipt: string }>()
  // Reconcile accepted identity before applying a later CAS or renewing an expired upload
  if (prior) { if (prior.digest !== requestDigest) throw new ApiFailure('IDEMPOTENCY_MISMATCH'); return JSON.parse(prior.receipt) as CommitReceipt }
  await validateDescriptors(principal, input, context)
  const completedWork = await prepareClosure(principal, input, requestDigest, context)
  for (const head of input.heads) {
    const revision = input.revisions.find(r => r.revisionId === head.revisionId) ?? await revisionDescriptor(principal, head.revisionId, context)
    if (revision.documentId !== head.documentId) throw new ApiFailure('INTEGRITY_FAILED')
  }
  const commandJson = JSON.stringify(input)
  // JSON table inputs keep binding count bounded; each descriptor remains a separate D1 row
  const headMatch = `NOT EXISTS (SELECT 1 FROM json_each(?) e LEFT JOIN sync_documents d ON d.account_id = ? AND d.document_id = json_extract(e.value,'$.documentId') WHERE d.head IS NOT json_extract(e.value,'$.revisionId'))`
  const changed = `EXISTS (SELECT 1 FROM json_each(?) h LEFT JOIN sync_documents d ON d.account_id = ? AND d.document_id = json_extract(h.value,'$.documentId') WHERE d.head IS NOT json_extract(h.value,'$.revisionId'))`
  const statements = [db.prepare('INSERT OR IGNORE INTO account_sequences(account_id) VALUES (?)').bind(accountId), db.prepare(`UPDATE account_sequences SET sequence = sequence + 1,publication_epoch = publication_epoch + (${changed}) WHERE account_id = ?`).bind(JSON.stringify(input.heads), accountId, accountId)]
  for (const revision of input.revisions) {
    const descriptor = JSON.stringify(revision)
    statements.push(db.prepare("UPDATE quota_counters SET reserved_metadata = reserved_metadata - COALESCE((SELECT descriptor_reserve FROM upload_reservations WHERE account_id = ? AND upload_id = ?),0) WHERE scope IN ('global',?) AND NOT EXISTS (SELECT 1 FROM sync_revisions WHERE account_id = ? AND revision_id = ?)").bind(accountId, revision.uploadId, accountId, accountId, revision.revisionId), db.prepare('INSERT OR IGNORE INTO sync_revisions(account_id,revision_id,document_id,upload_id,descriptor,protected) VALUES (?,?,?,?,?,?)').bind(accountId, revision.revisionId, revision.documentId, revision.uploadId, descriptor, Number(revision.protected)), db.prepare('UPDATE upload_reservations SET descriptor_reserve = 0 WHERE account_id = ? AND upload_id = ?').bind(accountId, revision.uploadId))
    statements.push(db.prepare("INSERT OR IGNORE INTO sync_dependencies(account_id,revision_id,dependency_id,document_id) SELECT ?,?,json_extract(value,'$.revisionId'),json_extract(value,'$.documentId') FROM json_each(?)").bind(accountId,revision.revisionId,JSON.stringify(revision.dependencies)))
  }
  for (const head of input.heads) {
    statements.push(db.prepare('INSERT INTO head_history(account_id,document_id,sequence,revision_id) SELECT ?,?,sequence,? FROM account_sequences WHERE account_id = ? AND NOT EXISTS (SELECT 1 FROM sync_documents WHERE account_id = ? AND document_id = ? AND head = ?)').bind(accountId, head.documentId, head.revisionId, accountId, accountId, head.documentId, head.revisionId), db.prepare('INSERT INTO sync_documents(account_id,document_id,head,first_sequence) SELECT ?,?,?,sequence FROM account_sequences WHERE account_id = ? ON CONFLICT(account_id,document_id) DO UPDATE SET head = excluded.head').bind(accountId, head.documentId, head.revisionId, accountId))
  }
  statements.push(db.prepare(`INSERT INTO mutation_receipts(account_id,mutation_id,digest,sequence,receipt,group_json) SELECT ?,?,?,sequence,json_object('version',1,'mutationId',?,'sequence',sequence,'publicationEpoch',publication_epoch,'heads',json(?)),json_object('sequence',sequence,'mutationId',?,'revisions',json_extract(?,'$.revisions'),'heads',json_extract(?,'$.heads')) FROM account_sequences WHERE account_id = ?`).bind(accountId, input.mutationId, requestDigest, input.mutationId, JSON.stringify(input.heads), input.mutationId, commandJson, commandJson, accountId), db.prepare('UPDATE publication_work SET state = ? WHERE account_id = ? AND mutation_id = ?').bind(input.heads.length ? 'accepted' : 'abandoned', accountId, input.mutationId))
  if (input.heads.length === 1) statements.push(issueCertificate(db, completedWork, input.heads[0]))
  // Pending work bars cleanup, so completed immutable closure pins stay ready until this
  // transaction activates them; rescanning the graph here would make publication unbounded
  context.checkpoint('sync.commit.before')
  try {
    await syncBatch(principal, `NOT EXISTS (SELECT 1 FROM json_each(?) r LEFT JOIN upload_reservations u ON u.account_id = ? AND u.upload_id = json_extract(r.value,'$.uploadId') LEFT JOIN storage_generations g ON g.id = u.generation LEFT JOIN sync_revisions existing ON existing.account_id = u.account_id AND existing.revision_id = json_extract(r.value,'$.revisionId') WHERE g.state IS NOT 'ready' OR (existing.descriptor IS NOT NULL AND existing.descriptor <> r.value)) AND ${headMatch} AND (? IS NULL OR COALESCE((SELECT publication_epoch FROM account_sequences WHERE account_id = ?),0) = ?) AND COALESCE((SELECT sequence FROM account_sequences WHERE account_id = ?),0) < ? AND COALESCE((SELECT publication_epoch FROM account_sequences WHERE account_id = ?),0) < ? AND EXISTS (SELECT 1 FROM publication_work WHERE account_id = ? AND mutation_id = ? AND digest = ? AND state = 'complete') AND ${workIdentityGuard} AND NOT EXISTS (SELECT 1 FROM mutation_receipts WHERE account_id = ? AND mutation_id = ?)`, [JSON.stringify(input.revisions), accountId, JSON.stringify(input.expected), accountId, input.expectedPublicationEpoch ?? null, accountId, input.expectedPublicationEpoch ?? null, accountId, Number.MAX_SAFE_INTEGER, accountId, Number.MAX_SAFE_INTEGER, accountId, input.mutationId, requestDigest, ...workIdentityBindings(completedWork), accountId, input.mutationId], statements, context, 'HEAD_CONFLICT')
  } catch (error) {
    const won = await db.prepare('SELECT digest,receipt FROM mutation_receipts WHERE account_id = ? AND mutation_id = ?').bind(accountId, input.mutationId).first<{ digest: string; receipt: string }>()
    if (won?.digest === requestDigest) return JSON.parse(won.receipt) as CommitReceipt
    if (error instanceof ApiFailure && error.code === 'HEAD_CONFLICT') {
      const identityChanged = await db.prepare("SELECT 1 FROM json_each(?) r JOIN sync_revisions existing ON existing.account_id = ? AND existing.revision_id = json_extract(r.value,'$.revisionId') WHERE existing.descriptor <> r.value LIMIT 1").bind(JSON.stringify(input.revisions),accountId).first()
      if (identityChanged) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
      const headsStillMatch = await db.prepare(`SELECT ${headMatch} AND (? IS NULL OR (SELECT publication_epoch FROM account_sequences WHERE account_id = ?) = ?) AS matches`).bind(JSON.stringify(input.expected),accountId,input.expectedPublicationEpoch ?? null,accountId,input.expectedPublicationEpoch ?? null).first('matches')
      // Internal journal abandonment or counter exhaustion is not a user head conflict
      if (headsStillMatch) throw new ApiFailure('SERVICE_UNAVAILABLE',closureRetryAfterSeconds)
    }
    throw error
  }
  context.checkpoint('sync.commit.after')
  return (await mutationReceipt(principal, input.mutationId, context))!
}

export async function reconcileExpiredPublicationWork(context: ServiceContext): Promise<number> {
  const db = context.env.DB!
  // A delayed scan cannot expire replacement work under the same mutation identity
  const rows = await db.prepare(`
    SELECT w.account_id,w.mutation_id,w.expires_at,p.work_id
    FROM publication_work w LEFT JOIN publication_progress p USING(account_id,mutation_id)
    WHERE w.expires_at <= ? AND w.state IN ('validating','complete') ORDER BY w.expires_at LIMIT ?
  `).bind(context.now(), closureStepsPerCall).all<{ account_id: string; mutation_id: string; expires_at: number; work_id: string | null }>()
  context.checkpoint('sync.expiry.selected')
  await db.prepare('DELETE FROM scan_leases WHERE id IN (SELECT id FROM scan_leases WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)').bind(context.now(), closureStepsPerCall).run()
  let released = 0
  for (const row of rows.results) {
    const result = await db.prepare(`
      UPDATE publication_work SET state = 'abandoned'
      WHERE account_id = ? AND mutation_id = ? AND expires_at = ? AND state IN ('validating','complete')
        AND (SELECT work_id FROM publication_progress WHERE account_id = ? AND mutation_id = ?) IS ?
        AND NOT EXISTS (SELECT 1 FROM mutation_receipts WHERE account_id = ? AND mutation_id = ?)
      RETURNING mutation_id
    `).bind(row.account_id, row.mutation_id, row.expires_at, row.account_id, row.mutation_id, row.work_id, row.account_id, row.mutation_id).all()
    released += result.results.length
  }
  return released
}
