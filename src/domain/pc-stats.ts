import { calculationModResolver } from './calculation-mods'
import type { GameRuleResolution } from './game-rules'
import { calculateFormula, evaluateExpression, NATIVE_DATA, PC_MODEL, PC_RULES } from './calculation-rules'
import { definitionSourceRecord, equipmentRole, type MechanicsDefinition } from './mechanics-facts'
import { nativeEntityId, nativeIdentity } from './native-game'
import { nativeInteger } from './native-number'
import { jsonRecord, MAX_GROWTH_RATING } from './crystal-edit'
import type { BuildCalculationPlan, BuildRevisionContent, EntityRef, SlotDefinition } from './types'
import { entityDefinitionKey } from './core'
import { catalogClassSource } from './build-mechanics'
import { bundledModEntityId, bundledModIdentity } from './bundled-mods'
import { crystalEditPlanningRecord, CRYSTAL_EDIT_VERSION_FIELD, supportsCrystalEditVersion } from './crystal-edit-compatibility'
import { calculationGenderId, nativeGenderDefinitions, type GenderDefinition } from './calculation-genders'

export type NativeRecord = Readonly<Record<string, unknown>>
type Family = 'job' | 'equipment' | 'passive' | 'gender' | 'ability' | 'status'
type Resolve = (ref: EntityRef) => MechanicsDefinition | undefined
export type PCStats = Readonly<Record<string, number | null>>
export const BATTLE_START_STATUS_LIMITATION = 'automatic battle-start status'
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
const crystalRecord = (definition: MechanicsDefinition | undefined): NativeRecord | undefined => {
  return crystalEditPlanningRecord(definition)
}

function nativeById(family: Family, id: number, mode: string): NativeRecord | undefined {
  const base = NATIVE_DATA.records[family].find(record => record.ID === id)
  const patch = mode === 'standard' ? undefined : NATIVE_DATA.patches.find(patch => patch.name.toLowerCase() === mode)?.records[family].find(record => record.ID === id)
  return base ? { ...base, ...patch } : undefined
}

export function nativeStatRecord(ref: EntityRef | null, family: Family, resolve: Resolve, mode = 'standard'): NativeRecord | undefined {
  if (!ref) return undefined
  const definition = resolve(ref)
  if (!definition || (family === 'job' ? definition.kind !== 'class' : family === 'passive' ? !['passive', 'innate'].includes(definition.kind) : family === 'equipment' ? definition.kind !== 'item' : family === 'ability' ? !['ability', 'monsterMagic'].includes(definition.kind) : false)) return undefined
  const explicit = crystalRecord(definition)
  if (explicit) return explicit
  const native = definitionSourceRecord(definition)
  if (native) {
    const identity = nativeIdentity(definition)
    const patch = identity?.database === family && identity.mode === 'base' && mode !== 'standard' ? NATIVE_DATA.patches.find(patch => patch.name.toLowerCase() === mode)?.records[family].find(record => record.ID === identity.databaseId) : undefined
    return { ...native, ...patch }
  }
  const bindings = NATIVE_DATA.bindings as Readonly<Record<string, { readonly family: string; readonly id: number }>>
  const binding = ref.kind === 'catalog' && ref.catalogId === NATIVE_DATA.catalogId ? bindings[ref.entityId] : undefined
  if (binding?.family === family) return nativeById(family, binding.id, mode)
  return undefined
}

export function calculatePCStats(content: BuildRevisionContent, slots: readonly SlotDefinition[], resolve: Resolve, unknownInputs: readonly string[] = [], unknownSecondaryClass = false, gameRules?: GameRuleResolution): PCStatResult {
  try { return calculateRestingStats(content, slots, resolve, unknownInputs, unknownSecondaryClass, gameRules) }
  catch {
    const empty = unknownStats()
    return { base: empty, neutral: empty, male: empty, female: empty, genders: {}, effects: [], issues: [...unknownInputs, ...gameRules?.issues ?? [], 'Native arithmetic is outside the supported range.'] }
  }
}

