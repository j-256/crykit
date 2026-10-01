const BUNDLED_CATALOG_ID = 'crystal-project-public-starter'
const BUNDLED_CATALOG_REVISION_ID = 'catalog-v1'

export function referencePath(entityId: string, catalogId = BUNDLED_CATALOG_ID, catalogRevisionId = BUNDLED_CATALOG_REVISION_ID): string {
  const entityPath = entityId.split(':').map(encodeURIComponent).join('/')
  return `/#/reference/catalog/${encodeURIComponent(catalogId)}/revisions/${encodeURIComponent(catalogRevisionId)}/entities/${entityPath}`
}
