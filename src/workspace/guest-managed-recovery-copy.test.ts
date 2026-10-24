import './guest-managed-monitor.test-helpers'
import { expect, it, vi } from 'vitest'
import { CryKitDatabase } from '../persistence/database'
import { createBlankLocalData, addGameSetupRevision, createPlaythrough } from '../domain/local-data'
import { createBuild } from '../domain/builds'
import { openGuestBindings } from './guest-workspace'
import { migrateGuestWorkspace } from './guest-managed-migration'
import { openGuestManagedRepository, managedGuestRecoveryNotices } from './guest-managed-repository'
import { copyRepositoryGuestRecovery, inspectRepositoryGuestRecovery, exportRepositoryGuestRecovery } from './guest-repository'
import { captureWorkspaceSnapshot, openHistoricalSnapshot, disposeWorkspaceSnapshot } from './snapshot'
import { createGuestLocalStore, type GuestManagedManifest } from './guest-local-store'
import { admitLocalRoot } from './local-root'
import { readBlob, blobIdentity } from './blobs'

// Keep the transaction semantics case small; the native browser journey retains all bundled catalogs
vi.mock('../catalog/bundled', async importOriginal => ({ ...await importOriginal<typeof import('../catalog/bundled')>(), BUNDLED_CATALOGS: [] }))

it('copies an explicitly selected retained branch into a writable managed head with both complete originals recoverable', async () => {
  const original = new CryKitDatabase(`synthetic-managed-recovery-copy-${crypto.randomUUID()}`)
  let localData = addGameSetupRevision(createBlankLocalData(), { label: 'Synthetic local setup', catalogLock: {} })
  const setup = localData.gameSetups[localData.planningGameSetupRevisionId!]!
  localData = createPlaythrough(localData, { label: 'Synthetic selected Playthrough', currentGameSetupRevisionId: setup.id })
  localData = createBuild(localData, { title: 'Synthetic retained Build', gameSetupId: setup.gameSetupId })
  await original.localDatas.put({ id: 'local-data-record', revision: localData.revision, updatedAt: localData.updatedAt, localData, lineage: { rootLocalDataId: localData.id } })
  const binding = await openGuestBindings(original)
  await binding.files.open(); await binding.inspector.openDatabase()
  const text = '\ufeff{\r\n"Unknown":900719925474099312345,"Text":"\\ud800"\r\n}'
  await binding.inspector.import('retained.json', text, 'synthetic')
  try {
    const migrated = await migrateGuestWorkspace(binding)
    const repository = await openGuestManagedRepository(binding.coordinator, migrated)
    const initial = (await repository.load()).localData, id = Object.keys(initial.builds)[0]!
    await repository.save({ ...initial, builds: { ...initial.builds, [id]: { ...initial.builds[id]!, title: 'Selected managed work' } } }, initial.revision)
    const before = await repository.readWorkspace(), beforeManifest = (await binding.coordinator.active.get('active'))!.manifest as unknown as GuestManagedManifest
    const old = (await original.localDatas.get('local-data-record'))!
    const changed = { ...old, localData: { ...old.localData, builds: { ...old.localData.builds, [id]: { ...old.localData.builds[id]!, title: 'Retained old-tab work' } } } }
    // Simulate an actual pre-feature writer that does not participate in the new write barrier
    await new Promise<void>((resolve, reject) => {
      const tx = original.backendDB().transaction('localDatas', 'readwrite')
      tx.objectStore('localDatas').put(changed)
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error)
    })
    const notice = (await managedGuestRecoveryNotices(repository))![0]!
    expect(notice.status).toBe('diverged')
    expect((await inspectRepositoryGuestRecovery(repository, notice)).editorRecords).toBeGreaterThan(0)
    let exported = 0, closed = false
    await exportRepositoryGuestRecovery(repository, notice, { async write(bytes) { exported += bytes.length }, async close() { closed = true }, async abort() { throw new Error('Unexpected recovery export abort') } })
    expect(exported).toBeGreaterThan(text.length); expect(closed).toBe(true)
    await expect(copyRepositoryGuestRecovery(repository, notice, () => false)).rejects.toThrow(/draft/)
    expect((await binding.coordinator.active.get('active'))!.manifest).toEqual(beforeManifest)
    await copyRepositoryGuestRecovery(repository, notice, () => true)
    await expect(repository.load()).rejects.toThrow(/retired/)
    const selected = (await binding.coordinator.active.get('active'))!.manifest as unknown as GuestManagedManifest
    expect(selected.recoveryId).toBeTruthy()
    const reopened = await openGuestManagedRepository(binding.coordinator, selected)
    expect(await managedGuestRecoveryNotices(reopened)).toEqual([])
    const after = await reopened.readWorkspace()
    expect(after.planner.localData.builds[id]!.title).toBe('Retained old-tab work')
    expect(after.planner.localData.selectedPlaythroughId).toBe(before.planner.localData.selectedPlaythroughId)
    expect(after.planner.history.slice(0, before.planner.history.length)).toEqual(before.planner.history)
    expect(after.planner.history.at(-1)).toMatchObject({ command: 'guest-restore', before: before.planner.localData, after: after.planner.localData })
    const snapshot = await captureWorkspaceSnapshot(reopened)
    try {
      expect(snapshot.version).toBe(2)
      if (snapshot.version !== 2) throw new Error('Missing complete pre-copy evidence')
      let foundPrevious = false, foundRetained = false
      // Historical readers deliberately admit one complete native graph at a time
      for (const value of snapshot.historicalEvidence.snapshots) {
        const member = await openHistoricalSnapshot(snapshot, value.id)
        try {
          const title = member.state.planner.localData.builds[id]?.title
          if (title === 'Selected managed work') { expect(member.state.planner).toEqual(before.planner); foundPrevious = true }
          else if (title === 'Retained old-tab work') { expect(member.state.planner.localData).toEqual(changed.localData); foundRetained = true }
          else throw new Error('Unexpected pre-copy historical member')
          for (const body of before.blobs) {
            const actual = member.state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(body.ref))!
            expect(await readBlob(actual.content, actual.ref.byteLength)).toEqual(await readBlob(body.content, body.ref.byteLength))
          }
        } finally { await disposeWorkspaceSnapshot(member) }
      }
      expect(foundPrevious).toBe(true); expect(foundRetained).toBe(true)
    } finally { await disposeWorkspaceSnapshot(snapshot) }
    expect(await original.localDatas.get('local-data-record')).toEqual(changed)
    expect((await binding.inspector.list())[0]!.filename).toBe('retained.json')
    const oldRoot = await admitLocalRoot(createGuestLocalStore(binding.coordinator, () => {}).adapter, beforeManifest.root, { check: () => {}, assertCurrent: async () => {} })
    expect(oldRoot.state.planner).toEqual(before.planner)
    const saved = await reopened.save(after.planner.localData, after.planner.localData.revision)
    expect(saved.localData.revision).toBe(after.planner.localData.revision + 1)
  } finally { original.close(); binding.inspector.close(); binding.files.close(); binding.coordinator.close() }
}, 120_000)
