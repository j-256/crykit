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
import type { LocalDataNotification } from '../../interchange/types'
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
  let notify!: () => void
  const repo = { readWorkspace: vi.fn(async () => state), subscribe: (listener: (event: LocalDataNotification) => void) => { notify = () => listener({ localDataId: state.planner.localData.id, revision: state.planner.localData.revision, reason: 'sync' }); return () => {} } }
  const resolve = vi.spyOn(actions, 'resolveConflict').mockRejectedValue(new Error('STALE_CONFLICT_CHOICE'))
  await act(async () => root.render(<ConflictPanel token={token} repository={repo}/>))
  expect(container.textContent).toContain('Pending version')
  expect(container.textContent).toContain('Accepted version')
  expect(container.textContent).toContain('before.json')
  expect(container.textContent).toContain('other.json')
  expect(container.textContent).not.toContain('Use both')
  let finishRead!: (value: WorkspaceState) => void
  repo.readWorkspace.mockImplementationOnce(() => new Promise<WorkspaceState>(resolve => { finishRead = resolve }))
  await act(async () => notify())
  const button = [...container.querySelectorAll('button')].find(button => button.textContent === 'Use pending version')!
  await act(async () => button.click())
  expect(resolve).toHaveBeenCalledWith(token, conflict.id, 'this', state.planner.localData.revision)
  await act(async () => finishRead(state))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('The accepted version changed')
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


it('shows saved Playthrough labels before choosing and marks only displayed differences', async () => {
  const token = installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32)), fixture = await editorClosureFixture()
  const closure = async (label: string, id: string) => {
    const value = { metadata: { id: 'play', revision: 1, label, createdAt: '2026-11-14T00:00:00.000Z', updatedAt: '2026-11-14T00:00:00.000Z' }, optional: { skillTreeCaptures: false, quintarBreeding: false } }
    const ref = await fixture.add(value, id)
    const index = await fixture.add({ version: 1, kind: 'conflict-closure-page', children: [], entries: [{ version: 1, ref, documentVersion: 1, kind: 'playthrough', key: '["playthrough","play"]', encoding: 'json', dependencies: [] }] }, `${id}-index`)
    return { version: 1 as const, root: ref, index }
  }
  const pending = await closure('Device journey', 'device-play'), accepted = await closure('Account journey', 'account-play')
  const conflict: WorkspaceConflict = { version: 1, id: 'play-conflict', unit: { kind: 'record', privateKey: '["playthrough","play"]' }, commonAncestor: { kind: 'absent' }, branches: [{ role: 'local-pending', closure: pending }, { role: 'accepted-cloud', closure: accepted }], disposition: { kind: 'unresolved' } }
  await act(async () => root.render(<ConflictPanel token={token} repository={{ readWorkspace: async () => ({ ...fixture.state, blobs: fixture.blobs, conflicts: [conflict] }), subscribe: () => () => {} }}/>))
  const summaries = [...container.querySelectorAll('dl')]
  expect(summaries).toHaveLength(2)
  expect(summaries[0].textContent).toContain('Device journey')
  expect(summaries[1].textContent).toContain('Account journey')
  expect(summaries.map(summary => [...summary.querySelectorAll('[data-differs=true]')].map(row => row.querySelector('dt')?.textContent))).toEqual([['NameDiffers'], ['NameDiffers']])
  expect([...container.querySelectorAll('button')].map(button => button.textContent)).toContain('Use pending version')
  expect(container.querySelectorAll('details')).toHaveLength(2)
})


