import { collectEffectiveModifiers } from './effective-modifiers'
import { nativeStatRecord, type NativeRecord } from './native-stat-record'
export { nativeStatRecord, type NativeRecord } from './native-stat-record'
import type { DefinitionResolver as Resolve } from './build-mechanics'
import { calculationModResolver } from './calculation-mods'
import type { GameRuleResolution } from './game-rules'
import { calculateFormula, evaluateExpression, NATIVE_DATA, PC_MODEL, PC_RULES } from './calculation-rules'
import { equipmentRole } from './mechanics-facts'
import { nativeInteger } from './native-number'
import { MAX_GROWTH_RATING } from './crystal-edit'
import type { BuildCalculationPlan, BuildRevisionContent, SlotDefinition } from './types'
import { entityDefinitionKey } from './core'
import { calculationGenderId, nativeGenderDefinitions, type GenderDefinition } from './calculation-genders'

export type PCStats = Readonly<Record<string, number | null>>
export const BATTLE_START_STATUS_LIMITATION = 'automatic battle-start status'
export const PC_STAT_FIELDS: Readonly<Record<string, string>> = Object.freeze({ HP: 'HP', MP: 'MP', AP: 'AP', STR: 'Str', VIT: 'Vit', DEX: 'Dex', AGI: 'Agi', MND: 'Mnd', SPI: 'Spi', SPD: 'Spd', LUK: 'Lck', ATK: 'PAtk', DEF: 'PDef', RES: 'MDef', CRIT: 'PCritChance', CRIT_DAMAGE: 'PCritDmg', ACC: 'PAccRating', EVA: 'PEvaRating', PPEN: 'PPen', MPEN: 'MPen', TT: 'TT' })
export interface PCStatResult {
  readonly base: PCStats
  readonly neutral: PCStats
  readonly male: PCStats
  readonly female: PCStats
  readonly genders: Readonly<Record<string, PCStats>>
  readonly issues: readonly string[]
  readonly effects: readonly string[]
}

export function selectedPCStats(result: PCStatResult, gender: BuildCalculationPlan['gender'], selection?: BuildCalculationPlan['genderSelection']): PCStats {
  return selection ? result.genders[selection.id] ?? unknownStats() : gender ? result[gender] : result.neutral
}
const number = (record: NativeRecord | undefined, key: string) => nativeInteger(record?.[key]) ? record[key] as number : undefined
const unknownStats = (): PCStats => Object.fromEntries(Object.keys(PC_RULES.stats).map(stat => [stat, null]))

export function calculatePCStats(content: BuildRevisionContent, slots: readonly SlotDefinition[], resolve: Resolve, unknownInputs: readonly string[] = [], unknownSecondaryClass = false, gameRules?: GameRuleResolution): PCStatResult {
  try { return calculateNativeStats(content, slots, resolve, unknownInputs, unknownSecondaryClass, gameRules) }
  catch {
    const empty = unknownStats()
    return { base: empty, neutral: empty, male: empty, female: empty, genders: {}, effects: [], issues: [...unknownInputs, ...gameRules?.issues ?? [], 'Native arithmetic is outside the supported range.'] }
  }
}

