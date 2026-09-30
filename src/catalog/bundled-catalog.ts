import type { CatalogRevisionId, CatalogSnapshot } from '../domain/types'
import { addCrystalEditFacts } from './crystal-edit'
import { addModdingGuideFacts } from './modding-guide'
import { addTravelUnlockDefinitions } from './travel-unlocks'

export const BUNDLED_CATALOG_REVISION_ID = 'bundled-v2' as CatalogRevisionId
export const BUNDLED_CATALOG_CHECKSUM = 'builtin:sha256:65ba218cde80dc18d5fb39ec46a04331ff7622fcd4decd1c1491f297194c7bf4'

export function assemblePreviousBundledCatalog(base: CatalogSnapshot): CatalogSnapshot {
  const enriched = addModdingGuideFacts(addCrystalEditFacts(base))
  const legacy = enriched.legacy && typeof enriched.legacy === 'object' && !Array.isArray(enriched.legacy) ? enriched.legacy : {}
  return { ...enriched, revisionId: 'bundled-v1' as CatalogRevisionId, checksum: 'builtin:sha256:2462b9a438f9be915a7e77b2866be26cb1e8b1e30a76d6f4acb2cf4216906248', legacy: { ...legacy, previousRevisionId: base.revisionId } }
}

export function assembleBundledCatalog(base: CatalogSnapshot): CatalogSnapshot {
  const previous = assemblePreviousBundledCatalog(base)
  const enriched = addTravelUnlockDefinitions(previous)
  return { ...enriched, revisionId: BUNDLED_CATALOG_REVISION_ID, checksum: BUNDLED_CATALOG_CHECKSUM, legacy: { ...enriched.legacy as object, previousRevisionId: previous.revisionId } }
}
