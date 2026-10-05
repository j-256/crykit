import { describe, expect, it } from 'vitest'
import parity from '../calculations/preview-parity-v1.json'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { calculateBuildStats, physicalHitChance, CALCULATED_STATS } from './build-stats'
import { estimateAbility, learningCost } from './ability-estimates'
import { calculateCombat, COMBAT_RULES } from './combat-calculations'
import type { CombatValue } from './combat-expression'
import { defaultCalculation } from './calculation-plan'
import { resolveGameRules } from './game-rules'
import { SUGGESTED_BUILD_SLOTS } from './build-planning'
import type { BuildRevisionContent, CatalogEntity, CatalogRef, EntityId, EntityRef, JsonValue } from './types'

const ref = (id: string): CatalogRef => ({ kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: id as EntityId })
const warrior = ref('base:job:0')
const resolve = (ref: EntityRef) => ref.kind === 'catalog' ? DEFAULT_CATALOG.entities[ref.entityId] : undefined
const content: BuildRevisionContent = { primaryClass: warrior, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: defaultCalculation(warrior) }
const ability = (record?: JsonValue): CatalogEntity => ({ id: 'synthetic-native-ability' as EntityId, kind: 'ability', name: 'Synthetic power', aliases: [], sources: [], fields: record ? { 'Crystal Edit source record': { state: 'known', value: record } } : { Description: { state: 'known', value: 'Damage: 50 + 1.5 Spi' } } })

