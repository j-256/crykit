import { capturedLocalDocuments } from './local-root'
import { maxDependencies } from '../account/protocol'
import { blobIdentity } from './blobs'
import { archiveTypedReferences, inspectWorkspaceClosure, type WorkspaceUnitIndex } from './closure'
import { resolvedDomainClosureKeys } from './domain-closure'
import { isBlobSource, privateRecordKey, splitWorkspace, type SaveWorkspaceDocument, type WorkspaceBlobRef, type WorkspaceConflictClosureEntry, type WorkspaceState } from './documents'
import { editorBlob } from './editor-document'
import { INDEX_PAGE_BYTES, INDEX_PAGE_ENTRIES } from './directory'

export async function retainFileRevision(state: WorkspaceState, file: SaveWorkspaceDocument, retention: 'protected' | 'autosave-recovery'): Promise<WorkspaceState> {
  if (JSON.stringify(state.saveDocuments.find(value => value.id === file.id)) !== JSON.stringify(file)) throw new Error('History requires the exact captured Save container')
  const documents = capturedLocalDocuments(state) ?? new Map(splitWorkspace(state).map(document => [document.key, document]))
  const blobs = new Map(state.blobs.map(blob => [blobIdentity(blob.ref), blob]))
  const entries = new Map<string, WorkspaceConflictClosureEntry>(), seen = new Map<string, WorkspaceBlobRef>(), visiting = new Set<string>()
  const json = async (value: unknown) => {
    const body = await editorBlob(new TextEncoder().encode(JSON.stringify(value)), 'utf8')
    blobs.set(blobIdentity(body.ref), body)
    return body.ref
  }
  const unit = async (value: WorkspaceUnitIndex) => {
    const ref = await json(value)
    entries.set(blobIdentity(ref), { version: 1, ref, documentVersion: 1, kind: 'unit-index', key: privateRecordKey('unit-index', blobIdentity(ref)), encoding: 'json', dependencies: value.roots })
    return ref
  }
  async function visit(key: string): Promise<WorkspaceBlobRef> {
    if (visiting.has(key)) throw new Error('Cyclic file history relationship')
    const previous = seen.get(key)
    if (previous) return previous
    const document = documents.get(key)
    if (!document || isBlobSource(document.value)) throw new Error('Exact file history relationship is unavailable')
    visiting.add(key)
    const direct = archiveTypedReferences(document.kind, document.value)
    for (const ref of direct) {
      const blob = blobs.get(blobIdentity(ref))
      if (!blob || JSON.stringify(blob.ref) !== JSON.stringify(ref)) throw new Error('Exact file history bytes are unavailable')
      entries.set(blobIdentity(ref), { version: 1, ref, documentVersion: 1, kind: 'blob', key: privateRecordKey('blob', blobIdentity(ref)), encoding: 'bytes', dependencies: [] })
    }
    const dependencies = [...direct]
    // Only declared typed relationships retain bodies; pendingForm identifiers are inert recovery evidence
    for (const dependency of resolvedDomainClosureKeys(document, documents)) dependencies.push(await visit(dependency))
    const ref = await json(document.value)
    let refs = [...new Map(dependencies.map(value => [blobIdentity(value), value])).values()]
    let retainingIndex: WorkspaceBlobRef | undefined
    if (refs.length > maxDependencies) {
      const relation = { kind: 'retaining-edges' as const, privateKey: key, owner: ref }
      do {
        const parents: WorkspaceBlobRef[] = []
        for (let at = 0; at < refs.length; at += INDEX_PAGE_ENTRIES) parents.push(await unit({ version: 1, kind: 'unit-index', roots: refs.slice(at, at + INDEX_PAGE_ENTRIES), relation }))
        refs = parents
      } while (refs.length > 1)
      retainingIndex = refs[0]
    }
    entries.set(blobIdentity(ref), { version: 1, ref, documentVersion: 1, kind: document.kind as WorkspaceConflictClosureEntry['kind'], key, encoding: 'json', dependencies: refs, ...(retainingIndex ? { retainingIndex } : {}) })
    seen.set(key, ref); visiting.delete(key)
    return ref
  }
  const root = await visit(privateRecordKey('save', file.id))
  async function pages(values: readonly WorkspaceConflictClosureEntry[] | readonly WorkspaceBlobRef[], children: boolean): Promise<WorkspaceBlobRef[]> {
    const result: WorkspaceBlobRef[] = []
    let page = { version: 1, kind: 'conflict-closure-page', entries: [] as WorkspaceConflictClosureEntry[], children: [] as WorkspaceBlobRef[] }
    const full = (value: typeof page) => value.entries.length + value.children.length > INDEX_PAGE_ENTRIES || new TextEncoder().encode(JSON.stringify(value)).length > INDEX_PAGE_BYTES
    for (const value of values) {
      const next = children ? { ...page, children: [...page.children, value as WorkspaceBlobRef] } : { ...page, entries: [...page.entries, value as WorkspaceConflictClosureEntry] }
      if (full(next)) { if (!page.entries.length && !page.children.length) throw new Error('File history entry exceeds page format'); result.push(await json(page)); page = { version: 1, kind: 'conflict-closure-page', entries: [], children: [] } }
      if (children) page.children.push(value as WorkspaceBlobRef); else page.entries.push(value as WorkspaceConflictClosureEntry)
      if (full(page)) throw new Error('File history entry exceeds page format')
    }
    if (page.entries.length || page.children.length) result.push(await json(page))
    return result
  }
  let indexes = await pages([...entries.values()], false)
  while (indexes.length > 1) indexes = await pages(indexes, true)
  const content = { version: 1 as const, root, index: indexes[0] }
  const result: WorkspaceState = { ...state, blobs: [...blobs.values()], retainedContent: [...state.retainedContent, { version: 1, kind: 'file-history', id: crypto.randomUUID(), fileKind: 'save', documentId: file.id, retention, retainedAt: new Date().toISOString(), content }] }
  await inspectWorkspaceClosure(result, content)
  return result
}
