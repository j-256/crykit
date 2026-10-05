import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BUNDLED_CATALOG, CURRENT_CATALOG } from '../catalog/bundled'
import { BUNDLED_MOD_LIBRARY } from '../catalog/mod-library-metadata'
import { createSampleLocalData } from '../domain/sample-data'
import { modSearchCatalog } from '../domain/mod-search'
import { configureModSetup } from '../domain/mod-setup'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { CryKitDatabase, setDatabaseForTests } from './database'
import { commitModSetup, exportBackup, loadLocalData, previewImport, undoLocalDataWithStatus } from './local-data'

let database: CryKitDatabase
beforeEach(() => { database = new CryKitDatabase(`mod-setup-${crypto.randomUUID()}`); setDatabaseForTests(database) })
afterEach(async () => { vi.restoreAllMocks(); setDatabaseForTests(undefined); await database.delete() })
const source = (id = 'synthetic-mod-setup') => new TextEncoder().encode(JSON.stringify({ ID: id, Name: 'Synthetic selectable mod', EditorVersion: 34, Version: '1', Equipment: [{ ID: 9000, Name: 'Synthetic test sword', Type: 0, Hands: 1, StatMods: [] }], Passives: [{ ID: 8000, Name: 'Synthetic innate', IsInnate: true, PP: 2 }], UnknownRoot: { retained: true } }))

it('starts fresh profiles with vanilla and skips once without loading mod sources or changing setups', async () => {
  const original = await loadLocalData()
  expect(original.catalogs).toEqual([CURRENT_CATALOG])
  expect(original.localData.modSetup).toEqual({ version: 1, state: 'pending' })
  const skipped = await commitModSetup([], original.revision, true)
  expect(skipped.localData.modSetup?.state).toBe('skipped')
  expect(skipped.localData.gameSetups).toEqual(original.localData.gameSetups)
  expect(await database.sources.count()).toBe(0)
  expect((await loadLocalData()).localData.modSetup?.state).toBe('skipped')
})

it('saves source bytes, Reference membership, exact enabled revisions and priority atomically while keeping earlier records', async () => {
  const original = await loadLocalData()
  const one = await previewCrystalEdit(source(), 'synthetic.json')
  const two = await previewCrystalEdit(source('second-synthetic-mod'), 'second.json')
  const configured = await commitModSetup([two, one], original.revision)
  const setup = configured.localData.gameSetups[configured.localData.planningGameSetupRevisionId!]!
  expect(setup.modComposition?.baseline).toEqual({ catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId })
  expect(setup.modComposition?.layers).toEqual([two, one].map(preview => ({ catalogId: preview.proposed.catalogs[0]!.id, catalogRevisionId: preview.proposed.catalogs[0]!.revisionId, enabled: true })))
  expect(configured.localData.modSetup?.state).toBe('completed')
  expect(configured.localData.referenceLibrary?.excludedMods).toEqual(expect.arrayContaining(BUNDLED_MOD_LIBRARY.map(mod => mod.id)))
  expect(configured.localData.referenceLibrary?.excludedMods).toContain('name:doge shield')
  expect(configured.localData.buildRevisions).toEqual(original.localData.buildRevisions)
  const archived = await database.sources.get(one.proposed.sources[0]!.id)
  expect(archived?.bytes).toEqual(source())
  expect(await database.imports.get(one.id)).toMatchObject({ sourceDigest: one.sourceDigest, localDataId: original.localData.id })
  expect(configured.localData.gameSetups).toMatchObject(original.localData.gameSetups)
  expect(Object.values(configured.localData.playthroughs)[0]!.currentGameSetupRevisionId).toBe(setup.id)
  const backup = await previewImport(await exportBackup(), 'synthetic-mod-setup.zip')
  expect(backup.proposed.localData.modSetup).toEqual(configured.localData.modSetup)
  expect(backup.proposed.sources.find(candidate => candidate.id === archived!.id)?.bytes).toEqual(source())
  expect(backup.proposed.catalogs.find(candidate => candidate.id === one.proposed.catalogs[0]!.id)?.entities[Object.keys(one.proposed.catalogs[0]!.entities)[0]!]).toEqual(Object.values(one.proposed.catalogs[0]!.entities)[0])
})

