import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { SUGGESTED_BUILD_SLOTS } from './build-planning'
import { calculateBuildStats } from './build-stats'
import { defaultCalculation, validateCalculationPlan } from './calculation-plan'
import { STAT_KEYS } from './crystal-edit'
import { calculatePCStats, selectedPCStats } from './pc-stats'
import { calculateStatBreakdown } from './stat-breakdown'
import type { BuildCalculationPlan, BuildRevisionContent, CatalogEntity, CatalogRef, EntityId, EntityRef } from './types'

const ref = (id: string): CatalogRef => ({ kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: id as EntityId })
const warrior = ref('base:job:0')
const wizard = ref('base:job:3')
const gear = ref('synthetic-breakdown-gear')
const passive = ref('synthetic-breakdown-passive')
const synthetic = new Map<string, CatalogEntity>([
  [gear.entityId, { id: gear.entityId, name: 'Synthetic integer bonuses', kind: 'item', aliases: [], sources: [], fields: { 'Crystal Edit source record': { state: 'known', value: { ID: 9000, EquipmentType: 0, IsTwoHanded: false, StatMods: [{ Tag: 40, Value1: 101, Value2: 0 }, { Tag: 100, Value1: 5, Value2: 2 }] } } } }],
  [passive.entityId, { id: passive.entityId, name: 'Synthetic HP percentage', kind: 'passive', aliases: [], sources: [], fields: { 'Crystal Edit source record': { state: 'known', value: { StatMods: [{ Tag: 20, Value1: 10, Value2: 0 }] } } } }],
])
const resolve = (value: EntityRef) => value.kind === 'catalog' ? synthetic.get(value.entityId) ?? DEFAULT_CATALOG.entities[value.entityId] : undefined
const content = (gender?: BuildCalculationPlan['gender'], level = 60): BuildRevisionContent => ({ primaryClass: warrior, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: { ...defaultCalculation(warrior, level), gender } })

describe('stat contributions and gender selection', () => {
  it.each([undefined, 'male', 'female'] as const)('reconciles %s totals with mixed growth, per-level gear and percentage passives', gender => {
    const build = { ...content(gender), equipment: { 'plan-main-hand': { ref: gear } }, passives: [{ ref: passive }], calculation: { ...content(gender).calculation!, growthMode: 'manual' as const, growth: [{ classRef: warrior, levels: 30 }, { classRef: wizard, levels: 30 }] } }
    const result = calculatePCStats(build, SUGGESTED_BUILD_SLOTS, resolve)
    expect(result.issues).toEqual([])
    const breakdown = calculateStatBreakdown(build, SUGGESTED_BUILD_SLOTS, resolve)
    for (const stat of STAT_KEYS) {
      const row = breakdown[stat]
      expect(row.base!.low + row.equipment!.low + row.level!.low + row.gender!.low).toBe(row.total!.low)
      expect(row.total!.low).toBe(selectedPCStats(result, gender)[stat])
    }
    expect(breakdown.HP.equipment!.low).toBeGreaterThan(150)
    if (gender === 'male') expect(breakdown.HP.gender).toEqual({ low: 110, high: 110 })
    if (gender === 'female') expect(result.female.ACC).toBeGreaterThan(result.neutral.ACC!)
  })

  it('keeps the level-1 base fixed when level and selected gender change', () => {
    const initial = calculateStatBreakdown(content(undefined, 1), SUGGESTED_BUILD_SLOTS, resolve)
    const leveled = calculateStatBreakdown(content('male'), SUGGESTED_BUILD_SLOTS, resolve)
    for (const stat of STAT_KEYS) {
      expect(initial[stat].level).toEqual({ low: 0, high: 0 })
      expect(leveled[stat].base).toEqual(initial[stat].base)
    }
    expect(leveled.HP.level!.low).toBeGreaterThan(0)
    expect(leveled.HP.gender).toEqual({ low: 100, high: 100 })
    const fixed = content('male')
    const selected = calculateBuildStats(fixed, SUGGESTED_BUILD_SLOTS, resolve)
    expect(selected.stats.HP.value).toEqual(leveled.HP.total)
    const unspecified = calculateBuildStats(content(), SUGGESTED_BUILD_SLOTS, resolve)
    expect(unspecified.stats.HP.value).toEqual({ low: calculatePCStats(content(), SUGGESTED_BUILD_SLOTS, resolve).neutral.HP, high: calculatePCStats(content(), SUGGESTED_BUILD_SLOTS, resolve).neutral.HP })
  })

  it('shows net gender effects after caps and keeps unknown loadout and growth unresolved', () => {
    const capped = ref('synthetic-cap')
    const definition: CatalogEntity = { id: capped.entityId, name: 'Synthetic capped HP', kind: 'passive', aliases: [], sources: [], fields: { 'Crystal Edit source record': { state: 'known', value: { StatMods: [{ Tag: 0, Value1: 12000, Value2: 0 }] } } } }
    const cappedStats = calculateStatBreakdown({ ...content('male'), passives: [{ ref: capped }] }, SUGGESTED_BUILD_SLOTS, value => value.kind === 'catalog' && value.entityId === capped.entityId ? definition : resolve(value))
    expect(cappedStats.HP.total).toEqual({ low: 9999, high: 9999 })
    expect(cappedStats.HP.gender).toEqual({ low: 0, high: 0 })
    const unknown = calculateStatBreakdown(content('male'), SUGGESTED_BUILD_SLOTS, resolve, undefined, ['Off hand is unknown'])
    expect(unknown.HP.base).not.toBeNull()
    expect(unknown.HP.level).not.toBeNull()
    expect(unknown.HP.equipment).toBeNull()
    expect(unknown.HP.gender).toBeNull()
    expect(unknown.HP.total).toBeNull()
    const incomplete = calculateStatBreakdown({ ...content('female'), calculation: { ...content('female').calculation!, growth: [{ classRef: warrior, levels: 59 }] } }, SUGGESTED_BUILD_SLOTS, resolve)
    expect(incomplete.HP.base).not.toBeNull()
    expect(incomplete.HP.level).toBeNull()
    expect(incomplete.HP.total).toBeNull()
  })

  it('evaluates model-less native plans without rewriting inputs and retains unsupported custom assumptions', () => {
    const build = content('female', 20)
    const modelLess = { ...build, calculation: { ...build.calculation!, model: undefined } }
    const before = structuredClone(modelLess)
    expect(calculateBuildStats(modelLess, SUGGESTED_BUILD_SLOTS, resolve)).toEqual(calculateBuildStats(build, SUGGESTED_BUILD_SLOTS, resolve))
    expect(calculateStatBreakdown(modelLess, SUGGESTED_BUILD_SLOTS, resolve)).toEqual(calculateStatBreakdown(build, SUGGESTED_BUILD_SLOTS, resolve))
    const unsupported = { ...modelLess, calculation: { ...modelLess.calculation, bonuses: ['MP' as const] } }
    const estimate = calculateBuildStats(unsupported, SUGGESTED_BUILD_SLOTS, resolve)
    expect(estimate.stats.MP.value).toBeNull()
    expect(estimate.issues).toContain("Custom stat bonuses are not supported by gender comparisons.")
    expect(modelLess).toEqual(before)
    expect(() => validateCalculationPlan({ ...modelLess.calculation, gender: 'invalid' as BuildCalculationPlan['gender'] }, () => undefined)).toThrow('Unsupported calculation gender')
  })
})
