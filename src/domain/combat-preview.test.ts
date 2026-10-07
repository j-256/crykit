import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import combatData from '../catalog/native-combat-v1.json'
import { calculateBuildCombatPreview } from './combat-preview'
import { defaultCalculation } from './calculation-plan'
import { defaultBattleCalculation } from './battle-plan'
import { SUGGESTED_BUILD_SLOTS } from './build-planning'
import { NATIVE_DATA } from './calculation-rules'
import { catalogEntity } from './entity-identities'
import { resolveGameRules } from './game-rules'
import { calculateBuildStats } from './build-stats'
import type { BattleCalculationPlan, BuildRevisionContent, CatalogEntity, CatalogRef, EntityId, EntityRef, JsonValue } from './types'

const ref = (id: string): CatalogRef => ({ kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: id as EntityId })
const warrior = ref('base:job:0')
const selectedAbility = ref('synthetic-combat-ability')
const gear = ref('synthetic-combat-equipment')
const passive = ref('synthetic-combat-passive')
const target = ref('synthetic-combat-monster')
const status = ref('synthetic-combat-status')
const tag = (name: string) => Number(Object.entries(combatData.enums.SangStatModTag).find(([, value]) => value === name)![0])
const abilityTag = (name: string) => Number(Object.entries(combatData.enums.SangAbilityModTag).find(([, value]) => value === name)![0])
const modifier = (name: string, Value1: number, Value2 = 0, Value3 = 0) => ({ Tag: tag(name), Value1, Value2, Value3 })
const definition = (id: string, kind: CatalogEntity['kind'], record: Record<string, unknown>): CatalogEntity => ({ id: id as EntityId, kind, name: `Synthetic ${kind}`, aliases: [], sources: [], fields: { 'Crystal Edit source record': { state: 'known', value: record as JsonValue } } })
const rules = resolveGameRules({ mode: { state: 'known', value: 'Standard' }, difficulty: { version: 1, selection: { state: 'known', value: 0 } } }, [])
const ability = { ...NATIVE_DATA.records.ability[0], ID: 9100, Name: 'Synthetic ability', IsBasic: false, ScalingPower: null, ScalingPAtkRate: null, BasePower: 20, BasePAtkRate: 0, StrRate: 0, MPCost: 16 }
const monster = { ...combatData.records.monster[0], ID: 9200, Level: 10, HP: 500, MP: 30, Str: 60, Vit: 40, Dex: 30, Agi: 20, Mnd: 30, Spi: 30, Spd: 20, Lck: 20 }
const battle = (patch: Partial<BattleCalculationPlan> = {}): BattleCalculationPlan => ({ ...defaultBattleCalculation(), target, user: { hp: 100, mp: 10, ap: 0 }, targetResources: { hp: 100, mp: 10, ap: 0 }, bottomThreat: false, topThreat: false, targetIsThreatTarget: false, ...patch })
const content = (scenario: BattleCalculationPlan | undefined = battle()): BuildRevisionContent => ({ primaryClass: warrior, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: { ...defaultCalculation(warrior), ability: selectedAbility, battle: scenario } })
function setup(values: { ability?: Record<string, unknown>; equipment?: Record<string, unknown>; passive?: Record<string, unknown>; monster?: Record<string, unknown>; status?: Record<string, unknown> } = {}) {
  const entries = [definition(passive.entityId, 'passive', { ID: 9500, IsInnate: false, StatMods: [], ...values.passive }), definition(selectedAbility.entityId, 'ability', { ...ability, ...values.ability }), definition(gear.entityId, 'item', { ID: 9300, EquipmentType: 0, StatMods: [], ...values.equipment }), definition(target.entityId, 'monster', { ...monster, ...values.monster }), definition(status.entityId, 'status', { ID: 9400, Name: 'Synthetic status', Category: 2, ReApplyResistance: false, PersistsThroughDeath: false, StatMods: [], ...values.status })]
  const resolve = (selected: EntityRef) => selected.kind === 'catalog' ? entries.find(item => item.id === selected.entityId || item.kind === 'status' && selected.entityId === `crystal-edit:Statuses:${values.status?.ID ?? 9400}`) ?? catalogEntity(DEFAULT_CATALOG, selected.entityId) : undefined
  const preview = (selected = content()) => calculateBuildCombatPreview(selected, SUGGESTED_BUILD_SLOTS, resolve, rules)
  return { preview, resolve }
}

