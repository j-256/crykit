import { addNativeBase } from './native-game'
import { referenceSupplements } from './reference-supplements'
import { projectSourceCatalog, reconcileNativeSourceIdentities } from './source-catalog'
import { compileCatalogIdentities } from '../domain/catalog-identities'
import supplementalIds from './supplemental-entity-ids.json' with { type: 'json' }
import type { CatalogRevisionId, CatalogSnapshot } from '../domain/types'

export const VANILLA_CATALOG_REVISION_ID = 'catalog-v2' as CatalogRevisionId

export function vanillaSourceCatalog(): CatalogSnapshot {
  // Reconcile source identities before projecting facts, then compile portable IDs only after those joins
  // Compiling earlier would detach reviewed source-key mappings from their records
  const catalog = projectSourceCatalog(reconcileNativeSourceIdentities(addNativeBase(referenceSupplements())))
  return { ...catalog, revisionId: VANILLA_CATALOG_REVISION_ID, applicability: { state: 'known', value: 'Fingerprint-pinned Windows base definitions and separately attributed reference facts' } }
}

export function vanillaCatalog(checksum: string): CatalogSnapshot {
  return { ...compileCatalogIdentities(vanillaSourceCatalog(), supplementalIds.ids), checksum }
}
