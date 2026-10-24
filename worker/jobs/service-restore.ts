import type { D1PreparedStatement } from '@cloudflare/workers-types/experimental'
import type { ServiceContext } from '../context'
import { randomId } from '../auth/identity'
import { runGuardedBatch } from '../db/guarded-batch'
import { ApiFailure } from '../http'
import { controlBodyBytes, decode, digest } from '../sync/storage'
import {
  readRevocationHead,
  readRevocationLiabilities,
  verifyRevocationLedgerPage,
  type LedgerScan,
  type RevocationEvent,
} from './ledger'
import { readSnapshotLink, readSnapshotManifest, type SnapshotItem } from './service-backup'
import {
  openRecovery,
  recoveryFragmentBytes,
  recoveryMaximumRowBytes,
  type ObjectReference,
  type RecoveryManifest,
} from './recovery-codec'
import {
  recoveryProjection,
  recoveryTables,
  normalizeRecoveryTuple,
  type RecoveryTable,
} from './recovery-projection'
import {
  allocateRecoveryObject,
  readRecoveryObject,
  recoveryObject,
  writeRecoveryObject,
} from './recovery-storage'

interface Restore {
  state: string
  generation: string
  snapshot_id: string | null
  phase: string
  cursor: number
  ledger: string | null
  code: string | null
}
const excludedRestoreTables = new Set<RecoveryTable>([
  'quota_counters',
  'scan_leases',
  'publication_borrows',
  'admin_access_sessions',
  'admin_sessions',
  'admin_confirmations',
  'admin_previews',
])
function guard(row: Restore) {
  return {
    sql: "SELECT state='restoring' AND generation=? AND snapshot_id=? AND phase=? AND cursor=? FROM recovery_control WHERE id=1",
    bindings: [row.generation, row.snapshot_id, row.phase, row.cursor],
  }
}
async function control(context: ServiceContext) {
  const row = await context.env.DB!.prepare('SELECT * FROM recovery_control WHERE id=1').first<Restore>()
  if (!row) throw new ApiFailure('INTEGRITY_FAILED')
  return row
}
// Every installed row and independent-ledger page must fit after its accounting triggers run
// Checking only the initial manifest reservation would miss later acknowledged liabilities
async function restoreBatch(row: Restore, context: ServiceContext, statements: readonly D1PreparedStatement[]) {
  const db = context.env.DB!,
    check = randomId()
  await runGuardedBatch(db, guard(row), [
    ...statements,
    db
      .prepare(
        "INSERT INTO transaction_guards(id,passed) SELECT ?,CASE WHEN payload_bytes+reserved_metadata+metadata_bytes<=? THEN 1 ELSE 0 END FROM quota_counters WHERE scope='global'",
      )
      .bind(check, Number(context.env.STORAGE_CAP_BYTES)),
    db.prepare('DELETE FROM transaction_guards WHERE id=?').bind(check),
  ])
}
async function advance(
  row: Restore,
  context: ServiceContext,
  phase: string,
  cursor = 0,
  ledger: string | null = row.ledger,
) {
  await restoreBatch(row, context, [
    context.env
      .DB!.prepare('UPDATE recovery_control SET phase=?,cursor=?,ledger=? WHERE id=1')
      .bind(phase, cursor, ledger),
  ])
}
export async function requireRecoveryOpen(context: ServiceContext): Promise<void> {
  if ((await control(context)).state !== 'open') throw new ApiFailure('SERVICE_UNAVAILABLE')
}
export async function closeServiceForRecovery(context: ServiceContext): Promise<void> {
  // This D1 fence also rejects a writer that passed request middleware before closure
  await context.env.DB!.prepare("UPDATE recovery_control SET state='closed' WHERE id=1 AND state='open'").run()
}
async function importCipher(row: Restore, item: SnapshotItem, context: ServiceContext) {
  if (!item.sourceKey || !item.accountId) throw new ApiFailure('INTEGRITY_FAILED')
  const db = context.env.DB!
  if (await deleted(item.accountId, context)) return
  let mapped = await db
    .prepare('SELECT object_id FROM recovery_object_map WHERE original=?')
    .bind(item.sourceKey)
    .first<string>('object_id')
  if (!mapped) {
    const allocated = await allocateRecoveryObject(
      `restore:${row.generation}:${item.sourceKey}`,
      item.object.size,
      item.object.digest,
      item.accountId,
      'live',
      guard(row),
      context,
      (id) => [db.prepare('INSERT INTO recovery_object_map(original,object_id) VALUES (?,?)').bind(item.sourceKey, id)],
    )
    mapped = allocated.id
  }
  const bytes = await readRecoveryObject(
    { bucket: 'backup', object_key: item.object.key, size: item.object.size, digest: item.object.digest },
    context,
  )
  await writeRecoveryObject(mapped, bytes, guard(row), context)
}
async function download(row: Restore, manifest: RecoveryManifest, context: ServiceContext) {
  if (row.cursor < 0) {
    await advance(row, context, 'assemble', 0, row.code)
    await context.env.DB!.prepare('UPDATE recovery_control SET code=NULL WHERE id=1').run()
    return
  }
  const ref = JSON.parse(row.ledger!) as ObjectReference
  const link = await readSnapshotLink(context, manifest.snapshotId, row.cursor, ref),
    item = link.item,
    db = context.env.DB!
  if (item.kind === 'cipher') await importCipher(row, item, context)
  else {
    if (
      !item.table ||
      !recoveryTables.includes(item.table as RecoveryTable) ||
      !Number.isSafeInteger(item.row) ||
      !Number.isSafeInteger(item.offset) ||
      !Number.isSafeInteger(item.total) ||
      item.total! > recoveryMaximumRowBytes ||
      item.offset! < 0 ||
      !item.label
    )
      throw new ApiFailure('INTEGRITY_FAILED')
    const encrypted = await readRecoveryObject(
      { bucket: 'backup', object_key: item.object.key, size: item.object.size, digest: item.object.digest },
      context,
    )
    const plain = await openRecovery(encrypted, item.label, context)
    if (item.offset! + plain.length > item.total!) throw new ApiFailure('INTEGRITY_FAILED')
    const body = Array.from(plain)
    await restoreBatch(row, context, [
      db
        .prepare(
          'INSERT INTO recovery_fragments(table_name,source_rowid,offset,total,body) VALUES (?,?,?,?,?) ON CONFLICT(table_name,source_rowid,offset) DO NOTHING',
        )
        .bind(item.table, item.row!, item.offset!, item.total!, JSON.stringify(body)),
    ])
  }
  if ((row.cursor === 0) !== (link.previous === null)) throw new ApiFailure('INTEGRITY_FAILED')
  context.checkpoint('restore.item.verified')
  await advance(row, context, 'download', row.cursor - 1, JSON.stringify(link.previous))
}
async function assemble(row: Restore, context: ServiceContext) {
  const db = context.env.DB!,
    first = await db
      .prepare('SELECT table_name,source_rowid,total FROM recovery_fragments ORDER BY table_name,source_rowid LIMIT 1')
      .first<{ table_name: string; source_rowid: number; total: number }>()
  if (!first) {
    await advance(row, context, 'install', 0)
    return
  }
  const parts = await db
    .prepare(
      'SELECT offset,total,body FROM recovery_fragments WHERE table_name=? AND source_rowid=? ORDER BY offset LIMIT ?',
    )
    .bind(first.table_name, first.source_rowid, Math.ceil(recoveryMaximumRowBytes / recoveryFragmentBytes))
    .all<{ offset: number; total: number; body: string }>()
  const bytes = new Uint8Array(first.total)
  let length = 0
  for (const part of parts.results) {
    const chunk = Uint8Array.from(JSON.parse(part.body) as number[])
    if (part.offset !== length || part.total !== first.total) throw new ApiFailure('INTEGRITY_FAILED')
    bytes.set(chunk, length)
    length += chunk.length
  }
  if (length !== first.total) throw new ApiFailure('INTEGRITY_FAILED')
  const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  const values = normalizeRecoveryTuple(first.table_name as RecoveryTable, JSON.parse(body))
  await restoreBatch(row, context, [
    db
      .prepare('INSERT INTO recovery_import_rows(table_name,source_rowid,body) VALUES (?,?,?)')
      .bind(first.table_name, first.source_rowid, JSON.stringify(values)),
    db
      .prepare('DELETE FROM recovery_fragments WHERE table_name=? AND source_rowid=?')
      .bind(first.table_name, first.source_rowid),
  ])
}
async function generation(original: string, row: Restore, context: ServiceContext) {
  const db = context.env.DB!
  let value = await db
    .prepare('SELECT replacement FROM recovery_generations WHERE original=?')
    .bind(original)
    .first<string>('replacement')
  if (!value) {
    value = randomId()
    await restoreBatch(row, context, [
      db.prepare('INSERT INTO recovery_generations(original,replacement) VALUES (?,?)').bind(original, value),
    ])
  }
  return value
}
async function deleted(accountId: string, context: ServiceContext) {
  return !!(await context.env
    .DB!.prepare(
      "SELECT 1 FROM recovery_ledger_events WHERE json_extract(event,'$.kind')='account-deleted' AND json_extract(event,'$.accountId')=? LIMIT 1",
    )
    .bind(accountId)
    .first())
}
async function install(row: Restore, manifest: RecoveryManifest, context: ServiceContext) {
  const db = context.env.DB!,
    table = recoveryTables[row.cursor]
  if (!table) {
    if ((await db.prepare('SELECT COUNT(*) n FROM recovery_import_rows').first<number>('n')) !== manifest.rows)
      throw new ApiFailure('INTEGRITY_FAILED')
    await advance(row, context, 'revocations', 0, row.ledger)
    return
  }
  if (excludedRestoreTables.has(table)) {
    await advance(row, context, 'install', row.cursor + 1)
    return
  }
  const record = await db
    .prepare(
      'SELECT source_rowid,body FROM recovery_import_rows WHERE table_name=? AND source_rowid>COALESCE((SELECT CAST(code AS INTEGER) FROM recovery_control WHERE id=1),0) ORDER BY source_rowid LIMIT 1',
    )
    .bind(table)
    .first<{ source_rowid: number; body: string }>()
  if (!record) {
    await restoreBatch(row, context, [db.prepare('UPDATE recovery_control SET cursor=cursor+1,code=NULL WHERE id=1')])
    return
  }
  const columns: readonly string[] = recoveryProjection[table],
    values = JSON.parse(record.body) as (string | number | null)[],
    data = Object.fromEntries(columns.map((name, index) => [name, values[index]]))
  if (
    (table === 'accounts' && (await deleted(String(data.id), context))) ||
    (typeof data.account_id === 'string' && (await deleted(data.account_id, context)))
  ) {
    await restoreBatch(row, context, [
      db.prepare('UPDATE recovery_control SET code=? WHERE id=1').bind(String(record.source_rowid)),
    ])
    return
  }
  if (table === 'devices') data.revoked_at = context.now()
  if (table === 'email_jobs') {
    data.payload = null
    data.eligible = 0
    data.lease_token = null
    data.lease_until = null
    if (['queued', 'waiting', 'running'].includes(String(data.state))) {
      data.state = 'failed'
      if (!['accepted', 'uncertain'].includes(String(data.delivery))) data.delivery = 'cancelled'
    }
  }
  if (table === 'service_jobs') {
    data.lease_token = null
    data.lease_until = null
  }
  if (table === 'publication_work' && ['validating', 'complete'].includes(String(data.state))) data.state = 'abandoned'
  if (table === 'publication_certificates') data.state = 'invalidated'
  if (table === 'storage_generations') data.id = await generation(String(data.id), row, context)
  if (table === 'upload_reservations' || table === 'publication_pins')
    if (data.generation) data.generation = await generation(String(data.generation), row, context)
  const extra = []
  if (table === 'upload_chunks') {
    const old = String(data.object_key),
      mapped = await db
        .prepare('SELECT object_id FROM recovery_object_map WHERE original=?')
        .bind(old)
        .first<string>('object_id')
    data.generation = await generation(String(data.generation), row, context)
    if (data.state === 'ready') {
      const object = mapped ? await recoveryObject(mapped, context) : null
      if (
        !object ||
        object.state !== 'ready' ||
        object.digest !== data.cipher_digest ||
        object.size !== data.cipher_bytes
      )
        throw new ApiFailure('INTEGRITY_FAILED')
      await readRecoveryObject(object, context)
      Object.assign(data, {
        object_key: object.object_key,
        seed: object.seed,
        marker: object.marker,
        seed_etag: object.seed_etag,
      })
      extra.push(
        db
          .prepare('UPDATE quota_counters SET payload_bytes=payload_bytes+? WHERE scope=?')
          .bind(object.size + controlBodyBytes * 2, data.account_id),
      )
    } else if (data.state === 'closed') {
      const marker = decode(String(data.marker))
      await context.env.OBJECTS!.put(old, marker)
      const saved = await context.env.OBJECTS!.get(old)
      if (
        !saved ||
        (await digest(new Uint8Array(await saved.arrayBuffer()))) !== (await digest(marker)) ||
        saved.etag === data.seed_etag
      )
        throw new ApiFailure('INTEGRITY_FAILED')
      extra.push(
        db
          .prepare("UPDATE quota_counters SET payload_bytes=payload_bytes+32 WHERE scope='global' OR scope=?")
          .bind(data.account_id),
      )
    } else throw new ApiFailure('INTEGRITY_FAILED')
  }
  if (table === 'upload_reservations')
    extra.push(
      db
        .prepare(
          "UPDATE quota_counters SET reserved_metadata=reserved_metadata+? WHERE scope='global' OR scope=?",
        )
        .bind(data.descriptor_reserve, data.account_id),
    )
  // Staging migrations seed settings; replace that singleton without discarding captured policy
  await restoreBatch(row, context, [
    db
      .prepare(
        `INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})${
          table === 'service_settings'
            ? ` ON CONFLICT(id) DO UPDATE SET ${columns
                .filter((name) => name !== 'id')
                .map((name) => `${name}=excluded.${name}`)
                .join(',')}`
            : ''
        }`,
      )
      .bind(...columns.map((name) => data[name])),
    ...extra,
    db.prepare('UPDATE recovery_control SET code=? WHERE id=1').bind(String(record.source_rowid)),
  ])
}
async function reconcile(row: Restore, manifest: RecoveryManifest, context: ServiceContext) {
  const db = context.env.DB!,
    scan = row.ledger ? (JSON.parse(row.ledger) as LedgerScan) : undefined
  const result = await verifyRevocationLedgerPage(context, scan, manifest.ledger)
  const statements = result.events.map((event) =>
    db
      .prepare('INSERT INTO recovery_ledger_events(intent_id,event) VALUES (?,?) ON CONFLICT(intent_id) DO NOTHING')
      .bind(event.intentId, JSON.stringify(event)),
  )
  statements.push(
    db
      .prepare('UPDATE recovery_control SET ledger=?,phase=?,cursor=?,code=? WHERE id=1')
      .bind(
        JSON.stringify(result.next ?? manifest.last),
        result.next ? 'ledger' : 'download',
        result.next ? 0 : manifest.items - 1,
        result.next ? null : JSON.stringify(result.head),
      ),
  )
  await restoreBatch(row, context, statements)
}
async function revoke(row: Restore, context: ServiceContext) {
  const db = context.env.DB!,
    entry = await db
      .prepare('SELECT rowid,event FROM recovery_ledger_events WHERE rowid>? ORDER BY rowid LIMIT 1')
      .bind(row.cursor)
      .first<{ rowid: number; event: string }>()
  if (!entry) {
    // An append during reconciliation cannot slip into a claimed verified restore
    const head = await readRevocationHead(context, JSON.parse(row.ledger!))
    if (JSON.stringify(head) !== row.ledger) throw new ApiFailure('SERVICE_UNAVAILABLE')
    context.checkpoint('restore.ledger.verified')
    await restoreBatch(row, context, [
      db.prepare("UPDATE recovery_control SET state='verified',phase='verified',cursor=0,code=NULL WHERE id=1"),
    ])
    return
  }
  const event = JSON.parse(entry.event) as RevocationEvent,
    statements = []
  if (event.kind === 'account-deleted') {
    const pages = await readRevocationLiabilities(event.intentId, context)
    if (!pages) throw new ApiFailure('INTEGRITY_FAILED')
    const pageIndex = Number(row.code ?? 0),
      page = pages[pageIndex]
    for (const liability of page?.entries ?? []) {
      const existing = await db
        .prepare('SELECT marker FROM recovery_liabilities WHERE object_key=?')
        .bind(liability.managedKey)
        .first<string>('marker')
      if (existing && existing !== liability.markerIdentity) throw new ApiFailure('INTEGRITY_FAILED')
      if (!existing) {
        statements.push(
          db
            .prepare('INSERT INTO recovery_liabilities(object_key,marker,bytes) VALUES (?,?,?)')
            .bind(liability.managedKey, liability.markerIdentity, liability.retainedBytes),
          db
            .prepare(
              "UPDATE quota_counters SET payload_bytes=payload_bytes+CASE WHEN EXISTS(SELECT 1 FROM upload_chunks WHERE object_key=?) THEN 0 ELSE 32 END,metadata_bytes=metadata_bytes+512 WHERE scope='global'",
            )
            .bind(liability.managedKey),
        )
      }
    }
    if (pageIndex + 1 < pages.length) {
      statements.push(db.prepare('UPDATE recovery_control SET code=? WHERE id=1').bind(String(pageIndex + 1)))
      await restoreBatch(row, context, statements)
      return
    }
    // Authority is suppressed immediately; normal deletion continues its exact journal after promotion
    // Restored copies for a deleted owner are kept closed and never returned through customer auth
    statements.push(
      db
        .prepare("UPDATE accounts SET access='deleting',session_epoch=MAX(session_epoch,?) WHERE id=?")
        .bind(event.sessionEpoch, event.accountId),
      db.prepare("UPDATE shares SET state='stopped' WHERE account_id=?").bind(event.accountId),
    )
  } else if (event.kind === 'share-stopped')
    statements.push(
      db
        .prepare("UPDATE shares SET state='stopped' WHERE id=? AND account_id=?")
        .bind(event.shareId, event.accountId),
    )
  else if (event.kind === 'operator-revoked')
    statements.push(
      db
        .prepare("UPDATE operators SET state='revoked',revision=MAX(revision,?) WHERE id=?")
        .bind(event.sessionEpoch, event.operatorId),
    )
  else if (event.kind === 'invitation-revoked') {
    // operatorId binds the creator identity, never authority to revoke that creator
    statements.push(
      db
        .prepare(
          "UPDATE admin_invitations SET state='cancelled',revision=MAX(revision,?) WHERE id=? AND created_by=?",
        )
        .bind(event.sessionEpoch, event.invitationId, event.operatorId),
    )
  } else throw new ApiFailure('INTEGRITY_FAILED')
  statements.push(db.prepare('UPDATE recovery_control SET cursor=?,code=NULL WHERE id=1').bind(entry.rowid))
  await restoreBatch(row, context, statements)
}
// The target is a separately provisioned, never-served staging database/bucket pair
// One invocation advances one bounded phase and leaves all HTTP and scheduled work closed
export async function restoreServiceSnapshot(context: ServiceContext, snapshotId: string): Promise<void> {
  if (!context.env.DB || !context.env.LEDGER_BACKUPS || !context.env.OBJECTS)
    throw new ApiFailure('INTEGRITY_FAILED')
  const db = context.env.DB!,
    manifest = await readSnapshotManifest(context, snapshotId)
  let row = await control(context)
  if (row.snapshot_id === null) {
    // Even pre-membership authority makes a target previously served, not empty staging
    await runGuardedBatch(
      db,
      {
        sql: "SELECT state='closed' AND NOT EXISTS(SELECT 1 FROM accounts) AND NOT EXISTS(SELECT 1 FROM service_backup_objects) AND NOT EXISTS(SELECT 1 FROM operators) AND NOT EXISTS(SELECT 1 FROM admin_actions) AND NOT EXISTS(SELECT 1 FROM admin_invitations) AND NOT EXISTS(SELECT 1 FROM admin_access_sessions) AND NOT EXISTS(SELECT 1 FROM admin_previews) FROM recovery_control WHERE id=1",
        bindings: [],
      },
      [
        db
          .prepare(
            "UPDATE recovery_control SET state='restoring',generation=?,snapshot_id=?,phase='ledger',cursor=0,ledger=NULL WHERE id=1",
          )
          .bind(randomId(), snapshotId),
        db
          .prepare("UPDATE quota_counters SET reserved_metadata=reserved_metadata+? WHERE scope='global'")
          .bind(8192 + manifest.bytes * 6 + manifest.rows * 512),
        db
          .prepare(
            "INSERT INTO transaction_guards(id,passed) SELECT ?,CASE WHEN payload_bytes+reserved_metadata+metadata_bytes<=? THEN 1 ELSE 0 END FROM quota_counters WHERE scope='global'",
          )
          .bind(snapshotId, Number(context.env.STORAGE_CAP_BYTES)),
        db.prepare('DELETE FROM transaction_guards WHERE id=?').bind(snapshotId),
      ],
    )
    return
  }
  if (row.snapshot_id !== snapshotId) throw new ApiFailure('INTEGRITY_FAILED')
  if (row.state === 'verified') return
  if (row.state !== 'restoring') throw new ApiFailure('INTEGRITY_FAILED')
  context.checkpoint(`restore.${row.phase}.before`)
  if (row.phase === 'download') await download(row, manifest, context)
  else if (row.phase === 'assemble') await assemble(row, context)
  else if (row.phase === 'install') await install(row, manifest, context)
  else if (row.phase === 'ledger') await reconcile(row, manifest, context)
  else if (row.phase === 'revocations') await revoke(row, context)
  else throw new ApiFailure('INTEGRITY_FAILED')
}
// Local promotion contract only: the operational owner must supply the frozen original
// Provider deployment/binding changes are deliberately outside this function's authority
export async function promoteServiceRestore(staged: ServiceContext, original: ServiceContext): Promise<void> {
  const row = await control(staged),
    source = await control(original)
  if (
    row.state !== 'verified' ||
    source.state !== 'closed' ||
    staged.env.DB === original.env.DB ||
    staged.env.OBJECTS === original.env.OBJECTS
  )
    throw new ApiFailure('INTEGRITY_FAILED')
  const manifest = await readSnapshotManifest(staged, row.snapshot_id!)
  if (
    source.generation !== manifest.sourceGeneration ||
    staged.env.REVOCATION_LEDGER !== original.env.REVOCATION_LEDGER
  )
    throw new ApiFailure('INTEGRITY_FAILED')
  if (
    await original.env
      .DB!.prepare(
        "SELECT EXISTS(SELECT 1 FROM revocation_intents WHERE acknowledged=0) OR EXISTS(SELECT 1 FROM share_mutations WHERE kind='stop' AND receipt IS NULL) OR EXISTS(SELECT 1 FROM admin_revocations WHERE acknowledged=0) OR EXISTS(SELECT 1 FROM service_snapshots WHERE state NOT IN ('complete','paused','expired')) AS pending",
      )
      .first<number>('pending')
  )
    throw new ApiFailure('SERVICE_UNAVAILABLE')
  const head = await readRevocationHead(staged, JSON.parse(row.ledger!))
  if (JSON.stringify(head) !== row.ledger) throw new ApiFailure('SERVICE_UNAVAILABLE')
  // Keep original storage and control liabilities charged until the operational owner proves disposal
  const retained = await original.env
    .DB!.prepare(
      "SELECT payload_bytes+reserved_metadata+metadata_bytes AS bytes FROM quota_counters WHERE scope='global'",
    )
    .first<number>('bytes')
  if (retained === null) throw new ApiFailure('INTEGRITY_FAILED')
  await runGuardedBatch(
    staged.env.DB!,
    { sql: "SELECT state='verified' AND generation=? FROM recovery_control WHERE id=1", bindings: [row.generation] },
    [
      staged.env.DB!.prepare("UPDATE recovery_control SET state='restoring' WHERE id=1"),
      staged.env
        .DB!.prepare("UPDATE quota_counters SET reserved_metadata=reserved_metadata+? WHERE scope='global'")
        .bind(retained),
      staged.env
        .DB!.prepare(
          "INSERT INTO transaction_guards(id,passed) SELECT ?,CASE WHEN payload_bytes+reserved_metadata+metadata_bytes<=MIN(?,COALESCE((SELECT project_capacity_bytes FROM service_settings WHERE id='service'),?)) AND NOT EXISTS(SELECT 1 FROM admin_revocations WHERE acknowledged=0) THEN 1 ELSE 0 END FROM quota_counters WHERE scope='global'",
        )
        .bind(row.generation, Number(staged.env.STORAGE_CAP_BYTES), Number(staged.env.STORAGE_CAP_BYTES)),
      staged.env.DB!.prepare('DELETE FROM transaction_guards WHERE id=?').bind(row.generation),
      staged.env.DB!.prepare("UPDATE recovery_control SET state='open',phase='promoted' WHERE id=1"),
    ],
  )
}
