import { runGuardedBatch } from '../db/guarded-batch'
import type { CustomerPrincipal } from '../auth/session'
import type { ServiceContext } from '../context'
import { ApiFailure } from '../http'
import { RecoverySupersessionSchema, type RecoverySupersession, type RecoveryOperationStatus, MAX_RECOVERY_BYTES, MAX_RECOVERY_POINTS, RECOVERY_RETENTION_MS, RecoveryBindingSchema, type RecoveryBinding, RECOVERY_CONTROL_BYTES, RECOVERY_REVISION_CONTROL_BYTES, RecoveryReserveSchema, type RecoveryPoint, type RecoveryReserve } from '../../src/account/recovery-protocol'
import type { CommitRequest, RevisionDescriptor } from '../../src/account/protocol'
import { claimGenerationCleanup, fenceGeneration, chunkRow, controlReservationBytes, digest, encodedBytes, encoder, syncBatch } from './storage'

interface RecoveryRow {
  account_id: string; operation_id: string; request_digest: string; state: RecoveryPoint['state']; sealed: number
  reserved_bytes: number; admitted_bytes: number; created_at: number; completed_at: number | null
  expires_at: number | null; mutation_id: string | null; binding_json: string | null; accepted_at: number | null
}
async function recoveryRow(principal: CustomerPrincipal, operationId: string, context: ServiceContext): Promise<RecoveryRow> {
  const row = await context.env.DB!.prepare('SELECT * FROM account_recoveries WHERE account_id=? AND operation_id=?').bind(principal.accountId, operationId).first<RecoveryRow>()
  if (!row) throw new ApiFailure('NOT_FOUND')
  return row
}
async function point(row: RecoveryRow, context: ServiceContext): Promise<RecoveryPoint> {
  const revisions = await context.env.DB!.prepare('SELECT descriptor FROM recovery_revisions WHERE account_id=? AND operation_id=? ORDER BY revision_id').bind(row.account_id, row.operation_id).all<{ descriptor: string }>()
  return { version: 1, operationId: row.operation_id, state: row.state, sealed: row.sealed === 1, reservedBytes: row.reserved_bytes, admittedBytes: row.admitted_bytes, revisions: revisions.results.map(r => JSON.parse(r.descriptor) as RevisionDescriptor), createdAt: row.created_at, completedAt: row.completed_at, expiresAt: row.expires_at, mutationId: row.mutation_id, acceptedAt: row.accepted_at }
}
export async function listRecoveries(principal: CustomerPrincipal, context: ServiceContext) {
  const rows = await context.env.DB!.prepare('SELECT * FROM account_recoveries WHERE account_id=? ORDER BY created_at,operation_id').bind(principal.accountId).all<RecoveryRow>()
  const points = await Promise.all(rows.results.map(row => point(row, context)))
  await syncBatch(principal, '1', [], [], context, 'AUTH_REQUIRED', false, false)
  return { version: 1 as const, points }
}
export async function recoveryOperationStatus(principal: CustomerPrincipal, operationId: string, context: ServiceContext): Promise<RecoveryOperationStatus> {
  // Read ownership in one statement. Only permanent terminal evidence permits local cleanup;
  // active and unknown results remain conservative if a concurrent reserve or retirement wins
  const status = await context.env.DB!.prepare(`SELECT CASE
    WHEN EXISTS(SELECT 1 FROM account_recoveries WHERE account_id=?1 AND operation_id=?2) THEN 'active'
    WHEN EXISTS(SELECT 1 FROM cancelled_recoveries WHERE account_id=?1 AND operation_id=?2)
      OR EXISTS(SELECT 1 FROM superseded_recoveries WHERE account_id=?1 AND operation_id=?2)
      OR EXISTS(SELECT 1 FROM upload_reservations WHERE account_id=?1 AND recovery_operation_id=?2) THEN 'retired'
    ELSE 'unknown' END AS status`).bind(principal.accountId, operationId).first<RecoveryOperationStatus['status']>('status')
  await syncBatch(principal, '1', [], [], context, 'AUTH_REQUIRED', false, false)
  if (!status) throw new ApiFailure('INTEGRITY_FAILED')
  return { version: 1, operationId, status }
}
export async function reserveRecovery(principal: CustomerPrincipal, input: RecoveryReserve, context: ServiceContext): Promise<RecoveryPoint> {
  input = RecoveryReserveSchema.parse(input)
  const db = context.env.DB!, accountId = principal.accountId
  // Descriptor order is not identity; ciphertext, upload IDs, and the exact set are immutable
  const revisions = [...input.revisions].sort((a, b) => a.revisionId < b.revisionId ? -1 : a.revisionId > b.revisionId ? 1 : 0)
  const requestDigest = await digest(encoder.encode(JSON.stringify({ ...input, revisions })))
  try {
    const prior = await db.prepare('SELECT * FROM account_recoveries WHERE account_id=? AND operation_id=?').bind(accountId, input.operationId).first<RecoveryRow>()
    if (prior) {
      if (prior.request_digest !== requestDigest) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
      await syncBatch(principal, '1', [], [], context)
      return point(prior, context)
    }
    if (await db.prepare('SELECT 1 FROM cancelled_recoveries WHERE account_id=? AND operation_id=?').bind(accountId, input.operationId).first()) throw new ApiFailure('NOT_FOUND')
    if (await db.prepare('SELECT 1 FROM upload_reservations WHERE account_id=? AND recovery_operation_id=? LIMIT 1').bind(accountId, input.operationId).first()) throw new ApiFailure('NOT_FOUND')
    if (revisions.some(r => r.accountId !== accountId)) throw new ApiFailure('NOT_FOUND')
    const ciphertextBytes = revisions.reduce((total, r) => total + r.chunks.reduce((sum, c) => sum + c.cipherBytes, 0), 0)
    if (input.reservedBytes !== ciphertextBytes) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
    const admittedBytes = ciphertextBytes + RECOVERY_CONTROL_BYTES + revisions.reduce((sum, r) => sum + encodedBytes(r) + RECOVERY_REVISION_CONTROL_BYTES + r.chunks.length * controlReservationBytes, 0)
    const revisionsJson = JSON.stringify(revisions)
    const capacityGuard = `(SELECT COUNT(*) FROM account_recoveries WHERE account_id=?) < ? AND ?+(SELECT COALESCE(SUM(admitted_bytes),0) FROM account_recoveries WHERE account_id=?) <= MIN(?,(SELECT capacity_bytes FROM accounts WHERE id=?))`
    const capacityBindings = [accountId, MAX_RECOVERY_POINTS, admittedBytes, accountId, MAX_RECOVERY_BYTES, accountId]
    const ownershipGuard = `NOT EXISTS (SELECT 1 FROM json_each(?) j JOIN sync_revisions s ON s.account_id=? AND (s.revision_id=json_extract(j.value,'$.revisionId') OR s.upload_id=json_extract(j.value,'$.uploadId')))
      AND NOT EXISTS (SELECT 1 FROM json_each(?) j JOIN recovery_revisions r ON r.account_id=? AND (r.revision_id=json_extract(j.value,'$.revisionId') OR r.upload_id=json_extract(j.value,'$.uploadId')))
      AND NOT EXISTS (SELECT 1 FROM json_each(?) j JOIN upload_reservations u ON u.account_id=? AND (u.revision_id=json_extract(j.value,'$.revisionId') OR u.upload_id=json_extract(j.value,'$.uploadId')) WHERE u.recovery_operation_id IS NOT NULL OR COALESCE((SELECT state FROM storage_generations WHERE id=u.generation),'') NOT IN ('staging','ready') OR u.upload_id<>json_extract(j.value,'$.uploadId') OR u.revision_id<>json_extract(j.value,'$.revisionId') OR u.document_id<>json_extract(j.value,'$.documentId') OR json_extract(u.request_json,'$.chunks')<>json_extract(j.value,'$.chunks'))
      AND NOT EXISTS (SELECT 1 FROM publication_pins p JOIN json_each(?) j ON p.revision_id=json_extract(j.value,'$.revisionId') WHERE p.account_id=?)`
    const ownershipBindings = [revisionsJson, accountId, revisionsJson, accountId, revisionsJson, accountId, revisionsJson, accountId]
    if (!await db.prepare(`SELECT ${ownershipGuard} AS ok`).bind(...ownershipBindings).first('ok')) throw new ApiFailure('INTEGRITY_FAILED')
    if (admittedBytes > Math.min(MAX_RECOVERY_BYTES, (await db.prepare('SELECT capacity_bytes FROM accounts WHERE id=?').bind(accountId).first<number>('capacity_bytes'))!)) throw new ApiFailure('QUOTA_EXCEEDED')
    // A bounded oldest-first pass frees logical slots; retained shared bytes still face the account quota
    if (!await db.prepare(`SELECT ${capacityGuard} AS ok`).bind(...capacityBindings).first('ok')) {
      const completed = await db.prepare("SELECT operation_id FROM account_recoveries WHERE account_id=? AND state='completed' ORDER BY completed_at,operation_id LIMIT ?").bind(accountId, MAX_RECOVERY_POINTS).all<{operation_id:string}>()
      for (const row of completed.results) {
        await retireRecovery(accountId, row.operation_id, context, principal)
        if (await db.prepare(`SELECT ${capacityGuard} AS ok`).bind(...capacityBindings).first('ok')) break
      }
    }
    const statements = [db.prepare("INSERT INTO account_recoveries(account_id,operation_id,request_digest,state,reserved_bytes,admitted_bytes,created_at) VALUES (?,?,?,'pending',?,?,?)").bind(accountId, input.operationId, requestDigest, ciphertextBytes, admittedBytes, context.now())]
    for (const revision of revisions) {
      const stagingBytes = revision.chunks.reduce((sum, c) => sum + c.cipherBytes + controlReservationBytes, 0)
      statements.push(db.prepare('INSERT INTO recovery_revisions(account_id,operation_id,upload_id,revision_id,descriptor,staging_reserve) VALUES (?,?,?,?,?,CASE WHEN EXISTS(SELECT 1 FROM upload_reservations WHERE account_id=? AND upload_id=?) THEN 0 ELSE ? END)').bind(accountId, input.operationId, revision.uploadId, revision.revisionId, JSON.stringify(revision), accountId, revision.uploadId, stagingBytes),
        // The recovery descriptor is already charged metadata and will never enter sync_revisions
        db.prepare("UPDATE quota_counters SET reserved_metadata=reserved_metadata-COALESCE((SELECT descriptor_reserve FROM upload_reservations WHERE account_id=? AND upload_id=?),0) WHERE scope='global' OR scope=?").bind(accountId, revision.uploadId, accountId),
        db.prepare('UPDATE upload_reservations SET descriptor_reserve=0,recovery_operation_id=? WHERE account_id=? AND upload_id=?').bind(input.operationId, accountId, revision.uploadId))
    }
    await syncBatch(principal, `${capacityGuard} AND ${ownershipGuard} AND NOT EXISTS(SELECT 1 FROM cancelled_recoveries WHERE account_id=? AND operation_id=?) AND NOT EXISTS(SELECT 1 FROM upload_reservations WHERE account_id=? AND recovery_operation_id=?) AND NOT EXISTS(SELECT 1 FROM account_recoveries WHERE account_id=? AND operation_id=?)`, [...capacityBindings, ...ownershipBindings, accountId, input.operationId, accountId, input.operationId, accountId, input.operationId], statements, context, 'QUOTA_EXCEEDED')
    return point(await recoveryRow(principal, input.operationId, context), context)
  } catch (error) {
    const won = await db.prepare('SELECT * FROM account_recoveries WHERE account_id=? AND operation_id=?').bind(accountId, input.operationId).first<RecoveryRow>()
    if (won?.request_digest === requestDigest) {
      await syncBatch(principal, '1', [], [], context, 'FORBIDDEN', true, false)
      return point(won, context)
    }
    if (won) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
    throw error
  }
}
export async function sealRecovery(principal: CustomerPrincipal, operationId: string, context: ServiceContext): Promise<RecoveryPoint> {
  const row = await recoveryRow(principal, operationId, context), db = context.env.DB!
  // Capture exact ready generations atomically with the seal; unsealed transport keeps ordinary expiry
  await syncBatch(principal, `EXISTS(SELECT 1 FROM account_recoveries WHERE account_id=? AND operation_id=? AND state='pending') AND NOT EXISTS(
    SELECT 1 FROM recovery_revisions r LEFT JOIN upload_reservations u ON u.account_id=r.account_id AND u.upload_id=r.upload_id LEFT JOIN storage_generations g ON g.id=u.generation
    WHERE r.account_id=? AND r.operation_id=? AND (u.recovery_operation_id IS NOT r.operation_id OR g.state IS NOT 'ready' OR r.staging_reserve<>0 OR (SELECT COUNT(*) FROM upload_chunks c WHERE c.generation=g.id AND c.state='ready')<>json_array_length(json_extract(r.descriptor,'$.chunks'))))
    AND NOT EXISTS(SELECT 1 FROM recovery_revisions r JOIN sync_revisions s ON s.account_id=r.account_id AND s.revision_id=r.revision_id WHERE r.account_id=? AND r.operation_id=?)`, [principal.accountId, operationId, principal.accountId, operationId, principal.accountId, operationId], [
    db.prepare('UPDATE recovery_revisions SET generation=(SELECT generation FROM upload_reservations u WHERE u.account_id=recovery_revisions.account_id AND u.upload_id=recovery_revisions.upload_id) WHERE account_id=? AND operation_id=?').bind(principal.accountId, operationId),
    db.prepare('UPDATE account_recoveries SET sealed=1 WHERE account_id=? AND operation_id=?').bind(principal.accountId, operationId),
  ], context)
  return point({ ...row, sealed: 1 }, context)
}

