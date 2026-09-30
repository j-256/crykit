import type { CatalogRevisionId, CatalogSnapshot } from '../domain/types'
import { addCrystalEditFacts } from './crystal-edit'
import { addEquipmentExpansionFacts } from './equipment-expansion'
import { addLearnableInnateFacts } from './learnable-innates'
import { addModdingGuideFacts } from './modding-guide'
import { addTravelUnlockDefinitions } from './travel-unlocks'

export const BUNDLED_CATALOG_REVISION_ID = 'bundled-v3' as CatalogRevisionId
export const BUNDLED_CATALOG_CHECKSUM = 'builtin:sha256:5929feca4fe1e57d728318f8c51d2a2a88a7681dbbe6cee48d22d3b667687335'
export const BUNDLED_V2_CATALOG_REVISION_ID = 'bundled-v2' as CatalogRevisionId
export const BUNDLED_V2_CATALOG_CHECKSUM = 'builtin:sha256:2c94c43df4e57b604ce3b0a48e427218155131484d5bee6fde3a2cf14e004308'
export const BUNDLED_V1_CATALOG_REVISION_ID = 'bundled-v1' as CatalogRevisionId
export const BUNDLED_V1_CATALOG_CHECKSUM = 'builtin:sha256:2462b9a438f9be915a7e77b2866be26cb1e8b1e30a76d6f4acb2cf4216906248'

export function assembleBundledCatalogV1(base: CatalogSnapshot): CatalogSnapshot {
  const enriched = addModdingGuideFacts(addCrystalEditFacts(base))
  const legacy = enriched.legacy && typeof enriched.legacy === 'object' && !Array.isArray(enriched.legacy) ? enriched.legacy : {}
  return { ...enriched, revisionId: BUNDLED_V1_CATALOG_REVISION_ID, checksum: BUNDLED_V1_CATALOG_CHECKSUM, legacy: { ...legacy, previousRevisionId: base.revisionId } }
}

export function assembleBundledCatalogV2(base: CatalogSnapshot): CatalogSnapshot {
  const enriched = addLearnableInnateFacts(addEquipmentExpansionFacts(addModdingGuideFacts(addCrystalEditFacts(base))))
  const legacy = enriched.legacy && typeof enriched.legacy === 'object' && !Array.isArray(enriched.legacy) ? enriched.legacy : {}
  return { ...enriched, revisionId: BUNDLED_V2_CATALOG_REVISION_ID, checksum: BUNDLED_V2_CATALOG_CHECKSUM, legacy: { ...legacy, previousRevisionId: BUNDLED_V1_CATALOG_REVISION_ID } }
}

export function assembleBundledCatalog(base: CatalogSnapshot): CatalogSnapshot {
  const previous = assembleBundledCatalogV2(base)
  const enriched = addTravelUnlockDefinitions(previous)
  return { ...enriched, revisionId: BUNDLED_CATALOG_REVISION_ID, checksum: BUNDLED_CATALOG_CHECKSUM, legacy: { ...enriched.legacy as object, previousRevisionId: previous.revisionId } }
}
