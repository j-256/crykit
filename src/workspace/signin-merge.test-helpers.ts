import { createBlankLocalData, createPersonalDefinition, createPlaythrough } from '../domain/local-data'
import { upsertProgress } from '../domain/characters'
import type { LocalData, PersonalDefinitionId, PlaythroughId, ProgressRecordId } from '../domain/types'
import type { WorkspaceState } from './documents'

export const now = '2026-11-14T00:00:00.000Z'
export function workspace(localData: LocalData): WorkspaceState {
  return { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] }, blobs: [] }
}
export function progress(id: string, known = true): WorkspaceState {
  const local = createPlaythrough(createPersonalDefinition(createBlankLocalData({ now }), { id: 'subject' as PersonalDefinitionId, kind: 'class', name: 'Class', now }), { id: 'play' as PlaythroughId, label: 'Run', now })
  return workspace(upsertProgress(local, { id: id as ProgressRecordId, subject: { kind: 'personal', definitionId: 'subject' as PersonalDefinitionId }, displayName: 'Class', unlocked: known ? { state: 'known', value: true } : { state: 'unknown', reason: 'Check later' }, now }))
}
