import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import Dexie from 'dexie'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CryKitDatabase } from './database'
import { changedLocalData, loadLocalData, saveLocalDataWithStatus } from './local-data'
import { createBlankLocalData } from '../domain/local-data'
import { guestParticipants, openGuestBindings, readGuestWorkspace } from '../workspace/guest-workspace'
import { captureGuestSnapshot } from '../workspace/guest-snapshot'
import { activateGuestWorkspaceRestore, beginGuestWorkspaceRestore, previewGuestWorkspaceRestore, stageGuestWorkspaceRestore } from '../workspace/restore'
import { disposeWorkspaceSnapshot } from '../workspace/snapshot'
import { exportWorkspaceBackup, readWorkspaceBackup } from '../interchange/workspace-backup'
import { memoryBlob } from '../workspace/blobs'
import { requireGuestRestoreJournal, requireGuestSuccessorJournal, type GuestRestoreJournal, type GuestSuccessorJournal } from '../workspace/guest-coordinator'
import { guestPlannerValuesEqual } from './guest-planner-record'
import { captureGuestRecovery, checkGuestRecovery, copyGuestRecovery } from '../workspace/guest-recovery'
import { acquireParticipantBarrier, GUEST_BARRIER_KEY } from '../workspace/guest-barrier'
import { createGuestRepository, readGuestSaveRecovery } from '../workspace/guest-repository'
import { commitOwnedFile, newOwnedFileCommand, resolveOwnedFileReceipt, verifyOwnedFileReceipt } from '../workspace/owned-file-command'
import { createSaveRepository } from '../workspace/save-repository'

// Native restore journals and deterministic participant names must be exercised before managed startup migration
vi.mock('../workspace/guest-managed-startup', async importOriginal => {
  const actual = await importOriginal<typeof import('../workspace/guest-managed-startup')>()
  const { openGuestBindings } = await import('../workspace/guest-workspace')
  return { ...actual, prepareGuestStartup: async (original: CryKitDatabase) => ({ kind: 'legacy-recovery', binding: await openGuestBindings(original) }) }
})

const names: string[] = []
afterEach(async () => { for (const name of names.splice(0)) await Dexie.delete(name) })
const backupStagingNames = async () => (await Dexie.getDatabaseNames()).filter(name => name.startsWith('crykit-backup-staging-')).sort()
const legacyBackup = Buffer.from((JSON.parse(readFileSync(new URL('../interchange/workspace-backup-v1.fixtures.json', import.meta.url), 'utf8')) as { archive: string }[])[2].archive, 'base64')
it('releases v1 normalization if guest preview fails after inheritance', async () => {
  const planner = new CryKitDatabase(`guest-restore-${crypto.randomUUID()}`)
  names.push(planner.name, `${planner.name}-coordinator`, `${planner.name}-inspector`, `${planner.name}-workspace-files-v1`)
  const binding = await openGuestBindings(planner)
  let input: Awaited<ReturnType<typeof readWorkspaceBackup>> | undefined
  const originalStaging = await backupStagingNames()
  try {
    await blankPlanner(planner)
    input = await readWorkspaceBackup(memoryBlob(legacyBackup).open())
    expect(input.version).toBe(1)
    const uploadedStaging = await backupStagingNames()
    expect(uploadedStaging).toHaveLength(originalStaging.length + 1)
    const failedBinding = { ...binding, planner: { open: async () => { throw new Error('Synthetic participant failure') } } as unknown as CryKitDatabase }
    await expect(previewGuestWorkspaceRestore(failedBinding, input)).rejects.toThrow('Synthetic participant failure')
    expect(await backupStagingNames()).toEqual(uploadedStaging)
  } finally {
    if (input) await disposeWorkspaceSnapshot(input)
    planner.close(); binding.inspector.close(); binding.files.close(); binding.coordinator.close()
    expect(await backupStagingNames()).toEqual(originalStaging)
  }
})
it('compares restored values without property order and still rejects changed content', () => {
  const source = { id: 'change', revision: 1, endpoint: { unknown: true, count: 0 } }
  expect(guestPlannerValuesEqual(source, { endpoint: { count: 0, unknown: true }, revision: 1, id: 'change' })).toBe(true)
  expect(guestPlannerValuesEqual(source, { endpoint: { count: 1, unknown: true }, revision: 1, id: 'change' })).toBe(false)
})
async function blankPlanner(planner: CryKitDatabase) {
  const localData = createBlankLocalData()
  await planner.localDatas.add({ id: 'local-data-record', revision: localData.revision, updatedAt: localData.updatedAt, localData, lineage: { rootLocalDataId: localData.id } })
  await loadLocalData(planner)
}

