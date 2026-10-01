import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { coalesceDefinitionOverrides, createDefinitionOverride, updateGameSetupRevision } from '../domain/local-data'
import { syntheticModLayers } from '../domain/mod-layers.test-helpers'
import { modCatalogForPin } from '../domain/mod-layers'
import type { EntityId } from '../domain/types'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { CryKitDatabase, setDatabaseForTests } from './database'
import { commitImport, exportBackup, loadLocalData, previewImport, saveLocalData, undoLocalDataWithStatus } from './local-data'

let database: CryKitDatabase
beforeEach(() => { database = new CryKitDatabase(`mod-layers-${crypto.randomUUID()}`); setDatabaseForTests(database) })
afterEach(async () => { vi.restoreAllMocks(); setDatabaseForTests(undefined); await database.delete() })

async function importedData() {
  const mods = await syntheticModLayers()
  const initial = await loadLocalData()
  await commitImport(mods.first, { mode: 'add-reference', targetLocalDataId: initial.localData.id, expectedRevision: initial.revision })
  const afterFirst = await loadLocalData()
  await commitImport(mods.second, { mode: 'add-reference', targetLocalDataId: afterFirst.localData.id, expectedRevision: afterFirst.revision })
  return { ...mods, loaded: await loadLocalData() }
}

it('saves immutable effective catalogs, preserves earlier setup values, and round-trips all sources through backup', async () => {
  const { loaded, composition } = await importedData()
  const previousSetup = loaded.localData.planningGameSetupRevisionId!
  const planned = updateGameSetupRevision(loaded.localData, { sourceRevisionId: previousSetup, modComposition: composition })
  const saved = await saveLocalData(planned, loaded.revision)
  const loadedSaved = await loadLocalData()
  const setup = saved.gameSetups[saved.planningGameSetupRevisionId!]!
  const effective = modCatalogForPin(loadedSaved.catalogs, { catalogId: DEFAULT_CATALOG.id, catalogRevisionId: setup.catalogLock[DEFAULT_CATALOG.id]! })!
  expect(effective.entities['base:class:warrior']?.name).toBe('Second Fighter')
  const stored = (await database.catalogs.toArray()).find(value => value.snapshot.revisionId === effective.revisionId)!
  expect(stored.snapshot.entities['base:class:wizard']).toBeUndefined()
  expect(effective.entities['base:class:wizard']).toEqual(DEFAULT_CATALOG.entities['base:class:wizard'])
  expect(saved.gameSetups[previousSetup]).toEqual(loaded.localData.gameSetups[previousSetup])
  const draft = updateGameSetupRevision(saved, { sourceRevisionId: setup.id, modComposition: { ...composition, layers: [...composition.layers].reverse() } })
  await saveLocalData(draft, saved.revision)
  const latest = await loadLocalData()
  expect(latest.catalogs.find(catalog => catalog.revisionId === effective.revisionId)?.entities).toEqual(effective.entities)
  const backup = await previewImport(await exportBackup(), 'mod-backup.zip')
  expect(backup.proposed.sources.filter(source => source.format === 'crystal-edit-json-1')).toHaveLength(2)
  await commitImport(backup)
  const restored = await loadLocalData()
  expect(restored.localData.gameSetups).toEqual(latest.localData.gameSetups)
  expect(restored.catalogs.find(catalog => catalog.revisionId === effective.revisionId)?.entities).toEqual(effective.entities)
  const corrupted = restored.catalogs.map(catalog => catalog.revisionId === effective.revisionId ? { ...catalog, entities: {} } : catalog)
  expect(() => validateNativeLocalDataGraph(restored.localData, corrupted)).toThrow(/effective mod catalog/)
})

it('reuses unchanged layer catalogs for personal overrides and requires review when the composition changes', async () => {
  const { loaded, composition } = await importedData()
  await saveLocalData(updateGameSetupRevision(loaded.localData, { sourceRevisionId: loaded.localData.planningGameSetupRevisionId!, modComposition: composition }), loaded.revision)
  const layered = await loadLocalData()
  const setup = layered.localData.gameSetups[layered.localData.planningGameSetupRevisionId!]!
  const override = createDefinitionOverride(layered.localData, layered.catalogs, { sourceRef: { kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: setup.catalogLock[DEFAULT_CATALOG.id]!, entityId: 'base:class:warrior' as EntityId }, name: 'Personal fighter' })
  const pinned = coalesceDefinitionOverrides(override.localData, { sourceGameSetupRevisionId: setup.id, definitionRefs: [override.ref], activate: true })
  const saved = await saveLocalData(pinned, layered.revision)
  const renamed = updateGameSetupRevision(saved, { sourceRevisionId: saved.planningGameSetupRevisionId!, label: 'Renamed setup' })
  expect(renamed.gameSetups[renamed.planningGameSetupRevisionId!]!.catalogLock).toEqual(setup.catalogLock)
  expect(renamed.gameSetups[renamed.planningGameSetupRevisionId!]!.definitionOverrides).toEqual([override.ref])
  const savedRename = await saveLocalData(renamed, saved.revision)
  const reversed = { ...composition, layers: [...composition.layers].reverse() }
  expect(() => updateGameSetupRevision(savedRename, { sourceRevisionId: savedRename.planningGameSetupRevisionId!, modComposition: reversed })).toThrow(/Review personal overrides/)
  const reviewed = updateGameSetupRevision(savedRename, { sourceRevisionId: savedRename.planningGameSetupRevisionId!, modComposition: reversed, definitionOverrides: [] })
  await saveLocalData(reviewed, savedRename.revision)
  const backup = await previewImport(await exportBackup(), 'personal-mod-setup.zip')
  expect(backup.proposed.localData.personalDefinitions).toEqual(reviewed.personalDefinitions)
  expect(backup.proposed.localData.gameSetups[savedRename.planningGameSetupRevisionId!]!.definitionOverrides).toEqual([override.ref])
})

it('rolls back derived catalogs on save failure, retries the same revision, and undoes the setup change', async () => {
  const { loaded, composition } = await importedData()
  const draft = updateGameSetupRevision(loaded.localData, { sourceRevisionId: loaded.localData.planningGameSetupRevisionId!, modComposition: composition })
  const count = await database.catalogs.count()
  vi.spyOn(database.history, 'add').mockRejectedValueOnce(new DOMException('Synthetic full storage', 'QuotaExceededError'))
  await expect(saveLocalData(draft, loaded.revision)).rejects.toMatchObject({ code: 'storage-failure' })
  expect(await database.catalogs.count()).toBe(count)
  expect((await loadLocalData()).localData).toEqual(loaded.localData)
  const recovery = await previewImport(await exportBackup(draft), 'retained-mod-draft.zip')
  expect(recovery.proposed.localData.gameSetups).toEqual(draft.gameSetups)
  expect((await loadLocalData()).localData).toEqual(loaded.localData)
  const saved = await saveLocalData(draft, loaded.revision)
  await undoLocalDataWithStatus(saved.revision)
  expect((await loadLocalData()).localData.gameSetups).toEqual(loaded.localData.gameSetups)
})
