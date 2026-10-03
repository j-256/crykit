import { describe, expect, it } from 'vitest'
import parity from '../calculations/pc-parity-v1.json'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { calculateFormula, calculationPackage, evaluateExpression, PC_RULES } from './calculation-rules'
import { calculatePCStats, nativeStatRecord } from './pc-stats'
import { changeCalculationLevel, changeGrowthLevels, defaultCalculation, followPrimary, growthAllowance } from './calculation-plan'
import { SUGGESTED_BUILD_SLOTS } from './build-planning'
import { previewImport } from '../interchange/import'
import { addTestDefinition, createTestLocalData, personalRef } from './test-helpers'
import type { BuildRevisionContent, CatalogEntity, CatalogRef, EntityId, EntityRef } from './types'

const ref = (id: string): CatalogRef => ({ kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: id as EntityId })
const warrior = ref('base:job:0')
const wizard = ref('base:job:3')
const resolve = (value: EntityRef) => value.kind === 'catalog' ? DEFAULT_CATALOG.entities[value.entityId] : undefined
const content = (primary = warrior): BuildRevisionContent => ({ primaryClass: primary, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: defaultCalculation(primary) })

describe('versioned arithmetic package', () => {
  it('matches compiled, unchanged decompiled methods at rounding, truncation, cap and defense boundaries', () => {
    for (const fixture of parity.cases) expect(calculateFormula(fixture.formula, fixture.input), JSON.stringify(fixture)).toBe(fixture.expected)
  })
  it('rejects missing, nonfinite, executable and excessive expressions and evaluates conditions lazily', () => {
    expect(evaluateExpression(['if', 1, 5, ['div', 1, 0]], {})).toBe(5)
    expect(calculateFormula('memberCore', [3, 50, 150, 0])).toBe(18)
    expect(evaluateExpression(['roundEven', 2.5], {})).toBe(2)
    expect(evaluateExpression(['roundEven', -3.5], {})).toBe(-4)
    for (const expression of ['constructor', ['eval', 'alert(1)'], ['div', 1, 0], ['pow', -1, 0.5], ['call', 'missing'], ['add', 1]]) expect(() => evaluateExpression(expression, {})).toThrow()
    let deep: import('./calculation-rules').Expression = 0
    for (let index = 0; index < PC_RULES.limits.expressionDepth + 1; index++) deep = ['add', 0, deep]
    expect(() => evaluateExpression(deep, {})).toThrow('limit')
    expect(() => evaluateExpression('x', { x: Infinity })).toThrow('finite')
    const exported = JSON.parse(JSON.stringify(calculationPackage()))
    expect(exported.rules.id).toBe(exported.data.engine)
    expect(exported.rules.formulas.memberHP.evidence).toContain('CalculateMemberHP')
    expect(exported.rules.sheetStages).toEqual(PC_RULES.sheetStages)
  })
})

describe('growth input intent', () => {
  it('follows primary class and level until edited, then retains allocations including an over-budget level change', () => {
    expect(followPrimary(undefined, warrior)).toBeUndefined()
    const automatic = followPrimary(defaultCalculation(warrior), wizard)
    expect(automatic.growth).toEqual([{ classRef: wizard, levels: 60 }])
    expect(changeCalculationLevel(automatic, 30, wizard).growth[0]?.levels).toBe(30)
    const manual = changeGrowthLevels(automatic, 0, 45)
    expect(manual.growthMode).toBe('manual')
    expect(followPrimary(manual, warrior).growth).toEqual(manual.growth)
    expect(changeCalculationLevel(manual, 30, warrior).growth).toEqual(manual.growth)
    expect(changeGrowthLevels(changeCalculationLevel(manual, 30, warrior), 0, 44).growth[0]?.levels).toBe(44)
    expect(followPrimary({ ...manual, growthMode: undefined }, warrior).growth).toEqual(manual.growth)
  })
  it('bounds increments and fixed-scale slider values by the remaining shared allowance', () => {
    const plan = { ...defaultCalculation(warrior), growthMode: 'manual' as const, growth: [{ classRef: warrior, levels: 45 }, { classRef: wizard, levels: 10 }] }
    expect(growthAllowance(plan, 1)).toBe(15)
    expect(changeGrowthLevels(plan, 1, 60).growth[1]?.levels).toBe(15)
    expect(changeGrowthLevels(plan, 1, -10).growth[1]?.levels).toBe(0)
    expect(changeGrowthLevels(plan, 1, null).growth[1]?.levels).toBeNull()
  })
})

