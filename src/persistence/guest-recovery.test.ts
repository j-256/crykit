import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { expect, it, vi } from 'vitest'
import { CryKitDatabase } from './database'
import { createGuestRepository, guestRepositoryBindings } from '../workspace/guest-repository'
import { captureGuestRecovery, checkGuestRecovery } from '../workspace/guest-recovery'
import * as coordinator from '../workspace/guest-coordinator'

// Exercise retained native recovery before public startup migrates these named stores to managed storage
vi.mock('../workspace/guest-managed-startup', async importOriginal => {
  const actual = await importOriginal<typeof import('../workspace/guest-managed-startup')>()
  const { openGuestBindings } = await import('../workspace/guest-workspace')
  return { ...actual, prepareGuestStartup: async (original: CryKitDatabase) => ({ kind: 'legacy-recovery', binding: await openGuestBindings(original) }) }
})

it.each(['notice-first', 'reader-first'] as const)('cancelled notice preserves one complete concurrent repository check: %s', async order => {
  const database = new CryKitDatabase(`recovery-consumers-${crypto.randomUUID()}`)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    const original = createGuestRepository(database), initial = await original.readWorkspace()
    await original.commitWorkspace(initial, initial.planner.localData.revision)
    const repository = createGuestRepository(database), binding = await guestRepositoryBindings(repository)
    const expected = await repository.readWorkspace()
    const toArray = binding.coordinator.journal.toArray.bind(binding.coordinator.journal)
    let started!: () => void
    const checking = new Promise<void>(resolve => { started = resolve })
    const reconciliations = vi.spyOn(coordinator, 'reconcileGuestOperation')
    vi.spyOn(binding.coordinator.journal, 'toArray').mockImplementation(() => { started(); return Dexie.Promise.resolve(gate).then(() => toArray()) })
    const caller = new AbortController()
    const reader = order === 'reader-first' ? repository.readWorkspace() : undefined
    if (reader) await checking
    const notice = checkGuestRecovery(binding, caller.signal)
    const cancelled = expect(notice).rejects.toThrow('Legacy check cancelled')
    const activeReader = reader ?? repository.readWorkspace()
    await checking
    caller.abort()
    release()
    await cancelled
    const complete = await activeReader
    expect(complete.planner.localData).toEqual(expected.planner.localData)
    expect(complete.saveDocuments).toEqual([])
    expect((await binding.coordinator.active.get('active'))!.manifest).toEqual(binding.manifest)
    expect(reconciliations).toHaveBeenCalledTimes(1)
    expect(reconciliations.mock.calls[0][2].every(participant => !participant.database.isOpen())).toBe(true)
    await checkGuestRecovery(binding)
    expect(reconciliations).toHaveBeenCalledTimes(2)
    await expect(checkGuestRecovery(binding, caller.signal)).rejects.toThrow('Legacy check cancelled')
    expect(reconciliations).toHaveBeenCalledTimes(2)
  } finally { release(); vi.restoreAllMocks(); await database.delete() }
})

