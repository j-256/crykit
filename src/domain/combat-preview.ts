import combatData from '../catalog/native-combat-v1.json'
import { ABILITY_COSTS, type AbilityEstimate } from './ability-estimates'
import { calculateBuildStats, type CalculatedStat } from './build-stats'
import type { DefinitionResolver } from './build-mechanics'
import { calculateCombat } from './combat-calculations'
import type { CombatValue } from './combat-expression'
import { calculateFormula, NATIVE_DATA } from './calculation-rules'
import { calculationModResolver } from './calculation-mods'
import { aggregateStatModifiers, applyAutomaticStatuses, collectEffectiveModifiers, resolveLinkedStatus, type EffectiveModifiers, type EffectiveModifierRecord } from './effective-modifiers'
import { definitionSourceRecord } from './mechanics-facts'
import { nativeIdentity } from './native-game'
import { nativeStatRecord, type NativeRecord } from './pc-stats'
import { nativeInteger } from './native-number'
import type { GameRuleResolution } from './game-rules'
import type { BattleCalculationPlan, BuildRevisionContent, EntityRef, SlotDefinition } from './types'

const COST_FORMULAS = Object.freeze({ HP: 'hpCost', MP: 'mpCost', AP: 'apCost', CT: 'chargeTime', CD: 'cooldown' })
const CORE_NAMES = Object.freeze({ HP: 'HP', MP: 'MP', STR: 'Str', VIT: 'Vit', DEX: 'Dex', AGI: 'Agi', MND: 'Mnd', SPI: 'Spi', SPD: 'Spd', LUK: 'Lck', ATK: 'PAtk', DEF: 'PDef', RES: 'MDef', CRIT: 'PCritChance', CRIT_DAMAGE: 'PCritDmg', ACC: 'PAccRating', EVA: 'PEvaRating', PPEN: 'PPen', MPEN: 'MPen', TT: 'TT' })
const TAG_IDS = Object.fromEntries(Object.entries(combatData.enums.SangStatModTag).map(([id, name]) => [name, Number(id)]))
const ELEMENT_IDS = Object.keys(combatData.enums.ElementType).map(Number)
const RESOURCE_FIELDS = Object.freeze({ hp: 'HP', mp: 'MP', ap: 'AP' })
const BASE_AP_CAPACITY = 30
const MEMBER_AP_CAPACITY_LIMIT = 99
const MAX_DEFENSE_TAG_MINIMUM = 9999
const BUFF_CATEGORY = 1
const DEBUFF_CATEGORY = 2

type CombatObject = Record<string, CombatValue>
interface ActiveStatus { readonly ref?: EntityRef; readonly record: NativeRecord; readonly count: number | null; readonly uncertain?: boolean }
export interface CombatStatusPreview { readonly name: string; readonly recipient: 'user' | 'target'; readonly chance: number | null; readonly duration: number | null; readonly condition?: string }
export interface BuildCombatPreview {
  readonly costs: AbilityEstimate['costs']
  readonly baseCosts: AbilityEstimate['costs']
  readonly damage: number | null
  readonly criticalDamage: number | null
  readonly hitChance: number | null
  readonly criticalChance: number | null
  readonly variance: number | null
  readonly criticalVariance: number | null
  readonly maxima: { readonly user: BattleCalculationPlan['user']; readonly target: BattleCalculationPlan['user'] | null }
  readonly periodic: Readonly<Record<'HP' | 'MP' | 'AP', number | null>>
  readonly statuses: readonly CombatStatusPreview[]
  readonly issues: readonly string[]
  readonly notes: readonly string[]
  readonly unavailable: Readonly<Record<string, readonly string[]>>
}