describe('published guest restore', () => {
  const sharedNames: string[] = []
  let v2SaveRevision: number
  let planner: CryKitDatabase
  let binding: Awaited<ReturnType<typeof openGuestBindings>>
  let snapshot: Awaited<ReturnType<typeof captureGuestSnapshot>> | undefined
  let target: GuestRestoreJournal['target']
  beforeAll(async () => {
    planner = new CryKitDatabase(`guest-restore-${crypto.randomUUID()}`)
    sharedNames.push(planner.name, `${planner.name}-coordinator`, `${planner.name}-inspector`, `${planner.name}-workspace-files-v1`)
    binding = await openGuestBindings(planner)
  })
  afterAll(async () => {
    if (snapshot) await disposeWorkspaceSnapshot(snapshot)
    planner?.close(); binding?.inspector.close(); binding?.files.close(); binding?.coordinator.close()
    for (const name of sharedNames) await Dexie.delete(name)
  })
  it('registers fresh v2 target names and reopens after Inspector and planner edits', async () => {
    await blankPlanner(planner)
    await guestParticipants(binding)
    snapshot = await captureGuestSnapshot(binding)
    const preview = await previewGuestWorkspaceRestore(binding, snapshot)
    const before = (await binding.coordinator.active.get('active'))!.manifest
    const journal = await beginGuestWorkspaceRestore(preview)
    expect(requireGuestRestoreJournal(await binding.coordinator.journal.get(journal.id))).toEqual(journal)
    expect(journal.target.planner).toBe(`crykit-restored-v2-${journal.id}-planner`)
    expect(journal.target.inspector).toBe(`crykit-restored-v2-${journal.id}-inspector`)
    expect(journal.target.files).toBe(`crykit-restored-v2-${journal.id}-files`)
    expect((await binding.coordinator.active.get('active'))!.manifest).toEqual(before)
    const databases = await Dexie.getDatabaseNames()
    expect(databases).not.toContain(journal.target.planner)
    expect(databases).not.toContain(journal.target.inspector)
    expect(databases).not.toContain(journal.target.files)
    sharedNames.push(journal.target.planner, journal.target.inspector, journal.target.files)
    const staged = await stageGuestWorkspaceRestore(preview, journal.id)
    expect(staged.phase).toBe('staged')
    expect((await binding.coordinator.active.get('active'))!.manifest).toEqual(before)
    expect(await checkGuestRecovery(binding)).toEqual([])
    expect(await activateGuestWorkspaceRestore(preview, staged.id)).toEqual(staged.target)
    target = staged.target
    const selected = await openGuestBindings(new CryKitDatabase(planner.name))
    try {
      expect(selected.manifest).toEqual(target)
      expect(await checkGuestRecovery(selected)).toEqual([])
      await readGuestWorkspace(selected)
      const loaded = await loadLocalData(selected.planner)
      const draft = await selected.inspector.import('Synthetic.json', '{"Unknown":"preserved draft"}', 'synthetic-reference')
      const reopened = await openGuestBindings(new CryKitDatabase(planner.name))
      try {
        expect((await readGuestWorkspace(reopened)).planner.localData.revision).toBe(loaded.revision)
        expect((await reopened.inspector.get(draft.id))?.draftText).toBe(draft.draftText)
        await saveLocalDataWithStatus(loaded.localData, loaded.revision, reopened.planner)
      }
      finally { reopened.planner.close(); reopened.inspector.close(); reopened.files.close(); reopened.coordinator.close() }
      const afterSave = await openGuestBindings(new CryKitDatabase(planner.name))
      try { expect((await readGuestWorkspace(afterSave)).planner.localData.revision).toBeGreaterThan(loaded.revision) }
      finally { afterSave.planner.close(); afterSave.inspector.close(); afterSave.files.close(); afterSave.coordinator.close() }
    } finally { selected.planner.close(); selected.inspector.close(); selected.files.close(); selected.coordinator.close() }
  })
  it('round-trips the restored planner journal and inherited history through a complete backup', async () => {
    const selected = await openGuestBindings(new CryKitDatabase(planner.name))
    let restoredBackup: Awaited<ReturnType<typeof captureGuestSnapshot>> | undefined
    let imported: Awaited<ReturnType<typeof readWorkspaceBackup>> | undefined
    try {
      restoredBackup = await captureGuestSnapshot(selected)
      imported = await readWorkspaceBackup(exportWorkspaceBackup(restoredBackup))
      expect(imported.state.planner.journal).toBeDefined()
      expect(imported.state.planner.history.length).toBeGreaterThan(0)
    } finally {
      if (imported) await disposeWorkspaceSnapshot(imported)
      if (restoredBackup) await disposeWorkspaceSnapshot(restoredBackup)
      selected.planner.close(); selected.inspector.close(); selected.files.close(); selected.coordinator.close()
    }
  })
  it('publishes a full-workspace successor from a selected v2 profile and reopens its history', async () => {
    const repository = createGuestRepository(new CryKitDatabase(planner.name))
    const before = await repository.readWorkspace()
    const saved = await repository.commitWorkspace(before, before.planner.localData.revision)
    const successor = await openGuestBindings(new CryKitDatabase(planner.name))
    sharedNames.push(successor.manifest.planner, successor.manifest.inspector, successor.manifest.files)
    try {
      expect(successor.manifest.version).toBe(2)
      expect(successor.manifest.id).not.toBe(target.id)
      expect(saved.revision).toBe(before.planner.localData.revision + 1)
      const reopened = await readGuestWorkspace(successor)
      expect(reopened.planner.localData.revision).toBe(saved.revision)
      expect(reopened.planner.history.length).toBeGreaterThan(before.planner.history.length)
      expect(await checkGuestRecovery(successor)).toEqual([])
    } finally { successor.planner.close(); successor.inspector.close(); successor.files.close(); successor.coordinator.close() }
  })
  it('commits an owned file command at the selected v2 revision and verifies its receipt', async () => {
    const repository = createGuestRepository(new CryKitDatabase(planner.name))
    const before = await repository.readWorkspace()
    const command = newOwnedFileCommand('apply')
    const outcome = await commitOwnedFile(repository, before, before, command)
    expect(outcome.status).toBe('saved')
    expect(outcome.receipt?.id).toBe(command.id)
    await verifyOwnedFileReceipt(outcome.receipt!)
    const completion = await resolveOwnedFileReceipt(outcome.receipt!)
    expect(completion.state.planner.localData.revision).toBe(before.planner.localData.revision + 1)
    const successor = await openGuestBindings(new CryKitDatabase(planner.name))
    sharedNames.push(successor.manifest.planner, successor.manifest.inspector, successor.manifest.files)
    try {
      const row = requireGuestSuccessorJournal(await successor.coordinator.journal.get(successor.manifest.id))
      expect(row.kind).toBe('guest-successor')
      expect(row.commandId).toBe(command.id)
    } finally { successor.planner.close(); successor.inspector.close(); successor.files.close(); successor.coordinator.close() }
  })
  it('publishes an ahead-revision planner save as a selected v2 successor', async () => {
    const selected = createGuestRepository(new CryKitDatabase(planner.name))
    const before = await selected.readWorkspace()
    const proposed = changedLocalData(before.planner.localData, before.planner.localData, 'test-domain', new Date().toISOString() as typeof before.planner.localData.updatedAt)
    const saved = await selected.save(proposed, before.planner.localData.revision)
    expect(saved.localData.revision).toBe(proposed.revision)
    v2SaveRevision = saved.localData.revision
    const savedBinding = await openGuestBindings(new CryKitDatabase(planner.name))
    sharedNames.push(savedBinding.manifest.planner, savedBinding.manifest.inspector, savedBinding.manifest.files)
    try {
      expect(savedBinding.manifest.version).toBe(2)
      const savedState = await readGuestWorkspace(savedBinding)
      expect(savedState.planner.journal?.checkpoints.at(-1)?.command).toBe('test-domain')
    } finally { savedBinding.planner.close(); savedBinding.inspector.close(); savedBinding.files.close(); savedBinding.coordinator.close() }
  })
  it('publishes operative Undo over the selected v2 save and reopens it', async () => {
    const undoRepository = createGuestRepository(new CryKitDatabase(planner.name))
    const before = await undoRepository.readWorkspace()
    expect(before.planner.localData.revision).toBe(v2SaveRevision)
    const undone = await undoRepository.undo(v2SaveRevision)
    expect(undone.localData.revision).toBe(v2SaveRevision + 1)
    const reopened = await openGuestBindings(new CryKitDatabase(planner.name))
    sharedNames.push(reopened.manifest.planner, reopened.manifest.inspector, reopened.manifest.files)
    try { expect((await readGuestWorkspace(reopened)).planner.localData.revision).toBe(v2SaveRevision + 1) }
    finally { reopened.planner.close(); reopened.inspector.close(); reopened.files.close(); reopened.coordinator.close() }
  })
  it('reads an exact save original from a published v2 successor for recovery', async () => {
    const repository = createGuestRepository(new CryKitDatabase(planner.name))
    const bytes = new Uint8Array([99, 0, 1])
    const saved = await createSaveRepository(repository).importFile('retained.sav', bytes)
    const content = await readGuestSaveRecovery(repository, saved)
    expect(content.originalBytes).toEqual(bytes)
    const selected = await openGuestBindings(new CryKitDatabase(planner.name))
    sharedNames.push(selected.manifest.planner, selected.manifest.inspector, selected.manifest.files)
    selected.planner.close(); selected.inspector.close(); selected.files.close(); selected.coordinator.close()
  })
  it('reports an unaware old-tab write and captures the retained branch for recovery', async () => {
    const selected = await openGuestBindings(new CryKitDatabase(planner.name))
    try {
      const selectedInspector = await selected.inspector.openDatabase()
      const sourceDraft = (await selectedInspector.table('drafts').toArray())[0] as Record<string, unknown> | undefined
      expect(sourceDraft).toBeDefined()
      const restoredDraftId = crypto.randomUUID()
      const rawDraft = { ...sourceDraft!, id: restoredDraftId, filename: 'Recovered Original.json' }
      const rawChunks = (await selectedInspector.table('chunks').toArray()).filter((row: { draftId: string }) => row.draftId === sourceDraft!.id)
        .map((row: Record<string, unknown>) => ({ ...row, draftId: restoredDraftId }))
      const retiredInspector = await binding.inspector.openDatabase()
      await new Promise<void>((resolve, reject) => {
        const transaction = retiredInspector.backendDB().transaction(['drafts', 'chunks'], 'readwrite')
        transaction.objectStore('drafts').put(rawDraft)
        for (const chunk of rawChunks) transaction.objectStore('chunks').put(chunk)
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error)
      })
      const notices = await checkGuestRecovery(selected)
      expect(notices).toEqual([{ id: target.id, status: 'diverged', frozenCaptureId: expect.any(String) }])
      const retained = await captureGuestRecovery(selected, notices[0])
      expect(retained.completed).toBe(true)
      expect(retained.id).not.toBe(notices[0].frozenCaptureId)
      expect((await selected.coordinator.active.get('active'))?.manifest).toEqual(selected.manifest)
      await copyGuestRecovery(selected, retained, () => true)
      const copied = await openGuestBindings(new CryKitDatabase(planner.name))
      sharedNames.push(copied.manifest.planner, copied.manifest.inspector, copied.manifest.files)
      try {
        const recovered = await copied.inspector.get(restoredDraftId)
        expect(recovered?.filename).toBe('Recovered Original.json')
        expect(recovered?.originalText).toBeTruthy()
        const table = copied.coordinator.table<GuestSuccessorJournal, string>('journal')
        const journal = requireGuestSuccessorJournal(await table.get(copied.manifest.id))
        expect(journal.recoveryCapture).toBeDefined()
        const changed = { ...journal, recoveryCapture: { ...journal.recoveryCapture!, participants: journal.recoveryCapture!.participants.map((participant, index) => index === 0 ? { ...participant, name: `${participant.name}-changed` } : participant) } }
        await table.put(changed)
        try { await expect(openGuestBindings(new CryKitDatabase(planner.name))).rejects.toThrow('recovery capture changed') }
        finally { await table.put(journal) }
      } finally { copied.planner.close(); copied.inspector.close(); copied.files.close(); copied.coordinator.close() }
    } finally { selected.planner.close(); selected.inspector.close(); selected.files.close(); selected.coordinator.close() }
  })
})

