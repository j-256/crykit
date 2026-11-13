import guideEntityIds from './guide-source-entity-ids.json' with { type: 'json' }
import sourceEntityIds from './bundled-source-entity-ids.json' with { type: 'json' }
import vanillaReceipt from './vanilla-current.json' with { type: 'json' }
import vanillaPacked from './vanilla-current.packed.json' with { type: 'json' }
import guideReceipt from './guide-modding-current.json' with { type: 'json' }
import guidePacked from './guide-modding-current.packed.json' with { type: 'json' }
import { unpackJson } from './packed-json'
import { immutableCatalogSnapshot } from '../interchange/native'
import type { CatalogSnapshot, EntityId } from '../domain/types'

export const CURRENT_CATALOG = immutableCatalogSnapshot(unpackJson<CatalogSnapshot>(vanillaPacked))
if (CURRENT_CATALOG.checksum !== vanillaReceipt.checksum) throw new Error('The generated vanilla catalog does not match its checksum receipt')
export const GUIDE_CATALOG = immutableCatalogSnapshot(unpackJson<CatalogSnapshot>(guidePacked))
if (GUIDE_CATALOG.checksum !== guideReceipt.checksum) throw new Error('The generated guide catalog does not match its checksum receipt')
// Stable immutable membership lets native validation reuse this exact catalog lookup
export const BUNDLED_CATALOGS = Object.freeze([CURRENT_CATALOG, GUIDE_CATALOG])
export const DEFAULT_CATALOG = CURRENT_CATALOG
export const BUNDLED_CATALOG = CURRENT_CATALOG

export function preferredStarterCatalog(catalogs: readonly CatalogSnapshot[]): CatalogSnapshot | undefined {
  // New defaults choose the packaged revision explicitly; saved references resolve their own exact pins
  return catalogs.find(catalog => catalog.id === CURRENT_CATALOG.id && catalog.revisionId === CURRENT_CATALOG.revisionId)
}

export const BUNDLED_SOURCE_ENTITY_IDS: ReadonlyMap<string, EntityId> = new Map(Object.entries(sourceEntityIds) as [string, EntityId][])

export const GUIDE_SOURCE_ENTITY_IDS: ReadonlyMap<string, EntityId> = new Map(Object.entries(guideEntityIds) as [string, EntityId][])

export function compileGuideSourceId(sourceId: string): EntityId {
  const id = GUIDE_SOURCE_ENTITY_IDS.get(sourceId)
  if (!id) throw new Error(`Missing guide source definition: ${sourceId}`)
  return id
}

export function compileGuideSourceBindings<T>(bindings: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  return Object.fromEntries(Object.entries(bindings).flatMap(([sourceId, binding]) => GUIDE_SOURCE_ENTITY_IDS.has(sourceId) ? [[compileGuideSourceId(sourceId), binding]] : []))
}

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
