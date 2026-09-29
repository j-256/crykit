import type { CatalogRevisionId, CatalogSnapshot } from '../domain/types'
import { addCrystalEditFacts } from './crystal-edit'
import { addModdingGuideFacts } from './modding-guide'

export const BUNDLED_CATALOG_REVISION_ID = 'bundled-v1' as CatalogRevisionId
export const BUNDLED_CATALOG_CHECKSUM = 'builtin:sha256:abab286f37606a0d61ba5ea5d5bb86a0e79f62e2afe14dbe13aefd4dded1bfb4'

export function assembleBundledCatalog(base: CatalogSnapshot): CatalogSnapshot {
  const enriched = addModdingGuideFacts(addCrystalEditFacts(base))
  const legacy = enriched.legacy && typeof enriched.legacy === 'object' && !Array.isArray(enriched.legacy) ? enriched.legacy : {}
  return { ...enriched, revisionId: BUNDLED_CATALOG_REVISION_ID, checksum: BUNDLED_CATALOG_CHECKSUM, legacy: { ...legacy, previousRevisionId: base.revisionId } }
}
