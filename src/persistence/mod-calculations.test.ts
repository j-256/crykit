import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { buildBehavior, saveBuildBehavior } from '../domain/build-behavior'
import { buildContentForModSetup, selectBuildModRevision } from '../domain/build-mods'
import { createBuildPlan, SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { defaultCalculation } from '../domain/calculation-plan'
import { NATIVE_DATA } from '../domain/calculation-rules'
import { createId } from '../domain/core'
import { resolveGameRules } from '../domain/game-rules'
import { modCatalogForPin } from '../domain/mod-layers'
import { calculatePCStats, selectedPCStats } from '../domain/pc-stats'
import type { BuildId, BuildRevisionId, CatalogRef, EntityId, EntityRef } from '../domain/types'
import { createSharePayload, decodeSharePayload, encodeSharePayload, sharePreviewData, validateSharePayload } from '../interchange/share'
import { NativeLocalDataSchema } from '../interchange/native-schema'
import { resolveCalculationEntity } from '../ui/model'
import { CryKitDatabase, setDatabaseForTests } from './database'
import { commitImport, exportBackup, loadLocalData, prepareModCatalogs, previewImport, saveLocalData } from './local-data'

let database: CryKitDatabase
beforeEach(() => { database = new CryKitDatabase(`mod-calculations-${crypto.randomUUID()}`); setDatabaseForTests(database) })
afterEach(async () => { vi.restoreAllMocks(); setDatabaseForTests(undefined); await database.delete() })
const warrior: CatalogRef = { kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: 'base:job:0' as EntityId }

it('round-trips a versioned mod gender and its exact setup through backup and read-only shares', async () => {
  const mod = { ID: 'synthetic-persisted-gender', EditorVersion: 34, Genders: [{ ...NATIVE_DATA.records.gender[0], ID: 8, Name: 'Synthetic extra bonus', BoostStr: true }] }
  const bytes = new TextEncoder().encode(JSON.stringify(mod))
  await loadLocalData()
  await commitImport(await previewImport(bytes, 'synthetic.json'), { mode: 'add-reference' })
  const loaded = await loadLocalData()
  const source = loaded.catalogs.find(catalog => catalog.id === 'crystal-edit:synthetic-persisted-gender')!
  const initial = loaded.localData.gameSetups[loaded.localData.planningGameSetupRevisionId!]!
  const behavior = selectBuildModRevision({ ...buildBehavior(initial), platform: { state: 'known', value: 'Windows' }, gameVersion: { state: 'known', value: '1.6.9' }, mode: { state: 'known', value: 'Standard' }, mods: { state: 'known', value: [] } }, source, loaded.catalogs)
  const configured = saveBuildBehavior(loaded.localData, behavior)
  const base = { ...configured.localData, planningGameSetupRevisionId: configured.setup.id }
  const id = createId<BuildId>('build')
  const revisionId = createId<BuildRevisionId>('buildRevision')
  const content = buildContentForModSetup({ primaryClass: warrior, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: { ...defaultCalculation(warrior), genderSelection: { version: 1 as const, id: 8 } } }, configured.setup, loaded.catalogs)
  const planned = createBuildPlan(base, { id, revisionId, title: 'Synthetic extra gender', content, catalogLock: configured.setup.catalogLock })
  await saveLocalData(planned, loaded.revision)
  const saved = await loadLocalData()
  const effective = modCatalogForPin(saved.catalogs, { catalogId: DEFAULT_CATALOG.id, catalogRevisionId: configured.setup.catalogLock[DEFAULT_CATALOG.id]! })!
  const resolver = (ref: EntityRef) => resolveCalculationEntity(saved.localData, saved.catalogs, ref, configured.setup)
  const expected = calculatePCStats(content, SUGGESTED_BUILD_SLOTS, resolver, [], false, resolveGameRules(configured.setup, saved.catalogs))
  expect(expected.issues).toEqual([])
  expect(selectedPCStats(expected, undefined, content.calculation.genderSelection).STR).toBeGreaterThan(expected.neutral.STR!)
  const payload = decodeSharePayload(encodeSharePayload(createSharePayload(saved.localData, { kind: 'build', revisionId })))
  expect(payload.records.buildRevisions[revisionId]!.content.calculation).toEqual(content.calculation)
  const previewData = sharePreviewData(payload)
  const previewCatalogs = await prepareModCatalogs(previewData, saved.catalogs)
  const previewResolve = (ref: EntityRef) => resolveCalculationEntity(previewData, previewCatalogs, ref, configured.setup)
  expect(calculatePCStats(payload.records.buildRevisions[revisionId]!.content, SUGGESTED_BUILD_SLOTS, previewResolve, [], false, resolveGameRules(configured.setup, previewCatalogs))).toEqual(expected)
  const backup = await previewImport(await exportBackup(), 'synthetic-mod-calculations.zip')
  const restored = await commitImport(backup)
  expect(restored.localData.gameSetups).toEqual(saved.localData.gameSetups)
  expect(restored.localData.buildRevisions[revisionId]!.content.calculation).toEqual(content.calculation)
  const reloaded = await loadLocalData()
  expect(modCatalogForPin(reloaded.catalogs, { catalogId: effective.id, catalogRevisionId: effective.revisionId })!).toEqual(effective)
  expect(backup.proposed.sources.some(source => source.bytes.length === bytes.length && source.bytes.every((value, index) => value === bytes[index]))).toBe(true)
  const invalid = JSON.parse(JSON.stringify(payload))
  invalid.records.buildRevisions[revisionId].content.calculation.genderSelection.version = 99
  expect(() => validateSharePayload(invalid)).toThrow('unsupported or malformed')
  const malformed = { ...saved.localData, buildRevisions: { ...saved.localData.buildRevisions, [revisionId]: { ...saved.localData.buildRevisions[revisionId]!, content: { ...content, calculation: { ...content.calculation, gender: 'male' } } } } }
  expect(NativeLocalDataSchema.safeParse(malformed).success).toBe(false)
})

it('rolls back a failed versioned gender save without changing old checkpoints', async () => {
  const loaded = await loadLocalData()
  const id = createId<BuildId>('build')
  const planned = createBuildPlan(loaded.localData, { id, title: 'Synthetic gender rollback', catalogLock: { [DEFAULT_CATALOG.id]: DEFAULT_CATALOG.revisionId }, content: { primaryClass: warrior, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: { ...defaultCalculation(warrior), genderSelection: { version: 1, id: 8 } } } })
  vi.spyOn(database.history, 'add').mockRejectedValueOnce(new DOMException('Synthetic quota failure', 'QuotaExceededError'))
  await expect(saveLocalData(planned, loaded.revision)).rejects.toMatchObject({ code: 'storage-failure' })
  expect((await loadLocalData()).localData).toEqual(loaded.localData)
})
