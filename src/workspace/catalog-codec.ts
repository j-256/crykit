import { z } from 'zod'
import { maxDocumentBytes } from '../account/protocol'
import { encodeBackupPage, decodeBackupPage } from '../interchange/workspace-backup-compression'
import { parseBoundedJson, NATIVE_BACKUP_JSON_LIMITS } from '../interchange/json'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import type { CatalogSnapshot } from '../domain/types'
import { immutableCatalogSnapshot, isImmutableCatalogSnapshot } from '../interchange/native'

const SOURCE_PAGE_BYTES = 1024 * 1024
const BASE64_SLICE_BYTES = 32 * 1024
const CompressedCatalogSchema = z.strictObject({ version: z.literal(1), kind: z.literal('compressed-catalog-snapshot'), encoding: z.literal('deflate-json-pages-v1'), byteLength: z.number().int().positive().max(maxDocumentBytes), pages: z.array(z.string().min(1).max(SOURCE_PAGE_BYTES * 2)).min(1).max(Math.ceil(maxDocumentBytes / SOURCE_PAGE_BYTES)) })
type CompressedCatalog = z.infer<typeof CompressedCatalogSchema>
const encodedCatalogs = new WeakMap<CatalogSnapshot, CompressedCatalog>()
function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let at = 0; at < bytes.length; at += BASE64_SLICE_BYTES) binary += String.fromCharCode(...bytes.subarray(at, at + BASE64_SLICE_BYTES))
  return btoa(binary)
}
function unbase64(value: string): Uint8Array {
  const binary = atob(value), bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  if (base64(bytes) !== value) throw new Error('Noncanonical compressed catalog page')
  return bytes
}
const corroborated = new WeakSet<object>()
function sameCatalogJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((value, index) => sameCatalogJson(value, right[index]))
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(right)) return false
  // JSON object order is not content; omitted optional fields and ordered arrays keep their durable meaning
  const entries = Object.entries(left).filter(([, value]) => value !== undefined)
  const other = Object.entries(right).filter(([, value]) => value !== undefined)
  return entries.length === other.length && entries.every(([key, value]) => Object.hasOwn(right, key) && sameCatalogJson(value, (right as Record<string, unknown>)[key]))
}
export function encodeCatalogPayload(snapshot: CatalogSnapshot): unknown {
  const exact = BUNDLED_CATALOGS.find(value => value.id === snapshot.id && value.revisionId === snapshot.revisionId && value.checksum === snapshot.checksum)
  if (exact && snapshot !== exact && !corroborated.has(snapshot)) {
    if (!sameCatalogJson(snapshot, exact)) throw new Error('Packaged catalog identity has conflicting contents')
    immutableCatalogSnapshot(snapshot); corroborated.add(snapshot)
  }
  const cached = isImmutableCatalogSnapshot(snapshot) && encodedCatalogs.get(snapshot)
  if (cached) return cached
  // Every page contains actual source bytes; package removal cannot remove saved definitions
  // The existing bounded canonical compression codec fixes both its interpretation and inflation limits
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot))
  if (bytes.length > maxDocumentBytes) throw new Error('Catalog snapshot exceeds its expanded bound')
  const pages: string[] = []
  for (let at = 0; at < bytes.length; at += SOURCE_PAGE_BYTES) pages.push(base64(encodeBackupPage(bytes.subarray(at, at + SOURCE_PAGE_BYTES))))
  const encoded = CompressedCatalogSchema.parse({ version: 1, kind: 'compressed-catalog-snapshot', encoding: 'deflate-json-pages-v1', byteLength: bytes.length, pages })
  Object.freeze(encoded.pages); Object.freeze(encoded)
  if (isImmutableCatalogSnapshot(snapshot)) encodedCatalogs.set(snapshot, encoded)
  return encoded
}
export function decodeCatalogPayload(value: unknown): unknown {
  if (value && typeof value === 'object' && 'kind' in value && value.kind === 'packaged-catalog-pin') throw new Error('Prelaunch package-only catalog records are unsupported')
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'compressed-catalog-snapshot') return value
  const encoded = CompressedCatalogSchema.parse(value)
  if (encoded.pages.length !== Math.ceil(encoded.byteLength / SOURCE_PAGE_BYTES)) throw new Error('Catalog snapshot page count mismatch')
  // Exact compressed byte equality permits reuse of a packaged object, never a package-only read
  // The self-contained decoder below remains authoritative when the package no longer has that body
  for (const snapshot of BUNDLED_CATALOGS) {
    const known = encodedCatalogs.get(snapshot)
    if (known && encoded.byteLength === known.byteLength && encoded.pages.length === known.pages.length && encoded.pages.every((page, index) => page === known.pages[index])) return snapshot
  }
  const chunks = encoded.pages.map((page, index) => {
    const bytes = decodeBackupPage(unbase64(page))
    if (bytes.length !== Math.min(SOURCE_PAGE_BYTES, encoded.byteLength - index * SOURCE_PAGE_BYTES)) throw new Error('Catalog snapshot page length mismatch')
    return bytes
  })
  const bytes = new Uint8Array(encoded.byteLength)
  for (const [index, chunk] of chunks.entries()) bytes.set(chunk, index * SOURCE_PAGE_BYTES)
  const snapshot = immutableCatalogSnapshot(parseBoundedJson(bytes, 'catalog snapshot', NATIVE_BACKUP_JSON_LIMITS) as unknown as CatalogSnapshot)
  Object.freeze(encoded.pages); Object.freeze(encoded)
  encodedCatalogs.set(snapshot, encoded)
  return snapshot
}
