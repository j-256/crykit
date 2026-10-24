import { expect, it } from 'vitest'
import { createSaveEditorModProjectFixture } from '../domain/save-editor.fixture'
import { createSaveEditorModSource } from '../domain/save-editor-mods'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { editorBlob } from './editor-document'
import { retainFileRevision } from './file-history'
import { editorClosureFixture } from './test-helpers'
import { inspectWorkspaceClosure } from './closure'
import { privateRecordKey, type SaveWorkspaceDocument, type WorkspaceState } from './documents'
import { blobIdentity } from './blobs'

it('retains complete Save requirements, catalog and source bytes while pending references remain inert', async () => {
  const fixture = await editorClosureFixture()
  const preview = await previewCrystalEdit(new TextEncoder().encode(JSON.stringify(createSaveEditorModProjectFixture())), 'synthetic.json')
  const catalog = preview.proposed.catalogs[0]
  const sourceBlobs = await Promise.all(preview.proposed.sources.map(source => editorBlob(source.bytes, 'bytes')))
  const sources = preview.proposed.sources.map(({ bytes: _bytes, ...source }, index) => ({ ...source, original: sourceBlobs[index].ref }))
  const body = await editorBlob(new Uint8Array([99, 1, 2]), 'bytes')
  const file: SaveWorkspaceDocument = { version: 1, id: 'saved', revision: 4, filename: 'exact.sav', original: body.ref, working: body.ref, pendingForm: { revision: 999, selectedBuild: 'absent-build', ref: { kind: 'catalog', catalogId: 'absent', catalogRevisionId: 'absent-revision', entityId: 'absent-entity' } }, requirements: [{ catalogId: catalog.id, catalogRevisionId: catalog.revisionId, checksum: catalog.checksum, title: createSaveEditorModSource(catalog).title }], coverage: { status: 'unsupported', diagnostics: ['Synthetic future framing'] }, exportedRevision: 2, createdAt: '2026-01-01', updatedAt: '2026-01-02' }
  const state: WorkspaceState = { ...fixture.state, planner: { ...fixture.state.planner, catalogs: [catalog], sources, evidence: preview.proposed.evidence }, saveDocuments: [file], retainedContent: [], blobs: [body, ...sourceBlobs] }
  const retained = await retainFileRevision(state, file, 'protected')
  const history = retained.retainedContent[0]
  if (history.kind !== 'file-history') throw new Error('Expected Save history')
  const inspected = await inspectWorkspaceClosure(retained, history.content)
  expect(inspected.value).toEqual(file)
  expect(inspected.documents.get(privateRecordKey('catalog', catalog.id, catalog.revisionId))!.value).toEqual(JSON.parse(JSON.stringify(catalog)))
  expect(inspected.documents.get(privateRecordKey('source', sources[0].id))!.value).toEqual(sources[0])
  expect(inspected.refs.has(blobIdentity(sourceBlobs[0].ref))).toBe(true)
  expect([...inspected.documents.values()].some(value => value.kind === 'build-checkpoint')).toBe(false)
  expect(history.retention).toBe('protected')
})
