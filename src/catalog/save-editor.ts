import { NATIVE_GAME_DATA } from './native-game'
import { createSaveEditorCatalog } from '../domain/save-editor'

export const SAVE_EDITOR_CATALOG = createSaveEditorCatalog(NATIVE_GAME_DATA)