// Bind the full request digest, but retain only opaque guards and heads as server control metadata
export function recoveryPublicationBinding(input: CommitRequest, requestDigest: string): string {
  return JSON.stringify({ mutationId: input.mutationId, expectedPublicationEpoch: input.expectedPublicationEpoch, expected: input.expected, heads: input.heads, requestDigest })
}
export function recoveryPublicationGuard(accountId: string, input: CommitRequest, requestDigest: string) {
  return input.recoveryOperationId ? {
    sql: "EXISTS(SELECT 1 FROM account_recoveries WHERE account_id=? AND operation_id=? AND state='pending' AND sealed=1 AND mutation_id=? AND binding_json=? AND accepted_at IS NULL)",
    bindings: [accountId, input.recoveryOperationId, input.mutationId, recoveryPublicationBinding(input, requestDigest)],
  } : {
    sql: 'NOT EXISTS(SELECT 1 FROM account_recoveries WHERE account_id=? AND mutation_id=?)',
    bindings: [accountId, input.mutationId],
  }
}
export async function bindRecoveryPublication(principal: CustomerPrincipal, input: RecoveryBinding, context: ServiceContext): Promise<RecoveryPoint> {
  input = RecoveryBindingSchema.parse(input)
  const row = await recoveryRow(principal, input.operationId, context), db = context.env.DB!, publication = input.publication
  const requestDigest = await digest(encoder.encode(JSON.stringify(publication)))
  const binding = recoveryPublicationBinding(publication, requestDigest)
  if (row.sealed !== 1 || row.state !== 'pending') throw new ApiFailure('INTEGRITY_FAILED')
  if (row.binding_json === binding) {
    await syncBatch(principal, '1', [], [], context)
    return point(row, context)
  }
  const old = row.binding_json ? JSON.parse(row.binding_json) as { expectedPublicationEpoch: number } : null
  if (row.mutation_id && (input.supersedesMutationId !== row.mutation_id || row.mutation_id === publication.mutationId)) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
  // An unknown receipt at the unchanged epoch is still an in-flight write, not permission to replace it
  const superseded = old ? `AND NOT EXISTS(SELECT 1 FROM mutation_receipts WHERE account_id=? AND mutation_id=?) AND COALESCE((SELECT publication_epoch FROM account_sequences WHERE account_id=?),0)>?` : ''
  await syncBatch(principal, `EXISTS(SELECT 1 FROM account_recoveries WHERE account_id=? AND operation_id=? AND state='pending' AND sealed=1 AND binding_json IS ? AND accepted_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM mutation_receipts WHERE account_id=? AND mutation_id=?)
    AND NOT EXISTS(SELECT 1 FROM account_recoveries WHERE account_id=? AND mutation_id=? AND operation_id<>?)
    AND COALESCE((SELECT publication_epoch FROM account_sequences WHERE account_id=?),0)=? ${superseded}`,
  [principal.accountId, input.operationId, row.binding_json, principal.accountId, publication.mutationId, principal.accountId, publication.mutationId, input.operationId, principal.accountId, publication.expectedPublicationEpoch!, ...(old ? [principal.accountId, row.mutation_id, principal.accountId, old.expectedPublicationEpoch] : [])], [
    db.prepare('UPDATE account_recoveries SET binding_json=?,mutation_id=? WHERE account_id=? AND operation_id=?').bind(binding, publication.mutationId, principal.accountId, input.operationId),
  ], context, 'HEAD_CONFLICT')
  return point(await recoveryRow(principal, input.operationId, context), context)
}
export async function completeRecovery(principal: CustomerPrincipal, operationId: string, context: ServiceContext): Promise<RecoveryPoint> {
  await recoveryRow(principal, operationId, context)
  const db = context.env.DB!
  // Acceptance is written beside the mutation receipt, so delayed completion never extends retention
  await syncBatch(principal, `EXISTS(SELECT 1 FROM account_recoveries r JOIN mutation_receipts m ON m.account_id=r.account_id AND m.mutation_id=r.mutation_id
    WHERE r.account_id=? AND r.operation_id=? AND r.sealed=1 AND r.state IN ('pending','completed') AND r.accepted_at IS NOT NULL
      AND m.digest=json_extract(r.binding_json,'$.requestDigest') AND json_extract(m.receipt,'$.heads')=json_extract(r.binding_json,'$.heads'))`, [principal.accountId, operationId], [
    db.prepare("UPDATE account_recoveries SET state='completed',completed_at=accepted_at,expires_at=accepted_at+? WHERE account_id=? AND operation_id=?").bind(RECOVERY_RETENTION_MS, principal.accountId, operationId),
  ], context)
  // Acceptance can win after the initial read, so return the transaction's recorded timestamps
  return point(await recoveryRow(principal, operationId, context), context)
}
export async function recoveryChunk(principal: CustomerPrincipal, operationId: string, revisionId: string, index: number, context: ServiceContext): Promise<Uint8Array> {
  const db = context.env.DB!
  const row = await db.prepare("SELECT r.generation FROM recovery_revisions r JOIN account_recoveries p ON p.account_id=r.account_id AND p.operation_id=r.operation_id WHERE r.account_id=? AND r.operation_id=? AND r.revision_id=? AND p.sealed=1 AND p.state IN ('pending','completed')").bind(principal.accountId, operationId, revisionId).first<{ generation: string }>()
  if (!row) throw new ApiFailure('NOT_FOUND')
  const chunk = await chunkRow(row.generation, index, context)
  if (chunk.account_id !== principal.accountId || chunk.state !== 'ready') throw new ApiFailure('NOT_FOUND')
  const object = await context.env.OBJECTS!.get(chunk.object_key)
  if (!object) throw new ApiFailure('NOT_FOUND')
  const bytes = new Uint8Array(await object.arrayBuffer())
  if (bytes.length !== chunk.cipher_bytes || await digest(bytes) !== chunk.cipher_digest) throw new ApiFailure('INTEGRITY_FAILED')
  await syncBatch(principal, "EXISTS(SELECT 1 FROM recovery_revisions r JOIN account_recoveries p ON p.account_id=r.account_id AND p.operation_id=r.operation_id JOIN upload_chunks c ON c.generation=r.generation WHERE r.account_id=? AND r.operation_id=? AND r.revision_id=? AND r.generation=? AND c.chunk_index=? AND c.state='ready' AND p.sealed=1 AND p.state IN ('pending','completed'))", [principal.accountId, operationId, revisionId, row.generation, index], [], context, 'NOT_FOUND', false, false)
  return bytes
}

