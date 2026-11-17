import { SYNTHETIC_RETAINED_CATALOG } from '../domain/retained-catalog.test-helpers'
import { checkpointContentDigest } from '../domain/checkpoint-identity'
import { immutableCatalogSnapshot } from '../interchange/native'

// Only isolated writer tests declare this distinct source in their module's bundle membership
// The production bundle and the separate unlisted retained fixture never acquire that authority
const { checksum: _checksum, ...retained } = SYNTHETIC_RETAINED_CATALOG
const content = { ...retained, id: 'crystal-project/guide/synthetic-packaged-source' as typeof retained.id }
export const SYNTHETIC_PACKAGED_CATALOG = immutableCatalogSnapshot({ ...content, checksum: `builtin:sha256:${checkpointContentDigest(content)}` })
