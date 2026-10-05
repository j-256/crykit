import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import combatData from '../catalog/native-combat-v1.json'
import { defaultBattleCalculation } from './battle-plan'
import { SUGGESTED_BUILD_SLOTS } from './build-planning'
import { defaultCalculation } from './calculation-plan'
import { calculateBuildCombatPreview } from './combat-preview'
import { compareActiveStatusImpact, listActiveStatusImpactChoices } from './combat-status-impact'
import { catalogEntity } from './entity-identities'
import { resolveGameRules } from './game-rules'
import { definitionSourceRecord } from './mechanics-facts'
import { nativeStatRecord } from './native-stat-record'
import type { BattleCalculationPlan, BuildRevisionContent, CatalogEntity, CatalogRef, EntityId, EntityRef, JsonValue } from './types'

const ref = (id: string): CatalogRef => ({ kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: id as EntityId })
const hunter = ref('base:job:7')
const snipe = ref('base:ability:147')
const coyote = ref('base:monster:95')
const powerUp = ref('base:status:12')
const powerDown = ref('base:status:16')
const powerWall = ref('base:status:32')
const syntheticStatus = ref('impact-status')
const syntheticAbility = ref('impact-ability')
const syntheticPassive = ref('impact-passive')
const syntheticMonster = ref('impact-monster')
const rules = resolveGameRules({ mode: { state: 'known', value: 'Standard' }, difficulty: { version: 1, selection: { state: 'known', value: 0 } } }, [])
const tag = (name: string) => Number(Object.entries(combatData.enums.SangStatModTag).find(([, value]) => value === name)![0])
const abilityTag = (name: string) => Number(Object.entries(combatData.enums.SangAbilityModTag).find(([, value]) => value === name)![0])
const modifier = (name: string, Value1: number, Value2 = 0, Value3 = 0) => ({ Tag: tag(name), Value1, Value2, Value3 })
const definition = (selected: CatalogRef, kind: CatalogEntity['kind'], record: Record<string, unknown>, name = 'Synthetic status'): CatalogEntity => ({ id: selected.entityId, kind, name, aliases: [], sources: [], fields: { 'Crystal Edit source record': { state: 'known', value: record as JsonValue } } })
const resolver = (...entries: readonly CatalogEntity[]) => (selected: EntityRef) => selected.kind === 'catalog' ? entries.find(entry => entry.id === selected.entityId) ?? catalogEntity(DEFAULT_CATALOG, selected.entityId) : undefined
const resolve = resolver()
const content = (patch: Partial<BattleCalculationPlan> = {}): BuildRevisionContent => ({
  primaryClass: hunter, secondaryClass: null, equipment: { 'plan-main-hand': { ref: ref('base:equipment:300') } }, passives: [], contextAssumptions: [],
  calculation: { ...defaultCalculation(hunter), ability: snipe, battle: { ...defaultBattleCalculation(), target: coyote, statuses: [{ ref: powerUp, count: 3 }], ...patch } },
})
const preview = (selected: BuildRevisionContent, source = resolve) => calculateBuildCombatPreview(selected, SUGGESTED_BUILD_SLOTS, source, rules)
const compare = (selected: BuildRevisionContent, source = resolve, index = 0) => compareActiveStatusImpact(selected, SUGGESTED_BUILD_SLOTS, source, listActiveStatusImpactChoices(selected, source, rules)[index]!, rules)!
const withAbility = (selected: BuildRevisionContent): BuildRevisionContent => ({ ...selected, calculation: { ...selected.calculation!, ability: syntheticAbility } })
const customAbility = (patch: Record<string, unknown>) => definition(syntheticAbility, 'ability', { ...nativeStatRecord(snipe, 'ability', resolve, 'standard'), ID: 9200, ...patch }, 'Synthetic ability')
const customStatus = (mods: readonly unknown[]) => definition(syntheticStatus, 'status', { ID: 9300, Name: 'Synthetic status', Category: 1, ReApplyResistance: false, PersistsThroughDeath: false, StatMods: mods })

