import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it } from 'vitest'
import { CryKitDatabase } from './database'
import { InspectorStorage } from '../mod-inspector/storage'
import { GuestFilesDatabase } from '../workspace/guest-files'

const names: string[] = []
afterEach(async () => { for (const name of names.splice(0)) await Dexie.delete(name) })
const target = (kind: 'planner' | 'inspector' | 'files', name: string) => kind === 'planner'
  ? new CryKitDatabase(name, { plannerFormatRequirement: 'journaled', freshGuestTarget: true })
  : kind === 'inspector' ? new InspectorStorage(name, { freshGuestTarget: true }) : new GuestFilesDatabase(name, { freshGuestTarget: true })
const open = async (value: ReturnType<typeof target>) => value instanceof InspectorStorage ? value.openDatabase() : value.open()
const close = (value: ReturnType<typeof target>) => value.close()
const versions = { planner: 60, inspector: 30, files: 20 } as const

it.each(['inspector', 'files'] as const)('reopens an exact existing %s target and never creates a missing one', async kind => {
  const name = `crykit-restored-v2-${crypto.randomUUID()}-${kind}`; names.push(name)
  const missing = kind === 'inspector' ? new InspectorStorage(name, { requiredGuestTarget: true }) : new GuestFilesDatabase(name, { requiredGuestTarget: true })
  try { await expect(open(missing)).rejects.toThrow() } finally { close(missing) }
  expect(await Dexie.getDatabaseNames()).not.toContain(name)
  const created = target(kind, name)
  try { await open(created) } finally { close(created) }
  const reopened = kind === 'inspector' ? new InspectorStorage(name, { requiredGuestTarget: true }) : new GuestFilesDatabase(name, { requiredGuestTarget: true })
  try { await open(reopened) } finally { close(reopened) }
})

it.each(['inspector', 'files'] as const)('rejects occupied wrong-layout and wrong-version %s targets without changing them', async kind => {
  for (const version of [1, versions[kind], versions[kind] + 10]) {
    const name = `crykit-restored-v2-${crypto.randomUUID()}-${kind}`; names.push(name)
    const existing = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, version)
      request.onupgradeneeded = () => request.result.createObjectStore('sentinel')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    existing.close()
    const required = kind === 'inspector' ? new InspectorStorage(name, { requiredGuestTarget: true }) : new GuestFilesDatabase(name, { requiredGuestTarget: true })
    try { await expect(open(required)).rejects.toThrow() } finally { close(required) }
    const checked = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try { expect(checked.version).toBe(version); expect(Array.from(checked.objectStoreNames)).toEqual(['sentinel']) } finally { checked.close() }
  }
})

it.each(['planner', 'inspector', 'files'] as const)('admits only the actual first native creation of a %s target', async kind => {
  const name = `crykit-restored-v2-${crypto.randomUUID()}-${kind}`; names.push(name)
  const fresh = target(kind, name)
  try { await open(fresh); expect((await Dexie.getDatabaseNames()).includes(name)).toBe(true) } finally { close(fresh) }
  const occupied = target(kind, name)
  try { await expect(open(occupied)).rejects.toThrow() } finally { close(occupied) }
})

it.each(['planner', 'inspector', 'files'] as const)('leaves occupied older, same and future %s targets untouched', async kind => {
  for (const version of [1, versions[kind], versions[kind] + 10]) {
    const name = `crykit-restored-v2-${crypto.randomUUID()}-${kind}`; names.push(name)
    const original = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, version)
      request.onupgradeneeded = () => request.result.createObjectStore('sentinel')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const marker = crypto.randomUUID()
    await new Promise<void>((resolve, reject) => {
      const transaction = original.transaction('sentinel', 'readwrite')
      transaction.objectStore('sentinel').put(marker, 'proof')
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    original.close()
    const fresh = target(kind, name)
    try { await expect(open(fresh)).rejects.toThrow() } finally { close(fresh) }
    const checked = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      expect(checked.version).toBe(version)
      expect(Array.from(checked.objectStoreNames)).toEqual(['sentinel'])
      expect(await new Promise((resolve, reject) => {
        const request = checked.transaction('sentinel').objectStore('sentinel').get('proof')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })).toBe(marker)
    } finally { checked.close() }
  }
})

it.each(['planner', 'inspector', 'files'] as const)('rejects a blocked %s opener and aborts its late upgrade', async kind => {
  const name = `crykit-restored-v2-${crypto.randomUUID()}-${kind}`; names.push(name)
  const original = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('sentinel')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const fresh = target(kind, name)
  try { await expect(open(fresh)).rejects.toThrow() } finally { close(fresh); original.close() }
  const checked = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try { expect(checked.version).toBe(1); expect(Array.from(checked.objectStoreNames)).toEqual(['sentinel']) } finally { checked.close() }
})

it.each(['planner', 'inspector', 'files'] as const)('keeps a retired %s first request from creating a late target', async kind => {
  const name = `crykit-restored-v2-${crypto.randomUUID()}-${kind}`; names.push(name)
  const original = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('sentinel')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const fresh = target(kind, name)
  const opening = open(fresh)
  close(fresh)
  original.close()
  await expect(opening).rejects.toThrow()
  const checked = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try { expect(checked.version).toBe(1); expect(Array.from(checked.objectStoreNames)).toEqual(['sentinel']) } finally { checked.close() }
})
