import type { AppRoute } from './navigation'
import { acquireAccountForeground } from '../account/background-work'
import type { ProfileToken } from '../account/profile'
import { EditorInputController, type EditorInputTicket, type EditorViewIncarnation } from '../workspace/editor-input-controller'
import type { EditorWorkspaceDocument } from '../workspace/documents'
import type { readEditorContent } from '../workspace/editor-document'
import type { OwnedFileCompletion, OwnedFileOperation, OwnedFileOutcome } from '../workspace/owned-file-command'
import type { ModEditorView } from './mod-workspace'
import type { ExpansionRule } from './mod-inspector/tree'

export interface OpenEditorDocument { readonly file: EditorWorkspaceDocument; readonly content: Awaited<ReturnType<typeof readEditorContent>> }
export interface EditorLibraryResult { readonly title: string; readonly unchanged: boolean; readonly warnings: readonly string[] }
export interface EditorHydration { readonly view: EditorViewIncarnation; readonly completion: OwnedFileCompletion; readonly generation: number; confirmation?: Promise<void> }
export interface EditorSession {
  readonly controller: EditorInputController
  phase: 'idle' | 'staging' | 'reconciling' | 'hydrating' | 'recovery'
  transferView?: EditorViewIncarnation
  autosaveForeground?: { view: EditorViewIncarnation; readonly release: () => void }
  command?: EditorInputTicket
  document?: OpenEditorDocument
  hydration?: EditorHydration
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

export class RetiredEditorCommandError extends Error {
  constructor(readonly ticket: EditorInputTicket, readonly outcome: OwnedFileOutcome) {
    super(outcome.status === 'saved' ? 'The captured draft was saved; its editor owner was retired' : 'The editor command owner was retired')
  }
}

export function releaseEditorAutosaveForeground(session: EditorSession, view: EditorViewIncarnation | undefined): void {
  const reservation = session.autosaveForeground
  if (!reservation || reservation.view !== view) return
  session.autosaveForeground = undefined
  reservation.release()
}

function ownsEditorView(session: EditorSession, view: EditorViewIncarnation): boolean {
  if (session.transferView !== view) return false
  try { session.controller.assertView(view); return true } catch { return false }
}

export function updateEditorAutosaveForeground(session: EditorSession, view: EditorViewIncarnation, token: ProfileToken | undefined, automatic: boolean): void {
  if (!ownsEditorView(session, view)) return
  if (!token || !automatic) { releaseEditorAutosaveForeground(session, view); return }
  const reservation = session.autosaveForeground
  if (session.controller.snapshot().dirty) {
    if (!reservation) session.autosaveForeground = { view, release: acquireAccountForeground(token) }
    return
  }
  // During a save, returning to the old baseline can still leave dirty input after acknowledgement
  if (session.phase !== 'idle' || reservation?.view !== view) return
  // Compound map events can briefly restore the durable input between synchronous field callbacks
  queueMicrotask(() => {
    if (session.autosaveForeground === reservation && ownsEditorView(session, view) && session.phase === 'idle' && !session.controller.snapshot().dirty) {
      releaseEditorAutosaveForeground(session, view)
    }
  })
}

export function transferEditorAutosaveForeground(session: EditorSession, from: EditorViewIncarnation, to: EditorViewIncarnation): void {
  // Move the captured lease so the worker never sees an idle edge during view replacement
  if (session.autosaveForeground?.view === from) session.autosaveForeground.view = to
}

export interface EditorWorkspaceActions {
  readonly editorSession: EditorSession
  reopenEditorSavedVersion(view: EditorViewIncarnation, documentId: string): Promise<void>
  importEditorSource(preview: import('../interchange/types').ImportPreview, expected: { readonly id: string; readonly revision: number }, owner: symbol, result: EditorLibraryResult): Promise<void>
  beginEditorCommand(view: EditorViewIncarnation, operation: OwnedFileOperation): EditorInputTicket
  completeEditorCommand(outcome: OwnedFileOutcome, ticket: EditorInputTicket, file?: EditorWorkspaceDocument): Promise<void>
  captureEditorNavigation(destination: AppRoute, owner?: symbol): void
  retryEditorCommand(view: EditorViewIncarnation): Promise<void>
  confirmEditorHydration(view: EditorViewIncarnation): Promise<void>
  reportEditorHandoffLoadFailure(): void
  fileCommandPending(): boolean
  isCurrent(): boolean
}