it('does not register a target when the selected source changes after preview', async () => {
  const planner = new CryKitDatabase(`guest-restore-${crypto.randomUUID()}`)
  names.push(planner.name, `${planner.name}-coordinator`, `${planner.name}-inspector`, `${planner.name}-workspace-files-v1`)
  const binding = await openGuestBindings(planner)
  let snapshot: Awaited<ReturnType<typeof captureGuestSnapshot>> | undefined
  try {
    await blankPlanner(planner)
    await guestParticipants(binding)
    snapshot = await captureGuestSnapshot(binding)
    const preview = await previewGuestWorkspaceRestore(binding, snapshot)
    await planner.meta.put({ key: 'synthetic-change', value: 'after-preview' })
    await expect(beginGuestWorkspaceRestore(preview)).rejects.toThrow('changed')
    expect(await binding.coordinator.journal.count()).toBe(0)
  } finally { if (snapshot) await disposeWorkspaceSnapshot(snapshot); planner.close(); binding.inspector.close(); binding.files.close(); binding.coordinator.close() }
})

it('releases a source barrier after interruption before its acquired list is journaled', async () => {
  const planner = new CryKitDatabase(`guest-restore-${crypto.randomUUID()}`)
  names.push(planner.name, `${planner.name}-coordinator`, `${planner.name}-inspector`, `${planner.name}-workspace-files-v1`)
  const binding = await openGuestBindings(planner)
  let snapshot: Awaited<ReturnType<typeof captureGuestSnapshot>> | undefined
  try {
    await blankPlanner(planner)
    await guestParticipants(binding)
    snapshot = await captureGuestSnapshot(binding)
    const preview = await previewGuestWorkspaceRestore(binding, snapshot)
    const staged = await stageGuestWorkspaceRestore(preview, (await beginGuestWorkspaceRestore(preview)).id)
    names.push(staged.target.planner, staged.target.inspector, staged.target.files)
    await binding.coordinator.table<GuestRestoreJournal, string>('journal').put({ ...staged, phase: 'publishing' })
    await acquireParticipantBarrier(planner, staged.id)
    expect(await planner.meta.get(GUEST_BARRIER_KEY)).toEqual({ key: GUEST_BARRIER_KEY, value: staged.id })
    expect(await checkGuestRecovery(binding)).toEqual([])
    expect(await planner.meta.get(GUEST_BARRIER_KEY)).toBeUndefined()
    expect(requireGuestRestoreJournal(await binding.coordinator.journal.get(staged.id)).phase).toBe('blocked')
    expect((await binding.coordinator.active.get('active'))!.manifest).toEqual(binding.manifest)
  } finally { if (snapshot) await disposeWorkspaceSnapshot(snapshot); planner.close(); binding.inspector.close(); binding.files.close(); binding.coordinator.close() }
})

