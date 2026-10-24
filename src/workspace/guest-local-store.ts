import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'
import type { Table } from 'dexie'
import { GuestManagedManifestSchema, requireGuestManagedRecoveryReceipt, type GuestManagedRecoverySelection, type GuestManagedManifest } from './guest-managed-contract'
export { GuestManagedManifestSchema, type GuestManagedManifest } from './guest-managed-contract'
import { readManagedRetainedBranches } from './guest-managed-retained'
import type { GuestCoordinatorDatabase } from './guest-coordinator'
import type { GuestManagedMigration } from './guest-managed-migration'
import { admittedLocalReferences, type AdmittedLocalSnapshot, type LocalRecordRef, type LocalStoreAdapter } from './local-root'
import { BLOB_CHUNK_BYTES, blobIdentity, hashBlob, memoryBlob, verifiedBlob } from './blobs'
import { maxDependencies, maxDocumentBytes, plainChunkBytes } from '../account/protocol'
import { WORKSPACE_BACKUP_LIMITS } from '../interchange/workspace-backup-schema'

interface ManagedRecord { readonly revisionId: string; readonly documentId: string; readonly operationId: string; readonly byteLength: number; readonly chunks: number; readonly sha256: string; readonly dependencies: readonly LocalRecordRef[]; readonly ready: boolean }
interface ManagedChunk { readonly revisionId: string; readonly index: number; readonly bytes: Uint8Array }
export interface GuestManagedReceipt { readonly version: 1; readonly id: string; readonly kind: 'managed-local-commit'; readonly expected?: unknown; readonly target: GuestManagedManifest; readonly recovery?: GuestManagedRecoverySelection }
const INLINE_OPERATION_BYTES = 4 * 1024 * 1024
const READ_WINDOW_CHUNKS = 32
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

