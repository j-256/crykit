import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { BackupJsonReader } from './workspace-backup-json'
import * as snapshots from '../workspace/snapshot'
import * as evidence from './workspace-backup-evidence'
import { editorClosureFixture } from '../workspace/test-helpers'
import { assertWorkspaceSnapshotCurrent, disposeWorkspaceSnapshot, openHistoricalSnapshot, ownWorkspaceSnapshot, projectWorkspaceSnapshotV1, snapshotMetadata, type WorkspaceSnapshotV1 } from '../workspace/snapshot'
import { exportWorkspaceBackup, readWorkspaceBackup } from './workspace-backup'

afterEach(() => vi.restoreAllMocks())

async function fixture() {
  const { state } = await editorClosureFixture()
  return { dataGeneration: LAUNCH_DATA_GENERATION, version: 1 as const, snapshotId: 'source', capturedAt: '2026-10-12', revisionVector: { guest: 'source' }, state }
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

it('decodes and validates one historical member at a time, with fresh later readers and imports', async () => {
  const source = await fixture(), first = await inherited(source), second = await inherited({ ...source, snapshotId: 'other' })
  const current = ownWorkspaceSnapshot({ ...source, snapshotId: 'current' }, { async check() {}, async dispose() {} })
  const finish = BackupJsonReader.prototype.finish, validate = snapshots.validateWorkspaceSnapshotV1
  const events: string[] = []
  vi.spyOn(BackupJsonReader.prototype, 'finish').mockImplementation(function (this: BackupJsonReader) {
    const value = finish.call(this) as { snapshotId?: string }
    if (value.snapshotId === 'source' || value.snapshotId === 'other') events.push(`decode:${value.snapshotId}`)
    return value
  })
  vi.spyOn(snapshots, 'validateWorkspaceSnapshotV1').mockImplementation(async (...args) => {
    if (args[0].snapshotId === 'source' || args[0].snapshotId === 'other') events.push(`validate:${args[0].snapshotId}`)
    return validate(...args)
  })
  const joined = await evidence.joinWorkspaceSnapshotEvidence(current, { members: [...first.members, ...second.members], bodies: first.bodies })
  try {
    expect(events).toHaveLength(4)
    for (let index = 0; index < events.length; index += 2) expect(events[index + 1]).toBe(events[index].replace('decode:', 'validate:'))
    events.length = 0
    const child = await openHistoricalSnapshot(joined, first.members[0].id)
    await disposeWorkspaceSnapshot(child)
    expect(events).toEqual(['decode:source', 'validate:source'])
    const bytes: Uint8Array[] = []
    for await (const chunk of exportWorkspaceBackup(joined)) bytes.push(chunk)
    events.length = 0
    const imported = await readWorkspaceBackup((async function* () { yield* bytes })())
    await disposeWorkspaceSnapshot(imported)
    expect(new Set(events.filter(value => value.startsWith('decode:')))).toEqual(new Set(['decode:other', 'decode:source']))
    expect(events.filter(value => value.startsWith('validate:')).sort()).toEqual(['validate:other', 'validate:source'])
  } finally { await disposeWorkspaceSnapshot(joined) }
})

it('validates every duplicate member subset without retaining duplicate decoded metadata', async () => {
  const source = await fixture(), history = await inherited(source)
  let disposed = false
  const current = ownWorkspaceSnapshot(source, { async check() { if (disposed) throw new Error('disposed') }, async dispose() { disposed = true } })
  const member = history.members[0]
  for (const subset of [[], [...member.subset, member.subset[0]], member.subset.map((ref, index) => index ? ref : { ...ref, encoding: 'utf8' as const })]) {
    await expect(evidence.joinWorkspaceSnapshotEvidence(current, { ...history, members: [member, { ...member, subset }] })).rejects.toThrow(/subset/i)
    expect(disposed).toBe(false)
  }
  const joined = await evidence.joinWorkspaceSnapshotEvidence(current, { ...history, members: [member, member] })
  try { expect(joined.historicalEvidence.snapshots).toHaveLength(1) }
  finally { await disposeWorkspaceSnapshot(joined) }
})

it('detaches source subset and body constraints before an awaited owner check', async () => {
  const source = await fixture(), history = await inherited(source)
  const bodies = [...history.bodies]
  let release!: () => void, entered!: () => void, first = true
  const held = new Promise<void>(resolve => { release = resolve }), checking = new Promise<void>(resolve => { entered = resolve })
  const current = ownWorkspaceSnapshot(source, { async check() { if (first) { first = false; entered(); await held } }, async dispose() {} })
  const pending = evidence.joinWorkspaceSnapshotEvidence(current, { ...history, bodies })
  try {
    await checking
    history.members[0].subset = []
    bodies[0] = { ...bodies[0], ref: { ...bodies[0].ref, sha256: '0'.repeat(64) } }
  } finally { release() }
  const joined = await pending
  try { expect(joined.historicalEvidence.snapshots).toEqual([{ id: history.members[0].id }]) }
  finally { await disposeWorkspaceSnapshot(joined) }
})
