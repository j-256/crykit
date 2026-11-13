import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { expect, it, vi } from 'vitest'
import { BUNDLED_CATALOGS, CURRENT_CATALOG } from '../catalog/bundled'
import { createSampleLocalData } from '../domain/sample-data'
import { createPersonalDefinition } from '../domain/local-data'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { exportWorkspaceBackup, readWorkspaceBackup } from '../interchange/workspace-backup'
import { historyEntry } from '../persistence/local-data'
import { AccountDatabase, activateLocalAccountCommit } from '../persistence/account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId } from './account-cache'
import { prepareAccountWorkspace, openAccountWorkspace } from './account-graph'
import { captureAccountSnapshot } from './account-snapshot'
import { disposeWorkspaceSnapshot } from './snapshot'
import { memoryBlob, readBlob } from './blobs'
import type { WorkspaceState } from './documents'

vi.mock('../catalog/bundled', async importOriginal => {
  const actual = await importOriginal<typeof import('../catalog/bundled')>()
  return { ...actual, BUNDLED_CATALOGS: [...actual.BUNDLED_CATALOGS] }
})

it('reconstructs encrypted sources, checkpoints, and originals on a separate device after package removal', async () => {
  const packageBodies = [...BUNDLED_CATALOGS], mutablePackage = BUNDLED_CATALOGS as typeof CURRENT_CATALOG[]
  const originalFactory = Dexie.dependencies.indexedDB
  const accountId = accountLocalId(), key = crypto.getRandomValues(new Uint8Array(32))
  const databases: AccountDatabase[] = []
  let snapshot: Awaited<ReturnType<typeof captureAccountSnapshot>> | undefined
  let restored: Awaited<ReturnType<typeof readWorkspaceBackup>> | undefined
  try {
    Dexie.dependencies.indexedDB = new IDBFactory()
    let token = installProfile(accountId, key.slice())
    const first = new AccountDatabase(accountId); databases.push(first)
    const bytes = new TextEncoder().encode('{ "ID": "Synthetic retained original", "EditorVersion": 34, "Items": [{ "ID": 9000, "Name": "Retained item" }] }')
    const preview = await previewCrystalEdit(bytes, 'synthetic-original.json')
    const { bytes: original, ...source } = preview.proposed.sources[0]!
    const ref = { documentId: source.id, revisionId: source.digest, byteLength: original.byteLength, sha256: source.digest, encoding: 'bytes' as const }
    const before = createSampleLocalData(CURRENT_CATALOG)
    const localData = createPersonalDefinition(before, { kind: 'item', name: 'Synthetic retained checkpoint' })
    const history = [historyEntry(before, localData, 'personal-definition.create', localData.updatedAt)]
    const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [...BUNDLED_CATALOGS, ...preview.proposed.catalogs], sources: [{ ...source, original: ref }], evidence: [], history }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [{ ref, content: memoryBlob(original) }], libraryDefaults: { version: 1, layers: [] } }
    const prepared = await prepareAccountWorkspace(first, token, state)
    const fence = await activateLocalAccountCommit(first, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records })
    const revisions = await first.encryptedRevisions.toArray(), chunks = await first.stagedCipherChunks.toArray()
    invalidateProfile(); first.close()
    mutablePackage.splice(0)
    Dexie.dependencies.indexedDB = new IDBFactory()
    token = installProfile(accountId, key.slice())
    const second = new AccountDatabase(accountId); databases.push(second)
    expect(await second.encryptedRevisions.count()).toBe(0)
    // The second device receives only authenticated ciphertext and its dependency descriptors
    await second.encryptedRevisions.bulkPut(revisions)
    await second.stagedCipherChunks.bulkPut(chunks)
    const opened = await openAccountWorkspace(second, token, prepared.head)
    expect(opened.state.planner).toEqual(state.planner)
    expect(await readBlob(opened.state.blobs[0]!.content, original.byteLength)).toEqual(bytes)
    snapshot = await captureAccountSnapshot(opened, fence, async () => {}, { database: second, token })
    let backupBytes = 0
    async function* measuredBackup() {
      for await (const chunk of exportWorkspaceBackup(snapshot!)) { backupBytes += chunk.byteLength; yield chunk }
    }
    restored = await readWorkspaceBackup(measuredBackup())
    expect(restored.state.planner).toEqual(state.planner)
    expect(await readBlob(restored.state.blobs[0]!.content, original.byteLength)).toEqual(bytes)
    expect(mutablePackage).toEqual([])
    if (process.env.CRYKIT_SOURCE_STORAGE_MEASUREMENTS) {
      const { deflateSync } = await import('fflate')
      const bodies = new TextEncoder().encode(JSON.stringify(state.planner.catalogs))
      const measurements = { scenario: 'Launch vanilla, guides, a synthetic import, one checkpoint, and original bytes', sourceJsonBytes: bodies.byteLength, sourceDeflateBytes: deflateSync(bodies).byteLength, encryptedRevisionBytes: chunks.reduce((total, chunk) => total + chunk.bytes.byteLength, 0), completeBackupBytes: backupBytes }
      const { writeFileSync } = await import('node:fs')
      writeFileSync(process.env.CRYKIT_SOURCE_STORAGE_MEASUREMENTS, JSON.stringify(measurements, null, 2) + '\n')
    }
  } finally {
    if (restored) await disposeWorkspaceSnapshot(restored)
    if (snapshot) await disposeWorkspaceSnapshot(snapshot)
    invalidateProfile(); for (const database of databases) database.close()
    Dexie.dependencies.indexedDB = originalFactory
    mutablePackage.splice(0, mutablePackage.length, ...packageBodies)
    key.fill(0)
  }
}, 30_000)
