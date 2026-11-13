import { crystalEditSourceKey } from '../interchange/source-identity'
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { syntheticCrystalEdit } from '../interchange/crystal-edit.test-helpers'
import { requirePlaythrough } from '../domain'
import { CryKitDatabase, setDatabaseForTests } from './database'
import { commitImport, exportBackup, loadLocalData, previewImport, undoLocalDataWithStatus } from './local-data'

const syntheticCatalogId = `crystal-project/imported/${await crystalEditSourceKey('synthetic-project')}`
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
  expect(added.catalogs.some(catalog => catalog.id === syntheticCatalogId)).toBe(true)
  const repeatedPreview = await previewImport(encode(syntheticCrystalEdit()), 'renamed.json')
  const repeated = await commitImport(repeatedPreview, { mode: 'add-reference', targetLocalDataId: added.localData.id, expectedRevision: added.revision })
  expect(repeated.revision).toBe(added.revision)
  const backup = await previewImport(await exportBackup(), 'synthetic-backup.zip')
  expect(backup.proposed.sources.some(source => source.format === 'crystal-edit-json-1')).toBe(true)
  const restored = await commitImport(backup)
  expect(requirePlaythrough(restored.localData).characters).toEqual(requirePlaythrough(before.localData).characters)
  expect(restored.catalogs.find(catalog => catalog.id === syntheticCatalogId)?.entities).toEqual(preview.proposed.catalogs[0]?.entities)
})

it('can undo a reference addition without replacing Playthrough records', async () => {
  const first = await loadLocalData()
  const data = encode(syntheticCrystalEdit())
  const added = await commitImport(await previewImport(data, 'first.json'), { mode: 'add-reference', targetLocalDataId: first.localData.id, expectedRevision: first.revision })
  expect(added.catalogs.some(catalog => catalog.id === syntheticCatalogId)).toBe(true)
  await undoLocalDataWithStatus(added.revision)
  const undone = await loadLocalData()
  expect(undone.localData.importReceipts).toEqual({})
  expect(undone.localData.referenceLibrary).toEqual(first.localData.referenceLibrary)
  expect(undone.catalogs.filter(catalog => catalog.id === syntheticCatalogId)).toEqual(added.catalogs.filter(catalog => catalog.id === syntheticCatalogId))
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

it('deduplicates equivalent definitions while retaining both exact original artifacts in backups', async () => {
  await loadLocalData()
  const firstBytes = encode(syntheticCrystalEdit())
  const secondBytes = new TextEncoder().encode(JSON.stringify(syntheticCrystalEdit(), null, 2))
  const first = await previewImport(firstBytes, 'first.json')
  const second = await previewImport(secondBytes, 'second.json')
  await commitImport(first, { mode: 'add-reference' })
  const added = await commitImport(second, { mode: 'add-reference' })
  expect(added.catalogs.filter(catalog => catalog.id === syntheticCatalogId)).toEqual(first.proposed.catalogs)
  const backup = await previewImport(await exportBackup(), 'originals.zip')
  const originals = backup.proposed.sources.filter(source => source.format === 'crystal-edit-json-1')
  expect(new Set(originals.map(source => source.digest))).toEqual(new Set([first.sourceDigest, second.sourceDigest]))
  expect(originals.find(source => source.filename === 'first.json')?.bytes).toEqual(firstBytes)
  expect(originals.find(source => source.filename === 'second.json')?.bytes).toEqual(secondBytes)
  await commitImport(backup)
  expect((await loadLocalData()).catalogs.filter(catalog => catalog.id === syntheticCatalogId)).toEqual(first.proposed.catalogs)
})