function requireNumber(value: unknown, label: string): number {
  if (!nativeInteger(value)) throw new Error(`${label} is unknown or outside the native integer range`)
  return value
}
function nativeResult(value: number): number { return requireNumber(value, 'Calculated result') }
function add(left: number, right: number): number { return nativeResult(left + right) }
function percent(value: number, rate: number): number { return calculateCombat('percent', [value, rate]) as number }
function guarded(target: CombatObject, key: string, value: CombatValue | undefined, label: string, known = value !== undefined): void {
  Object.defineProperty(target, key, { enumerable: true, configurable: true, get: () => {
    if (!known) throw new Error(`${label} is unknown`)
    return value
  } })
}
function numericObject(values: Readonly<Record<string, number | null>>, unknown: ReadonlySet<string>, label: string): CombatObject {
  const result: CombatObject = {}
  for (const [key, value] of Object.entries(values)) guarded(result, key, value, `${label} ${key}`, !unknown.has(key) && !unknown.has('*'))
  return result
}
function modifierNumber(modifiers: EffectiveModifiers, field: string, label: string): number {
  if (modifiers.unknownFields.has('*') || modifiers.unknownFields.has(field)) throw new Error(`${label} is unknown`)
  return requireNumber(modifiers.stats[field], label)
}
function hasTag(modifiers: EffectiveModifiers, name: string): boolean {
  if (modifiers.unknownFields.has('*') || modifiers.unknownFields.has(`tag.${name}`)) throw new Error(`${name} effect is unknown`)
  return modifiers.tags.has(name)
}
function modifierStats(modifiers: EffectiveModifiers, label: string): CombatObject {
  const result = numericObject(modifiers.stats, modifiers.unknownFields, label)
  const known = (key: string) => !modifiers.unknownFields.has(key) && !modifiers.unknownFields.has('*')
  const tags = [...modifiers.tags].flatMap(tag => TAG_IDS[tag] === undefined ? [] : [TAG_IDS[tag]!])
  const uncertainTags = new Set([...modifiers.unknownFields].filter(field => field.startsWith('tag.')).map(field => TAG_IDS[field.slice(4)]))
  tags.includes = (id: number) => {
    if (uncertainTags.has(id)) throw new Error(`${label} ${combatData.enums.SangStatModTag[String(id) as keyof typeof combatData.enums.SangStatModTag]} effect is uncertain`)
    return Array.prototype.includes.call(tags, id)
  }
  guarded(result, 'Tags', tags, `${label} modifier flags`, known('Tags'))
  guarded(result, 'PElements', modifiers.physicalElements, `${label} physical elements`, known('PElements'))
  for (const [key, values] of [['AbilityMPCostFlat', modifiers.abilityMP], ['AbilityAPCostFlat', modifiers.abilityAP], ['AbilityDmgMult', modifiers.abilityDamage]] as const) {
    const mapName = key === 'AbilityMPCostFlat' ? 'abilityMP' : key === 'AbilityAPCostFlat' ? 'abilityAP' : 'abilityDamage'
    const uncertainIDs = [...modifiers.unknownFields].filter(field => field.startsWith(`${mapName}.`)).map(field => field.slice(mapName.length + 1))
    const pairs = [...new Set([...Object.keys(values), ...uncertainIDs])].map(ID => {
      const Value = values[ID]

      const pair: CombatObject = { ID: Number(ID) }
      guarded(pair, 'Value', Value, `${label} ${key} for ability ${ID}`, Value != null && !uncertainIDs.includes(ID))
      return pair
    })
    guarded(result, key, pairs, `${label} ${key}`, known(key))
  }
  for (const [key, values] of [['ElementDmgGivenMults', modifiers.elementGiven], ['ElementDmgTakenMults', modifiers.elementTaken]] as const) {
    const multipliers: number[] = []
    for (const id of ELEMENT_IDS) Object.defineProperty(multipliers, id, { enumerable: true, get: () => {
      const field = `${key === 'ElementDmgGivenMults' ? 'elementGiven' : 'elementTaken'}.${id}`
      const value = modifiers.unknownFields.has(field) ? null : values[id] === undefined ? 100 : values[id]
      return requireNumber(value, `${label} ${key} element ${id}`)
    } })
    guarded(result, key, multipliers, `${label} ${key}`, known(key))
  }
  return result
}

