import { SYNTHETIC_RETAINED_CATALOG } from '../../src/domain/retained-catalog.test-helpers'
import { createPersonalDefinition, createPlaythrough, addGameSetupRevision } from '../../src/domain/local-data'
import { upsertProgress } from '../../src/domain/characters'
import { prepareModComposition, composeModCatalog, expandModCatalogs } from '../../src/domain/mod-layers'
import { readWorkspaceBackup, exportWorkspaceBackup } from '../../src/interchange/workspace-backup'
import { capturedBackupEvidence, historicalMetadataIdentity, inheritWorkspaceSnapshot } from '../../src/interchange/workspace-backup-evidence'
import { memoryBlob, hashBlob } from '../../src/workspace/blobs'
import { assertWorkspaceSnapshotCurrent, ownWorkspaceSnapshot, disposeWorkspaceSnapshot } from '../../src/workspace/snapshot'
import { completeWorkspaceFixture } from './workspace-fixture'

// Author a separate small source; never shrink or rewrite a previously retained starter original
// The caller restores over the explicit empty-catalog control so replacement does not archive vanilla
export async function smallMergeOriginalsFixture() {
  const initial = await completeWorkspaceFixture(), original = await readWorkspaceBackup(memoryBlob(initial.backup).open())
  try {
    const metadata = await historicalMetadataIdentity(capturedBackupEvidence(original).current)
    const bodies = await Promise.all(original.state.blobs.map(async body => ({ ref: body.ref, digest: await hashBlob(body.content) })))
    const imported = original.state.planner.catalogs.find(catalog => catalog.schemaVersion === 'crystal-edit-json-1')!
    const inputs = [SYNTHETIC_RETAINED_CATALOG, ...original.state.planner.catalogs]
    let localData = createPersonalDefinition(original.state.planner.localData, { id: 'subject' as never, kind: 'class', name: 'Class' })
    localData = createPlaythrough(localData, { id: 'play' as never, label: 'Run' })
    localData = upsertProgress(localData, { id: 'local' as never, subject: { kind: 'personal', definitionId: 'subject' as never }, displayName: 'Class', unlocked: { state: 'unknown', reason: 'Check later' } })
    const composition = prepareModComposition({ baseline: { catalogId: SYNTHETIC_RETAINED_CATALOG.id, catalogRevisionId: SYNTHETIC_RETAINED_CATALOG.revisionId }, layers: [{ catalogId: imported.id, catalogRevisionId: imported.revisionId, enabled: true }], links: [] }, inputs)
    localData = addGameSetupRevision(localData, { label: 'Synthetic retained qualification setup', modComposition: composition, activate: false })
    const setup = Object.values(localData.gameSetups).find(setup => setup.label === 'Synthetic retained qualification setup')!
    const catalogs = expandModCatalogs([...inputs, composeModCatalog(setup, inputs)!])
    const current = ownWorkspaceSnapshot({ version: 1, dataGeneration: original.dataGeneration, snapshotId: 'small-retained-imported-merge-source', capturedAt: original.capturedAt, revisionVector: { source: 'small-retained-imported' }, state: { ...original.state, planner: { ...original.state.planner, localData, catalogs, savedChanges: localData.changes, journal: { ...original.state.planner.journal!, changes: localData.changes } } } }, { check: () => assertWorkspaceSnapshotCurrent(original), async dispose() {} })
    try {
      const inherited = await inheritWorkspaceSnapshot(current, [original]), chunks: Buffer[] = []
      try {
        for await (const chunk of exportWorkspaceBackup(inherited)) chunks.push(Buffer.from(chunk))
        const backup = Buffer.concat(chunks)
        const sizes = { backupBytes: backup.length, originalMetadataBytes: capturedBackupEvidence(original).current.byteLength, currentMetadataBytes: capturedBackupEvidence(current).current.byteLength, nativeBodyBytes: bodies.reduce((sum, body) => sum + body.ref.byteLength, 0), catalogs: catalogs.map(catalog => ({ id: catalog.id, revisionId: catalog.revisionId, schema: catalog.schemaVersion, jsonBytes: new TextEncoder().encode(JSON.stringify(catalog)).length })) }
        return { backup, metadata, bodies, sizes }
      } finally { await disposeWorkspaceSnapshot(inherited) }
    } finally { await disposeWorkspaceSnapshot(current) }
  } finally { await disposeWorkspaceSnapshot(original) }
}
