import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { expect, it, vi } from 'vitest'
import { CryKitDatabase, setDatabaseForTests } from './database'
import { createGuestRepository, guestRepositoryBindings, readGuestSaveRecovery } from '../workspace/guest-repository'
import { GuestCoordinatorDatabase, type GuestManifest } from '../workspace/guest-coordinator'
import { createBlankLocalData } from '../domain/local-data'
import { createSaveRepository } from '../workspace/save-repository'
import { resolveOwnedFileReceipt, verifyOwnedFileReceipt, type OwnedFileOutcome } from '../workspace/owned-file-command'
import { guestParticipants } from '../workspace/guest-workspace'

// Exercise retained native recovery before public startup migrates these named stores to managed storage
vi.mock('../workspace/guest-managed-startup', async importOriginal => {
  const actual = await importOriginal<typeof import('../workspace/guest-managed-startup')>()
  const { openGuestBindings } = await import('../workspace/guest-workspace')
  return { ...actual, prepareGuestStartup: async (original: CryKitDatabase) => ({ kind: 'legacy-recovery', binding: await openGuestBindings(original) }) }
})

it('rejects a retired captured binding before opening its planner and file participants', async () => {
  const database = new CryKitDatabase(`guest-participants-route-${crypto.randomUUID()}`)
  const opened: string[] = []
  try {
    const binding = await guestRepositoryBindings(createGuestRepository(database))
    const target = { version: 2, id: 'selected-v2', revision: binding.manifest.revision + 1, planner: `${database.name}-v2-planner`, inspector: `${database.name}-v2-inspector`, files: `${database.name}-v2-files` }
    await binding.coordinator.active.put({ key: 'active', manifest: target as GuestManifest })
    const open = indexedDB.open.bind(indexedDB)
    vi.spyOn(indexedDB, 'open').mockImplementation((name, version) => { opened.push(name); return version === undefined ? open(name) : open(name, version) })
    await expect(guestParticipants(binding)).rejects.toThrow()
    expect(opened).not.toContain(binding.manifest.planner)
    expect(opened).not.toContain(binding.manifest.files)
  } finally { vi.restoreAllMocks(); await database.delete() }
})

it.each(['v2', 'unknown-version', 'v1-hybrid', 'incomplete-v2'] as const)('rejects %s active manifest before constructing its named containers', async variant => {
  const database = new CryKitDatabase(`guest-start-route-${crypto.randomUUID()}`)
  const coordinator = new GuestCoordinatorDatabase(`${database.name}-coordinator`)
  const target = { version: 2, id: 'synthetic-v2', revision: 1, planner: `${database.name}-target-planner`, inspector: `${database.name}-target-inspector`, files: `${database.name}-target-files` }
  const manifest = variant === 'unknown-version' ? { ...target, version: 99 } : variant === 'v1-hybrid' ? { ...target, version: 1, creator: { operation: 'unadmitted' } } : variant === 'incomplete-v2' ? { ...target, files: undefined } : target
  try {
    await coordinator.active.put({ key: 'active', manifest: manifest as unknown as GuestManifest })
    const constructed = vi.spyOn(Dexie.prototype, 'version')
    await expect(createGuestRepository(database).readWorkspace()).rejects.toThrow()
    const names = constructed.mock.instances.map(value => value.name)
    expect(names).not.toContain(target.planner)
    expect(names).not.toContain(target.inspector)
    expect(names).not.toContain(target.files)
    vi.restoreAllMocks()
    expect(await Dexie.exists(target.planner)).toBe(false)
  } finally { vi.restoreAllMocks(); coordinator.close(); await coordinator.delete(); await database.delete() }
})

it('save recovery rejects an active v2 pointer before constructing any v2 target container', async () => {
  const database = new CryKitDatabase(`guest-save-route-${crypto.randomUUID()}`)
  try {
    let repository = createGuestRepository(database)
    let outcome: OwnedFileOutcome | undefined
    const saved = await createSaveRepository(repository, { onOutcome: value => { outcome = value } }).importFile('saved.sav', new Uint8Array([99, 0, 1]))
    expect(outcome?.status).toBe('saved')
    repository = (await resolveOwnedFileReceipt(outcome!.receipt!)).repository
    const binding = await guestRepositoryBindings(repository)
    const target = { version: 2, id: 'synthetic-v2', revision: binding.manifest.revision + 1, planner: `${database.name}-v2-planner`, inspector: `${database.name}-v2-inspector`, files: `${database.name}-v2-files` }
    await binding.coordinator.active.put({ key: 'active', manifest: target as GuestManifest })
    const constructed = vi.spyOn(Dexie.prototype, 'version')
    await expect(readGuestSaveRecovery(repository, saved)).rejects.toThrow()
    const names = constructed.mock.instances.map(value => value.name)
    expect(names).not.toContain(target.planner)
    expect(names).not.toContain(target.inspector)
    expect(names).not.toContain(target.files)
    vi.restoreAllMocks()
    expect(await Dexie.exists(target.planner)).toBe(false)
  } finally { vi.restoreAllMocks(); await database.delete() }
})

