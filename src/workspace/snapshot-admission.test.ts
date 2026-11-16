import { afterEach, expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile, profileSignal } from '../account/profile'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { ownWorkspaceSnapshot, disposeWorkspaceSnapshot } from './snapshot'
import * as snapshots from './snapshot'
import { editorClosureFixture } from './test-helpers'
import { admitWorkspaceMetadata, assertMetadataAdmission, createMergeOperationScope, metadataAdmissionFacts, validateSnapshotBodies, type WorkspaceMetadataAdmission } from './snapshot-admission'

afterEach(() => { invalidateProfile(); vi.restoreAllMocks() })
async function fixture() {
  const token = installProfile('metadata-admission', crypto.getRandomValues(new Uint8Array(32)))
  const data = await editorClosureFixture()
  let live = true
  const check = vi.fn(async () => { if (!live) throw new Error('owner retired') })
  const snapshot = ownWorkspaceSnapshot({ version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: 'admitted', capturedAt: data.file.updatedAt, revisionVector: {}, state: { ...data.state, editorDocuments: [data.file] } }, { check, async dispose() { live = false } })
  const current = vi.fn(async () => {})
  const scope = createMergeOperationScope(token, profileSignal(token), current)
  return { token, snapshot, scope, current, check }
}
it('reuses exact graph facts without repeating admission and still rereads physical bodies', async () => {
  const { snapshot, scope, check, current } = await fixture()
  const validation = vi.spyOn(snapshots, 'validateWorkspaceSnapshot')
  const first = await admitWorkspaceMetadata(snapshot, scope)
  const facts = await metadataAdmissionFacts(first, snapshot, scope)
  const second = await admitWorkspaceMetadata(snapshot, scope)
  expect(second).toBe(first)
  expect(await metadataAdmissionFacts(second, snapshot, scope)).toBe(facts)
  expect(validation).toHaveBeenCalledTimes(1)
  expect(check.mock.calls.length).toBeGreaterThan(1)
  expect(current.mock.calls.length).toBeGreaterThan(1)
  await validateSnapshotBodies(first)
  const body = snapshot.state.blobs[0].content
  vi.spyOn(body, 'open').mockImplementation(async function* () { throw new Error('reader rejected') })
  await expect(validateSnapshotBodies(first)).rejects.toThrow()
})
it.each(['forged', 'snapshot', 'scope', 'disposed-scope', 'disposed-owner', 'head', 'profile', 'aborted'] as const)('rejects %s authority even with identical public metadata', async mode => {
  const { token, snapshot, scope, current } = await fixture()
  let admission = await admitWorkspaceMetadata(snapshot, scope), expected = snapshot, owner = scope
  if (mode === 'forged') admission = Object.freeze({}) as WorkspaceMetadataAdmission
  if (mode === 'snapshot') expected = ownWorkspaceSnapshot(snapshot, { async check() {}, async dispose() {} })
  if (mode === 'scope') owner = createMergeOperationScope(token, profileSignal(token), async () => {})
  if (mode === 'disposed-scope') scope.dispose()
  if (mode === 'disposed-owner') await disposeWorkspaceSnapshot(snapshot)
  if (mode === 'head') current.mockRejectedValue(new Error('head changed'))
  if (mode === 'profile') invalidateProfile()
  if (mode === 'aborted') { const abort = new AbortController(); owner = createMergeOperationScope(token, abort.signal, async () => {}); admission = await admitWorkspaceMetadata(snapshot, owner); abort.abort() }
  await expect(assertMetadataAdmission(admission, expected, owner)).rejects.toThrow()
})
it('rejects changed backing bytes with unchanged readers and frozen metadata', async () => {
  const { snapshot, scope } = await fixture()
  const body = snapshot.state.blobs[0].content, original = body.open.bind(body)
  let corrupt = false
  body.open = async function* () { for await (const bytes of original()) { const next = bytes.slice(); if (corrupt && next.length) next[0] ^= 1; yield next } }
  const admission = await admitWorkspaceMetadata(snapshot, scope)
  corrupt = true
  await expect(validateSnapshotBodies(admission)).rejects.toThrow('digest')
})
it('does not publish a partially admitted snapshot when its owner retires during a read', async () => {
  const { snapshot, scope } = await fixture()
  const body = snapshot.state.blobs[0].content, original = body.open.bind(body)
  body.open = async function* () { yield* original(); scope.dispose() }
  await expect(admitWorkspaceMetadata(snapshot, scope)).rejects.toThrow()
  await expect(admitWorkspaceMetadata(snapshot, scope)).rejects.toThrow()
})
it('does not admit shallow-frozen unowned metadata or a copied profile token', async () => {
  const { token, snapshot, scope } = await fixture()
  await expect(admitWorkspaceMetadata(Object.freeze({ ...snapshot }), scope)).rejects.toThrow('registered owned')
  expect(() => createMergeOperationScope({ ...token }, profileSignal(token), async () => {})).toThrow('Foreign merge profile')
})
it('a new owned snapshot receives an independent admission even when IDs and values match', async () => {
  const { snapshot, scope } = await fixture()
  const other = ownWorkspaceSnapshot(snapshot, { async check() {}, async dispose() {} })
  const first = await admitWorkspaceMetadata(snapshot, scope), second = await admitWorkspaceMetadata(other, scope)
  expect(first).not.toBe(second)
  await expect(assertMetadataAdmission(first, other, scope)).rejects.toThrow()
})
it('propagates a later rejected read from the same registered stream capability', async () => {
  const { snapshot, scope } = await fixture()
  const body = snapshot.state.blobs[0].content, original = body.open.bind(body)
  let unavailable = false
  body.open = async function* () { if (unavailable) throw new Error('physical read failed'); yield* original() }
  const admission = await admitWorkspaceMetadata(snapshot, scope)
  unavailable = true
  await expect(validateSnapshotBodies(admission)).rejects.toThrow('physical read failed')
})
