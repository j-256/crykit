import { useMemo, useState } from 'react'
import { SaveEditorView as SaveContent } from './SaveEditorView'
import { createSaveSession, saveContentBase, type OpenSaveDocument, type SaveWorkspace } from './save-workspace'
import { parseSavePending } from '../workspace/save-pending'
import { emptySavePending, type SavePending } from '../workspace/save-input-controller'
import type { SaveWorkspaceDocument, WorkspaceBlobRef } from '../workspace/documents'
import { decodeCrystalSave } from '../interchange/crystal-save'
import { downloadBytes } from './model'
import type { LocalData } from '../domain/types'
import type { DraftChangeHandler } from './drafts'

// Native handler tests use an explicit volatile adapter; real provider/transaction tests live separately
export function SaveEditorView(props: { readonly localData?: LocalData; readonly onDraftChange?: DraftChangeHandler }) {
  const [generation, update] = useState(0)
  const shared = useMemo(() => ({ session: createSaveSession(), rows: new Map<string, OpenSaveDocument>() }), [])
  const storage = useMemo<SaveWorkspace>(() => {
    const session = shared.session, controller = session.controller, view = session.transferView ?? controller.attach()
    session.transferView = view
    const isCurrent = () => { try { controller.assertView(view); return true } catch { return false } }
    const ref = (bytes: Uint8Array): WorkspaceBlobRef => ({ documentId: crypto.randomUUID(), revisionId: crypto.randomUUID(), byteLength: bytes.length, sha256: '0'.repeat(64), encoding: 'bytes' })
    const install = (value: OpenSaveDocument, input: SavePending) => {
      controller.open(view, value.file.id, value.file.revision, saveContentBase(value.file), value.content.workingBytes, input)
      session.document = value; shared.rows.set(value.file.id, value)
      session.transferView = controller.transfer(view); update(version => version + 1)
    }
    return {
      controller, view, session, isCurrent, assertCurrent: () => controller.assertView(view), pending: () => false,
      beginSources: () => { controller.changeContext(view); return () => { if (isCurrent()) controller.changeContext(view) } },
      ready: async () => controller.hydrated(view), retry: async () => {},
      subscribe: () => () => {},
      list: async () => [...shared.rows.values()].map(value => value.file),
      open: async id => { const value = shared.rows.get(id)!; const parsed = parseSavePending(value.file.pendingForm); install(value, parsed.kind === 'supported' ? parsed.input : emptySavePending()); return value },
      importFile: async file => {
        const bytes = new Uint8Array(await file.arrayBuffer()), original = ref(bytes)
        let supported = true, diagnostic = ''
        try { decodeCrystalSave(bytes) } catch (error) { supported = false; diagnostic = error instanceof Error ? error.message : String(error) }
        const row: SaveWorkspaceDocument = { version: 1, id: crypto.randomUUID(), revision: 1, filename: file.name, original, working: original, pendingForm: null, requirements: [], coverage: { status: supported ? 'supported' : 'unsupported', diagnostics: supported ? [] : [diagnostic] }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', exportedRevision: null }
        install({ file: row, content: { originalBytes: bytes, workingBytes: bytes }, exportStatus: 'never' }, emptySavePending()); return row
      },
      save: async () => {
        const value = session.document!, input = controller.snapshot().input!
        const file = { ...value.file, revision: value.file.revision + 1, pendingForm: JSON.parse(JSON.stringify(input)) }
        install({ ...value, file }, input); return file
      },
      apply: async (bytes, input) => {
        const value = session.document!, file = { ...value.file, revision: value.file.revision + 1, working: ref(bytes), pendingForm: JSON.parse(JSON.stringify(input)) }
        install({ ...value, file, content: { ...value.content, workingBytes: bytes }, exportStatus: value.exportStatus === 'never' ? 'never' : 'changed' }, input); return file
      },
      remove: async () => { shared.rows.delete(session.document!.file.id) },
      downloadRecovery: async () => { throw new Error('Native fixture has no saved recovery receipt') },
      reloadRecovery: async () => { throw new Error('Native fixture has no saved recovery receipt') },
      download: async original => {
        const value = session.document!
        downloadBytes(original ? value.content.originalBytes : value.content.workingBytes, original ? `original-${value.file.filename}` : `${value.file.filename.replace(/\.sav$/i, '')}-edited.sav`)
        if (!original) install({ ...value, file: { ...value.file, revision: value.file.revision + 1, exportedRevision: value.file.revision }, exportStatus: 'requested' }, controller.snapshot().input!)
      },
    }
  }, [shared, generation])
  return <SaveContent {...props} key={generation} storage={storage}/>
}
