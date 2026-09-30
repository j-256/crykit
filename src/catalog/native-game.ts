import snapshot from './native-game-data.json' with { type: 'json' }
import type { CatalogRevisionId, CatalogSnapshot } from '../domain/types'
import { assembleNativeBase, type NativeGameSnapshot } from '../domain/native-game'

export const NATIVE_BASE_REVISION_ID = 'native-v1' as CatalogRevisionId
export const NATIVE_BASE_CHECKSUM = 'builtin:sha256:1beefc9ae37e4e857b6a63a6f96d02ba784622196578cfd78e1d15310cc2a490'
export const NATIVE_GAME_DATA = snapshot as unknown as NativeGameSnapshot

export function addNativeBase(supplement: CatalogSnapshot): CatalogSnapshot {
  return assembleNativeBase(supplement, NATIVE_GAME_DATA, NATIVE_BASE_REVISION_ID, NATIVE_BASE_CHECKSUM)
}
