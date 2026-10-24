import { expect, it } from 'vitest'
import type { OpenAccountWorkspace } from './account-graph'
import { retainPendingUnits } from './pending-content'
import { editorClosureFixture } from './test-helpers'
import { inspectWorkspaceClosures } from './closure'
import { readBlob } from './blobs'

it('reads shared pending metadata once while checking each overlapping closure', async () => {
  const { state, add, closure, entries } = await editorClosureFixture()
  const otherIndex = await add({ version: 1, kind: 'conflict-closure-page', entries, children: [] }, 'other-index')
  const calls = new Map<string, number>()
  const observed = { ...state, retainedContent: [...state.retainedContent, { ...state.retainedContent[0], id: 'pending-2', target: { ...closure, index: otherIndex } }], blobs: state.blobs.map(blob => ({ ...blob, content: { ...blob.content, async *open() { calls.set(blob.ref.documentId, (calls.get(blob.ref.documentId) ?? 0) + 1); yield* blob.content.open() } } })) }
  // With no newly changed unit, the real consumer still checks all existing pending closures
  const unused = {} as OpenAccountWorkspace
  const result = await retainPendingUnits(observed, unused, unused, 'next-group', [])
  expect(result.retainedContent).toEqual(observed.retainedContent)
  expect(result.blobs).toEqual(observed.blobs)
  expect(calls.get(closure.root.documentId)).toBe(1)
  expect(calls.get(closure.index.documentId)).toBe(1)
  expect(calls.get(otherIndex.documentId)).toBe(1)
})

it('rechecks each closure identity even when its metadata body was parsed in the same batch', async () => {
  const { state, add, closure, entries } = await editorClosureFixture()
  const wrongIndex = await add({ version: 1, kind: 'conflict-closure-page', entries: [{ ...entries[0], key: '["editor","foreign"]' }, entries[1]], children: [] }, 'wrong-index')
  await expect(inspectWorkspaceClosures(state, [closure, { ...closure, index: wrongIndex }])).rejects.toThrow('identity')
  const wrongRef = { ...closure.root, sha256: '0'.repeat(64) }
  const wrongRefIndex = await add({ version: 1, kind: 'conflict-closure-page', entries: [{ ...entries[0], ref: wrongRef }, entries[1]], children: [] }, 'wrong-ref-index')
  await expect(inspectWorkspaceClosures(state, [closure, { ...closure, root: wrongRef, index: wrongRefIndex }])).rejects.toThrow('reference')
})

it('rejects a changed body source within a batch and reads changed bytes in the next batch', async () => {
  const { state, add, closure, entries } = await editorClosureFixture()
  const otherIndex = await add({ version: 1, kind: 'conflict-closure-page', entries, children: [] }, 'other-index')
  const root = state.blobs.find(blob => blob.ref === closure.root)!
  let bytes = await readBlob(root.content, root.ref.byteLength)
  const source = { byteLength: bytes.length, async *open() { yield bytes } }
  const observed = { ...state, blobs: state.blobs.map(blob => blob === root ? { ...blob, content: source } : blob) }
  await inspectWorkspaceClosures(observed, [closure, { ...closure, index: otherIndex }])
  bytes = bytes.slice(); bytes[0] = '!'.charCodeAt(0)
  await expect(inspectWorkspaceClosures(observed, [closure])).rejects.toThrow()
  bytes = await readBlob(root.content, root.ref.byteLength)
  const changing = { ...observed, blobs: observed.blobs.map(blob => blob.ref === otherIndex ? { ...blob, content: { ...blob.content, async *open() { source.open = async function* () { yield bytes }; yield* blob.content.open() } } } : blob) }
  await expect(inspectWorkspaceClosures(changing, [closure, { ...closure, index: otherIndex }])).rejects.toThrow('source changed')
})
