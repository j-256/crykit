import parity from '../calculations/modifier-parity-v1.json'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { PC_RULES } from './calculation-rules'
import { aggregateStatModifiers, collectEffectiveModifiers, NATIVE_MODIFIER_DEFAULTS, type EffectiveModifierRecord } from './effective-modifiers'
import { calculatePCStats } from './pc-stats'
import { defaultCalculation } from './calculation-plan'
import { SUGGESTED_BUILD_SLOTS } from './build-planning'
import type { BattleCalculationPlan, BuildRevisionContent, CatalogEntity, CatalogRef, EntityId, EntityRef, JsonValue } from './types'

const tag = (name: string, Value1: number, Value2 = 0, Value3 = 0) => ({ Tag: Number(Object.entries(PC_RULES.statMods).find(([, value]) => value.name === name)![0]), Value1, Value2, Value3 })
const source = (mods: readonly object[], group: EffectiveModifierRecord['group'] = 'equipment'): EffectiveModifierRecord => ({ record: { StatMods: mods }, group, label: group })
const ref = (id: string): CatalogRef => ({ kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: id as EntityId })
const warrior = ref('base:job:0')
const content = (): BuildRevisionContent => ({ primaryClass: warrior, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: defaultCalculation(warrior) })
const battle = (overrides: Partial<BattleCalculationPlan> = {}): BattleCalculationPlan => ({ version: 1, turnCount: 0, targetTurnCount: 0, automaticStatuses: false, statuses: [], user: { hp: 100, mp: null, ap: null }, target: null, targetResources: { hp: null, mp: null, ap: null }, targetStatuses: [], repeatCount: null, bottomThreat: null, topThreat: null, targetIsThreatTarget: null, targetCharging: null, previouslyAppliedStatuses: [], userPreviouslyAppliedStatuses: [], ...overrides })
const entity = (id: string, kind: CatalogEntity['kind'], record: object): CatalogEntity => ({ id: id as EntityId, kind, name: id, aliases: [], sources: [], fields: { 'Crystal Edit source record': { state: 'known', value: record as JsonValue } } })
const resolver = (...entities: CatalogEntity[]) => (value: EntityRef) => value.kind === 'catalog' ? entities.find(item => item.id === value.entityId) ?? DEFAULT_CATALOG.entities[value.entityId] : undefined

