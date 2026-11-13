import { jsonRecord } from './crystal-edit'
import { MOD_CATALOG_SCHEMA } from './catalog-schemas'
import type { CatalogEntity, CatalogId, CatalogRevisionId, CatalogSnapshot, DefinitionOrigins } from './types'

export function definitionOrigins(catalog: CatalogSnapshot, entity: CatalogEntity): DefinitionOrigins | undefined {
  if (catalog.schemaVersion === MOD_CATALOG_SCHEMA) {
    if (entity.origins) return entity.origins
    const baseline = jsonRecord(catalog.legacy) ? catalog.legacy.modBaseline : undefined
    if (!jsonRecord(baseline) || typeof baseline.catalogId !== 'string' || typeof baseline.catalogRevisionId !== 'string') return undefined
    // Expanded unchanged records belong to the pinned baseline, never the effective catalog's namespace
    const ref = { kind: 'catalog' as const, catalogId: baseline.catalogId as CatalogId, catalogRevisionId: baseline.catalogRevisionId as CatalogRevisionId, entityId: entity.id }
    return { mechanical: ref, text: ref }
  }
  const ref = { kind: 'catalog' as const, catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entity.id }
  return { mechanical: ref, text: ref }
}
