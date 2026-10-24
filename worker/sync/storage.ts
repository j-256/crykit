import type { D1PreparedStatement } from '@cloudflare/workers-types/experimental'
import type { ApiErrorCode } from '../../src/account/protocol'
import { encode, randomId } from '../auth/identity'
import { liveSessionSql, type CustomerPrincipal } from '../auth/session'
import type { ServiceContext } from '../context'
import { runGuardedBatch } from '../db/guarded-batch'
import { ApiFailure } from '../http'

export const controlBodyBytes = 32
export const controlReservationBytes = controlBodyBytes * 2
export const cleanupPageSize = 32
export const cleanupGenerationsPerCall = 1
export const encoder = new TextEncoder()
export function encodedBytes(value: unknown): number { return encoder.encode(JSON.stringify(value)).length }
export async function digest(bytes: Uint8Array): Promise<string> { return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) }
export function decode(value: string): Uint8Array { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)) }
export function controlBody(kind: 0 | 1): string { const bytes = crypto.getRandomValues(new Uint8Array(controlBodyBytes)); bytes[0] = 1; bytes[1] = kind; return encode(bytes) }
export function authority(principal: CustomerPrincipal, context: ServiceContext, write = true, operation: 'upload' | 'publish' = 'upload') {
  return { sql: `${liveSessionSql}${write ? " AND a.access = 'active' AND a.verified_at IS NOT NULL AND EXISTS (SELECT 1 FROM service_settings WHERE id='service' AND " + (operation === 'publish' ? 'sharing_paused' : 'uploads_paused') + "=0)" : ''}`, bindings: [principal.sessionId, principal.accountId, context.now(), context.now()] }
}
export async function syncBatch(principal: CustomerPrincipal, condition: string, bindings: (string | number | null)[], statements: D1PreparedStatement[], context: ServiceContext, denied: ApiErrorCode = 'INTEGRITY_FAILED', write = true, capacity = true, operation: 'upload' | 'publish' = 'upload') {
  const startedAt = performance.now()
  const db = context.env.DB!, live = authority(principal, context, write, operation), checkId = randomId()
  const all = [...statements]
  if (capacity) {
    // Check final logical liabilities in the same transaction, including trigger-maintained metadata
    all.push(db.prepare(`INSERT INTO transaction_guards(id,passed) VALUES (?, CASE WHEN NOT EXISTS (SELECT 1 FROM quota_counters q WHERE (q.scope = ? AND q.payload_bytes + q.reserved_metadata + q.metadata_bytes > (SELECT capacity_bytes FROM accounts WHERE id = ?)) OR (q.scope = 'global' AND q.payload_bytes + q.reserved_metadata + q.metadata_bytes > MIN(?,COALESCE((SELECT project_capacity_bytes FROM service_settings WHERE id='service'),?)))) THEN 1 ELSE 0 END)`).bind(checkId, principal.accountId, principal.accountId, Number(context.env.STORAGE_CAP_BYTES), Number(context.env.STORAGE_CAP_BYTES)), db.prepare('DELETE FROM transaction_guards WHERE id = ?').bind(checkId))
  }
  try {
    const results = await runGuardedBatch(db, { sql: `SELECT EXISTS (${live.sql}) AND (${condition})`, bindings: [...live.bindings, ...bindings] }, all)
    context.emit({operation:'sync',stage:'transaction',durationMs:Math.max(0,performance.now()-startedAt),rowsRead:results.reduce((sum,row)=>sum+row.meta.rows_read,0),rowsWritten:results.reduce((sum,row)=>sum+row.meta.rows_written,0)})
    return results
  } catch (error) {
    if (String(error).includes('transaction_guard_passed')) {
      if (!await db.prepare(live.sql).bind(...live.bindings).first()) throw new ApiFailure(write ? 'FORBIDDEN' : 'AUTH_REQUIRED')
      if (!await db.prepare(`SELECT (${condition}) AS ok`).bind(...bindings).first('ok')) throw new ApiFailure(denied)
      throw new ApiFailure('QUOTA_EXCEEDED')
    }
    context.emit({ operation: 'sync', stage: 'database', code: 'SERVICE_UNAVAILABLE' })
    throw new ApiFailure('SERVICE_UNAVAILABLE')
  }
}
export interface FencedChunk { account_id: string | null; generation: string; chunk_index: number; object_key: string; cipher_bytes: number; cipher_digest: string; seed: string; marker: string; seed_etag: string | null; state: string; released: number }
export async function chunkRow(generation: string, index: number, context: ServiceContext): Promise<FencedChunk> {
  const row = await context.env.DB!.prepare('SELECT * FROM upload_chunks WHERE generation = ? AND chunk_index = ?').bind(generation, index).first<FencedChunk>()
  if (!row) throw new ApiFailure('NOT_FOUND')
  return row
}
const writableGeneration = `EXISTS (SELECT 1 FROM storage_generations g JOIN upload_reservations u ON u.generation = g.id AND u.account_id = g.account_id WHERE g.id = ? AND g.account_id = ? AND g.state IN ('staging','ready') AND (g.expires_at > ? OR g.state = 'ready'))`
export async function writeFencedChunk(principal: CustomerPrincipal, generation: string, index: number, bytes: Uint8Array, context: ServiceContext): Promise<void> {
  const db = context.env.DB!, objects = context.env.OBJECTS!
  let row = await chunkRow(generation, index, context)
  if (row.account_id !== principal.accountId) throw new ApiFailure('NOT_FOUND')
  if (bytes.length !== row.cipher_bytes || await digest(bytes) !== row.cipher_digest) throw new ApiFailure('IDEMPOTENCY_MISMATCH')
  const guard = `${writableGeneration} AND EXISTS (SELECT 1 FROM upload_chunks WHERE generation = ? AND chunk_index = ? AND state = ?)`
  const bindings = (state: string) => [generation, principal.accountId, context.now(), generation, index, state]
  if (row.state === 'allocated') {
    await syncBatch(principal, guard, bindings('allocated'), [db.prepare("UPDATE upload_chunks SET state = 'initializing' WHERE generation = ? AND chunk_index = ?").bind(generation, index)], context)
    context.checkpoint('sync.seed.claimed')
    // This right is one-shot even after an uncertain external response
    await objects.put(row.object_key, decode(row.seed), { onlyIf: { etagDoesNotMatch: '*' } })
    context.checkpoint('sync.seed.written')
    row = await chunkRow(generation, index, context)
  }
  if (row.state === 'initializing') {
    const object = await objects.get(row.object_key)
    if (!object || await digest(new Uint8Array(await object.arrayBuffer())) !== await digest(decode(row.seed))) throw new ApiFailure('SERVICE_UNAVAILABLE', 1)
    await syncBatch(principal, guard, bindings('initializing'), [db.prepare("UPDATE upload_chunks SET state = 'seeded', seed_etag = ? WHERE generation = ? AND chunk_index = ?").bind(object.etag, generation, index)], context)
    row = await chunkRow(generation, index, context)
  }
  if (row.state === 'seeded' || row.state === 'writing') {
    await syncBatch(principal, guard, bindings(row.state), [db.prepare("UPDATE upload_chunks SET state = 'writing' WHERE generation = ? AND chunk_index = ?").bind(generation, index)], context)
    context.checkpoint('sync.body.authorized')
    // Never adopt an observed payload/marker ETag as a new write predicate
    await objects.put(row.object_key, bytes, { onlyIf: { etagMatches: row.seed_etag! } })
    context.checkpoint('sync.body.written')
  } else if (row.state !== 'ready') throw new ApiFailure('INTEGRITY_FAILED')
  const object = await objects.get(row.object_key)
  if (!object || object.size !== row.cipher_bytes || await digest(new Uint8Array(await object.arrayBuffer())) !== row.cipher_digest) throw new ApiFailure('INTEGRITY_FAILED')
  await syncBatch(principal, `${writableGeneration} AND EXISTS (SELECT 1 FROM upload_chunks WHERE generation = ? AND chunk_index = ? AND state IN ('writing','ready'))`, [generation, principal.accountId, context.now(), generation, index], [db.prepare("UPDATE upload_chunks SET state = 'ready' WHERE generation = ? AND chunk_index = ?").bind(generation, index)], context)
  context.checkpoint('sync.chunk.ready')
}

