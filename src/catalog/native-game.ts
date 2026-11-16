import snapshot from './native-game-data.json' with { type: 'json' }
import type { NativeGameSnapshot } from '../domain/native-game'

export const NATIVE_GAME_DATA = snapshot as unknown as NativeGameSnapshot
