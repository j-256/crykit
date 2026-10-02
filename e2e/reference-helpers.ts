import { bundledEntityRouteName, entityRouteSlug } from '../src/ui/entity-route-names'
import type { CatalogRef } from '../src/domain/types'

const BUNDLED_CATALOG_ID = 'crystal-project-public-starter'
const BUNDLED_CATALOG_REVISION_ID = 'catalog-v1'

export function referencePath(entityId: string, catalogId = BUNDLED_CATALOG_ID, catalogRevisionId = BUNDLED_CATALOG_REVISION_ID): string {
  const ref = { kind: 'catalog', catalogId, catalogRevisionId, entityId } as CatalogRef
  const entityPath = entityId.split(':').map(encodeURIComponent).join('/')
  const slug = entityRouteSlug(bundledEntityRouteName(ref))
  return `/#/reference/catalog/${encodeURIComponent(catalogId)}/revisions/${encodeURIComponent(catalogRevisionId)}/entities/${entityPath}/${encodeURIComponent(slug)}`
}