describe('active status impact comparisons', () => {
  it('reproduces the native Hunter, War Bow, Snipe and Coyote Power Up comparison without changing the saved plan', () => {
    const selected = content()
    const original = structuredClone(selected)
    const current = preview(selected)
    const choice = listActiveStatusImpactChoices(selected, resolve, rules)[0]!
    const result = compareActiveStatusImpact(selected, SUGGESTED_BUILD_SLOTS, resolve, choice, rules, [], false, current)!
    expect(choice).toMatchObject({ name: 'Power Up', ref: powerUp, recipient: 'user' })
    expect(result.current).toMatchObject({ damage: 1278, criticalDamage: 1929, hitChance: 80, criticalChance: 39, costs: { HP: 0, MP: 0, AP: 0, CT: 0, CD: 8 } })
    expect(result.without).toMatchObject({ damage: 947, criticalDamage: 1429, hitChance: 80, criticalChance: 39, costs: current.costs })
    expect(result.current.costs).toBe(current.costs)
    expect(result.current.unavailable).toEqual({})
    expect(result.without.unavailable).toEqual({})
    expect(result.automaticStatus).toBe('none')
    expect(result.notes).toEqual([])
    expect(selected).toEqual(original)
  })

  it('removes target statuses independently and leaves actor statuses in effect', () => {
    const selected = content({ targetStatuses: [{ ref: powerWall, count: 3 }] })
    const choices = listActiveStatusImpactChoices(selected, resolve, rules)
    expect(choices.map(choice => choice.recipient)).toEqual(['user', 'target'])
    const result = compare(selected, resolve, 1)
    expect(result.current.damage).toBeLessThan(1278)
    expect(result.without.damage).toBe(1278)
    expect(result.without.criticalDamage).toBe(preview(content()).criticalDamage)
    expect(selected.calculation!.battle!.statuses).toEqual([{ ref: powerUp, count: 3 }])
  })

  it('retains interacting statuses and their native rounding instead of assigning a flat contribution', () => {
    const selected = content({ statuses: [{ ref: powerUp, count: 3 }, { ref: powerDown, count: 3 }] })
    const result = compare(selected)
    const downOnly = preview(content({ statuses: [{ ref: powerDown, count: 3 }] }))
    expect(result.current.damage).toBe(preview(selected).damage)
    expect(result.without.damage).toBe(downOnly.damage)
    expect(result.current.damage! - result.without.damage!).not.toBe(1278 - 947)
  })

  it('groups source aliases by effective status identity and removes the complete selection together', () => {
    const alias = ref('crystal-edit:Statuses:12')
    const source = (selected: EntityRef) => selected.kind === 'catalog' && selected.entityId === alias.entityId ? resolve(powerUp) : resolve(selected)
    const selected = content({ statuses: [{ ref: powerUp, count: 3 }, { ref: alias, count: 2 }] })
    expect(listActiveStatusImpactChoices(selected, source, rules)).toHaveLength(1)
    const result = compare(selected, source)
    expect(result.current.damage).toBe(1278)
    expect(result.without.damage).toBe(947)
    expect(result.notes).toContain('References to this same effective status were removed together.')
  })

  it('uses one actor choice for self-targeting and changes both sides of the shared battler', () => {
    const source = resolver(customStatus([modifier('Mult_PDmg_Given_100', 150), modifier('Mult_PDmg_Taken_100', 50)]))
    const selected = content({ target: 'self', statuses: [{ ref: syntheticStatus, count: 3 }], targetStatuses: [{ ref: powerWall, count: 3 }] })
    expect(listActiveStatusImpactChoices(selected, source, rules).map(choice => choice.recipient)).toEqual(['user'])
    const result = compare(selected, source)
    const noStatus = preview(content({ target: 'self', statuses: [], targetStatuses: [{ ref: powerWall, count: 3 }] }), source)
    expect(result.without.damage).toBe(noStatus.damage)
    expect(result.current.damage).toBeLessThan(result.without.damage!)
    expect(result.notes.some(note => note.includes('changes both sides'))).toBe(true)
  })

  it('retains signed healing and changed costs', () => {
    const source = resolver(customStatus([modifier('Mult_Healing_Given_100', 150), modifier('Flat_MPCosts', -5)]), customAbility({ BasePower: -200, BasePAtkRate: 0, AgiRate: 0, StrRate: 0, DexRate: 0, PDefRate: 0, MDefRate: 0, IsPAbil: false, IsMAbil: true, MPCost: 16, Target: 1, AbilityMods: [] }))
    const result = compare(withAbility(content({ target: 'self', statuses: [{ ref: syntheticStatus, count: 3 }] })), source)
    expect(result.current.damage).toBe(-300)
    expect(result.without.damage).toBe(-200)
    expect(result.current.costs.MP).toBe(11)
    expect(result.without.costs.MP).toBe(16)
  })

  it('preserves unknown damage reasons on both sides while comparing independent costs', () => {
    const source = resolver(customStatus([modifier('Flat_MPCosts', -5)]), customAbility({ MPCost: 16, AbilityMods: [{ Tag: abilityTag('DamageRateCurrent_100'), Value1: 25, Value2: 0 }] }))
    const result = compare(withAbility(content({ statuses: [{ ref: syntheticStatus, count: 3 }] })), source)
    expect(result.current.damage).toBeNull()
    expect(result.without.damage).toBeNull()
    expect(result.current.unavailable.Damage?.join(' ')).toContain('current HP')
    expect(result.without.unavailable.Damage).toEqual(result.current.unavailable.Damage)
    expect(result.current.costs.MP).toBe(11)
    expect(result.without.costs.MP).toBe(16)
  })

  it('does not clamp current resources when removal lowers maximum HP', () => {
    const source = resolver(customStatus([modifier('Flat_HP', 100)]), customAbility({ AbilityMods: [{ Tag: abilityTag('DamageRateCurrent_100'), Value1: 25, Value2: 0 }] }))
    const selected = withAbility(content({ targetStatuses: [{ ref: syntheticStatus, count: 3 }], statuses: [], targetResources: { hp: 18050, mp: null, ap: null } }))
    const result = compare(selected, source)
    expect(result.current.damage).not.toBeNull()
    expect(result.without.damage).toBeNull()
    expect(result.without.unavailable.Damage?.join(' ')).toContain('exceeds')
    expect(selected.calculation!.battle!.targetResources.hp).toBe(18050)
  })

  it('identifies guaranteed actor automatic reapplication without claiming the status was removed', () => {
    const source = resolver(definition(syntheticPassive, 'passive', { ID: 9400, IsInnate: false, StatMods: [modifier('StatusAuto', 12, 100, 255)] }))
    const selected = { ...content({ user: { hp: 100, mp: null, ap: null } }), passives: [{ ref: syntheticPassive }] }
    const result = compare(selected, source)
    expect(result.automaticStatus).toBe('retained')
    expect(result.current.damage).toBe(1278)
    expect(result.without.damage).toBe(1278)
    expect(result.notes.some(note => note.includes('still applied automatically'))).toBe(true)
    const disabled = compare({ ...selected, calculation: { ...selected.calculation!, battle: { ...selected.calculation!.battle!, automaticStatuses: false } } }, source)
    expect(disabled.automaticStatus).toBe('none')
    expect(disabled.without.damage).toBe(947)
  })

  it('distinguishes uncertain automatic application and immune automatic sources', () => {
    const selected = { ...content({ user: { hp: 100, mp: null, ap: null } }), passives: [{ ref: syntheticPassive }] }
    const random = resolver(definition(syntheticPassive, 'passive', { ID: 9400, IsInnate: false, StatMods: [modifier('StatusAuto', 12, 50, 255)] }))
    expect(compare(selected, random)).toMatchObject({ automaticStatus: 'uncertain', current: { damage: 1278 }, without: { damage: null } })
    const immune = resolver(definition(syntheticPassive, 'passive', { ID: 9400, IsInnate: false, StatMods: [modifier('StatusAuto', 12, 100, 255), modifier('StatusImmunity', 12)] }))
    expect(compare(selected, immune)).toMatchObject({ automaticStatus: 'none', without: { damage: 947 } })
  })

  it('detects target automatic reapplication using the target source and resources', () => {
    const source = resolver(definition(syntheticMonster, 'monster', { ...definitionSourceRecord(resolve(coyote)!), ID: 9500, StatMods: [modifier('StatusAuto', 32, 100, 255)] }))
    const selected = content({ target: syntheticMonster, statuses: [], targetStatuses: [{ ref: powerWall, count: 3 }], targetResources: { hp: 100, mp: null, ap: null } })
    const result = compare(selected, source)
    expect(result.automaticStatus).toBe('retained')
    expect(result.without.damage).toBe(result.current.damage)
    expect(result.without.damage).not.toBeNull()
  })

  it('keeps unresolved status identities separate and guards stale choices', () => {
    const missing = ref('missing-impact-status')
    const selected = content({ statuses: [{ ref: missing, count: 3 }, { ref: powerUp, count: 3 }] })
    const choices = listActiveStatusImpactChoices(selected, resolve, rules)
    expect(choices).toHaveLength(2)
    expect(compare(selected)).toMatchObject({ automaticStatus: 'unknown', current: { damage: null }, without: { damage: 1278 } })
    expect(compareActiveStatusImpact(content(), SUGGESTED_BUILD_SLOTS, resolve, choices[0]!, rules)).toBeUndefined()
    expect(listActiveStatusImpactChoices({ ...selected, calculation: undefined }, resolve, rules)).toEqual([])
  })
})
