import reviewed from './reviewed-catalogs.json' with { type: 'json' }
import { STARTER_CATALOG } from './starter'
import { validateReviewedCatalogBundle } from '../interchange/correction-promotion'
import { sameCorrectionValue } from '../domain/corrections'
import { assembleBundledCatalog } from './bundled-catalog'

export const REVIEWED_CATALOG_BUNDLE = validateReviewedCatalogBundle(reviewed)
const revisions = new Map([[JSON.stringify([STARTER_CATALOG.id, STARTER_CATALOG.revisionId]), STARTER_CATALOG]])
const enriched = assembleBundledCatalog(STARTER_CATALOG)
revisions.set(JSON.stringify([enriched.id, enriched.revisionId]), enriched)
for (const catalog of REVIEWED_CATALOG_BUNDLE.catalogs) {
  const key = JSON.stringify([catalog.id, catalog.revisionId])
  const previous = revisions.get(key)
  if (previous && !sameCorrectionValue(previous, catalog)) throw new Error('A reviewed catalog attempts to replace an immutable bundled revision')
  revisions.set(key, catalog)
}
export const BUNDLED_CATALOGS = [...revisions.values()]
export const DEFAULT_CATALOG = REVIEWED_CATALOG_BUNDLE.current
  ? revisions.get(JSON.stringify([REVIEWED_CATALOG_BUNDLE.current.catalogId, REVIEWED_CATALOG_BUNDLE.current.revisionId]))!
  : enriched
