import type { BlobSource, WorkspaceBlobRef } from './file-types'
import { WorkspaceError } from './repository'
import { getSodium } from '../account/crypto/sodium'
import { sha256Hex } from '../account/crypto/sha256'
import { plainChunkBytes } from '../account/protocol'

export const BLOB_CHUNK_BYTES = 64 * 1024
// Bound native digest materialization to the same memory unit as revision transport
const NATIVE_HASH_BYTES = plainChunkBytes
function canBufferNativeHash(source: BlobSource): boolean { return typeof crypto !== 'undefined' && !!crypto.subtle && source.byteLength <= NATIVE_HASH_BYTES }
export function blobIdentity(ref: Pick<WorkspaceBlobRef, 'documentId' | 'revisionId'>): string { return JSON.stringify([ref.documentId, ref.revisionId]) }
export function memoryBlob(bytes: Uint8Array): BlobSource {
  const owned = bytes.slice()
  return { byteLength: owned.byteLength, async *open() { for (let at = 0; at < owned.byteLength; at += BLOB_CHUNK_BYTES) yield owned.slice(at, at + BLOB_CHUNK_BYTES) } }
}
export async function hashBlob(source: BlobSource): Promise<string> {
  // Materialize only bounded metadata; large sources retain incremental hashing and backpressure
  if (canBufferNativeHash(source)) {
    const buffer = new Uint8Array(source.byteLength)
    let length = 0
    try {
      for await (const chunk of source.open()) {
        if (chunk.length > buffer.length - length) throw new Error('Trailing blob bytes')
        buffer.set(chunk, length); length += chunk.length
      }
      if (length !== source.byteLength) throw new Error('Truncated blob bytes')
      return await sha256Hex(buffer)
    } finally { buffer.fill(0) }
  }
  const sodium = await getSodium()
  const state = sodium.crypto_hash_sha256_init()
  let finalized = false
  let length = 0
  try {
    for await (const chunk of source.open()) {
      length += chunk.length
      if (length > source.byteLength) throw new Error('Trailing blob bytes')
      sodium.crypto_hash_sha256_update(state, chunk)
    }
    if (length !== source.byteLength) throw new Error('Truncated blob bytes')
    const hash = sodium.crypto_hash_sha256_final(state, 'hex')
    finalized = true
    return hash
  } finally {
    // The pinned wrapper frees SHA state on final; an interrupted scan must release it itself
    if (!finalized) {
      const raw = (sodium as unknown as { libsodium: { HEAPU8: Uint8Array; _crypto_hash_sha256_statebytes(): number; _free(address: number): void } }).libsodium
      const address = state as unknown as number
      raw.HEAPU8.fill(0, address, address + raw._crypto_hash_sha256_statebytes()); raw._free(address)
    }
  }
}
export async function readBlob(source: BlobSource, limit: number, exact = true): Promise<Uint8Array> {
  if (source.byteLength > limit) throw new WorkspaceError('LOCAL_MATERIALIZATION_LIMIT', 'This operation requires a streamed full-workspace backup.')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for await (const chunk of source.open()) {
      length += chunk.byteLength
      if (length > limit || length > source.byteLength) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'The blob length does not match.')
      chunks.push(chunk.slice())
    }
    if (exact && length !== source.byteLength) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'The blob is truncated.')
    const result = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
    return result
  } finally { for (const chunk of chunks) chunk.fill(0) }
}

// Verification completes before a collecting consumer can return the bytes
// Streaming consumers must abort their destination if iteration fails at EOF
export function verifiedBlob(source: BlobSource, digest: string): BlobSource {
  return { byteLength: source.byteLength, async *open() {
    if (canBufferNativeHash(source)) {
      const buffer = new Uint8Array(source.byteLength)
      let length = 0
      try {
        for await (const bytes of source.open()) {
          if (bytes.length > buffer.length - length) throw new Error('Verified blob length mismatch')
          // Preserve source chunk boundaries and hash before-consumer bytes, even if a consumer mutates its view
          buffer.set(bytes, length); length += bytes.length
          yield bytes
        }
        if (length !== source.byteLength) throw new Error('Verified blob is truncated')
        if (await sha256Hex(buffer) !== digest) throw new Error('Verified blob digest mismatch')
      } finally { buffer.fill(0) }
      return
    }
    const sodium = await getSodium(), state = sodium.crypto_hash_sha256_init()
    let finalized = false, length = 0
    try {
      for await (const bytes of source.open()) {
        length += bytes.byteLength
        if (length > source.byteLength) throw new Error('Verified blob length mismatch')
        sodium.crypto_hash_sha256_update(state, bytes)
        yield bytes
      }
      if (length !== source.byteLength) throw new Error('Verified blob is truncated')
      const actual = sodium.crypto_hash_sha256_final(state, 'hex'); finalized = true
      if (actual !== digest) throw new Error('Verified blob digest mismatch')
    } finally {
      if (!finalized) {
        const raw = (sodium as unknown as { libsodium: { HEAPU8: Uint8Array; _crypto_hash_sha256_statebytes(): number; _free(address: number): void } }).libsodium
        const address = state as unknown as number
        raw.HEAPU8.fill(0, address, address + raw._crypto_hash_sha256_statebytes()); raw._free(address)
      }
    }
  } }
}
