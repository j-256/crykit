import { BUNDLED_CATALOGS } from '../../src/catalog/bundled'
import { createSampleLocalData } from '../../src/domain/sample-data'
import { createSaveEditorFixture } from '../../src/domain/save-editor.fixture'
import { encodeCrystalSave } from '../../src/interchange/crystal-save'
import { editorBlob, encodeEditorText } from '../../src/workspace/editor-document'
import type { WorkspaceState } from '../../src/workspace/documents'
import type { BuildId } from '../../src/domain/types'

export const PERFORMANCE_SAVE_ID = 'synthetic-performance-save'
export const PERFORMANCE_EDITOR_ID = 'synthetic-performance-editor'
export const PERFORMANCE_JSON_BYTES = 64 * 1024
export const PERFORMANCE_UNRELATED_BYTES = 32 * 1024 * 1024
export const PERFORMANCE_UNRELATED_BUILDS = 1000
export const PERFORMANCE_UNRELATED_HISTORY = 100

// Bulk preparation is deliberately outside each ordinary operation's timing boundary
// Both sizes edit identical records; unrelated source bodies and chronological native history stay exact
export async function localSaveWorkload(large: boolean): Promise<WorkspaceState> {
  const seed = createSampleLocalData(BUNDLED_CATALOGS[0]!)
  const { latestRevisionId: _checkpoint, ...template } = Object.values(seed.builds)[0]!
  const localData = large ? { ...seed, revision: PERFORMANCE_UNRELATED_HISTORY, builds: { ...seed.builds, ...Object.fromEntries(Array.from({ length: PERFORMANCE_UNRELATED_BUILDS }, (_, index) => {
    const id = `synthetic-unrelated-build-${index}` as BuildId
    return [id, { ...template, id, title: `Synthetic unrelated Build ${index}` }]
  })) } } : seed
  const history = large ? Array.from({ length: PERFORMANCE_UNRELATED_HISTORY }, (_, index) => ({ id: `synthetic-unrelated-history-${index}`, localDataId: seed.id, command: 'synthetic-history', previousRevision: index, nextRevision: index + 1, before: { ...seed, revision: index }, after: { ...seed, revision: index + 1 }, recordedAt: seed.updatedAt })) : []
  const original = await editorBlob(encodeCrystalSave(createSaveEditorFixture()), 'bytes')
  const base = JSON.stringify({ ID: 'synthetic-performance-mod', Title: 'Synthetic performance mod', EditorVersion: 34, Notes: '' })
  const text = JSON.stringify({ ID: 'synthetic-performance-mod', Title: 'Synthetic performance mod', EditorVersion: 34, Notes: 'x'.repeat(PERFORMANCE_JSON_BYTES - base.length) })
  const editorOriginal = await editorBlob(new TextEncoder().encode(text), 'bytes'), editorText = await editorBlob(encodeEditorText(text), 'utf16le')
  if (editorOriginal.ref.byteLength !== PERFORMANCE_JSON_BYTES || original.ref.byteLength !== 29791) throw new Error('The benchmark source workload changed')
  const timestamp = seed.updatedAt
  const save: WorkspaceState['saveDocuments'][number] = { version: 1, id: PERFORMANCE_SAVE_ID, revision: 1, filename: 'synthetic-performance.sav', original: original.ref, working: original.ref, pendingForm: null, requirements: [], coverage: { status: 'supported', diagnostics: [] }, createdAt: timestamp, updatedAt: timestamp, exportedRevision: null }
  const editor: WorkspaceState['editorDocuments'][number] = { version: 1, id: PERFORMANCE_EDITOR_ID, revision: 1, filename: 'synthetic-performance.json', referenceId: '', original: editorOriginal.ref, originalByteIdentity: 'exact', lastApplied: editorText.ref, unfinished: { text: editorText.ref, editedPath: [], fieldState: null, baseRevision: 1, validation: 'valid' }, createdAt: timestamp, updatedAt: timestamp }
  const unrelated = large ? await editorBlob(new Uint8Array(PERFORMANCE_UNRELATED_BYTES).fill(113), 'bytes') : undefined
  return { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: BUNDLED_CATALOGS, sources: [], evidence: [], history }, editorDocuments: [editor], saveDocuments: [save, ...(unrelated ? [{ ...save, id: 'synthetic-unsupported-original', filename: 'synthetic-unsupported.sav', original: unrelated.ref, working: unrelated.ref, coverage: { status: 'unsupported' as const, diagnostics: ['Synthetic immutable unrelated file'] } }] : [])], assets: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] }, blobs: [original, editorOriginal, editorText, ...(unrelated ? [unrelated] : [])] }
}
