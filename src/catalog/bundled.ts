import archive from './legacy-catalog-v1.json' with { type: 'json' }
import previousVanillaReceipt from './vanilla-catalog-v2.json' with { type: 'json' }
import previousVanillaPacked from './vanilla-catalog-v2.packed.json' with { type: 'json' }
import vanillaReceipt from './vanilla-catalog-v3.json' with { type: 'json' }
import vanillaPacked from './vanilla-catalog-v3.packed.json' with { type: 'json' }
import { unpackJson } from './packed-json'
import { immutableCatalogSnapshot } from '../interchange/native'
import type { CatalogSnapshot, EntityId } from '../domain/types'

const historical = unpackJson<{ readonly catalog: CatalogSnapshot; readonly sourceEntityIds: Readonly<Record<string, EntityId>> }>(archive)
export const BUNDLED_CATALOG = immutableCatalogSnapshot(historical.catalog)
// Keep the exact prior base snapshot so saved catalog-v2 pins and links remain resolvable
export const PREVIOUS_CATALOG = immutableCatalogSnapshot(unpackJson<CatalogSnapshot>(previousVanillaPacked))
if (PREVIOUS_CATALOG.checksum !== previousVanillaReceipt.checksum) throw new Error('The previous vanilla catalog does not match its checksum receipt')
export const CURRENT_CATALOG = immutableCatalogSnapshot(unpackJson<CatalogSnapshot>(vanillaPacked))
if (CURRENT_CATALOG.checksum !== vanillaReceipt.checksum) throw new Error('The generated vanilla catalog does not match its checksum receipt')
export const BUNDLED_CATALOGS = [BUNDLED_CATALOG, PREVIOUS_CATALOG, CURRENT_CATALOG]
// Preserve the historical export for persisted fixtures and catalog-v1 integrations
export const DEFAULT_CATALOG = BUNDLED_CATALOG

export function preferredStarterCatalog(catalogs: readonly CatalogSnapshot[]): CatalogSnapshot | undefined {
  // Imported historical revisions may precede the current bundled revision in catalog lists
  return catalogs.find(catalog => catalog.id === CURRENT_CATALOG.id && catalog.revisionId === CURRENT_CATALOG.revisionId)
    ?? catalogs.find(catalog => catalog.id === CURRENT_CATALOG.id)
}

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
