import { z } from 'zod'
import type { JobReceipt } from '../../src/account/protocol'
import { OpaqueIdSchema } from '../../src/account/protocol'
import type { ServiceContext } from '../context'
import { runGuardedBatch } from '../db/guarded-batch'
import { ApiFailure } from '../http'
import { decode, digest } from '../sync/storage'
import { readRevocationHead } from './ledger'
import { recoveryTables, recoveryProjection } from './recovery-projection'
import {
  allocateRecoveryObject,
  recoveryCapacitySql,
  recoveryCapacityStatements,
  recoveryObject,
  readRecoveryObject,
  writeRecoveryObject,
  activeRecoveryService,
  fenceRecoveryObject,
  type RecoveryObject,
} from './recovery-storage'
import {
  encodeBytes,
  jsonBytes,
  manifestSchema,
  openRecovery,
  recoveryFragmentBytes,
  recoveryPolicySchema,
  objectReferenceSchema,
  cipherObjectReferenceSchema,
  recoveryMaximumRowBytes,
  reference,
  sealRecovery,
  secretIdentity,
  type ObjectReference,
  type RecoveryManifest,
} from './recovery-codec'

interface Snapshot {
  id: string
  source_generation: string
  state: string
  created_at: number
  ledger: string
  secrets: string
  rows: number
  bytes: number
  reserve: number
  cursor: number
  offset: number
  page: number
  manifest: string | null
  code: string | null
}
export interface SnapshotItem {
  kind: 'page' | 'cipher'
  sourceKey: string | null
  accountId?: string
  table?: string
  row?: number
  offset?: number
  total?: number
  object: ObjectReference
  label?: string
}
const snapshotItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('page'),
    sourceKey: z.null(),
    table: z.enum(recoveryTables as [(typeof recoveryTables)[number], ...typeof recoveryTables]),
    row: z.number().int().positive().safe(),
    offset: z.number().int().nonnegative().safe(),
    total: z.number().int().positive().max(recoveryMaximumRowBytes),
    label: z.string().max(96),
    object: objectReferenceSchema,
  }),
  z.strictObject({
    kind: z.literal('cipher'),
    sourceKey: z.string().regex(/^sync\/[A-Za-z0-9_-]{22}$/),
    accountId: OpaqueIdSchema,
    object: cipherObjectReferenceSchema,
  }),
])
const linkSchema = z.strictObject({
  ordinal: z.number().int().nonnegative().safe(),
  item: snapshotItemSchema,
  previous: objectReferenceSchema.nullable(),
})
type Link = z.infer<typeof linkSchema>
interface StoredReference {
  ordinal: number
  source_key: string | null
  object_id: string
  kind: string
  body: string | null
}
const snapshotFixedReservation = 8192
const snapshotRowReservation = 512
const rootPrefix = 'service-snapshots/v1/'
function receipt(snapshotId: string, state: JobReceipt['state'], context: ServiceContext): JobReceipt {
  return { jobId: snapshotId, state, requestId: context.requestId }
}
function owner(snapshot: Snapshot) {
  return {
    sql: `SELECT ${activeRecoveryService} AND EXISTS(SELECT 1 FROM service_snapshots WHERE id=? AND state=? AND cursor=? AND offset=? AND page=?) AND NOT EXISTS(SELECT 1 FROM service_snapshot_pins p JOIN storage_generations g ON g.id=p.generation JOIN accounts a ON a.id=g.account_id WHERE p.snapshot_id=? AND a.access='deleting')`,
    bindings: [snapshot.id, snapshot.state, snapshot.cursor, snapshot.offset, snapshot.page, snapshot.id],
  }
}
async function snapshotRow(id: string, context: ServiceContext) {
  return context.env.DB!.prepare('SELECT * FROM service_snapshots WHERE id=?').bind(id).first<Snapshot>()
}
function capturePolicy(value: string | undefined) {
  let parsed: unknown
  try {
    parsed = value ? JSON.parse(value) : null
  } catch {
    parsed = null
  }
  return recoveryPolicySchema.safeParse(parsed)
}
export async function serviceRecoveryStatus(context: ServiceContext) {
  const row = await context.env
    .DB!.prepare(
      "SELECT id,created_at FROM service_snapshots WHERE state IN ('complete','reverifying') ORDER BY created_at DESC,rowid DESC LIMIT 1",
    )
    .first<{ id: string; created_at: number }>()
  const latest = await context.env
    .DB!.prepare('SELECT state,code FROM service_snapshots ORDER BY created_at DESC,rowid DESC LIMIT 1')
    .first<{ state: string; code: string | null }>()
  const controlCode = await context.env
    .DB!.prepare("SELECT code FROM recovery_control WHERE id=1 AND state='open'")
    .first<string>('code')
  const code =
    latest?.code ??
    controlCode ??
    (!capturePolicy(context.env.SERVICE_BACKUP_POLICY).success
      ? 'MEASURED_POLICY_REQUIRED'
      : latest?.state === 'reverifying'
        ? 'VERIFYING'
        : null)
  return {
    state: code ? 'paused' : row ? 'verified' : 'unverified',
    lastVerifiedAt: row?.created_at ?? null,
    ageMs: row ? Math.max(0, context.now() - row.created_at) : null,
    code,
  }
}
async function capture(context: ServiceContext, id: string): Promise<void> {
  const db = context.env.DB!,
    policy = capturePolicy(context.env.SERVICE_BACKUP_POLICY)
  const paused = async (code: string) => {
    try {
      await runGuardedBatch(
        db,
        {
          sql: `SELECT ${activeRecoveryService} AND NOT EXISTS(SELECT 1 FROM service_snapshots WHERE id=?) AND (SELECT payload_bytes+reserved_metadata+metadata_bytes FROM quota_counters WHERE scope='global')+?<=${recoveryCapacitySql}`,
          bindings: [
            id,
            snapshotFixedReservation,
            Number(context.env.STORAGE_CAP_BYTES),
            Number(context.env.STORAGE_CAP_BYTES),
          ],
        },
        [
          db
            .prepare(
              "INSERT INTO service_snapshots(id,source_generation,state,created_at,ledger,secrets,rows,bytes,reserve,code) SELECT ?,generation,'paused',?,'{}','{}',0,0,?,? FROM recovery_control WHERE id=1",
            )
            .bind(id, context.now(), snapshotFixedReservation, code),
          db
            .prepare("UPDATE quota_counters SET reserved_metadata=reserved_metadata+? WHERE scope='global'")
            .bind(snapshotFixedReservation),
          ...recoveryCapacityStatements(context, id),
        ],
      )
    } catch (error) {
      if (!String(error).includes('transaction_guard_passed')) throw error
      // The precharged singleton can report exhaustion without unbounded failed-job rows
      await db.prepare("UPDATE recovery_control SET code=? WHERE id=1 AND state='open'").bind(code).run()
    }
  }
  if (!policy.success) {
    await paused('MEASURED_POLICY_REQUIRED')
    return
  }
  const limits = policy.data,
    ledger = await readRevocationHead(context),
    secrets = await secretIdentity(context)
  // All source counters and generation eligibility are read inside the same capture transaction
  // A later ordinary commit cannot enlarge or mutate these immutable rows or their exact pins
  const statements = [
    db
      .prepare(
        `INSERT INTO service_snapshots(id,source_generation,state,created_at,ledger,secrets,rows,bytes,reserve) SELECT ?,(SELECT generation FROM recovery_control WHERE id=1),'pages',?,?,?,SUM(rows),SUM(bytes),?+SUM(bytes)*6+SUM(rows)*? FROM recovery_source_stats`,
      )
      .bind(
        id,
        context.now(),
        JSON.stringify(ledger),
        JSON.stringify(secrets),
        snapshotFixedReservation,
        snapshotRowReservation,
      ),
  ]
  for (const table of recoveryTables)
    statements.push(
      db
        .prepare(
          `INSERT INTO service_snapshot_rows(snapshot_id,table_name,source_rowid,body) SELECT ?,?,rowid,json_array(${recoveryProjection[table].join(',')}) FROM ${table}`,
        )
        .bind(id, table),
    )
  statements.push(
    db
      .prepare(
        "INSERT INTO service_snapshot_pins(snapshot_id,generation) SELECT ?,id FROM storage_generations WHERE state='ready'",
      )
      .bind(id),
    db
      .prepare(
        "UPDATE quota_counters SET reserved_metadata=reserved_metadata+(SELECT reserve FROM service_snapshots WHERE id=?) WHERE scope='global'",
      )
      .bind(id),
    ...recoveryCapacityStatements(context, id),
  )
  const guard = {
    sql: `SELECT ${activeRecoveryService} AND NOT EXISTS(SELECT 1 FROM service_snapshots WHERE id=?) AND (SELECT SUM(rows) FROM recovery_source_stats)<=? AND (SELECT SUM(bytes) FROM recovery_source_stats)<=? AND (SELECT MAX(max_row_bytes) FROM recovery_source_stats)<=? AND (SELECT edges FROM quota_counters WHERE scope='global')<=? AND (SELECT SUM(rows) FROM recovery_source_stats)+(SELECT edges FROM quota_counters WHERE scope='global')<=? AND ?+(SELECT SUM(bytes)*6+SUM(rows)*? FROM recovery_source_stats)<=? AND (SELECT payload_bytes+reserved_metadata+metadata_bytes FROM quota_counters WHERE scope='global')+?+(SELECT SUM(bytes)*6+SUM(rows)*? FROM recovery_source_stats)<=${recoveryCapacitySql} AND NOT EXISTS(SELECT 1 FROM storage_generations WHERE state NOT IN ('ready','closed')) AND NOT EXISTS(SELECT 1 FROM upload_chunks c JOIN storage_generations g ON g.id=c.generation WHERE g.state='ready' AND c.state<>'ready') AND NOT EXISTS(SELECT 1 FROM accounts WHERE access='deleting') AND NOT EXISTS(SELECT 1 FROM admin_revocations WHERE acknowledged=0)`,
    bindings: [
      id,
      limits.maxRows,
      limits.maxBytes,
      limits.maxRowBytes,
      limits.maxEdges,
      limits.maxWork,
      snapshotFixedReservation,
      snapshotRowReservation,
      limits.maxTemporaryBytes,
      snapshotFixedReservation,
      snapshotRowReservation,
      Number(context.env.STORAGE_CAP_BYTES),
      Number(context.env.STORAGE_CAP_BYTES),
    ],
  }
  if (statements.length + 2 > limits.maxStatements) {
    await paused('CAPTURE_STATEMENT_BUDGET')
    return
  }
  context.checkpoint('backup.capture.before')
  try {
    const started = performance.now(),
      result = await runGuardedBatch(db, guard, statements)
    await db.prepare("UPDATE recovery_control SET code=NULL WHERE id=1 AND state='open'").run()
    context.emit({
      operation: 'service-backup',
      stage: 'capture',
      jobId: id,
      durationMs: performance.now() - started,
      rowsRead: result.reduce((n, r) => n + r.meta.rows_read, 0),
      rowsWritten: result.reduce((n, r) => n + r.meta.rows_written, 0),
    })
  } catch (error) {
    if (String(error).includes('transaction_guard_passed')) {
      await paused('CAPTURE_NOT_ADMITTED')
      return
    }
    throw error
  }
  context.checkpoint('backup.capture.committed')
}
async function stored(snapshot: Snapshot, kind: string, ordinal: number, context: ServiceContext) {
  return context.env
    .DB!.prepare('SELECT * FROM service_snapshot_objects WHERE snapshot_id=? AND kind=? AND ordinal=?')
    .bind(snapshot.id, kind, ordinal)
    .first<StoredReference>()
}
async function page(snapshot: Snapshot, context: ServiceContext) {
  const db = context.env.DB!,
    row = await db
      .prepare(
        'SELECT id,table_name,source_rowid,body FROM service_snapshot_rows WHERE snapshot_id=? AND id>? ORDER BY id LIMIT 1',
      )
      .bind(snapshot.id, snapshot.cursor)
      .first<{ id: number; table_name: string; source_rowid: number; body: string }>()
  if (!row) {
    await runGuardedBatch(db, owner(snapshot), [
      db.prepare("UPDATE service_snapshots SET state='cipher',cursor=0,offset=0 WHERE id=?").bind(snapshot.id),
    ])
    return
  }
  let ref = await stored(snapshot, 'page', snapshot.page, context)
  if (!ref) {
    const plain = jsonBytes(JSON.parse(row.body)),
      fragment = plain.slice(snapshot.offset, snapshot.offset + recoveryFragmentBytes),
      label = `${snapshot.id}:page:${snapshot.page}`
    const encrypted = await sealRecovery(fragment, label, context)
    const descriptor = {
      kind: 'page',
      sourceKey: null,
      table: row.table_name,
      row: row.source_rowid,
      offset: snapshot.offset,
      total: plain.length,
      label,
      sealed: encodeBytes(encrypted),
    }
    await allocateRecoveryObject(
      label,
      encrypted.length,
      await digest(encrypted),
      null,
      'backup',
      owner(snapshot),
      context,
      (objectId) => [
        db
          .prepare(
            "INSERT INTO service_snapshot_objects(snapshot_id,ordinal,object_id,kind,body) VALUES (?,?,?,'page',?)",
          )
          .bind(snapshot.id, snapshot.page, objectId, JSON.stringify(descriptor)),
      ],
    )
    ref = await stored(snapshot, 'page', snapshot.page, context)
  }
  const body = JSON.parse(ref!.body!) as { sealed: string; total: number }
  await writeRecoveryObject(ref!.object_id, decode(body.sealed), owner(snapshot), context)
  const nextOffset = Math.min(body.total, snapshot.offset + recoveryFragmentBytes),
    finished = nextOffset === body.total
  await runGuardedBatch(db, owner(snapshot), [
    db
      .prepare('UPDATE service_snapshots SET cursor=?,offset=?,page=page+1 WHERE id=?')
      .bind(finished ? row.id : snapshot.cursor, finished ? 0 : nextOffset, snapshot.id),
  ])
}
async function copy(snapshot: Snapshot, context: ServiceContext) {
  const db = context.env.DB!,
    row = await db
      .prepare(
        "SELECT id AS rowid,json_extract(body,'$[0]') AS account_id,json_extract(body,'$[3]') AS object_key,json_extract(body,'$[4]') AS cipher_bytes,json_extract(body,'$[5]') AS cipher_digest FROM service_snapshot_rows WHERE snapshot_id=? AND table_name='upload_chunks' AND id>? AND json_extract(body,'$[9]')='ready' ORDER BY id LIMIT 1",
      )
      .bind(snapshot.id, snapshot.cursor)
      .first<{ rowid: number; account_id: string; object_key: string; cipher_bytes: number; cipher_digest: string }>()
  if (!row) {
    await runGuardedBatch(db, owner(snapshot), [
      db
        .prepare("UPDATE service_snapshots SET state='index',cursor=0,offset=0,manifest=NULL WHERE id=?")
        .bind(snapshot.id),
    ])
    return
  }
  let ref = await stored(snapshot, 'cipher', snapshot.page, context)
  if (!ref) {
    const identity = `cipher:${row.object_key}:${row.cipher_digest}`,
      existing = await db
        .prepare("SELECT * FROM service_backup_objects WHERE identity=? AND state='ready' AND bucket='backup' LIMIT 1")
        .bind(identity)
        .first<RecoveryObject>()
    const attach = (objectId: string) => [
      db
        .prepare(
          "INSERT INTO service_snapshot_objects(snapshot_id,ordinal,source_key,object_id,kind,body) VALUES (?,?,?,?,'cipher',?)",
        )
        .bind(
          snapshot.id,
          snapshot.page,
          row.object_key,
          objectId,
          JSON.stringify({ kind: 'cipher', sourceKey: row.object_key, accountId: row.account_id }),
        ),
    ]
    if (existing)
      await runGuardedBatch(
        db,
        {
          sql: `SELECT (${owner(snapshot).sql}) AND EXISTS(SELECT 1 FROM service_backup_objects WHERE id=? AND state='ready')`,
          bindings: [...owner(snapshot).bindings, existing.id],
        },
        attach(existing.id),
      )
    else
      await allocateRecoveryObject(
        identity,
        row.cipher_bytes,
        row.cipher_digest,
        row.account_id,
        'backup',
        owner(snapshot),
        context,
        attach,
      )
    ref = await stored(snapshot, 'cipher', snapshot.page, context)
  }
  const object = await recoveryObject(ref!.object_id, context)
  if (object!.state === 'ready') await readRecoveryObject(object!, context)
  else {
    const bytes = await readRecoveryObject(
      { bucket: 'live', object_key: row.object_key, size: row.cipher_bytes, digest: row.cipher_digest },
      context,
    )
    context.checkpoint('backup.copy.read')
    await writeRecoveryObject(object!.id, bytes, owner(snapshot), context)
  }
  await runGuardedBatch(db, owner(snapshot), [
    db.prepare('UPDATE service_snapshots SET cursor=?,page=page+1 WHERE id=?').bind(row.rowid, snapshot.id),
  ])
}
async function index(snapshot: Snapshot, context: ServiceContext) {
  const db = context.env.DB!,
    ordinal = snapshot.page + snapshot.cursor
  if (snapshot.cursor === snapshot.page) {
    await publishManifest(snapshot, context)
    return
  }
  const item = await db
    .prepare('SELECT * FROM service_snapshot_objects WHERE snapshot_id=? AND ordinal=?')
    .bind(snapshot.id, snapshot.cursor)
    .first<StoredReference>()
  if (!item) throw new ApiFailure('INTEGRITY_FAILED')
  let ref = await stored(snapshot, 'index', ordinal, context)
  if (!ref) {
    const object = await recoveryObject(item.object_id, context)
    if (!object || object.state !== 'ready') throw new ApiFailure('INTEGRITY_FAILED')
    await readRecoveryObject(object, context)
    const { sealed: _sealed, ...detail } = JSON.parse(item.body!) as SnapshotItem & { sealed?: string }
    const link = {
      ordinal: snapshot.cursor,
      item: { ...detail, object: reference(object) },
      previous: snapshot.manifest ? (JSON.parse(snapshot.manifest) as ObjectReference) : null,
    }
    const bytes = await sealRecovery(jsonBytes(link), `${snapshot.id}:index:${snapshot.cursor}`, context)
    await allocateRecoveryObject(
      `${snapshot.id}:index:${snapshot.cursor}`,
      bytes.length,
      await digest(bytes),
      null,
      'backup',
      owner(snapshot),
      context,
      (objectId) => [
        db
          .prepare(
            "INSERT INTO service_snapshot_objects(snapshot_id,ordinal,object_id,kind,body) VALUES (?,?,?,'index',?)",
          )
          .bind(snapshot.id, ordinal, objectId, encodeBytes(bytes)),
      ],
    )
    ref = await stored(snapshot, 'index', ordinal, context)
  }
  await writeRecoveryObject(ref!.object_id, decode(ref!.body!), owner(snapshot), context)
  await runGuardedBatch(db, owner(snapshot), [
    db
      .prepare('UPDATE service_snapshots SET cursor=cursor+1,manifest=? WHERE id=?')
      .bind(JSON.stringify(reference((await recoveryObject(ref!.object_id, context))!)), snapshot.id),
  ])
}
async function publishManifest(snapshot: Snapshot, context: ServiceContext) {
  const db = context.env.DB!,
    ordinal = snapshot.page * 2
  let ref = await stored(snapshot, 'manifest', ordinal, context)
  if (!ref) {
    const manifest: RecoveryManifest = {
      version: 1,
      snapshotId: snapshot.id,
      sourceGeneration: snapshot.source_generation,
      createdAt: snapshot.created_at,
      rows: snapshot.rows,
      bytes: snapshot.bytes,
      items: snapshot.page,
      last: snapshot.manifest ? (JSON.parse(snapshot.manifest) as ObjectReference) : null,
      secrets: JSON.parse(snapshot.secrets),
      ledger: JSON.parse(snapshot.ledger),
    }
    const bytes = await sealRecovery(jsonBytes(manifest), `${snapshot.id}:manifest`, context)
    await allocateRecoveryObject(
      `${snapshot.id}:manifest`,
      bytes.length,
      await digest(bytes),
      null,
      'backup',
      owner(snapshot),
      context,
      (objectId) => [
        db
          .prepare(
            "INSERT INTO service_snapshot_objects(snapshot_id,ordinal,object_id,kind,body) VALUES (?,?,?,'manifest',?)",
          )
          .bind(snapshot.id, ordinal, objectId, encodeBytes(bytes)),
      ],
    )
    ref = await stored(snapshot, 'manifest', ordinal, context)
  }
  await writeRecoveryObject(ref!.object_id, decode(ref!.body!), owner(snapshot), context)
  const root = reference((await recoveryObject(ref!.object_id, context))!),
    body = JSON.stringify(root)
  context.checkpoint('backup.manifest.before')
  await context.env.LEDGER_BACKUPS!.put(`${rootPrefix}${snapshot.id}`, body, { onlyIf: { etagDoesNotMatch: '*' } })
  if ((await (await context.env.LEDGER_BACKUPS!.get(`${rootPrefix}${snapshot.id}`))?.text()) !== body)
    throw new ApiFailure('INTEGRITY_FAILED')
  await runGuardedBatch(db, owner(snapshot), [
    db.prepare("UPDATE service_snapshots SET state='verifying',cursor=page-1 WHERE id=?").bind(snapshot.id),
  ])
}
export async function readSnapshotManifest(context: ServiceContext, snapshotId: string): Promise<RecoveryManifest> {
  if (!OpaqueIdSchema.safeParse(snapshotId).success) throw new ApiFailure('INTEGRITY_FAILED')
  const locator = await context.env.LEDGER_BACKUPS?.get(`${rootPrefix}${snapshotId}`)
  if (!locator || locator.size > 1024) throw new ApiFailure('INTEGRITY_FAILED')
  try {
    const root = objectReferenceSchema.parse(JSON.parse(await locator.text()))
    if (root.size > 16 * 1024) throw new ApiFailure('INTEGRITY_FAILED')
    const bytes = await readRecoveryObject(
      { bucket: 'backup', object_key: root.key, size: root.size, digest: root.digest },
      context,
    )
    const manifest = manifestSchema.parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
          await openRecovery(bytes, `${snapshotId}:manifest`, context),
        ),
      ),
    )
    if (
      manifest.snapshotId !== snapshotId ||
      JSON.stringify(manifest.secrets) !== JSON.stringify(await secretIdentity(context))
    )
      throw new ApiFailure('INTEGRITY_FAILED')
    return manifest
  } catch {
    throw new ApiFailure('INTEGRITY_FAILED')
  }
}
export async function readSnapshotLink(
  context: ServiceContext,
  snapshotId: string,
  ordinal: number,
  ref: ObjectReference,
): Promise<Link> {
  objectReferenceSchema.parse(ref)
  if (ref.size > 16 * 1024) throw new ApiFailure('INTEGRITY_FAILED')
  const bytes = await readRecoveryObject(
    { bucket: 'backup', object_key: ref.key, size: ref.size, digest: ref.digest },
    context,
  )
  const link = linkSchema.parse(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
        await openRecovery(bytes, `${snapshotId}:index:${ordinal}`, context),
      ),
    ),
  )
  if (link.ordinal !== ordinal || (link.item.kind === 'page' && link.item.label !== `${snapshotId}:page:${ordinal}`))
    throw new ApiFailure('INTEGRITY_FAILED')
  await readRecoveryObject(
    {
      bucket: 'backup',
      object_key: link.item.object.key,
      size: link.item.object.size,
      digest: link.item.object.digest,
    },
    context,
  )
  return link
}
async function verifySnapshotStep(context: ServiceContext, snapshotId: string): Promise<void> {
  const snapshot = await snapshotRow(snapshotId, context)
  if (!snapshot || !['verifying', 'reverifying', 'complete'].includes(snapshot.state))
    throw new ApiFailure('INTEGRITY_FAILED')
  const manifest = await readSnapshotManifest(context, snapshotId)
  if (snapshot.state === 'complete') return
  let next: ObjectReference | null = null
  if (snapshot.cursor >= 0) {
    const ref = snapshot.manifest ? (JSON.parse(snapshot.manifest) as ObjectReference) : manifest.last
    if (!ref) throw new ApiFailure('INTEGRITY_FAILED')
    next = (await readSnapshotLink(context, snapshotId, snapshot.cursor, ref)).previous
    if ((snapshot.cursor === 0) !== (next === null)) throw new ApiFailure('INTEGRITY_FAILED')
  }
  await runGuardedBatch(context.env.DB!, owner(snapshot), [
    context.env
      .DB!.prepare(
        "UPDATE service_snapshots SET cursor=cursor-1,manifest=?,state=CASE WHEN cursor<=0 THEN 'complete' ELSE state END WHERE id=?",
      )
      .bind(next ? JSON.stringify(next) : null, snapshotId),
  ])
}
// Explicit verification is a durable bounded scan; SERVICE_UNAVAILABLE means resume the same scan
export async function verifyServiceSnapshot(context: ServiceContext, snapshotId: string): Promise<void> {
  const snapshot = await snapshotRow(snapshotId, context)
  if (!snapshot) throw new ApiFailure('INTEGRITY_FAILED')
  try {
    // Root failures must pause durable health while retaining the original recovery-point timestamp
    if (snapshot.state === 'complete') {
      const manifest = await readSnapshotManifest(context, snapshotId)
      await runGuardedBatch(context.env.DB!, owner(snapshot), [
        context.env
          .DB!.prepare("UPDATE service_snapshots SET state='reverifying',cursor=?,manifest=? WHERE id=?")
          .bind(manifest.items - 1, JSON.stringify(manifest.last), snapshotId),
      ])
    }
    await verifySnapshotStep(context, snapshotId)
  } catch (error) {
    await context.env
      .DB!.prepare('UPDATE service_snapshots SET code=? WHERE id=?')
      .bind(error instanceof ApiFailure ? error.code : 'CAPTURE_RETRY_REQUIRED', snapshotId)
      .run()
    throw error
  }
  await context.env.DB!.prepare('UPDATE service_snapshots SET code=NULL WHERE id=?').bind(snapshotId).run()
  if ((await snapshotRow(snapshotId, context))?.state !== 'complete') throw new ApiFailure('SERVICE_UNAVAILABLE', 1)
}
export async function cancelAccountSnapshots(accountId: string, context: ServiceContext): Promise<boolean> {
  const id = await context.env
    .DB!.prepare(
      "SELECT DISTINCT s.id FROM service_snapshots s JOIN service_snapshot_pins p ON p.snapshot_id=s.id JOIN storage_generations g ON g.id=p.generation WHERE g.account_id=? AND s.state NOT IN ('complete','expired','paused') LIMIT 1",
    )
    .bind(accountId)
    .first<string>('id')
  if (!id) return true
  await expireServiceSnapshot(context, id)
  return false
}
// Each call performs one bounded durable phase; callers schedule continuation explicitly
export async function captureServiceSnapshot(context: ServiceContext, snapshotId: string): Promise<JobReceipt> {
  if (!OpaqueIdSchema.safeParse(snapshotId).success || !context.env.DB || !context.env.LEDGER_BACKUPS)
    throw new ApiFailure('INTEGRITY_FAILED')
  let snapshot = await snapshotRow(snapshotId, context)
  try {
    if (!snapshot) await capture(context, snapshotId)
    else if (snapshot.state === 'pages') await page(snapshot, context)
    else if (snapshot.state === 'cipher') await copy(snapshot, context)
    else if (snapshot.state === 'index') await index(snapshot, context)
    else if (snapshot.state === 'verifying' || snapshot.state === 'reverifying')
      await verifySnapshotStep(context, snapshotId)
    snapshot = await snapshotRow(snapshotId, context)
    if (snapshot && snapshot.state !== 'paused')
      await context.env.DB!.prepare('UPDATE service_snapshots SET code=NULL WHERE id=?').bind(snapshotId).run()
    return receipt(
      snapshotId,
      snapshot?.state === 'complete' ? 'complete' : !snapshot || snapshot.state === 'paused' ? 'waiting' : 'running',
      context,
    )
  } catch (error) {
    await context.env
      .DB!.prepare('UPDATE service_snapshots SET code=? WHERE id=?')
      .bind(error instanceof ApiFailure ? error.code : 'CAPTURE_RETRY_REQUIRED', snapshotId)
      .run()
    if (!snapshot)
      await context.env
        .DB!.prepare("UPDATE recovery_control SET code=? WHERE id=1 AND state='open'")
        .bind(error instanceof ApiFailure ? error.code : 'CAPTURE_RETRY_REQUIRED')
        .run()
    context.emit({
      operation: 'service-backup',
      stage: 'capture',
      jobId: snapshotId,
      code: error instanceof ApiFailure ? error.code : 'RETRY_PENDING',
    })
    throw error
  }
}
// Expiration claims references before fencing, so a simultaneous dedup claimant wins or loses atomically
export async function expireServiceSnapshot(context: ServiceContext, snapshotId: string): Promise<boolean> {
  const db = context.env.DB!,
    snapshot = await snapshotRow(snapshotId, context)
  if (!snapshot) throw new ApiFailure('NOT_FOUND')
  if (snapshot.state === 'expired') return true
  if (!['expiring', 'expired'].includes(snapshot.state))
    await runGuardedBatch(
      db,
      {
        sql: `SELECT ${activeRecoveryService} AND EXISTS(SELECT 1 FROM service_snapshots WHERE id=? AND state=?)`,
        bindings: [snapshotId, snapshot.state],
      },
      [db.prepare("UPDATE service_snapshots SET state='expiring' WHERE id=?").bind(snapshotId)],
    )
  const ref = await db
    .prepare('SELECT * FROM service_snapshot_objects WHERE snapshot_id=? ORDER BY ordinal LIMIT 1')
    .bind(snapshotId)
    .first<StoredReference>()
  if (ref) {
    await runGuardedBatch(
      db,
      { sql: "SELECT state='expiring' FROM service_snapshots WHERE id=?", bindings: [snapshotId] },
      [
        db
          .prepare(
            "UPDATE service_backup_objects SET state='closing' WHERE id=? AND state NOT IN ('closed','unsafe') AND NOT EXISTS(SELECT 1 FROM service_snapshot_objects WHERE object_id=? AND NOT(snapshot_id=? AND ordinal=?))",
          )
          .bind(ref.object_id, ref.object_id, snapshotId, ref.ordinal),
      ],
    )
    const object = await recoveryObject(ref.object_id, context)
    if (object?.state === 'unsafe' || (object?.state === 'closing' && !(await fenceRecoveryObject(object.id, context))))
      throw new ApiFailure('INTEGRITY_FAILED')
    await runGuardedBatch(
      db,
      { sql: "SELECT state='expiring' FROM service_snapshots WHERE id=?", bindings: [snapshotId] },
      [
        db
          .prepare('DELETE FROM service_snapshot_objects WHERE snapshot_id=? AND ordinal=?')
          .bind(snapshotId, ref.ordinal),
        // Two expirations may both observe the other reference before either removes it
        // The final removal must claim closing in this same transaction or it can orphan ready bytes
        db
          .prepare(
            "UPDATE service_backup_objects SET state='closing' WHERE id=? AND state='ready' AND NOT EXISTS(SELECT 1 FROM service_snapshot_objects WHERE object_id=?)",
          )
          .bind(ref.object_id, ref.object_id),
      ],
    )
    return false
  }
  const pending = await db
    .prepare("SELECT id FROM service_backup_objects WHERE state='closing' LIMIT 1")
    .first<string>('id')
  if (pending) {
    await fenceRecoveryObject(pending, context)
    return false
  }
  const rows = await db
    .prepare(
      'DELETE FROM service_snapshot_rows WHERE id IN(SELECT id FROM service_snapshot_rows WHERE snapshot_id=? LIMIT 32)',
    )
    .bind(snapshotId)
    .run()
  if (rows.meta.changes) return false
  await runGuardedBatch(
    db,
    { sql: "SELECT state='expiring' FROM service_snapshots WHERE id=?", bindings: [snapshotId] },
    [
      db.prepare('DELETE FROM service_snapshot_pins WHERE snapshot_id=?').bind(snapshotId),
      db
        .prepare(
          "UPDATE quota_counters SET reserved_metadata=reserved_metadata-(SELECT MAX(0,reserve-8192) FROM service_snapshots WHERE id=?) WHERE scope='global'",
        )
        .bind(snapshotId),
      db.prepare("UPDATE service_snapshots SET state='expired',reserve=MIN(reserve,8192) WHERE id=?").bind(snapshotId),
    ],
  )
  return true
}
