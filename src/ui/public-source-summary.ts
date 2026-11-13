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
  return [project, revision, origin.kind === 'catalog' ? origin.modelKey : undefined].filter(Boolean).join(' · ')
}

export function publicReceiptContributors(receipt: PublicEntityReceipt): string {
  const origins = receipt.origins
  if (!origins) return receipt.origin ? publicReceiptSourceSummary(receipt.origin) : 'Source identity unavailable'
  const label = (ref: typeof origins.mechanical) => `${publicCatalogLabel(ref.catalogId)} · ${ref.catalogRevisionId} · ${ref.entityId}`
  return JSON.stringify(origins.mechanical) === JSON.stringify(origins.text) ? label(origins.mechanical) : `Mechanics: ${label(origins.mechanical)}; text: ${label(origins.text)}`
}
