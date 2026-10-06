import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { syntheticCrystalEdit } from '../interchange/crystal-edit.test-helpers'
import { requirePlaythrough } from '../domain'
import { CryKitDatabase, setDatabaseForTests } from './database'
import { commitImport, exportBackup, loadLocalData, previewImport, undoLocalDataWithStatus } from './local-data'

let database: CryKitDatabase
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
beforeEach(() => { database = new CryKitDatabase(`crystal-edit-${crypto.randomUUID()}`); setDatabaseForTests(database) })
afterEach(async () => { vi.restoreAllMocks(); setDatabaseForTests(undefined); await database.delete() })

it('adds reference data without replacing personal records, repeats idempotently, and restores the source in a backup', async () => {
  const before = await loadLocalData()
  const preview = await previewImport(encode(syntheticCrystalEdit()), 'synthetic-mod.json')
  const added = await commitImport(preview, { mode: 'add-reference', targetLocalDataId: before.localData.id, expectedRevision: before.revision })
  expect(added.localData.id).toBe(before.localData.id)
  expect(requirePlaythrough(added.localData).characters).toEqual(requirePlaythrough(before.localData).characters)
  expect(requirePlaythrough(added.localData).inventory).toEqual(requirePlaythrough(before.localData).inventory)
  expect(added.localData.gameSetups).toEqual(before.localData.gameSetups)
  expect(added.catalogs.some(catalog => catalog.id === 'crystal-edit:synthetic-project')).toBe(true)
  const repeatedPreview = await previewImport(encode(syntheticCrystalEdit()), 'renamed.json')
  const repeated = await commitImport(repeatedPreview, { mode: 'add-reference', targetLocalDataId: added.localData.id, expectedRevision: added.revision })
  expect(repeated.revision).toBe(added.revision)
  const backup = await previewImport(await exportBackup(), 'synthetic-backup.zip')
  expect(backup.proposed.sources.some(source => source.format === 'crystal-edit-json-1')).toBe(true)
  const restored = await commitImport(backup)
  expect(requirePlaythrough(restored.localData).characters).toEqual(requirePlaythrough(before.localData).characters)
  expect(restored.catalogs.find(catalog => catalog.id === 'crystal-edit:synthetic-project')?.entities).toEqual(preview.proposed.catalogs[0]?.entities)
})

it('can undo a reference addition without replacing Playthrough records', async () => {
  const first = await loadLocalData()
  const data = encode(syntheticCrystalEdit())
  const added = await commitImport(await previewImport(data, 'first.json'), { mode: 'add-reference', targetLocalDataId: first.localData.id, expectedRevision: first.revision })
  expect(added.catalogs.some(catalog => catalog.id === 'crystal-edit:synthetic-project')).toBe(true)
  await undoLocalDataWithStatus(added.revision)
  const undone = await loadLocalData()
  expect(undone.localData.importReceipts).toEqual({})
  expect(undone.catalogs.some(catalog => catalog.id === 'crystal-edit:synthetic-project')).toBe(false)
})

it('rolls back every write on storage failure and rejects stale localData revisions', async () => {
  const before = await loadLocalData()
  const preview = await previewImport(encode(syntheticCrystalEdit()), 'synthetic-mod.json')
  const initialCatalogs = await database.catalogs.count()
  const initialSources = await database.sources.count()
  vi.spyOn(database.history, 'add').mockRejectedValueOnce(new DOMException('Synthetic quota failure', 'QuotaExceededError'))
  await expect(commitImport(preview, { mode: 'add-reference', targetLocalDataId: before.localData.id, expectedRevision: before.revision })).rejects.toMatchObject({ code: 'storage-failure' })
  expect((await loadLocalData()).localData).toEqual(before.localData)
  expect(await database.catalogs.count()).toBe(initialCatalogs)
  expect(await database.sources.count()).toBe(initialSources)
  await expect(commitImport(preview, { mode: 'add-reference', targetLocalDataId: before.localData.id, expectedRevision: before.revision + 1 })).rejects.toMatchObject({ code: 'revision-conflict' })
  const added = await commitImport(preview, { mode: 'add-reference', targetLocalDataId: before.localData.id, expectedRevision: before.revision })
  expect(added.revision).toBe(before.revision + 1)
})