function calculateNativeStats(content: BuildRevisionContent, slots: readonly SlotDefinition[], sourceResolve: Resolve, unknownInputs: readonly string[], unknownSecondaryClass: boolean, gameRules?: GameRuleResolution): PCStatResult {
  const modScope = calculationModResolver(sourceResolve)
  const resolve = modScope.resolve
  const plan = content.calculation
  const issues = [...unknownInputs, ...(gameRules?.issues ?? [])]
  const effects = new Set<string>()
  const mode = gameRules?.mode ?? plan?.pcMode ?? 'standard'
  const primary = nativeStatRecord(content.primaryClass, 'job', resolve, mode)
  const empty = unknownStats()
  if (gameRules?.issues.length) return { base: empty, neutral: empty, male: empty, female: empty, genders: {}, issues: [...issues, ...modScope.issues], effects: [] }
  if (!plan || plan.model !== undefined && plan.model !== PC_MODEL || !primary || plan.level === null || !Number.isInteger(plan.level) || plan.level < 1 || plan.level > PC_RULES.limits.levelCap) {
    if (!primary && !modScope.issues.size) issues.push('Primary class has no verified numeric record.')
    else if (primary) issues.push('Choose a supported native calculation level.')
    return { base: empty, neutral: empty, male: empty, female: empty, genders: {}, issues: [...issues, ...modScope.issues], effects: [] }
  }
  const level = plan.level
  const growth: Record<string, number> = Object.fromEntries(PC_RULES.coreStats.map(stat => [stat, 0]))
  let growthKnown = true
  let allocated = 0
  for (const row of plan.growth) {
    if (row.levels === null || !Number.isInteger(row.levels) || row.levels < 0 || row.levels > PC_RULES.limits.levelCap) { growthKnown = false; continue }
    allocated += row.levels
    if (row.levels === 0) continue
    const job = nativeStatRecord(row.classRef, 'job', resolve, mode)
    for (const stat of PC_RULES.coreStats) {
      const rating = number(job, PC_RULES.stats[stat]!.rating!)
      if (rating === undefined || rating < 0 || rating > MAX_GROWTH_RATING) growthKnown = false
      else growth[stat]! += row.levels * rating
    }
  }
  if (allocated !== level) { growthKnown = false; issues.push(`Growth allocates ${allocated} of ${level} levels. Allocate exactly the calculation level.`) }
  if (!growthKnown) issues.push('Growth is incomplete or a selected class lacks verified ratings.')
  const gear = slots.map(slot => {
    const selection = content.equipment[slot.id]
    const record = selection ? nativeStatRecord(selection.ref, 'equipment', resolve, mode) : undefined
    if (selection && (!record || !Array.isArray(record.StatMods))) issues.push(`${slot.label}: numeric equipment effects are unknown.`)
    if (selection && !equipmentRole(slot)) issues.push(`${slot.label}: its game equipment role is unknown.`)
    return { slot, selection, record }
  })
  if (Object.keys(content.equipment).some(id => !slots.some(slot => slot.id === id) && content.equipment[id])) issues.push('Selected equipment exists outside the mapped slot layout.')
  const main = gear.find(entry => equipmentRole(entry.slot) === 'mainHand')
  const off = gear.find(entry => equipmentRole(entry.slot) === 'offHand')
  if (main?.selection?.allocationId && main.selection.allocationId === off?.selection?.allocationId) {
    // Two hand selections can represent one physical copy, whose modifiers count only once
    if (entityDefinitionKey(main.selection.ref) !== entityDefinitionKey(off.selection.ref)) issues.push('A shared weapon copy has conflicting identities.')
    else { off.selection = null; off.record = undefined }
  }
  if (gear.filter(entry => equipmentRole(entry.slot) === 'mainHand').length !== 1 || gear.filter(entry => equipmentRole(entry.slot) === 'offHand').length !== 1) issues.push('Map exactly one main-hand and one off-hand slot for verified weapon calculations.')
  const isWeapon = (record?: NativeRecord) => record && PC_RULES.equipment.weaponTypes.includes(number(record, 'EquipmentType') ?? -1)
  const unarmed = !main?.selection && !off?.selection
  const battle = plan.battle
  const modifiers = collectEffectiveModifiers(content, slots, sourceResolve, { mode, turnCount: battle ? battle.turnCount : 0, statuses: battle?.statuses.map(status => status.ref), includeAutomaticStatuses: battle?.automaticStatuses, previouslyAppliedStatuses: battle?.userPreviouslyAppliedStatuses, currentHP: battle?.user.hp })
  if (modifiers.tags.has('SubJobInnatePassives') && !content.secondaryClass && unknownSecondaryClass) issues.push('Secondary class is unknown and its innates affect this loadout.')
  if (!battle && plan.statuses.length) issues.push('Saved legacy status assumptions require explicit adoption into a battle snapshot.')
  if (plan.bonuses.length) issues.push('Per-stat bonus assumptions are outside the native gender comparisons.')
  const fatal = issues.length > 0 || modifiers.unknownFields.has('*') || modScope.issues.size > 0
  issues.push(...modifiers.issues)
  for (const record of modifiers.records) for (const mod of Array.isArray(record.record.StatMods) ? record.record.StatMods : []) {
    const mapped = PC_RULES.statMods[String(mod.Tag)]
    if (mapped?.scope === 'battle') effects.add(`${record.label}: ${mapped.name}`)
  }
  if (!battle) for (const status of modifiers.automaticStatuses) effects.add(`${BATTLE_START_STATUS_LIMITATION}${typeof status.record?.Name === 'string' ? ` "${status.record.Name}"` : ` #${status.id}`} is excluded from resting stats; enable a battle snapshot to include its applicable effects.`)
  const tags = modifiers.tags
  const weaponAttack = main?.record && Array.isArray(main.record.StatMods) ? number((main.record.StatMods as NativeRecord[]).find(mod => PC_RULES.statMods[String(mod.Tag)]?.stat === 'ATK' && PC_RULES.statMods[String(mod.Tag)]?.scale === 'direct' && PC_RULES.statMods[String(mod.Tag)]?.kind === 'flat'), 'Value1') : undefined
  const vars: Record<string, number> = { 'context.unarmed': Number(unarmed), 'context.dualWield': Number(unarmed || Boolean(isWeapon(main?.record) && isWeapon(off?.record))), 'context.twoHanded': Number(Boolean(main?.record && isWeapon(main.record) && main.record.IsTwoHanded === false && !off?.selection && weaponAttack !== undefined)), 'context.weaponAttack': weaponAttack ?? 0 }
  if (modifiers.stats.BonusHPMult !== null) vars.hpMultiplier = modifiers.stats.BonusHPMult!
  if (modifiers.stats.TTNextTurnMult !== null) vars.ttMultiplier = modifiers.stats.TTNextTurnMult!
  for (const [key, value] of Object.entries(gameRules?.battleConfig ?? NATIVE_DATA.battleConfig)) if (typeof value === 'number') vars[`config.${key}`] = value
  for (const mod of Object.values(PC_RULES.statMods)) if (!modifiers.unknownFields.has(`tag.${mod.name}`)) vars[`tag.${mod.name}`] = Number(tags.has(mod.name))
  issues.push(...modScope.issues)
  const base: Record<string, number | null> = { ...empty }
  const genderIssues: string[] = []
  const sheet = (gender?: GenderDefinition): PCStats => {
    if (gender?.issues.length) { genderIssues.push(...gender.issues); return empty }
    const scope = { ...vars }
    let known = growthKnown
    for (const [stat, descriptor] of Object.entries(PC_RULES.stats)) {
      let start = descriptor.base ?? 0
      if (descriptor.formula) {
        const rating = number(primary, descriptor.rating!)
        if (rating === undefined || rating < 0 || rating > MAX_GROWTH_RATING || !growthKnown) { known = false; continue }
        start = calculateFormula(descriptor.formula, [level, rating, growth[stat]!, Number(gender?.boosts[stat as keyof GenderDefinition['boosts']] === true)])
      }
      if (!gender) base[stat] = start
      const field = PC_STAT_FIELDS[stat]!
      const flat = modifiers.stats[field]
      const percentField = `Bonus${field}Addi`
      const percent = Object.hasOwn(modifiers.stats, percentField) ? modifiers.stats[percentField] : 0
      if (flat !== null) scope[`stat.${stat}`] = evaluateExpression(['add', start, flat!], {})
      if (percent !== null) scope[`percent.${stat}`] = percent!
    }
    // Unresolved effects block a complete sheet total even when base growth is known
    if (!known || fatal) return empty
    const unavailable = new Set<string>()
    // Each native stage consumes earlier results, including their truncation and caps
    for (const stage of PC_RULES.sheetStages) {
      try { scope[`stat.${stage.stat}`] = evaluateExpression(stage.value, scope) }
      catch { delete scope[`stat.${stage.stat}`]; unavailable.add(stage.stat) }
    }
    for (const stat of unavailable) if (scope[`stat.${stat}`] === undefined) genderIssues.push(`${stat}: a required calculation input is unavailable.`)
    return Object.fromEntries(Object.keys(PC_RULES.stats).map(stat => [stat, scope[`stat.${stat}`] ?? null]))
  }
  const neutral = sheet()
  const definitions = gameRules?.genders ?? nativeGenderDefinitions(mode)
  const selected = calculationGenderId(plan)
  const genders = Object.fromEntries(definitions.filter(gender => gender.id === PC_RULES.genders.male || gender.id === PC_RULES.genders.female || gender.id === selected).map(gender => [gender.id, sheet(gender)]))
  if (selected !== undefined && !Object.hasOwn(genders, selected)) genderIssues.push(`Gender #${selected} is unavailable in this Game Setup. Select an enabled source version or another calculation gender.`)
  const male = genders[PC_RULES.genders.male] ?? empty
  const female = genders[PC_RULES.genders.female] ?? empty
  return { base, neutral, male, female, genders, issues: [...new Set([...issues, ...genderIssues])], effects: [...effects] }
}

export function benchmarkDamage(stats: PCStats, id: string): number | null {
  const benchmark = PC_RULES.benchmarks.find(benchmark => benchmark.id === id)
  if (!benchmark) return null
  const attack = stats[benchmark.attack], main = stats[benchmark.main], pierce = stats[benchmark.pierce]
  if (attack == null || main == null || pierce == null) return null
  try { return calculateFormula('benchmarkDamage', [attack, main, benchmark.basePower, benchmark.attackRate, benchmark.statRate, benchmark.targetMain, benchmark.defense, pierce]) }
  catch { return null }
}
