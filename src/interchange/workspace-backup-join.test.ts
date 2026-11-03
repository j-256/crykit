import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import * as evidence from './workspace-backup-evidence'
import { editorClosureFixture } from '../workspace/test-helpers'
import { assertWorkspaceSnapshotCurrent, disposeWorkspaceSnapshot, openHistoricalSnapshot, ownWorkspaceSnapshot, projectWorkspaceSnapshotV1, snapshotMetadata, type WorkspaceSnapshotV1 } from '../workspace/snapshot'
import { exportWorkspaceBackup, readWorkspaceBackup } from './workspace-backup'

async function fixture() {
  const { state } = await editorClosureFixture()
  return { version: 1 as const, snapshotId: 'source', capturedAt: '2026-10-12', revisionVector: { guest: 'source' }, state }
}
async function inherited(source: WorkspaceSnapshotV1) {
  const metadata = evidence.metadataSource(snapshotMetadata(source))
  return { members: [{ id: await evidence.historicalEvidenceId(metadata), metadata, subset: source.state.blobs.map(blob => blob.ref) }], bodies: source.state.blobs }
}
it('joins exact history without adding source current and retains terminal current ownership', async () => {
  expect(evidence).toHaveProperty('joinWorkspaceSnapshotEvidence')
  const source = await fixture(), history = await inherited(source)
  let current = true, disposals = 0
  const captured = ownWorkspaceSnapshot({ ...source, snapshotId: 'new-current' }, { async check() { if (!current) throw new Error('current changed') }, async dispose() { disposals++; current = false } })
  const joined = await evidence.joinWorkspaceSnapshotEvidence(captured, history)
  expect(joined.snapshotId).toBe('new-current')
  expect(joined.historicalEvidence.snapshots).toEqual([{ id: history.members[0].id }])
  const child = await openHistoricalSnapshot(joined, history.members[0].id)
  expect(child.snapshotId).toBe('source')
  await disposeWorkspaceSnapshot(child)
  const restored = await readWorkspaceBackup(exportWorkspaceBackup(joined))
  await disposeWorkspaceSnapshot(restored)
  current = false
  await expect(readWorkspaceBackup(exportWorkspaceBackup(joined))).rejects.toThrow('current changed')
  await disposeWorkspaceSnapshot(joined); await disposeWorkspaceSnapshot(joined)
  expect(disposals).toBe(1)
})
it('rejects forged owners, subset omissions and orphans while preserving input ownership on failure', async () => {
  expect(evidence).toHaveProperty('joinWorkspaceSnapshotEvidence')
  const source = await fixture(), history = await inherited(source)
  await expect(evidence.joinWorkspaceSnapshotEvidence(source, history)).rejects.toThrow(/owned/i)
  let disposed = false
  const current = ownWorkspaceSnapshot(source, { async check() { if (disposed) throw new Error('disposed') }, async dispose() { disposed = true } })
  await expect(evidence.joinWorkspaceSnapshotEvidence(current, { ...history, members: [{ ...history.members[0], subset: [] }] })).rejects.toThrow(/subset/i)
  await expect(evidence.joinWorkspaceSnapshotEvidence(current, { members: [], bodies: history.bodies })).rejects.toThrow(/orphan/i)
  await assertWorkspaceSnapshotCurrent(current)
  expect(disposed).toBe(false)
  const empty = await evidence.joinWorkspaceSnapshotEvidence(current, { members: [], bodies: [] })
  expect(empty.version).toBe(2)
  expect(empty.historicalEvidence.snapshots).toEqual([])
  await disposeWorkspaceSnapshot(empty)
})

it('keeps joined current metadata and inherited references detached from later caller mutations', async () => {
  const source = await fixture(), history = await inherited(source)
  const historicalMetadata = structuredClone(snapshotMetadata(source))
  const current = ownWorkspaceSnapshot({ ...source, snapshotId: 'current' }, { async check() {}, async dispose() {} })
  const expectedCurrent = snapshotMetadata(current)
  const joined = await evidence.joinWorkspaceSnapshotEvidence(current, history)
  try {
    source.revisionVector.guest = 'changed'
    expect(Reflect.set(source.state.planner.catalogs, 0, { invalid: true })).toBe(true)
    Object.assign(history.bodies[0].ref, { byteLength: history.bodies[0].ref.byteLength + 1 })
    const restored = await readWorkspaceBackup(exportWorkspaceBackup(joined))
    try {
      expect(snapshotMetadata(projectWorkspaceSnapshotV1(restored))).toEqual(expectedCurrent)
      const child = await openHistoricalSnapshot(restored, history.members[0].id)
      try { expect(snapshotMetadata(child)).toEqual(historicalMetadata) }
      finally { await disposeWorkspaceSnapshot(child) }
    } finally { await disposeWorkspaceSnapshot(restored) }
  } finally { await disposeWorkspaceSnapshot(joined) }
})

it('revokes joined children when the caller disposes the adopted current and awaits its disposal', async () => {
  const source = await fixture(), history = await inherited(source)
  let disposed = false, completed = false
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const current = ownWorkspaceSnapshot(source, { async check() { if (disposed) throw new Error('current disposed') }, async dispose() { disposed = true; await gate; completed = true } })
  const joined = await evidence.joinWorkspaceSnapshotEvidence(current, history)
  const child = await openHistoricalSnapshot(joined, history.members[0].id)
  const disposingCurrent = disposeWorkspaceSnapshot(current)
  await expect(assertWorkspaceSnapshotCurrent(joined)).rejects.toThrow('current disposed')
  await expect(assertWorkspaceSnapshotCurrent(child)).rejects.toThrow('current disposed')
  const disposingJoined = disposeWorkspaceSnapshot(joined)
  expect(completed).toBe(false)
  release()
  await Promise.all([disposingCurrent, disposingJoined, disposeWorkspaceSnapshot(child)])
  expect(completed).toBe(true)
})
it('rejects same-identity full-ref conflicts and cancellation without disposing the current owner', async () => {
  const source = await fixture(), history = await inherited(source)
  let disposed = false
  const current = ownWorkspaceSnapshot(source, { async check() { if (disposed) throw new Error('disposed') }, async dispose() { disposed = true } })
  const contradictory = { ...history, bodies: history.bodies.map((body, index) => index ? body : { ...body, ref: { ...body.ref, encoding: body.ref.encoding === 'bytes' ? 'utf8' as const : 'bytes' as const } }) }
  await expect(evidence.joinWorkspaceSnapshotEvidence(current, contradictory)).rejects.toThrow(/subset body/i)
  const cancelled = new AbortController(); cancelled.abort()
  await expect(evidence.joinWorkspaceSnapshotEvidence(current, history, { signal: cancelled.signal })).rejects.toThrow()
  await assertWorkspaceSnapshotCurrent(current)
  expect(disposed).toBe(false)
  await disposeWorkspaceSnapshot(current)
})