describe('effective native modifiers', () => {
  it('matches unchanged compiled native methods for every scalar operation and grouped numeric lists', () => {
    for (const fixture of parity.cases) {
      const result = aggregateStatModifiers(fixture.records as readonly EffectiveModifierRecord[], fixture.level, fixture.turnCount)
      expect(result.stats, fixture.name).toEqual({ ...NATIVE_MODIFIER_DEFAULTS, ...fixture.expected.stats })
      expect([...result.tags], fixture.name).toEqual(fixture.expected.tags)
      for (const key of ['physicalElements', 'statusImmunities', 'statusImmunityCategories', 'abilityDamage', 'abilityMP', 'abilityAP', 'elementGiven', 'elementTaken'] as const) expect(result[key], `${fixture.name} ${key}`).toEqual(fixture.expected[key])
      expect(result.automaticStatuses.map(({ id, chance, count }) => ({ id, chance, count })), fixture.name).toEqual(fixture.expected.automaticStatuses)
      expect(result.physicalStatuses.map(({ id, chance, count }) => ({ id, chance, count })), fixture.name).toEqual(fixture.expected.physicalStatuses)
      expect(result.issues, fixture.name).toEqual([])
    }
  })
  it('uses native neutral defaults and merges separately truncated source groups', () => {
    expect(NATIVE_MODIFIER_DEFAULTS.MPCostsMult).toBe(100)
    expect(NATIVE_MODIFIER_DEFAULTS.MPCostsFlat).toBe(0)
    expect(NATIVE_MODIFIER_DEFAULTS.MaxDamageGiven).toBeNull()
    const result = aggregateStatModifiers([
      source([tag('Mult_PDmg_Given_100', 150), tag('Mult_PDmg_Given_100', 151)]),
      source([tag('Mult_PDmg_Given_100', 153), tag('Mult_PDmg_Given_100', 153)], 'passive'),
    ], 60)
    expect(result.stats.PDmgGivenMult).toBe(528)
    expect(result.issues).toEqual([])
  })
  it('combines ability and element modifiers across equipment, passives, and statuses', () => {
    const result = aggregateStatModifiers([
      source([tag('Flat_AbilityMPCost', 201, -5), tag('Mult_AbilityDmg', 201, 50), tag('Mult_ElementDmg_Given', 2, 50)]),
      source([tag('Flat_AbilityMPCost', 201, -2), tag('Mult_AbilityDmg', 201, 25)], 'passive'),
      source([tag('Mult_MPCosts', -50), tag('Mult_ElementDmg_Given', 2, 25), tag('Flat_DamagePerTurnHP', -20), tag('Addi_DamagePerTurnHP', -5)], 'status'),
    ], 60)
    expect(result.abilityMP[201]).toBe(-7)
    expect(result.abilityDamage[201]).toBe(187)
    expect(result.elementGiven[2]).toBe(187)
    expect(result.stats).toMatchObject({ MPCostsMult: 50, DamagePerTurnHPFlat: -20, DamagePerTurnHPAddi: -5 })
  })
  it('isolates missing per-turn inputs, unknown ability values, and native overflow', () => {
    const result = aggregateStatModifiers([source([tag('Flat_HP_PerLevel', 10, 2), tag('Flat_PAtk_PerTurn', 10, 5), tag('Flat_MPCosts', -5)])], 60, null)
    expect(result.stats.HP).toBe(300)
    expect(result.stats.MPCostsFlat).toBe(-5)
    expect(result.stats.PAtk).toBeNull()
    expect([...result.unknownFields]).toEqual(['PAtk'])
    const overflow = aggregateStatModifiers([source([tag('Flat_HP', 2147483647), tag('Flat_HP', 1), tag('Flat_MPCosts', -5)])], 60)
    expect(overflow.stats.HP).toBeNull()
    expect(overflow.stats.MPCostsFlat).toBe(-5)
    expect(overflow.issues.join(' ')).toContain('Flat_HP')
  })
  it('retains resource-return attributes and nullable damage caps', () => {
    const result = aggregateStatModifiers([source([tag('Addi_HealingReturn', 6, 25), tag('Addi_PDmgReturn_OnKill', 1, 30), tag('MaxDamageGiven', 100), tag('MaxBuffCount', 2)]), source([tag('MaxDamageGiven', 50), tag('MaxBuffCount', 3)], 'status')], 60)
    expect(result.stats).toMatchObject({ HealingReturnAddi: 25, PDmgMPReturnOnKillAddi: 30, MaxDamageGiven: 50, MaxBuffCount: 5 })
  })
  it('counts shared copies once and doubles both matching paired equipment effects', () => {
    const weapon = entity('synthetic-paired', 'item', { ID: 5000, EquipmentType: 0, StatMods: [tag('Flat_MPCosts', -2), tag('BonusDoubledWhenPaired', 0)] })
    const selected = { ref: ref(weapon.id) }
    const build = { ...content(), equipment: { 'plan-main-hand': selected, 'plan-off-hand': selected } }
    expect(collectEffectiveModifiers(build, SUGGESTED_BUILD_SLOTS, resolver(weapon)).stats.MPCostsFlat).toBe(-8)
    const shared = { ...selected, allocationId: 'shared-copy' }
    expect(collectEffectiveModifiers({ ...build, equipment: { 'plan-main-hand': shared, 'plan-off-hand': shared } }, SUGGESTED_BUILD_SLOTS, resolver(weapon)).stats.MPCostsFlat).toBe(-2)
  })
})

