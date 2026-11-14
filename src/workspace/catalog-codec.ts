import { z } from 'zod'
import { maxDocumentBytes } from '../account/protocol'
import { encodeBackupPage, decodeBackupPage } from '../interchange/workspace-backup-compression'
import { parseBoundedJson, NATIVE_BACKUP_JSON_LIMITS } from '../interchange/json'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import type { CatalogSnapshot } from '../domain/types'
import { immutableCatalogSnapshot, isImmutableCatalogSnapshot } from '../interchange/native'

const SOURCE_PAGE_BYTES = 1024 * 1024
const BASE64_SLICE_BYTES = 32 * 1024
const BASE64_GROUP_CHARACTERS = 4
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_PADDING_MASKS = [0, 0b11, 0b1111] as const
// Validate every encoded page before any inflation, including unused bits in padded final symbols
// A malformed tail must not make the reader inflate and recompress all preceding source pages
const EncodedCatalogPageSchema = z.string().min(1).max(SOURCE_PAGE_BYTES * 2).regex(/^[A-Za-z0-9+/]*={0,2}$/).refine(value => {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const last = BASE64_ALPHABET.indexOf(value.at(-padding - 1) ?? '=')
  return value.length % BASE64_GROUP_CHARACTERS === 0 && last >= 0 && (last & BASE64_PADDING_MASKS[padding]) === 0
}, 'Noncanonical compressed catalog page')
const CompressedCatalogSchema = z.strictObject({ version: z.literal(1), kind: z.literal('compressed-catalog-snapshot'), encoding: z.literal('deflate-json-pages-v1'), byteLength: z.number().int().positive().max(maxDocumentBytes), pages: z.array(EncodedCatalogPageSchema).min(1).max(Math.ceil(maxDocumentBytes / SOURCE_PAGE_BYTES)) })
type CompressedCatalog = z.infer<typeof CompressedCatalogSchema>
const encodedCatalogs = new WeakMap<CatalogSnapshot, CompressedCatalog>()
const DECODED_CATALOG_CACHE_LIMIT = 16
// Bound the lookup handles without keeping retired catalog bodies alive
const decodedCatalogs: WeakRef<CatalogSnapshot>[] = []
function sameEncodedCatalog(left: CompressedCatalog, right: CompressedCatalog): boolean {
  return left.byteLength === right.byteLength && left.pages.length === right.pages.length && left.pages.every((page, index) => page === right.pages[index])
}
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
export function encodeCatalogPayload(snapshot: CatalogSnapshot): CompressedCatalog {
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
    // Cold starts have no prior writer; computing the canonical bytes avoids inflating and readmitting the same body
    const known = encodedCatalogs.get(snapshot) ?? encodeCatalogPayload(snapshot)
    if (sameEncodedCatalog(encoded, known)) return snapshot
  }
  // Repeated roots and history can share an immutable decoded body only after comparing every encoded byte
  // Each storage read still owns authentication and current-root/profile checks; this cache grants none
  for (let index = decodedCatalogs.length - 1; index >= 0; index--) {
    const snapshot = decodedCatalogs[index]!.deref()
    if (!snapshot) { decodedCatalogs.splice(index, 1); continue }
    const known = encodedCatalogs.get(snapshot)
    if (known && sameEncodedCatalog(encoded, known)) return snapshot
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
  decodedCatalogs.push(new WeakRef(snapshot))
  if (decodedCatalogs.length > DECODED_CATALOG_CACHE_LIMIT) decodedCatalogs.shift()
  return snapshot
}
