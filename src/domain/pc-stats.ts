import { calculateFormula, evaluateExpression, NATIVE_DATA, PC_MODEL, PC_RULES } from './calculation-rules'
import { definitionSourceRecord, knownField, equipmentRole, type MechanicsDefinition } from './mechanics-facts'
import { nativeIdentity } from './native-game'
import { jsonRecord } from './crystal-edit'
import type { BuildRevisionContent, EntityRef, SlotDefinition } from './types'
import { entityDefinitionKey } from './core'

type NativeRecord = Readonly<Record<string, unknown>>
type Family = 'job' | 'equipment' | 'passive' | 'gender'
type Resolve = (ref: EntityRef) => MechanicsDefinition | undefined
export type PCStats = Readonly<Record<string, number | null>>
export interface PCStatResult {
  readonly base: PCStats
  readonly neutral: PCStats
  readonly male: PCStats
  readonly female: PCStats
  readonly issues: readonly string[]
  readonly effects: readonly string[]
}
const number = (record: NativeRecord | undefined, key: string) => typeof record?.[key] === 'number' && Number.isSafeInteger(record[key]) ? record[key] as number : undefined
const unknownStats = (): PCStats => Object.fromEntries(Object.keys(PC_RULES.stats).map(stat => [stat, null]))
const crystalRecord = (definition: MechanicsDefinition | undefined): NativeRecord | undefined => {
  const record = knownField(definition, 'Crystal Edit source record')
  return jsonRecord(record) ? record : undefined
}

function nativeById(family: Family, id: number, mode: string): NativeRecord | undefined {
  const base = NATIVE_DATA.records[family].find(record => record.ID === id)
  const patch = mode === 'standard' ? undefined : NATIVE_DATA.patches.find(patch => patch.name.toLowerCase() === mode)?.records[family].find(record => record.ID === id)
  return base ? { ...base, ...patch } : undefined
}