describe('explicit battle stat snapshots', () => {
  const statusId = 9000
  const status = entity(`crystal-edit:Statuses:${statusId}`, 'status', { ID: statusId, Name: 'Synthetic focus', Category: 1, PersistsThroughDeath: false, ReApplyResistance: false, StatMods: [tag('Flat_HP', 100), tag('Mult_MPCosts', -50)] })
  const auto = (chance = 100, count = 255) => entity('synthetic-auto', 'passive', { StatMods: [tag('StatusAuto', statusId, chance, count)] })
  it('keeps resting totals available and applies selected or guaranteed automatic statuses only in an explicit snapshot', () => {
    const original = content()
    const build = { ...original, passives: [{ ref: ref('synthetic-auto') }] }
    const resolve = resolver(auto(), status)
    const resting = calculatePCStats(build, SUGGESTED_BUILD_SLOTS, resolve)
    expect(resting.issues).toEqual([])
    expect(resting.neutral.HP).toBeGreaterThan(0)
    expect(resting.effects.join(' ')).toContain('excluded from resting stats')
    const snapshot = { ...build, calculation: { ...build.calculation!, battle: battle({ automaticStatuses: true }) } }
    expect(calculatePCStats(snapshot, SUGGESTED_BUILD_SLOTS, resolve).neutral.HP).toBe(resting.neutral.HP! + 100)
    const selected = { ...original, calculation: { ...original.calculation!, battle: battle({ statuses: [{ ref: ref(status.id), count: 3 }] }) } }
    expect(calculatePCStats(selected, SUGGESTED_BUILD_SLOTS, resolve).neutral.HP).toBe(resting.neutral.HP! + 100)
  })
  it('preserves independently calculable values for uncertain automatic statuses', () => {
    const build = { ...content(), passives: [{ ref: ref('synthetic-auto') }] }
    const result = collectEffectiveModifiers(build, SUGGESTED_BUILD_SLOTS, resolver(auto(50), status), { turnCount: 0, includeAutomaticStatuses: true, currentHP: 100 })
    expect(result.stats.HP).toBeNull()
    expect(result.stats.MPCostsMult).toBeNull()
    expect(result.stats.Str).toBe(0)
    expect(result.automaticStatuses[0]?.applied).not.toBe(true)
    const snapshot = { ...build, calculation: { ...build.calculation!, battle: battle({ automaticStatuses: true }) } }
    const sheet = calculatePCStats(snapshot, SUGGESTED_BUILD_SLOTS, resolver(auto(50), status))
    expect(sheet.neutral.HP).toBeNull()
    expect(sheet.neutral.STR).toBeGreaterThan(0)
    const explicit = collectEffectiveModifiers(build, SUGGESTED_BUILD_SLOTS, resolver(auto(50), status), { turnCount: 2, includeAutomaticStatuses: true, statuses: [ref(status.id)], currentHP: 100 })
    expect(explicit.stats.HP).toBe(100)
    expect(explicit.stats.MPCostsMult).toBe(50)
  })
  it('honors automatic immunity, failure, permanent counts, and application history', () => {
    const immune = entity('synthetic-immunity', 'passive', { StatMods: [tag('StatusImmunity', statusId)] })
    const build = { ...content(), passives: [{ ref: ref('synthetic-auto') }, { ref: ref(immune.id) }] }
    expect(collectEffectiveModifiers(build, SUGGESTED_BUILD_SLOTS, resolver(auto(), status, immune), { includeAutomaticStatuses: true, currentHP: 100 }).stats.HP).toBe(0)
    const withoutImmunity = { ...build, passives: [{ ref: ref('synthetic-auto') }] }
    expect(collectEffectiveModifiers(withoutImmunity, SUGGESTED_BUILD_SLOTS, resolver(auto(0), status), { includeAutomaticStatuses: true, currentHP: 100 }).stats.HP).toBe(0)
    expect(collectEffectiveModifiers(withoutImmunity, SUGGESTED_BUILD_SLOTS, resolver(auto(100, 2), status), { includeAutomaticStatuses: true, turnCount: 2, currentHP: 100 }).stats.HP).toBeNull()
    expect(collectEffectiveModifiers(withoutImmunity, SUGGESTED_BUILD_SLOTS, resolver(auto(), status), { includeAutomaticStatuses: true, turnCount: 2, currentHP: 100 }).stats.HP).toBe(100)
    expect(collectEffectiveModifiers(withoutImmunity, SUGGESTED_BUILD_SLOTS, resolver(auto(), status), { includeAutomaticStatuses: true, currentHP: 0 }).stats.HP).toBe(0)
  })
  it('propagates uncertain automatic immunity only to statuses it could prevent', () => {
    const immunityId = statusId + 1
    for (const modifier of [tag('StatusImmunity', statusId), tag('ImmuneToStatusCategory', 1)]) {
      const immune = entity(`crystal-edit:Statuses:${immunityId}`, 'status', { ID: immunityId, Name: 'Conditional immunity', Category: 1, PersistsThroughDeath: false, StatMods: [modifier] })
      const passive = entity('synthetic-auto', 'passive', { StatMods: [tag('StatusAuto', immunityId, 50, 255), tag('StatusAuto', statusId, 100, 255)] })
      const build = { ...content(), passives: [{ ref: ref(passive.id) }] }
      const result = collectEffectiveModifiers(build, SUGGESTED_BUILD_SLOTS, resolver(passive, immune, status), { includeAutomaticStatuses: true, currentHP: 100 })
      expect(result.stats.HP).toBeNull()
      expect(result.stats.MPCostsMult).toBeNull()
      expect(result.stats.Str).toBe(0)
      expect(result.automaticStatuses.find(value => value.id === statusId)?.uncertain).toBe(true)
      const selected = collectEffectiveModifiers(build, SUGGESTED_BUILD_SLOTS, resolver(passive, immune, status), { includeAutomaticStatuses: true, currentHP: 100, statuses: [ref(status.id)] })
      expect(selected.stats.HP).toBe(100)
    }
  })
  it('collapses duplicate automatic presence while preserving uncertain or accumulated counts', () => {
    for (const counts of [[255, 255], [2, 3]] as const) {
      const passive = entity('synthetic-auto', 'passive', { StatMods: [tag('StatusAuto', statusId, 50, counts[0]), tag('StatusAuto', statusId, 100, counts[1])] })
      const build = { ...content(), passives: [{ ref: ref(passive.id) }] }
      const result = collectEffectiveModifiers(build, SUGGESTED_BUILD_SLOTS, resolver(passive, status), { includeAutomaticStatuses: true, currentHP: 100 })
      expect(result.stats.HP).toBe(100)
      expect(result.automaticStatuses.some(value => value.uncertain)).toBe(false)
      expect(result.automaticStatuses.find(value => value.applied)?.countUncertain).toBe(counts[1] !== 255)
      expect(result.issues).toEqual([])
    }
    const passive = entity('synthetic-auto', 'passive', { StatMods: [tag('StatusAuto', statusId, 100, 2), tag('StatusAuto', statusId, 100, 3)] })
    const build = { ...content(), passives: [{ ref: ref(passive.id) }] }
    const result = collectEffectiveModifiers(build, SUGGESTED_BUILD_SLOTS, resolver(passive, status), { includeAutomaticStatuses: true, currentHP: 100 })
    expect(result.stats.HP).toBe(100)
    expect(result.automaticStatuses.find(value => value.applied)?.count).toBe(5)
    expect(result.automaticStatuses.filter(value => value.applied)).toHaveLength(1)
  })
  it('applies native duration modifiers once before adding duplicate raw counts', () => {
    const passive = entity('synthetic-auto', 'passive', { StatMods: [tag('Flat_BuffDuration', 2), tag('Flat_ApplyBuffDuration', 1), tag('Addi_BuffDuration', 50), tag('StatusAuto', statusId, 100, 3), tag('StatusAuto', statusId, 100, 2)] })
    const build = { ...content(), passives: [{ ref: ref(passive.id) }] }
    const result = collectEffectiveModifiers(build, SUGGESTED_BUILD_SLOTS, resolver(passive, status), { includeAutomaticStatuses: true, currentHP: 100 })
    expect(result.automaticStatuses.find(value => value.applied)?.count).toBe(11)
    expect(result.automaticStatuses.find(value => value.applied)?.countUncertain).toBe(false)
    const permanent = entity(passive.id, 'passive', { StatMods: [tag('AppliedBuffsArePerma', 0), tag('StatusAuto', statusId, 100, 3)] })
    const later = collectEffectiveModifiers(build, SUGGESTED_BUILD_SLOTS, resolver(permanent, status), { includeAutomaticStatuses: true, currentHP: 100, turnCount: 2 })
    expect(later.stats.HP).toBe(100)
    expect(later.automaticStatuses.find(value => value.applied)?.count).toBe(255)
  })
  it('keeps relevant unresolved status application history and category immunity unknown', () => {
    const resistant = entity(status.id, 'status', { ID: statusId, Name: 'Resistant status', Category: 1, PersistsThroughDeath: false, ReApplyResistance: true, StatMods: [tag('Flat_HP', 100)] })
    const build = { ...content(), passives: [{ ref: ref('synthetic-auto') }] }
    const options = { includeAutomaticStatuses: true, currentHP: 100, previouslyAppliedStatuses: [ref('unresolved-history')] }
    expect(collectEffectiveModifiers(build, SUGGESTED_BUILD_SLOTS, resolver(auto(), resistant), options).stats.HP).toBeNull()
    expect(collectEffectiveModifiers(build, SUGGESTED_BUILD_SLOTS, resolver(auto(), status), options).stats.HP).toBe(100)
    const categoryUnknown = entity(status.id, 'status', { ID: statusId, PersistsThroughDeath: false, StatMods: [tag('Flat_HP', 100)] })
    const immune = entity('synthetic-category-immunity', 'passive', { StatMods: [tag('ImmuneToStatusCategory', 1)] })
    const withImmunity = { ...build, passives: [...build.passives, { ref: ref(immune.id) }] }
    expect(collectEffectiveModifiers(withImmunity, SUGGESTED_BUILD_SLOTS, resolver(auto(), categoryUnknown, immune), { includeAutomaticStatuses: true, currentHP: 100 }).stats.HP).toBeNull()
  })
  it('leaves chained automatic applications unresolved only for their dependent effects', () => {
    const chained = entity(`crystal-edit:Statuses:${statusId}`, 'status', { ID: statusId, Name: 'Chained automatic status', Category: 1, PersistsThroughDeath: false, StatMods: [tag('SetStatusOnApply', 9001, 3)] })
    const target = entity('crystal-edit:Statuses:9001', 'status', { ID: 9001, Name: 'Chained target', StatMods: [tag('Flat_MP', 50)] })
    const build = { ...content(), passives: [{ ref: ref('synthetic-auto') }] }
    const unresolved = collectEffectiveModifiers(build, SUGGESTED_BUILD_SLOTS, resolver(auto(), chained, target), { includeAutomaticStatuses: true, currentHP: 100 })
    expect(unresolved.stats.MP).toBeNull()
    expect(unresolved.stats.HP).toBe(0)
    expect(unresolved.automaticStatuses.find(status => status.id === 9001)?.uncertain).toBe(true)
    const selected = collectEffectiveModifiers(build, SUGGESTED_BUILD_SLOTS, resolver(auto(), chained, target), { includeAutomaticStatuses: true, currentHP: 100, statuses: [ref(target.id)] })
    expect(selected.stats.MP).toBe(50)
  })
  it('retains uncertain status presence even when that status has no numeric modifiers', () => {
    const emptyStatus = entity(status.id, 'status', { ID: statusId, StatMods: [] })
    const result = collectEffectiveModifiers({ ...content(), passives: [{ ref: ref('synthetic-auto') }] }, SUGGESTED_BUILD_SLOTS, resolver(auto(50), emptyStatus), { includeAutomaticStatuses: true, currentHP: 100 })
    expect(result.stats.HP).toBe(0)
    expect(result.automaticStatuses[0]?.uncertain).toBe(true)
  })
  it('does not reinterpret legacy status selections, and empty automatic status modifiers do not hide stats', () => {
    const original = content()
    const legacy = { ...original, calculation: { ...original.calculation!, statuses: [ref(status.id)] } }
    expect(calculatePCStats(legacy, SUGGESTED_BUILD_SLOTS, resolver(status)).issues.join(' ')).toContain('explicit adoption')
    const emptyStatus = entity(status.id, 'status', { ID: statusId, StatMods: [] })
    const build = { ...content(), passives: [{ ref: ref('synthetic-auto') }] }
    expect(calculatePCStats(build, SUGGESTED_BUILD_SLOTS, resolver(auto(), emptyStatus)).neutral.HP).toBeGreaterThan(0)
  })
})
