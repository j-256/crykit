import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { buildBehavior, saveBuildBehavior } from '../domain/build-behavior'
import { buildContentForModSetup, selectBuildModRevision } from '../domain/build-mods'
import { createBuildPlan } from '../domain/build-planning'
import { defaultCalculation } from '../domain/calculation-plan'
import { NATIVE_DATA } from '../domain/calculation-rules'
import { createId } from '../domain/core'
import { resolveGameRules } from '../domain/game-rules'
import { updateGameSetupRevision } from '../domain/local-data'
import type { BuildRevisionId, CatalogRef } from '../domain/types'
import { createSharePayload, decodeSharePayload, encodeSharePayload, validateSharePayload } from '../interchange/share'
import { CryKitDatabase, setDatabaseForTests } from './database'
import { commitImport, exportBackup, loadLocalData, previewImport, saveLocalData } from './local-data'

let database: CryKitDatabase
beforeEach(() => { database = new CryKitDatabase(`mod-identities-${crypto.randomUUID()}`); setDatabaseForTests(database) })
afterEach(async () => { vi.restoreAllMocks(); setDatabaseForTests(undefined); await database.delete() })

it('preserves colliding added selections and reserved identity maps in shares, backups, and rollback', async () => {
  await loadLocalData()
  for (const id of ['synthetic-first-gender', 'synthetic-second-gender']) {
    const root = { ID: id, Title: id, EditorVersion: 34, Genders: [{ ...NATIVE_DATA.records.gender[0], ID: 8, Name: `${id} selection` }] }
    await commitImport(await previewImport(new TextEncoder().encode(JSON.stringify(root)), 'synthetic.json'), { mode: 'add-reference' })
  }
  const loaded = await loadLocalData()
  const first = loaded.catalogs.find(catalog => catalog.id === 'crystal-edit:synthetic-first-gender')!
  const second = loaded.catalogs.find(catalog => catalog.id === 'crystal-edit:synthetic-second-gender')!
  const initial = loaded.localData.gameSetups[loaded.localData.planningGameSetupRevisionId!]!
  const behavior = selectBuildModRevision(selectBuildModRevision(buildBehavior(initial), first, loaded.catalogs), second, loaded.catalogs)
  const configured = saveBuildBehavior(loaded.localData, behavior)
  const genderId = behavior.modComposition!.identityMappings!.find(mapping => mapping.projectId === second.id && mapping.family === 'Genders')!.effectiveId
  expect(genderId).not.toBe(8)
  const warrior: CatalogRef = { kind: 'catalog', catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId, entityId: 'base:job:0' as CatalogRef['entityId'] }
  const content = buildContentForModSetup({ primaryClass: warrior, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: { ...defaultCalculation(warrior), genderSelection: { version: 1 as const, id: genderId } } }, configured.setup, loaded.catalogs)
  const revisionId = createId<BuildRevisionId>('buildRevision')
  const planned = createBuildPlan({ ...configured.localData, planningGameSetupRevisionId: configured.setup.id }, { title: 'Synthetic project gender', revisionId, content, catalogLock: configured.setup.catalogLock })
  await saveLocalData(planned, loaded.revision)
  const saved = await loadLocalData()
  const changed = updateGameSetupRevision(saved.localData, { sourceRevisionId: configured.setup.id, modComposition: { ...behavior.modComposition!, layers: behavior.modComposition!.layers.filter(layer => layer.catalogId !== first.id) } })
  vi.spyOn(database.history, 'add').mockRejectedValueOnce(new DOMException('Synthetic quota failure', 'QuotaExceededError'))
  await expect(saveLocalData(changed, saved.revision)).rejects.toMatchObject({ code: 'storage-failure' })
  expect((await loadLocalData()).localData).toEqual(saved.localData)
  await saveLocalData(changed, saved.revision)
  const latest = await loadLocalData()
  const latestSetup = latest.localData.gameSetups[latest.localData.planningGameSetupRevisionId!]!
  expect(latestSetup.modComposition!.identityMappings).toEqual(behavior.modComposition!.identityMappings)
  expect(resolveGameRules(latestSetup, latest.catalogs).genders.find(gender => gender.id === genderId)?.name).toBe('synthetic-second-gender selection')
  const payload = decodeSharePayload(encodeSharePayload(createSharePayload(latest.localData, { kind: 'build', revisionId })))
  expect(payload.records.gameSetups[configured.setup.id]!.modComposition).toEqual(behavior.modComposition)
  expect(payload.records.buildRevisions[revisionId]!.content.calculation!.genderSelection).toEqual({ version: 1, id: genderId })
  const invalid = JSON.parse(JSON.stringify(payload))
  invalid.records.gameSetups[configured.setup.id].modComposition.identityMappings.push(invalid.records.gameSetups[configured.setup.id].modComposition.identityMappings[0])
  expect(() => validateSharePayload(invalid)).toThrow('unsupported or malformed')
  const backup = await previewImport(await exportBackup(), 'synthetic-identity-backup.zip')
  await commitImport(backup)
  const restored = await loadLocalData()
  expect(restored.localData.gameSetups).toEqual(latest.localData.gameSetups)
  expect(restored.localData.buildRevisions[revisionId]!.content).toEqual(content)
  expect(restored.catalogs.find(catalog => catalog.revisionId === latestSetup.catalogLock[CURRENT_CATALOG.id])?.legacy).toEqual(latest.catalogs.find(catalog => catalog.revisionId === latestSetup.catalogLock[CURRENT_CATALOG.id])?.legacy)
})
