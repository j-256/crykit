import type { EditorWorkspaceDocument, WorkspaceBlobRef, WorkspaceState, WorkspaceConflictClosureEntry } from './documents'
import { EditorWorkspaceDocumentSchema } from './file-schemas'
import { blobIdentity, hashBlob, memoryBlob, readBlob, verifiedBlob } from './blobs'
import { DOCUMENT_LIMITS } from '../mod-inspector/document'
import { MAX_MOD_SOURCE_BYTES } from '../domain/mod-library'

const EDITOR_TEXT_CHUNK_UNITS = 8192

export function validateEditorContainer(value: unknown): EditorWorkspaceDocument {
  // Unfinished text is an opaque blob; parsing it here would make invalid saved work unreopenable
  const file = EditorWorkspaceDocumentSchema.parse(value)
  if (file.unfinished.text.encoding !== 'utf16le' || file.unfinished.text.byteLength > DOCUMENT_LIMITS.textLength * 2 || file.unfinished.baseRevision > file.revision) throw new Error('Invalid unfinished editor container')
  if (file.originalByteIdentity === 'text-only' && file.original.encoding !== 'utf16le') throw new Error('Text-only originals require exact code units')
  if (file.originalByteIdentity === 'exact' && file.original.byteLength > MAX_MOD_SOURCE_BYTES) throw new Error('Mod exceeds the 96 MiB import size limit')
  return file
}
export function encodeEditorText(text: string): Uint8Array {
  if (text.length > DOCUMENT_LIMITS.textLength) throw new Error('Mod exceeds the 96 Mi code-unit text limit')
  const bytes = new Uint8Array(text.length * 2), view = new DataView(bytes.buffer)
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true)
  return bytes
}
export function decodeEditorText(bytes: Uint8Array): string {
  if (bytes.length % 2) throw new Error('Truncated UTF-16 editor text')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), pieces: string[] = []
  // TextDecoder replaces lone surrogates; original code units must remain recoverable
  const chunk = EDITOR_TEXT_CHUNK_UNITS
  for (let at = 0; at < bytes.length; at += chunk * 2) {
    const units: number[] = []
    for (let i = at; i < Math.min(at + chunk * 2, bytes.length); i += 2) units.push(view.getUint16(i, true))
    pieces.push(String.fromCharCode(...units))
  }
  return pieces.join('')
}
export async function editorBlob(bytes: Uint8Array, encoding: WorkspaceBlobRef['encoding']): Promise<WorkspaceState['blobs'][number]> {
  const content = memoryBlob(bytes)
  return { ref: { documentId: crypto.randomUUID(), revisionId: crypto.randomUUID(), byteLength: bytes.length, sha256: await hashBlob(content), encoding }, content }
}
export async function readEditorContent(state: WorkspaceState, file: EditorWorkspaceDocument) {
  validateEditorContainer(file)
  const consumed = new Map<string, { bytes: Uint8Array; text: string }>()
  const read = async (ref: WorkspaceBlobRef) => {
    const identity = blobIdentity(ref), body = state.blobs.find(blob => blobIdentity(blob.ref) === identity)
    if (!body || JSON.stringify(body.ref) !== JSON.stringify(ref) || body.content.byteLength !== ref.byteLength) throw new Error('Exact editor content is unavailable')
    // Alias reuse belongs only to this read and follows complete declared-metadata comparison
    // Authenticate the collected bytes themselves; hashing then reopening duplicates IO and can observe different bytes
    const prior = consumed.get(identity)
    if (prior) return prior
    const bytes = await readBlob(verifiedBlob(body.content, ref.sha256), DOCUMENT_LIMITS.textLength * 2)
    const text = ref.encoding === 'utf16le' ? decodeEditorText(bytes) : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    const result = { bytes, text }
    consumed.set(identity, result)
    return result
  }
  const original = await read(file.original), applied = await read(file.lastApplied), unfinished = await read(file.unfinished.text)
  return { originalBytes: original.bytes, lastAppliedBytes: applied === original ? applied.bytes.slice() : applied.bytes, originalText: original.text, lastAppliedText: applied.text, unfinishedText: unfinished.text }
}
export async function retainEditorRevision(state: WorkspaceState, file: EditorWorkspaceDocument, retention: 'protected' | 'autosave-recovery'): Promise<WorkspaceState> {
  const root = await editorBlob(new TextEncoder().encode(JSON.stringify(file)), 'utf8')
  const refs = [...new Map([file.original, file.lastApplied, file.unfinished.text].map(ref => [blobIdentity(ref), ref])).values()]
  const entries: WorkspaceConflictClosureEntry[] = [{ version: 1, ref: root.ref, documentVersion: 1, kind: 'editor', key: JSON.stringify(['editor', file.id]), encoding: 'json', dependencies: refs }, ...refs.map(ref => ({ version: 1 as const, ref, documentVersion: 1 as const, kind: 'blob' as const, key: JSON.stringify(['blob', blobIdentity(ref)]), encoding: 'bytes' as const, dependencies: [] }))]
  const index = await editorBlob(new TextEncoder().encode(JSON.stringify({ version: 1, kind: 'conflict-closure-page', entries, children: [] })), 'utf8')
  return { ...state, blobs: [...state.blobs, root, index], retainedContent: [...state.retainedContent, { version: 1, kind: 'file-history', id: crypto.randomUUID(), fileKind: 'editor', documentId: file.id, retainedAt: new Date().toISOString(), retention, content: { version: 1, root: root.ref, index: index.ref } }] }
}
