import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile } from '../../account/profile'
import { editorClosureFixture } from '../../workspace/test-helpers'
import { memoryBlob } from '../../workspace/blobs'
import type { WorkspaceDocument } from '../../workspace/documents'
import * as browserActions from '../browser-actions'
import { ConflictFileVersion } from './ConflictFileVersion'
let root: Root, container: HTMLDivElement
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); invalidateProfile(); vi.restoreAllMocks() })
it('downloadsExactBinaryHistoryWithoutMarkingTheWorkingSaveExported', async () => {
  const token = installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32)), fixture = await editorClosureFixture()
  const bytes = new Uint8Array([0, 255, 3, 128]), ref = await fixture.add(bytes, 'binary', 'bytes')
  const save = { version: 1, id: 'save-1', revision: 4, filename: 'SAVE.sav', original: ref, working: ref, pendingForm: null, requirements: [], coverage: { status: 'unsupported', diagnostics: ['Unknown native field'] }, createdAt: '2026-01-01', updatedAt: '2026-01-02', exportedRevision: null }
  const document: WorkspaceDocument = { version: 1, kind: 'save', key: '["save","save-1"]', value: save as unknown as WorkspaceDocument['value'] }
  let downloaded: Uint8Array | undefined
  const download = vi.spyOn(browserActions, 'downloadBytes').mockImplementation(value => { downloaded = value.slice() })
  await act(async () => root.render(<ConflictFileVersion token={token} documents={[document]} blobs={fixture.blobs} version="pending"/>))
  expect(container.textContent).toContain('Revision 4'); expect(container.textContent).toContain('Unknown native field')
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Download original file')!.click())
  await act(async () => { await vi.waitFor(() => expect(download).toHaveBeenCalledOnce()) }); expect(downloaded).toEqual(bytes); expect(save.exportedRevision).toBeNull()
})
it('profileChangeDuringContentReadCannotDisplayOrDownloadTheOldAccountsBytes', async () => {
  const token = installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32)), fixture = await editorClosureFixture()
  let release!: () => void, entered!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve }), reading = new Promise<void>(resolve => { entered = resolve })
  const blobs = [{ ref: fixture.file.original, content: { byteLength: 2, async *open() { entered(); await waiting; yield new Uint8Array([0, 216]) } } }]
  const download = vi.spyOn(browserActions, 'downloadBytes').mockImplementation(() => {})
  const document: WorkspaceDocument = { version: 1, kind: 'editor', key: '["editor","editor-1"]', value: fixture.file as unknown as WorkspaceDocument['value'] }
  await act(async () => root.render(<ConflictFileVersion token={token} documents={[document]} blobs={blobs} version="accepted"/>))
  expect(container.textContent).toContain('original file bytes are unavailable')
  await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Download saved draft')!.click(); await reading; installProfile('BBBBBBBBBBBBBBBBBBBBBA', new Uint8Array(32)); release() })
  expect(download).not.toHaveBeenCalled(); expect(container.querySelector('pre')).toBeNull()
})
it('previewLimitFailsVisiblyWithoutOpeningAnOversizedSource', async () => {
  const token = installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32)), fixture = await editorClosureFixture()
  const ref = { ...fixture.file.original, byteLength: 65538 }, file = { ...fixture.file, unfinished: { ...fixture.file.unfinished, text: ref } }
  const open = vi.fn(memoryBlob(new Uint8Array()).open)
  const document: WorkspaceDocument = { version: 1, kind: 'editor', key: '["editor","editor-1"]', value: file as unknown as WorkspaceDocument['value'] }
  await act(async () => root.render(<ConflictFileVersion token={token} documents={[document]} blobs={[{ ref, content: { byteLength: ref.byteLength, open } }]} version="pending"/>))
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Inspect saved draft')!.click())
  expect(open).not.toHaveBeenCalled(); expect(container.querySelector('[role="alert"]')?.textContent).toContain('64 KiB')
})