export function nativeStatRecord(ref: EntityRef | null, family: Family, resolve: Resolve, mode = 'standard'): NativeRecord | undefined {
  if (!ref) return undefined
  const definition = resolve(ref)
  if (!definition || (family === 'job' ? definition.kind !== 'class' : family === 'passive' ? !['passive', 'innate'].includes(definition.kind) : family === 'equipment' ? definition.kind !== 'item' : false)) return undefined
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

export function calculatePCStats(content: BuildRevisionContent, slots: readonly SlotDefinition[], resolve: Resolve, unknownInputs: readonly string[] = [], unknownSecondaryClass = false): PCStatResult {
  const plan = content.calculation
  const issues = [...unknownInputs]
  const effects = new Set<string>()
  const mode = plan?.pcMode ?? 'standard'
  const primary = nativeStatRecord(content.primaryClass, 'job', resolve, mode)
  const empty = unknownStats()
  if (plan?.model !== PC_MODEL || !primary || plan.level === null || !Number.isInteger(plan.level) || plan.level < 1 || plan.level > PC_RULES.limits.levelCap) {
    issues.push(!primary ? 'Primary class has no verified numeric record.' : 'Choose a supported calculation model and level.')
    return { base: empty, neutral: empty, male: empty, female: empty, issues, effects: [] }
  }
  const level = plan.level
  const growth: Record<string, number> = Object.fromEntries(PC_RULES.coreStats.map(stat => [stat, 0]))
  let growthKnown = true
  let allocated = 0
  for (const row of plan.growth) {
    if (row.levels === null || !Number.isInteger(row.levels) || row.levels < 0) { growthKnown = false; continue }
    allocated += row.levels
    if (row.levels === 0) continue
    const job = nativeStatRecord(row.classRef, 'job', resolve, mode)
    for (const stat of PC_RULES.coreStats) {
      const rating = number(job, PC_RULES.stats[stat]!.rating!)
      if (rating === undefined) growthKnown = false
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
  const apply = (record: NativeRecord, target: Group, label: string) => {
    if (!Array.isArray(record.StatMods)) { issues.push(`${label}: numeric effects are unknown.`); return }
    for (const mod of record.StatMods as readonly NativeRecord[]) {
      const tag = number(mod, 'Tag'), value = number(mod, 'Value1')
      const mapped = tag === undefined ? undefined : PC_RULES.statMods[String(tag)]
      if (!mapped || value === undefined) { issues.push(`${label}: invalid or unsupported numeric modifier.`); continue }
      try {
        if (mapped.kind === 'tag') {
          target.tags.add(mapped.name)
          if (mapped.scope === 'context') issues.push(`${label}: ${mapped.name} needs additional context.`)
          else if (mapped.scope === 'battle') effects.add(`${label}: ${mapped.name}`)
        } else if (mapped.kind === 'allCore') {
          for (const stat of PC_RULES.coreStats) target.flat[stat]! += value
        } else if (mapped.kind === 'ttMultiplier') target.tt = calculateFormula('multiplyPercent', [target.tt, value])
        else if (mapped.kind === 'hpMultiplier') target.hp += value
        else {
          const amount = mapped.scale === 'PerLevel' ? calculateFormula('perLevel', [value, level, number(mod, 'Value2') ?? NaN]) : mapped.scale === 'PerTurn' ? calculateFormula('perTurn', [value, PC_RULES.contexts.turnCount, number(mod, 'Value2') ?? NaN]) : value
          const values = mapped.kind === 'percent' ? target.percent : target.flat
          values[mapped.stat!]! += amount
        }
      } catch { issues.push(`${label}: a numeric modifier cannot be calculated.`) }
    }
  }
  for (const entry of gear) if (entry.record) {
    apply(entry.record, equipment, resolve(entry.selection!.ref)?.name ?? entry.slot.label)
    if (paired.has(entry.record)) apply(entry.record, equipment, 'Paired equipment bonus')
  }
  const addInnates = (ref: EntityRef | null, job: NativeRecord) => {
    if (!Array.isArray(job.PassiveIDs)) { issues.push('Class innate list is unknown.'); return }
    const definition = ref ? resolve(ref) : undefined
    const binding = !crystalRecord(definition) && (nativeIdentity(definition ?? { fields: {} })?.database === 'job' || ref?.kind === 'catalog' && ref.catalogId === NATIVE_DATA.catalogId && Object.hasOwn(NATIVE_DATA.bindings, ref.entityId))
    for (const id of job.PassiveIDs as unknown[]) {
      const passive = typeof id === 'number' ? binding ? nativeById('passive', id, mode) : ref?.kind === 'catalog' ? crystalRecord(resolve({ ...ref, entityId: `crystal-edit:Passives:${id}` as typeof ref.entityId })) : undefined : undefined
      if (!passive || typeof passive.IsInnate !== 'boolean') { issues.push('A class passive record is unavailable; its innate effects are unknown.'); continue }
      if (passive.IsInnate) apply(passive, passives, typeof passive.Name === 'string' ? passive.Name : 'Class innate')
    }
  }
  addInnates(content.primaryClass, primary)
  for (const selection of content.passives) {
    const record = nativeStatRecord(selection.ref, 'passive', resolve, mode)
    if (record) apply(record, passives, resolve(selection.ref)?.name ?? 'Equipped passive')
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
  const tags = new Set([...equipment.tags, ...passives.tags])
  const weaponAttack = main?.record && Array.isArray(main.record.StatMods) ? number((main.record.StatMods as NativeRecord[]).find(mod => PC_RULES.statMods[String(mod.Tag)]?.stat === 'ATK' && PC_RULES.statMods[String(mod.Tag)]?.scale === 'direct' && PC_RULES.statMods[String(mod.Tag)]?.kind === 'flat'), 'Value1') : undefined
  const vars: Record<string, number> = { hpMultiplier: equipment.hp + passives.hp, ttMultiplier: calculateFormula('multiplyPercent', [equipment.tt, passives.tt]), 'context.unarmed': Number(unarmed), 'context.dualWield': Number(unarmed || Boolean(isWeapon(main?.record) && isWeapon(off?.record))), 'context.twoHanded': Number(Boolean(main?.record && isWeapon(main.record) && main.record.IsTwoHanded === false && !off?.selection && weaponAttack !== undefined)), 'context.weaponAttack': weaponAttack ?? 0 }
  for (const [key, value] of Object.entries(NATIVE_DATA.battleConfig)) if (typeof value === 'number') vars[`config.${key}`] = value
  for (const mod of Object.values(PC_RULES.statMods)) vars[`tag.${mod.name}`] = Number(tags.has(mod.name))
  const base: Record<string, number | null> = { ...empty }
  const sheet = (gender?: NativeRecord): PCStats => {
    const scope = { ...vars }
    let known = growthKnown
    for (const [stat, descriptor] of Object.entries(PC_RULES.stats)) {
      let start = descriptor.base ?? 0
      if (descriptor.formula) {
        const rating = number(primary, descriptor.rating!)
        if (rating === undefined || !growthKnown) { known = false; continue }
        start = calculateFormula(descriptor.formula, [level, rating, growth[stat]!, Number(gender?.[descriptor.gender!] === true)])
      }
      if (!gender) base[stat] = start
      scope[`stat.${stat}`] = start + equipment.flat[stat]! + passives.flat[stat]!
      scope[`percent.${stat}`] = equipment.percent[stat]! + passives.percent[stat]!
    }
    if (!known) return empty
    if (issues.length) return empty
    try {
      for (const stage of PC_RULES.sheetStages) scope[`stat.${stage.stat}`] = evaluateExpression(stage.value, scope)
      return Object.fromEntries(Object.keys(PC_RULES.stats).map(stat => [stat, scope[`stat.${stat}`]!]))
    } catch { issues.push('A required calculation input is unavailable.'); return empty }
  }
  const neutral = sheet()
  const male = sheet(nativeById('gender', PC_RULES.genders.male, mode))
  const female = sheet(nativeById('gender', PC_RULES.genders.female, mode))
  return { base, neutral, male, female, issues: [...new Set(issues)], effects: [...effects] }
}

export function benchmarkDamage(stats: PCStats, id: string): number | null {
  const benchmark = PC_RULES.benchmarks.find(benchmark => benchmark.id === id)
  if (!benchmark) return null
  const attack = stats[benchmark.attack], main = stats[benchmark.main], pierce = stats[benchmark.pierce]
  if (attack == null || main == null || pierce == null) return null
  return calculateFormula('benchmarkDamage', [attack, main, benchmark.basePower, benchmark.attackRate, benchmark.statRate, benchmark.targetMain, benchmark.defense, pierce])
}
