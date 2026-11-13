import { LAUNCH_DATA_GENERATION } from '../../src/domain/data-generation'
import { previewImport } from '../../src/interchange/import'
import { exportWorkspaceBackup } from '../../src/interchange/workspace-backup'
import { changedLocalData, historyEntry } from '../../src/persistence/local-data'
import { editorClosureFixture } from '../../src/workspace/test-helpers'
import type { WorkspaceSnapshotV1 } from '../../src/workspace/snapshot'

export const SYNTHETIC_SAVE_ORIGINAL = 'opaqueCredential password accountKey csrf inert file bytes'

// Author every retained class through the launch format so complete-restore journeys cannot pass with an empty archive
export async function completeWorkspaceFixture() {
  const fixture = await editorClosureFixture()
  const imported = await previewImport(new TextEncoder().encode(JSON.stringify({ ID: 'complete-backup-source', Title: 'Synthetic complete source', EditorVersion: 34, Items: [{ ID: 1, Name: 'Synthetic item' }] })), 'source.json')
  const archive = imported.proposed.sources[0]!
  const { bytes, ...source } = archive
  const sourceOriginal = await fixture.add(bytes, 'source-original', 'bytes')
  const saveOriginal = await fixture.add(new TextEncoder().encode(SYNTHETIC_SAVE_ORIGINAL), 'save-original', 'bytes')
  const artwork = await fixture.add(new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6xX0AAAAASUVORK5CYII=', 'base64')), 'artwork', 'bytes')
  const before = fixture.state.planner.localData
  const localData = changedLocalData(before, before, 'fixture-history', before.updatedAt)
  const history = historyEntry(before, localData, 'fixture-history', localData.updatedAt)
  const snapshot: WorkspaceSnapshotV1 = {
    version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: 'complete-browser-fixture', capturedAt: before.createdAt, revisionVector: { source: 'synthetic' },
    state: { ...fixture.state,
      planner: { ...fixture.state.planner, localData, catalogs: imported.proposed.catalogs, sources: [{ ...source, original: sourceOriginal }], history: [history], savedChanges: localData.changes, journal: { version: 1, changes: localData.changes, checkpoints: [history], undoable: true } },
      editorDocuments: [fixture.file],
      saveDocuments: [{ version: 1, id: 'save-1', revision: 0, filename: 'save.dat', original: saveOriginal, working: saveOriginal, pendingForm: { unfinished: 'synthetic' }, requirements: [], coverage: { status: 'unsupported', diagnostics: ['Synthetic opaque save'] }, createdAt: before.createdAt, updatedAt: before.createdAt, exportedRevision: null }],
      assets: [{ version: 1, id: 'artwork-1', sourceKey: source.id, relativePath: 'artwork.png', original: artwork, mediaType: 'image/png', width: 1, height: 1 }],
    },
  }
  const chunks: Buffer[] = []
  for await (const chunk of exportWorkspaceBackup(snapshot)) chunks.push(Buffer.from(chunk))
  return { backup: Buffer.concat(chunks), historyId: history.id }
}
