import './guest-managed-monitor.test-helpers'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { invalidateProfile } from '../account/profile'
import { CryKitDatabase, setDatabaseForTests } from '../persistence/database'
import { GuestCoordinatorDatabase } from './guest-coordinator'
import { openGuestManagedRepository } from './guest-managed-repository'
import { prepareFreshGuestWorkspace } from './guest-managed-startup'
import { captureExistingGuestWorkspaceForSignin } from './guest-repository'
import { assertOwnedWorkspaceSnapshot, backupMetadataDigest, disposeWorkspaceSnapshot, snapshotMetadata, type WorkspaceSnapshot } from './snapshot'

const databases: Dexie[] = []
function fixture() {
  const original = new CryKitDatabase(`synthetic-signin-probe-${crypto.randomUUID()}`)
  const coordinator = new GuestCoordinatorDatabase(`${original.name}-coordinator`)
  databases.push(original, coordinator)
  setDatabaseForTests(original)
  return { original, coordinator }
}
afterEach(async () => {
  setDatabaseForTests(undefined)
  invalidateProfile()
  for (const database of databases.splice(0)) await database.delete()
})

// This catches calling ordinary startup, which creates a guest database and sample data as a side effect
it('leaves the IndexedDB name inventory untouched when no local workspace exists', async () => {
  fixture()
  const before = await indexedDB.databases()
  expect(await captureExistingGuestWorkspaceForSignin()).toBeUndefined()
  expect(await indexedDB.databases()).toEqual(before)
})

it('rejects a coordinator disappearing after inventory without recreating it', async () => {
  const { coordinator } = fixture()
  await prepareFreshGuestWorkspace(coordinator)
  const names = await indexedDB.databases()
  await coordinator.delete()
  const inventory = vi.spyOn(indexedDB, 'databases').mockResolvedValue(names)
  try { await expect(captureExistingGuestWorkspaceForSignin()).rejects.toThrow() }
  finally { inventory.mockRestore() }
  expect((await indexedDB.databases()).some(database => database.name === coordinator.name)).toBe(false)
})

it('captures the exact managed selection with a stable source vector across probes', async () => {
  const { coordinator } = fixture(), manifest = await prepareFreshGuestWorkspace(coordinator)
  const original = await (await openGuestManagedRepository(coordinator, manifest)).readWorkspace()
  const first = (await captureExistingGuestWorkspaceForSignin())!, second = (await captureExistingGuestWorkspaceForSignin())!
  try {
    expect(first.snapshot.state.planner.localData).toEqual(original.planner.localData)
    expect(first.snapshot.state.planner.localData).toEqual(second.snapshot.state.planner.localData)
    const sourceIdentity = (snapshot: WorkspaceSnapshot) => {
      const { snapshotId: _captureId, capturedAt: _captureTime, ...source } = snapshotMetadata(snapshot)
      return backupMetadataDigest(source)
    }
    expect(await sourceIdentity(first.snapshot)).toBe(await sourceIdentity(second.snapshot))
    expect(first.snapshot.revisionVector).toEqual({ guest: manifest.id, managedRoot: JSON.stringify(manifest.root), managedRevision: '0' })
    expect(second.snapshot.revisionVector).toEqual(first.snapshot.revisionVector)
    expect((await coordinator.active.get('active'))?.manifest).toEqual(manifest)
    await expect(assertOwnedWorkspaceSnapshot(first.snapshot)).resolves.toBeUndefined()
  } finally { await disposeWorkspaceSnapshot(first.snapshot); await disposeWorkspaceSnapshot(second.snapshot) }
})

it('keeps prelaunch storage untouched and rejects through the recovery-safe route', async () => {
  const { original } = fixture(), raw = new Dexie(original.name)
  raw.version(1).stores({ localDatas: '&id' })
  const record = { id: 'synthetic', unsupported: 'retained' }
  await raw.table('localDatas').put(record)
  databases.push(raw)
  await expect(captureExistingGuestWorkspaceForSignin()).rejects.toMatchObject({ code: 'PRELAUNCH_GUEST_DATA' })
  expect(await raw.table('localDatas').get('synthetic')).toEqual(record)
})

it('rejects a prelaunch coordinator without upgrading its schema or rewriting its manifest', async () => {
  const { coordinator } = fixture(), raw = new Dexie(coordinator.name)
  raw.version(1).stores({ active: 'key' })
  const manifest = { version: 1, id: 'retained-prelaunch', revision: 0 }
  await raw.table('active').put({ key: 'active', manifest })
  const nativeVersion = raw.backendDB().version
  raw.close()
  try {
    await expect(captureExistingGuestWorkspaceForSignin()).rejects.toThrow()
    await raw.open()
    expect(raw.backendDB().version).toBe(nativeVersion)
    expect(await raw.table('active').get('active')).toEqual({ key: 'active', manifest })
    expect(Array.from(raw.backendDB().objectStoreNames)).toEqual(['active'])
  } finally { raw.close() }
})

it('rejects an unsupported active manifest without replacing it', async () => {
  const { coordinator } = fixture(), manifest = { version: 99, id: 'unsupported' }
  await coordinator.table('active').put({ key: 'active', manifest })
  await expect(captureExistingGuestWorkspaceForSignin()).rejects.toThrow()
  expect((await coordinator.active.get('active'))?.manifest).toEqual(manifest)
})

it('rejects an existing coordinator with a missing active selection rather than initializing it', async () => {
  const { coordinator } = fixture()
  await coordinator.open()
  await expect(captureExistingGuestWorkspaceForSignin()).rejects.toThrow()
  expect(await coordinator.active.count()).toBe(0)
})

it('rejects corrupt managed bodies without changing the selected manifest', async () => {
  const { coordinator } = fixture(), manifest = await prepareFreshGuestWorkspace(coordinator)
  await coordinator.table('managedRecords').delete(manifest.root.revisionId)
  await expect(captureExistingGuestWorkspaceForSignin()).rejects.toThrow()
  expect((await coordinator.active.get('active'))?.manifest).toEqual(manifest)
})

it('rejects a stale captured source after a profile transition', async () => {
  const { coordinator } = fixture()
  await prepareFreshGuestWorkspace(coordinator)
  const source = (await captureExistingGuestWorkspaceForSignin())!
  invalidateProfile()
  try { await expect(assertOwnedWorkspaceSnapshot(source.snapshot)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' }) }
  finally { await disposeWorkspaceSnapshot(source.snapshot) }
})
