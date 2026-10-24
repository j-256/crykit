import type { Page } from '@playwright/test'
import { maxDocumentBytes } from '../src/account/protocol'
import { guestPlannerValuesEqual } from '../src/persistence/guest-planner-equality'
import { BLOB_CHUNK_BYTES, memoryBlob, verifiedBlob } from '../src/workspace/blobs'
import type { BlobSource, WorkspaceState } from '../src/workspace/documents'
import { GuestManagedManifestSchema } from '../src/workspace/guest-managed-contract'
import { admitLocalRoot, type LocalRecordRef, type LocalStoreAdapter } from '../src/workspace/local-root'

const GUEST_COORDINATOR_NAME = 'crykit-guest-coordinator-v1'

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
    const captured = await page.evaluate(({ name, ref, byteLimit, chunkBytes }) => new Promise<{ selected: unknown; record: { documentId: string; revisionId: string; byteLength: number; chunks: number; sha256: string }; chunks: Uint8Array[] }>((resolve, reject) => {
      const open = indexedDB.open(name)
      open.onupgradeneeded = () => open.transaction?.abort()
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const database = open.result
        let transaction: IDBTransaction
        try { transaction = database.transaction(['active', 'managedRecords', 'managedChunks'], 'readonly') }
        catch (error) { database.close(); reject(error); return }
        const selected = transaction.objectStore('active').get('active')
        const record = transaction.objectStore('managedRecords').get(ref.revisionId)
        const chunks: IDBRequest[] = []
        let failure: Error | undefined
        record.onsuccess = () => {
          const value = record.result
          if (!value || value.documentId !== ref.documentId || value.revisionId !== ref.revisionId || value.ready !== true
            || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > byteLimit
            || value.chunks !== Math.ceil(value.byteLength / chunkBytes) || !/^[a-f0-9]{64}$/.test(value.sha256)) {
            failure = new Error('The selected managed test record is unavailable or invalid'); transaction.abort(); return
          }
          for (let index = 0; index < value.chunks; index++) chunks.push(transaction.objectStore('managedChunks').get([ref.revisionId, index]))
        }
        transaction.oncomplete = () => {
          database.close()
          if (chunks.some((chunk, index) => !chunk.result || chunk.result.revisionId !== ref.revisionId || chunk.result.index !== index
            || chunk.result.bytes?.byteLength !== Math.min(chunkBytes, record.result.byteLength - index * chunkBytes))) { reject(new Error('The selected managed test chunks are incomplete')); return }
          resolve({ selected: selected.result?.manifest, record: record.result, chunks: chunks.map(chunk => chunk.result.bytes) })
        }
        transaction.onabort = () => { database.close(); reject(failure ?? transaction.error) }
      }
    }), { name: GUEST_COORDINATOR_NAME, ref, byteLimit: maxDocumentBytes, chunkBytes: BLOB_CHUNK_BYTES })
    check()
    if (!guestPlannerValuesEqual(captured.selected, expected)) throw new Error('The selected guest changed during inspection')
    const bytes = new Uint8Array(captured.record.byteLength)
    captured.chunks.forEach((chunk, index) => bytes.set(chunk, index * BLOB_CHUNK_BYTES))
    return verifiedBlob(memoryBlob(bytes), captured.record.sha256)
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
