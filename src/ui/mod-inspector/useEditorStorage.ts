import { guestInspectorFor, usesManagedGuestStorage } from '../../workspace/guest-repository'
import { useMemo } from 'react'
import { createEditorRepository, type EditorInitialTab } from '../../workspace/editor-repository'
import { useWorkspace } from '../WorkspaceProvider'
import type { InspectorDraft } from '../../mod-inspector/types'
import type { OpenEditorDocument } from '../editor-session'
import type { EditorInputTicket } from '../../workspace/editor-input-controller'
import { inspectorInputFileInfo } from '../../mod-inspector/file-info'

export function inspectorDraft(opened: OpenEditorDocument): InspectorDraft {
  const { file, content } = opened
  return { schemaVersion: 1, id: file.id, filename: file.filename, referenceId: file.referenceId, createdAt: file.createdAt, updatedAt: file.updatedAt, revision: file.revision, fileInfo: inspectorInputFileInfo(file.unfinished.fieldState), originalText: content.originalText, originalBytes: file.originalByteIdentity === 'exact' ? content.originalBytes : undefined, draftText: content.lastAppliedText, unfinished: { text: content.unfinishedText, editedPath: file.unfinished.editedPath, fieldState: file.unfinished.fieldState, validation: file.unfinished.validation } }
}
export function useEditorStorage() {
  const workspace = useWorkspace(), { repository, editorSession: session } = workspace
  return useMemo(() => {
    const controller = session.controller
    const view = session.transferView ?? controller.attach()
    session.transferView = view
    const openedRows = new WeakMap<InspectorDraft, OpenEditorDocument>()
    let ticket: EditorInputTicket | undefined
    let delivered = false
    const editor = createEditorRepository(repository, {
      begin: operation => { ticket = workspace.beginEditorCommand(view, operation); delivered = false; return ticket.command },
      onOutcome: async (outcome, file) => { delivered = true; await workspace.completeEditorCommand(outcome, ticket!, file) },
    })
    async function write<T>(operation: () => Promise<T>): Promise<T> {
      try { return await operation() }
      catch (error) {
        if (!delivered && ticket) { delivered = true; await workspace.completeEditorCommand({ status: 'not-saved', error }, ticket).catch(() => {}) }
        throw error
      }
    }
    return {
      controller, view, session,
      isCurrent: () => { try { controller.assertView(view); return workspace.isCurrent() } catch { return false } },
      ready: () => workspace.confirmEditorHydration(view),
      retry: () => workspace.retryEditorCommand(view),
      reopen: (id: string) => workspace.reopenEditorSavedVersion(view, id),
      pending: workspace.fileCommandPending,
      list: async () => {
        const state = await repository.readWorkspace()
        // Listing uses admitted encrypted metadata rather than opening every private file body
        const modern = state.editorDocuments.map(file => ({ schemaVersion: 1 as const, ...file, fileInfo: inspectorInputFileInfo(file.unfinished.fieldState) }))
        if (repository.kind !== 'guest' || await usesManagedGuestStorage(repository)) return modern
        const legacy = await (await guestInspectorFor(repository)).list()
        return [...modern, ...legacy.filter(row => !modern.some(file => file.id === row.id) && !state.retainedContent.some(item => item.kind === 'file-history' && item.documentId === row.id && item.fileKind === 'editor'))]
      },
      get: async (id: string) => {
        const value = await editor.read(id)
        if (!value) return undefined
        const row = inspectorDraft(value); openedRows.set(row, value); return row
      },
      remember: (row: InspectorDraft) => { const opened = openedRows.get(row); if (opened) session.document = opened },
      import: async (filename: string, text: string, referenceId: string, bytes?: Uint8Array, initialTab?: EditorInitialTab) => {
        await write(() => editor.importFile({ filename, text, referenceId, bytes, initialTab }))
        return inspectorDraft(session.document!)
      },
      save: async (id: string, revision: number) => {
        const input = controller.snapshot().input
        if (!input) throw new Error('The editor has no captured input')
        await write(() => editor.saveUnfinished(id, input, revision))
        return inspectorDraft(session.document!)
      },
      apply: (id: string, revision: number) => write(() => editor.applyDraft(id, revision)),
      remove: (id: string, revision: number) => write(() => editor.remove(id, revision)),
    }
  }, [repository])
}
