import type { Page } from '@playwright/test'
import { maxDocumentBytes } from '../src/account/protocol'
import { guestPlannerValuesEqual } from '../src/persistence/guest-planner-equality'
import { BLOB_CHUNK_BYTES, memoryBlob, verifiedBlob } from '../src/workspace/blobs'
import type { BlobSource, WorkspaceState } from '../src/workspace/documents'
import { GuestManagedManifestSchema } from '../src/workspace/guest-managed-contract'
import { admitLocalRoot, type LocalRecordRef, type LocalStoreAdapter } from '../src/workspace/local-root'

const GUEST_COORDINATOR_NAME = 'crykit-guest-coordinator-v1'
const READ_BATCH_RECORDS = 32
const READ_BATCH_BYTES = 1024 * 1024
interface CapturedRecord {
  record: { documentId: string; revisionId: string; byteLength: number; chunks: number; sha256: string }
  chunks: Uint8Array[]
}

async function selectedManifest(page: Page): Promise<unknown> {
  return page.evaluate(async name => {
    if (!(await indexedDB.databases()).some(database => database.name === name)) return undefined
    return new Promise<unknown>((resolve, reject) => {
      const open = indexedDB.open(name)
      open.onupgradeneeded = () => open.transaction?.abort()
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const database = open.result
        let transaction: IDBTransaction
        try { transaction = database.transaction('active', 'readonly') }
        catch (error) { database.close(); reject(error); return }
        const selected = transaction.objectStore('active').get('active')
        transaction.oncomplete = () => { database.close(); resolve(selected.result?.manifest) }
        transaction.onabort = () => { database.close(); reject(transaction.error) }
      }
    })
  }, GUEST_COORDINATOR_NAME)
}