function calculateRestingStats(content: BuildRevisionContent, slots: readonly SlotDefinition[], sourceResolve: Resolve, unknownInputs: readonly string[], unknownSecondaryClass: boolean, gameRules?: GameRuleResolution): PCStatResult {
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
    if (entityDefinitionKey(main.selection.ref) !== entityDefinitionKey(off.selection.ref)) issues.push('A shared weapon copy has conflicting identities.')
    else { off.selection = null; off.record = undefined }
  }
  if (gear.filter(entry => equipmentRole(entry.slot) === 'mainHand').length !== 1 || gear.filter(entry => equipmentRole(entry.slot) === 'offHand').length !== 1) issues.push('Map exactly one main-hand and one off-hand slot for verified weapon calculations.')
  const isWeapon = (record?: NativeRecord) => record && PC_RULES.equipment.weaponTypes.includes(number(record, 'EquipmentType') ?? -1)
  const unarmed = !main?.selection && !off?.selection
  const paired = new Set<NativeRecord>()
  for (const role of ['hand', 'accessory']) {
    const candidates = gear.filter(entry => role === 'hand' ? ['mainHand', 'offHand'].includes(equipmentRole(entry.slot) ?? '') : equipmentRole(entry.slot) === 'accessory')
    if (candidates.length === 2 && candidates[0]!.record && candidates[1]!.record && number(candidates[0]!.record, 'ID') === number(candidates[1]!.record, 'ID') && number(candidates[0]!.record, 'ID') !== undefined) {
      const mods = candidates[0]!.record.StatMods as readonly NativeRecord[]
      if (mods?.some(mod => mod.Tag === PC_RULES.equipment.pairedTag)) candidates.forEach(entry => paired.add(entry.record!))
    }
  }
  type Group = { flat: Record<string, number>; percent: Record<string, number>; tt: number; hp: number; tags: Set<string> }
  const group = (): Group => ({ flat: Object.fromEntries(Object.keys(PC_RULES.stats).map(stat => [stat, PC_RULES.modifierDefaults.flat])), percent: Object.fromEntries(Object.keys(PC_RULES.stats).map(stat => [stat, PC_RULES.modifierDefaults.percent])), tt: PC_RULES.modifierDefaults.tt, hp: PC_RULES.modifierDefaults.hp, tags: new Set() })
  const equipment = group(), passives = group()
  const apply = (record: NativeRecord, target: Group, label: string, nativeStatuses = false) => {
    if (!Array.isArray(record.StatMods)) { issues.push(`${label}: numeric effects are unknown.`); return }
    for (const mod of record.StatMods as readonly NativeRecord[]) {
      const tag = number(mod, 'Tag'), value = number(mod, 'Value1')
      const mapped = tag === undefined ? undefined : PC_RULES.statMods[String(tag)]
      if (!mapped || value === undefined) { issues.push(`${label}: invalid or unsupported numeric modifier.`); continue }
      try {
        if (mapped.kind === 'tag') {
          target.tags.add(mapped.name)
          if (mapped.scope === 'context') {
            const status = nativeStatuses && mapped.name === 'StatusAuto' ? nativeById('status', value, mode)?.Name : undefined
            issues.push(`${label}: ${BATTLE_START_STATUS_LIMITATION}${typeof status === 'string' ? ` "${status}"` : ' effects'} cannot be calculated by the resting-stat preview.`)
          }
          else if (mapped.scope === 'battle') effects.add(`${label}: ${mapped.name}`)
        } else if (mapped.kind === 'allCore') {
          for (const stat of PC_RULES.coreStats) target.flat[stat] = evaluateExpression(['add', target.flat[stat]!, value], {})
        } else if (mapped.kind === 'ttMultiplier') target.tt = calculateFormula('multiplyPercent', [target.tt, value])
        else if (mapped.kind === 'hpMultiplier') target.hp = evaluateExpression(['add', target.hp, value], {})
        else {
          const amount = mapped.scale === 'PerLevel' ? calculateFormula('perLevel', [value, level, number(mod, 'Value2') ?? NaN]) : mapped.scale === 'PerTurn' ? calculateFormula('perTurn', [value, PC_RULES.contexts.turnCount, number(mod, 'Value2') ?? NaN]) : value
          const values = mapped.kind === 'percent' ? target.percent : target.flat
          values[mapped.stat!] = evaluateExpression(['add', values[mapped.stat!]!, amount], {})
        }
      } catch { issues.push(`${label}: a numeric modifier cannot be calculated.`) }
    }
  }
  for (const entry of gear) if (entry.record) {
    const definition = resolve(entry.selection!.ref)
    apply(entry.record, equipment, definition?.name ?? entry.slot.label, Boolean(definition && nativeIdentity(definition) && !crystalRecord(definition)))
    if (paired.has(entry.record)) apply(entry.record, equipment, 'Paired equipment bonus')
  }
  const addInnates = (ref: EntityRef | null, job: NativeRecord) => {
    if (!Array.isArray(job.PassiveIDs)) { issues.push('Class innate list is unknown.'); return }
    const source = ref ? catalogClassSource(ref, resolve) : undefined
    const definition = source?.definition
    const binding = !crystalRecord(definition) && (nativeIdentity(definition ?? { fields: {} })?.database === 'job' || source?.ref.catalogId === NATIVE_DATA.catalogId && Object.hasOwn(NATIVE_DATA.bindings, source.ref.entityId))
    const mod = definition && 'legacy' in definition ? bundledModIdentity(definition) : undefined
    const metadata = definition && 'legacy' in definition && jsonRecord(definition.legacy) ? definition.legacy : undefined
    const links = jsonRecord(metadata?.passiveEntityIds) ? metadata.passiveEntityIds : {}
    const model = definition?.fields['Crystal Edit model type']
    const version = definition?.fields[CRYSTAL_EDIT_VERSION_FIELD]
    const imported = model?.state === 'known' && model.value === 'Jobs' && version?.state === 'known' && supportsCrystalEditVersion(version.value)
    for (const id of job.PassiveIDs as unknown[]) {
      const target = typeof id === 'number' ? links[String(id)] ?? (mod ? bundledModEntityId(mod.key, 'Passives', id) : undefined) : undefined
      const linked = source && typeof target === 'string' ? nativeStatRecord({ ...source.ref, entityId: target as typeof source.ref.entityId }, 'passive', resolve, mode) : undefined
      const native = source && typeof id === 'number' && binding ? nativeStatRecord({ ...source.ref, entityId: nativeEntityId('passive', id) }, 'passive', resolve, mode) : undefined
      const passive = typeof target === 'string' ? linked : native ?? (typeof id === 'number' && (binding || imported) ? nativeById('passive', id, mode) : undefined)
      if (!passive || typeof passive.IsInnate !== 'boolean') { issues.push('A class passive record is unavailable; its innate effects are unknown.'); continue }
      if (passive.IsInnate) apply(passive, passives, typeof passive.Name === 'string' ? passive.Name : 'Class innate', Boolean(binding))
    }
  }
  addInnates(content.primaryClass, primary)
  for (const selection of content.passives) {
    const record = nativeStatRecord(selection.ref, 'passive', resolve, mode)
    const definition = resolve(selection.ref)
    if (record) apply(record, passives, definition?.name ?? 'Equipped passive', Boolean(definition && nativeIdentity(definition) && !crystalRecord(definition)))
    else issues.push(`${resolve(selection.ref)?.name ?? 'Equipped passive'}: numeric effects are unknown.`)
  }
  if (passives.tags.has(PC_RULES.statMods[String(PC_RULES.equipment.secondaryInnatesTag)]!.name)) {
    if (content.secondaryClass) {
      const secondary = nativeStatRecord(content.secondaryClass, 'job', resolve, mode)
      if (secondary) addInnates(content.secondaryClass, secondary)
      else issues.push('Secondary-class innate effects are unknown.')
    } else if (unknownSecondaryClass) issues.push('Secondary class is unknown and its innates affect this loadout.')
  }
  if (plan.statuses.length) issues.push('Active status effects are outside this resting character calculation.')
  if (plan.bonuses.length) issues.push('Per-stat bonus assumptions are outside the native gender comparisons.')
  for (const target of [equipment, passives]) if (![...Object.values(target.flat), ...Object.values(target.percent), target.tt, target.hp].every(nativeInteger)) issues.push('Accumulated modifiers exceed the supported native integer range.')
  const tags = new Set([...equipment.tags, ...passives.tags])
  const weaponAttack = main?.record && Array.isArray(main.record.StatMods) ? number((main.record.StatMods as NativeRecord[]).find(mod => PC_RULES.statMods[String(mod.Tag)]?.stat === 'ATK' && PC_RULES.statMods[String(mod.Tag)]?.scale === 'direct' && PC_RULES.statMods[String(mod.Tag)]?.kind === 'flat'), 'Value1') : undefined
  const vars: Record<string, number> = { hpMultiplier: evaluateExpression(['add', equipment.hp, passives.hp], {}), ttMultiplier: calculateFormula('multiplyPercent', [equipment.tt, passives.tt]), 'context.unarmed': Number(unarmed), 'context.dualWield': Number(unarmed || Boolean(isWeapon(main?.record) && isWeapon(off?.record))), 'context.twoHanded': Number(Boolean(main?.record && isWeapon(main.record) && main.record.IsTwoHanded === false && !off?.selection && weaponAttack !== undefined)), 'context.weaponAttack': weaponAttack ?? 0 }
  for (const [key, value] of Object.entries(gameRules?.battleConfig ?? NATIVE_DATA.battleConfig)) if (typeof value === 'number') vars[`config.${key}`] = value
  for (const mod of Object.values(PC_RULES.statMods)) vars[`tag.${mod.name}`] = Number(tags.has(mod.name))
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
      if (issues.length) continue
      scope[`stat.${stat}`] = evaluateExpression(['add', start, equipment.flat[stat]!, passives.flat[stat]!], {})
      scope[`percent.${stat}`] = evaluateExpression(['add', equipment.percent[stat]!, passives.percent[stat]!], {})
      if (!nativeInteger(scope[`stat.${stat}`]) || !nativeInteger(scope[`percent.${stat}`])) { known = false; issues.push('Accumulated stats exceed the supported native integer range.') }
    }
    if (!known) return empty
    if (issues.length) return empty
    try {
      for (const stage of PC_RULES.sheetStages) scope[`stat.${stage.stat}`] = evaluateExpression(stage.value, scope)
      return Object.fromEntries(Object.keys(PC_RULES.stats).map(stat => [stat, scope[`stat.${stat}`]!]))
    } catch { issues.push('A required calculation input is unavailable.'); return empty }
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