it('blocks publication when the old source changes after target staging', async () => {
  const planner = new CryKitDatabase(`guest-restore-${crypto.randomUUID()}`)
  names.push(planner.name, `${planner.name}-coordinator`, `${planner.name}-inspector`, `${planner.name}-workspace-files-v1`)
  const binding = await openGuestBindings(planner)
  let snapshot: Awaited<ReturnType<typeof captureGuestSnapshot>> | undefined
  try {
    await blankPlanner(planner)
    await guestParticipants(binding)
    snapshot = await captureGuestSnapshot(binding)
    const preview = await previewGuestWorkspaceRestore(binding, snapshot)
    const staged = await stageGuestWorkspaceRestore(preview, (await beginGuestWorkspaceRestore(preview)).id)
    names.push(staged.target.planner, staged.target.inspector, staged.target.files)
    await planner.meta.put({ key: 'synthetic-late-source', value: 'changed' })
    await expect(activateGuestWorkspaceRestore(preview, staged.id)).rejects.toThrow('changed during backup')
    expect((await binding.coordinator.active.get('active'))!.manifest).toEqual(binding.manifest)
    expect(requireGuestRestoreJournal(await binding.coordinator.journal.get(staged.id)).phase).toBe('blocked')
    expect(await planner.meta.get(GUEST_BARRIER_KEY)).toBeUndefined()
  } finally { if (snapshot) await disposeWorkspaceSnapshot(snapshot); planner.close(); binding.inspector.close(); binding.files.close(); binding.coordinator.close() }
})

