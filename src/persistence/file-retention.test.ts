import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { createBlankLocalData } from '../domain/local-data'
import { installProfile, invalidateProfile } from '../account/profile'
import { AccountDatabase, activateLocalAccountCommit } from './account-database'
import { accountLocalId } from '../workspace/account-cache'
import { prepareAccountWorkspace, openAccountWorkspace } from '../workspace/account-graph'
import { assembleWorkspace, splitWorkspace, type WorkspaceState, type WorkspaceBlobRef, type EditorWorkspaceDocument, type SaveWorkspaceDocument, type WorkspaceConflictClosureEntry } from '../workspace/documents'
import { archiveTypedReferences, inspectWorkspaceClosure, publicationDocuments, validateWorkspaceClosure } from '../workspace/closure'
import { blobIdentity, hashBlob, memoryBlob, readBlob } from '../workspace/blobs'

async function retainedFiles() {
  const localData = createBlankLocalData()
  const blobs: WorkspaceState['blobs'][number][] = []
  async function bytes(value: Uint8Array, id: string, encoding: WorkspaceBlobRef['encoding'] = 'bytes'): Promise<WorkspaceBlobRef> {
    const content = memoryBlob(value), ref: WorkspaceBlobRef = { documentId: id, revisionId: `${id}:1`, byteLength: value.length, sha256: await hashBlob(content), encoding }
    blobs.push({ ref, content }); return ref
  }
  const json = (value: unknown, id: string) => bytes(new TextEncoder().encode(JSON.stringify(value)), id)
  const editor: EditorWorkspaceDocument[] = [], saves: SaveWorkspaceDocument[] = []
  const closures = new Map<string, Awaited<ReturnType<typeof close>>>()
  async function close(file: EditorWorkspaceDocument | SaveWorkspaceDocument, kind: 'editor' | 'save') {
    const key = JSON.stringify([kind, file.id]), root = await json(file, `${kind}-metadata-${file.revision}`)
    const dependencies = [...new Map(archiveTypedReferences(kind, file).map(ref => [blobIdentity(ref), ref])).values()]
    const entries: WorkspaceConflictClosureEntry[] = [{ version: 1, ref: root, documentVersion: 1, kind, key, encoding: 'json', dependencies }, ...dependencies.map(ref => ({ version: 1 as const, ref, documentVersion: 1 as const, kind: 'blob' as const, key: JSON.stringify(['blob', blobIdentity(ref)]), encoding: 'bytes' as const, dependencies: [] }))]
    const index = await json({ version: 1, kind: 'conflict-closure-page', entries, children: [] }, `${kind}-index-${file.revision}`)
    const closure = { version: 1 as const, root, index }; closures.set(`${kind}:${file.revision}`, closure); return closure
  }
  for (let revision = 0; revision < 4; revision++) {
    const original = await bytes(new Uint8Array([0xef, 0xbb, 0xbf, 13, 10, revision]), `editor-original-${revision}`, revision ? 'bytes' : 'utf16le')
    const applied = await bytes(new Uint8Array([0x7b, revision, 0x7d]), `editor-applied-${revision}`, 'utf16le')
    const unfinished = await bytes(new Uint8Array([0x00, 0xd8, revision, 0]), `editor-unfinished-${revision}`, 'utf16le')
    editor.push({ version: 1, id: 'editor-file', revision, filename: `historical-${revision}.json`, referenceId: `reference-${revision}`, original, originalByteIdentity: revision ? 'exact' : 'text-only', lastApplied: applied, unfinished: { text: unfinished, editedPath: ['inert', revision], fieldState: { password: `inert-${revision}`, selectedPlaythroughId: 'ordinary inert field' }, baseRevision: revision, validation: revision % 2 ? 'valid' : 'invalid' }, createdAt: '2026-01-01', updatedAt: `2026-01-0${revision + 1}` })
    const saveOriginal = await bytes(new Uint8Array([0, 255, 0, revision]), `save-original-${revision}`)
    const working = await bytes(new Uint8Array([255, 0, revision, 254]), `save-working-${revision}`)
    saves.push({ version: 1, id: 'save-file', revision, filename: `historical-${revision}.sav`, original: saveOriginal, working, pendingForm: { quantities: { unknown: null, invalid: `typed-${revision}` }, activeScenarioId: 'inert save form', revision }, requirements: [], coverage: revision % 2 ? { status: 'supported', codecVersion: `codec-${revision}`, diagnostics: [`supported-${revision}`] } : { status: 'unsupported', diagnostics: [`unknown-${revision}`] }, createdAt: '2026-01-01', updatedAt: `2026-01-0${revision + 1}`, exportedRevision: revision === 0 ? null : revision - 1 })
    await close(editor[revision], 'editor'); await close(saves[revision], 'save')
  }
  const retainedContent: WorkspaceState['retainedContent'][number][] = []
  for (const kind of ['editor', 'save'] as const) {
    retainedContent.push({ version: 1, kind: 'file-history', id: `${kind}-history`, fileKind: kind, documentId: `${kind}-file`, retainedAt: '2026-01-05', retention: 'protected', content: closures.get(`${kind}:0`)! })
    retainedContent.push({ version: 1, kind: 'pending-content', id: `${kind}-active-target`, groupId: 'active-group', unit: { kind: 'record', privateKey: JSON.stringify([kind, `${kind}-file`]) }, base: { kind: 'present', closure: closures.get(`${kind}:1`)! }, target: closures.get(`${kind}:3`)! })
    retainedContent.push({ version: 1, kind: 'pending-content', id: `${kind}-superseded-target`, groupId: 'superseded-group', unit: { kind: 'record', privateKey: JSON.stringify([kind, `${kind}-file`]) }, base: { kind: 'present', closure: closures.get(`${kind}:1`)! }, target: closures.get(`${kind}:2`)! })
  }
  const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [editor[3]], saveDocuments: [saves[3]], assets: [], libraryDefaults: { version: 1, layers: [] }, retainedContent, conflicts: [], blobs }
  return { state, closures, editor, saves }
}