function explicitStatuses(rows: BattleCalculationPlan['statuses'], resolve: DefinitionResolver, mode: string, issues: string[]): ActiveStatus[] {
  const result: ActiveStatus[] = []
  for (const { ref, count } of rows) {
    const record = nativeStatRecord(ref, 'status', resolve, mode)
    if (!record) { issues.push('A selected battle status has no supported numeric record'); continue }
    const previous = nativeInteger(record.ID) ? result.findIndex(status => status.record.ID === record.ID) : -1
    if (previous < 0) result.push({ ref, record, count })
    else if (result[previous]!.count !== count) {
      issues.push('Aliases for an active status specify conflicting remaining counts')
      result[previous] = { ...result[previous]!, count: null }
    }
  }
  return result
}
function appendAutomaticStatuses(statuses: ActiveStatus[], modifiers: EffectiveModifiers): ActiveStatus[] {
  const result = [...statuses]
  for (const status of modifiers.automaticStatuses) if ((status.applied || status.uncertain) && !result.some(item => item.record.ID === status.id)) result.push({ ref: status.ref, record: status.record ?? { ID: status.id }, count: status.uncertain || status.countUncertain ? null : status.count, uncertain: status.uncertain })
  return result
}
function battler(stats: CombatObject, resources: BattleCalculationPlan['user'] | undefined, statuses: readonly ActiveStatus[], isMember: boolean, label: string): CombatObject {
  const result: CombatObject = { Stats: stats, IsMember: isMember, IsMonster: !isMember }
  for (const [input, native] of Object.entries(RESOURCE_FIELDS)) Object.defineProperty(result, `${native}Current`, { enumerable: true, get: () => {
    const current = requireNumber(resources?.[input as keyof typeof RESOURCE_FIELDS], `${label} current ${native}`)
    const maximum = stats[native]
    if (typeof maximum === 'number' && current > maximum) throw new Error(`${label} current ${native} exceeds its calculated maximum`)
    return current
  } })
  Object.defineProperty(result, 'HPCriticalValue', { enumerable: true, get: () => Math.trunc(requireNumber(stats.HP, `${label} maximum HP`) / 4) })
  result.Statuses = statuses.map(status => {
    const entry: CombatObject = {}
    guarded(entry, 'ID', status.record.ID as CombatValue, 'Status identity', nativeInteger(status.record.ID))
    guarded(entry, 'Count', status.count, `${label} ${String(status.record.Name ?? 'status')} count`, status.count !== null)
    return entry
  })
  return result
}

