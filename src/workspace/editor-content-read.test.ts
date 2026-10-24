import { expect, it } from 'vitest'
import { createBlankLocalData } from '../domain/local-data'
import { editorBlob, encodeEditorText, readEditorContent } from './editor-document'
import type { EditorWorkspaceDocument, WorkspaceState } from './documents'

async function fixture() {
  const text = '\ufeff{\r\n"Unknown":"\ud800"\r\n}', body = await editorBlob(encodeEditorText(text), 'utf16le')
  const timestamp = new Date().toISOString()
  const file: EditorWorkspaceDocument = { version: 1, id: 'synthetic-editor', revision: 1, filename: 'synthetic.json', referenceId: '', original: body.ref, originalByteIdentity: 'text-only', lastApplied: body.ref, unfinished: { text: body.ref, editedPath: [], fieldState: null, baseRevision: 1, validation: 'unchecked' }, createdAt: timestamp, updatedAt: timestamp }
  const localData = createBlankLocalData()
  const state: WorkspaceState = { planner: { localData, catalogs: [], sources: [], evidence: [], history: [], lineage: { rootLocalDataId: localData.id } }, editorDocuments: [file], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] }, blobs: [body] }
  return { text, body, file, state }
}

it('reads each exact editor body once per invocation and preserves original code units', async () => {
  const f = await fixture(), source = f.body.content
  let opens = 0
  const state = { ...f.state, blobs: [{ ...f.body, content: { byteLength: source.byteLength, async *open() { opens++; yield* source.open() } } }] }
  const result = await readEditorContent(state, f.file)
  expect(result.originalBytes).toEqual(encodeEditorText(f.text))
  expect(result.lastAppliedBytes).toEqual(result.originalBytes)
  expect([result.originalText, result.lastAppliedText, result.unfinishedText]).toEqual([f.text, f.text, f.text])
  expect(opens).toBe(1)
  result.originalBytes.fill(0)
  expect(result.lastAppliedBytes).toEqual(encodeEditorText(f.text))
  await readEditorContent(state, f.file)
  expect(opens).toBe(2)
})

it('opens distinct original, applied and invalid unfinished bodies exactly once each', async () => {
  const f = await fixture(), applied = await editorBlob(encodeEditorText('{"Applied":true}'), 'utf16le'), unfinished = await editorBlob(encodeEditorText('{"Invalid":'), 'utf16le')
  const opens = new Map<string, number>()
  const blobs = [f.body, applied, unfinished].map(body => ({ ...body, content: { byteLength: body.content.byteLength, async *open() {
    opens.set(body.ref.revisionId, (opens.get(body.ref.revisionId) ?? 0) + 1)
    yield* body.content.open()
  } } }))
  const file = { ...f.file, lastApplied: applied.ref, unfinished: { ...f.file.unfinished, text: unfinished.ref, validation: 'invalid' as const } }
  const result = await readEditorContent({ ...f.state, blobs }, file)
  expect([result.originalText, result.lastAppliedText, result.unfinishedText]).toEqual([f.text, '{"Applied":true}', '{"Invalid":'])
  expect([...opens.values()]).toEqual([1, 1, 1])
})

it('rejects conflicting declared metadata before reusing an alias', async () => {
  const f = await fixture()
  await expect(readEditorContent(f.state, { ...f.file, lastApplied: { ...f.file.lastApplied, sha256: '0'.repeat(64) } })).rejects.toThrow()
  await expect(readEditorContent(f.state, { ...f.file, lastApplied: { ...f.file.lastApplied, encoding: 'bytes' } })).rejects.toThrow()
})

it('authenticates the same collected bytes that it returns and still checks each new invocation', async () => {
  const f = await fixture(), source = f.body.content
  let corrupt = false, opens = 0
  const state = { ...f.state, blobs: [{ ...f.body, content: { byteLength: source.byteLength, async *open() {
    opens++
    for await (const bytes of source.open()) { if (corrupt) bytes[0] ^= 1; yield bytes }
    corrupt = true
  } } }] }
  expect((await readEditorContent(state, f.file)).unfinishedText).toBe(f.text)
  expect(opens).toBe(1)
  await expect(readEditorContent(state, f.file)).rejects.toThrow(/digest/)
})

it('rejects truncated bytes and a reader whose captured lifetime expires', async () => {
  const f = await fixture(), source = f.body.content
  for (const content of [
    { byteLength: source.byteLength, async *open() { yield new Uint8Array(1) } },
    { byteLength: source.byteLength, async *open() { yield new Uint8Array(1); throw new Error('Captured profile retired') } },
  ]) await expect(readEditorContent({ ...f.state, blobs: [{ ...f.body, content }] }, f.file)).rejects.toThrow()
})
