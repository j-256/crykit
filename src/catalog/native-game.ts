import snapshot from './native-game-data.json' with { type: 'json' }
import type { CatalogSnapshot } from '../domain/types'
import { assembleNativeBase, type NativeGameSnapshot } from '../domain/native-game'

export const NATIVE_GAME_DATA = snapshot as unknown as NativeGameSnapshot

export function addNativeBase(supplement: CatalogSnapshot): CatalogSnapshot {
  return assembleNativeBase(supplement, NATIVE_GAME_DATA)
}
