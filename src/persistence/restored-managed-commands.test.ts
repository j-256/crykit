import 'fake-indexeddb/auto'
import '../workspace/guest-managed-monitor.test-helpers'
import { expect, it, vi } from 'vitest'
import { CryKitDatabase } from './database'
import { changedLocalData } from './local-data'
import { createDetachedGuestGraph, detachedGuestBindings } from '../workspace/detached-guest.test-helpers'
import { openGuestBindings, guestParticipants } from '../workspace/guest-workspace'
import { captureGuestSnapshot } from '../workspace/guest-snapshot'
import { disposeWorkspaceSnapshot } from '../workspace/snapshot'
import { previewGuestWorkspaceRestore, beginGuestWorkspaceRestore, stageGuestWorkspaceRestore, activateGuestWorkspaceRestore } from '../workspace/restore'
import { migrateGuestWorkspace } from '../workspace/guest-managed-migration'
import { createGuestRepository, readGuestSaveRecovery } from '../workspace/guest-repository'
import { managedGuestBinding } from '../workspace/managed-guest.test-helpers'
import { commitOwnedFile, newOwnedFileCommand, verifyOwnedFileReceipt, resolveOwnedFileReceipt } from '../workspace/owned-file-command'
import { createSaveRepository } from '../workspace/save-repository'
import { createGuestLocalStore } from '../workspace/guest-local-store'
import { hashBlob, memoryBlob, readBlob } from '../workspace/blobs'
import { admitLocalRoot } from '../workspace/local-root'
import { INDEX_PAGE_BYTES } from '../workspace/directory'

vi.mock('../catalog/bundled', async importOriginal => ({ ...await importOriginal<typeof import('../catalog/bundled')>(), BUNDLED_CATALOGS: [] }))

it('preserves restored history through managed full commands, file receipts, planner save, Undo, and Save recovery', async () => {
  const database = new CryKitDatabase(`restored-managed-${crypto.randomUUID()}`)
  const binding = await detachedGuestBindings(createDetachedGuestGraph(database))
  await guestParticipants(binding)
  const snapshot = await captureGuestSnapshot(binding)
  try {
    const preview = await previewGuestWorkspaceRestore(binding, snapshot)
    const journal = await beginGuestWorkspaceRestore(preview)
    await stageGuestWorkspaceRestore(preview, journal.id)
    await activateGuestWorkspaceRestore(preview, journal.id)
    const detached = await openGuestBindings(new CryKitDatabase(database.name))
    // The launch opener never performs this conversion implicitly
    await expect(createGuestRepository(database).readWorkspace()).rejects.toThrow()
    try { await migrateGuestWorkspace(detached) }
    finally { detached.planner.close(); detached.inspector.close(); detached.files.close(); detached.coordinator.close() }

    let repository = createGuestRepository(database)
    const before = await repository.readWorkspace()
    const saved = await repository.commitWorkspace(before, before.planner.localData.revision)
    repository = createGuestRepository(database)
    const after = await repository.readWorkspace()
    expect(saved.revision).toBe(before.planner.localData.revision + 1)
    expect(after.planner.localData.revision).toBe(saved.revision)
    expect(after.planner.history.length).toBeGreaterThan(before.planner.history.length)

    const command = newOwnedFileCommand('apply')
    const outcome = await commitOwnedFile(repository, after, after, command)
    expect(outcome.status).toBe('saved')
    expect(outcome.receipt?.id).toBe(command.id)
    await verifyOwnedFileReceipt(outcome.receipt!)
    const savedBinding = await managedGuestBinding(createGuestRepository(database))
    const store = createGuestLocalStore(savedBinding.coordinator, savedBinding.assertProfile)
    const rootRef = savedBinding.manifest.root
    const records = savedBinding.coordinator.table('managedRecords'), chunks = savedBinding.coordinator.table('managedChunks')
    const rootRecord = await records.get(rootRef.revisionId), rootChunk = await chunks.get([rootRef.revisionId, 0])
    const root = JSON.parse(new TextDecoder().decode(await readBlob(await store.adapter.read(rootRef), INDEX_PAGE_BYTES)))
    const evidence = JSON.parse(new TextDecoder().decode(await readBlob(await store.adapter.read(root.inheritedEvidence), INDEX_PAGE_BYTES)))
    expect(evidence.roots).not.toHaveLength(0)
    // A valid empty archive still must not replace the receipt's inherited history
    const replacement = await store.adapter.stage('replacement', memoryBlob(new TextEncoder().encode(JSON.stringify({ version: 1, kind: 'local-inherited-evidence', roots: [] }))), [])
    await store.flush('replacement')
    const rootBytes = new TextEncoder().encode(JSON.stringify({ ...root, inheritedEvidence: replacement }))
    await chunks.put({ ...rootChunk, bytes: rootBytes })
    await records.put({ ...rootRecord, byteLength: rootBytes.length, sha256: await hashBlob(memoryBlob(rootBytes)), dependencies: rootRecord.dependencies.map((ref: { revisionId: string }) => ref.revisionId === root.inheritedEvidence.revisionId ? replacement : ref) })
    try {
      await expect(admitLocalRoot(store.adapter, rootRef, { check: savedBinding.assertProfile, assertCurrent: () => store.assertCurrent(savedBinding.manifest) })).resolves.toBeDefined()
      await expect(verifyOwnedFileReceipt(outcome.receipt!)).rejects.toThrow(/saved.*root|receipt/i)
    } finally { await records.put(rootRecord); await chunks.put(rootChunk) }
    await verifyOwnedFileReceipt(outcome.receipt!)
    const completion = await resolveOwnedFileReceipt(outcome.receipt!)
    expect(completion.state.planner.localData.revision).toBe(after.planner.localData.revision + 1)
    const selected = await managedGuestBinding(completion.repository)
    expect(selected.manifest.version).toBe(3)
    expect(await selected.coordinator.table('managedOperations').get(command.id)).toMatchObject({ kind: 'managed-local-commit', target: selected.manifest })

    repository = createGuestRepository(database)
    const initial = await repository.readWorkspace()
    const proposed = changedLocalData(initial.planner.localData, initial.planner.localData, 'test-domain', new Date().toISOString() as typeof initial.planner.localData.updatedAt)
    const planned = await repository.save(proposed, initial.planner.localData.revision)
    expect(planned.localData.revision).toBe(proposed.revision)
    const plannedState = await createGuestRepository(database).readWorkspace()
    expect(plannedState.planner.journal?.checkpoints.at(-1)?.command).toBe('test-domain')
    const undone = await createGuestRepository(database).undo(planned.localData.revision)
    expect(undone.localData.revision).toBe(planned.localData.revision + 1)
    expect((await createGuestRepository(database).readWorkspace()).planner.localData.revision).toBe(undone.localData.revision)

    repository = createGuestRepository(database)
    const bytes = new Uint8Array([99, 0, 1])
    const file = await createSaveRepository(repository).importFile('retained.sav', bytes)
    const content = await readGuestSaveRecovery(repository, file)
    expect(content.originalBytes).toEqual(bytes)
    expect(content.workingBytes).toEqual(bytes)
  } finally { await disposeWorkspaceSnapshot(snapshot); binding.planner.close(); binding.inspector.close(); binding.files.close(); binding.coordinator.close() }
})
