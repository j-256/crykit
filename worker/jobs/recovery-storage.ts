import type { D1PreparedStatement } from '@cloudflare/workers-types/experimental'
import { randomId } from '../auth/identity'
import type { ServiceContext } from '../context'
import { runGuardedBatch, type SqlGuard } from '../db/guarded-batch'
import { ApiFailure } from '../http'
import { controlBody, controlBodyBytes, decode, digest } from '../sync/storage'

// Covers the bounded opaque object row and permanent ownership/marker bookkeeping
export const recoveryObjectControlBytes = 2048
export interface RecoveryObject {
  id: string
  identity: string
  account_id: string | null
  object_key: string
  bucket: 'backup' | 'live'
  size: number
  digest: string
  seed: string
  marker: string
  seed_etag: string | null
  state: string
  released: number
}
export const activeRecoveryService = "(SELECT state FROM recovery_control WHERE id=1) IN ('open','restoring')"
// Live backup growth obeys owner settings; closed staged restore retains its separate deployment ceiling
export const recoveryCapacitySql =
  "MIN(?,COALESCE((SELECT project_capacity_bytes FROM service_settings WHERE id='service' AND (SELECT state FROM recovery_control WHERE id=1)='open'),?))"
export function recoveryCapacityStatements(context: ServiceContext, checkId: string): D1PreparedStatement[] {
  const db = context.env.DB!,
    deployment = Number(context.env.STORAGE_CAP_BYTES)
  return [
    db
      .prepare(
        `INSERT INTO transaction_guards(id,passed) SELECT ?,CASE WHEN payload_bytes+reserved_metadata+metadata_bytes<=${recoveryCapacitySql} THEN 1 ELSE 0 END FROM quota_counters WHERE scope='global'`,
      )
      .bind(checkId, deployment, deployment),
    db.prepare('DELETE FROM transaction_guards WHERE id=?').bind(checkId),
  ]
}
export async function allocateRecoveryObject(
  identity: string,
  bytes: number,
  hash: string,
  accountId: string | null,
  bucket: 'backup' | 'live',
  guard: SqlGuard,
  context: ServiceContext,
  attach: (id: string) => D1PreparedStatement[] = () => [],
): Promise<RecoveryObject> {
  if (identity.length > 256 || bytes < 0 || !Number.isSafeInteger(bytes) || hash.length !== 43)
    throw new ApiFailure('INTEGRITY_FAILED')
  const db = context.env.DB!,
    id = randomId()
  await runGuardedBatch(db, guard, [
    db
      .prepare(
        "INSERT INTO service_backup_objects(id,identity,account_id,object_key,bucket,size,digest,seed,marker,state) VALUES (?,?,?,?,?,?,?,?,?,'allocated')",
      )
      .bind(
        id,
        identity,
        accountId,
        `${bucket === 'live' ? 'sync' : 'recovery'}/${id}`,
        bucket,
        bytes,
        hash,
        controlBody(0),
        controlBody(1),
      ),
    db
      .prepare(
        "UPDATE quota_counters SET payload_bytes=payload_bytes+?,metadata_bytes=metadata_bytes+? WHERE scope='global'",
      )
      .bind(bytes + controlBodyBytes * 2, recoveryObjectControlBytes),
    ...attach(id),
    // Check final liabilities after attachment writes as part of the same rollback boundary
    ...recoveryCapacityStatements(context, id),
  ])
  return (await recoveryObject(id, context))!
}
export async function recoveryObject(id: string, context: ServiceContext) {
  return context.env.DB!.prepare('SELECT * FROM service_backup_objects WHERE id=?').bind(id).first<RecoveryObject>()
}
function bucketFor(row: RecoveryObject, context: ServiceContext) {
  const bucket = row.bucket === 'backup' ? context.env.LEDGER_BACKUPS : context.env.OBJECTS
  if (!bucket) throw new ApiFailure('INTEGRITY_FAILED')
  return bucket
}
export async function readRecoveryObject(
  row: Pick<RecoveryObject, 'bucket' | 'object_key' | 'size' | 'digest'>,
  context: ServiceContext,
): Promise<Uint8Array> {
  const bucket = row.bucket === 'backup' ? context.env.LEDGER_BACKUPS : context.env.OBJECTS
  const object = await bucket?.get(row.object_key)
  if (!object || object.size !== row.size) throw new ApiFailure('INTEGRITY_FAILED')
  const bytes = new Uint8Array(await object.arrayBuffer())
  if (bytes.length !== row.size || (await digest(bytes)) !== row.digest) throw new ApiFailure('INTEGRITY_FAILED')
  return bytes
}
export async function writeRecoveryObject(
  id: string,
  bytes: Uint8Array,
  owner: SqlGuard,
  context: ServiceContext,
): Promise<void> {
  const db = context.env.DB!
  let row = await recoveryObject(id, context)
  if (!row || row.size !== bytes.length || row.digest !== (await digest(bytes)))
    throw new ApiFailure('INTEGRITY_FAILED')
  const bucket = bucketFor(row, context)
  const transition = async (from: string, to: string, etag: string | null = row!.seed_etag) => {
    await runGuardedBatch(
      db,
      {
        sql: `SELECT (${owner.sql}) AND ${activeRecoveryService} AND EXISTS(SELECT 1 FROM service_backup_objects WHERE id=? AND state=?)`,
        bindings: [...owner.bindings, id, from],
      },
      [db.prepare('UPDATE service_backup_objects SET state=?,seed_etag=? WHERE id=?').bind(to, etag, id)],
    )
    row = await recoveryObject(id, context)
  }
  if (row.state === 'allocated') {
    await transition('allocated', 'initializing')
    context.checkpoint('backup.seed.claimed')
    // Only the winner of the durable transition owns this one initializer attempt
    await bucket.put(row!.object_key, decode(row!.seed), { onlyIf: { etagDoesNotMatch: '*' } })
    context.checkpoint('backup.seed.written')
  }
  if (row!.state === 'initializing') {
    const seed = await bucket.get(row!.object_key)
    if (
      !seed ||
      seed.size !== controlBodyBytes ||
      (await digest(new Uint8Array(await seed.arrayBuffer()))) !== (await digest(decode(row!.seed)))
    )
      throw new ApiFailure('SERVICE_UNAVAILABLE')
    await transition('initializing', 'seeded', seed.etag)
  }
  if (row!.state === 'seeded' || row!.state === 'writing') {
    await transition(row!.state, 'writing')
    context.checkpoint('backup.body.authorized')
    await bucket.put(row!.object_key, bytes, { onlyIf: { etagMatches: row!.seed_etag! } })
    context.checkpoint('backup.body.written')
  } else if (row!.state !== 'ready') throw new ApiFailure('INTEGRITY_FAILED')
  await readRecoveryObject(row!, context)
  await transition(row!.state, 'ready')
}
export async function fenceRecoveryObject(id: string, context: ServiceContext): Promise<boolean> {
  const db = context.env.DB!,
    row = await recoveryObject(id, context)
  if (!row || row.state === 'unsafe') return false
  if (row.state === 'closed') return true
  if (row.state !== 'closing') throw new ApiFailure('INTEGRITY_FAILED')
  const bucket = bucketFor(row, context)
  context.checkpoint('backup.marker.before')
  await bucket.put(row.object_key, decode(row.marker))
  const object = await bucket.get(row.object_key)
  if (
    !object ||
    object.size !== controlBodyBytes ||
    (await digest(new Uint8Array(await object.arrayBuffer()))) !== (await digest(decode(row.marker))) ||
    object.etag === row.seed_etag
  ) {
    await db.prepare("UPDATE service_backup_objects SET state='unsafe' WHERE id=?").bind(id).run()
    return false
  }
  context.checkpoint('backup.marker.verified')
  await runGuardedBatch(db, { sql: "SELECT state='closing' FROM service_backup_objects WHERE id=?", bindings: [id] }, [
    db
      .prepare(
        "UPDATE quota_counters SET payload_bytes=payload_bytes-? WHERE scope='global' AND EXISTS(SELECT 1 FROM service_backup_objects WHERE id=? AND released=0)",
      )
      .bind(row.size + controlBodyBytes, id),
    db.prepare("UPDATE service_backup_objects SET state='closed',released=1,account_id=NULL WHERE id=?").bind(id),
  ])
  return true
}