it('rolls back sources, catalogs and setup together on a save failure, then permits retry and undo', async () => {
  const original = await loadLocalData()
  const preview = await previewCrystalEdit(source(), 'synthetic.json')
  vi.spyOn(database.history, 'add').mockRejectedValueOnce(new DOMException('Synthetic quota failure', 'QuotaExceededError'))
  await expect(commitModSetup([preview], original.revision)).rejects.toMatchObject({ code: 'storage-failure' })
  expect((await loadLocalData()).localData).toEqual(original.localData)
  expect(await database.sources.count()).toBe(0)
  expect(await database.catalogs.count()).toBe(0)
  expect(await database.imports.count()).toBe(0)
  const configured = await commitModSetup([preview], original.revision)
  await expect(commitModSetup([], original.revision, true)).rejects.toMatchObject({ code: 'revision-conflict' })
  const undone = await undoLocalDataWithStatus(configured.revision)
  expect(undone.localData.modSetup).toEqual(original.localData.modSetup)
  expect(undone.localData.gameSetups).toEqual(original.localData.gameSetups)
})

it('keeps unrelated imported layers when bundled choices are changed later', async () => {
  const original = await loadLocalData()
  const preview = await previewCrystalEdit(source(), 'synthetic.json')
  const imported = await commitModSetup([preview], original.revision)
  const previous = imported.localData.gameSetups[imported.localData.planningGameSetupRevisionId!]!
  const changed = await commitModSetup([], imported.revision)
  const setup = changed.localData.gameSetups[changed.localData.planningGameSetupRevisionId!]!
  expect(setup.modComposition?.layers).toEqual(previous.modComposition?.layers)
  expect(changed.localData.gameSetups[previous.id]).toEqual(previous)
  expect(await database.sources.count()).toBe(1)
})

it('preserves old profiles and catalog pins without introducing an onboarding prompt', async () => {
  const previous = createSampleLocalData(BUNDLED_CATALOG)
  await database.localDatas.add({ id: 'local-data-record', revision: previous.revision, updatedAt: previous.updatedAt, localData: previous, lineage: { rootLocalDataId: previous.id } })
  const loaded = await loadLocalData()
  expect(loaded.localData).toEqual(previous)
  expect(loaded.localData.modSetup).toBeUndefined()
  expect(loaded.catalogs).toContain(BUNDLED_CATALOG)
  expect(loaded.catalogs).toContain(CURRENT_CATALOG)
  const backup = await previewImport(await exportBackup(), 'synthetic-legacy.zip')
  expect(backup.proposed.localData.gameSetups).toEqual(previous.gameSetups)
  expect(backup.proposed.catalogs).toContainEqual(BUNDLED_CATALOG)
})

it('rejects search previews as setup inputs and retains source conflicts rather than overwriting them', async () => {
  const loaded = await loadLocalData()
  const preview = await previewCrystalEdit(source(), 'synthetic.json')
  expect(() => configureModSetup(loaded.localData, [modSearchCatalog(preview.proposed.catalogs[0]!)], loaded.catalogs, loaded.revision)).toThrow('fully loaded')
  const saved = await commitModSetup([preview], loaded.revision)
  const damaged = { ...preview, proposed: { ...preview.proposed, sources: [{ ...preview.proposed.sources[0]!, bytes: source('different-source') }] } }
  await expect(commitModSetup([damaged], saved.revision)).rejects.toMatchObject({ code: 'import-conflict' })
  expect((await loadLocalData()).localData).toEqual(saved.localData)
})
