import { checkpointContentDigest } from './checkpoint-identity'
import { immutableCatalogSnapshot } from '../interchange/native'
import type { CatalogSnapshot } from './types'

// This complete synthetic source is deliberately absent from packaged receipts
// Persistence fixtures need a distinct retained body, not an alias for the active gameplay catalog
const content: Omit<CatalogSnapshot, 'checksum'> = {
  id: 'crystal-project/guide/synthetic-retained-source' as CatalogSnapshot['id'],
  revisionId: 'v1' as CatalogSnapshot['revisionId'],
  schemaVersion: 'synthetic-retained-catalog-1',
  applicability: { state: 'unknown', reason: 'Synthetic fixture; no gameplay applicability' },
  rights: { state: 'known', value: 'Synthetic test definitions' },
  entities: {
    'synthetic:class:1': {
      id: 'synthetic:class:1' as CatalogSnapshot['entities'][string]['id'],
      kind: 'class', name: 'Synthetic retained class', aliases: [], sources: [],
      fields: { description: { state: 'unknown', reason: 'Intentionally unrecorded' } },
    },
  },
  claims: [],
}
export const SYNTHETIC_RETAINED_CATALOG = immutableCatalogSnapshot({ ...content, checksum: `builtin:sha256:${checkpointContentDigest(content)}` })
