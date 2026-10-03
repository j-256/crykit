import { savedCatalogVersion } from '../domain/legacy-definition.test-helpers'
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BUNDLED_CATALOGS, DEFAULT_CATALOG } from '../catalog/bundled'
import { captureCharacter, cloneBuild, compareBuildRevisions, createId, requirePlaythrough, saveBuildRevision } from '../domain'
import { defaultCalculation } from '../domain/calculation-plan'
import { createBuildPlan } from '../domain/build-planning'
import type { BuildId, BuildRevisionId, CatalogRef, EntityId } from '../domain/types'
import { CryKitDatabase, setDatabaseForTests } from './database'
import { commitImport, exportBackup, loadLocalData, previewImport, saveLocalData } from './local-data'

const MIXED_CATALOG_BACKUP_TIMEOUT_MS = 60_000

let database: CryKitDatabase
beforeEach(() => { database = new CryKitDatabase(`build-calculation-${crypto.randomUUID()}`); setDatabaseForTests(database) })
afterEach(async () => { vi.restoreAllMocks(); setDatabaseForTests(undefined); await database.delete() })
const ref = (name: string): CatalogRef => ({ kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: Object.values(DEFAULT_CATALOG.entities).find(entity => entity.name === name)!.id as EntityId })

it('pins calculation inputs through saving, cloning, immutable comparison, and backup restore', async () => {
  const before = await loadLocalData()
  const id = createId<BuildId>('build')
  const revisionId = createId<BuildRevisionId>('buildRevision')
  const planned = createBuildPlan(before.localData, { id, revisionId, title: 'Synthetic planned caster', catalogLock: { [DEFAULT_CATALOG.id]: DEFAULT_CATALOG.revisionId }, content: {
    primaryClass: ref('Cleric'), secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: { level: 20, gender: 'female', growth: [{ classRef: ref('Cleric'), levels: 20 }], bonuses: ['SPI'], statuses: [ref('Power Up')], ability: ref('Cure'), targetEvasion: 50 },
  } })
  const saved = await saveLocalData(planned, before.revision)
  const original = saved.buildRevisions[revisionId]!
  const nextId = createId<BuildRevisionId>('buildRevision')
  const revised = saveBuildRevision(saved, { id: nextId, buildId: id, gameSetupRevisionId: original.gameSetupRevisionId, parentRevisionId: original.id, content: { ...original.content, calculation: { ...original.content.calculation!, level: null, growth: [{ classRef: null, levels: null }] } } })
  const updated = await saveLocalData(revised, saved.revision)
  expect(updated.buildRevisions[revisionId]).toEqual(original)
  expect(compareBuildRevisions(original, updated.buildRevisions[nextId]!).differences.some(row => row.path === 'content.calculation')).toBe(true)
  const cloneId = createId<BuildRevisionId>('buildRevision')
  const cloned = await saveLocalData(cloneBuild(updated, { sourceBuildId: id, revisionId: cloneId }), updated.revision)
  expect(cloned.buildRevisions[cloneId]!.content.calculation).toEqual(updated.buildRevisions[nextId]!.content.calculation)
  const preview = await previewImport(await exportBackup(), 'synthetic-calculation.zip')
  const restored = await commitImport(preview)
  expect(restored.localData.buildRevisions[revisionId]!.content.calculation).toEqual(original.content.calculation)
  expect(restored.localData.buildRevisions[cloneId]!.content.calculation).toEqual(cloned.buildRevisions[cloneId]!.content.calculation)
  expect(requirePlaythrough(restored.localData).characters).toEqual(requirePlaythrough(before.localData).characters)
  expect(requirePlaythrough(restored.localData).inventory).toEqual(requirePlaythrough(before.localData).inventory)
  expect(restored.localData.gameSetups[original.gameSetupRevisionId]!.slots.find(slot => slot.id === 'plan-main-hand')?.equipmentRole).toBe('mainHand')
})