describe('native sheet calculations', () => {
  it('uses native identities and weighted history, with separate gender totals and derived differences', () => {
    const estimate = calculatePCStats(content(), SUGGESTED_BUILD_SLOTS, resolve)
    expect(estimate.issues).toEqual([])
    expect(estimate.neutral.HP).toBeGreaterThan(0)
    expect(estimate.male.HP! - estimate.neutral.HP!).toBe(100)
    expect(estimate.female.MP! - estimate.neutral.MP!).toBeGreaterThan(0)
    expect(estimate.female.ACC! - estimate.neutral.ACC!).toBe(14)
    expect(estimate.female.TT).toBeLessThan(estimate.neutral.TT!)
    const mixed = content()
    const changed = calculatePCStats({ ...mixed, calculation: { ...mixed.calculation!, growthMode: 'manual', growth: [{ classRef: warrior, levels: 30 }, { classRef: wizard, levels: 30 }] } }, SUGGESTED_BUILD_SLOTS, resolve)
    expect(changed.issues).toEqual([])
    expect(changed.neutral.STR).not.toBe(estimate.neutral.STR)
    expect(changed.neutral.MND).not.toBe(estimate.neutral.MND)
    const foreign = { ...warrior, catalogId: 'unrelated' as CatalogRef['catalogId'] }
    expect(nativeStatRecord(foreign, 'job', () => undefined)).toBeUndefined()
    expect(nativeStatRecord(ref('base:passive:6'), 'passive', resolve)?.Name).toBe('Equip Sword')
    expect(calculatePCStats({ ...content(ref('base:job:4')), passives: [{ ref: ref('base:passive:6') }] }, SUGGESTED_BUILD_SLOTS, resolve).issues).toEqual([])
  })
  it('keeps totals unresolved for incomplete growth, unknown observations and absent numeric identities', () => {
    const original = content()
    expect(calculatePCStats({ ...original, calculation: { ...original.calculation!, growth: [{ classRef: warrior, levels: 59 }] } }, SUGGESTED_BUILD_SLOTS, resolve).neutral.HP).toBeNull()
    expect(calculatePCStats(original, SUGGESTED_BUILD_SLOTS, resolve, ['Off hand is unknown']).neutral.HP).toBeNull()
    const missing = ref('synthetic-unmapped-item')
    const estimate = calculatePCStats({ ...original, equipment: { 'plan-main-hand': { ref: missing } } }, SUGGESTED_BUILD_SLOTS, resolve)
    expect(estimate.neutral.HP).toBeNull()
    expect(estimate.base.HP).toBeGreaterThan(0)
  })
  it('honors explicit numeric overrides without treating their export-local IDs as native identities', () => {
    const job = nativeStatRecord(warrior, 'job', resolve)!
    const original = resolve(warrior)!
    const edited: CatalogEntity = { ...original, fields: { ...original.fields, 'Crystal Edit source record': { state: 'known', value: { ...job, HPRating: 10, PassiveIDs: [] } as import('./types').JsonValue } } }
    const resolver = (value: EntityRef) => value.kind === 'catalog' && value.entityId === warrior.entityId ? edited : resolve(value)
    const estimate = calculatePCStats(content(), SUGGESTED_BUILD_SLOTS, resolver)
    expect(estimate.issues).toEqual([])
    expect(estimate.neutral.HP).toBe(calculateFormula('memberHP', [60, 10, 600, 0]))
  })
  it('resolves imported innates by exact model mapping, including personal class revisions', async () => {
    const imported = await previewImport(new TextEncoder().encode(JSON.stringify({ ID: 'stat-fixture', EditorVersion: 34, Jobs: [{ ...nativeStatRecord(warrior, 'job', resolve), ID: 40, Name: 'Imported fighter', PassiveIDs: [8] }], Passives: [{ ID: 8, Name: 'Imported vitality', IsInnate: true, StatMods: [{ Tag: 0, Value1: 100, Value2: 0 }] }] })), 'fixture.json')
    const catalog = imported.proposed.catalogs[0]!
    const primary: CatalogRef = { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: 'mod:stat-fixture:class:40' as EntityId }
    const passive = catalog.entities['mod:stat-fixture:passive:8']!
    const resolver = (value: EntityRef) => value.kind === 'catalog' && value.catalogId === catalog.id ? catalog.entities[value.entityId] : resolve(value)
    const estimate = calculatePCStats(content(primary), SUGGESTED_BUILD_SLOTS, resolver)
    const without = calculatePCStats(content(primary), SUGGESTED_BUILD_SLOTS, value => value.kind === 'catalog' && value.entityId === passive.id ? { ...passive, fields: { ...passive.fields, 'Crystal Edit source record': { state: 'known', value: { ID: 8, IsInnate: false } } } } : resolver(value))
    expect(estimate.issues).toEqual([])
    expect(estimate.neutral.HP).toBe(without.neutral.HP! + 100)
    const local = addTestDefinition(createTestLocalData(), 'personal-import', { kind: 'class' })
    const personal = { ...local.personalDefinitions['personal-import']!, baseRef: primary, fields: catalog.entities[primary.entityId]!.fields }
    const plan = content(primary)
    const edited = calculatePCStats({ ...plan, primaryClass: personalRef('personal-import') }, SUGGESTED_BUILD_SLOTS, value => value.kind === 'personal' ? personal : resolver(value))
    expect(edited).toEqual(estimate)
  })
  it('applies integer flat-before-percent, per-level scaling, caps, and post-percentage Two-Handed bonuses', () => {
    const item = ref('synthetic-native-item'), passive = ref('synthetic-native-passive')
    const records = new Map<string, CatalogEntity>([
      [item.entityId, { id: item.entityId, kind: 'item', aliases: [], name: 'Synthetic weapon', fields: { 'Crystal Edit source record': { state: 'known', value: { ID: 9000, EquipmentType: 0, IsTwoHanded: false, StatMods: [{ Tag: 40, Value1: 101, Value2: 0 }, { Tag: 100, Value1: 5, Value2: 2 }] } } }, sources: [] }],
      [passive.entityId, { id: passive.entityId, kind: 'passive', aliases: [], name: 'Synthetic bonuses', fields: { 'Crystal Edit source record': { state: 'known', value: { StatMods: [{ Tag: 60, Value1: 25, Value2: 0 }, { Tag: 20, Value1: 10, Value2: 0 }, { Tag: 510, Value1: 0, Value2: 0 }] } } }, sources: [] }],
    ])
    const resolver = (value: EntityRef) => value.kind === 'catalog' ? records.get(value.entityId) ?? resolve(value) : undefined
    const original = content()
    const estimate = calculatePCStats({ ...original, equipment: { 'plan-main-hand': { ref: item } }, passives: [{ ref: passive }] }, SUGGESTED_BUILD_SLOTS, resolver)
    expect(estimate.issues).toEqual([])
    expect(estimate.neutral.ATK).toBe(176)
    const hp = estimate.base.HP! + 150
    expect(estimate.neutral.HP).toBe(hp + Math.trunc(hp * 10 / 100))
    expect(estimate.male.HP! - estimate.neutral.HP!).toBe(110)
  })
  it('counts a shared physical two-handed weapon once', () => {
    const item = ref('synthetic-two-handed')
    const record: CatalogEntity = { id: item.entityId, name: 'Synthetic two-handed weapon', kind: 'item', aliases: [], sources: [], fields: { 'Crystal Edit source record': { state: 'known', value: { ID: 9001, EquipmentType: 8, IsTwoHanded: true, StatMods: [{ Tag: 40, Value1: 100, Value2: 0 }] } } } }
    const selection = { ref: item, allocationId: 'shared' }
    const result = calculatePCStats({ ...content(), equipment: { 'plan-main-hand': selection, 'plan-off-hand': selection } }, SUGGESTED_BUILD_SLOTS, value => value.kind === 'catalog' && value.entityId === item.entityId ? record : resolve(value))
    expect(result.neutral.ATK).toBe(100)
  })
  it('applies unarmed Strength before percentages and Dual Wield after derived Attack, and enforces resource caps', () => {
    const passive = ref('synthetic-cap-passive')
    const record: CatalogEntity = { id: passive.entityId, aliases: [], name: 'Synthetic capacity and unarmed effects', kind: 'passive', sources: [], fields: { 'Crystal Edit source record': { state: 'known', value: { StatMods: [{ Tag: 0, Value1: 12000, Value2: 0 }, { Tag: 1, Value1: 5000, Value2: 0 }, { Tag: 2, Value1: 1000, Value2: 0 }, { Tag: 474, Value1: 0, Value2: 0 }, { Tag: 505, Value1: 0, Value2: 0 }, { Tag: 511, Value1: 0, Value2: 0 }, { Tag: 26, Value1: 10, Value2: 0 }, { Tag: 61, Value1: 100, Value2: 0 }] } } } }
    const result = calculatePCStats({ ...content(), passives: [{ ref: passive }] }, SUGGESTED_BUILD_SLOTS, value => value.kind === 'catalog' && value.entityId === passive.entityId ? record : resolve(value))
    expect(result.issues).toEqual([])
    expect(result.neutral).toMatchObject({ HP: 9999, MP: 999, AP: 99, STR: 275, ATK: 286, PPEN: 94 })
  })
  it('requires an unknown sub-command only when inherited innates affect the sheet', () => {
    expect(calculatePCStats(content(), SUGGESTED_BUILD_SLOTS, resolve, [], true).issues).toEqual([])
    const mimic = calculatePCStats(content(ref('base:job:22')), SUGGESTED_BUILD_SLOTS, resolve, [], true)
    expect(mimic.neutral.HP).toBeNull()
    expect(mimic.issues).toContain('Secondary class is unknown and its innates affect this loadout.')
  })
})
