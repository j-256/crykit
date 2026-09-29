import type { CatalogRevisionId, CatalogSnapshot } from '../domain/types'
import { addCrystalEditFacts } from './crystal-edit'
import { addModdingGuideFacts } from './modding-guide'

export const BUNDLED_CATALOG_REVISION_ID = 'bundled-v1' as CatalogRevisionId
export const BUNDLED_CATALOG_CHECKSUM = 'builtin:sha256:98bcf994af501fc44dfbdc9b1f0a97d96a1e6d84229efe62e4462b25d1bd48a0'

export function assembleBundledCatalog(base: CatalogSnapshot): CatalogSnapshot {
  const enriched = addModdingGuideFacts(addCrystalEditFacts(base))
  const legacy = enriched.legacy && typeof enriched.legacy === 'object' && !Array.isArray(enriched.legacy) ? enriched.legacy : {}
  return { ...enriched, revisionId: BUNDLED_CATALOG_REVISION_ID, checksum: BUNDLED_CATALOG_CHECKSUM, legacy: { ...legacy, previousRevisionId: base.revisionId } }
}
