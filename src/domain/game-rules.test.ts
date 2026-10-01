import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { previewImport } from '../interchange/import'
import { buildBehavior, sameBuildBehavior, saveBuildBehavior } from './build-behavior'
import { SUGGESTED_BUILD_SLOTS } from './build-planning'
import { defaultCalculation } from './calculation-plan'
import { NATIVE_DATA } from './calculation-rules'
import { difficultyHitChance, resolveGameRules } from './game-rules'
import { modLibrary } from './mod-library'
import { calculatePCStats } from './pc-stats'
import { calculateBuildStats } from './build-stats'
import { calculateStatBreakdown } from './stat-breakdown'
import { STAT_KEYS } from './crystal-edit'
import { createTestLocalData, TEST_GAME_SETUP_REVISION_ID } from './test-helpers'
import type { BuildRevisionContent, CatalogSnapshot, CatalogRef, EntityId, GameSetupRevision, JsonValue, ModComposition } from './types'

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const importMod = async (ID: string, fields: Record<string, unknown> = {}) => (await previewImport(encode({ ID, Title: ID, EditorVersion: 34, Jobs: [], ...fields }), `${ID}.json`)).proposed.catalogs[0]!
const setup = (catalogs: readonly CatalogSnapshot[], difficulty = 0, mode = 'Standard') => ({ mode: { state: 'known' as const, value: mode }, difficulty: { version: 1 as const, selection: { state: 'known' as const, value: difficulty } }, modComposition: { baseline: { catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId }, layers: catalogs.map(catalog => ({ catalogId: catalog.id, catalogRevisionId: catalog.revisionId, enabled: true })), links: [] } satisfies ModComposition })
const normal = (NATIVE_GAME_DATA.databases.difficulty as Record<string, JsonValue>[])[0]!

