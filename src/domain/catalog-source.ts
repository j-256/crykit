import type { CatalogRef, CatalogSnapshot } from './types'

export function catalogSource(catalogs: readonly CatalogSnapshot[], target: CatalogRef) {
  const catalog = catalogs.find(entry => entry.id === target.catalogId && entry.revisionId === target.catalogRevisionId)
  const entity = catalog && Object.hasOwn(catalog.entities, target.entityId) ? catalog.entities[target.entityId] : undefined
  return catalog && entity ? { catalog, entity, claims: catalog.claims.filter(claim => claim.entityId === target.entityId) } : undefined
}
