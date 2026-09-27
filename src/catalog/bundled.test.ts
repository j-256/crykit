import { describe, expect, it } from 'vitest'
import { BUNDLED_CATALOGS, DEFAULT_CATALOG, REVIEWED_CATALOG_BUNDLE } from './bundled'
import { STARTER_CATALOG } from './starter'
import { verifyReviewedCatalogChecksums } from '../interchange/correction-promotion'

describe('shipped reviewed catalogs', () => {
  it('retains the original source snapshot and verifies every promoted checksum', async () => {
    expect(BUNDLED_CATALOGS).toContainEqual(STARTER_CATALOG)
    expect(BUNDLED_CATALOGS).toContainEqual(DEFAULT_CATALOG)
    await expect(verifyReviewedCatalogChecksums(REVIEWED_CATALOG_BUNDLE)).resolves.toBeUndefined()
  })
})
