import type { CatalogRef, CatalogSnapshot } from './types'
import { fulfillSource } from './source-fulfillment'

export function catalogSource(catalogs: readonly CatalogSnapshot[], target: CatalogRef) {
  const catalog = fulfillSource(target, catalogs)?.catalog
  const entity = catalog && Object.hasOwn(catalog.entities, target.entityId) ? catalog.entities[target.entityId] : undefined
  return catalog && entity ? { catalog, entity, claims: catalog.claims.filter(claim => claim.entityId === target.entityId) } : undefined
}
