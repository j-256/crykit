import { expect, it } from 'vitest'
import { validateCapturedWorkspaceRecords, type CapturedWorkspaceRecord } from './account-evidence'
import { blobIdentity, hashBlob, memoryBlob } from './blobs'
import { editorClosureFixture } from './test-helpers'
import { privateRecordKey, type BlobSource, type WorkspaceDocument } from './documents'

async function capturedEditor() {
  const fixture = await editorClosureFixture(), ref = fixture.file.original
  let bytes = new Uint8Array([0x00, 0xd8]), reads = 0
  const source: BlobSource = { byteLength: bytes.length, async *open() { reads++; yield bytes.slice() } }
  const bodyRef = { documentId: 'native-body', revisionId: 'native-body-1' }
  const rootRef = { documentId: 'native-editor', revisionId: 'native-editor-1' }
  const body: CapturedWorkspaceRecord = { ref: bodyRef, document: { version: 1, kind: 'blob', key: privateRecordKey('blob', blobIdentity(ref)), value: source }, source, digest: ref.sha256, dependencies: [] }
  const root: CapturedWorkspaceRecord = { ref: rootRef, document: { version: 1, kind: 'editor', key: privateRecordKey('editor', fixture.file.id), value: fixture.file as unknown as WorkspaceDocument['value'] }, source: memoryBlob(new Uint8Array()), digest: '', dependencies: [bodyRef] }
  const records = new Map([body, root].map(record => [blobIdentity(record.ref), record]))
  const allocations = new Map([body, root].map(record => [record.document.key, record.ref.documentId]))
  const validate = (read = async (identity: typeof bodyRef) => records.get(blobIdentity(identity))!) => validateCapturedWorkspaceRecords(read, [rootRef], allocations, new Map())
  return { ref, source, body, root, records, validate, reads: () => reads, replace: (value: Uint8Array) => { bytes = value.slice() } }
}

it('authenticates a shared captured body once per graph traversal and rereads it on the next traversal', async () => {
  const fixture = await capturedEditor()
  await fixture.validate()
  expect(fixture.reads()).toBe(1)
  fixture.replace(new Uint8Array([0x00, 0xd9]))
  await expect(fixture.validate()).rejects.toThrow('Missing or mismatched captured body')
  expect(fixture.reads()).toBe(2)
})

it('checks every reference digest even when it names an already authenticated captured body', async () => {
  const fixture = await capturedEditor()
  const file = fixture.root.document.value as unknown as Awaited<ReturnType<typeof editorClosureFixture>>['file']
  const incorrect = await hashBlob(memoryBlob(new Uint8Array([0x00, 0xd9])))
  fixture.records.set(blobIdentity(fixture.root.ref), { ...fixture.root, document: { ...fixture.root.document, value: { ...file, lastApplied: { ...file.lastApplied, sha256: incorrect } } as unknown as WorkspaceDocument['value'] } })
  await expect(fixture.validate()).rejects.toThrow('Missing or mismatched captured body')
})

it('rejects a body source whose open capability changes while its digest is being observed', async () => {
  const fixture = await capturedEditor(), open = fixture.source.open
  fixture.source.open = async function* () {
    yield* open()
    fixture.source.open = async function* () { yield new Uint8Array([0x00, 0xd9]) }
  }
  await expect(fixture.validate()).rejects.toThrow('Captured body source changed')
})