describe('native preview stages', () => {
  it('matches independent compiled native power and hit vectors', () => {
    for (const vector of parity.cases) expect(calculateCombat(vector.formula, vector.input as CombatValue[]), `${vector.formula}:${JSON.stringify(vector.input)}`).toBe(vector.expected)
    for (const vector of parity.cases.filter(vector => vector.formula === 'physicalHitCurve')) expect(physicalHitChance(vector.input[0] as number, vector.input[1] as number)).toBe(vector.expected)
  })

  it('retains nested power truncation, inherited versus zero scaling, and negative healing', () => {
    for (const [index, vector] of parity.cases.filter(vector => vector.formula === 'abilityPower').entries()) {
      const [attack, coefficients, , user] = vector.input as [number, Record<string, JsonValue>, number, { Stats: Record<string, number> }]
      const mapping = { STR: 'Str', VIT: 'Vit', DEX: 'Dex', AGI: 'Agi', MND: 'Mnd', SPI: 'Spi', SPD: 'Spd', LUK: 'Lck' } as const
      const stats = calculateBuildStats(content, SUGGESTED_BUILD_SLOTS, resolve).stats
      const inputs = { ...stats, ...Object.fromEntries(Object.entries(mapping).map(([key, native]) => [key, { ...stats[key as keyof typeof stats], value: { low: user.Stats[native]!, high: user.Stats[native]! } }])), ATK: { ...stats.ATK, value: { low: index % 2 ? attack + 100 : attack, high: index % 2 ? attack + 100 : attack } }, DEF: { ...stats.DEF, value: { low: attack, high: attack } } }
      const preview = estimateAbility(ability({ ...coefficients, PDefAsPAtk: index % 2 === 1 }), inputs)
      expect(preview.baseAmount).toEqual({ low: vector.expected, high: vector.expected })
    }
    const curveInteriors = [1100, 623, 13].map(value => physicalHitChance(value, 1000))
    expect(curveInteriors.every(value => value !== null)).toBe(true)
    expect(physicalHitChance(0, 0)).toBe(100)
    expect(physicalHitChance(100, 0)).toBe(100)
    for (const invalid of [-1, NaN, Infinity, 87.5, Number.MAX_VALUE]) expect(physicalHitChance(invalid, 100)).toBeNull()
  })

  it('uses native LP display and exact JP affordability at fractional costs', () => {
    for (const [jp, lp, whole] of [[0, 0, 0], [1, 0.01, 1], [99, 0.99, 1], [100, 1, 1], [150, 1.5, 2], [199, 1.99, 2], [200, 2, 2]]) {
      expect(learningCost(jp)).toEqual({ jp, displayedLp: lp, requiredWholeLp: whole })
      expect(calculateCombat('learningEligible', [jp! - 1, jp!])).toBe(false)
      expect(calculateCombat('learningEligible', [jp!, jp!])).toBe(true)
    }
    for (const invalid of [undefined, -1, 1.5, Number.MAX_VALUE]) expect(learningCost(invalid)).toBeNull()
    const coefficients = parity.cases.find(vector => vector.formula === 'abilityPower')!.input[1] as unknown as Record<string, JsonValue>
    const preview = estimateAbility(ability({ ...coefficients, PDefAsPAtk: false, JP: 150, HPCost: 10, MPCost: 0, APCost: 6, CTCost: 10, CDCost: 1 }), calculateBuildStats(content, SUGGESTED_BUILD_SLOTS, resolve).stats)
    expect(preview.costs).toEqual({ HP: 10, MP: 0, AP: 6, CT: 10, CD: 1 })
    expect(preview.learning).toEqual({ jp: 150, displayedLp: 1.5, requiredWholeLp: 2 })
  })

  it('keeps unsupported platforms and versions unresolved rather than asserting parity', () => {
    for (const context of [{ platform: { state: 'known' as const, value: 'Nintendo Switch' } }, { gameVersion: { state: 'known' as const, value: '1.7.0' } }]) {
      const rules = resolveGameRules(context, [])
      const result = calculateBuildStats(content, SUGGESTED_BUILD_SLOTS, resolve, undefined, rules)
      expect(result.issues.length).toBeGreaterThan(0)
      expect(result.stats.HP.value).toBeNull()
    }
  })

  it.each(['1.6.6', '1.6.6.0'])('treats PC %s as compatible with the native rules under the planning assumption', version => {
    const rules = resolveGameRules({ platform: { state: 'known', value: 'Windows' }, gameVersion: { state: 'known', value: version } }, [])
    const result = calculateBuildStats(content, SUGGESTED_BUILD_SLOTS, resolve, undefined, rules)
    const baseline = calculateBuildStats(content, SUGGESTED_BUILD_SLOTS, resolve)
    expect(rules.issues).toEqual([])
    expect(result.issues).toEqual([])
    expect(result.stats.HP.value).toEqual({ low: 1244, high: 1244 })
    expect(result.stats).toEqual(baseline.stats)
  })

  it('keeps overflowing imported modifiers unknown before caps can fabricate totals', () => {
    const imported = ref('synthetic-overflowing-equipment')
    const equipped = { ...content, equipment: { 'plan-main-hand': { ref: imported } } }
    for (const values of [[2_147_483_647, 1], [2_147_483_647, 1, -2_147_483_647]]) {
      const raw = ability({ ID: 9000, EquipmentType: 0, StatMods: values.map(Value1 => ({ Tag: 0, Value1 })) })
      const result = calculateBuildStats(equipped, SUGGESTED_BUILD_SLOTS, selected => selected.kind === 'catalog' && selected.entityId === imported.entityId ? { ...raw, kind: 'item' } : resolve(selected))
      expect(result.stats.HP.value).toBeNull()
      expect(result.issues).toContain('Synthetic power: Flat_HP has an unavailable numeric input.')
    }
    expect(() => calculateCombat('abilityPower', [2_147_483_647, { BasePower: 0, BasePAtkRate: 200, ScalingPower: null, ScalingPAtkRate: null, StrRate: 0, VitRate: 0, DexRate: 0, AgiRate: 0, MndRate: 0, SpiRate: 0, SpdRate: 0, LckRate: 0 }, 0, { Stats: { Str: 1, Vit: 1, Dex: 1, Agi: 1, Mnd: 1, Spi: 1, Spd: 1, Lck: 1 } }])).toThrow(/signed integer range/)
  })

  it('leaves source text and invalid numeric records inert and keeps unknown loadout context unresolved', () => {
    const stats = calculateBuildStats(content, SUGGESTED_BUILD_SLOTS, resolve).stats
    expect(estimateAbility(ability(), stats).baseAmount).toBeNull()
    expect(estimateAbility(ability({ BasePower: Number.MAX_VALUE, JP: 1.5 }), stats).learning).toBeNull()
    const original = structuredClone(content)
    const unknown = calculateBuildStats(content, SUGGESTED_BUILD_SLOTS, resolve, undefined, undefined, ['Off hand is unknown'])
    for (const stat of CALCULATED_STATS) expect(unknown.stats[stat].value).toBeNull()
    expect(content).toEqual(original)
    expect(COMBAT_RULES.formulas.abilityPower.evidence).toContain('Sang.Battle.Calculator.CalculateBaseAttack')
  })
})
