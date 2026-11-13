import './guest-managed-monitor.test-helpers'
import { expect, it, vi } from 'vitest'
import { CryKitDatabase } from '../persistence/database'
import { GUEST_COORDINATOR_DATABASE, GUEST_PLANNER_DATABASE } from '../persistence/storage-names'
import { GuestCoordinatorDatabase } from './guest-coordinator'
import { prepareGuestStartup, startLaunchGuestWorkspace } from './guest-managed-startup'

it('requires an explicit fresh start, preserves prelaunch bytes, and retries interrupted initialization', async () => {
  const old = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('crykit', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('sentinel')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
  const bytes = new Uint8Array([10, 20, 30])
  await new Promise<void>((resolve, reject) => {
    const transaction = old.transaction('sentinel', 'readwrite')
    transaction.objectStore('sentinel').put(bytes, 'private-original')
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  old.close()
  const original = new CryKitDatabase(), coordinator = new GuestCoordinatorDatabase()
  const opening = vi.spyOn(indexedDB, 'open')
  try {
    expect(original.name).toBe(GUEST_PLANNER_DATABASE)
    expect(coordinator.name).toBe(GUEST_COORDINATOR_DATABASE)
    await expect(prepareGuestStartup(original)).rejects.toMatchObject({ code: 'PRELAUNCH_GUEST_DATA' })
    expect(opening.mock.calls.some(([name]) => name === 'crykit')).toBe(false)
    await coordinator.open()
    const failure = () => { throw new Error('Synthetic interrupted fresh start') }
    coordinator.active.hook('creating', failure)
    await expect(startLaunchGuestWorkspace(coordinator)).rejects.toThrow('Synthetic interrupted fresh start')
    expect(await coordinator.active.get('active')).toBeUndefined()
    coordinator.active.hook('creating').unsubscribe(failure)
    await expect(prepareGuestStartup(original)).rejects.toMatchObject({ code: 'PRELAUNCH_GUEST_DATA' })
    const accepted = await startLaunchGuestWorkspace(coordinator)
    expect((await prepareGuestStartup(original)).manifest).toEqual(accepted)
    expect(opening.mock.calls.some(([name]) => name === 'crykit')).toBe(false)
    opening.mockRestore()
    const reopened = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('crykit'); request.onsuccess = () => resolve(request.result) })
    expect(reopened.version).toBe(1)
    const retained = await new Promise<unknown>(resolve => { const request = reopened.transaction('sentinel').objectStore('sentinel').get('private-original'); request.onsuccess = () => resolve(request.result) })
    expect(retained).toEqual(bytes)
    reopened.close()
  } finally { opening.mockRestore(); original.close(); coordinator.close() }
})
