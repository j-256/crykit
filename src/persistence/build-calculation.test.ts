import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { cloneBuild, compareBuildRevisions, createId, saveBuildRevision } from '../domain'
import { createBuildPlan } from '../domain/build-planning'
import type { BuildId, BuildRevisionId, CatalogRef, EntityId } from '../domain/types'
import { CrystalCompanionDatabase, setDatabaseForTests } from './database'
import { commitImport, createProfile, exportBackup, loadWorkspace, previewImport, saveProfile } from './workspace'

let database: CrystalCompanionDatabase
beforeEach(() => { database = new CrystalCompanionDatabase(`build-calculation-${crypto.randomUUID()}`); setDatabaseForTests(database) })
afterEach(async () => { vi.restoreAllMocks(); setDatabaseForTests(undefined); await database.delete() })
const ref = (name: string): CatalogRef => ({ kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: Object.values(DEFAULT_CATALOG.entities).find(entity => entity.name === name)!.id as EntityId })

it('pins calculation inputs through saving, cloning, immutable comparison, and backup restore', async () => {
  await loadWorkspace()
  const before = await createProfile('Synthetic calculation')
  const id = createId<BuildId>('build')
  const revisionId = createId<BuildRevisionId>('buildRevision')
  const planned = createBuildPlan(before.profile, { id, revisionId, title: 'Synthetic planned caster', kind: 'template', catalogLock: { [DEFAULT_CATALOG.id]: DEFAULT_CATALOG.revisionId }, content: {
    primaryClass: ref('Cleric'), secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: { level: 20, growth: [{ classRef: ref('Cleric'), levels: 20 }], bonuses: ['SPI'], statuses: [ref('Power Up')], ability: ref('Cure'), targetEvasion: 50 },
  } })
  const saved = await saveProfile(planned, before.revision)
  const original = saved.buildRevisions[revisionId]!
  const nextId = createId<BuildRevisionId>('buildRevision')
  const revised = saveBuildRevision(saved, { id: nextId, buildId: id, rulesetRevisionId: original.rulesetRevisionId, parentRevisionId: original.id, content: { ...original.content, calculation: { ...original.content.calculation!, level: null, growth: [{ classRef: null, levels: null }] } } })
  const updated = await saveProfile(revised, saved.revision)
  expect(updated.buildRevisions[revisionId]).toEqual(original)
  expect(compareBuildRevisions(original, updated.buildRevisions[nextId]!).differences.some(row => row.path === 'content.calculation')).toBe(true)
  const cloneId = createId<BuildRevisionId>('buildRevision')
  const cloned = await saveProfile(cloneBuild(updated, { sourceBuildId: id, revisionId: cloneId }), updated.revision)
  expect(cloned.buildRevisions[cloneId]!.content.calculation).toEqual(updated.buildRevisions[nextId]!.content.calculation)
  const preview = await previewImport(await exportBackup(cloned.id), 'synthetic-calculation.zip')
  const restored = await commitImport(preview)
  expect(restored.profile.buildRevisions[revisionId]!.content.calculation).toEqual(original.content.calculation)
  expect(restored.profile.buildRevisions[cloneId]!.content.calculation).toEqual(cloned.buildRevisions[cloneId]!.content.calculation)
  expect(restored.profile.characters).toEqual(before.profile.characters)
  expect(restored.profile.inventory).toEqual(before.profile.inventory)
  expect(restored.profile.rulesets[original.rulesetRevisionId]!.slots.find(slot => slot.id === 'plan-main-hand')?.equipmentRole).toBe('mainHand')
})

it('rejects unpinned growth references and rolls a failed calculation save back atomically', async () => {
  const before = await loadWorkspace()
  const id = createId<BuildId>('build')
  const planned = createBuildPlan(before.profile, { id, title: 'Synthetic rollback', kind: 'template', catalogLock: { [DEFAULT_CATALOG.id]: DEFAULT_CATALOG.revisionId }, content: { primaryClass: null, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: { level: null, growth: [], bonuses: [], statuses: [] } } })
  const original = planned.buildRevisions[planned.builds[id]!.latestRevisionId!]!
  expect(() => saveBuildRevision(planned, { buildId: id, rulesetRevisionId: original.rulesetRevisionId, content: { ...original.content, calculation: { ...original.content.calculation!, growth: [{ classRef: { ...ref('Cleric'), catalogRevisionId: 'unlocked-revision' as CatalogRef['catalogRevisionId'] }, levels: 20 }] } } })).toThrow('catalog lock')
  vi.spyOn(database.history, 'add').mockRejectedValueOnce(new DOMException('Synthetic quota failure', 'QuotaExceededError'))
  await expect(saveProfile(planned, before.revision)).rejects.toMatchObject({ code: 'storage-failure' })
  expect((await loadWorkspace(before.profile.id)).profile).toEqual(before.profile)
})
