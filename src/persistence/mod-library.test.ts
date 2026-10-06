import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CryKitDatabase, setDatabaseForTests } from './database'
import { commitImport, exportBackup, loadLocalData, previewImport, saveLocalData, undoLocalDataWithStatus } from './local-data'
import { setModInReference } from '../domain/reference-library'
import { readModSource } from './mod-library'
import { modLibrary } from '../domain/mod-library'
import { MOD_LIBRARY_IMPORT_REVISION } from '../interchange/crystal-edit'
import type { CatalogRevisionId, ImportReceiptId } from '../domain/types'
import { jsonRecord } from '../domain/crystal-edit'

let database: CryKitDatabase
const original = '\ufeff{\r\n"ID":"synthetic-library","Title":"Synthetic mod","EditorVersion":34,"Passives":[{"ID":91000,"Name":"Synthetic passive","PP":1}]\r\n}'
beforeEach(() => { database = new CryKitDatabase(`mods-library-${crypto.randomUUID()}`); setDatabaseForTests(database) })
afterEach(async () => { setDatabaseForTests(undefined); await database.delete() })

it.each([4, 34])('keeps format %s source bytes and both revisions through a backup round trip', async editorVersion => {
  const versioned = original.replace('"EditorVersion":34', `"EditorVersion":${editorVersion}`)
  const before = await loadLocalData()
  const save = async (text: string) => commitImport(await previewImport(new TextEncoder().encode(text), 'synthetic.json'), { mode: 'add-reference' })
  const first = await save(versioned)
  const firstPin = modLibrary(first.catalogs).find(mod => mod.id === 'crystal-edit:synthetic-library')!.revisions[0]!
  expect(await readModSource(firstPin)).toEqual({ filename: 'synthetic.json', text: versioned })
  const changed = versioned.replace('"PP":1', '"PP":2')
  const second = await save(changed)
  expect(second.localData.playthroughs).toEqual(before.localData.playthroughs)
  expect(second.localData.gameSetups).toEqual(before.localData.gameSetups)
  expect(second.localData.buildRevisions).toEqual(before.localData.buildRevisions)
  const repeated = await save(changed)
  expect(repeated.revision).toBe(second.revision)
  const backup = await previewImport(await exportBackup(), 'synthetic-backup.zip')
  const restored = await commitImport(backup)
  const mods = modLibrary(restored.catalogs)
  expect(mods.map(mod => mod.id).sort()).toEqual([...modLibrary(before.catalogs).map(mod => mod.id), firstPin.catalogId].sort())
  expect(mods.find(mod => mod.id === firstPin.catalogId)!.revisions).toHaveLength(2)
  expect((await readModSource(firstPin)).text).toBe(versioned)
  expect(new Set(await Promise.all(mods.find(mod => mod.id === firstPin.catalogId)!.revisions.map(async revision => (await readModSource(revision)).text)))).toEqual(new Set([versioned, changed]))
})

it('rejects missing or damaged source bytes instead of manufacturing an editable file', async () => {
  await loadLocalData()
  const preview = await previewImport(new TextEncoder().encode(original), 'synthetic.json')
  const added = await commitImport(preview, { mode: 'add-reference' })
  const pin = modLibrary(added.catalogs).find(mod => mod.id === preview.proposed.catalogs[0]!.id)!.revisions[0]!
  const source = (await database.sources.get(preview.proposed.sources[0]!.id))!
  await database.sources.put({ ...source, bytes: new TextEncoder().encode('{}') })
  await expect(readModSource(pin)).rejects.toThrow('missing or damaged')
  await database.sources.delete(source.id)
  await expect(readModSource(pin)).rejects.toThrow('missing or damaged')
})

it('persists reversible membership in backups, retains original sources, and rolls back failed removals', async () => {
  await loadLocalData()
  const imported = await commitImport(await previewImport(new TextEncoder().encode(original), 'synthetic.json'), { mode: 'add-reference' })
  const pin = modLibrary(imported.catalogs).find(mod => mod.id === 'crystal-edit:synthetic-library')!.revisions[0]!
  const excluded = setModInReference(imported.localData, pin.catalogId, false)
  vi.spyOn(database.history, 'add').mockRejectedValueOnce(new DOMException('Synthetic membership failure', 'QuotaExceededError'))
  await expect(saveLocalData(excluded, imported.revision)).rejects.toMatchObject({ code: 'storage-failure' })
  expect((await loadLocalData()).localData).toEqual(imported.localData)
  const saved = await saveLocalData(excluded, imported.revision)
  const restored = await commitImport(await previewImport(await exportBackup(), 'synthetic-membership.zip'))
  expect(restored.localData.referenceLibrary).toEqual(saved.referenceLibrary)
  expect(restored.localData.gameSetups).toEqual(imported.localData.gameSetups)
  expect(restored.localData.buildRevisions).toEqual(imported.localData.buildRevisions)
  expect(await readModSource(pin)).toEqual({ filename: 'synthetic.json', text: original })
  const included = await saveLocalData(setModInReference(restored.localData, pin.catalogId, true), restored.revision)
  await undoLocalDataWithStatus(included.revision)
  expect((await loadLocalData()).localData.referenceLibrary).toEqual(saved.referenceLibrary)
})