it('round trips nonempty historical Editor and Save payloads, older bases and superseded pending targets through encrypted activation', async () => {
  const { state, closures, editor, saves } = await retainedFiles()
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    const mapped = assembleWorkspace(splitWorkspace(state), state.planner.localData.revision)
    await validateWorkspaceClosure(mapped)
    const prepared = await prepareAccountWorkspace(database, token, mapped)
    await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records })
    const reopened = (await openAccountWorkspace(database, token, prepared.head)).state
    expect(reopened.editorDocuments).toEqual([editor[3]])
    expect(reopened.saveDocuments).toEqual([saves[3]])
    expect(reopened.retainedContent).toEqual(state.retainedContent)
    for (const kind of ['editor', 'save'] as const) for (let revision = 0; revision < 4; revision++) {
      const result = await inspectWorkspaceClosure(reopened, closures.get(`${kind}:${revision}`)!)
      expect(result.value).toEqual((kind === 'editor' ? editor : saves)[revision])
    }
    // Equality of all reopened exact bytes proves older metadata and bodies were not replaced by the live target
    for (const expected of state.blobs) {
      const actual = reopened.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(expected.ref))!
      expect(actual.ref).toEqual(expected.ref)
      expect(await readBlob(actual.content, actual.ref.byteLength)).toEqual(await readBlob(expected.content, expected.ref.byteLength))
    }
    const documents = await publicationDocuments(reopened)
    const published = new Set(documents.filter(document => document.kind === 'blob').map(document => (JSON.parse(document.key) as string[])[1]))
    for (const kind of ['editor', 'save'] as const) {
      const historical = await inspectWorkspaceClosure(reopened, closures.get(`${kind}:0`)!)
      for (const ref of historical.refs) expect(published.has(ref)).toBe(true)
      for (const revision of [1, 2]) {
        const pending = await inspectWorkspaceClosure(reopened, closures.get(`${kind}:${revision}`)!)
        for (const ref of pending.refs) expect(published.has(ref)).toBe(false)
      }
      const current = (kind === 'editor' ? editor : saves)[3]
      for (const ref of archiveTypedReferences(kind, current)) expect(published.has(blobIdentity(ref))).toBe(true)
    }
    expect(documents.filter(document => document.kind === 'retained-content').map(document => (document.value as { kind: string }).kind)).toEqual(['file-history', 'file-history'])
    const missingBase = closures.get('save:1')!.root
    await expect(validateWorkspaceClosure({ ...reopened, blobs: reopened.blobs.filter(blob => blobIdentity(blob.ref) !== blobIdentity(missingBase)) })).rejects.toThrow('Missing')
    const historicalRoot = closures.get('editor:0')!.root
    await expect(validateWorkspaceClosure({ ...reopened, blobs: reopened.blobs.filter(blob => blobIdentity(blob.ref) !== blobIdentity(historicalRoot)) })).rejects.toThrow('Missing')
  } finally { invalidateProfile(); await database.delete() }
})

it('keeps acknowledged file originals portable until both exact versions have declared history evidence', async () => {
  const { retirePendingContent } = await import('../workspace/pending-content')
  const { state, closures, editor, saves } = await retainedFiles()
  // A current target and an accepted transport receipt do not preserve the prior file metadata
  const withoutEvidence = await retirePendingContent(state, 'active-group')
  expect(withoutEvidence.retainedContent).toEqual(state.retainedContent)
  for (const kind of ['editor', 'save'] as const) for (const revision of [1, 3]) expect((await inspectWorkspaceClosure(withoutEvidence, closures.get(`${kind}:${revision}`)!)).value).toEqual((kind === 'editor' ? editor : saves)[revision])
  const history = [1, 3].map(revision => ({ version: 1 as const, kind: 'file-history' as const, id: `accepted-editor-${revision}`, fileKind: 'editor' as const, documentId: 'editor-file', retainedAt: '2026-01-05', retention: 'protected' as const, content: closures.get(`editor:${revision}`)! }))
  const retired = await retirePendingContent({ ...state, retainedContent: [...state.retainedContent, ...history] }, 'active-group')
  expect(retired.retainedContent.some(value => value.id === 'editor-active-target')).toBe(false)
  expect(retired.retainedContent.some(value => value.id === 'save-active-target')).toBe(true)
  expect(retired.retainedContent.some(value => value.id === 'editor-superseded-target')).toBe(true)
  await validateWorkspaceClosure(retired)
  for (const kind of ['editor', 'save'] as const) for (const revision of [1, 2, 3]) expect((await inspectWorkspaceClosure(retired, closures.get(`${kind}:${revision}`)!)).value).toEqual((kind === 'editor' ? editor : saves)[revision])
  // No account keys, accepted-operation rows or binding caches participate in this round trip
  const portable = assembleWorkspace(splitWorkspace(retired), retired.planner.localData.revision)
  await validateWorkspaceClosure(portable)
  expect(portable.retainedContent).toEqual(retired.retainedContent)
})