function monsterStats(ref: EntityRef, statuses: readonly ActiveStatus[], resolve: DefinitionResolver, rules: GameRuleResolution | undefined, battle: BattleCalculationPlan, issues: string[]): { stats: CombatObject; modifiers: EffectiveModifiers; statuses: readonly ActiveStatus[] } {
  const definition = resolve(ref)
  let record = definition?.kind === 'monster' ? definitionSourceRecord(definition) : undefined
  const native = definition && nativeIdentity(definition)
  const mode = rules?.mode ?? 'standard'
  if (native?.database === 'monster' && native.mode === 'base') {
    const patch = combatData.patches.find(patch => patch.name.toLowerCase() === mode)?.records.monster.find(entry => entry.ID === native.databaseId)
    record = record ? { ...record, ...patch } : undefined
  }
  const records: EffectiveModifierRecord[] = [{ record: record ?? {}, ref, label: definition?.name ?? 'Target', group: 'equipment' }, ...statuses.map(status => ({ record: status.record, ref: status.ref, label: String(status.record.Name ?? 'Target status'), group: 'status' as const }))]
  if (battle.targetStatuses.some(status => !nativeStatRecord(status.ref, 'status', resolve, mode))) records.push({ record: {}, label: 'Unresolved target status', group: 'status' })
  const modifiers = applyAutomaticStatuses(aggregateStatModifiers(records, nativeInteger(record?.Level) ? record.Level as number : null, battle.targetTurnCount), nativeInteger(record?.Level) ? record.Level as number : null, resolve, { mode, turnCount: battle.targetTurnCount, statuses: battle.targetStatuses.map(status => status.ref), includeAutomaticStatuses: battle.automaticStatuses, previouslyAppliedStatuses: battle.previouslyAppliedStatuses, currentHP: battle.targetResources.hp })
  const active = appendAutomaticStatuses([...statuses], modifiers)
  const stats = modifierStats(modifiers, 'Target')
  const difficulty = rules?.difficulty
  const unresolved = !record ? 'Target has no supported numeric monster record' : rules?.difficultyIssues.length || !difficulty ? 'Choose a supported Game Setup difficulty for monster stats' : undefined
  if (unresolved) issues.push(unresolved)
  const raw: Record<string, number> = {}
  const failures = new Map<string, string>()
  const number = (field: string) => { if (modifiers.unknownFields.has('*') || modifiers.unknownFields.has(field)) throw new Error(`Target modifier ${field} is unknown`); return requireNumber(modifiers.stats[field], `Target modifier ${field}`) }
  const baseStats = ['HP', 'MP', 'Str', 'Vit', 'Dex', 'Agi', 'Mnd', 'Spi', 'Spd', 'Lck']
  const derivedStats = ['PAtk', 'PDef', 'MDef', 'PCritChance', 'PCritDmg', 'PAccRating', 'PEvaRating', 'PPen', 'MPen', 'PVariance']
  const compute = (key: string, run: () => number) => {
    try { raw[key] = run(); failures.delete(key) }
    catch (error) {
      delete raw[key]
      const message = error instanceof Error ? error.message : `Target ${key} is unknown`
      failures.set(key, message)
      Object.defineProperty(stats, key, { enumerable: true, configurable: true, get: () => { throw new Error(message) } })
    }
  }
  for (const key of [...baseStats, ...derivedStats]) compute(key, () => {
    if (unresolved) throw new Error(unresolved)
    let value = requireNumber(record?.[key], `Target base ${key}`)
    if (baseStats.includes(key) || ['PAtk', 'PDef', 'MDef'].includes(key)) {
      if (['HP', 'MP'].includes(key) && typeof record?.IsBoss !== 'boolean') throw new Error('Target boss classification is unknown')
      const rate = difficulty!.values[`${record?.IsBoss === true && ['HP', 'MP'].includes(key) ? 'Boss' : 'Monster'}${key}Rate`]
      value = calculateCombat(['HP', 'MP'].includes(key) ? 'difficultyVital' : 'difficultyStat', [value, requireNumber(rate, `Target difficulty ${key}`)]) as number
    }
    value = add(value, number(key))
    if (baseStats.includes(key)) value = add(value, percent(value, number(`Bonus${key}Addi`)))
    if (key === 'HP') value = percent(value, add(100, number('BonusHPMult')))
    return value
  })
  compute('AP', () => add(add(BASE_AP_CAPACITY, number('AP')), percent(add(BASE_AP_CAPACITY, number('AP')), number('BonusAPAddi'))))
  const required = (key: string) => { if (failures.has(key)) throw new Error(failures.get(key)!); return requireNumber(raw[key], `Target ${key}`) }
  const critSeed = () => hasTag(modifiers, 'CritFromMndAndSpi') ? add(required('Mnd'), required('Spi')) : required('Dex')
  compute('PCritChance', () => add(required('PCritChance'), calculateFormula('critChance', [critSeed()])))
  compute('PCritDmg', () => add(required('PCritDmg'), calculateFormula('critDamage', [critSeed()])))
  for (const key of ['PAccRating', 'PEvaRating']) compute(key, () => add(required(key), required('Agi')))
  for (const [key, seed] of [['PPen', 'Str'], ['MPen', 'Mnd']]) compute(key!, () => add(required(key!), calculateFormula('penetration', [required(seed!)])))
  for (const key of ['PAtk', 'PDef', 'MDef', 'PAccRating', 'PEvaRating', 'PPen', 'MPen']) compute(key, () => add(required(key), percent(required(key), number(`Bonus${key}Addi`))))
  compute('MP', () => hasTag(modifiers, 'NoMP') ? 0 : required('MP'))
  for (const key of ['PDef', 'MDef']) compute(key, () => hasTag(modifiers, `${key}Max`) ? Math.max(required(key), MAX_DEFENSE_TAG_MINIMUM) : required(key))
  compute('PAtk', () => {
    let value = required('PAtk')
    if (hasTag(modifiers, 'TwoHanded')) value = add(value, calculateFormula('twoHandedAttack', [value, requireNumber(rules?.battleConfig.TwoHandedPAtkFlat, 'Two-handed bonus'), requireNumber(rules?.battleConfig.TwoHandedPAtkRate, 'Two-handed rate')]))
    return hasTag(modifiers, 'DualWield') ? percent(value, requireNumber(rules?.battleConfig.DualWieldPAtkRate, 'Dual-wield rate')) : value
  })
  for (const [key, value] of Object.entries(raw)) Object.defineProperty(stats, key, { enumerable: true, configurable: true, value: Math.max(key === 'HP' ? 1 : 0, value) })
  issues.push(...modifiers.issues)
  return { stats, modifiers, statuses: active }
}