it('blocks a registered attempt when the selected source changes before staging', async () => {
  const planner = new CryKitDatabase(`guest-restore-${crypto.randomUUID()}`)
  names.push(planner.name, `${planner.name}-coordinator`, `${planner.name}-inspector`, `${planner.name}-workspace-files-v1`)
  const binding = await openGuestBindings(planner)
  let snapshot: Awaited<ReturnType<typeof captureGuestSnapshot>> | undefined
  try {
    await blankPlanner(planner)
    await guestParticipants(binding)
    snapshot = await captureGuestSnapshot(binding)
    const preview = await previewGuestWorkspaceRestore(binding, snapshot)
    const selected = (await binding.coordinator.active.get('active'))!.manifest
    const journal = await beginGuestWorkspaceRestore(preview)
    names.push(journal.target.planner, journal.target.inspector, journal.target.files)
    await planner.meta.put({ key: 'synthetic-change', value: 'after-registration' })
    await expect(stageGuestWorkspaceRestore(preview, journal.id)).rejects.toThrow('changed')
    expect((await binding.coordinator.active.get('active'))!.manifest).toEqual(selected)
    expect(requireGuestRestoreJournal(await binding.coordinator.journal.get(journal.id)).phase).toBe('blocked')
    expect(await Dexie.getDatabaseNames()).not.toContain(journal.target.planner)
  } finally { if (snapshot) await disposeWorkspaceSnapshot(snapshot); planner.close(); binding.inspector.close(); binding.files.close(); binding.coordinator.close() }
})
