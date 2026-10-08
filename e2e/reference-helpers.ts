import { formatEntityRefPath } from '../src/ui/navigation'
import { CURRENT_CATALOG } from '../src/catalog/bundled'
import type { CatalogRef } from '../src/domain/types'

const BUNDLED_CATALOG_ID = 'crystal-project-public-starter'
const BUNDLED_CATALOG_REVISION_ID = CURRENT_CATALOG.revisionId

export function referencePath(entityId: string, catalogId = BUNDLED_CATALOG_ID, catalogRevisionId: string = BUNDLED_CATALOG_REVISION_ID, name?: string): string {
  const ref = { kind: 'catalog', catalogId, catalogRevisionId, entityId } as CatalogRef
  return `/#/reference/${formatEntityRefPath(ref, name === undefined ? undefined : () => name)}`
}

export function referenceUrlPattern(entityId: string): RegExp {
  const path = referencePath(entityId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const vanilla = currentReferencePath(entityId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:${path}|${vanilla})(?:\\?|$)`)
}

export function currentReferencePath(entityId: string): string {
  return referencePath(entityId, BUNDLED_CATALOG_ID, CURRENT_CATALOG.revisionId)
}
