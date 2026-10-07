import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { resolveCalculationEntity } from '../ui/model'
import { buildBehavior, saveBuildBehavior } from './build-behavior'
import { buildContentForModSetup, selectBuildModRevision } from './build-mods'
import { SUGGESTED_BUILD_SLOTS } from './build-planning'
import { defaultCalculation } from './calculation-plan'
import { NATIVE_DATA, PC_RULES } from './calculation-rules'
import { STAT_KEYS } from './crystal-edit'
import { resolveGameRules } from './game-rules'
import { calculateGrowth } from './growth'
import { composeModCatalog, composeModLayers, expandModCatalogs, modModelEntity } from './mod-layers'
import { calculatePCStats, nativeStatRecord, selectedPCStats } from './pc-stats'
import { calculateStatBreakdown } from './stat-breakdown'
import { createTestLocalData, TEST_GAME_SETUP_REVISION_ID } from './test-helpers'
import type { BuildRevisionContent, CatalogRef, CatalogSnapshot, EntityId, EntityRef } from './types'

const ref = (id: string): CatalogRef => ({ kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: id as EntityId })
const warrior = ref('base:job:0')
const content = (primaryClass: EntityRef = warrior): BuildRevisionContent => ({ primaryClass, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: defaultCalculation(primaryClass) })
const importMod = async (ID: string, values: Record<string, unknown>) => (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID, Title: ID, EditorVersion: 34, ...values })), 'synthetic.json')).proposed.catalogs[0]!
const bonuses = Object.fromEntries(STAT_KEYS.map(stat => [PC_RULES.stats[stat]!.gender!, false]))
const job = { ID: 40, Name: 'Synthetic growth class', PassiveIDs: [], ...Object.fromEntries(STAT_KEYS.map(stat => [PC_RULES.stats[stat]!.rating!, 40])) }

function configured(mods: readonly CatalogSnapshot[], mode = 'Standard') {
  const original = createTestLocalData()
  const catalogs = [DEFAULT_CATALOG, ...mods]
  let behavior = { ...buildBehavior(original.gameSetups[TEST_GAME_SETUP_REVISION_ID]!), platform: { state: 'known' as const, value: 'Windows' }, gameVersion: { state: 'known' as const, value: '1.6.9' }, mode: { state: 'known' as const, value: mode }, mods: { state: 'known' as const, value: [] as readonly string[] } }
  for (const mod of mods) behavior = selectBuildModRevision(behavior, mod, catalogs) as typeof behavior
  const { localData, setup } = saveBuildBehavior(original, behavior)
  const effective = expandModCatalogs([...catalogs, composeModCatalog(setup, catalogs)!])
  const resolve = (ref: EntityRef) => resolveCalculationEntity(localData, effective, ref, setup)
  const rules = resolveGameRules(setup, catalogs)
  const calculate = (selected: BuildRevisionContent = content()) => calculatePCStats(buildContentForModSetup(selected, setup, effective), SUGGESTED_BUILD_SLOTS, resolve, [], false, rules)
  return { catalogs, effective, localData, setup, resolve, rules, calculate }
}

