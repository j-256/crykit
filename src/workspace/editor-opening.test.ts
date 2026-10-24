import { expect, it } from 'vitest'
import { createSampleLocalData } from '../domain/sample-data'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { createEditorRepository } from './editor-repository'
import { readEditorContent } from './editor-document'
import { registerOwnedFileCommitter } from './owned-file-command'
import type { WorkspaceRepository } from './repository'
import type { WorkspaceState } from './documents'

it.each([undefined, 'map', 'document'] as const)('retains the captured starting view with the imported file: %s', async initialTab => {
  const localData = createSampleLocalData(CURRENT_CATALOG)
  let state: WorkspaceState = { planner: { localData, catalogs: [CURRENT_CATALOG], lineage: { rootLocalDataId: localData.id }, sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], blobs: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] } }
  const repository = { kind: 'account', readWorkspace: async () => state } as WorkspaceRepository
  registerOwnedFileCommitter(repository, async (_before, next, command) => {
    command.assertMayActivate(); state = next
    return { status: 'saved' }
  })
  const editor = createEditorRepository(repository)
  const text = '\ufeff{\r\n"Entities":[],"Unknown":900719925474099312345,"Text":"\\ud800"\r\n}'
  const input = { filename: 'map.json', text, referenceId: 'synthetic', initialTab }
  const imported = editor.importFile(input)
  input.initialTab = initialTab === 'map' ? 'document' : 'map'
  const row = await imported
  expect(row.unfinished.fieldState).toEqual({ ...(initialTab ? { tab: initialTab } : {}), fileInfo: { schemaVersion: 1, edited: false, titleState: 'missing', versionState: 'missing', projectIdState: 'missing' } })
  expect(state.editorDocuments).toEqual([row])
  const content = await readEditorContent(state, row)
  expect(content.originalText).toBe(text)
  expect(content.lastAppliedText).toBe(text)
  expect(content.unfinishedText).toBe(text)
  expect(row.revision).toBe(1)
})

it('keeps file labels aligned with applied content and preserves unknown unfinished input', async () => {
  const localData = createSampleLocalData(CURRENT_CATALOG)
  let state: WorkspaceState = { planner: { localData, catalogs: [CURRENT_CATALOG], lineage: { rootLocalDataId: localData.id }, sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], blobs: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] } }
  const repository = { kind: 'account', readWorkspace: async () => state } as WorkspaceRepository
  registerOwnedFileCommitter(repository, async (_before, next, command) => {
    command.assertMayActivate(); state = next
    return { status: 'saved' }
  })
  const editor = createEditorRepository(repository)
  const original = '{"ID":"synthetic-project","Title":"Synthetic external mod","Version":"1.0","EditorVersion":34}'
  const first = await editor.importFile({ filename: 'same-name.json', text: original, referenceId: '' })
  const info = { schemaVersion: 1, title: 'Synthetic external mod', version: '1.0', projectId: 'synthetic-project', titleState: 'present', versionState: 'present', projectIdState: 'present', edited: false }
  expect(first.unfinished.fieldState).toEqual(expect.objectContaining({ fileInfo: info }))
  const changed = '{"ID":"synthetic-project","Title":"Renamed working copy","Version":"1.1","EditorVersion":34}'
  const fields = first.unfinished.fieldState as Record<string, import('../domain/types').JsonValue>
  const unfinished = await editor.saveUnfinished(first.id, { text: changed, editedPath: [], fieldState: { ...fields, unrecognized: { version: 9, value: 'Keep this exact field' }, editorDirty: true }, validation: 'valid' }, first.revision)
  expect(unfinished.unfinished.fieldState).toEqual(expect.objectContaining({ fileInfo: info }))
  const applied = await editor.applyDraft(first.id, unfinished.revision)
  expect(applied.unfinished.fieldState).toEqual(expect.objectContaining({ fileInfo: { ...info, title: 'Renamed working copy', version: '1.1', edited: true }, unrecognized: { version: 9, value: 'Keep this exact field' } }))
  const content = await readEditorContent(state, applied)
  expect(content.originalText).toBe(original)
  expect(content.lastAppliedText).toBe(changed)
})
