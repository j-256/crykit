import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import * as evidence from './guest-evidence'
import { editorClosureFixture } from './test-helpers'
import { disposeWorkspaceSnapshot, ownWorkspaceSnapshot, snapshotMetadata, type WorkspaceSnapshot } from './snapshot'
import { capturedBackupEvidence, inheritWorkspaceSnapshot, registerBackupMetadata } from '../interchange/workspace-backup-evidence'
import { encodeBackupJson } from '../interchange/workspace-backup-json'
import { blobIdentity, readBlob } from './blobs'

const LEGACY_METADATA_PAGE_BYTES = 256

it.each([false, true])('composes exact copy originals without an intermediate backup, including legacy page packing: inherited=%s', async inherited => {
  const fixture = await editorClosureFixture()
  const original = ownWorkspaceSnapshot({ version: 1, snapshotId: 'exact-original', capturedAt: fixture.file.updatedAt, revisionVector: {}, state: { ...fixture.state, editorDocuments: [fixture.file] } }, { check: async () => {}, dispose: async () => {} })
  let selectedLive = true
  const selected = ownWorkspaceSnapshot({ ...original, snapshotId: 'selected-original' }, { check: async () => { if (!selectedLive) throw new Error('Selected copy was released') }, dispose: async () => { selectedLive = false } })
  const pages = [...encodeBackupJson(snapshotMetadata(original), LEGACY_METADATA_PAGE_BYTES)]
  registerBackupMetadata(original, { byteLength: pages.reduce((sum, page) => sum + page.length, 0), async *open() { for (const page of pages) yield page } })
  const source: WorkspaceSnapshot = inherited ? await inheritWorkspaceSnapshot(original, [original]) : original
  const normalized = await inheritWorkspaceSnapshot(selected, [selected, source])
  try {
    const direct = await evidence.guestEvidenceForCopy(selected, source)
    const actual = evidence.guestEvidenceSources(direct), expected = capturedBackupEvidence(normalized)
    expect(actual.members.map(member => member.id)).toEqual(normalized.historicalEvidence.snapshots.map(member => member.id))
    for (const member of actual.members) expect(await readBlob(member.metadata, member.metadata.byteLength)).toEqual(await readBlob(expected.historical.get(member.id)!, member.metadata.byteLength))
    expect(actual.bodies.map(body => body.ref)).toEqual(normalized.historicalEvidence.blobs)
    for (const body of actual.bodies) expect(await readBlob(body.content, body.ref.byteLength)).toEqual(await readBlob(expected.blobs.find(value => blobIdentity(value.ref) === blobIdentity(body.ref))!.content, body.ref.byteLength))
    await disposeWorkspaceSnapshot(selected)
    await expect(direct.check()).rejects.toThrow()
  } finally { await disposeWorkspaceSnapshot(normalized); if (source !== original) await disposeWorkspaceSnapshot(source); await disposeWorkspaceSnapshot(selected); await disposeWorkspaceSnapshot(original) }
})

it('rejects damaged stored current metadata even when the source owner remains live', async () => {
  const fixture = await editorClosureFixture()
  const source = ownWorkspaceSnapshot({ version: 1, snapshotId: 'damaged-current', capturedAt: fixture.file.updatedAt, revisionVector: {}, state: fixture.state }, { check: async () => {}, dispose: async () => {} })
  const bytes = new TextEncoder().encode('invalid stored token pages')
  registerBackupMetadata(source, { byteLength: bytes.length, async *open() { yield bytes } })
  try {
    await expect(inheritWorkspaceSnapshot(source, [source])).rejects.toThrow()
    await expect(evidence.guestEvidenceForCopy(source)).rejects.toThrow()
  } finally { await disposeWorkspaceSnapshot(source) }
})
