import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { createPersonalDefinition } from '../domain'
import { createTestLocalData } from '../domain/test-helpers'
import { invalidateProfile } from '../account/profile'
import { createGuestRepository, guestRepositoryBindings } from '../workspace/guest-repository'
import { CryKitDatabase } from './database'
import * as local from './local-data'

// Exercise retained native recovery before public startup migrates these named stores to managed storage
vi.mock('../workspace/guest-managed-startup', async importOriginal => {
  const actual = await importOriginal<typeof import('../workspace/guest-managed-startup')>()
  const { openGuestBindings } = await import('../workspace/guest-workspace')
  return { ...actual, prepareGuestStartup: async (original: CryKitDatabase) => ({ kind: 'legacy-recovery', binding: await openGuestBindings(original) }) }
})

const databases: CryKitDatabase[] = []
afterEach(() => { invalidateProfile(); vi.restoreAllMocks(); for (const database of databases.splice(0)) database.close() })
async function retired() {
  const database = new CryKitDatabase(`recovery-export-${crypto.randomUUID()}`)
  databases.push(database)
  const data = { ...createTestLocalData(), revision: 0, changes: [] }
  await database.localDatas.add({ id: 'local-data-record', revision: 0, updatedAt: data.updatedAt, localData: data, lineage: { rootLocalDataId: data.id } })
  const repository = createGuestRepository(database), state = await repository.readWorkspace()
  const binding = await guestRepositoryBindings(repository)
  await repository.commitWorkspace(state, state.planner.localData.revision)
  const draft = createPersonalDefinition(state.planner.localData, { name: 'Kept unsaved recovery definition', kind: 'item' })
  return { database, repository, binding, draft }
}
it('exports the exact captured retired planner draft without changing its source or selected successor', async () => {
  const { database, repository, binding, draft } = await retired()
  const before = await Promise.all(database.tables.map(table => table.toArray()))
  const pointer = await binding.coordinator.active.get('active')
  const bytes = await repository.exportPlannerBackup(draft)
  const preview = await repository.previewImport(bytes, 'inert-native-draft.zip')
  expect(Object.values(preview.proposed.localData.personalDefinitions).map(value => value.name)).toContain('Kept unsaved recovery definition')
  expect(await Promise.all(database.tables.map(table => table.toArray()))).toEqual(before)
  expect(await binding.coordinator.active.get('active')).toEqual(pointer)
  await expect(repository.exportPlannerBackup()).rejects.toThrow('retired')
  await expect(repository.save(draft, draft.revision)).rejects.toThrow('retired')
  await expect(repository.exportPlannerBackup({ ...draft, id: 'other' as typeof draft.id })).rejects.toThrow('different planner')
})
it('rejects a retired draft export after its captured profile lifetime ends before the read', async () => {
  const { repository, draft } = await retired()
  const exporter = vi.spyOn(local, 'exportBackup')
  invalidateProfile()
  await expect(repository.exportPlannerBackup(draft)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  expect(exporter).not.toHaveBeenCalled()
})
it('clears completed inert ZIP bytes when the profile changes during an export', async () => {
  const { repository, draft } = await retired()
  const original = local.exportBackup
  let bytes!: Uint8Array
  vi.spyOn(local, 'exportBackup').mockImplementation(async (...args) => {
    bytes = await original(...args)
    expect(bytes.some(value => value !== 0)).toBe(true)
    invalidateProfile()
    return bytes
  })
  await expect(repository.exportPlannerBackup(draft)).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  expect(bytes.every(value => value === 0)).toBe(true)
})
