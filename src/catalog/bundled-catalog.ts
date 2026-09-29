import type { CatalogRevisionId, CatalogSnapshot } from '../domain/types'
import { addCrystalEditFacts } from './crystal-edit'
import { addModdingGuideFacts } from './modding-guide'

export const BUNDLED_CATALOG_REVISION_ID = 'bundled-v1' as CatalogRevisionId
export const BUNDLED_CATALOG_CHECKSUM = 'builtin:sha256:92e50dcd977f84d5a8b5d48df3f08b3969f183b08b4a4046c0720cdcadbc39b2'

export function assembleBundledCatalog(base: CatalogSnapshot): CatalogSnapshot {
  const enriched = addModdingGuideFacts(addCrystalEditFacts(base))
  const legacy = enriched.legacy && typeof enriched.legacy === 'object' && !Array.isArray(enriched.legacy) ? enriched.legacy : {}
  return { ...enriched, revisionId: BUNDLED_CATALOG_REVISION_ID, checksum: BUNDLED_CATALOG_CHECKSUM, legacy: { ...legacy, previousRevisionId: base.revisionId } }
}
