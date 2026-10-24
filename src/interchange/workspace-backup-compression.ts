import { deflateSync, Inflate } from 'fflate'
import { WORKSPACE_BACKUP_LIMITS } from './workspace-backup-schema'

const LENGTH_BYTES = 4
const DEFLATE_LEVEL = 6
const COMPRESSED_INPUT_SLICE = 4 * 1024

// Canonical raw DEFLATE from pinned fflate at level 6 is part of token codec v1
// Dependency upgrades must preserve these bytes or retain a versioned v1 decoder
export function encodeBackupPage(bytes: Uint8Array): Uint8Array {
  if (!bytes.length || bytes.length > WORKSPACE_BACKUP_LIMITS.payload) throw new Error('Backup metadata page exceeds its expanded bound')
  const compressed = deflateSync(bytes, { level: DEFLATE_LEVEL })
  const result = new Uint8Array(LENGTH_BYTES + compressed.length)
  new DataView(result.buffer).setUint32(0, bytes.length, true)
  result.set(compressed, LENGTH_BYTES)
  return result
}
export function decodeBackupPage(page: Uint8Array): Uint8Array {
  if (page.length <= LENGTH_BYTES || page.length > WORKSPACE_BACKUP_LIMITS.payload) throw new Error('Invalid compressed backup page bound')
  const length = new DataView(page.buffer, page.byteOffset, LENGTH_BYTES).getUint32(0, true)
  if (!length || length > WORKSPACE_BACKUP_LIMITS.payload) throw new Error('Backup metadata page exceeds its expanded bound')
  const output = new Uint8Array(length)
  let offset = 0
  // Bounded batches amortize inflater history-window copies while retaining early overflow rejection
  // Stop overflow before consuming later compressed input
  // A fixed inflateSync output alone would silently truncate oversized plaintext
  const inflater = new Inflate((bytes: Uint8Array) => {
    if (bytes.length > length - offset) throw new Error('Backup metadata expanded length exceeds its declaration')
    output.set(bytes, offset); offset += bytes.length
  })
  for (let at = LENGTH_BYTES; at < page.length; at += COMPRESSED_INPUT_SLICE) inflater.push(page.subarray(at, at + COMPRESSED_INPUT_SLICE), at + COMPRESSED_INPUT_SLICE >= page.length)
  if (offset !== length) throw new Error('Backup metadata expanded length mismatch')
  // fflate accepts some trailing raw-deflate input; canonical byte equality closes that ambiguity
  const canonical = encodeBackupPage(output)
  if (canonical.length !== page.length || canonical.some((byte, index) => byte !== page[index])) throw new Error('Noncanonical or trailing compressed backup page')
  return output
}
