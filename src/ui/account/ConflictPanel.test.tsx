import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile } from '../../account/profile'
import { editorClosureFixture } from '../../workspace/test-helpers'
import * as actions from '../../workspace/conflicts'
import * as status from '../../account/sync/conflict-status'
import type { WorkspaceConflict, WorkspaceState } from '../../workspace/documents'
import { ConflictPanel } from './ConflictPanel'
import { blobIdentity } from '../../workspace/blobs'
let root: Root, container: HTMLDivElement
beforeEach(() => { vi.spyOn(status, 'publishedSupersededConflicts').mockResolvedValue(new Set()); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); invalidateProfile(); vi.restoreAllMocks() })
it('comparesStableOriginsAndKeepsBothVisibleWhenChoiceIsStale', async () => {
  const token = installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32))
  const fixture = await editorClosureFixture()
  const otherRoot = await fixture.add({ ...fixture.file, filename: 'other.json' }, 'other-root')
  const otherIndex = await fixture.add({ version: 1, kind: 'conflict-closure-page', children: [], entries: fixture.entries.map((entry, index) => index ? entry : { ...entry, ref: otherRoot }) }, 'other-index')
  const conflict: WorkspaceConflict = { version: 1, id: 'opaque-conflict', unit: { kind: 'record', privateKey: '["editor","editor-1"]' }, commonAncestor: { kind: 'present', closure: fixture.closure }, branches: [{ role: 'local-pending', closure: fixture.closure }, { role: 'accepted-cloud', closure: { version: 1, root: otherRoot, index: otherIndex } }], disposition: { kind: 'unresolved' } }
  const state: WorkspaceState = { ...fixture.state, conflicts: [conflict], blobs: fixture.blobs }
  const repo = { readWorkspace: vi.fn(async () => state), subscribe: () => () => {} }
  const resolve = vi.spyOn(actions, 'resolveConflict').mockRejectedValue(new Error('STALE_CONFLICT_CHOICE'))
  await act(async () => root.render(<ConflictPanel token={token} repository={repo}/>))
  expect(container.textContent).toContain('Pending version')
  expect(container.textContent).toContain('Accepted version')
  expect(container.textContent).toContain('before.json')
  expect(container.textContent).toContain('other.json')
  expect(container.textContent).not.toContain('Use both')
  const button = [...container.querySelectorAll('button')].find(button => button.textContent === 'Use pending version')!
  await act(async () => button.click())
  expect(resolve).toHaveBeenCalledWith(token, conflict.id, 'this', state.planner.localData.revision)
  expect(container.textContent).toContain('changed')
  expect(container.textContent).toContain('before.json')
  expect(container.textContent).toContain('other.json')
})
it('profileReplacementCannotDisplayThePreviousAccountsLateRead', async () => {
  const token = installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32))
  let settle!: (state: WorkspaceState) => void
  const pending = new Promise<WorkspaceState>(resolve => { settle = resolve })
  const repo = { readWorkspace: () => pending, subscribe: () => () => {} }
  await act(async () => root.render(<ConflictPanel token={token} repository={repo}/>))
  const next = installProfile('BBBBBBBBBBBBBBBBBBBBBA', new Uint8Array(32))
  const fixture = await editorClosureFixture()
  await act(async () => root.render(<ConflictPanel token={next} repository={{ ...repo, readWorkspace: async () => fixture.state }}/>))
  await act(async () => settle({ ...fixture.state, conflicts: [] }))
  expect(container.textContent).not.toContain('before.json')
})
it('sameNamedEditorAlternativesExposeTheirExactDifferentInvalidCodeUnitsBeforeChoice', async () => {
  const token = installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32)), fixture = await editorClosureFixture()
  const draft = await fixture.add(new Uint8Array([1, 216]), 'different-draft', 'utf16le')
  const other = await fixture.add({ ...fixture.file, unfinished: { ...fixture.file.unfinished, text: draft } }, 'different-file')
  const index = await fixture.add({ version: 1, kind: 'conflict-closure-page', children: [], entries: [...fixture.entries.map((entry, i) => i ? entry : { ...entry, ref: other, dependencies: [fixture.file.original, draft] }), { version: 1, ref: draft, documentVersion: 1, kind: 'blob', key: JSON.stringify(['blob', blobIdentity(draft)]), encoding: 'bytes', dependencies: [] }] }, 'different-index')
  const conflict: WorkspaceConflict = { version: 1, id: 'different-content', unit: { kind: 'record', privateKey: '["editor","editor-1"]' }, commonAncestor: { kind: 'present', closure: fixture.closure }, branches: [{ role: 'local-pending', closure: fixture.closure }, { role: 'accepted-cloud', closure: { version: 1, root: other, index } }], disposition: { kind: 'unresolved' } }
  let deferReads = false
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const blobs = fixture.blobs.map(blob => ({ ...blob, content: { byteLength: blob.content.byteLength, async *open() { if (deferReads) await waiting; yield* blob.content.open() } } }))
  const state = { ...fixture.state, conflicts: [conflict], blobs }
  const resolve = vi.spyOn(actions, 'resolveConflict')
  await act(async () => root.render(<ConflictPanel token={token} repository={{ readWorkspace: async () => state, subscribe: () => () => {} }}/>))
  const inspect = [...container.querySelectorAll('button')].filter(button => button.textContent === 'Inspect saved draft')
  expect(inspect).toHaveLength(2)
  deferReads = true
  await act(async () => { for (const button of inspect) button.click() })
  release()
  // Late reads must settle between act scopes so polling cannot hold back its own render
  await vi.waitFor(async () => { await act(async () => {}); expect(container.querySelectorAll('[aria-label="Saved draft content"]')).toHaveLength(2) })
  const previews = [...container.querySelectorAll('[aria-label="Saved draft content"]')].map(node => node.textContent)
  expect(previews).toEqual(['"\\ud800"', '"\\ud801"'])
  expect(resolve).not.toHaveBeenCalled()
})
