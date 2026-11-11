import { STARTER_CATALOG_ID } from '../catalog/catalog-ids'
import type { PublicEntityReceipt } from '../interchange/public-share-schema'

// Display labels do not change exact catalog identities in saved links and receipts
export function publicCatalogLabel(id: string): string {
  return id === STARTER_CATALOG_ID ? 'Crystal Project' : id
}

export function publicReceiptSourceSummary(origin: NonNullable<PublicEntityReceipt['origin']>): string {
  const project = origin.kind === 'catalog' ? publicCatalogLabel(origin.projectId) : origin.projectId
  const revision = origin.sourceRevisionId === origin.catalogRevisionId
    ? origin.sourceRevisionId
    : `Source ${origin.sourceRevisionId} · Catalog ${origin.catalogRevisionId}`
  return [project, revision, origin.modelKey].filter(Boolean).join(' · ')
}