it('file receipt continuation and verification reject a replaced v2 journal before constructing the saved target', async () => {
  const database = new CryKitDatabase(`guest-receipt-route-${crypto.randomUUID()}`)
  try {
    const repository = createGuestRepository(database)
    let outcome: OwnedFileOutcome | undefined
    await createSaveRepository(repository, { onOutcome: value => { outcome = value } }).importFile('saved.sav', new Uint8Array([99, 0, 1]))
    expect(outcome?.status).toBe('saved')
    const receipt = outcome!.receipt!, binding = await guestRepositoryBindings(repository)
    const journal = (await binding.coordinator.journal.get(receipt.id))!
    await binding.coordinator.journal.put({ ...journal, version: 2, kind: 'guest-operation' } as unknown as typeof journal)
    const constructed = vi.spyOn(Dexie.prototype, 'version')
    await expect(resolveOwnedFileReceipt(receipt)).rejects.toThrow()
    await expect(verifyOwnedFileReceipt(receipt)).rejects.toThrow()
    const names = constructed.mock.instances.map(value => value.name)
    expect(names).not.toContain(journal.target.planner)
    expect(names).not.toContain(journal.target.inspector)
    expect(names).not.toContain(journal.target.files)
  } finally { vi.restoreAllMocks(); await database.delete() }
})

it('activates complete named guest containers while old captured repositories retain retired handles', async () => {
  const database = new CryKitDatabase(`guest-complete-${crypto.randomUUID()}`)
  setDatabaseForTests(database)
  try {
    const repository = createGuestRepository()
    const initial = await repository.readWorkspace()
    const { historyEntry } = await import('./local-data')
    const foreign = createBlankLocalData()
    const retainedHistory = historyEntry(foreign, { ...foreign, revision: 1 }, 'import', foreign.updatedAt)
    const next = { ...initial, planner: { ...initial.planner, history: [...initial.planner.history, retainedHistory], localData: { ...createBlankLocalData({ id: initial.planner.localData.id }), revision: initial.planner.localData.revision } } }
    await repository.commitWorkspace(next, initial.planner.localData.revision)
    await expect(repository.save(initial.planner.localData, initial.planner.localData.revision)).rejects.toThrow('retired')
    const successor = createGuestRepository()
    const reopened = await successor.readWorkspace()
    expect(Object.keys(reopened.planner.localData.playthroughs)).toHaveLength(0)
    expect(reopened.planner.history).toContainEqual(retainedHistory)
    expect(reopened.editorDocuments).toEqual([])
    expect(reopened.libraryDefaults).toEqual(next.libraryDefaults)
  } finally { setDatabaseForTests(undefined); await database.delete() }
})

it('copies an explicitly captured recovery branch only while the selected workspace has no drafts', async () => {
  const database = new CryKitDatabase(`guest-recovery-${crypto.randomUUID()}`)
  setDatabaseForTests(database)
  try {
    const old = createGuestRepository(), original = await old.readWorkspace()
    await old.commitWorkspace(original, original.planner.localData.revision)
    const selected = createGuestRepository()
    const { guestRepositoryBindings } = await import('../workspace/guest-repository')
    const { captureGuestRecovery, copyGuestRecovery } = await import('../workspace/guest-recovery')
    const binding = await guestRepositoryBindings(selected)
    const journal = (await binding.coordinator.journal.toArray())[0]
    const notice = { id: journal.id, status: 'diverged' as const, frozenCaptureId: journal.capture.id }
    const capture = await captureGuestRecovery(binding, notice)
    let checks = 0
    await expect(copyGuestRecovery(binding, capture, () => ++checks < 5)).rejects.toThrow('draft')
    expect((await binding.coordinator.active.get('active'))?.manifest).toEqual(binding.manifest)
    await copyGuestRecovery(binding, capture, () => true)
    const recovered = await createGuestRepository().readWorkspace()
    expect(recovered.planner.localData.builds).toEqual(original.planner.localData.builds)
    expect(await binding.coordinator.captures.get(capture.id)).toEqual(capture)
    expect(await binding.coordinator.journal.count()).toBeGreaterThan(1)
  } finally { setDatabaseForTests(undefined); await database.delete() }
})

it('ordinary save and undo preserve complete file, conflict and retained-content state in the selected manifest', async () => {
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const { guestRepositoryBindings } = await import('../workspace/guest-repository')
  const { createPersonalDefinition } = await import('../domain/local-data')
  const { state, file, closure, entries } = await editorClosureFixture()
  const database = new CryKitDatabase(`guest-preserved-${crypto.randomUUID()}`)
  setDatabaseForTests(database)
  try {
    const repository = createGuestRepository(), initial = await repository.readWorkspace()
    const conflict = { version: 1 as const, id: 'retained-conflict', unit: { kind: 'record' as const, privateKey: entries[0].key }, commonAncestor: { kind: 'present' as const, closure }, branches: [{ role: 'local-pending' as const, closure }, { role: 'accepted-cloud' as const, closure }] as const, disposition: { kind: 'unresolved' as const } }
    await repository.commitWorkspace({ ...initial, editorDocuments: [file], blobs: state.blobs, retainedContent: state.retainedContent, conflicts: [conflict] }, initial.planner.localData.revision)
    const selected = createGuestRepository(), before = await selected.readWorkspace(), binding = await guestRepositoryBindings(selected)
    const saved = await selected.save(createPersonalDefinition(before.planner.localData, { name: 'Ordinary planner save', kind: 'item' }), before.planner.localData.revision)
    const undone = await selected.undo(saved.localData.revision)
    const after = await selected.readWorkspace()
    expect((await binding.coordinator.active.get('active'))?.manifest).toEqual(binding.manifest)
    expect(after.editorDocuments).toEqual(before.editorDocuments)
    expect(after.conflicts).toEqual(before.conflicts)
    expect(after.retainedContent).toEqual(before.retainedContent)
    expect(after.planner.localData.personalDefinitions).toEqual(before.planner.localData.personalDefinitions)
    expect(after.planner.localData.revision).toBe(undone.localData.revision)
    expect(after.planner.history.length).toBe(before.planner.history.length + 2)
  } finally { setDatabaseForTests(undefined); await database.delete() }
})
