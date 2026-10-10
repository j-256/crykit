import receipts from '../catalog/withdrawn-catalogs.json' with { type: 'json' }
import type { CatalogSnapshot, ModCatalogPin } from './types'

export const WITHDRAWN_CATALOGS = receipts.catalogs as unknown as readonly Pick<CatalogSnapshot, 'id' | 'revisionId' | 'checksum'>[]

// The source-key migration targets the original bundled revision, independently of the fresh-profile default
const originalBundle = WITHDRAWN_CATALOGS.find(receipt => receipt.id === 'crystal-project-public-starter' && receipt.revisionId === 'catalog-v1')
if (!originalBundle) throw new Error('The historical bundled catalog receipt is missing')
export const HISTORICAL_BUNDLED_CATALOG = originalBundle

// These receipts identify removed bytes, not replacement definitions with the same revision
// Saved references retain their original identity; withdrawal receipts alone do not supply definitions
export function withdrawnCatalog(pin: Pick<ModCatalogPin, 'catalogId' | 'catalogRevisionId'>) {
  return WITHDRAWN_CATALOGS.find(receipt => receipt.id === pin.catalogId && receipt.revisionId === pin.catalogRevisionId)
}

export function withdrawnCatalogKey(key: string): boolean {
  return WITHDRAWN_CATALOGS.some(receipt => JSON.stringify([receipt.id, receipt.revisionId]) === key)
}