// Later deletion/snapshot owners compose their own service authority with these predicates
// Accepted journal pins stay effective without a deadline until explicit safe retention removal
export const generationUnpinnedSql = `NOT EXISTS (SELECT 1 FROM service_snapshot_pins sp JOIN service_snapshots ss ON ss.id=sp.snapshot_id WHERE sp.generation=g.id AND ss.state NOT IN ('expired','paused')) AND NOT EXISTS (SELECT 1 FROM publication_pins p JOIN publication_work w ON w.account_id = p.account_id AND w.mutation_id = p.mutation_id WHERE p.generation = g.id AND (w.state IN ('complete','validating') OR (w.state = 'accepted' AND p.retained = 1))) AND NOT EXISTS (SELECT 1 FROM publication_work w WHERE w.account_id = g.account_id AND w.state IN ('validating','complete')) AND NOT EXISTS (SELECT 1 FROM scan_leases l WHERE l.account_id = g.account_id AND l.expires_at > ?)`
export async function claimGenerationCleanup(accountId: string, generation: string, context: ServiceContext): Promise<boolean> {
  const db = context.env.DB!
  try {
    await runGuardedBatch(db, { sql: `SELECT 1 FROM storage_generations g WHERE g.id = ? AND g.account_id = ? AND g.state IN ('staging','ready') AND g.expires_at <= ? AND ${generationUnpinnedSql}`, bindings: [generation, accountId, context.now(), context.now()] }, [db.prepare("UPDATE storage_generations SET state = 'closing' WHERE id = ?").bind(generation), db.prepare("UPDATE upload_chunks SET state = 'closing' WHERE generation = ?").bind(generation)])
    return true
  } catch (error) { if (String(error).includes('transaction_guard_passed')) return false; throw error }
}
export async function fenceGeneration(generation: string, context: ServiceContext): Promise<boolean> {
  const db = context.env.DB!, objects = context.env.OBJECTS!
  if (await db.prepare("SELECT 1 FROM storage_generations WHERE id = ? AND state = 'unsafe'").bind(generation).first()) return false
  const rows = await db.prepare("SELECT * FROM upload_chunks WHERE generation = ? AND state = 'closing' ORDER BY chunk_index LIMIT ?").bind(generation, cleanupPageSize).all<FencedChunk>()
  for (const row of rows.results) {
    context.checkpoint('sync.marker.before')
    await objects.put(row.object_key, decode(row.marker))
    context.checkpoint('sync.marker.written')
    const object = await objects.get(row.object_key)
    const verified = object && object.size === controlBodyBytes && await digest(new Uint8Array(await object.arrayBuffer())) === await digest(decode(row.marker)) && (row.seed_etag === null || object.etag !== row.seed_etag)
    if (!verified) {
      await db.batch([db.prepare("UPDATE upload_chunks SET state = 'unsafe' WHERE generation = ? AND chunk_index = ?").bind(generation, row.chunk_index), db.prepare("UPDATE storage_generations SET state = 'unsafe' WHERE id = ?").bind(generation)])
      context.emit({ operation: 'sync', stage: 'unsafe-fence', code: 'INTEGRITY_FAILED', jobId: generation })
      return false
    }
    context.checkpoint('sync.marker.verified')
    // Release only displaced payload plus seed; permanent marker and opaque metadata remain charged
    await runGuardedBatch(db, { sql: "SELECT state IN ('closing','closed') AND NOT EXISTS (SELECT 1 FROM storage_generations WHERE id = ? AND state = 'unsafe') FROM upload_chunks WHERE generation = ? AND chunk_index = ?", bindings: [generation, generation, row.chunk_index] }, [
      db.prepare("UPDATE quota_counters SET payload_bytes = payload_bytes - ? WHERE (scope = 'global' OR scope = ?) AND EXISTS (SELECT 1 FROM upload_chunks WHERE generation = ? AND chunk_index = ? AND released = 0)").bind(row.cipher_bytes + controlBodyBytes, row.account_id, generation, row.chunk_index),
      db.prepare("UPDATE upload_chunks SET state = 'closed', released = 1 WHERE generation = ? AND chunk_index = ?").bind(generation, row.chunk_index),
    ])
    context.checkpoint('sync.marker.accounted')
  }
  const pending = await db.prepare("SELECT 1 FROM upload_chunks WHERE generation = ? AND state <> 'closed' LIMIT 1").bind(generation).first()
  if (!pending) await db.prepare("UPDATE storage_generations SET state = 'closed' WHERE id = ? AND state IN ('closing','closed')").bind(generation).run()
  return !pending
}
export async function cleanupExpiredUploads(context: ServiceContext): Promise<number> {
  const rows = await context.env.DB!.prepare(`SELECT g.id,g.account_id,g.state FROM storage_generations g WHERE g.state = 'closing' OR (g.state IN ('staging','ready') AND g.expires_at <= ? AND ${generationUnpinnedSql}) ORDER BY g.expires_at,g.id LIMIT ?`).bind(context.now(), context.now(), cleanupGenerationsPerCall).all<{ id: string; account_id: string; state: string }>()
  let complete = 0
  for (const row of rows.results) if (row.state === 'closing' || await claimGenerationCleanup(row.account_id, row.id, context)) if (await fenceGeneration(row.id, context)) complete++
  return complete
}

