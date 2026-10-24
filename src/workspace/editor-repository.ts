import type { JsonValue } from '../domain/types'
import type { JsonPath } from '../mod-inspector/types'
import { parseDocument } from '../mod-inspector/document'
import { deriveInspectorFileInfo, withInspectorInputFileInfo } from '../mod-inspector/file-info'
import { MAX_MOD_SOURCE_BYTES } from '../domain/mod-library'
import type { WorkspaceRepository } from './repository'
import type { EditorWorkspaceDocument, WorkspaceState } from './documents'
import { editorBlob, encodeEditorText, readEditorContent, retainEditorRevision, validateEditorContainer } from './editor-document'
import { captureLegacyBranch, holdLegacyReaders, readLegacyCapture } from './legacy-capture'
import { equalLegacyValue } from './legacy-value'
import { commitOwnedFile, registerOwnedInspectorCheck, newOwnedFileCommand, type OwnedFileCommand, type OwnedFileOperation, type OwnedFileOutcome } from './owned-file-command'
import { guestInspectorFor, guestRepositoryBindings, usesManagedGuestStorage } from './guest-repository'

export interface UnfinishedEditorInput { readonly text: string; readonly editedPath: JsonPath; readonly fieldState: JsonValue; readonly validation: 'valid' | 'invalid' | 'unchecked' }
export type EditorInitialTab = 'document' | 'map'
export interface EditorRepository {
  list(): Promise<readonly EditorWorkspaceDocument[]>
  get(id: string): Promise<EditorWorkspaceDocument | undefined>
  importFile(input: { filename: string; bytes?: Uint8Array; text: string; referenceId: string; initialTab?: EditorInitialTab }): Promise<EditorWorkspaceDocument>
  saveUnfinished(id: string, input: UnfinishedEditorInput, expectedRevision: number): Promise<EditorWorkspaceDocument>
  applyDraft(id: string, expectedRevision: number): Promise<EditorWorkspaceDocument>
  remove(id: string, expectedRevision: number): Promise<void>
}
export interface EditorCommandHooks {
  readonly begin?: (operation: OwnedFileOperation) => OwnedFileCommand
  readonly onOutcome?: (outcome: OwnedFileOutcome, document?: EditorWorkspaceDocument) => void | Promise<void>
}
export function createEditorRepository(repository: WorkspaceRepository, hooks: EditorCommandHooks = {}): EditorRepository & { read(id: string): Promise<{ file: EditorWorkspaceDocument; content: Awaited<ReturnType<typeof readEditorContent>> } | undefined> } {
  async function capture(legacyId?: string, ticket?: OwnedFileCommand): Promise<{ before: WorkspaceState; state: WorkspaceState }> {
    const before = await repository.readWorkspace()
    if (repository.kind !== 'guest' || await usesManagedGuestStorage(repository)) return { before, state: before }
    // Migration is prepared in memory and activates with the same full guest journal on the first command
    // Legacy chunks are never cleared, and failed preparation leaves their original recovery branch intact
    const storage = await guestInspectorFor(repository)
    let state = before
    let checkCapture: ((storage: import('../mod-inspector/storage').InspectorStorage) => Promise<void>) | undefined
    if (ticket) {
      const binding = await guestRepositoryBindings(repository)
      const original = await captureLegacyBranch(binding.coordinator, [{ kind: 'inspector', database: await storage.openDatabase() }])
      checkCapture = async target => {
        const held = await holdLegacyReaders([{ kind: 'inspector', database: await target.openDatabase() }])
        const records = readLegacyCapture(binding.coordinator, original)[Symbol.asyncIterator]()
        try {
          if (!equalLegacyValue(held.readers[0].tables, original.participants[0].tables)) throw new Error('Legacy editor tables changed during migration')
          await held.scan(async record => {
            const saved = await records.next()
            if (saved.done) throw new Error('Legacy editor gained rows during migration')
            const { captureId: _capture, ordinal: _ordinal, ...expected } = saved.value
            // Compare complete persisted values, including unknown metadata and exact UTF-16 chunks
            if (!equalLegacyValue(expected, record)) throw new Error('Legacy editor changed during migration')
          })
          if (!(await records.next()).done) throw new Error('Legacy editor lost rows during migration')
        } finally { await records.return?.(); await held.release() }
      }
      registerOwnedInspectorCheck(ticket, checkCapture)
    }
    for (const summary of await storage.list()) {
      if (legacyId && summary.id !== legacyId) continue
      if (state.editorDocuments.some(row => row.id === summary.id) || state.retainedContent.some(row => row.kind === 'file-history' && row.documentId === summary.id && row.fileKind === 'editor')) continue
      const legacy = await storage.get(summary.id)
      if (!legacy) { if (legacyId) continue; throw new Error('Legacy editor changed during migration') }
      const original = await editorBlob(encodeEditorText(legacy.originalText), 'utf16le'), applied = await editorBlob(encodeEditorText(legacy.draftText), 'utf16le')
      const row: EditorWorkspaceDocument = { version: 1, id: legacy.id, revision: legacy.revision, filename: legacy.filename, referenceId: legacy.referenceId, original: original.ref, originalByteIdentity: 'text-only', lastApplied: applied.ref, unfinished: { text: applied.ref, editedPath: [], fieldState: legacy.fileInfo ? withInspectorInputFileInfo(null, legacy.fileInfo) : null, baseRevision: legacy.revision, validation: 'valid' }, createdAt: legacy.createdAt, updatedAt: legacy.updatedAt }
      state = { ...state, editorDocuments: [...state.editorDocuments, row], blobs: [...state.blobs, original, applied] }
    }
    await checkCapture?.(storage)
    return { before, state }
  }
  const command = (operation: OwnedFileOperation) => hooks.begin?.(operation) ?? newOwnedFileCommand(operation)
  async function finish(before: WorkspaceState, next: WorkspaceState, ticket: OwnedFileCommand, document?: EditorWorkspaceDocument) {
    const outcome = await commitOwnedFile(repository, before, next, ticket)
    await hooks.onOutcome?.(outcome, document)
    if (outcome.status !== 'saved') throw outcome.error ?? new Error('The file command needs reconciliation before retry')
  }
  function selected(state: WorkspaceState, id: string, revision: number) {
    const file = state.editorDocuments.find(row => row.id === id)
    if (!file || file.revision !== revision) throw new Error('The saved editor revision changed. Keep your draft and reopen it.')
    return validateEditorContainer(file)
  }
  return {
    read: async id => { const { state } = await capture(id); const file = state.editorDocuments.find(row => row.id === id); return file ? { file, content: await readEditorContent(state, file) } : undefined },
    list: async () => (await capture()).state.editorDocuments,
    get: async id => (await capture(id)).state.editorDocuments.find(row => row.id === id),
    importFile: async input => {
      const ticket = command('import')
      const bytes = input.bytes?.slice(), { text, filename, referenceId, initialTab } = input
      if (bytes && bytes.length > MAX_MOD_SOURCE_BYTES) throw new Error('Mod exceeds the 96 MiB import size limit')
      const parsed = parseDocument(text)
      if (bytes && new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== text) throw new Error('Imported bytes do not match the selected text')
      const { before, state } = await capture(undefined, ticket), original = await editorBlob(bytes ?? encodeEditorText(text), bytes ? 'bytes' : 'utf16le'), applied = await editorBlob(encodeEditorText(text), 'utf16le')
      const timestamp = new Date().toISOString()
      // The owned successor may remount before the caller resumes, so capture its inert starting tab in this same import
      const row: EditorWorkspaceDocument = { version: 1, id: crypto.randomUUID(), revision: 1, filename, referenceId, original: original.ref, originalByteIdentity: bytes ? 'exact' : 'text-only', lastApplied: applied.ref, unfinished: { text: applied.ref, editedPath: [], fieldState: withInspectorInputFileInfo(initialTab ? { tab: initialTab } : null, deriveInspectorFileInfo(parsed, false)), baseRevision: 1, validation: 'valid' }, createdAt: timestamp, updatedAt: timestamp }
      validateEditorContainer(row)
      await finish(before, { ...state, editorDocuments: [...state.editorDocuments, row], blobs: [...state.blobs, original, applied] }, ticket, row)
      return row
    },
    saveUnfinished: async (id, input, revision) => {
      const ticket = command('saveUnfinished'), frozen = structuredClone(input)
      ticket.assertInput?.(id, revision, frozen)
      const { before, state } = await capture(undefined, ticket), file = selected(state, id, revision)
      const body = await editorBlob(encodeEditorText(frozen.text), 'utf16le')
      const row: EditorWorkspaceDocument = { ...file, revision: file.revision + 1, updatedAt: new Date().toISOString(), unfinished: { text: body.ref, editedPath: frozen.editedPath, fieldState: frozen.fieldState, validation: frozen.validation, baseRevision: file.unfinished.baseRevision } }
      validateEditorContainer(row)
      const retained = await retainEditorRevision(state, file, 'autosave-recovery')
      await finish(before, { ...retained, editorDocuments: retained.editorDocuments.map(value => value.id === id ? row : value), blobs: [...retained.blobs, body] }, ticket, row)
      return row
    },
    applyDraft: async (id, revision) => {
      const ticket = command('apply')
      ticket.assertInput?.(id, revision)
      const { before, state } = await capture(undefined, ticket), file = selected(state, id, revision)
      const content = await readEditorContent(state, file)
      const parsed = parseDocument(content.unfinishedText)
      const fields = file.unfinished.fieldState
      const appliedFields = fields && typeof fields === 'object' && !Array.isArray(fields) && 'editorDirty' in fields ? { ...fields, editorDirty: false, workingText: content.unfinishedText } : fields
      // Only validated Apply updates the label; unfinished input is not an applied file version
      const fieldState = withInspectorInputFileInfo(appliedFields, deriveInspectorFileInfo(parsed, content.unfinishedText !== content.originalText))
      const row: EditorWorkspaceDocument = { ...file, revision: revision + 1, lastApplied: file.unfinished.text, updatedAt: new Date().toISOString(), unfinished: { ...file.unfinished, fieldState, baseRevision: revision + 1, validation: 'valid' } }
      const retained = await retainEditorRevision(state, file, 'protected')
      await finish(before, { ...retained, editorDocuments: retained.editorDocuments.map(value => value.id === id ? row : value) }, ticket, row)
      return row
    },
    remove: async (id, revision) => {
      const ticket = command('remove')
      ticket.assertInput?.(id, revision)
      const { before, state } = await capture(undefined, ticket), file = selected(state, id, revision)
      const retained = await retainEditorRevision(state, file, 'protected')
      await finish(before, { ...retained, editorDocuments: retained.editorDocuments.filter(value => value.id !== id) }, ticket)
    },
  }
}
