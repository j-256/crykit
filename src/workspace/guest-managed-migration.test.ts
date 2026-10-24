import './guest-managed-monitor.test-helpers'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { expect, it, vi } from 'vitest'
import { CryKitDatabase } from '../persistence/database'
import { loadLocalData } from '../persistence/local-data'
import { openGuestBindings, readGuestWorkspace } from './guest-workspace'
import { migrateGuestWorkspace, reconcileGuestManagedMigration } from './guest-managed-migration'
import { openGuestManagedRepository, managedGuestRecoveryNotices } from './guest-managed-repository'
import { captureWorkspaceSnapshot, assertOwnedWorkspaceSnapshot, disposeWorkspaceSnapshot } from './snapshot'
import { readBlob, blobIdentity } from './blobs'
import { compareManagedGuestRetained } from './guest-managed-retained'
import { createGuestLocalStore } from './guest-local-store'
import { admitLocalRoot } from './local-root'
import { acquireParticipantBarrier, GUEST_BARRIER_KEY } from './guest-barrier'

it('prepares a legacy guest once and atomically retains its exact managed head and original databases', async () => {
  const original = new CryKitDatabase(`synthetic-managed-migration-${crypto.randomUUID()}`)
  await loadLocalData(original)
  const binding = await openGuestBindings(original)
  await binding.files.open(); await binding.inspector.openDatabase()
  const before = await readGuestWorkspace(binding)
  const originalRows = await original.localDatas.toArray()
  try {
    const target = await migrateGuestWorkspace(binding)
    expect(target.version).toBe(3)
    expect(await reconcileGuestManagedMigration(binding, target.id)).toBe('published')
    expect(await compareManagedGuestRetained(binding.coordinator.name, target, new AbortController().signal)).toEqual([])
    const repository = await openGuestManagedRepository(binding.coordinator, target)
    const after = await repository.readWorkspace()
    expect(after.planner).toEqual(before.planner)
    expect(after.editorDocuments).toEqual(before.editorDocuments)
    expect(await original.localDatas.toArray()).toEqual(originalRows)
    for (const body of before.blobs) {
      const retained = after.blobs.find(value => blobIdentity(value.ref) === blobIdentity(body.ref))!
      expect(await readBlob(retained.content, body.ref.byteLength)).toEqual(await readBlob(body.content, body.ref.byteLength))
    }
    const captured = await captureWorkspaceSnapshot(repository)
    expect(captured.state.planner).toEqual(after.planner)
    await assertOwnedWorkspaceSnapshot(captured)
    const saved = await repository.save(after.planner.localData, after.planner.localData.revision)
    expect(saved.localData.revision).toBe(after.planner.localData.revision + 1)
    await expect(assertOwnedWorkspaceSnapshot(captured)).rejects.toThrow(/changed/)
    await disposeWorkspaceSnapshot(captured)
    await expect(migrateGuestWorkspace(binding)).rejects.toThrow()
    expect(await original.localDatas.toArray()).toEqual(originalRows)
    await new Promise<void>((resolve, reject) => {
      const transaction = original.backendDB().transaction('meta', 'readwrite')
      transaction.objectStore('meta').put({ key: 'pre-feature-edit', value: 'retain both branches' })
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error)
    })
    expect(await compareManagedGuestRetained(binding.coordinator.name, target, new AbortController().signal)).toEqual([{ id: target.id, status: 'diverged', frozenCaptureId: (await binding.coordinator.table('managedMigrations').get(target.id)).capture.id }])
    expect(await managedGuestRecoveryNotices(repository)).toEqual([{ id: target.id, status: 'diverged', frozenCaptureId: (await binding.coordinator.table('managedMigrations').get(target.id)).capture.id }])
    const selectedBefore = await binding.coordinator.active.get('active')
    await expect(repository.save(saved.localData, saved.localData.revision)).rejects.toThrow(/Retained local data/)
    expect(await binding.coordinator.active.get('active')).toEqual(selectedBefore)
  } finally { original.close(); binding.inspector.close(); binding.files.close(); binding.coordinator.close() }
}, 30_000)

it('retains the old head after a source race and reconciles interrupted barriers without deleting preparation', async () => {
  const original = new CryKitDatabase(`synthetic-managed-race-${crypto.randomUUID()}`)
  await loadLocalData(original)
  const binding = await openGuestBindings(original)
  await binding.files.open(); await binding.inspector.openDatabase()
  const rows = binding.coordinator.table('managedMigrations'), add = rows.add.bind(rows)
  const race = vi.spyOn(rows, 'add').mockImplementation(row => Dexie.Promise.resolve().then(async () => {
    const key = await add(row)
    // A pre-feature writer changes durable source bytes after capture without advancing the coordinator
    await original.meta.put({ key: 'synthetic-retained-race', value: 'preserve me' })
    return key
  }))
  try {
    await expect(migrateGuestWorkspace(binding)).rejects.toThrow(/changed during migration/)
    race.mockRestore()
    expect((await binding.coordinator.active.get('active'))?.manifest).toEqual(binding.manifest)
    expect(await original.meta.get('synthetic-retained-race')).toEqual({ key: 'synthetic-retained-race', value: 'preserve me' })
    const journal = (await rows.toArray())[0]
    expect(journal.phase).toBe('publishing')
    expect(await binding.coordinator.table('managedRecords').count()).toBeGreaterThan(0)
    // Recreate an actual crash boundary with a durable publishing row and partially acquired barrier
    await acquireParticipantBarrier(original, journal.id)
    expect(await reconcileGuestManagedMigration(binding, journal.id)).toBe('failed')
    expect(await original.meta.get(GUEST_BARRIER_KEY)).toBeUndefined()
    expect((await rows.get(journal.id)).phase).toBe('failed')
    expect((await binding.coordinator.active.get('active'))?.manifest).toEqual(binding.manifest)
    expect(await binding.coordinator.table('managedOperations').get(journal.id)).toBeUndefined()
    expect(await binding.coordinator.table('managedRecords').count()).toBeGreaterThan(0)
  } finally { race.mockRestore(); original.close(); binding.inspector.close(); binding.files.close(); binding.coordinator.close() }
}, 30_000)