async function retireRecovery(accountId: string, operationId: string, context: ServiceContext, principal?: CustomerPrincipal) {
  const db = context.env.DB!
  const row = await db.prepare('SELECT state FROM account_recoveries WHERE account_id=? AND operation_id=?').bind(accountId, operationId).first<{ state: string }>()
  if (principal) await syncBatch(principal, '1', [], [], context, 'FORBIDDEN', true, false)
  if (!row) return { version: 1 as const, state: 'complete' as const }
  if (row.state !== 'completed') return { version: 1 as const, state: 'blocked' as const }
  const generations = await db.prepare('SELECT generation FROM recovery_revisions WHERE account_id=? AND operation_id=? ORDER BY generation').bind(accountId, operationId).all<{ generation: string }>()
  // Retirement transfers cleanup responsibility to the permanent upload owner without releasing bytes
  // Snapshot/publication pins still guard physical fencing, but no longer consume a recovery slot
  const guard = "EXISTS(SELECT 1 FROM account_recoveries WHERE account_id=? AND operation_id=? AND state='completed' AND sealed=1 AND accepted_at IS NOT NULL)"
  const bindings = [accountId, operationId]
  const statements = [
    db.prepare('UPDATE storage_generations SET expires_at=MIN(expires_at,?) WHERE id IN (SELECT generation FROM recovery_revisions WHERE account_id=? AND operation_id=?)').bind(context.now(), accountId, operationId),
    db.prepare('DELETE FROM recovery_revisions WHERE account_id=? AND operation_id=?').bind(accountId, operationId),
    db.prepare('DELETE FROM account_recoveries WHERE account_id=? AND operation_id=?').bind(accountId, operationId),
  ]
  try {
    if (principal) await syncBatch(principal, guard, bindings, statements, context, 'INTEGRITY_FAILED', true, false)
    else await runGuardedBatch(db, { sql: `SELECT ${guard}`, bindings }, statements)
  } catch (error) {
    if (String(error).includes('transaction_guard_passed')) return { version: 1 as const, state: 'blocked' as const }
    throw error
  }
  // Bound each call; remaining generations retain their full charge for the ordinary cleanup job
  let pending = generations.results.length > 1
  for (const { generation } of generations.results.slice(0, 1)) {
    if (await claimGenerationCleanup(accountId, generation, context)) pending = !await fenceGeneration(generation, context) || pending
    else pending = true
  }
  context.emit({ operation: 'sync', stage: pending ? 'recovery-retired-payload-retained' : 'recovery-retired' })
  return { version: 1 as const, state: pending ? 'pending' as const : 'complete' as const }
}
export function removeRecovery(principal: CustomerPrincipal, operationId: string, context: ServiceContext) {
  return retireRecovery(principal.accountId, operationId, context, principal)
}
export async function cleanupExpiredRecoveries(context: ServiceContext): Promise<number> {
  const rows = await context.env.DB!.prepare("SELECT account_id,operation_id FROM account_recoveries WHERE state='completed' AND expires_at<=? ORDER BY expires_at,operation_id LIMIT 1").bind(context.now()).all<{ account_id: string; operation_id: string }>()
  let retired = 0
  for (const row of rows.results) if ((await retireRecovery(row.account_id, row.operation_id, context)).state !== 'blocked') retired++
  return retired
}