// These tables share the coordinator's active row transaction domain
// Staged bodies are inert until the exact immutable descriptors and head CAS commit together
export function createGuestLocalStore(database: GuestCoordinatorDatabase, check: () => void) {
  const records: Table<ManagedRecord, string> = database.table('managedRecords')
  const chunks: Table<ManagedChunk, [string, number]> = database.table('managedChunks')
  const operations: Table<GuestManagedReceipt, string> = database.table('managedOperations')
  const active: Table<{ key: 'active'; manifest: unknown }, string> = database.table('active')
  const staged = new Map<string, { record: ManagedRecord; chunks: readonly ManagedChunk[]; durable: boolean }[]>()
  const observed = new Map<string, { record: ManagedRecord; chunks: Map<number, ManagedChunk> }>()
  const adapter: LocalStoreAdapter = {
    stage: async (operationId, source, dependencies, previous) => {
      check()
      if (source.byteLength > maxDocumentBytes || dependencies.length > maxDependencies) throw new Error('Managed record exceeds bound')
      const ref = { documentId: previous?.documentId ?? crypto.randomUUID(), revisionId: crypto.randomUUID() }
      const rows: ManagedChunk[] = []
      let length = 0, filled = 0
      let buffer = new Uint8Array(BLOB_CHUNK_BYTES)
      const digest = await hashBlob({ byteLength: source.byteLength, async *open() {
        for await (const input of source.open()) {
          check(); length += input.byteLength
          if (length > source.byteLength) throw new Error('Managed source length mismatch')
          for (let at = 0; at < input.byteLength;) {
            const take = Math.min(BLOB_CHUNK_BYTES - filled, input.byteLength - at)
            buffer.set(input.subarray(at, at + take), filled); filled += take; at += take
            if (filled === BLOB_CHUNK_BYTES) { rows.push({ revisionId: ref.revisionId, index: rows.length, bytes: buffer }); buffer = new Uint8Array(BLOB_CHUNK_BYTES); filled = 0 }
          }
          yield input
        }
      } })
      if (filled) rows.push({ revisionId: ref.revisionId, index: rows.length, bytes: buffer.slice(0, filled) })
      if (length !== source.byteLength) throw new Error('Managed source is truncated')
      const record: ManagedRecord = { ...ref, operationId, byteLength: length, chunks: rows.length, sha256: digest, dependencies: dependencies.map(value => ({ ...value })), ready: false }
      const pending = staged.get(operationId) ?? []
      const durable = pending.reduce((sum, value) => sum + (value.durable ? 0 : value.record.byteLength), length) > INLINE_OPERATION_BYTES
      // Small ordinary commands remain private preparation until the single head transaction
      // Bulk overflow can stage inert bytes, but activation still verifies their exact captured values
      if (durable) await database.transaction('rw', records, chunks, async () => { check(); await chunks.bulkAdd(rows); await records.add(record); check() })
      pending.push({ record, chunks: rows, durable }); staged.set(operationId, pending)
      check(); return ref
    },
    read: async ref => {
      check()
      const pending = [...staged.values()].flat().find(value => value.record.revisionId === ref.revisionId)
      const record = pending?.record ?? await records.get(ref.revisionId)
      if (!record || record.documentId !== ref.documentId) throw new Error('Managed record is unavailable')
      check()
      if (!/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('Managed record integrity descriptor is unavailable')
      // Metadata pages and native checkpoints need actual stored-byte integrity as well as schema admission
      return verifiedBlob({ byteLength: record.byteLength, async *open() {
        let length = 0
        for (let offset = 0; offset < record.chunks; offset += READ_WINDOW_CHUNKS) {
          check()
          const end = Math.min(record.chunks, offset + READ_WINDOW_CHUNKS)
          // Group native reads without holding a transaction across hashing, consumers or cancellation
          // Every opening still reads actual bytes, and activation rechecks the exact consumed values
          const rows = pending ? pending.chunks.slice(offset, end) : await database.transaction('r', chunks, async () => {
            check()
            const values = await chunks.bulkGet(Array.from({ length: end - offset }, (_, index) => [ref.revisionId, offset + index] as [string, number]))
            check(); return values
          })
          check()
          for (let index = offset; index < end; index++) {
            check()
            const chunk = rows[index - offset]
            if (!chunk || chunk.bytes.byteLength > BLOB_CHUNK_BYTES) throw new Error('Managed chunk is unavailable')
            length += chunk.bytes.byteLength
            if (length > record.byteLength) throw new Error('Managed chunk length mismatch')
            if (!pending) {
              const capture = observed.get(record.revisionId) ?? { record, chunks: new Map<number, ManagedChunk>() }
              capture.chunks.set(index, { ...chunk, bytes: chunk.bytes.slice() }); observed.set(record.revisionId, capture)
            }
            check(); yield chunk.bytes.slice()
          }
        }
        if (length !== record.byteLength) throw new Error('Managed record is truncated')
        check()
      } }, record.sha256)
    },
  }
  // Evidence pages are bounded independently of the full retained graph
  // Queue only native reads here; hashing outside the transaction avoids holding writers behind crypto
  async function readBounded(ref: LocalRecordRef, limit: number, expected: unknown, assertOwned: () => void, digest?: string): Promise<Uint8Array> {
    const alive = () => { check(); assertOwned() }
    alive()
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > WORKSPACE_BACKUP_LIMITS.payload) throw new Error('Managed read exceeds evidence bound')
    const captured = await database.transaction('r', active, records, chunks, async () => {
      alive()
      const [head, record] = await Promise.all([active.get('active'), records.get(ref.revisionId)])
      alive()
      if (!same(head?.manifest, expected)) throw new Error('The managed workspace changed')
      if (!record || record.documentId !== ref.documentId || record.byteLength > limit || record.byteLength < 0
        || !Number.isSafeInteger(record.byteLength) || record.chunks !== Math.ceil(record.byteLength / BLOB_CHUNK_BYTES)
        || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('Managed record exceeds evidence bound')
      const rows = await chunks.bulkGet(Array.from({ length: record.chunks }, (_, index) => [ref.revisionId, index] as [string, number]))
      alive()
      for (const [index, row] of rows.entries()) if (!row || row.revisionId !== ref.revisionId || row.index !== index
        || row.bytes.byteLength !== Math.min(BLOB_CHUNK_BYTES, record.byteLength - index * BLOB_CHUNK_BYTES)) throw new Error('Managed evidence chunk is unavailable')
      return { record, rows: rows as ManagedChunk[] }
    })
    alive()
    const bytes = new Uint8Array(captured.record.byteLength)
    for (const row of captured.rows) bytes.set(row.bytes, row.index * BLOB_CHUNK_BYTES)
    try {
      // This reader already owns the whole bounded buffer, so native SHA avoids another streamed copy and main-thread WASM pass
      // Cap the native input copy at an existing chunk bound; larger records retain incremental hashing
      const actual = bytes.byteLength <= plainChunkBytes
        ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
        : await hashBlob(memoryBlob(bytes))
      if (actual !== captured.record.sha256 || digest !== undefined && actual !== digest) throw new Error('Managed evidence digest mismatch')
      alive()
      // The publication owner rechecks all consumed descriptors and bytes in its head CAS
      observed.set(ref.revisionId, { record: captured.record, chunks: new Map(captured.rows.map(row => [row.index, row])) })
      return bytes
    } catch (error) { bytes.fill(0); throw error }
  }
  async function assertStoredChunks(captured: readonly ManagedChunk[], message: string): Promise<void> {
    // Queue bounded native requests inside the existing head transaction, without a round trip per chunk
    // Every consumed or durable staged byte still has to match before that same transaction can publish
    for (let offset = 0; offset < captured.length; offset += READ_WINDOW_CHUNKS) {
      check()
      const window = captured.slice(offset, offset + READ_WINDOW_CHUNKS)
      const actual = await chunks.bulkGet(window.map(row => [row.revisionId, row.index] as [string, number]))
      check()
      for (const [index, row] of window.entries()) {
        const stored = actual[index]
        if (!stored || stored.bytes.byteLength !== row.bytes.byteLength || stored.bytes.some((byte, at) => byte !== row.bytes[at])) throw new Error(message)
      }
    }
  }
  async function activate(operationId: string, root: LocalRecordRef, expected: unknown, assertMayActivate: () => void, previous?: AdmittedLocalSnapshot, migration?: GuestManagedMigration, recovery?: GuestManagedRecoverySelection): Promise<GuestManagedReceipt> {
    const pending = staged.get(operationId)
    if (!pending?.some(value => blobIdentity(value.record) === blobIdentity(root))) throw new Error('Managed operation lacks its prepared root')
    const migrations = database.table<GuestManagedMigration, string>('managedMigrations')
    const prior = GuestManagedManifestSchema.safeParse(expected)
    if (previous && (!prior.success || !same(prior.data.root, previous.head))) throw new Error('Managed predecessor admission changed')
    const retained = previous ? admittedLocalReferences(previous, adapter) : new Set<string>()
    // Fresh lineage identity names its immutable origin receipt without scanning ordinary command history
    const target = GuestManagedManifestSchema.parse({ version: 3, id: prior.success ? prior.data.id : migration?.id ?? operationId, revision: prior.success ? prior.data.revision + 1 : migration ? migration.expected.revision + 1 : 0, root, ...(recovery ? { recoveryId: operationId } : prior.success && prior.data.recoveryId ? { recoveryId: prior.data.recoveryId } : {}) })
    const receipt: GuestManagedReceipt = { version: 1, id: operationId, kind: 'managed-local-commit', ...(expected ? { expected } : {}), target, ...(recovery ? { recovery } : {}) }
    if (recovery) { if (migration) throw new Error('A migration cannot rebase recovery'); requireGuestManagedRecoveryReceipt(receipt) }
    const own = new Set(pending.map(value => value.record.revisionId))
    await database.transaction('rw', [active, records, chunks, operations, ...(migration || recovery ? [migrations] : []), ...(recovery ? [database.captures, database.journal] : [])], async () => {
      check(); assertMayActivate()
      if (!same((await active.get('active'))?.manifest, expected)) throw new Error('The managed workspace changed')
      if (migration && (migration.id !== operationId || !same(migration.expected, expected) || !same(await migrations.get(operationId), migration))) throw new Error('Managed migration ownership changed')
      if (recovery) {
        // The selected head, explicit branch baseline and fresh complete capture bind one publication
        // An arbitrary newer capture or receipt from another branch cannot reset the monitor
        const retained = await readManagedRetainedBranches(database, prior.success ? prior.data : GuestManagedManifestSchema.parse(expected))
        const branch = retained.branches.find(value => value.id === recovery.branchId)
        if (!branch || branch.original.id !== recovery.originalCaptureId || branch.capture.id !== recovery.previousCaptureId
          || !guestPlannerValuesEqual(branch.original.participants, recovery.capture.participants) || !guestPlannerValuesEqual(await database.captures.get(recovery.capture.id), recovery.capture)) throw new Error('Managed recovery source association changed')
      }
      const available = new Map(pending.map(value => [value.record.revisionId, value.record]))
      for (const value of pending) {
        if (value.durable && !same(await records.get(value.record.revisionId), value.record)) throw new Error('Managed staging changed')
        if (value.durable) await assertStoredChunks(value.chunks, 'Managed staged bytes changed')
        for (const dependency of value.record.dependencies) {
          if (retained.has(blobIdentity(dependency)) && !observed.has(dependency.revisionId)) continue
          const row = available.get(dependency.revisionId) ?? await records.get(dependency.revisionId)
          if (row) available.set(row.revisionId, row)
          if (!row || row.documentId !== dependency.documentId || !row.ready && !own.has(row.revisionId)) throw new Error('Managed dependency is unavailable')
        }
      }
      // Reads consumed by this head's commands remain guarded even when unrelated old refs are reused
      // Observations clear only after publication, when every competing old-head command loses its CAS
      for (const value of observed.values()) {
        if (!same(await records.get(value.record.revisionId), value.record)) throw new Error('Consumed managed record changed')
        await assertStoredChunks([...value.chunks.values()], 'Consumed managed bytes changed')
      }
      check(); assertMayActivate()
      for (const value of pending) {
        const ready = { ...value.record, ready: true }
        if (value.durable) await records.put(ready)
        else { await chunks.bulkAdd(value.chunks); await records.add(ready) }
      }
      await operations.add(receipt)
      if (migration) await migrations.put({ ...migration, target, phase: 'published' })
      await active.put({ key: 'active', manifest: target })
      check(); assertMayActivate()
    })
    staged.delete(operationId); observed.clear()
    return receipt
  }
  async function flush(operationId: string): Promise<void> {
    // Bulk migration verifies durable staged bytes before it acquires source publication barriers
    for (const value of staged.get(operationId) ?? []) {
      if (value.durable) continue
      await database.transaction('rw', records, chunks, async () => { check(); await chunks.bulkAdd(value.chunks); await records.add(value.record); check() })
      value.durable = true
    }
  }
  return { adapter, activate, flush, readBounded, finishAdmission: () => observed.clear(), receipt: (operationId: string) => operations.get(operationId), async assertCurrent(manifest: GuestManagedManifest) { check(); if (!same((await active.get('active'))?.manifest, manifest)) throw new Error('The managed workspace changed'); check() } }
}
