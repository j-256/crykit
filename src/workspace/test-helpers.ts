import { sha256 } from '../interchange/util'
import { createBlankLocalData } from '../domain/local-data'
import { memoryBlob } from './blobs'
import { WORKSPACE_BACKUP_LIMITS } from '../interchange/workspace-backup-schema'
import type { WorkspaceState, WorkspaceBlobRef, EditorWorkspaceDocument, WorkspaceConflictClosureEntry } from './documents'

export function multiPageMetadataText(fragment: string): string {
  // JSON escapes lone surrogates, so size segmentation fixtures by encoded bytes rather than code units
  const bytes = new TextEncoder().encode(JSON.stringify(fragment).slice(1, -1)).length
  return fragment.repeat(Math.floor(WORKSPACE_BACKUP_LIMITS.payload / bytes) + 1)
}

export async function editorClosureFixture() {
  const localData = createBlankLocalData()
  const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], evidence: [], sources: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], libraryDefaults: { version: 1, layers: [] }, conflicts: [], retainedContent: [], blobs: [] }
  const blobs: { ref: WorkspaceBlobRef; content: ReturnType<typeof memoryBlob> }[] = []
  async function add(value: unknown, id: string, encoding: WorkspaceBlobRef['encoding'] = 'utf8') {
    const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value))
    const ref: WorkspaceBlobRef = { documentId: id, revisionId: `${id}:1`, byteLength: bytes.length, sha256: await sha256(bytes), encoding }
    blobs.push({ ref, content: memoryBlob(bytes) }); return ref
  }
  const bytes = await add(new Uint8Array([0x00, 0xd8]), 'text', 'utf16le')
  const file: EditorWorkspaceDocument = { version: 1, id: 'editor-1', revision: 0, filename: 'before.json', referenceId: 'reference-v1', original: bytes, originalByteIdentity: 'text-only', lastApplied: bytes, unfinished: { text: bytes, editedPath: ['password'], fieldState: { password: 'inert' }, baseRevision: 0, validation: 'invalid' }, createdAt: '2026-01-01', updatedAt: '2026-01-01' }
  const root = await add(file, 'root')
  const entries: WorkspaceConflictClosureEntry[] = [{ version: 1, ref: root, documentVersion: 1, kind: 'editor', key: '["editor","editor-1"]', encoding: 'json', dependencies: [bytes] }, { version: 1, ref: bytes, documentVersion: 1, kind: 'blob', key: '["blob","text"]', encoding: 'bytes', dependencies: [] }]
  const index = await add({ version: 1, kind: 'conflict-closure-page', entries, children: [] }, 'index')
  const closure = { version: 1 as const, root, index }
  return { state: { ...state, blobs, retainedContent: [{ version: 1 as const, kind: 'pending-content' as const, id: 'pending-1', groupId: 'portable-group', unit: { kind: 'record' as const, privateKey: '["editor","editor-1"]' }, base: { kind: 'absent' as const }, target: closure }] }, blobs, add, closure, file, entries }
}