// A managed guest has no separately writable planner database
// Decode its actual selected immutable root rather than inspecting a retained ancestor or adding an app test API
export async function readManagedGuestWorkspace(page: Page, inspect?: (state: WorkspaceState) => Promise<void>): Promise<WorkspaceState | undefined> {
  const expected = await selectedManifest(page)
  const version = expected && typeof expected === 'object' ? (expected as { version?: unknown }).version : undefined
  if (expected === undefined || version === 1 || version === 2) return undefined
  const manifest = GuestManagedManifestSchema.parse(expected), origin = new URL(page.url()).origin
  const check = () => { if (page.isClosed() || new URL(page.url()).origin !== origin) throw new Error('The captured test page changed') }
  const assertCurrent = async () => { check(); if (!guestPlannerValuesEqual(await selectedManifest(page), expected)) throw new Error('The selected guest changed during inspection'); check() }
  // Repeated frame decoding shares only this inspection's exact captured bytes, with head checks before and after admission
  const reads = new Map<string, Promise<BlobSource>>()
  const read = async (ref: LocalRecordRef): Promise<BlobSource> => {
    check()
    const captured = await page.evaluate(({ name, ref, byteLimit, chunkBytes, batchRecords, batchBytes }) => new Promise<{ selected: unknown; records: CapturedRecord[] }>((resolve, reject) => {
      const open = indexedDB.open(name)
      open.onupgradeneeded = () => open.transaction?.abort()
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const database = open.result
        let transaction: IDBTransaction
        try { transaction = database.transaction(['active', 'managedRecords', 'managedChunks'], 'readonly') }
        catch (error) { database.close(); reject(error); return }
        const selected = transaction.objectStore('active').get('active')
        let failure: Error | undefined
        let bytes = 0
        const scheduled = new Set<string>()
        const records: { ref: typeof ref; required: boolean; record: IDBRequest; chunks: IDBRequest[] }[] = []
        const capture = (target: typeof ref, required = false) => {
          const key = JSON.stringify([target.documentId, target.revisionId])
          if (scheduled.has(key) || !required && scheduled.size >= batchRecords) return
          scheduled.add(key)
          const record = transaction.objectStore('managedRecords').get(target.revisionId)
          record.onsuccess = () => {
            const value = record.result
            if (!value || value.documentId !== target.documentId || value.revisionId !== target.revisionId || value.ready !== true
              || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > byteLimit
              || value.chunks !== Math.ceil(value.byteLength / chunkBytes) || !/^[a-f0-9]{64}$/.test(value.sha256)) {
              if (required) { failure = new Error('The selected managed test record is unavailable or invalid'); transaction.abort() }
              return
            }
            if (!required && bytes + value.byteLength > batchBytes) return
            bytes += value.byteLength
            const entry = { ref: target, required, record, chunks: [] as IDBRequest[] }
            records.push(entry)
            for (let index = 0; index < value.chunks; index++) entry.chunks.push(transaction.objectStore('managedChunks').get([target.revisionId, index]))
            // Declared edges are bounded read hints; the payload decoder independently proves every actual dependency
            // Missing or invalid hints cannot invalidate unrelated retained storage or supply a successful admission
            if (bytes < batchBytes && Array.isArray(value.dependencies)) for (const dependency of value.dependencies.slice(0, batchRecords)) {
              if (dependency && typeof dependency.documentId === 'string' && dependency.documentId && typeof dependency.revisionId === 'string' && dependency.revisionId) capture({ documentId: dependency.documentId, revisionId: dependency.revisionId })
            }
          }
        }
        capture(ref, true)
        transaction.oncomplete = () => {
          database.close()
          const complete: CapturedRecord[] = []
          for (const { ref: target, required, record, chunks } of records) {
            if (chunks.some((chunk, index) => !chunk.result || chunk.result.revisionId !== target.revisionId || chunk.result.index !== index
              || chunk.result.bytes?.byteLength !== Math.min(chunkBytes, record.result.byteLength - index * chunkBytes))) {
              if (required) { reject(new Error('The selected managed test chunks are incomplete')); return }
              continue
            }
            const { documentId, revisionId, byteLength, chunks: count, sha256 } = record.result
            complete.push({ record: { documentId, revisionId, byteLength, chunks: count, sha256 }, chunks: chunks.map(chunk => chunk.result.bytes) })
          }
          resolve({ selected: selected.result?.manifest, records: complete })
        }
        transaction.onabort = () => { database.close(); reject(failure ?? transaction.error) }
      }
    }), { name: GUEST_COORDINATOR_NAME, ref, byteLimit: maxDocumentBytes, chunkBytes: BLOB_CHUNK_BYTES, batchRecords: READ_BATCH_RECORDS, batchBytes: READ_BATCH_BYTES })
    check()
    if (!guestPlannerValuesEqual(captured.selected, expected)) throw new Error('The selected guest changed during inspection')
    let requested: BlobSource | undefined
    for (const { record, chunks } of captured.records) {
      const bytes = new Uint8Array(record.byteLength)
      chunks.forEach((chunk, index) => bytes.set(chunk, index * BLOB_CHUNK_BYTES))
      const source = verifiedBlob(memoryBlob(bytes), record.sha256), key = JSON.stringify([record.documentId, record.revisionId])
      if (record.documentId === ref.documentId && record.revisionId === ref.revisionId) requested = source
      else if (!reads.has(key)) reads.set(key, Promise.resolve(source))
    }
    if (!requested) throw new Error('The selected managed test record is unavailable or invalid')
    return requested
  }
  const adapter: LocalStoreAdapter = {
    read(ref) {
      const key = JSON.stringify([ref.documentId, ref.revisionId])
      let pending = reads.get(key)
      if (!pending) { pending = read(ref); reads.set(key, pending) }
      return pending
    },
    stage: async () => { throw new Error('The test planner reader is read-only') },
  }
  await assertCurrent()
  const snapshot = await admitLocalRoot(adapter, manifest.root, { check, assertCurrent })
  // Related read-only assertions can share this admission, inside its final selected-head check
  // Never reuse the captured bytes across later application actions or another inspection
  await inspect?.(snapshot.state)
  await assertCurrent()
  return snapshot.state
}

export async function readManagedGuestPlanner(page: Page): Promise<WorkspaceState['planner'] | undefined> {
  return (await readManagedGuestWorkspace(page))?.planner
}
