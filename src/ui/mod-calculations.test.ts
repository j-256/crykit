import { buildDefinitionOptions, definitionOptionsForSetup } from './definitions'
import { expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { definitionModAvailability } from '../catalog/mods'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { calculateBuildStats } from '../domain/build-stats'
import { defaultCalculation } from '../domain/calculation-plan'
import { calculatePCStats } from '../domain/pc-stats'
import { createTestLocalData, TEST_GAME_SETUP_REVISION_ID } from '../domain/test-helpers'
import type { BuildRevisionContent, CatalogRef, EntityId, EntityRef, GameSetupRevision } from '../domain/types'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { resolveCalculationEntity } from './model'

const warrior: CatalogRef = { kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: 'base:class:warrior' as EntityId }

it('applies exact enabled imported equipment and leaves disabled or unselected effects unresolved', async () => {
  const imported = (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: 'synthetic-stat-mod', Title: 'Synthetic stat mod', EditorVersion: 34, Equipment: [{ ID: 9000, Name: 'Synthetic HP sword', EquipmentType: 0, IsTwoHanded: false, StatMods: [{ Tag: 0, Value1: 101, Value2: 0 }] }] })), 'synthetic.json')).proposed.catalogs[0]!
  const catalogs = [DEFAULT_CATALOG, imported]
  const data = createTestLocalData()
  const original = data.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
  const item: CatalogRef = { kind: 'catalog', catalogId: imported.id, catalogRevisionId: imported.revisionId, entityId: Object.values(imported.entities)[0]!.id }
  const content: BuildRevisionContent = { primaryClass: warrior, secondaryClass: null, equipment: { 'plan-main-hand': { ref: item } }, passives: [], contextAssumptions: [], calculation: defaultCalculation(warrior) }
  const setup = (enabled: boolean): GameSetupRevision => ({ ...original, modComposition: { baseline: { catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId }, layers: [{ catalogId: imported.id, catalogRevisionId: imported.revisionId, enabled }], links: [] } })
  const resolve = (context: GameSetupRevision) => (ref: EntityRef) => resolveCalculationEntity(data, catalogs, ref, context)
  const enabled = calculatePCStats(content, SUGGESTED_BUILD_SLOTS, resolve(setup(true)))
  const empty = calculatePCStats({ ...content, equipment: {} }, SUGGESTED_BUILD_SLOTS, resolve(setup(true)))
  expect(enabled.issues).toEqual([])
  expect(enabled.neutral.HP).toBe(empty.neutral.HP! + 101)
  for (const context of [setup(false), original]) {
    const pc = calculatePCStats(content, SUGGESTED_BUILD_SLOTS, resolve(context))
    expect(pc.neutral.HP).toBeNull()
    expect(pc.issues.join(' ')).toContain('Synthetic stat mod')
    expect(pc.issues.join(' ')).toContain('effects are not applied')
    const guide = calculateBuildStats({ ...content, calculation: { ...content.calculation!, model: undefined } }, SUGGESTED_BUILD_SLOTS, resolve(context))
    expect(guide.stats.HP.value).toBeNull()
    expect(guide.contributions.some(entry => entry.value === 101)).toBe(false)
    expect(guide.issues.join(' ')).toContain('effects are not applied')
  }
  const options = buildDefinitionOptions(data, catalogs)
  expect(definitionOptionsForSetup(options, catalogs, setup(false)).some(option => option.ref.kind === 'catalog' && option.ref.catalogId === imported.id)).toBe(true)
  expect(definitionOptionsForSetup(options, catalogs, original).some(option => option.ref.kind === 'catalog' && option.ref.catalogId === imported.id)).toBe(true)
  expect(definitionOptionsForSetup(options, catalogs, setup(true)).some(option => option.ref.kind === 'catalog' && option.ref.catalogId === imported.id)).toBe(false)
  expect(definitionModAvailability(data, item, setup(false), catalogs).state).toBe('disabled')
  expect(definitionModAvailability(data, item, original, catalogs).state).toBe('unknown')
  const unrelated = { ...original, mods: { state: 'known' as const, value: ['Synthetic stat mod'] } }
  expect(definitionModAvailability(data, item, unrelated, catalogs).state).toBe('unknown')
})

it.each(['disabled', 'unknown', 'conflicting'] as const)('does not calculate a %s Switch mod class or its growth allocation', state => {
  const data = createTestLocalData()
  const original = data.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
  const mod = 'Moonlight Project'
  const setup: GameSetupRevision = { ...original, mods: state === 'conflicting' ? { state: 'conflicting', claims: [{ value: [mod], sources: [] }, { value: [], sources: [] }] } : { state: 'unknown' }, disabledMods: state === 'disabled' ? { state: 'known', value: [mod] } : { state: 'unknown' } }
  const brawler: CatalogRef = { ...warrior, entityId: Object.values(DEFAULT_CATALOG.entities).find(entity => entity.kind === 'class' && entity.name === 'Brawler')!.id }
  const resolve = (ref: EntityRef) => resolveCalculationEntity(data, [DEFAULT_CATALOG], ref, setup)
  for (const primaryClass of [warrior, brawler]) {
    const content: BuildRevisionContent = { primaryClass, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: { ...defaultCalculation(primaryClass), growth: [{ classRef: brawler, levels: 60 }] } }
    const result = calculatePCStats(content, SUGGESTED_BUILD_SLOTS, resolve)
    expect(result.neutral.HP).toBeNull()
    expect(result.issues.join(' ')).toContain(`Brawler: ${mod}`)
    expect(result.issues.join(' ')).toContain('effects are not applied')
  }
})