it('migrates an actually published v2 restore with exact inherited history and legacy Inspector text', async () => {
  const { guestParticipants } = await import('./guest-workspace')
  const { captureGuestSnapshot } = await import('./guest-snapshot')
  const { previewGuestWorkspaceRestore, beginGuestWorkspaceRestore, stageGuestWorkspaceRestore, activateGuestWorkspaceRestore, releaseGuestWorkspaceRestorePreview } = await import('./restore')
  const { openHistoricalSnapshot } = await import('./snapshot')
  const { createEditorRepository } = await import('./editor-repository')
  const original = new CryKitDatabase(`synthetic-managed-v2-${crypto.randomUUID()}`)
  await loadLocalData(original)
  const binding = await openGuestBindings(original)
  await guestParticipants(binding)
  const text = '\ufeff{\r\n"Unknown":900719925474099312345,"Text":"\\ud800"\r\n}'
  const draft = await binding.inspector.import('historical.json', text, 'synthetic')
  const snapshot = await captureGuestSnapshot(binding)
  const preview = await previewGuestWorkspaceRestore(binding, snapshot)
  let selected: Awaited<ReturnType<typeof openGuestBindings>> | undefined
  let actual: Awaited<ReturnType<typeof captureWorkspaceSnapshot>> | undefined
  let source: Awaited<ReturnType<typeof captureGuestSnapshot>> | undefined
  try {
    const registered = await beginGuestWorkspaceRestore(preview)
    await stageGuestWorkspaceRestore(preview, registered.id)
    await activateGuestWorkspaceRestore(preview, registered.id)
    selected = await openGuestBindings(original)
    source = await captureGuestSnapshot(selected)
    const before = source.state
    const destinationBefore = (await selected.planner.localDatas.get('local-data-record'))!.operativePlanner!.savedDestinationChanges
    const target = await migrateGuestWorkspace(selected)
    const actualRoot = await admitLocalRoot(createGuestLocalStore(selected.coordinator, () => {}).adapter, target.root, { check: () => {}, assertCurrent: async () => {} })
    expect(actualRoot.destinationChanges).toEqual(destinationBefore)
    expect(await compareManagedGuestRetained(binding.coordinator.name, target, new AbortController().signal)).toEqual([])
    const repository = await openGuestManagedRepository(binding.coordinator, target)
    actual = await captureWorkspaceSnapshot(repository)
    expect(actual.state.planner).toEqual(before.planner)
    expect(actual.state.editorDocuments).toEqual(before.editorDocuments)
    expect(source.version).toBe(2); expect(actual.version).toBe(2)
    if (source.version !== 2 || actual.version !== 2) throw new Error('Missing inherited historical evidence')
    expect(actual.historicalEvidence).toEqual(source.historicalEvidence)
    for (const member of source.historicalEvidence.snapshots) {
      const expected = await openHistoricalSnapshot(source, member.id)
      const retained = await openHistoricalSnapshot(actual, member.id)
      expect({ ...retained, state: { ...retained.state, blobs: retained.state.blobs.map(body => body.ref) } }).toEqual({ ...expected, state: { ...expected.state, blobs: expected.state.blobs.map(body => body.ref) } })
      for (const body of expected.state.blobs) {
        const found = retained.state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(body.ref))!
        expect(await readBlob(found.content, body.ref.byteLength)).toEqual(await readBlob(body.content, body.ref.byteLength))
      }
    }
    const opened = await createEditorRepository(repository).read(draft.id)
    expect(opened?.content.originalText).toBe(text)
    expect(opened?.content.lastAppliedText).toBe(text)
    expect(await binding.inspector.get(draft.id)).toMatchObject({ originalText: text, draftText: text })
  } finally {
    if (actual) await disposeWorkspaceSnapshot(actual)
    if (source) await disposeWorkspaceSnapshot(source)
    await releaseGuestWorkspaceRestorePreview(preview)
    await disposeWorkspaceSnapshot(snapshot)
    selected?.planner.close(); selected?.inspector.close(); selected?.files.close(); selected?.coordinator.close()
    original.close(); binding.inspector.close(); binding.files.close(); binding.coordinator.close()
  }
}, 120_000)

it('does not create a missing managed coordinator while checking retained sources', async () => {
  const name = `synthetic-missing-monitor-${crypto.randomUUID()}`
  await expect(compareManagedGuestRetained(name, { version: 3, id: 'missing', revision: 0, root: { documentId: 'missing', revisionId: 'missing' } }, new AbortController().signal)).rejects.toThrow()
  expect(await Dexie.exists(name)).toBe(false)
})
