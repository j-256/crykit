import Dexie, { type Table } from 'dexie'
import type { BlobSource } from './file-types'
import { WORKSPACE_BACKUP_LIMITS, WorkspaceBackupError } from '../interchange/workspace-backup-schema'

const CIPHERTEXT_READ_BATCH_CHUNKS = 4
const STAGING_WRITE_BATCH_BYTES = 1024 * 1024
const STAGING_WRITE_BATCH_CHUNKS = 64

interface StagedChunk { document: number; index: number; nonce: Uint8Array; ciphertext: ArrayBuffer }

class BackupStagingDatabase extends Dexie {
  chunks!: Table<StagedChunk, [number, number]>
  constructor(name: string) { super(name); this.version(1).stores({ chunks: '[document+index], document' }) }
}
export async function createBackupStaging(signal?: AbortSignal) {
  const database = new BackupStagingDatabase(`crykit-backup-staging-${crypto.randomUUID()}`)
  let key: CryptoKey | undefined = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  let disposed = false
  let opening: Promise<unknown> | undefined
  let disposal: Promise<void> | undefined
  const check = () => { signal?.throwIfAborted(); if (disposed || !key) throw new WorkspaceBackupError('BACKUP_DISPOSED', 'This backup reader has been released. Select the backup again.') }
  const aad = (document: number, index: number) => new TextEncoder().encode(JSON.stringify([1, database.name, document, index]))
  // Abort revokes access immediately, but every cleanup owner awaits the same deletion
  // Waiting for open prevents a cancelled initialization from recreating its database
  const dispose = (): Promise<void> => {
    if (disposal) return disposal
    disposed = true; key = undefined; signal?.removeEventListener('abort', abort)
    disposal = (async () => { await opening?.catch(() => {}); await database.delete() })()
    return disposal
  }
  const abort = () => { void dispose().catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  try { check(); opening = database.open(); await opening; check() } catch (error) { await dispose(); throw error }
  const encrypt = async (document: number, index: number, bytes: Uint8Array): Promise<StagedChunk> => {
    check()
    if (bytes.length > WORKSPACE_BACKUP_LIMITS.payload) throw new Error('Backup staging chunk exceeds bound')
    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(document, index) }, key!, bytes.slice().buffer)
    check()
    return { document, index, nonce, ciphertext }
  }
  // Each serialized producer owns its batch; pending rows contain ciphertext only
  // Flush before exposing a completed document so validation never races buffered writes
  const bufferedWriter = () => {
    let rows: StagedChunk[] = []
    let batchBytes = 0
    const flush = async () => {
      check()
      if (!rows.length) return
      await database.chunks.bulkAdd(rows); check()
      rows = []; batchBytes = 0
    }
    return {
      async write(document: number, index: number, bytes: Uint8Array) {
        // Encrypt before advancing borrowed readers, which may clear their yielded bytes
        const row = await encrypt(document, index, bytes)
        if (batchBytes + row.ciphertext.byteLength > STAGING_WRITE_BATCH_BYTES) await flush()
        rows.push(row); batchBytes += row.ciphertext.byteLength
        if (batchBytes >= STAGING_WRITE_BATCH_BYTES || rows.length >= STAGING_WRITE_BATCH_CHUNKS) await flush()
      },
      flush,
    }
  }
  const staging = {
    dispose,
    bufferedWriter,
    async write(document: number, index: number, bytes: Uint8Array) {
      const row = await encrypt(document, index, bytes)
      check(); await database.chunks.add(row); check()
    },
    // Complete-source staging acknowledges only after every row is durable
    // Batch ciphertext rather than joining plaintext pages: historical metadata identities and token framing depend on their exact boundaries
    async stage(document: number, input: BlobSource): Promise<BlobSource> {
      let count = 0, length = 0
      const writer = bufferedWriter()
      check()
      for await (const chunk of input.open()) {
        check(); length += chunk.length
        if (length > input.byteLength) throw new Error('Backup source length mismatch')
        for (let offset = 0; offset < chunk.length; offset += WORKSPACE_BACKUP_LIMITS.payload) {
          await writer.write(document, count++, chunk.subarray(offset, offset + WORKSPACE_BACKUP_LIMITS.payload))
        }
      }
      check()
      if (length !== input.byteLength) throw new Error('Backup source length mismatch')
      await writer.flush()
      return staging.source(document, count, length)
    },
    source(document: number, count: number, byteLength: number): BlobSource {
      return { byteLength, async *open() {
        check(); let length = 0
        // Append-only rows let bounded ciphertext batches share one read transaction
        // Decryption and disposal checks stay per chunk so suspended readers cannot retain extra plaintext
        for (let start = 0; start < count; start += CIPHERTEXT_READ_BATCH_CHUNKS) {
          const size = Math.min(CIPHERTEXT_READ_BATCH_CHUNKS, count - start)
          const rows = await database.chunks.bulkGet(Array.from({ length: size }, (_, offset) => [document, start + offset] as [number, number])); check()
          for (let offset = 0; offset < size; offset++) {
            check()
            const index = start + offset, row = rows[offset]
            if (!row || row.document !== document || row.index !== index) throw new Error('Incomplete encrypted backup staging')
            const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.nonce.slice(), additionalData: aad(document, index) }, key!, row.ciphertext))
            try { check(); length += plaintext.length; if (length > byteLength) throw new Error('Trailing backup staging bytes'); yield plaintext } finally { plaintext.fill(0) }
          }
        }
        check(); if (length !== byteLength || await database.chunks.get([document, count])) throw new Error('Backup staging length mismatch')
      } }
    },
  }
  return staging
}