it('shows recorded Progress knowledge without turning unknown or conflicting values into facts', async () => {
  const token = installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32)), fixture = await editorClosureFixture()
  const { progress } = await import('../../workspace/signin-merge.test-helpers')
  const workspace = progress('observation'), local = workspace.planner.localData
  const { splitWorkspace } = await import('../../workspace/documents')
  const owner = await fixture.add(splitWorkspace(workspace).find(value => value.kind === 'playthrough')!.value, 'progress-owner')
  const definition = await fixture.add(local.personalDefinitions.subject, 'definition')
  const record = { ...local.playthroughs.play.progress.observation, unlocked: { state: 'unknown', reason: 'Check the class menu' }, partyMastery: { state: 'conflicting', claims: [{ value: true, sources: [] }, { value: false, sources: [] }] }, collection: { state: 'notApplicable', reason: 'Not a collectible' } }
  const ref = await fixture.add(record, 'progress-root')
  const index = await fixture.add({ version: 1, kind: 'conflict-closure-page', children: [], entries: [{ version: 1, ref, documentVersion: 1, kind: 'progress', key: '["progress","play","observation"]', encoding: 'json', dependencies: [definition, owner] }, { version: 1, ref: owner, documentVersion: 1, kind: 'playthrough', key: '["playthrough","play"]', encoding: 'json', dependencies: [] }, { version: 1, ref: definition, documentVersion: 1, kind: 'personal-definition', key: '["personal-definition","subject"]', encoding: 'json', dependencies: [] }] }, 'progress-index')
  const closure = { version: 1 as const, root: ref, index }
  const { inspectWorkspaceClosure } = await import('../../workspace/closure')
  await inspectWorkspaceClosure({ ...fixture.state, blobs: fixture.blobs }, closure)
  const conflict: WorkspaceConflict = { version: 1, id: 'progress-conflict', unit: { kind: 'record', privateKey: '["progress","play","observation"]' }, commonAncestor: { kind: 'absent' }, branches: [{ role: 'local-pending', closure }, { role: 'accepted-cloud', closure }], disposition: { kind: 'unresolved' } }
  await act(async () => root.render(<ConflictPanel token={token} repository={{ readWorkspace: async () => ({ ...fixture.state, blobs: fixture.blobs, conflicts: [conflict] }), subscribe: () => () => {} }}/>))
  const summary = container.querySelector('dl')!
  expect(summary).not.toBeNull()
  expect(summary.textContent).toContain('Unknown: Check the class menu')
  expect(summary.textContent).toContain('Conflicting: Yes; No')
  expect(summary.textContent).toContain('Not applicable: Not a collectible')
  expect(summary.textContent).toContain('Class')
  expect(summary.textContent).toContain('PlaythroughRun')
  expect(container.textContent).toContain('Shown fields match')
  expect(summary.querySelector('[data-differs=true]')).toBeNull()
})


it('clears a failed comparison read only when the latest subscription read succeeds', async () => {
  const token = installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32)), fixture = await editorClosureFixture()
  const conflict: WorkspaceConflict = { version: 1, id: 'read-recovery', unit: { kind: 'record', privateKey: '["editor","editor-1"]' }, commonAncestor: { kind: 'absent' }, branches: [{ role: 'local-pending', closure: fixture.closure }, { role: 'accepted-cloud', closure: fixture.closure }], disposition: { kind: 'unresolved' } }
  const state: WorkspaceState = { ...fixture.state, blobs: fixture.blobs, conflicts: [conflict] }
  let read: () => Promise<WorkspaceState> = async () => { throw new Error('Read unavailable') }
  let notify!: () => void
  const repository = { readWorkspace: () => read(), subscribe: (listener: (event: LocalDataNotification) => void) => { notify = () => listener({ localDataId: state.planner.localData.id, revision: state.planner.localData.revision, reason: 'sync' }); return () => {} } }
  await act(async () => root.render(<ConflictPanel token={token} repository={repository}/>))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Saved versions could not be read')
  let finishOlderRead!: (value: WorkspaceState) => void
  const olderRead = new Promise<WorkspaceState>(resolve => { finishOlderRead = resolve })
  read = () => olderRead
  await act(async () => notify())
  read = async () => { throw new Error('Newer read unavailable') }
  await act(async () => notify())
  await act(async () => finishOlderRead(state))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Saved versions could not be read')
  expect(container.textContent).not.toContain('before.json')
  read = async () => state
  await act(async () => notify())
  expect(container.textContent).toContain('before.json')
  expect(container.querySelector('[role="alert"]')).toBeNull()
})