describe('effective build combat previews', () => {
  it('applies per-ability and global costs without requiring a target or complete core stats', () => {
    const { preview } = setup({ equipment: { StatMods: [modifier('Flat_AbilityMPCost', ability.ID, -5), modifier('Mult_MPCosts', -50)] } })
    const selected = { ...content(undefined), equipment: { 'plan-main-hand': { ref: gear } }, calculation: { ...content(undefined).calculation!, level: null, growth: [] } }
    const result = preview(selected)
    const reduced = setup({ equipment: { StatMods: [modifier('Flat_AbilityMPCost', ability.ID, -5)] } }).preview(selected)
    expect(reduced.costs.MP).toBe(11)
    expect(result.baseCosts.MP).toBe(16)
    expect(result.costs.MP).toBe(5)
    expect(result.costs.HP).toBe(0)
    expect(result.costs.AP).toBe(0)
    expect(result.damage).toBeNull()
    expect(result.issues.filter(issue => issue.includes('modifier'))).toEqual([])
  })

  it('retains native truncation, flat clamping, cooldown order, and HP percentage costs', () => {
    const { preview, resolve } = setup({ ability: { HPCost: 13, MPCost: 3, APCost: 5, CTCost: 37, CDCost: 5 }, equipment: { StatMods: [modifier('Flat_MPCosts', -7), modifier('Mult_MPCosts', -50), modifier('Mult_APCosts', -50), modifier('Mult_CT_100', 50), modifier('Flat_Cooldowns', 2), modifier('HalfCooldowns', 0)] } })
    const selected = { ...content(), equipment: { 'plan-main-hand': { ref: gear } } }
    const result = preview(selected)
    const hp = calculateBuildStats(selected, SUGGESTED_BUILD_SLOTS, resolve, undefined, rules).stats.HP.value!.low
    expect(result.costs).toEqual({ HP: Math.trunc(hp * 13 / 100), MP: 0, AP: 2, CT: 18, CD: 3 })
  })

  it('assembles target defenses, native derived stats, difficulty, and independent chances', () => {
    const { preview } = setup()
    const result = preview()
    expect(result.unavailable).toEqual({})
    expect(result.damage).toBeGreaterThan(0)
    expect(result.criticalDamage).toBeGreaterThan(result.damage!)
    expect(result.hitChance).toBeGreaterThan(0)
    expect(result.criticalChance).toBeGreaterThan(0)
    expect(result.maxima.target).toEqual({ hp: 500, mp: 30, ap: 30 })
    expect(result.periodic).toEqual({ HP: 0, MP: 0, AP: 0 })
  })

  it('uses the same build as a healing target and preserves negative healing', () => {
    const { preview } = setup({ ability: { BasePower: -200, IsPAbil: false, IsMAbil: true, PDefRate: 0, Target: 1 }, equipment: { StatMods: [modifier('Mult_Healing_Given_100', 150)] } })
    const result = preview({ ...content(battle({ target: 'self' })), equipment: { 'plan-main-hand': { ref: gear } } })
    expect(result.damage).toBe(-300)
    expect(result.hitChance).toBe(100)
    expect(result.costs.MP).toBe(16)
  })

  it('keeps missing target resources scoped to damage while effective costs and crit remain known', () => {
    const { preview } = setup({ ability: { AbilityMods: [{ Tag: abilityTag('DamageRateCurrent_100'), Value1: 25, Value2: 0 }] } })
    const result = preview(content(battle({ targetResources: { hp: null, mp: null, ap: null } })))
    expect(result.damage).toBeNull()
    expect(result.costs.MP).toBe(16)
    expect(result.criticalChance).not.toBeNull()
    expect(result.unavailable.Damage?.join(' ')).toContain('current HP')
  })

  it('calculates per-turn statuses and marks unknown modifier dependencies without blanking costs', () => {
    const { preview } = setup({ status: { StatMods: [modifier('Addi_DamagePerTurnHP', 15)] } })
    const result = preview(content(battle({ statuses: [{ ref: status, count: 3 }] })))
    expect(result.periodic.HP).toBeGreaterThan(0)
    expect(result.costs.MP).toBe(16)
  })
  it('applies status immunity, independent application history, and duration modifiers', () => {
    const { preview } = setup({ ability: { TargetStatuses: [{ StatusID: 9400, Chance: 80, Count: 3 }], UserStatuses: [{ StatusID: 9400, Chance: 70, Count: 2 }] }, status: { ReApplyResistance: true }, equipment: { StatMods: [modifier('Flat_ApplyDebuffDuration', 1)] }, monster: { StatMods: [modifier('Addi_DebuffDuration', 50)] } })
    const selected = { ...content(), equipment: { 'plan-main-hand': { ref: gear } } }
    expect(preview(selected).statuses).toEqual([{ name: 'Synthetic status', recipient: 'user', chance: 70, duration: 3 }, { name: 'Synthetic status', recipient: 'target', chance: 80, duration: 6 }])
    const history = preview({ ...selected, calculation: { ...selected.calculation!, battle: battle({ previouslyAppliedStatuses: [status] }) } })
    expect(history.statuses.map(status => status.chance)).toEqual([70, 0])
    const immunity = setup({ ability: { TargetStatuses: [{ StatusID: 9400, Chance: 80, Count: 3 }] }, monster: { StatMods: [modifier('StatusImmunity', 9400)] } }).preview()
    expect(immunity.statuses[0]?.chance).toBe(0)
  })

  it('shares guaranteed automatic status behavior for monster targets and isolates uncertain effects', () => {
    const { preview } = setup({ monster: { StatMods: [modifier('StatusAuto', 9400, 100, 3)] }, status: { StatMods: [modifier('Flat_HP', 100)] } })
    expect(preview().maxima.target?.hp).toBe(600)
    expect(preview(content(battle({ targetTurnCount: 2 }))).maxima.target?.hp).toBeNull()
    expect(preview(content(battle({ targetTurnCount: 2, targetStatuses: [{ ref: status, count: 1 }] }))).maxima.target?.hp).toBe(600)
    const random = setup({ monster: { StatMods: [modifier('StatusAuto', 9400, 50, 255)] }, status: { StatMods: [modifier('Flat_HP', 100)] } }).preview()
    expect(random.maxima.target?.hp).toBeNull()
    expect(random.criticalChance).not.toBeNull()
    expect(random.costs.MP).toBe(16)
    const immune = setup({ monster: { StatMods: [modifier('StatusAuto', 9400, 100, 255), modifier('StatusImmunity', 9400)] }, status: { StatMods: [modifier('Flat_HP', 100)] } }).preview()
    expect(immune.maxima.target?.hp).toBe(500)
  })

  it('preserves explicitly selected target statuses against automatic application events', () => {
    const automaticId = 9401
    const automaticRef = ref(`crystal-edit:Statuses:${automaticId}`)
    const automatic = definition(automaticRef.entityId, 'status', { ID: automaticId, Name: 'Automatic removal', Category: 2, ReApplyResistance: false, PersistsThroughDeath: false, StatMods: [modifier('RemoveStatusOnApply', 9400)] })
    const { resolve } = setup({ monster: { StatMods: [modifier('StatusAuto', automaticId, 100, 255)] }, status: { StatMods: [modifier('Flat_HP', 100)] } })
    const withAutomatic = (selected: EntityRef) => selected.kind === 'catalog' && selected.entityId === automaticRef.entityId ? automatic : resolve(selected)
    const selected = content(battle({ targetStatuses: [{ ref: status, count: 3 }] }))
    const result = calculateBuildCombatPreview(selected, SUGGESTED_BUILD_SLOTS, withAutomatic, rules)
    expect(result.maxima.target?.hp).toBe(600)
    expect(result.issues).not.toContain("Automatic statuses change other statuses. Select the statuses that are active afterward.")
  })

  it('does not silently ignore unavailable statuses, unknown targets, or overflowing resource modifiers', () => {
    const { preview } = setup()
    const missing = preview(content(battle({ targetStatuses: [{ ref: ref('missing-status'), count: 1 }] })))
    expect(missing.damage).toBeNull()
    expect(missing.criticalChance).toBeNull()
    expect(missing.costs.MP).toBe(16)
    const missingMonster = preview(content(battle({ target: ref('missing-monster') })))
    expect(missingMonster.criticalChance).toBeNull()
    expect(missingMonster.maxima.target).toEqual({ hp: null, mp: null, ap: null })
    expect(missingMonster.costs.MP).toBe(16)
    const overflow = setup({ equipment: { StatMods: [modifier('Flat_AP', 2147483647)] } })
    const selected = { ...content(), equipment: { 'plan-main-hand': { ref: gear } } }
    expect(() => overflow.preview(selected)).not.toThrow()
    expect(overflow.preview(selected).maxima.user.ap).toBeNull()
    expect(overflow.preview(selected).costs.MP).toBe(16)
  })

  it('preserves per-ability and per-flag uncertainty without blocking unaffected costs', () => {
    const uncertain = setup({ equipment: { StatMods: [modifier('StatusAuto', 9400, 50, 255)] }, status: { StatMods: [modifier('Flat_AbilityMPCost', ability.ID, -5), modifier('HalfCooldowns', 0)] }, ability: { CDCost: 5 } })
    const selected = { ...content(), equipment: { 'plan-main-hand': { ref: gear } } }
    const result = uncertain.preview(selected)
    expect(result.costs.MP).toBeNull()
    expect(result.costs.CD).toBeNull()
    expect(result.costs.AP).toBe(0)
    expect(result.costs.CT).toBe(0)
    const explicit = uncertain.preview({ ...selected, calculation: { ...selected.calculation!, battle: battle({ statuses: [{ ref: status, count: 255 }] }) } })
    expect(explicit.costs.MP).toBe(11)
    expect(explicit.costs.CD).toBe(2)
  })

  it('includes physical on-hit statuses and distinguishes randomly selected ability statuses', () => {
    const { preview } = setup({ ability: { TargetStatuses: [{ StatusID: 9400, Chance: 80, Count: 3 }], AbilityMods: [{ Tag: abilityTag('RandomStatusTarget'), Value1: 0, Value2: 0 }] }, equipment: { StatMods: [modifier('PStatusApply', 9400, 50, 2)] } })
    const result = preview({ ...content(), equipment: { 'plan-main-hand': { ref: gear } } })
    expect(result.statuses).toEqual([{ name: 'Synthetic status', recipient: 'target', chance: 80, duration: 3, condition: 'Chance is conditional on this status being randomly selected' }, { name: 'Synthetic status', recipient: 'target', chance: 50, duration: 2, condition: 'Applied by a physical on-hit modifier' }])
    const magical = setup({ ability: { IsPAbil: false, IsMAbil: true }, equipment: { StatMods: [modifier('PStatusApply', 9400, 50, 2)] } }).preview({ ...content(), equipment: { 'plan-main-hand': { ref: gear } } })
    expect(magical.statuses).toEqual([])
  })

  it('uses actor application history when targeting self and separates removal from immunity', () => {
    const { preview } = setup({ ability: { TargetStatuses: [{ StatusID: 9400, Chance: 80, Count: 3 }] }, status: { ReApplyResistance: true } })
    expect(preview(content(battle({ target: 'self', userPreviouslyAppliedStatuses: [status] }))).statuses[0]?.chance).toBe(0)
    const remove = setup({ ability: { TargetStatuses: [{ StatusID: 9400, Chance: 80, Count: -1 }] }, status: { ReApplyResistance: true, PreventRemoval: false }, monster: { StatMods: [modifier('StatusImmunity', 9400)] } }).preview()
    expect(remove.statuses[0]).toMatchObject({ chance: 80, duration: -1 })
    const dead = preview(content(battle({ targetResources: { hp: 0, mp: 0, ap: 0 } })))
    expect(dead.statuses[0]?.chance).toBe(0)
  })

  it('does not demand resources or threat conditions when their modifiers are neutral', () => {
    const selected = content({ ...defaultBattleCalculation(), target, turnCount: null, repeatCount: null, targetCharging: null })
    const plain = setup().preview(selected)
    expect(plain.damage).not.toBeNull()
    expect(plain.unavailable).toEqual({})
    const contingent = setup({ equipment: { StatMods: [modifier('Mult_PDmg_GivenWhenCritical_100', 150)] } }).preview({ ...selected, equipment: { 'plan-main-hand': { ref: gear } } })
    expect(contingent.damage).toBeNull()
    expect(contingent.unavailable.Damage?.join(' ')).toContain('current HP')
    const maxHP = setup({ ability: { AbilityMods: [{ Tag: abilityTag('DamageRateMax_100'), Value1: 10, Value2: 0 }] } }).preview(selected)
    expect(maxHP.damage).not.toBeNull()
    const bottom = setup({ ability: { AbilityMods: [{ Tag: abilityTag('BottomThreatDamageMult'), Value1: 50, Value2: 0 }] } }).preview(content({ ...selected.calculation!.battle!, bottomThreat: true }))
    expect(bottom.damage).not.toBeNull()
  })

  it('preserves uncertain automatic status presence even when it has no numeric modifiers', () => {
    const selected = content(battle())
    const plain = setup({ monster: { StatMods: [modifier('StatusAuto', 9400, 50, 255)] } }).preview(selected)
    expect(plain.damage).not.toBeNull()
    const conditional = setup({ monster: { StatMods: [modifier('StatusAuto', 9400, 50, 255)] }, ability: { AbilityMods: [{ Tag: abilityTag('DamageRateVsStatus'), Value1: 9400, Value2: 100 }] } }).preview(selected)
    expect(conditional.damage).toBeNull()
    expect(conditional.unavailable.Damage?.join(' ')).toContain('count')
    expect(conditional.unavailable.Variance).toEqual(conditional.unavailable.Damage)
    expect(conditional.unavailable['Critical variance']).toEqual(conditional.unavailable['Critical damage'])
  })

  it('keeps unavailable secondary innates and unsupported rule contexts out of all affected results', () => {
    const { resolve } = setup({ passive: { StatMods: [modifier('SubJobInnatePassives', 0)] }, ability: { UserStatuses: [{ StatusID: 9400, Chance: 100, Count: 3 }] } })
    const selected = { ...content(), equipment: { 'plan-main-hand': { ref: gear } } }
    const withInnate = { ...selected, passives: [{ ref: passive }] }
    const unknownSecondary = calculateBuildCombatPreview(withInnate, SUGGESTED_BUILD_SLOTS, resolve, rules, [], true)
    expect(unknownSecondary.costs.MP).toBeNull()
    expect(unknownSecondary.periodic.HP).toBeNull()
    expect(unknownSecondary.statuses[0]?.duration).toBeNull()
    const platform = resolveGameRules({ platform: { state: 'known', value: 'Nintendo Switch' } }, [])
    const unsupported = calculateBuildCombatPreview(selected, SUGGESTED_BUILD_SLOTS, resolve, platform)
    expect(unsupported.costs.MP).toBeNull()
    expect(unsupported.periodic).toEqual({ HP: null, MP: null, AP: null })
    expect(unsupported.statuses[0]).toMatchObject({ chance: null, duration: null })
    const unknownGear = calculateBuildCombatPreview(content(), SUGGESTED_BUILD_SLOTS, resolve, rules, ['Off hand unknown'])
    expect(unknownGear.costs.MP).toBeNull()
    expect(unknownGear.periodic.HP).toBeNull()
  })

  it('keeps magical hit chances independent of unavailable physical accuracy and evasion', () => {
    const { preview } = setup({ ability: { IsPAbil: false, IsMAbil: true }, monster: { StatMods: [modifier('Flat_Agi_PerTurn', 1, 1)] } })
    const result = preview(content(battle({ targetTurnCount: null })))
    expect(result.hitChance).toBe(100)
    expect(result.costs.MP).toBe(16)
  })

  it('resolves native Cleric, Cure and Slime records from the actual bundled catalog', () => {
    const cleric = ref('base:job:4')
    const cureRecord = NATIVE_DATA.records.ability.find(record => record.Name === 'Cure')!
    const selected: BuildRevisionContent = { ...content(battle({ target: ref('base:monster:2'), targetResources: { hp: 50, mp: 40, ap: 30 } })), primaryClass: cleric, calculation: { ...defaultCalculation(cleric), ability: ref(`base:ability:${cureRecord.ID}`), battle: battle({ target: ref('base:monster:2'), targetResources: { hp: 50, mp: 40, ap: 30 } }) } }
    const resolve = (selected: EntityRef) => selected.kind === 'catalog' ? catalogEntity(DEFAULT_CATALOG, selected.entityId) : undefined
    const result = calculateBuildCombatPreview(selected, SUGGESTED_BUILD_SLOTS, resolve, rules)
    expect(result.issues).toEqual([])
    expect(result.maxima.target).toEqual({ hp: 50, mp: 40, ap: 30 })
    expect(result.unavailable).toEqual({})
    expect(result.damage).toBeLessThan(0)
    expect(result.hitChance).toBe(100)
  })

  it('retains flat periodic effects when maximum HP and resistance stats are unknown', () => {
    const { preview } = setup({ equipment: { StatMods: [modifier('Flat_DamagePerTurnHP', -20), modifier('Flat_DamagePerTurnMP', -2)] } })
    const selected = { ...content(), equipment: { 'plan-main-hand': { ref: gear } }, calculation: { ...content().calculation!, level: null, growth: [] } }
    const result = preview(selected)
    expect(result.maxima.user.hp).toBeNull()
    expect(result.periodic).toEqual({ HP: -20, MP: -2, AP: 0 })
    expect(result.costs.MP).toBe(16)
  })

  it('uses independent target turns for monster modifiers and automatic status expiry', () => {
    const { preview } = setup({ monster: { StatMods: [modifier('Flat_HP_PerTurn', 25, 10)] } })
    expect(preview(content(battle({ turnCount: 5, targetTurnCount: 2 }))).maxima.target?.hp).toBe(550)
    expect(preview(content(battle({ turnCount: null, targetTurnCount: 2 }))).maxima.target?.hp).toBe(550)
    expect(preview(content(battle({ turnCount: 0, targetTurnCount: null }))).maxima.target?.hp).toBeNull()
    const auto = setup({ monster: { StatMods: [modifier('StatusAuto', 9400, 100, 3)] }, status: { StatMods: [modifier('Flat_HP', 100)] } })
    expect(auto.preview(content(battle({ turnCount: 5, targetTurnCount: 0 }))).maxima.target?.hp).toBe(600)
    expect(auto.preview(content(battle({ turnCount: 0, targetTurnCount: 2 }))).maxima.target?.hp).toBeNull()
  })

  it('keeps unresolved recipient duration and prior-application identities unknown', () => {
    const { preview } = setup({ ability: { TargetStatuses: [{ StatusID: 9400, Chance: 80, Count: 3 }] }, status: { ReApplyResistance: true } })
    const missing = preview(content(battle({ target: ref('missing-monster') })))
    expect(missing.statuses[0]).toMatchObject({ chance: null, duration: null })
    expect(missing.unavailable['Synthetic status duration (target)']).toEqual(['Received duration modifier is unknown'])
    const history = preview(content(battle({ previouslyAppliedStatuses: [ref('missing-status')] })))
    expect(history.statuses[0]).toMatchObject({ chance: null, duration: 3 })
    expect(history.unavailable['Synthetic status chance (target)']).toEqual(['Previously applied status identity is unresolved'])
    const withoutResistance = setup({ ability: { TargetStatuses: [{ StatusID: 9400, Chance: 80, Count: 3 }] } }).preview(content(battle({ previouslyAppliedStatuses: [ref('missing-status')] })))
    expect(withoutResistance.statuses[0]).toMatchObject({ chance: 80, duration: 3 })
    const permanent = setup({ ability: { TargetStatuses: [{ StatusID: 9400, Chance: 80, Count: 3 }] }, equipment: { StatMods: [modifier('AppliedDebuffsArePerma', 0)] } }).preview({ ...content(battle({ target: ref('missing-monster') })), equipment: { 'plan-main-hand': { ref: gear } } })
    expect(permanent.statuses[0]).toMatchObject({ chance: null, duration: 255 })
  })

  it('applies status aliases once and preserves uncertainty in duplicate automatic counts', () => {
    const { preview } = setup({ status: { StatMods: [modifier('Flat_HP', 100)] } })
    const selected = content(battle({ targetStatuses: [{ ref: status, count: 3 }, { ref: ref('crystal-edit:Statuses:9400'), count: 3 }] }))
    expect(preview(selected).maxima.target?.hp).toBe(600)
    const abilityMods = [{ Tag: abilityTag('ConsumeComboTokens'), Value1: 10, Value2: 0 }]
    const automatic = (chance: number) => setup({ status: { ID: 46 }, monster: { StatMods: [modifier('StatusAuto', 46, 100, 3), modifier('StatusAuto', 46, chance, 2)] }, ability: { AbilityMods: abilityMods } }).preview()
    expect(automatic(100).damage).not.toBeNull()
    expect(automatic(50).damage).toBeNull()
    expect(automatic(50).unavailable.Damage?.join(' ')).toContain('count')
  })

})
