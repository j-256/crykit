import './guest-managed-monitor.test-helpers'
import Dexie from 'dexie'
import { expect, it, vi } from 'vitest'
import { GuestManagedManifestSchema } from './guest-managed-contract'
import { CryKitDatabase } from '../persistence/database'
import { createGuestRepository, guestRepositorySelection } from './guest-repository'
import { GuestCoordinatorDatabase } from './guest-coordinator'
import { prepareFreshGuestWorkspace } from './guest-managed-startup'
import { openGuestManagedRepository } from './guest-managed-repository'
import { createStarterLocalData } from '../persistence/local-data'
import { invalidateProfile } from '../account/profile'
import * as startup from './guest-managed-startup'

it('does not open or migrate local data before use and rejects a retired unused facade', async () => {
  const original = new CryKitDatabase(`synthetic-lazy-guest-${crypto.randomUUID()}`)
  const prepare = vi.spyOn(startup, 'prepareGuestStartup')
  try {
    const repository = createGuestRepository(original)
    await Promise.resolve()
    expect(prepare).not.toHaveBeenCalled()
    expect(await Dexie.exists(original.name)).toBe(false)
    invalidateProfile()
    await expect(repository.load()).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
    expect(prepare).not.toHaveBeenCalled()
  } finally { prepare.mockRestore(); invalidateProfile(); original.close() }
})

it('prepares a fresh managed guest without allocating legacy participant databases', async () => {
  const name = `synthetic-managed-startup-${crypto.randomUUID()}`
  const coordinator = new GuestCoordinatorDatabase(`${name}-coordinator`)
  try {
    const before = new Set(await Dexie.getDatabaseNames())
    const repository = createGuestRepository(new CryKitDatabase(name))
    const initial = await repository.load()
    const manifest = GuestManagedManifestSchema.parse((await coordinator.active.get('active'))!.manifest)
    expect(manifest.version).toBe(3)
    expect((await coordinator.active.get('active'))!.manifest).toEqual(manifest)
    const expected = createStarterLocalData()
    expect(initial.localData.revision).toBe(0)
    expect(Object.values(initial.localData.builds).map(value => value.title)).toEqual(Object.values(expected.builds).map(value => value.title))
    const names = (await Dexie.getDatabaseNames()).filter(value => !before.has(value))
    expect(names).toEqual([coordinator.name])
    const capturedSelection = await guestRepositorySelection(repository)
    const saved = await repository.save(initial.localData, initial.revision)
    expect(saved.localData.revision).toBe(1)
    expect(await capturedSelection.readSelected()).not.toEqual(capturedSelection.manifest)
    expect((await guestRepositorySelection(repository)).manifest).toEqual(await capturedSelection.readSelected())
    expect(await coordinator.table('managedMigrations').count()).toBe(0)
    const reopened = await openGuestManagedRepository(coordinator, GuestManagedManifestSchema.parse((await coordinator.active.get('active'))!.manifest))
    expect((await reopened.load()).localData).toEqual(saved.localData)
    await expect(prepareFreshGuestWorkspace(coordinator)).rejects.toThrow(/selected/)
    invalidateProfile()
    await expect(capturedSelection.readSelected()).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  } finally { invalidateProfile(); coordinator.close() }
}, 30_000)

it('rejects an unknown selected layout without creating a planner or changing its pointer', async () => {
  const name = `synthetic-managed-unsupported-${crypto.randomUUID()}`
  const coordinator = new GuestCoordinatorDatabase(`${name}-coordinator`)
  const manifest = { version: 99, id: 'unknown', privateUnknown: { retain: true } }
  await coordinator.table('active').add({ key: 'active', manifest })
  try {
    await expect(createGuestRepository(new CryKitDatabase(name)).load()).rejects.toThrow()
    expect((await coordinator.active.get('active'))!.manifest).toEqual(manifest)
    expect(await Dexie.exists(name)).toBe(false)
    expect(await coordinator.table('managedRecords').count()).toBe(0)
  } finally { invalidateProfile(); coordinator.close() }
})

it('rejects a concurrent old-head read without retiring the monitor needed by the next save', async () => {
  const name = `synthetic-managed-read-race-${crypto.randomUUID()}`
  const coordinator = new GuestCoordinatorDatabase(`${name}-coordinator`)
  try {
    const target = await prepareFreshGuestWorkspace(coordinator)
    const repository = await openGuestManagedRepository(coordinator, target)
    const before = await repository.load()
    const transaction = coordinator.transaction.bind(coordinator)
    let concurrentReadRejected = false
    const publication = vi.spyOn(coordinator, 'transaction').mockImplementation((async (...args: Parameters<typeof transaction>) => {
      const result = await transaction(...args)
      if (args[0] === 'rw' && !concurrentReadRejected) {
        // Another reader can run after the native commit and before the stable wrapper adopts its receipt
        await expect(repository.readWorkspace()).rejects.toThrow(/changed/)
        concurrentReadRejected = true
      }
      return result
    }) as typeof coordinator.transaction)
    const first = await repository.save(before.localData, before.revision)
    publication.mockRestore()
    expect(concurrentReadRejected).toBe(true)
    const second = await repository.save(first.localData, first.localData.revision)
    expect((await repository.load()).localData).toEqual(second.localData)
    expect(second.localData.revision).toBe(before.revision + 2)
  } finally { vi.restoreAllMocks(); invalidateProfile(); coordinator.close() }
}, 30_000)
