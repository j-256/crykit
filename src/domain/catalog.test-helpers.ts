import type { CatalogId, CatalogRef, CatalogRevisionId, EntityId } from './types'

// Rule-only fixtures own their definitions and do not need to load a gameplay catalog
export const TEST_CATALOG_ID = 'synthetic-test-catalog' as CatalogId
export const TEST_CATALOG_REVISION_ID = 'synthetic-test-revision' as CatalogRevisionId

export function testCatalogRef(id: string): CatalogRef {
  return { kind: 'catalog', catalogId: TEST_CATALOG_ID, catalogRevisionId: TEST_CATALOG_REVISION_ID, entityId: id as EntityId }
}
