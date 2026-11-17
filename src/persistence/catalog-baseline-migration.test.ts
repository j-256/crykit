import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { installProfile, invalidateProfile } from '../account/profile'
import { AccountDatabase, activateLocalAccountCommit } from './account-database'
import { seedManagedWorkspace } from './managed-sync.test-helpers'
import { accountLocalId } from '../workspace/account-cache'
import { prepareAccountCatalogMigration } from '../workspace/catalog-migration'
import { captureManagedAccountSnapshot } from '../workspace/account-managed-snapshot'
import { editorClosureFixture } from '../workspace/test-helpers'
import { capturedBackupEvidence, equalMetadataStreams } from '../interchange/workspace-backup-evidence'
import { disposeWorkspaceSnapshot } from '../workspace/snapshot'
import { workspaceDocumentSource } from '../workspace/document-codec'
import { privateRecordKey } from '../workspace/documents'

// This integration uses the actual unmodified bundle; isolated writer cases own their small membership fixture
it('migrates the native baseline through exact managed activation without changing personal values or originals', async () => {
  vi.stubGlobal('__CRYKIT_COMPACT_CATALOG_QUALIFICATION__', true)
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  let migration: Awaited<ReturnType<typeof prepareAccountCatalogMigration>> | undefined
  try {
    const fixture = await editorClosureFixture()
    const state = { ...fixture.state, editorDocuments: [fixture.file], planner: { ...fixture.state.planner, catalogs: [CURRENT_CATALOG] } }
    await seedManagedWorkspace(database, token, state)
    const expected = (await database.profileMeta.get('active'))!
    const outbox = await database.outbox.toArray(), journal = await database.migrationJournal.toArray(), heads = await database.documentHeads.toArray()
    migration = await prepareAccountCatalogMigration(database, token, expected)
    expect(await database.profileMeta.get('active')).toEqual(expected)
    expect(await database.outbox.toArray()).toEqual(outbox)
    expect(await database.migrationJournal.toArray()).toEqual(journal)
    expect(await database.documentHeads.toArray()).toEqual(heads)
    await database.profileMeta.put({ ...expected, headRevision: expected.headRevision + 1 })
    await expect(activateLocalAccountCommit(database, token, migration.prepared)).rejects.toThrow()
    expect(await database.profileMeta.get('active')).toEqual({ ...expected, headRevision: expected.headRevision + 1 })
    expect(await database.outbox.toArray()).toEqual(outbox)
    expect(await database.migrationJournal.toArray()).toEqual(journal)
    await database.profileMeta.put(expected)
    const selected = await activateLocalAccountCommit(database, token, migration.prepared)
    const snapshot = await captureManagedAccountSnapshot(database, token, selected)
    try {
      expect(snapshot.version).toBe(3)
      expect(snapshot.state.planner.localData).toEqual(state.planner.localData)
      expect(snapshot.state.planner.history).toEqual(state.planner.history)
      expect(snapshot.state.editorDocuments).toEqual(state.editorDocuments)
      expect(snapshot.state.blobs.map(body => body.ref)).toEqual(state.blobs.map(body => body.ref))
      for (const original of state.blobs) {
        const retained = snapshot.state.blobs.find(body => body.ref.documentId === original.ref.documentId && body.ref.revisionId === original.ref.revisionId)!
        expect(await equalMetadataStreams(retained.content, original.content)).toBe(true)
      }
      const evidence = capturedBackupEvidence(snapshot)
      expect(evidence.catalogBodies).toHaveLength(1)
      const frame = workspaceDocumentSource({ version: 1, kind: 'catalog', key: privateRecordKey('catalog', CURRENT_CATALOG.id, CURRENT_CATALOG.revisionId), value: CURRENT_CATALOG as never })
      expect(await equalMetadataStreams(evidence.catalogBodies![0].content, frame)).toBe(true)
    } finally { await disposeWorkspaceSnapshot(snapshot) }
  } finally { await migration?.dispose(); vi.unstubAllGlobals(); invalidateProfile(); await database.delete() }
})
