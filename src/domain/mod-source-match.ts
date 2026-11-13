import { jsonRecord } from './crystal-edit'
import { CRYSTAL_EDIT_CATALOG_SCHEMA } from './mod-layers'
import { fulfillSource, sourcePayloadValid } from './source-fulfillment'
import type { CatalogSnapshot, ModSourceReceipt } from './types'

export function modSourceMatch(receipt: ModSourceReceipt, catalog: CatalogSnapshot): 'payload' | undefined {
  if (catalog.schemaVersion !== CRYSTAL_EDIT_CATALOG_SCHEMA || !sourcePayloadValid(catalog)) return undefined
  const fulfilled = fulfillSource(receipt, [catalog])?.catalog
  if (!fulfilled || receipt.checksum !== fulfilled.checksum) return undefined
  if (receipt.contentFingerprint && (!jsonRecord(fulfilled.legacy) || receipt.contentFingerprint !== fulfilled.legacy.contentFingerprint)) return undefined
  return 'payload'
}
