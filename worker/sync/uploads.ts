import { uploadReservationMs, UploadStartSchema, type UploadReady, type UploadStart } from '../../src/account/protocol'
import { randomId } from '../auth/identity'
import { assertCustomerWrite, type CustomerPrincipal } from '../auth/session'
import type { ServiceContext } from '../context'
import { ApiFailure } from '../http'
import { controlBody, controlReservationBytes, digest, encoder, syncBatch, writeFencedChunk } from './storage'

export interface Reservation { account_id: string; upload_id: string; document_id: string; revision_id: string; request_digest: string; request_json: string; generation: string; descriptor_reserve: number; recovery_operation_id: string | null }
export async function reservation(principal: CustomerPrincipal, uploadId: string, context: ServiceContext): Promise<Reservation> {
  const row = await context.env.DB!.prepare('SELECT * FROM upload_reservations WHERE account_id = ? AND upload_id = ?').bind(principal.accountId, uploadId).first<Reservation>()
  if (!row) throw new ApiFailure('NOT_FOUND')
  return row
}
export async function startUpload(principal: CustomerPrincipal, input: UploadStart, context: ServiceContext): Promise<UploadReady> {
  input = UploadStartSchema.parse(input)
  await assertCustomerWrite(principal, 'upload', context)
  const db = context.env.DB!, requestJson = JSON.stringify(input), requestDigest = await digest(encoder.encode(requestJson))
  const prior = await db.prepare('SELECT * FROM upload_reservations WHERE account_id = ? AND (upload_id = ? OR revision_id = ?)').bind(principal.accountId, input.uploadId, input.revisionId).first<Reservation>()
  if (prior && (prior.upload_id !== input.uploadId || prior.request_digest !== requestDigest)) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
  if (prior) {
    const current = await db.prepare('SELECT state,expires_at FROM storage_generations WHERE id = ?').bind(prior.generation).first<{ state: string; expires_at: number }>()
    if (current && (current.state === 'ready' || (current.state === 'staging' && current.expires_at > context.now()))) return { version: 1, uploadId: input.uploadId, expiresAt: current.expires_at }
    if (current?.state !== 'closed') throw new ApiFailure('SERVICE_UNAVAILABLE', 1)
  }
  const recovery = await db.prepare('SELECT r.operation_id,r.descriptor,p.sealed,p.state FROM recovery_revisions r JOIN account_recoveries p ON p.account_id=r.account_id AND p.operation_id=r.operation_id WHERE r.account_id=? AND (r.upload_id=? OR r.revision_id=?)').bind(principal.accountId,input.uploadId,input.revisionId).first<{operation_id:string;descriptor:string;sealed:number;state:string}>()
  if (prior?.recovery_operation_id && !recovery) throw new ApiFailure('NOT_FOUND')
  if (recovery) {
    const descriptor = JSON.parse(recovery.descriptor)
    if (descriptor.uploadId !== input.uploadId || descriptor.revisionId !== input.revisionId || descriptor.documentId !== input.documentId || JSON.stringify(descriptor.chunks) !== JSON.stringify(input.chunks)) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
    if (recovery.sealed || recovery.state !== 'pending') throw new ApiFailure('INTEGRITY_FAILED')
  }
  const generation = randomId(), expiresAt = context.now() + uploadReservationMs
  const statements = [db.prepare('INSERT OR IGNORE INTO quota_counters(scope) VALUES (?)').bind(principal.accountId), db.prepare('INSERT OR IGNORE INTO account_sequences(account_id) VALUES (?)').bind(principal.accountId)]
  if (!prior) statements.push(db.prepare('INSERT INTO upload_reservations(account_id,upload_id,document_id,revision_id,request_digest,request_json,generation,descriptor_reserve,recovery_operation_id) VALUES (?,?,?,?,?,?,?,?,?)').bind(principal.accountId, input.uploadId, input.documentId, input.revisionId, requestDigest, requestJson, generation, recovery ? 0 : input.metadataBytes, recovery?.operation_id ?? null))
  else statements.push(db.prepare('UPDATE upload_reservations SET generation = ? WHERE account_id = ? AND upload_id = ?').bind(generation, principal.accountId, input.uploadId))
  statements.push(db.prepare("INSERT INTO storage_generations(account_id,id,upload_id,expires_at,state) VALUES (?,?,?,?,'staging')").bind(principal.accountId, generation, input.uploadId, expiresAt))
  for (const chunk of input.chunks) statements.push(db.prepare("INSERT INTO upload_chunks(account_id,generation,chunk_index,object_key,cipher_bytes,cipher_digest,seed,marker,state) VALUES (?,?,?,?,?,?,?,?,'allocated')").bind(principal.accountId, generation, chunk.index, `sync/${randomId()}`, chunk.cipherBytes, chunk.cipherDigest, controlBody(0), controlBody(1)))
  if (recovery) statements.push(db.prepare('UPDATE recovery_revisions SET staging_reserve=0 WHERE account_id=? AND upload_id=? AND operation_id=?').bind(principal.accountId,input.uploadId,recovery.operation_id))
  const payloadBytes = input.chunks.reduce((sum, chunk) => sum + chunk.cipherBytes + controlReservationBytes, 0)
  statements.push(db.prepare("UPDATE quota_counters SET payload_bytes = payload_bytes + ?, reserved_metadata = reserved_metadata + ? WHERE scope IN ('global',?)").bind(payloadBytes, prior || recovery ? 0 : input.metadataBytes, principal.accountId))
  const recoveryGuard = recovery ? "EXISTS(SELECT 1 FROM recovery_revisions r JOIN account_recoveries p ON p.account_id=r.account_id AND p.operation_id=r.operation_id WHERE r.account_id=? AND r.upload_id=? AND r.operation_id=? AND p.sealed=0 AND p.state='pending')" : 'NOT EXISTS(SELECT 1 FROM recovery_revisions WHERE account_id=? AND (upload_id=? OR revision_id=?))'
  const recoveryBindings = recovery ? [principal.accountId,input.uploadId,recovery.operation_id] : [principal.accountId,input.uploadId,input.revisionId]
  await syncBatch(principal, `(${recoveryGuard}) AND (` + (prior ? "EXISTS (SELECT 1 FROM upload_reservations u JOIN storage_generations g ON g.id = u.generation WHERE u.account_id = ? AND u.upload_id = ? AND g.id = ? AND g.state = 'closed')" : 'NOT EXISTS (SELECT 1 FROM upload_reservations WHERE account_id = ? AND (upload_id = ? OR revision_id = ?))') + ')', [...recoveryBindings, ...(prior ? [principal.accountId, input.uploadId, prior.generation] : [principal.accountId, input.uploadId, input.revisionId])], statements, context, 'IDEMPOTENCY_MISMATCH')
  context.checkpoint('sync.reservation.created')
  return { version: 1, uploadId: input.uploadId, expiresAt }
}
export async function putUploadChunk(principal: CustomerPrincipal, uploadId: string, index: number, request: Request, context: ServiceContext): Promise<void> {
  await assertCustomerWrite(principal, 'upload', context)
  const row = await reservation(principal, uploadId, context), input = JSON.parse(row.request_json) as UploadStart
  const chunk = input.chunks[index]
  if (!chunk) throw new ApiFailure('NOT_FOUND')
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/octet-stream' || !request.body) throw new ApiFailure('INVALID_REQUEST')
  const reader = request.body.getReader(), bytes = new Uint8Array(chunk.cipherBytes)
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (size + next.value.length > bytes.length) { await reader.cancel().catch(() => {}); throw new ApiFailure('IDEMPOTENCY_MISMATCH') }
      bytes.set(next.value, size); size += next.value.length
    }
  } finally { reader.releaseLock() }
  if (size !== bytes.length) throw new ApiFailure('INTEGRITY_FAILED')
  await writeFencedChunk(principal, row.generation, index, bytes, context)
}
export async function finishUpload(principal: CustomerPrincipal, uploadId: string, context: ServiceContext): Promise<UploadReady> {
  await assertCustomerWrite(principal, 'upload', context)
  const db = context.env.DB!, row = await reservation(principal, uploadId, context)
  const input = JSON.parse(row.request_json) as UploadStart
  const generation = await db.prepare('SELECT expires_at FROM storage_generations WHERE id = ?').bind(row.generation).first<{ expires_at: number }>()
  await syncBatch(principal, `EXISTS (SELECT 1 FROM upload_reservations u JOIN storage_generations g ON g.id = u.generation WHERE u.account_id = ? AND u.upload_id = ? AND g.id = ? AND g.state IN ('staging','ready') AND (g.expires_at > ? OR g.state = 'ready')) AND (SELECT COUNT(*) FROM upload_chunks WHERE generation = ? AND state = 'ready') = ?`, [principal.accountId, uploadId, row.generation, context.now(), row.generation, input.chunks.length], [db.prepare("UPDATE storage_generations SET state = 'ready' WHERE id = ?").bind(row.generation)], context)
  context.checkpoint('sync.upload.finished')
  return { version: 1, uploadId, expiresAt: generation!.expires_at }
}