export async function cancelRecoveryPreparation(principal: CustomerPrincipal, operationId: string, context: ServiceContext): Promise<{ version: 1; state: 'complete' | 'blocked' }> {
  const db = context.env.DB!, accountId = principal.accountId
  const cancelled = await db.prepare('SELECT 1 FROM cancelled_recoveries WHERE account_id=? AND operation_id=?').bind(accountId, operationId).first()
  await syncBatch(principal, '1', [], [], context, 'FORBIDDEN', true, false)
  if (cancelled) return { version: 1 as const, state: 'complete' as const }
  const row = await db.prepare('SELECT * FROM account_recoveries WHERE account_id=? AND operation_id=?').bind(accountId, operationId).first<RecoveryRow>()
  if (!row) {
    if ((await recoveryOperationStatus(principal, operationId, context)).status === 'retired') return { version: 1 as const, state: 'complete' as const }
    // Never-admitted work needs only a charged terminal marker, not a free recovery slot or
    // capacity for its archive. This domain-separated digest identifies cancellation intent;
    // no reserve descriptor exists, and all later reserves reject marker existence atomically
    const requestDigest = await digest(encoder.encode(JSON.stringify(['recovery-cancellation', 1, operationId])))
    try {
      await syncBatch(principal, `NOT EXISTS(SELECT 1 FROM account_recoveries WHERE account_id=? AND operation_id=?)
        AND NOT EXISTS(SELECT 1 FROM cancelled_recoveries WHERE account_id=? AND operation_id=?)
        AND NOT EXISTS(SELECT 1 FROM superseded_recoveries WHERE account_id=? AND operation_id=?)
        AND NOT EXISTS(SELECT 1 FROM upload_reservations WHERE account_id=? AND recovery_operation_id=?)`,
      [accountId, operationId, accountId, operationId, accountId, operationId, accountId, operationId], [
        db.prepare('INSERT INTO cancelled_recoveries(account_id,operation_id,request_digest,created_at) VALUES(?,?,?,?)').bind(accountId, operationId, requestDigest, context.now()),
      ], context, 'HEAD_CONFLICT')
    } catch (error) {
      // A reserve/cancel winner is re-read through the same sealed/bound and session guards
      if (error instanceof ApiFailure && error.code === 'HEAD_CONFLICT') return cancelRecoveryPreparation(principal, operationId, context)
      throw error
    }
    context.emit({ operation: 'sync', stage: 'recovery-preparation-cancelled' })
    return { version: 1 as const, state: 'complete' as const }
  }
  if (row.sealed || row.mutation_id || row.state !== 'pending') return { version: 1 as const, state: 'blocked' as const }
  // Cancellation and sealing compete for the same unsealed identity in one guarded transaction
  // Terminal metadata prevents a late preparation retry from consuming a newly freed slot
  try {
    await syncBatch(principal, "EXISTS(SELECT 1 FROM account_recoveries WHERE account_id=? AND operation_id=? AND sealed=0 AND state='pending' AND mutation_id IS NULL AND accepted_at IS NULL)", [accountId, operationId], [
      db.prepare('INSERT INTO cancelled_recoveries(account_id,operation_id,request_digest,created_at) VALUES(?,?,?,?)').bind(accountId, operationId, row.request_digest, context.now()),
      db.prepare('UPDATE storage_generations SET expires_at=MIN(expires_at,?) WHERE account_id=? AND upload_id IN (SELECT upload_id FROM recovery_revisions WHERE account_id=? AND operation_id=?)').bind(context.now(), accountId, accountId, operationId),
      db.prepare('DELETE FROM recovery_revisions WHERE account_id=? AND operation_id=?').bind(accountId, operationId),
      db.prepare('DELETE FROM account_recoveries WHERE account_id=? AND operation_id=?').bind(accountId, operationId),
    ], context, 'INTEGRITY_FAILED', true, false)
  } catch (error) {
    if (error instanceof ApiFailure && error.code === 'INTEGRITY_FAILED') return { version: 1 as const, state: 'blocked' as const }
    throw error
  }
  context.emit({ operation: 'sync', stage: 'recovery-preparation-cancelled' })
  return { version: 1 as const, state: 'complete' as const }
}