export function generationCleanupStatements(generation: string, context: ServiceContext): D1PreparedStatement[] {
  return [context.env.DB!.prepare("UPDATE storage_generations SET state = 'closing' WHERE id = ?").bind(generation), context.env.DB!.prepare("UPDATE upload_chunks SET state = 'closing' WHERE generation = ? AND state <> 'closed'").bind(generation)]
}
export function prepareClosedLiabilityTransfer(accountId: string, context: ServiceContext) {
  const db=context.env.DB!
  // The deletion owner must compose independent ledger acknowledgment into this same guard
  // Null ownership preserves globally counted fences after customer authority rows are removed
  return {
    guard: {sql:"SELECT EXISTS (SELECT 1 FROM accounts WHERE id = ? AND access = 'deleting') AND NOT EXISTS (SELECT 1 FROM upload_chunks WHERE account_id = ? AND (state <> 'closed' OR released <> 1)) AND NOT EXISTS (SELECT 1 FROM storage_generations WHERE account_id = ? AND state <> 'closed')",bindings:[accountId,accountId,accountId]},
    statements:[
      db.prepare('UPDATE quota_counters SET payload_bytes = payload_bytes - (SELECT COUNT(*) * ? FROM upload_chunks WHERE account_id = ?) WHERE scope = ?').bind(controlBodyBytes,accountId,accountId),
      db.prepare("UPDATE upload_chunks SET account_id = NULL,cipher_bytes = 0,cipher_digest = '',seed = '' WHERE account_id = ? AND state = 'closed'").bind(accountId),
    ],
  }
}
