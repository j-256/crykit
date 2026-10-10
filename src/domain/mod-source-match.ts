import { jsonRecord } from './crystal-edit'
import { CRYSTAL_EDIT_CATALOG_SCHEMA } from './mod-layers'
import type { CatalogSnapshot, ModSourceReceipt } from './types'

export function modSourceMatch(receipt: ModSourceReceipt, catalog: CatalogSnapshot): 'bytes' | 'content' | undefined {
  if (catalog.schemaVersion !== CRYSTAL_EDIT_CATALOG_SCHEMA || receipt.catalogId !== catalog.id) return undefined
  if (receipt.checksum === catalog.checksum) return 'bytes'
  if (receipt.contentFingerprint && jsonRecord(catalog.legacy) && receipt.contentFingerprint === catalog.legacy.contentFingerprint) return 'content'
  return undefined
}

export function modSourceInterpretationMatches(receipt: ModSourceReceipt, catalog: CatalogSnapshot): boolean {
  // Library v4 adds content receipts; its planning projection is unchanged from v3
  // Older projections retain their own pins even when source content matches
  const interpretation = (revision: string) => revision.split(':').slice(-2).join(':').replace(/:library-v4$/, ':library-v3')
  return Boolean(modSourceMatch(receipt, catalog)) && interpretation(receipt.catalogRevisionId) === interpretation(catalog.revisionId)
}