export function calculateBuildCombatPreview(content: BuildRevisionContent, slots: readonly SlotDefinition[], sourceResolve: DefinitionResolver, rules?: GameRuleResolution, unknownInputs: readonly string[] = [], unknownSecondaryClass = false): BuildCombatPreview {
  const scope = calculationModResolver(sourceResolve)
  const resolve = scope.resolve
  const plan = content.calculation
  const battle = plan?.battle
  const mode = rules?.mode ?? plan?.pcMode ?? 'standard'
  const issues: string[] = [...unknownInputs, ...rules?.issues ?? []]
  const unavailable: Record<string, readonly string[]> = {}
  const attempt = (key: string, operation: () => number): number | null => {
    try { return requireNumber(operation(), key) }
    catch (error) { unavailable[key] = [error instanceof Error ? error.message : 'Inputs are unresolved']; return null }
  }
  const selectedStatuses = battle?.statuses ?? []
  const explicit = explicitStatuses(selectedStatuses, resolve, mode, issues)
  const collected = collectEffectiveModifiers(content, slots, resolve, { mode, turnCount: battle ? battle.turnCount : 0, statuses: selectedStatuses.map(status => status.ref), includeAutomaticStatuses: battle?.automaticStatuses ?? false, previouslyAppliedStatuses: battle?.userPreviouslyAppliedStatuses, currentHP: battle?.user.hp })
  const unknownInnates = unknownSecondaryClass && collected.records.some(source => source.group === 'passive' && Array.isArray(source.record.StatMods) && source.record.StatMods.some((mod: NativeRecord) => mod.Tag === TAG_IDS.SubJobInnatePassives))
  if (unknownInnates) issues.push('Secondary class innate modifiers are unknown')
  const modifiers = unknownInputs.length || unknownInnates || rules?.issues.length ? { ...collected, unknownFields: new Set([...collected.unknownFields, '*']) } : collected
  issues.push(...modifiers.issues)
  const active = battle?.automaticStatuses ? appendAutomaticStatuses(explicit, modifiers) : explicit
  const stats = modifierStats(modifiers, 'User')
  const sheet = calculateBuildStats(content, slots, resolve, undefined, rules, unknownInputs, unknownSecondaryClass)
  for (const [key, native] of Object.entries(CORE_NAMES)) {
    const range = sheet.stats[key as CalculatedStat].value
    guarded(stats, native, range?.low, `User ${key}`, range !== null && range.low === range.high)
  }
  const ap = attempt('Maximum AP', () => { if (modifiers.unknownFields.has('*')) throw new Error('User modifiers are unknown'); const flat = requireNumber(modifiers.stats.AP, 'User AP modifier'); const rate = requireNumber(modifiers.stats.BonusAPAddi, 'User AP percentage modifier'); const subtotal = add(BASE_AP_CAPACITY, flat); return Math.max(0, Math.min(MEMBER_AP_CAPACITY_LIMIT, add(subtotal, percent(subtotal, rate)))) })
  guarded(stats, 'AP', ap, 'User maximum AP', ap !== null)
  const user = battler(stats, battle?.user, active, true, 'User')
  const ability = plan?.ability ? nativeStatRecord(plan.ability, 'ability', resolve, mode) : undefined
  const costs = Object.fromEntries(ABILITY_COSTS.map(cost => [cost, attempt(`${cost} cost`, () => {
    if (!ability) throw new Error('Choose an ability with supported numeric data')
    if (issues.length && (unknownInputs.length || rules?.issues.length || scope.issues.size)) throw new Error(issues[0]!)
    if (cost === 'HP' && ability.HPCost === 0) return 0
    return calculateCombat(COST_FORMULAS[cost], [user, ability as CombatValue]) as number
  })])) as unknown as AbilityEstimate['costs']
  const baseCosts = Object.fromEntries(ABILITY_COSTS.map(cost => [cost, nativeInteger(ability?.[`${cost}Cost`]) ? ability![`${cost}Cost`] : null])) as AbilityEstimate['costs']
  const targetExplicit = battle ? explicitStatuses(battle.targetStatuses, resolve, mode, issues) : []
  const monster = battle && battle.target && battle.target !== 'self' ? monsterStats(battle.target, targetExplicit, resolve, rules, battle, issues) : undefined
  const target = battle?.target === 'self' ? user : monster ? battler(monster.stats, battle?.targetResources, monster.statuses, false, 'Target') : undefined
  const targetMods = battle?.target === 'self' ? modifiers : monster?.modifiers
  const targetActive = battle?.target === 'self' ? active : monster?.statuses ?? []
  const context: CombatObject = { config: (rules?.battleConfig ?? NATIVE_DATA.battleConfig) as CombatValue, sameBattler: battle?.target === 'self', calcTestMode: false }
  for (const key of ['bottomThreat', 'topThreat', 'targetIsThreatTarget', 'targetCharging', 'repeatCount'] as const) guarded(context, key, battle?.[key], key, battle?.[key] != null)
  guarded(context, 'userBuffCount', new Set(active.filter(status => status.record.Category === BUFF_CATEGORY).map(status => status.record.ID)).size, 'Actor active buff count', !active.some(status => status.uncertain && (status.record.Category === undefined || status.record.Category === BUFF_CATEGORY)))
  guarded(context, 'targetDebuffCount', new Set(targetActive.filter(status => status.record.Category === DEBUFF_CATEGORY).map(status => status.record.ID)).size, 'Target active debuff count', !targetActive.some(status => status.uncertain && (status.record.Category === undefined || status.record.Category === DEBUFF_CATEGORY)))
  const calculate = (key: string, formula: string, extra: readonly CombatValue[] = []) => attempt(key, () => {
    if (!ability) throw new Error('Choose an ability with supported numeric data')
    if (!target) throw new Error('Choose a battle target')
    if (rules?.issues.length) throw new Error(rules.issues[0]!)
    return calculateCombat(formula, [user, target, ability as CombatValue, ...(formula === 'critChance' ? [] : [context]), ...extra]) as number
  })
  const damage = calculate('Damage', 'damage', [false])
  const criticalDamage = calculate('Critical damage', 'damage', [true])
  const baseHit = calculate('Hit chance', 'hitChance')
  const hitChance = baseHit === null ? null : attempt('Hit chance', () => {
    if (baseHit === 0 || baseHit === 100) return baseHit
    return calculateCombat('difficultyHit', [baseHit, requireNumber(rules?.difficulty?.values.MemberHitChanceMod, 'Game Setup difficulty hit modifier')]) as number
  })
  const criticalChance = calculate('Critical chance', 'critChance')
  const variance = damage === null || !ability ? null : attempt('Variance', () => calculateCombat('variance', [damage, user, ability as CombatValue]) as number)
  const criticalVariance = criticalDamage === null || !ability ? null : attempt('Critical variance', () => calculateCombat('variance', [criticalDamage, user, ability as CombatValue]) as number)
  if (variance === null && !unavailable.Variance) unavailable.Variance = unavailable.Damage ?? ['Damage inputs are unresolved']
  if (criticalVariance === null && !unavailable['Critical variance']) unavailable['Critical variance'] = unavailable['Critical damage'] ?? ['Critical damage inputs are unresolved']
  const periodic = Object.fromEntries(['HP', 'MP', 'AP'].map(resource => [resource, attempt(`${resource} per turn`, () => {
    if (rules?.issues.length) throw new Error(rules.issues[0]!)
    const rate = requireNumber(stats[`DamagePerTurn${resource}Addi`], `${resource} per-turn rate`)
    const flat = requireNumber(stats[`DamagePerTurn${resource}Flat`], `${resource} per-turn amount`)
    if (rate === 0 && flat === 0) return 0
    const inputs: CombatValue[] = [rate === 0 ? 0 : stats[resource]!, rate, flat]
    if (resource === 'HP') inputs.push(stats.PercentDmgTakenMult!, stats.DamageTakenPerTurnMult!, stats.HealingTakenPerTurnMult!, rate > 0 ? stats.Vit! : 0, rate < 0 ? stats.Spi! : 0)
    inputs.push(hasTag(modifiers, 'DisableLifestealAndRegen'))
    return calculateCombat(resource === 'HP' ? 'periodicHP' : 'periodicResource', inputs) as number
  })])) as BuildCombatPreview['periodic']
  const statuses: CombatStatusPreview[] = []
  const applications: { entry: NativeRecord; source: EntityRef; recipient: 'user' | 'target'; condition?: string }[] = []
  if (ability && plan?.ability) {
    for (const [field, recipient] of [['UserStatuses', 'user'], ['TargetStatuses', 'target']] as const) {
      const randomTag = Number(Object.entries(combatData.enums.SangAbilityModTag).find(([, name]) => name === (recipient === 'user' ? 'RandomStatusUser' : 'RandomStatusTarget'))?.[0])
      const random = Array.isArray(ability.AbilityMods) && ability.AbilityMods.some((mod: NativeRecord) => mod.Tag === randomTag)
      if (Array.isArray(ability[field])) for (const entry of ability[field] as readonly NativeRecord[]) applications.push({ entry, source: plan.ability, recipient, ...(random ? { condition: 'Chance is conditional on this status being randomly selected' } : {}) })
    }
    if (ability.IsPAbil === true) {
      if (modifiers.unknownFields.has('PStatusApplies') || modifiers.unknownFields.has('*')) issues.push('Some physical on-hit status effects are unresolved')
      for (const status of modifiers.physicalStatuses) if (status.ref) applications.push({ entry: { StatusID: status.id, Chance: status.chance, Count: status.count }, source: status.ref, recipient: 'target', condition: 'Applied by a physical on-hit modifier' })
    }
  }
  for (const { entry, source, recipient, condition } of applications) {
      const linked = nativeInteger(entry.StatusID) ? resolveLinkedStatus(source, entry.StatusID, resolve, mode) : {}
      const status = linked.record
      const name = String(status?.Name ?? `Status ${entry.StatusID}`)
      const receivingMods = recipient === 'user' ? modifiers : targetMods
      const history = recipient === 'user' || battle?.target === 'self' ? battle?.userPreviouslyAppliedStatuses : battle?.previouslyAppliedStatuses
      const chance = attempt(`${name} chance (${recipient})`, () => {
        if (rules?.issues.length) throw new Error(rules.issues[0]!)
        if (!status || !receivingMods || !battle) throw new Error('Status data or battle recipient is unresolved')
        const count = requireNumber(entry.Count, 'Status count')
        const baseChance = requireNumber(entry.Chance, 'Status chance')
        if (count === 0) return 0
        if (count < 0) {
          if (typeof status.PreventRemoval !== 'boolean') throw new Error('Status removal behavior is unknown')
          return status.PreventRemoval ? 0 : baseChance
        }
        const hp = recipient === 'user' || battle.target === 'self' ? battle.user.hp : battle.targetResources.hp
        if (status.PersistsThroughDeath !== true) {
          if (hp === null) throw new Error('Recipient current HP is unknown')
          if (hp === 0) {
            if (typeof status.PersistsThroughDeath !== 'boolean') throw new Error('Status behavior after death is unknown')
            return 0
          }
        }
        if (receivingMods.unknownFields.has('*') || receivingMods.unknownFields.has('StatusImmunity') || receivingMods.unknownFields.has('ImmuneToStatusCategory')) throw new Error('Status immunity inputs are unknown')
        const immuneByID = receivingMods.statusImmunities.includes(requireNumber(status.ID, 'Status identity'))
        const immuneByCategory = receivingMods.statusImmunityCategories.length > 0 && receivingMods.statusImmunityCategories.includes(requireNumber(status.Category, 'Status category'))
        if (immuneByID || immuneByCategory) return 0
        if (typeof status.ReApplyResistance !== 'boolean') throw new Error('Status reapplication behavior is unknown')
        let previously = false
        if (status.ReApplyResistance) {
          const previousIDs = (history ?? []).map(ref => nativeStatRecord(ref, 'status', resolve, mode)?.ID)
          previously = previousIDs.includes(entry.StatusID)
          if (!previously && previousIDs.some(id => !nativeInteger(id))) throw new Error('Previously applied status identity is unresolved')
        }
        return calculateCombat('statusChance', [baseChance, false, false, status.ReApplyResistance, previously]) as number
      })
      const duration = attempt(`${name} duration (${recipient})`, () => {
        if (rules?.issues.length) throw new Error(rules.issues[0]!)
        if (!status || !receivingMods) throw new Error('Status data or recipient modifiers are unresolved')
        const count = requireNumber(entry.Count, 'Status count')
        if (count <= 0 || count === 255) return count
        const category = requireNumber(status.Category, 'Status category')
        const type = category === BUFF_CATEGORY ? 'Buff' : category === DEBUFF_CATEGORY ? 'Debuff' : undefined
        if (!type) return count
        if (hasTag(modifiers, `Applied${type}sArePerma`)) return 255
        return calculateCombat('statusDuration', [count, category, false, false, modifierNumber(receivingMods, `${type}DurationFlat`, 'Received duration modifier'), modifierNumber(modifiers, `Apply${type}DurationFlat`, 'Applied duration modifier'), modifierNumber(receivingMods, `${type}DurationAddi`, 'Received duration rate'), modifierNumber(modifiers, `Apply${type}DurationAddi`, 'Applied duration rate')]) as number
      })
      statuses.push({ name, recipient, chance, duration, ...(condition ? { condition } : {}) })
  }
  const maximaOf = (value: CombatObject): BattleCalculationPlan['user'] => Object.fromEntries(Object.entries(RESOURCE_FIELDS).map(([key, field]) => { try { return [key, requireNumber(value[field], field)] } catch { return [key, null] } })) as unknown as BattleCalculationPlan['user']
  const maxima = { user: maximaOf(stats), target: battle?.target === 'self' ? maximaOf(stats) : monster ? maximaOf(monster.stats) : null }
  return { costs, baseCosts, maxima, damage, criticalDamage, hitChance, criticalChance, variance, criticalVariance, periodic, statuses, issues: [...new Set([...issues, ...scope.issues])], unavailable, notes: ['Damage and healing are calculated before variance, random rolls, survival effects, and resource limits.', 'Hit, critical, and status chances are shown before Luck and failure-counter adjustments.', ...(battle?.automaticStatuses ? ['Includes guaranteed automatic statuses. Select chance-based or possibly expired statuses only if they are active.'] : [])] }
}