it('rejects unpinned growth references and rolls a failed calculation save back atomically', async () => {
  const before = await loadLocalData()
  const id = createId<BuildId>('build')
  const planned = createBuildPlan(before.localData, { id, title: 'Synthetic rollback', catalogLock: { [DEFAULT_CATALOG.id]: DEFAULT_CATALOG.revisionId }, content: { primaryClass: null, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: { level: null, growth: [], bonuses: [], statuses: [] } } })
  const original = planned.buildRevisions[planned.builds[id]!.latestRevisionId!]!
  expect(() => saveBuildRevision(planned, { buildId: id, gameSetupRevisionId: original.gameSetupRevisionId, content: { ...original.content, calculation: { ...original.content.calculation!, growth: [{ classRef: { ...ref('Cleric'), catalogRevisionId: 'unlocked-revision' as CatalogRef['catalogRevisionId'] }, levels: 20 }] } } })).toThrow('catalog lock')
  vi.spyOn(database.history, 'add').mockRejectedValueOnce(new DOMException('Synthetic quota failure', 'QuotaExceededError'))
  await expect(saveLocalData(planned, before.revision)).rejects.toMatchObject({ code: 'storage-failure' })
  expect((await loadLocalData()).localData).toEqual(before.localData)
})

it('round-trips native and earlier bundled catalog revisions together without retargeting definitions', async () => {
  const before = await loadLocalData()
  let data = before.localData
  for (const catalog of BUNDLED_CATALOGS) {
    const sourceRef: CatalogRef = { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: 'base:class:warrior' as EntityId }
    data = savedCatalogVersion(data, BUNDLED_CATALOGS, { sourceRef, name: `Synthetic retained ${catalog.revisionId}` }).localData
  }
  await saveLocalData(data, before.revision)
  const preview = await previewImport(await exportBackup(), 'synthetic-mixed-catalogs.zip')
  expect(preview.proposed.catalogs.map(catalog => catalog.revisionId).sort()).toEqual(BUNDLED_CATALOGS.map(catalog => catalog.revisionId).sort())
  const restored = await commitImport(preview)
  expect(restored.localData.personalDefinitions).toEqual(data.personalDefinitions)
}, MIXED_CATALOG_BACKUP_TIMEOUT_MS)

it('round-trips character calculation assumptions without rewriting observed level, totals or earlier snapshots', async () => {
  const before = await loadLocalData()
  const character = Object.values(requirePlaythrough(before.localData).characters)[0]!
  const original = character.snapshots[character.currentSnapshotId!]!
  const calculation = { ...defaultCalculation(ref('Warrior')), gender: 'female' as const, growthMode: 'manual' as const, growth: [{ classRef: ref('Warrior'), levels: 40 }, { classRef: ref('Wizard'), levels: 20 }] }
  const planned = captureCharacter(before.localData, { characterId: character.id, gameSetupRevisionId: original.gameSetupRevisionId, level: original.level, displayedStats: original.displayedStats, primaryClass: original.primaryClass, secondaryClass: original.secondaryClass, equipment: original.equipment, passives: original.passives, calculation })
  const saved = await saveLocalData(planned, before.revision)
  const updatedCharacter = requirePlaythrough(saved).characters[character.id]!
  const snapshot = updatedCharacter.snapshots[updatedCharacter.currentSnapshotId!]!
  expect(snapshot.calculation).toEqual(calculation)
  expect(snapshot.level).toEqual(original.level)
  expect(snapshot.displayedStats).toEqual(original.displayedStats)
  expect(updatedCharacter.snapshots[original.id]).toEqual(original)
  const restored = await commitImport(await previewImport(await exportBackup(), 'synthetic-character-calculation.zip'))
  expect(requirePlaythrough(restored.localData).characters[character.id]!.snapshots[snapshot.id]!.calculation).toEqual(calculation)
  expect(() => captureCharacter(saved, { characterId: character.id, calculation: { ...calculation, level: 61 } })).toThrow('Calculation level')
  vi.spyOn(database.history, 'add').mockRejectedValueOnce(new DOMException('Synthetic quota failure', 'QuotaExceededError'))
  const retryBase = await loadLocalData()
  await expect(saveLocalData(captureCharacter(retryBase.localData, { characterId: character.id, calculation: { ...calculation, gender: 'male' } }), retryBase.revision)).rejects.toMatchObject({ code: 'storage-failure' })
  expect((await loadLocalData()).localData).toEqual(retryBase.localData)
})
