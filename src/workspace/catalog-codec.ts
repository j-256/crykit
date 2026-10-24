import { z } from 'zod'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import type { CatalogSnapshot } from '../domain/types'
import { immutableCatalogSnapshot } from '../interchange/native'

export const PackagedCatalogPinSchema = z.object({ version: z.literal(1), kind: z.literal('packaged-catalog-pin'), id: z.string(), revisionId: z.string(), checksum: z.string() }).strict()
const pinned = new WeakSet<object>()
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
  if (!exact) return snapshot
  if (snapshot !== exact && !pinned.has(snapshot)) {
    if (!sameCatalogJson(snapshot, exact)) throw new Error('Packaged catalog identity has conflicting contents')
    immutableCatalogSnapshot(snapshot); pinned.add(snapshot)
  }
  return { version: 1, kind: 'packaged-catalog-pin', id: exact.id, revisionId: exact.revisionId, checksum: exact.checksum }
}
export function decodeCatalogPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'packaged-catalog-pin') return value
  const pin = PackagedCatalogPinSchema.parse(value)
  const exact = BUNDLED_CATALOGS.find(snapshot => snapshot.id === pin.id && snapshot.revisionId === pin.revisionId && snapshot.checksum === pin.checksum)
  if (!exact) throw new Error('The exact packaged catalog is unavailable')
  // Portable archives use splitWorkspace's full snapshot, so they survive loss of this package pin
  return exact
}
