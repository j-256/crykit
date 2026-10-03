import { STARTER_CATALOG } from './starter'
import { assembleBundledCatalog } from './bundled-catalog'
import { addNativeBase } from './native-game'
import { assembleSourceCatalog } from './certainty-catalog'
import { immutableCatalogSnapshot } from '../interchange/native'
import { compileCatalogIdentities, compiledEntityId } from '../domain/catalog-identities'
import supplementalIds from './supplemental-entity-ids.json' with { type: 'json' }
import type { EntityId } from '../domain/types'
import { catalogEntity } from '../domain/entity-identities'

const sourceCatalog = assembleSourceCatalog(addNativeBase(assembleBundledCatalog(STARTER_CATALOG)))
export const BUNDLED_CATALOG = immutableCatalogSnapshot(compileCatalogIdentities(sourceCatalog, supplementalIds.ids))
export const BUNDLED_CATALOGS = [BUNDLED_CATALOG]
export const DEFAULT_CATALOG = BUNDLED_CATALOG

export function compileBundledSourceId(sourceId: string): EntityId {
  const source = catalogEntity(sourceCatalog, sourceId)
  if (!source) throw new Error(`Missing bundled source definition: ${sourceId}`)
  return compiledEntityId(source, supplementalIds.ids)
}

export function compileBundledSourceBindings<T>(bindings: Readonly<Record<string, T>>): Readonly<Record<string, T>> {
  return Object.fromEntries(Object.entries(bindings).flatMap(([sourceId, binding]) => catalogEntity(sourceCatalog, sourceId) ? [[compileBundledSourceId(sourceId), binding]] : []))
}