describe('data-backed game setup rules', () => {
  it('applies complete battle settings in enabled order, including a later return to the base value', async () => {
    const first = await importMod('first', { System: { BattleConfig: { ...NATIVE_DATA.battleConfig, DualWieldPAtkRate: 40 } } })
    const second = await importMod('second', { System: { BattleConfig: { ...NATIVE_DATA.battleConfig, TwoHandedPAtkFlat: 80 } } })
    const catalogs = [first, second]
    const rules = resolveGameRules(setup(catalogs), catalogs)
    expect(rules.issues).toEqual([])
    expect(rules.battleConfig.DualWieldPAtkRate).toBe(NATIVE_DATA.battleConfig.DualWieldPAtkRate)
    expect(rules.changes).toEqual([{ field: 'TwoHandedPAtkFlat', value: 80, baseline: 50, source: 'second', calculated: true }])
    expect(resolveGameRules(setup([...catalogs].reverse()), catalogs).battleConfig.TwoHandedPAtkFlat).toBe(50)
    const disabled = setup(catalogs)
    expect(resolveGameRules({ ...disabled, modComposition: { ...disabled.modComposition, layers: disabled.modComposition.layers.map((layer, index) => ({ ...layer, enabled: index === 0 })) } }, catalogs).battleConfig.DualWieldPAtkRate).toBe(40)
  })

  it('preserves missing coverage and invalid settings instead of silently supplying base values', async () => {
    const partial = await importMod('partial', { System: { BattleConfig: { DualWieldPAtkRate: 40 } } })
    expect(resolveGameRules(setup([partial]), [partial]).issues.join()).toContain('missing or invalid')
    const old = { ...partial, legacy: { projectTitle: 'Old import', editorVersion: 34 } }
    expect(resolveGameRules(setup([old]), [old]).issues.join()).toContain('Reimport')
    expect(resolveGameRules(setup([partial]), []).issues.join()).toContain('unavailable')
    const future = await importMod('future', { EditorVersion: 99, System: { BattleConfig: NATIVE_DATA.battleConfig } })
    expect(resolveGameRules(setup([future]), [future]).issues.join()).toContain('format 99')
    const localization = await importMod('labels', { IsLocalization: true, System: { BattleConfig: { DualWieldPAtkRate: 1 } } })
    expect(resolveGameRules(setup([localization]), [localization]).changes).toEqual([])
  })

  it('resolves difficulty by identity from base, mode, and mods without guessing a selection', async () => {
    const hard = resolveGameRules(setup([], 2), [])
    expect(hard.difficulty?.name).toBe('Hard')
    expect(hard.difficulty?.values.BossHPRate).toBe(130)
    expect(resolveGameRules(setup([], 2, 'Chaos'), []).difficulty?.values.BossHPRate).toBe(200)
    const changed = await importMod('difficulty change', { Difficulties: [{ ...normal, Name: 'Synthetic normal', BossHPRate: 175, MemberHitChanceMod: 8 }] })
    const rules = resolveGameRules(setup([changed]), [changed])
    expect(rules.difficulty?.values.BossHPRate).toBe(175)
    expect(rules.difficultyIssues).toEqual([])
    expect(difficultyHitChance(97, rules)).toBe(100)
    expect(difficultyHitChance(0, rules)).toBe(0)
    expect(difficultyHitChance(100, rules)).toBe(100)
    expect(difficultyHitChance(50, resolveGameRules({ ...setup([]), mods: { state: 'known', value: ['Unimported changes'] } }, []))).toBeNull()
    expect(difficultyHitChance(50, resolveGameRules({ ...setup([changed]), difficulty: undefined }, [changed]))).toBeNull()
    expect(resolveGameRules(setup([changed], 999), [changed]).difficulty).toBeUndefined()
    const incomplete = await importMod('incomplete difficulty', { Difficulties: [{ ID: 0, Name: 'Incomplete', MemberHitChanceMod: 5 }] })
    expect(difficultyHitChance(50, resolveGameRules(setup([incomplete]), [incomplete]))).toBeNull()
  })

  it('feeds mod constants into native sheet calculations and does not apply enemy difficulty multipliers to the player', async () => {
    const mod = await importMod('unarmed', { System: { BattleConfig: { ...NATIVE_DATA.battleConfig, StrWhileUnarmedBonusFlat: 60 } } })
    const warrior: CatalogRef = { kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: 'base:class:warrior' as EntityId }
    const passive: CatalogRef = { ...warrior, entityId: 'synthetic-unarmed' as EntityId }
    const content: BuildRevisionContent = { primaryClass: warrior, secondaryClass: null, equipment: {}, passives: [{ ref: passive }], contextAssumptions: [], calculation: defaultCalculation(warrior) }
    const resolve = (ref: typeof warrior | { kind: 'personal'; definitionId: string }) => ref.kind === 'catalog' && ref.entityId === passive.entityId ? { id: passive.entityId, name: 'Synthetic unarmed', kind: 'passive' as const, aliases: [], sources: [], fields: { 'Crystal Edit source record': { state: 'known' as const, value: { StatMods: [{ Tag: 474, Value1: 0, Value2: 0 }] } } } } : ref.kind === 'catalog' ? DEFAULT_CATALOG.entities[ref.entityId] : undefined
    const original = calculatePCStats(content, SUGGESTED_BUILD_SLOTS, resolve)
    const modified = calculatePCStats(content, SUGGESTED_BUILD_SLOTS, resolve, [], false, resolveGameRules(setup([mod], 2), [mod]))
    expect(modified.issues).toEqual([])
    expect(modified.neutral.STR).toBe(original.neutral.STR! + 30)
    expect(modified.neutral.HP).toBe(original.neutral.HP)
    const rules = resolveGameRules(setup([mod], 2), [mod])
    const selected = { ...content, calculation: { ...content.calculation!, gender: 'male' as const } }
    const breakdown = calculateStatBreakdown(selected, SUGGESTED_BUILD_SLOTS, resolve, undefined, [], false, rules)
    const estimate = calculateBuildStats(selected, SUGGESTED_BUILD_SLOTS, resolve, undefined, rules)
    for (const stat of STAT_KEYS) {
      const row = breakdown[stat]
      expect(row.total).toEqual(estimate.stats[stat].value)
      expect(row.base!.low + row.level!.low + row.equipment!.low + row.gender!.low).toBe(row.total!.low)
    }
    expect(breakdown.STR.equipment).toEqual({ low: 60, high: 60 })
    const unknown = calculateStatBreakdown(selected, SUGGESTED_BUILD_SLOTS, resolve, undefined, ['Off hand unknown'], false, rules)
    expect(unknown.STR.total).toBeNull()
    expect(unknown.STR.base).toEqual(breakdown.STR.base)
  })

  it('uses the Game Setup balance mode before an independent calculation assumption', () => {
    const ref = (id: string): CatalogRef => ({ kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: id as EntityId })
    const warrior = ref('base:class:warrior')
    const body = SUGGESTED_BUILD_SLOTS.find(slot => slot.equipmentRole === 'body')!
    const content: BuildRevisionContent = { primaryClass: warrior, secondaryClass: null, equipment: { [body.id]: { ref: ref('base:item:plate-of-lion') } }, passives: [], contextAssumptions: [], calculation: defaultCalculation(warrior) }
    const resolve = (value: CatalogRef | { kind: 'personal'; definitionId: string }) => value.kind === 'catalog' ? DEFAULT_CATALOG.entities[value.entityId] : undefined
    const standard = calculatePCStats(content, SUGGESTED_BUILD_SLOTS, resolve)
    const expected = calculatePCStats({ ...content, calculation: { ...content.calculation!, pcMode: 'vanilla' } }, SUGGESTED_BUILD_SLOTS, resolve)
    const actual = calculatePCStats(content, SUGGESTED_BUILD_SLOTS, resolve, [], false, resolveGameRules(setup([], 0, 'Vanilla'), []))
    expect(actual.issues).toEqual([])
    expect(actual.neutral).toEqual(expected.neutral)
    expect(actual.neutral.DEF).not.toBe(standard.neutral.DEF)
    expect(content.calculation?.pcMode).toBe('standard')
    const breakdown = calculateStatBreakdown(content, SUGGESTED_BUILD_SLOTS, resolve, undefined, [], false, resolveGameRules(setup([], 0, 'Vanilla'), []))
    expect(breakdown.VIT.total).toEqual({ low: actual.neutral.VIT!, high: actual.neutral.VIT! })
  })

  it('groups revisions by project identity while preserving every source and checkpoint setting', async () => {
    const first = await importMod('same project', { Version: 'one', System: { BattleConfig: NATIVE_DATA.battleConfig } })
    const second = await importMod('same project', { Version: 'two', System: { BattleConfig: { ...NATIVE_DATA.battleConfig, DualWieldPAtkRate: 45 } } })
    const library = modLibrary([first, second, DEFAULT_CATALOG])
    expect(library).toHaveLength(1)
    expect(library[0]?.revisions).toHaveLength(2)
    expect(first.revisionId).not.toBe(second.revisionId)
    const original = createTestLocalData()
    const before = original.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
    const difficulty: GameSetupRevision['difficulty'] = { version: 1, selection: { state: 'known', value: 2 } }
    const saved = saveBuildBehavior(original, { ...buildBehavior(before), difficulty })
    expect(saved.setup.difficulty).toEqual(difficulty)
    expect(saved.localData.gameSetups[before.id]).toEqual(before)
    expect(sameBuildBehavior(before, saved.setup)).toBe(false)
    expect(sameBuildBehavior(before, { ...before, difficulty: { version: 1, selection: { state: 'unknown' } } })).toBe(true)
  })
})
