import reviewed from './reviewed-catalogs.json' with { type: 'json' }
import { STARTER_CATALOG } from './starter'
import { validateReviewedCatalogBundle } from '../interchange/correction-promotion'
import { sameCorrectionValue } from '../domain/corrections'
import { assembleBundledCatalog } from './bundled-catalog'
import { addNativeBase } from './native-game'
import { assembleCertaintyCatalog } from './certainty-catalog'
import { immutableCatalogSnapshot } from '../interchange/native'

export const REVIEWED_CATALOG_BUNDLE = validateReviewedCatalogBundle(reviewed)
export const BUNDLED_CATALOG = assembleCertaintyCatalog(addNativeBase(assembleBundledCatalog(STARTER_CATALOG)))
const revisions = new Map([[JSON.stringify([BUNDLED_CATALOG.id, BUNDLED_CATALOG.revisionId]), BUNDLED_CATALOG]])
for (const catalog of REVIEWED_CATALOG_BUNDLE.catalogs) {
  const key = JSON.stringify([catalog.id, catalog.revisionId])
  const previous = revisions.get(key)
  if (previous && !sameCorrectionValue(previous, catalog)) throw new Error('A reviewed catalog attempts to replace an immutable bundled revision')
  revisions.set(key, catalog)
}
export const BUNDLED_CATALOGS = [...revisions.values()].map(immutableCatalogSnapshot)
export const DEFAULT_CATALOG = REVIEWED_CATALOG_BUNDLE.current
  ? revisions.get(JSON.stringify([REVIEWED_CATALOG_BUNDLE.current.catalogId, REVIEWED_CATALOG_BUNDLE.current.revisionId]))!
  : BUNDLED_CATALOG
