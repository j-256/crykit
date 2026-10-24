import { immutableHistory, validateHistoryEndpoint, validateHistoryEndpointShape } from './history-admission'
import { PlannerJournalSchema } from './planner-journal'
import { immutableCatalogSnapshot } from '../interchange/native'
import type { WorkspaceState } from './documents'
import { blobIdentity } from './blobs'
import type { WorkspaceBlobRef } from './file-types'
import { EditorWorkspaceDocumentSchema, SaveWorkspaceDocumentSchema, WorkspaceAssetSchema, WorkspaceBlobRefSchema, WorkspaceConflictSchema, WorkspaceRetainedContentSchema, LibraryDefaultsSchema } from './file-schemas'
import { NativeEvidenceSchema, NativeLineageSchema, NativeLocalDataSchema, NativeSourceManifestSchema } from '../interchange/native-schema'

export function validateWorkspace(state: WorkspaceState): void {
  const exactFields = (value: object, fields: readonly string[]) => { const keys = Object.keys(value); if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) throw new Error('Unknown or missing workspace container fields') }
  exactFields(state, ['planner', 'editorDocuments', 'saveDocuments', 'assets', 'libraryDefaults', 'conflicts', 'retainedContent', 'blobs'])
  exactFields(state.planner, ['localData', 'lineage', 'catalogs', 'evidence', 'sources', 'history', ...(state.planner.savedChanges ? ['savedChanges'] : []), ...(state.planner.journal ? ['journal'] : [])])
  if (state.planner.journal) {
    const { checkpoints, ...header } = state.planner.journal
    PlannerJournalSchema.omit({ checkpoints: true }).parse(header)
    if (!Array.isArray(checkpoints)) throw new Error('Invalid planner checkpoint collection')
    if (JSON.stringify(state.planner.journal.changes) !== JSON.stringify(state.planner.localData.changes)) throw new Error('Operative planner changes differ from journal')
    for (const entry of checkpoints) { immutableHistory(entry); validateHistoryEndpoint(entry.before, state.planner.catalogs); validateHistoryEndpoint(entry.after, state.planner.catalogs) }
  }
  if (state.planner.savedChanges) {
    if (new Set(state.planner.savedChanges.map(value => value.id)).size !== state.planner.savedChanges.length) throw new Error('Duplicate saved planner change')
    for (const value of state.planner.savedChanges) NativeLocalDataSchema.shape.changes.element.parse(value)
  }
  validateHistoryEndpointShape(state.planner.localData)
  NativeLineageSchema.parse(state.planner.lineage)
  for (const field of ['catalogs', 'sources', 'evidence', 'history'] as const) {
    const identities = new Set<string>()
    for (const value of state.planner[field]) { const key = JSON.stringify([value.id, ...('revisionId' in value ? [value.revisionId] : [])]); if (identities.has(key)) throw new Error('Duplicate planner identity'); identities.add(key) }
  }
  for (const catalog of state.planner.catalogs) immutableCatalogSnapshot(catalog)
  for (const evidence of state.planner.evidence) NativeEvidenceSchema.parse(evidence)
  for (const history of state.planner.history) {
    immutableHistory(history)
    validateHistoryEndpoint(history.before, state.planner.catalogs)
    validateHistoryEndpoint(history.after, state.planner.catalogs)
  }
  for (const source of state.planner.sources) { const { original, ...metadata } = source; NativeSourceManifestSchema.omit({ path: true, size: true }).parse(metadata); WorkspaceBlobRefSchema.parse(original) }
  LibraryDefaultsSchema.parse(state.libraryDefaults)
  for (const [values, schema] of [[state.editorDocuments, EditorWorkspaceDocumentSchema], [state.saveDocuments, SaveWorkspaceDocumentSchema], [state.assets, WorkspaceAssetSchema], [state.conflicts, WorkspaceConflictSchema], [state.retainedContent, WorkspaceRetainedContentSchema]] as const) {
    const ids = new Set<string>()
    for (const value of values) { schema.parse(value); if (ids.has(value.id)) throw new Error('Duplicate workspace identity'); ids.add(value.id) }
  }
  validateHistoryEndpoint(state.planner.localData, state.planner.catalogs)
  if (!Array.isArray(state.conflicts) || !Array.isArray(state.retainedContent) || state.libraryDefaults.version !== 1) throw new Error('Unsupported workspace version')
  const refs = new Map<string, WorkspaceBlobRef>()
  for (const { ref, content } of state.blobs) {
    WorkspaceBlobRefSchema.parse(ref)
    const key = blobIdentity(ref)
    if (refs.has(key)) throw new Error('Duplicate blob reference')
    refs.set(key, ref)
    if (content.byteLength !== ref.byteLength || typeof content.open !== 'function') throw new Error('Blob length mismatch')
  }
  const requireRef = (ref: WorkspaceBlobRef) => { if (JSON.stringify(refs.get(blobIdentity(ref))) !== JSON.stringify(ref)) throw new Error('Missing or contradictory blob reference') }
  for (const source of state.planner.sources) { requireRef(source.original); if (source.original.sha256 !== source.digest) throw new Error('Source digest mismatch') }
  for (const file of state.editorDocuments) {
    if (file.version !== 1 || file.unfinished.text.encoding !== 'utf16le' || (file.originalByteIdentity === 'text-only' && file.original.encoding !== 'utf16le')) throw new Error('Unsupported editor document')
    requireRef(file.original); requireRef(file.lastApplied); requireRef(file.unfinished.text)
  }
  for (const file of state.saveDocuments) { if (file.version !== 1) throw new Error('Unsupported save document'); requireRef(file.original); requireRef(file.working) }
  for (const asset of state.assets) { if (asset.version !== 1) throw new Error('Unsupported asset'); requireRef(asset.original); if (asset.thumbnail) requireRef(asset.thumbnail) }
  const closure = (value: { version: 1; root: WorkspaceBlobRef; index: WorkspaceBlobRef }) => { if (value.version !== 1) throw new Error('Unsupported closure'); requireRef(value.root); requireRef(value.index) }
  for (const conflict of state.conflicts) {
    if (conflict.version !== 1 || conflict.branches.length !== 2 || conflict.branches[0].role !== 'local-pending' || conflict.branches[1].role !== 'accepted-cloud') throw new Error('Unsupported conflict')
    if (conflict.commonAncestor.kind === 'present') closure(conflict.commonAncestor.closure)
    for (const branch of conflict.branches) closure(branch.closure)
    if (conflict.disposition.kind === 'resolved') closure(conflict.disposition.result)
  }
  for (const content of state.retainedContent) {
    if (content.version !== 1) throw new Error('Unsupported retained content')
    if (content.kind === 'file-history') closure(content.content)
    else { if (content.base.kind === 'present') closure(content.base.closure); closure(content.target) }
  }
}
