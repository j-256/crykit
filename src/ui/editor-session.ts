import type { AppRoute } from './navigation'
import { EditorInputController, type EditorInputTicket, type EditorViewIncarnation } from '../workspace/editor-input-controller'
import type { EditorWorkspaceDocument } from '../workspace/documents'
import type { readEditorContent } from '../workspace/editor-document'
import type { OwnedFileCompletion, OwnedFileOperation, OwnedFileOutcome } from '../workspace/owned-file-command'
import type { ModEditorView } from './mod-workspace'
import type { ExpansionRule } from './mod-inspector/tree'

export interface OpenEditorDocument { readonly file: EditorWorkspaceDocument; readonly content: Awaited<ReturnType<typeof readEditorContent>> }
export interface EditorLibraryResult { readonly title: string; readonly unchanged: boolean; readonly warnings: readonly string[] }
export interface EditorSession {
  readonly controller: EditorInputController
  phase: 'idle' | 'staging' | 'reconciling' | 'hydrating' | 'recovery'
  transferView?: EditorViewIncarnation
  document?: OpenEditorDocument
  hydration?: { readonly view: EditorViewIncarnation; readonly completion: OwnedFileCompletion; readonly generation: number; confirmation?: Promise<void> }
  navigation?: { readonly destination: AppRoute; readonly sourceHash: string; readonly documentId?: string; readonly input: string }
  applyRequested?: { readonly documentId: string; readonly input: string }
  recovery?: { readonly outcome: OwnedFileOutcome; readonly ticket: EditorInputTicket; readonly file?: EditorWorkspaceDocument }
  libraryResult?: { readonly documentId: string; readonly revision: number; readonly result: EditorLibraryResult }
  scroll?: { readonly tab: ModEditorView; readonly x: number; readonly y: number; readonly mainLeft: number; readonly mainTop: number }
  // Same-file handoffs retain inert explorer context, never parsed nodes or retired callbacks
  explorer?: { readonly documentId: string; readonly expanded: readonly ExpansionRule[]; readonly treePages: ReadonlyMap<string, number>; readonly treeRowLimit: number; readonly query: string; readonly searchLimit: number; readonly optionQuery: string; readonly optionLimit: number }
  captureFocus?: () => void
}
export function createEditorSession(): EditorSession { return { controller: new EditorInputController(), phase: 'idle' } }
export interface EditorWorkspaceActions {
  readonly editorSession: EditorSession
  reopenEditorSavedVersion(view: EditorViewIncarnation, documentId: string): Promise<void>
  importEditorSource(preview: import('../interchange/types').ImportPreview, expected: { readonly id: string; readonly revision: number }, owner: symbol, result: EditorLibraryResult): Promise<void>
  beginEditorCommand(view: EditorViewIncarnation, operation: OwnedFileOperation): EditorInputTicket
  completeEditorCommand(outcome: OwnedFileOutcome, ticket: EditorInputTicket, file?: EditorWorkspaceDocument): Promise<void>
  captureEditorNavigation(destination: AppRoute, owner?: symbol): void
  retryEditorCommand(view: EditorViewIncarnation): Promise<void>
  confirmEditorHydration(view: EditorViewIncarnation): Promise<void>
  fileCommandPending(): boolean
  isCurrent(): boolean
}
