import { checkpointContentDigest } from './checkpoint-identity'
import { fulfillSource } from './source-fulfillment'
import type { CatalogSnapshot, ModComposition } from './types'

export function sourceCompositionDigest(composition: ModComposition, catalogs: readonly CatalogSnapshot[]): string {
  const sources = [composition.baseline, ...composition.layers].map(pin => {
    const catalog = fulfillSource(pin, catalogs)?.catalog
    if (!catalog) throw new Error('A composition requires every pinned source snapshot')
    return { catalogId: pin.catalogId, catalogRevisionId: pin.catalogRevisionId, checksum: catalog.checksum, ...(catalog.payloadSource ? { payloadSource: catalog.payloadSource } : {}) }
  })
  // Layer order, disabled pins, links, mappings, and complete payload receipts all affect the saved composition
  return checkpointContentDigest({ version: 1, composition, sources })
}
