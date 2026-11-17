import { formatEntityRefPath } from '../src/ui/navigation'
import { CURRENT_CATALOG } from '../src/catalog/bundled'
import { NATIVE_GAME_DATA } from '../src/catalog/native-game'
import { nativeGameplayScopeLabel } from '../src/domain/native-game'
import type { CatalogRef } from '../src/domain/types'

export const CURRENT_GAME_VERSION = NATIVE_GAME_DATA.source.gameVersion
export const CURRENT_NATIVE_LABEL = nativeGameplayScopeLabel(NATIVE_GAME_DATA.source.platform, CURRENT_GAME_VERSION)
export const CURRENT_NATIVE_SOURCE_ID = `native-game:${NATIVE_GAME_DATA.source.platform.toLowerCase()}:${CURRENT_GAME_VERSION}`
export const CURRENT_NATIVE_SOURCE_LABEL = `${NATIVE_GAME_DATA.source.platform} ${CURRENT_GAME_VERSION} game files`

const BUNDLED_CATALOG_ID = CURRENT_CATALOG.id
const BUNDLED_CATALOG_REVISION_ID = CURRENT_CATALOG.revisionId

export function referencePath(entityId: string, catalogId: string = BUNDLED_CATALOG_ID, catalogRevisionId: string = BUNDLED_CATALOG_REVISION_ID, name?: string): string {
  const ref = { kind: 'catalog', catalogId, catalogRevisionId, entityId } as CatalogRef
  return `/#/reference/${formatEntityRefPath(ref, name === undefined ? undefined : () => name)}`
}

export function referenceUrlPattern(entityId: string): RegExp {
  const path = referencePath(entityId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const vanilla = currentReferencePath(entityId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:${path}|${vanilla})(?:\\?|$)`)
}

export function currentReferencePath(entityId: string): string {
  return referencePath(entityId, BUNDLED_CATALOG_ID, CURRENT_CATALOG.revisionId)
}