it('imports and re-includes a removed source atomically without duplicating an unchanged import', async () => {
  const before = await loadLocalData()
  const initialSources = await database.sources.count()
  const preview = await previewImport(new TextEncoder().encode(original), 'synthetic.json')
  const catalog = preview.proposed.catalogs[0]!
  const excluded = await saveLocalData(setModInReference(before.localData, catalog.id, false), before.revision)
  const options = { mode: 'add-reference' as const, includeModInReference: catalog.id }
  vi.spyOn(database.history, 'add').mockRejectedValueOnce(new DOMException('Synthetic import membership failure', 'QuotaExceededError'))
  await expect(commitImport(preview, options)).rejects.toMatchObject({ code: 'storage-failure' })
  expect((await loadLocalData()).localData).toEqual(excluded)
  expect(await database.sources.count()).toBe(initialSources)
  const imported = await commitImport(preview, options)
  expect(imported.localData.referenceLibrary).toEqual(before.localData.referenceLibrary)
  const removed = await saveLocalData(setModInReference(imported.localData, catalog.id, false), imported.revision)
  const receipts = removed.importReceipts
  const included = await commitImport(preview, { ...options, expectedRevision: removed.revision })
  expect(included.localData.referenceLibrary).toEqual(before.localData.referenceLibrary)
  expect(included.localData.importReceipts).toEqual(receipts)
  expect(await database.sources.count()).toBe(initialSources + 1)
  const repeated = await commitImport(preview, options)
  expect(repeated.revision).toBe(included.revision)
  const excludedAgain = await saveLocalData(setModInReference(repeated.localData, catalog.id, false), repeated.revision)
  const updated = await commitImport(await previewImport(new TextEncoder().encode(original.replace('"PP":1', '"PP":2')), 'synthetic-update.json'), { mode: 'add-reference', expectedRevision: excludedAgain.revision })
  expect(updated.localData.referenceLibrary).toEqual(excludedAgain.referenceLibrary)
  expect(await database.sources.count()).toBe(initialSources + 2)
})

it('retains older parser revisions when enriching identical source bytes and restoring a backup', async () => {
  const before = await loadLocalData()
  const text = original.replace('"EditorVersion":34', '"EditorVersion":34,"SteamWorkshopFileID":123456')
  const preview = await previewImport(new TextEncoder().encode(text), 'synthetic.json')
  const catalog = preview.proposed.catalogs[0]!
  const suffix = `:${MOD_LIBRARY_IMPORT_REVISION}`
  const oldRevisionId = catalog.revisionId.replace(suffix, '') as CatalogRevisionId
  const legacy = jsonRecord(catalog.legacy) ? { ...catalog.legacy } : {}
  delete legacy.steamWorkshopFileId
  const receipt = Object.values(preview.proposed.localData.importReceipts)[0]!
  const oldReceiptId = receipt.id.replace(suffix, '') as ImportReceiptId
  const older = await commitImport({ ...preview, proposed: { ...preview.proposed, catalogs: [{ ...catalog, revisionId: oldRevisionId, legacy }], localData: { ...preview.proposed.localData, importReceipts: { [oldReceiptId]: { ...receipt, id: oldReceiptId } } } } }, { mode: 'add-reference' })
  const oldPin = modLibrary(older.catalogs).find(mod => mod.id === catalog.id)!.revisions[0]!
  const updated = await commitImport(preview, { mode: 'add-reference' })
  expect(updated.localData.gameSetups).toEqual(before.localData.gameSetups)
  expect(updated.localData.buildRevisions).toEqual(before.localData.buildRevisions)
  const restored = await commitImport(await previewImport(await exportBackup(), 'synthetic-upgrade.zip'))
  const revisions = modLibrary(restored.catalogs).find(mod => mod.id === catalog.id)!.revisions
  expect(revisions.map(revision => revision.catalogRevisionId)).toEqual(expect.arrayContaining([oldRevisionId, catalog.revisionId]))
  expect(revisions.find(revision => revision.catalogRevisionId === oldRevisionId)?.steamWorkshopFileId).toBeUndefined()
  expect(revisions.find(revision => revision.catalogRevisionId === catalog.revisionId)?.steamWorkshopFileId).toBe('123456')
  expect(await readModSource(oldPin)).toEqual({ filename: 'synthetic.json', text })
})
