import { NATIVE_GAME_DATA } from './native-game'
import { nativeMechanicDefinitions } from './native-mechanics'
import { projectSourceCatalog, reconcileNativeSourceIdentities } from './source-catalog'
import { compileCatalogIdentities } from '../domain/catalog-identities'
import { buildNativeCatalog } from '../domain/native-game'
import { STARTER_CATALOG_ID, STARTER_CATALOG_REVISION_ID } from './catalog-ids'
import type { CatalogSnapshot } from '../domain/types'

export const VANILLA_CATALOG_REVISION_ID = STARTER_CATALOG_REVISION_ID

export function vanillaSourceCatalog(): CatalogSnapshot {
  // Join reviewed numeric identities before compilation; this keeps learn-tree and innate links exact
  const { importedAt: _acquiredAt, ...source } = projectSourceCatalog(reconcileNativeSourceIdentities(buildNativeCatalog(NATIVE_GAME_DATA)))
  return { ...source, id: STARTER_CATALOG_ID, revisionId: VANILLA_CATALOG_REVISION_ID, applicability: { state: 'known', value: 'Fingerprint-pinned Crystal Project 1.6.9.0 native definitions and reviewed implementation facts' } }
}

export function vanillaCatalog(checksum: string): CatalogSnapshot {
  const native = compileCatalogIdentities(vanillaSourceCatalog())
  return { ...native, entities: { ...native.entities, ...nativeMechanicDefinitions() }, checksum }
}