export async function supersedeRecoveryPublication(principal: CustomerPrincipal, input: RecoverySupersession, context: ServiceContext) {
  input = RecoverySupersessionSchema.parse(input)
  const db = context.env.DB!, accountId = principal.accountId
  const requestDigest = await digest(encoder.encode(JSON.stringify(input)))
  const receipt = { version: 1 as const, operationId: input.operationId, successorOperationId: input.successorOperationId, successorMutationId: input.successorMutationId }
  const prior = () => db.prepare('SELECT request_digest FROM superseded_recoveries WHERE account_id=? AND operation_id=?').bind(accountId, input.operationId).first<{ request_digest: string }>()
  const existing = await prior()
  await syncBatch(principal, '1', [], [], context, 'FORBIDDEN', true, false)
  if (existing) {
    if (existing.request_digest !== requestDigest) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
    return receipt
  }
  // The server proves publication impossibility and sealed successor ownership, not encrypted content
  // The client must verify that the successor contains the original sources plus newly displaced data
  // A concurrent bind must lose to the same atomic null predicate that retires unbound ownership
  const predecessorGuard = input.version === 1
    ? `old.mutation_id=?
        AND json_extract(successor.binding_json,'$.expectedPublicationEpoch')>json_extract(old.binding_json,'$.expectedPublicationEpoch')
        AND COALESCE((SELECT publication_epoch FROM account_sequences WHERE account_id=old.account_id),0)>json_extract(old.binding_json,'$.expectedPublicationEpoch')
        AND NOT EXISTS(SELECT 1 FROM mutation_receipts m WHERE m.account_id=old.account_id AND m.mutation_id=old.mutation_id)`
    : 'old.mutation_id IS NULL AND old.binding_json IS NULL'
  try {
    await syncBatch(principal, `EXISTS(SELECT 1 FROM account_recoveries old JOIN account_recoveries successor ON successor.account_id=old.account_id
      WHERE old.account_id=? AND old.operation_id=? AND old.state='pending' AND old.sealed=1 AND old.accepted_at IS NULL
        AND successor.operation_id=? AND successor.sealed=1 AND successor.mutation_id=? AND successor.binding_json IS NOT NULL
        AND (successor.accepted_at IS NULL OR successor.accepted_at+?>?)
        AND ${predecessorGuard})
      AND NOT EXISTS(SELECT 1 FROM superseded_recoveries WHERE account_id=? AND operation_id=?)`,
    [accountId, input.operationId, input.successorOperationId, input.successorMutationId, RECOVERY_RETENTION_MS, context.now(), ...(input.version === 1 ? [input.mutationId] : []), accountId, input.operationId], [
      db.prepare('INSERT INTO superseded_recoveries(account_id,operation_id,request_digest,successor_operation_id,successor_mutation_id,created_at) VALUES(?,?,?,?,?,?)').bind(accountId, input.operationId, requestDigest, input.successorOperationId, input.successorMutationId, context.now()),
      db.prepare('UPDATE storage_generations SET expires_at=MIN(expires_at,?) WHERE id IN (SELECT generation FROM recovery_revisions WHERE account_id=? AND operation_id=?)').bind(context.now(), accountId, input.operationId),
      db.prepare('DELETE FROM recovery_revisions WHERE account_id=? AND operation_id=?').bind(accountId, input.operationId),
      db.prepare('DELETE FROM account_recoveries WHERE account_id=? AND operation_id=?').bind(accountId, input.operationId),
    ], context, 'HEAD_CONFLICT', true, false)
  } catch (error) {
    const won = await prior()
    if (won?.request_digest === requestDigest) {
      await syncBatch(principal, '1', [], [], context, 'FORBIDDEN', true, false)
      return receipt
    }
    if (won) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
    throw error
  }
  context.checkpoint('sync.recovery.superseded')
  context.emit({ operation: 'sync', stage: 'recovery-publication-superseded' })
  return receipt
}
