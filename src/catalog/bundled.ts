import archive from './legacy-catalog-v1.json' with { type: 'json' }
import vanillaReceipt from './vanilla-catalog-v2.json' with { type: 'json' }
import { unpackJson } from './packed-json'
import { vanillaCatalog } from './vanilla-catalog'
import { immutableCatalogSnapshot } from '../interchange/native'
import type { CatalogSnapshot, EntityId } from '../domain/types'

const historical = unpackJson<{ readonly catalog: CatalogSnapshot; readonly sourceEntityIds: Readonly<Record<string, EntityId>> }>(archive)
export const BUNDLED_CATALOG = immutableCatalogSnapshot(historical.catalog)
export const CURRENT_CATALOG = immutableCatalogSnapshot(vanillaCatalog(vanillaReceipt.checksum))
export const BUNDLED_CATALOGS = [BUNDLED_CATALOG, CURRENT_CATALOG]
// Preserve the historical export for persisted fixtures and catalog-v1 integrations
export const DEFAULT_CATALOG = BUNDLED_CATALOG

export const BUNDLED_SOURCE_ENTITY_IDS: ReadonlyMap<string, EntityId> = new Map(Object.entries(historical.sourceEntityIds))

export function compileBundledSourceId(sourceId: string): EntityId {
  const id = BUNDLED_SOURCE_ENTITY_IDS.get(sourceId)
  if (!id) throw new Error(`Missing bundled source definition: ${sourceId}`)
  return id
}

export function compileBundledSourceBindings<T>(bindings: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  return Object.fromEntries(Object.entries(bindings).flatMap(([sourceId, binding]) => BUNDLED_SOURCE_ENTITY_IDS.has(sourceId) ? [[compileBundledSourceId(sourceId), binding]] : []))
}

export function bundledCatalogForSnapshot(catalog: CatalogSnapshot): CatalogSnapshot | undefined {
  return BUNDLED_CATALOGS.find(snapshot => snapshot.id === catalog.id && snapshot.revisionId === catalog.revisionId && snapshot.checksum === catalog.checksum)
}
