import { z } from 'zod'
import { parseBoundedJson, NATIVE_BACKUP_JSON_LIMITS } from '../interchange/json'
import { maxDocumentBytes } from '../account/protocol'
import { INDEX_PAGE_BYTES } from './directory'
import { WORKSPACE_DOCUMENT_KINDS, isBlobSource, type WorkspaceDocument } from './documents'
import type { BlobSource } from './file-types'
import { memoryBlob } from './blobs'

const MAGIC = new TextEncoder().encode('CRYKIT-DOC/1\n')
const metadataSchema = z.object({ version: z.literal(1), kind: z.enum(WORKSPACE_DOCUMENT_KINDS), key: z.string().min(1), encoding: z.enum(['json', 'bytes']), byteLength: z.number().int().nonnegative().max(maxDocumentBytes) }).strict()
type Metadata = z.infer<typeof metadataSchema>
const utf8 = new TextEncoder()

async function* framedBody(source: BlobSource, expected?: Metadata, onMetadata?: (metadata: Metadata) => void): AsyncGenerator<Uint8Array, Metadata> {
  const iterator = source.open()[Symbol.asyncIterator]()
  let chunk: Uint8Array = new Uint8Array(0)
  let offset = 0
  let total = 0
  const next = async () => {
    const result = await iterator.next()
    if (result.done) return false
    if (!(result.value instanceof Uint8Array)) throw new Error('Invalid frame chunk')
    chunk = result.value; offset = 0; total += chunk.length
    if (total > source.byteLength) throw new Error('Trailing frame bytes')
    return true
  }
  const exact = async (size: number) => {
    const bytes = new Uint8Array(size)
    let at = 0
    while (at < size) {
      if (offset === chunk.length && !await next()) throw new Error('Truncated document frame')
      const count = Math.min(size - at, chunk.length - offset)
      bytes.set(chunk.subarray(offset, offset + count), at); offset += count; at += count
    }
    return bytes
  }
  try {
    const magic = await exact(MAGIC.length)
    if (magic.some((byte, index) => byte !== MAGIC[index])) throw new Error('Unsupported document frame version')
    const length = await exact(4), metadataLength = new DataView(length.buffer).getUint32(0, true)
    if (metadataLength > INDEX_PAGE_BYTES) throw new Error('Document frame metadata exceeds bound')
    const metadataBytes = await exact(metadataLength)
    const metadata = metadataSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes)))
    if (expected && JSON.stringify(metadata) !== JSON.stringify(expected)) throw new Error('Frame source changed')
    if (source.byteLength !== MAGIC.length + 4 + metadataLength + metadata.byteLength) throw new Error('Document frame length mismatch')
    onMetadata?.(metadata)
    let remaining = metadata.byteLength
    while (remaining) {
      if (offset === chunk.length && !await next()) throw new Error('Truncated document body')
      const count = Math.min(remaining, chunk.length - offset)
      yield chunk.subarray(offset, offset + count)
      offset += count; remaining -= count
    }
    if (offset !== chunk.length) throw new Error('Trailing document body')
    while (await next()) if (chunk.length) throw new Error('Trailing document body')
    if (total !== source.byteLength) throw new Error('Truncated document frame')
    return metadata
  } finally { await iterator.return?.() }
}

export function workspaceDocumentSource(document: WorkspaceDocument): BlobSource {
  const binary = isBlobSource(document.value)
  const source = binary ? document.value as BlobSource : memoryBlob(utf8.encode(JSON.stringify(document.value)))
  const metadata = metadataSchema.parse({ version: document.version, kind: document.kind, key: document.key, encoding: binary ? 'bytes' : 'json', byteLength: source.byteLength })
  const bytes = utf8.encode(JSON.stringify(metadata))
  if (bytes.length > INDEX_PAGE_BYTES) throw new Error('Document frame metadata exceeds bound')
  const length = new Uint8Array(4); new DataView(length.buffer).setUint32(0, bytes.length, true)
  return { byteLength: MAGIC.length + length.length + bytes.length + source.byteLength, async *open() {
    yield MAGIC.slice(); yield length; yield bytes
    let received = 0
    for await (const part of source.open()) { received += part.length; if (received > source.byteLength) throw new Error('Trailing source body'); yield part }
    if (received !== source.byteLength) throw new Error('Truncated source body')
  } }
}
export function encodeWorkspaceDocument(document: WorkspaceDocument): AsyncIterable<Uint8Array> { return workspaceDocumentSource(document).open() }

export async function decodeWorkspaceDocument(source: BlobSource, onFrameVerified?: () => void): Promise<WorkspaceDocument> {
  // Complete the authenticated frame observation before exposing a reusable body capability
  // JSON already needs a bounded complete body, so copy it during this scan instead of
  // reopening and decrypting the same frame; binary bodies stay lazy and check EOF on reuse
  let json: Uint8Array | undefined, offset = 0, complete = false
  const scan = framedBody(source, undefined, metadata => { if (metadata.encoding === 'json') json = new Uint8Array(metadata.byteLength) })
  try {
    let step = await scan.next()
    while (!step.done) {
      // Account streams clear delivered plaintext on advance, so retain only an owned JSON copy
      if (json) { json.set(step.value, offset); offset += step.value.length }
      step = await scan.next()
    }
    complete = true
    // EOF completes the source's integrity checks; parsing has not started at this diagnostic boundary
    onFrameVerified?.()
    const metadata = step.value
    const body: BlobSource = { byteLength: metadata.byteLength, open: () => framedBody(source, metadata) }
    const value = json ? parseBoundedJson(json, 'workspace document', NATIVE_BACKUP_JSON_LIMITS) : body
    return { version: 1, kind: metadata.kind, key: metadata.key, value }
  } finally { json?.fill(0); if (!complete) await scan.return(undefined as never) }
}

// A captured immutable binary header can be checked during one consumption pass
// The owning store must still authenticate the actual frame bytes on every open
export function capturedWorkspaceBody(source: BlobSource, expected: { readonly key: string; readonly kind: WorkspaceDocument['kind']; readonly byteLength: number }): BlobSource {
  const metadata: Metadata = { version: 1, kind: expected.kind, key: expected.key, encoding: 'bytes', byteLength: expected.byteLength }
  return { byteLength: expected.byteLength, open: () => framedBody(source, metadata) }
}
