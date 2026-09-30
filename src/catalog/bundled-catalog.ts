import type { CatalogRevisionId, CatalogSnapshot } from '../domain/types'
import { addCrystalEditFacts } from './crystal-edit'
import { addEquipmentExpansionFacts } from './equipment-expansion'
import { addLearnableInnateFacts } from './learnable-innates'
import { addModdingGuideFacts } from './modding-guide'

export const BUNDLED_CATALOG_REVISION_ID = 'bundled-v2' as CatalogRevisionId
export const BUNDLED_CATALOG_CHECKSUM = 'builtin:sha256:97a70b4a22fdb516fccb7f135f0ed43edfaa30bcf732076447bdd78fd1d1c947'
export const BUNDLED_V1_CATALOG_REVISION_ID = 'bundled-v1' as CatalogRevisionId
export const BUNDLED_V1_CATALOG_CHECKSUM = 'builtin:sha256:2462b9a438f9be915a7e77b2866be26cb1e8b1e30a76d6f4acb2cf4216906248'

export function assembleBundledCatalogV1(base: CatalogSnapshot): CatalogSnapshot {
  const enriched = addModdingGuideFacts(addCrystalEditFacts(base))
  const legacy = enriched.legacy && typeof enriched.legacy === 'object' && !Array.isArray(enriched.legacy) ? enriched.legacy : {}
  return { ...enriched, revisionId: BUNDLED_V1_CATALOG_REVISION_ID, checksum: BUNDLED_V1_CATALOG_CHECKSUM, legacy: { ...legacy, previousRevisionId: base.revisionId } }
}

export function assembleBundledCatalog(base: CatalogSnapshot): CatalogSnapshot {
  const enriched = addLearnableInnateFacts(addEquipmentExpansionFacts(addModdingGuideFacts(addCrystalEditFacts(base))))
  const legacy = enriched.legacy && typeof enriched.legacy === 'object' && !Array.isArray(enriched.legacy) ? enriched.legacy : {}
  return { ...enriched, revisionId: BUNDLED_CATALOG_REVISION_ID, checksum: BUNDLED_CATALOG_CHECKSUM, legacy: { ...legacy, previousRevisionId: base.revisionId } }
}
