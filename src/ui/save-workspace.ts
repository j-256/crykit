import { collectRecoveryCopy, writeRecoveryCopy, RECOVERY_FALLBACK_BYTES, type SaveRecoverySink } from '../workspace/save-recovery'
import { useMemo, useReducer } from 'react'
import type { AppRoute } from './navigation'
import { useWorkspace } from './WorkspaceProvider'
import { SaveInputController, emptySavePending, savePendingJson, type SaveInputTicket, type SaveViewIncarnation, type SaveContentBase, type SavePending } from '../workspace/save-input-controller'
import { parseSavePending } from '../workspace/save-pending'
import { createSaveRepository, readSaveContent, saveExportStatus, type SaveOperation } from '../workspace/save-repository'
import type { SaveWorkspaceDocument } from '../workspace/documents'
import type { OwnedFileCompletion, OwnedFileOutcome } from '../workspace/owned-file-command'
import type { SaveEditorModSource } from '../domain/save-editor-mods'
import type { CrystalSave } from '../interchange/crystal-save'
import { assertActiveProfile, trackProfileUrl } from '../account/profile'

const DOWNLOAD_URL_LIFETIME_MS = 1_000

export interface OpenSaveDocument { readonly file: SaveWorkspaceDocument; readonly content: Awaited<ReturnType<typeof readSaveContent>>; readonly exportStatus: Awaited<ReturnType<typeof saveExportStatus>> }
export interface SaveSession {
  readonly controller: SaveInputController
  // A discrete choice may arrive during publication and must flush after the successor hydrates
  immediateInputSave?: boolean
  // The typing pause belongs to the input, so ownership transfers must not restart it
  inputSaveDeadline?: { readonly input: SavePending; readonly at: number }
  operation?: SaveOperation
  phase: 'idle' | 'staging' | 'reconciling' | 'hydrating' | 'recovery'
  transferView?: SaveViewIncarnation
  document?: OpenSaveDocument
  hydration?: { readonly view: SaveViewIncarnation; readonly completion: OwnedFileCompletion; readonly generation: number; confirmation?: Promise<void> }
  navigation?: { readonly destination: AppRoute; readonly sourceHash: string; readonly documentId?: string; readonly input: string }
  recovery?: { readonly outcome: OwnedFileOutcome; readonly ticket: SaveInputTicket; readonly file?: SaveWorkspaceDocument }
  readonly sourceReads: Set<symbol>
  sources: readonly SaveEditorModSource[]
  candidate?: { readonly base: string; readonly draft: CrystalSave }
  captureFocus?: () => void
}
export function createSaveSession(): SaveSession { return { controller: new SaveInputController(), sources: [], sourceReads: new Set(), phase: 'idle' } }
export function saveContentBase(file: SaveWorkspaceDocument): SaveContentBase { return { original: JSON.stringify(file.original), working: JSON.stringify(file.working), requirements: JSON.stringify(file.requirements), coverage: JSON.stringify(file.coverage), marker: JSON.stringify(file.exportedRevision), context: JSON.stringify(file.pendingForm && typeof file.pendingForm === 'object' && !Array.isArray(file.pendingForm) ? 'context' in file.pendingForm ? file.pendingForm.context : null : null) } }
export interface SaveWorkspaceActions {
  readonly saveSession: SaveSession
  beginSaveCommand(view: SaveViewIncarnation, operation: SaveOperation): SaveInputTicket
  completeSaveCommand(outcome: OwnedFileOutcome, ticket: SaveInputTicket, file?: SaveWorkspaceDocument): Promise<void>
  captureSaveNavigation(destination: AppRoute, owner?: symbol): void
  retrySaveCommand(view: SaveViewIncarnation): Promise<void>
  confirmSaveHydration(view: SaveViewIncarnation): Promise<void>
  prepareSaveRecovery(view: SaveViewIncarnation): Promise<{ readonly copy: import('../workspace/save-recovery').SaveRecoveryCopy; readonly verify: () => Promise<void>; readonly assertCurrent: () => void }>
  reloadSaveRecovery(view: SaveViewIncarnation, confirmDiscard: () => boolean): Promise<void>
}
export function useSaveWorkspace() {
  const workspace = useWorkspace(), { repository, saveSession: session } = workspace
  const [, refresh] = useReducer(value => value + 1, 0)
  return useMemo(() => {
    const controller = session.controller, view = session.transferView ?? controller.attach()
    session.transferView = view
    const isCurrent = () => { try { controller.assertView(view); return workspace.isCurrent() } catch { return false } }
    let opening = 0
    const assertCurrent = () => { if (!isCurrent()) throw new Error('This Save workspace was retired'); if (workspace.token) assertActiveProfile(workspace.token) }
    async function run<T>(operation: SaveOperation, execute: (saves: ReturnType<typeof createSaveRepository>, ticket: SaveInputTicket) => Promise<T>, nativeIntent?: 'vanilla' | 'reset-original'): Promise<T> {
      // Capture before file reads, hashing, decoding or browser initiation; the repository cannot recapture a newer input
      session.captureFocus?.()
      const ticket = workspace.beginSaveCommand(view, operation)
      refresh()
      let delivered = false
      const saves = createSaveRepository(repository, { sources: session.sources, nativeIntent, ...(operation === 'saveApply' ? { intent: 'saveApply' as const } : {}), begin: actual => { if (actual !== operation) throw new Error('Save command classification changed'); return ticket.command }, onOutcome: async (outcome, file) => { delivered = true; await workspace.completeSaveCommand(outcome, ticket, file) } })
      try { return await execute(saves, ticket) }
      catch (error) { if (!delivered) await workspace.completeSaveCommand({ status: 'not-saved', error }, ticket).catch(() => {}); if (isCurrent()) refresh(); throw error }
    }
    return {
      controller, view, session, isCurrent, assertCurrent, pending: workspace.fileCommandPending,
      beginSources: () => {
        assertCurrent()
        if (workspace.fileCommandPending()) throw new Error('Finish saving before changing Save definitions')
        controller.changeContext(view)
        const read = Symbol('save-source-read'); session.sourceReads.add(read)
        return () => { if (isCurrent()) { controller.changeContext(view); session.sourceReads.delete(read) } }
      },
      ready: () => workspace.confirmSaveHydration(view), retry: () => workspace.retrySaveCommand(view),
      subscribe: (listener: () => void) => repository.subscribe(() => { if (isCurrent()) listener() }),
      list: async () => { const result = await createSaveRepository(repository).list(); assertCurrent(); return result },
      open: async (id: string) => {
        const request = ++opening
        assertCurrent()
        if (session.sourceReads.size) throw new Error('Finish reading Save definitions before opening another document')
        if (controller.snapshot().dirty || workspace.fileCommandPending()) throw new Error('Save unfinished input before opening another document')
        const state = await repository.readWorkspace(); assertCurrent()
        const file = state.saveDocuments.find(value => value.id === id)
        if (!file) throw new Error('Saved document is unavailable')
        const content = await readSaveContent(state, file), exportStatus = await saveExportStatus(state, file); assertCurrent()
        if (request !== opening || controller.snapshot().dirty || workspace.fileCommandPending() || session.sourceReads.size) throw new Error('Save input changed while opening')
        const parsed = parseSavePending(file.pendingForm)
        controller.open(view, file.id, file.revision, saveContentBase(file), content.workingBytes, parsed.kind === 'supported' ? parsed.input : emptySavePending())
        session.document = { file, content, exportStatus }; session.sources = []; session.candidate = undefined
        return session.document
      },
      importFile: (file: File) => run('saveImport', async saves => { const bytes = new Uint8Array(await file.arrayBuffer()); assertCurrent(); return saves.importFile(file.name, bytes) }),
      save: () => run('savePending', (saves, ticket) => {
        if (!session.document || !ticket.documentId || ticket.revision === undefined || !ticket.input) throw new Error('Open a Save before saving input')
        return saves.saveWorking(ticket.documentId, session.document.content.workingBytes, savePendingJson(ticket.input), ticket.revision)
      }),
      apply: (bytes: Uint8Array, input: import('../workspace/save-input-controller').SavePending, nativeIntent?: 'vanilla' | 'reset-original') => run('saveApply', (saves, ticket) => saves.saveWorking(ticket.documentId!, bytes, savePendingJson(input), ticket.revision!), nativeIntent),
      remove: () => run('saveRemove', (saves, ticket) => saves.remove(ticket.documentId!, ticket.revision!)),
      reloadRecovery: (confirmDiscard: () => boolean) => workspace.reloadSaveRecovery(view, confirmDiscard),
      downloadRecovery: async () => {
        assertCurrent()
        const saved = session.recovery?.file
        if (!saved) throw new Error('An exact saved recovery file is unavailable')
        const picker = (window as unknown as { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<SaveRecoverySink> }> }).showSaveFilePicker
        const filename = `${saved.filename}-recovery.jsonl`
        if (!picker && Math.ceil((saved.original.byteLength + saved.working.byteLength) * 4 / 3) > RECOVERY_FALLBACK_BYTES) throw new Error('Use a browser with streamed file saving for this recovery copy. Keep this tab open.')
        // Open the user gesture-bound picker before asynchronous repository verification
        const handle = picker ? await picker.call(window, { suggestedName: filename }) : undefined
        const recovery = await workspace.prepareSaveRecovery(view)
        recovery.assertCurrent()
        if (handle) {
          const sink = await handle.createWritable()
          try { await recovery.verify(); recovery.assertCurrent() } catch (error) { await sink.abort().catch(() => {}); throw error }
          await writeRecoveryCopy(recovery.copy, sink, recovery.assertCurrent)
          await recovery.verify()
        } else {
          const bytes = await collectRecoveryCopy(recovery.copy, recovery.assertCurrent)
          await recovery.verify(); recovery.assertCurrent()
          const urls = URL
          const url = urls.createObjectURL(new Blob([bytes.slice().buffer], { type: 'application/x-ndjson' }))
          try { if (workspace.token) trackProfileUrl(workspace.token, url); recovery.assertCurrent(); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click() }
          catch (error) { urls.revokeObjectURL(url); throw error }
          window.setTimeout(() => urls.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS)
        }
      },
      download: async (original: boolean) => {
        const opened = session.document
        if (!opened) throw new Error('Open a Save before downloading')
        const initiate = () => {
          assertCurrent()
          const bytes = original ? opened.content.originalBytes : opened.content.workingBytes
          // Cleanup can outlive the calling view and must use the allocator that owns this URL
          const urls = URL
          const url = urls.createObjectURL(new Blob([bytes.slice().buffer], { type: 'application/octet-stream' }))
          try { if (workspace.token) trackProfileUrl(workspace.token, url); assertCurrent(); const anchor = document.createElement('a'); anchor.href = url; anchor.download = original ? `original-${opened.file.filename}` : `${opened.file.filename.replace(/\.sav$/i, '')}-edited.sav`; anchor.click() }
          catch (error) { urls.revokeObjectURL(url); throw error }
          window.setTimeout(() => urls.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS)
        }
        if (original) { initiate(); return }
        let initiated = false
        try { await run('saveExport', async saves => { initiate(); initiated = true; return saves.markExported(opened.file.id, opened.file.revision) }) }
        catch (error) { throw new Error(`${initiated ? 'Download requested; its marker was not confirmed.' : 'Download could not start.'} ${error instanceof Error ? error.message : String(error)}`) }
      },
    }
  }, [repository])
}
export type SaveWorkspace = ReturnType<typeof useSaveWorkspace>
