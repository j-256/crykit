import { MODDING_GUIDE_SOURCE } from './modding-guide'
import { referenceSupplements } from './reference-supplements'
import { compileCatalogIdentities } from '../domain/catalog-identities'
import { formatCatalogSourceId } from '../domain/source-identity'
import supplementalIds from './supplemental-entity-ids.json' with { type: 'json' }
import type { CatalogRevisionId, CatalogSnapshot } from '../domain/types'

export const GUIDE_CATALOG_ID = formatCatalogSourceId({ game: 'crystal-project', origin: 'guide', key: 'modding' })
export const GUIDE_CATALOG_REVISION_ID = 'v1' as CatalogRevisionId

export function guideCatalog(checksum: string): CatalogSnapshot {
  const { importedAt: _acquiredAt, legacy: _mixedSourceMetadata, ...source } = referenceSupplements('guide')
  return { ...compileCatalogIdentities({ ...source, id: GUIDE_CATALOG_ID, revisionId: GUIDE_CATALOG_REVISION_ID, schemaVersion: 'guide-source-1', rights: { state: 'unknown', reason: 'The community guide retains its own source terms', sources: [MODDING_GUIDE_SOURCE] }, applicability: { state: 'known', value: 'Attributed community modding reference; these descriptions do not establish native calculation behavior' } }, supplementalIds.ids), checksum }
}
