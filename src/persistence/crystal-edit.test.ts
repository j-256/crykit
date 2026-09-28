import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { syntheticCrystalEdit } from '../interchange/crystal-edit.test-helpers'
import { CrystalCompanionDatabase, setDatabaseForTests } from './database'
import { commitImport, createProfile, exportBackup, loadWorkspace, previewImport, undoProfileWithStatus } from './workspace'

let database: CrystalCompanionDatabase
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
beforeEach(() => { database = new CrystalCompanionDatabase(`crystal-edit-${crypto.randomUUID()}`); setDatabaseForTests(database) })
afterEach(async () => { vi.restoreAllMocks(); setDatabaseForTests(undefined); await database.delete() })

it('adds reference data without replacing personal records, repeats idempotently, and restores the source in a backup', async () => {
  const before = await loadWorkspace()
  const preview = await previewImport(encode(syntheticCrystalEdit()), 'synthetic-mod.json')
  const added = await commitImport(preview, { mode: 'add-reference', targetProfileId: before.profile.id, expectedRevision: before.revision })
  expect(added.profile.id).toBe(before.profile.id)
  expect(added.profile.characters).toEqual(before.profile.characters)
  expect(added.profile.inventory).toEqual(before.profile.inventory)
  expect(added.profile.rulesets).toEqual(before.profile.rulesets)
  expect(added.catalogs.some(catalog => catalog.id === 'crystal-edit:synthetic-project')).toBe(true)
  const repeatedPreview = await previewImport(encode(syntheticCrystalEdit()), 'renamed.json')
  const repeated = await commitImport(repeatedPreview, { mode: 'add-reference', targetProfileId: added.profile.id, expectedRevision: added.revision })
  expect(repeated.revision).toBe(added.revision)
  const backup = await previewImport(await exportBackup(added.profile.id), 'synthetic-backup.zip')
  expect(backup.proposed.sources.some(source => source.format === 'crystal-edit-json-1')).toBe(true)
  const restored = await commitImport(backup)
  expect(restored.profile.characters).toEqual(before.profile.characters)
  expect(restored.catalogs.find(catalog => catalog.id === 'crystal-edit:synthetic-project')?.entities).toEqual(preview.proposed.catalogs[0]?.entities)
})

it('can share an identical reference source across profiles and Undo its addition', async () => {
  const first = await loadWorkspace()
  const data = encode(syntheticCrystalEdit())
  await commitImport(await previewImport(data, 'first.json'), { mode: 'add-reference', targetProfileId: first.profile.id, expectedRevision: first.revision })
  const second = await createProfile('Second synthetic profile')
  const added = await commitImport(await previewImport(data, 'second.json'), { mode: 'add-reference', targetProfileId: second.profile.id, expectedRevision: second.revision })
  expect(added.catalogs.some(catalog => catalog.id === 'crystal-edit:synthetic-project')).toBe(true)
  await undoProfileWithStatus(added.profile.id, added.revision)
  const undone = await loadWorkspace(added.profile.id)
  expect(undone.profile.importReceipts).toEqual({})
  expect(undone.catalogs.some(catalog => catalog.id === 'crystal-edit:synthetic-project')).toBe(false)
})

it('rolls back every write on storage failure and rejects stale profile revisions', async () => {
  const before = await loadWorkspace()
  const preview = await previewImport(encode(syntheticCrystalEdit()), 'synthetic-mod.json')
  const initialCatalogs = await database.catalogs.count()
  vi.spyOn(database.history, 'add').mockRejectedValueOnce(new DOMException('Synthetic quota failure', 'QuotaExceededError'))
  await expect(commitImport(preview, { mode: 'add-reference', targetProfileId: before.profile.id, expectedRevision: before.revision })).rejects.toMatchObject({ code: 'storage-failure' })
  expect((await loadWorkspace(before.profile.id)).profile).toEqual(before.profile)
  expect(await database.catalogs.count()).toBe(initialCatalogs)
  expect(await database.sources.count()).toBe(0)
  await expect(commitImport(preview, { mode: 'add-reference', targetProfileId: before.profile.id, expectedRevision: before.revision + 1 })).rejects.toMatchObject({ code: 'revision-conflict' })
  const added = await commitImport(preview, { mode: 'add-reference', targetProfileId: before.profile.id, expectedRevision: before.revision })
  expect(added.revision).toBe(before.revision + 1)
})
