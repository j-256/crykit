import { SAVE_EDITOR_MAX_LEVEL, type SaveEditorSummary } from '../domain/save-editor'

export function saveEditorLevelHint(summary: Pick<SaveEditorSummary, 'levelCap' | 'levelCapCanBeRaised'>): string {
  // Both party forms must respect challenge restrictions before offering a level-cap assist
  return summary.levelCapCanBeRaised
    ? `Above ${summary.levelCap} enables the level-cap assist, up to ${SAVE_EDITOR_MAX_LEVEL}`
    : `1 to ${summary.levelCap}`
}
