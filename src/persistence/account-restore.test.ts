import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { AccountDatabase, activateLocalAccountCommit } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId } from '../workspace/account-cache'
import { openAccountWorkspace, prepareAccountWorkspace } from '../workspace/account-graph'
import { editorClosureFixture } from '../workspace/test-helpers'
import { createBlankLocalData } from '../domain/local-data'
import { exportWorkspaceBackup, readWorkspaceBackup } from '../interchange/workspace-backup'
import { captureAccountSnapshot } from '../workspace/account-snapshot'
import { disposeWorkspaceSnapshot, openHistoricalSnapshot, type WorkspaceSnapshotV1 } from '../workspace/snapshot'
import { activateAccountWorkspaceRestore, previewAccountWorkspaceRestore, releaseAccountWorkspaceRestorePreview, releaseAccountWorkspaceRestoreStage, stageAccountWorkspaceRestore } from '../workspace/account-restore'
import { readBlob } from '../workspace/blobs'

let database: AccountDatabase | undefined
afterEach(async () => { invalidateProfile(); await database?.delete(); database = undefined })

it('restoresAnOwnedBackupWithOneGuardedPointerAndRetainsExactOriginalsForExport', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const localData = createBlankLocalData()
  const blank = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1 as const, layers: [] } }
  const initial = await prepareAccountWorkspace(database, token, blank)
  const old = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: initial.head, records: initial.records })
  const fixture = await editorClosureFixture()
  const source: WorkspaceSnapshotV1 = { version: 1, snapshotId: 'owned-editor-restore', capturedAt: '2026-10-13', revisionVector: {}, state: { ...fixture.state, editorDocuments: [{ ...fixture.file, unfinished: { ...fixture.file.unfinished, fieldState: { original: '\ud800' } } }] } }
  const backup = await readWorkspaceBackup(exportWorkspaceBackup(source))
  let stage: Awaited<ReturnType<typeof stageAccountWorkspaceRestore>> | undefined
  try {
    const preview = await previewAccountWorkspaceRestore(database, token, backup)
    try {
      const existingChunks = new Set((await database.stagedCipherChunks.toArray()).map(chunk => JSON.stringify([chunk.payloadId, chunk.index])))
      stage = await stageAccountWorkspaceRestore(preview)
      expect(await database.profileMeta.get('active')).toEqual(old)
      expect(await database.outbox.count()).toBe(0)
      const stagedChunk = (await database.stagedCipherChunks.toArray()).find(chunk => !existingChunks.has(JSON.stringify([chunk.payloadId, chunk.index])))!
      await database.stagedCipherChunks.delete([stagedChunk.payloadId, stagedChunk.index])
      await expect(activateAccountWorkspaceRestore(stage)).rejects.toThrow()
      expect(await database.profileMeta.get('active')).toEqual(old)
      expect(await database.outbox.count()).toBe(0)
      await database.stagedCipherChunks.put(stagedChunk)
      const concurrentIntent = { id: accountLocalId(), ref: old.head, status: 'mapped-local' as const }
      await database.outbox.add(concurrentIntent)
      await expect(activateAccountWorkspaceRestore(stage)).rejects.toThrow('Finish syncing')
      expect(await database.profileMeta.get('active')).toEqual(old)
      expect(await database.outbox.toArray()).toEqual([concurrentIntent])
      await database.outbox.delete(concurrentIntent.id)
      await expect(activateAccountWorkspaceRestore(stage, () => { throw new Error('Injected pointer failure') })).rejects.toThrow('Injected pointer failure')
      expect(await database.profileMeta.get('active')).toEqual(old)
      expect(await database.outbox.count()).toBe(0)
      const restored = await activateAccountWorkspaceRestore(stage)
      expect(restored.head).toEqual(stage.targetHead)
      expect(await database.outbox.count()).toBe(1)
      expect((await database.encryptedRevisions.get(old.head.revisionId))?.revisionId).toBe(old.head.revisionId)
      const workspace = await openAccountWorkspace(database, token, restored.head)
      expect(workspace.formatVersion).toBe(2)
      expect(workspace.state.editorDocuments[0].unfinished.fieldState).toEqual({ original: '\ud800' })
      const captured = await captureAccountSnapshot(workspace, restored, async () => {}, { database, token })
      try {
        expect(captured.version).toBe(2)
        if (captured.version !== 2) throw new Error('Missing historical original')
        expect(captured.historicalEvidence.snapshots).toHaveLength(1)
        const original = await openHistoricalSnapshot(captured, captured.historicalEvidence.snapshots[0].id)
        try {
          const body = original.state.blobs.find(value => value.ref.documentId === 'text')!
          expect(await readBlob(body.content, body.ref.byteLength)).toEqual(new Uint8Array([0x00, 0xd8]))
        } finally { await disposeWorkspaceSnapshot(original) }
      } finally { await disposeWorkspaceSnapshot(captured) }
    } finally { releaseAccountWorkspaceRestorePreview(preview) }
  } finally { if (stage) await releaseAccountWorkspaceRestoreStage(stage); await disposeWorkspaceSnapshot(backup) }
})