it('rejects a v2 journal before opening its named planner while the captured v1 pointer remains selected', async () => {
  const database = new CryKitDatabase(`recovery-v2-row-${crypto.randomUUID()}`)
  const absentPlanner = `${database.name}-absent-v2-planner`
  const observedOpens: string[] = []
  try {
    const original = createGuestRepository(database), initial = await original.readWorkspace()
    await original.commitWorkspace(initial, initial.planner.localData.revision)
    const repository = createGuestRepository(database), binding = await guestRepositoryBindings(repository)
    const previous = (await binding.coordinator.journal.toArray())[0]
    const v2 = { ...previous, version: 2, kind: 'guest-operation', id: '000-v2-stage', localStatus: 'prepared', expected: { ...previous.expected, planner: absentPlanner } }
    const { kind: _kind, ...withoutKind } = v2
    const malformedCapture = { ...previous.capture, participants: previous.capture.participants.map(participant => participant.kind === 'planner' ? { ...participant, name: absentPlanner, tables: [42] } : participant) }
    const matchingCapture = { ...previous.capture, participants: previous.capture.participants.map(participant => participant.kind === 'planner' ? { ...participant, name: absentPlanner } : participant) }
    const unsupportedRows = [
      { name: 'v2 prepared', row: v2 },
      { name: 'v2 failed', row: { ...v2, localStatus: 'failed' } },
      { name: 'v2 ready', row: { ...v2, localStatus: 'ready' } },
      { name: 'v2 complete', row: { ...v2, localStatus: 'complete' } },
      { name: 'v1 with v2 kind', row: { ...v2, version: 1 } },
      { name: 'v1 with v2 nested manifest', row: { ...withoutKind, version: 1, expected: { ...v2.expected, version: 2 } } },
      { name: 'v1 with wrong captured planner', row: { ...withoutKind, version: 1 } },
      { name: 'v1 with malformed captured tables', row: { ...withoutKind, version: 1, capture: malformedCapture } },
      { name: 'v1 with unknown status', row: { ...withoutKind, version: 1, capture: matchingCapture, localStatus: 'unknown' } },
      { name: 'v1 with wrong target revision', row: { ...withoutKind, version: 1, capture: matchingCapture, target: { ...previous.target, revision: previous.expected.revision + 2 } } },
      { name: 'unknown journal version', row: { ...v2, version: 3 } },
    ]
    const pointer = await binding.coordinator.active.get('active')
    const sourceRows = await database.localDatas.toArray(), selectedRows = await binding.planner.localDatas.toArray()
    const open = indexedDB.open.bind(indexedDB)
    vi.spyOn(indexedDB, 'open').mockImplementation((name, version) => { observedOpens.push(name); return version === undefined ? open(name) : open(name, version) })
    for (const { name, row } of unsupportedRows) {
      observedOpens.length = 0
      await binding.coordinator.journal.put(row as unknown as coordinator.GuestActivationJournal)
      expect((await binding.coordinator.journal.toArray())[0].id).toBe(v2.id)
      const journal = await binding.coordinator.journal.get(v2.id)
      let admitted = true
      try { await repository.readWorkspace() } catch { admitted = false }
      expect(admitted, name).toBe(false)
      expect(observedOpens, name).not.toContain(absentPlanner)
      expect(await binding.coordinator.active.get('active')).toEqual(pointer)
      expect(await binding.coordinator.journal.get(v2.id)).toEqual(journal)
      expect(await database.localDatas.toArray()).toEqual(sourceRows)
      expect(await binding.planner.localDatas.toArray()).toEqual(selectedRows)
    }
    vi.restoreAllMocks()
    expect(await Dexie.exists(absentPlanner)).toBe(false)
  } finally { vi.restoreAllMocks(); await database.delete(); await Dexie.delete(absentPlanner) }
})

