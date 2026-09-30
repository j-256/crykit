import reviewed from './reviewed-catalogs.json' with { type: 'json' }
import { STARTER_CATALOG } from './starter'
import { validateReviewedCatalogBundle } from '../interchange/correction-promotion'
import { sameCorrectionValue } from '../domain/corrections'
import { assembleBundledCatalog, assembleBundledCatalogV1, assembleBundledCatalogV2 } from './bundled-catalog'
import { addNativeBase } from './native-game'

export const REVIEWED_CATALOG_BUNDLE = validateReviewedCatalogBundle(reviewed)
const revisions = new Map([[JSON.stringify([STARTER_CATALOG.id, STARTER_CATALOG.revisionId]), STARTER_CATALOG]])
export const BUNDLED_V1_CATALOG = assembleBundledCatalogV1(STARTER_CATALOG)
revisions.set(JSON.stringify([BUNDLED_V1_CATALOG.id, BUNDLED_V1_CATALOG.revisionId]), BUNDLED_V1_CATALOG)
export const BUNDLED_V2_CATALOG = assembleBundledCatalogV2(STARTER_CATALOG)
revisions.set(JSON.stringify([BUNDLED_V2_CATALOG.id, BUNDLED_V2_CATALOG.revisionId]), BUNDLED_V2_CATALOG)
const enriched = assembleBundledCatalog(STARTER_CATALOG)
revisions.set(JSON.stringify([enriched.id, enriched.revisionId]), enriched)
const native = addNativeBase(enriched)
revisions.set(JSON.stringify([native.id, native.revisionId]), native)
for (const catalog of REVIEWED_CATALOG_BUNDLE.catalogs) {
  const key = JSON.stringify([catalog.id, catalog.revisionId])
  const previous = revisions.get(key)
  if (previous && !sameCorrectionValue(previous, catalog)) throw new Error('A reviewed catalog attempts to replace an immutable bundled revision')
  revisions.set(key, catalog)
}
export const BUNDLED_CATALOGS = [...revisions.values()]
export const DEFAULT_CATALOG = REVIEWED_CATALOG_BUNDLE.current
  ? revisions.get(JSON.stringify([REVIEWED_CATALOG_BUNDLE.current.catalogId, REVIEWED_CATALOG_BUNDLE.current.revisionId]))!
  : native
