import { formatEntityRefPath } from '../src/ui/navigation'
import type { CatalogRef } from '../src/domain/types'

const BUNDLED_CATALOG_ID = 'crystal-project-public-starter'
const BUNDLED_CATALOG_REVISION_ID = 'catalog-v1'

export function referencePath(entityId: string, catalogId = BUNDLED_CATALOG_ID, catalogRevisionId = BUNDLED_CATALOG_REVISION_ID): string {
  const ref = { kind: 'catalog', catalogId, catalogRevisionId, entityId } as CatalogRef
  return `/#/reference/${formatEntityRefPath(ref)}`
}

export function referenceUrlPattern(entityId: string): RegExp {
  const path = referencePath(entityId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${path}(?:\\?|$)`)
}