it('rejects an active v2 pointer before a retained v1 journal opens any participant', async () => {
  const database = new CryKitDatabase(`recovery-v2-pointer-${crypto.randomUUID()}`)
  const absentPlanner = `${database.name}-v2-planner`
  const observedOpens: string[] = []
  try {
    const original = createGuestRepository(database), initial = await original.readWorkspace()
    await original.commitWorkspace(initial, initial.planner.localData.revision)
    const repository = createGuestRepository(database), binding = await guestRepositoryBindings(repository)
    expect((await repository.readWorkspace()).planner.localData.id).toBe(initial.planner.localData.id)
    const previous = (await binding.coordinator.journal.toArray())[0]
    const v2 = { version: 2, id: 'selected-v2', revision: binding.manifest.revision + 1, planner: absentPlanner, inspector: `${database.name}-v2-inspector`, files: `${database.name}-v2-files` }
    const sourceRows = await database.localDatas.toArray(), selectedRows = await binding.planner.localDatas.toArray()
    const open = indexedDB.open.bind(indexedDB)
    vi.spyOn(indexedDB, 'open').mockImplementation((name, version) => { observedOpens.push(name); return version === undefined ? open(name) : open(name, version) })
    const notice = { id: previous.id, status: 'incomplete' as const, frozenCaptureId: previous.capture.id }
    for (const manifest of [v2, { ...v2, version: 99 }, { ...v2, files: undefined }]) {
      observedOpens.length = 0
      await binding.coordinator.active.put({ key: 'active', manifest: manifest as unknown as coordinator.GuestManifest })
      const pointer = await binding.coordinator.active.get('active'), journal = await binding.coordinator.journal.get(previous.id)
      await expect(repository.readWorkspace()).rejects.toThrow()
      expect(observedOpens).not.toContain(previous.expected.planner)
      await expect(captureGuestRecovery(binding, notice)).rejects.toThrow()
      expect(observedOpens).not.toContain(previous.expected.planner)
      expect(await database.localDatas.toArray()).toEqual(sourceRows)
      expect(await binding.planner.localDatas.toArray()).toEqual(selectedRows)
      expect(await binding.coordinator.active.get('active')).toEqual(pointer)
      expect(await binding.coordinator.journal.get(previous.id)).toEqual(journal)
    }
    vi.restoreAllMocks()
    expect(await Dexie.exists(absentPlanner)).toBe(false)
  } finally { vi.restoreAllMocks(); await database.delete(); await Dexie.delete(absentPlanner) }
})

it('does not start a coalesced scan when its caller aborts during active-pointer admission', async () => {
  const database = new CryKitDatabase(`recovery-gate-abort-${crypto.randomUUID()}`)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { entered = resolve })
  try {
    const repository = createGuestRepository(database), binding = await guestRepositoryBindings(repository)
    const get = binding.coordinator.active.get.bind(binding.coordinator.active)
    vi.spyOn(binding.coordinator.active, 'get').mockImplementation(((key: string) => { entered(); return Dexie.Promise.resolve(gate).then(() => get(key)) }) as typeof binding.coordinator.active.get)
    const scan = vi.spyOn(binding.coordinator.journal, 'toArray')
    const controller = new AbortController(), pending = checkGuestRecovery(binding, controller.signal)
    await reached
    controller.abort(); release()
    await expect(pending).rejects.toThrow('Legacy check cancelled')
    expect(scan).not.toHaveBeenCalled()
  } finally { release(); vi.restoreAllMocks(); await database.delete() }
})

it('rejects every coalesced caller when the captured v1 pointer changes before a retained row opens', async () => {
  const database = new CryKitDatabase(`recovery-coalesced-pointer-${crypto.randomUUID()}`)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { entered = resolve })
  const observedOpens: string[] = []
  try {
    const original = createGuestRepository(database), initial = await original.readWorkspace()
    await original.commitWorkspace(initial, initial.planner.localData.revision)
    const repository = createGuestRepository(database), binding = await guestRepositoryBindings(repository)
    const row = (await binding.coordinator.journal.toArray())[0]
    const toArray = binding.coordinator.journal.toArray.bind(binding.coordinator.journal)
    vi.spyOn(binding.coordinator.journal, 'toArray').mockImplementation(() => { entered(); return Dexie.Promise.resolve(gate).then(() => toArray()) })
    const open = indexedDB.open.bind(indexedDB)
    vi.spyOn(indexedDB, 'open').mockImplementation((name, version) => { observedOpens.push(name); return version === undefined ? open(name) : open(name, version) })
    const first = repository.readWorkspace(), second = checkGuestRecovery(binding)
    await reached
    const v2 = { version: 2, id: 'selected-v2', revision: binding.manifest.revision + 1, planner: `${database.name}-new-planner`, inspector: `${database.name}-new-inspector`, files: `${database.name}-new-files` }
    await binding.coordinator.active.put({ key: 'active', manifest: v2 as unknown as coordinator.GuestManifest })
    release()
    await expect(first).rejects.toThrow()
    await expect(second).rejects.toThrow()
    expect(observedOpens).not.toContain(row.expected.planner)
  } finally { release(); vi.restoreAllMocks(); await database.delete() }
})
