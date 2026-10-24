import type { JsonValue } from '../domain/types'
import { hashBlob, memoryBlob } from './blobs'

export const RECOVERY_FALLBACK_BYTES = 8 * 1024 * 1024
const RECOVERY_METADATA_BYTES = 2 * 1024 * 1024
const RECOVERY_CHUNK_BYTES = 48 * 1024
const encoder = new TextEncoder()
interface RecoveryByteIdentity { readonly byteLength: number; readonly sha256: string }
export interface SaveRecoveryCopy {
  readonly filename: string
  readonly original: RecoveryByteIdentity
  readonly working: RecoveryByteIdentity
  readonly originalBytes: Uint8Array
  readonly workingBytes: Uint8Array
  readonly storedPending: JsonValue
  readonly livePending: JsonValue
}
export interface SaveRecoverySink { write(bytes: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }
const record = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`)
async function identity(bytes: Uint8Array): Promise<RecoveryByteIdentity> { return { byteLength: bytes.length, sha256: await hashBlob(memoryBlob(bytes)) } }
export async function* recoveryCopyChunks(copy: SaveRecoveryCopy): AsyncGenerator<Uint8Array> {
  const stored = record(copy.storedPending), live = record(copy.livePending)
  if (stored.length + live.length > RECOVERY_METADATA_BYTES) throw new Error('The unfinished recovery input exceeds the export limit. Keep this tab open.')
  for (const kind of ['original', 'working'] as const) {
    const bytes = copy[`${kind}Bytes`], expected = copy[kind]
    if (bytes.length !== expected.byteLength || await hashBlob(memoryBlob(bytes)) !== expected.sha256) throw new Error('Recovery bytes do not match the exact saved result')
  }
  // This envelope has no repository handles or operational blob references and is never import authority
  const header = record({ format: 'crykit-save-recovery', version: 1, filename: copy.filename, original: copy.original, working: copy.working, storedPending: copy.storedPending, livePending: copy.livePending, pendingIntegrity: { stored: await identity(stored), live: await identity(live) } })
  if (header.length > RECOVERY_METADATA_BYTES) throw new Error('The recovery metadata exceeds the export limit. Keep this tab open.')
  yield header
  for (const kind of ['original', 'working'] as const) {
    const bytes = copy[`${kind}Bytes`]
    for (let offset = 0; offset < bytes.length; offset += RECOVERY_CHUNK_BYTES) {
      let binary = ''
      for (const byte of bytes.subarray(offset, offset + RECOVERY_CHUNK_BYTES)) binary += String.fromCharCode(byte)
      yield record({ kind, offset, base64: btoa(binary) })
    }
  }
  // Missing end records expose interrupted streams without interpreting a partial copy as complete
  yield record({ kind: 'end' })
}
export async function writeRecoveryCopy(copy: SaveRecoveryCopy, sink: SaveRecoverySink, assertCurrent: () => void): Promise<void> {
  try {
    for await (const bytes of recoveryCopyChunks(copy)) { assertCurrent(); await sink.write(bytes); assertCurrent() }
    assertCurrent(); await sink.close(); assertCurrent()
  } catch (error) { try { await sink.abort() } catch { /* Preserve the export failure if sink cleanup also fails */ } throw error }
}
export async function collectRecoveryCopy(copy: SaveRecoveryCopy, assertCurrent: () => void = () => {}): Promise<Uint8Array> {
  // Reject large byte streams before base64 encoding or aggregate allocation in browsers without a streamed sink
  if (Math.ceil((copy.originalBytes.length + copy.workingBytes.length) * 4 / 3) > RECOVERY_FALLBACK_BYTES) throw new Error('Use a browser with streamed file saving for this recovery copy. Keep this tab open.')
  const chunks: Uint8Array[] = []
  let length = 0
  for await (const bytes of recoveryCopyChunks(copy)) {
    assertCurrent(); length += bytes.length
    if (length > RECOVERY_FALLBACK_BYTES) throw new Error('Use a browser with streamed file saving for this recovery copy. Keep this tab open.')
    chunks.push(bytes)
  }
  assertCurrent()
  const result = new Uint8Array(length)
  let offset = 0
  for (const bytes of chunks) { result.set(bytes, offset); offset += bytes.length }
  return result
}