describe('source-backed mod calculation inputs', () => {
  it.each(STAT_KEYS)('changes the %s gender bonus without inheriting vanilla flags', async stat => {
    const mod = await importMod('synthetic-gender-flags', { Jobs: [job], Genders: [{ ID: 0, Name: 'Synthetic bonus', ...bonuses, [PC_RULES.stats[stat]!.gender!]: true }] })
    const context = configured([mod])
    const primary: CatalogRef = { kind: 'catalog', catalogId: mod.id, catalogRevisionId: mod.revisionId, entityId: modModelEntity(mod, 'crystal-edit:Jobs:40')!.id }
    const result = context.calculate(content(primary))
    expect(result.issues).toEqual([])
    for (const key of STAT_KEYS) expect(result.male[key]! - result.neutral[key]!).toBe(key === stat ? stat === 'HP' ? 100 : stat === 'MP' ? 20 : 15 : 0)
    expect(result.neutral.HP).toBe(933)
    expect(result.neutral.MP).toBe(116)
    expect(result.neutral.STR).toBe(150)
  })

  it.each([{ level: 1, hp: 116, mp: 24, core: 15 }, { level: 7, hp: 209, mp: 35, core: 30 }, { level: 60, hp: 1033, mp: 136, core: 165 }])('retains compiled native rounding at level $level for added gender records', async ({ level, hp, mp, core }) => {
    const mod = await importMod('synthetic-extra-gender', { Jobs: [job], Genders: [{ ID: 8, Name: 'All bonuses', ...Object.fromEntries(Object.keys(bonuses).map(key => [key, true])) }] })
    const context = configured([mod])
    const primary: CatalogRef = { kind: 'catalog', catalogId: mod.id, catalogRevisionId: mod.revisionId, entityId: modModelEntity(mod, 'crystal-edit:Jobs:40')!.id }
    const selected = { ...content(primary), calculation: { ...defaultCalculation(primary, level), genderSelection: { version: 1 as const, id: 8 } } }
    const result = context.calculate(selected)
    const total = selectedPCStats(result, undefined, selected.calculation.genderSelection)
    expect(result.issues).toEqual([])
    expect(total.HP).toBe(hp)
    expect(total.MP).toBe(mp)
    expect(total.STR).toBe(core)
    const rebound = buildContentForModSetup(selected, context.setup, context.effective)
    const growth = calculateGrowth(level, nativeStatRecord(rebound.primaryClass, 'job', context.resolve), [{ levels: level, record: nativeStatRecord(rebound.primaryClass, 'job', context.resolve) }], undefined, context.rules, selected.calculation.genderSelection)
    expect(growth.stats.HP).toBe(hp)
    expect(growth.stats.STR).toBe(core)
    const breakdown = calculateStatBreakdown(rebound, SUGGESTED_BUILD_SLOTS, context.resolve, undefined, [], false, context.rules)
    expect(breakdown.HP.total).toEqual({ low: hp, high: hp })
    expect(breakdown.HP.base!.low + breakdown.HP.level!.low + breakdown.HP.equipment!.low + breakdown.HP.gender!.low).toBe(hp)
  })

  it('applies enabled gender priority and ignores localization mechanics', async () => {
    const first = await importMod('first bonus', { Genders: [{ ...NATIVE_DATA.records.gender[0], BoostHP: false, BoostStr: true }] })
    const second = await importMod('later bonus', { Genders: [{ ...NATIVE_DATA.records.gender[0], BoostHP: false, BoostMP: true }] })
    const locale = await importMod('labels', { IsLocalization: true, Genders: [{ ...NATIVE_DATA.records.gender[0], BoostHP: true, BoostMP: false, Name: 'Localized label' }] })
    const context = configured([first, second, locale])
    expect(context.rules.issues).toEqual([])
    expect(context.rules.genders[0]!.source).toBe('later bonus')
    expect(context.rules.genders[0]!.sourceKind).toBe('mod')
    expect(context.rules.genders[0]!.nameSource).toBe('labels')
    const localizedNative = configured([locale]).rules.genders[0]!
    expect(localizedNative.sourceKind).toBe('native')
    expect(localizedNative.nameSource).toBe('labels')
    expect(localizedNative.boosts).toEqual(resolveGameRules(undefined, []).genders[0]!.boosts)
    expect(configured([locale, second]).rules.genders[0]!.nameSource).toBeUndefined()
    expect(context.rules.genders[0]!.name).toBe('Localized label')
    expect(context.calculate().male.HP).toBe(context.calculate().neutral.HP)
    expect(context.calculate().male.MP).toBeGreaterThan(context.calculate().neutral.MP!)
    expect(configured([second, first]).rules.genders[0]!.boosts.STR).toBe(true)
    const disabled = { ...context.setup, modComposition: { ...context.setup.modComposition!, layers: context.setup.modComposition!.layers.map(layer => ({ ...layer, enabled: false })) } }
    expect(resolveGameRules(disabled, context.catalogs).genders).toEqual(resolveGameRules(undefined, []).genders)
  })

  it('leaves invalid gender flags unresolved while preserving neutral and other valid comparisons', async () => {
    const mod = await importMod('invalid flags', { Genders: [{ ID: 0, Name: 'Incomplete flags', BoostHP: true }] })
    const result = configured([mod]).calculate()
    expect(result.neutral.HP).toBeGreaterThan(0)
    expect(result.male.HP).toBeNull()
    expect(result.female.HP).toBeGreaterThan(0)
    expect(result.issues.join(' ')).toContain('missing or invalid bonus flags')
    const missing = configured([mod]).calculate({ ...content(), calculation: { ...defaultCalculation(warrior), genderSelection: { version: 1, id: 999 } } })
    expect(selectedPCStats(missing, undefined, { version: 1, id: 999 }).HP).toBeNull()
    expect(missing.issues.join(' ')).toContain('Gender #999 is unavailable')
  })

  it('reads earlier rule projections without rewriting them or assuming missing gender coverage', async () => {
    const mod = await importMod('legacy rules', { Jobs: [], Genders: [] })
    const legacy = JSON.parse(JSON.stringify(mod)) as CatalogSnapshot
    const metadata = legacy.legacy as Record<string, unknown>
    metadata.gameRules = { version: 1, battleConfig: null, difficulties: [], localization: false, unsupported: [] }
    const before = JSON.stringify(legacy)
    expect(configured([legacy]).rules.issues).toEqual([])
    expect(JSON.stringify(legacy)).toBe(before)
    metadata.gameRules = { version: 1, battleConfig: null, difficulties: [], localization: false, unsupported: ['Genders'] }
    const unavailable = configured([legacy])
    expect(unavailable.rules.issues.join(' ')).toContain("Reimport and select")
    expect(unavailable.calculate().male.HP).toBeNull()
  })

  it('calculates changes to a native innate while leaving its class record untouched', async () => {
    const native = NATIVE_DATA.records.job.find(record => record.ID === 0)!
    const id = native.PassiveIDs[0]!
    const innate = NATIVE_DATA.records.passive.find(record => record.ID === id)!
    const mod = await importMod('native innate', { Passives: [{ ...innate, Name: 'Modified innate', StatMods: [{ Tag: 0, Value1: 123, Value2: 0 }] }] })
    const context = configured([mod])
    expect(context.setup.modComposition!.links).toContainEqual({ modelKey: `crystal-edit:Passives:${id}`, targetEntityId: `base:passive:${id}` })
    expect(context.calculate().issues).toEqual([])
    const unchanged = calculatePCStats(content(), SUGGESTED_BUILD_SLOTS, ref => ref.kind === 'catalog' ? DEFAULT_CATALOG.entities[ref.entityId] : undefined)
    expect(context.calculate().neutral.HP).toBe(unchanged.neutral.HP! + 123)
    expect(context.effective.at(-1)!.entities[warrior.entityId]).toEqual(DEFAULT_CATALOG.entities[warrior.entityId])
  })

  it('resolves an imported class innate from another layer or an exact native fallback', async () => {
    const first = await importMod('custom class', { Jobs: [{ ...job, PassiveIDs: [9000, 6] }] })
    const second = await importMod('custom innate', { Passives: [{ ID: 9000, Name: 'Cross-layer bonus', IsInnate: true, StatMods: [{ Tag: 0, Value1: 77, Value2: 0 }] }] })
    const primary: CatalogRef = { kind: 'catalog', catalogId: first.id, catalogRevisionId: first.revisionId, entityId: modModelEntity(first, 'crystal-edit:Jobs:40')!.id }
    const context = configured([first, second])
    const result = context.calculate(content(primary))
    expect(composeModLayers(context.setup.modComposition!, context.catalogs).unresolvedReferences).toEqual([])
    expect(result.issues).toEqual([])
    expect(result.neutral.HP).toBe(1010)
    const invalid = await importMod('custom innate', { Passives: [{ ID: 9000, Name: 'Unknown replacement', IsInnate: true }] })
    const unavailable = configured([first, invalid]).calculate(content(primary))
    expect(unavailable.neutral.HP).toBeNull()
    expect(unavailable.issues.join(' ')).toContain('numeric effects are unknown')
  })

  it('lets a source change innate membership without retaining the old automatic effect', async () => {
    const native = NATIVE_DATA.records.job.find(record => record.ID === 0)!
    const id = native.PassiveIDs[0]!
    const mod = await importMod('remove innate', { Passives: [{ ID: id, Name: 'Optional passive', IsInnate: false, PP: 1, StatMods: [{ Tag: 0, Value1: 123, Value2: 0 }] }] })
    const context = configured([mod])
    const result = context.calculate()
    expect(result.issues).toEqual([])
    expect(context.effective.at(-1)!.entities[`base:passive:${id}`]!.kind).toBe('passive')
    expect(result.neutral.HP).toBe(result.base.HP)
  })

  it('applies complete mod records after mode patches and keeps localization numeric inputs unchanged', async () => {
    const original = NATIVE_DATA.records.job.find(record => record.ID === 0)!
    const mod = await importMod('class override', { Jobs: [{ ...original, HPRating: 40, PassiveIDs: [] }] })
    const locale = await importMod('localized class', { IsLocalization: true, Jobs: [{ ...original, HPRating: 0, Name: 'Translated class' }] })
    const context = configured([mod, locale], 'Chaos')
    expect(context.calculate().issues).toEqual([])
    expect(context.calculate().neutral.HP).toBe(933)
    expect(context.resolve(buildContentForModSetup(content(), context.setup, context.effective).primaryClass!)?.name).toBe('Translated class')
  })

  it('preserves historical collision warnings while new compositions keep project identities separate', async () => {
    const first = await importMod('first additions', { Genders: [{ ID: 8, Name: 'First extra', ...bonuses }] })
    const second = await importMod('second additions', { Genders: [{ ID: 8, Name: 'Second extra', ...bonuses, BoostHP: true }] })
    const context = configured([first, second])
    const historical = { ...context.setup, modComposition: { ...context.setup.modComposition!, version: 2 as const, identityMappings: undefined } }
    expect(resolveGameRules(historical, context.catalogs).issues.join(' ')).toContain("CryKit cannot combine these added IDs")
    expect(context.rules.issues).toEqual([])
    expect(context.rules.genders.filter(gender => gender.sourceKind === 'mod').map(gender => gender.name)).toEqual(['First extra', 'Second extra'])
    expect(context.calculate().neutral.HP).not.toBeNull()
    const disabled = { ...context.setup, modComposition: { ...context.setup.modComposition!, layers: context.setup.modComposition!.layers.map(layer => ({ ...layer, enabled: layer.catalogId === first.id })) } }
    expect(resolveGameRules(disabled, context.catalogs).issues).toEqual([])
  })
})
