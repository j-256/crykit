import modifierData from '../calculations/native-modifiers-v1.json' with { type: 'json' }
import { calculateFormula, evaluateExpression, NATIVE_DATA, PC_RULES } from './calculation-rules'
import { calculationModResolver } from './calculation-mods'
import { catalogClassSource, type DefinitionResolver } from './build-mechanics'
import { nativeStatRecord, nativeById, type NativeRecord } from './native-stat-record'
import { equipmentRole } from './mechanics-facts'
import { nativeEntityId, nativeIdentity } from './native-game'
import { bundledModEntityId, bundledModIdentity } from './bundled-mods'
import { crystalEditPlanningRecord, CRYSTAL_EDIT_VERSION_FIELD, supportsCrystalEditVersion } from './crystal-edit-compatibility'
import { entityDefinitionKey } from './core'
import { jsonRecord } from './crystal-edit'
import { MOD_PROJECT_FIELD } from './mod-library'
import { nativeInteger } from './native-number'
import { calculateCombat } from './combat-calculations'
import type { BuildRevisionContent, EntityRef, SlotDefinition } from './types'

export interface EffectiveModifierRecord {
  readonly record: NativeRecord
  readonly label: string
  readonly group: 'equipment' | 'passive' | 'status'
  readonly ref?: EntityRef
}
export interface AutomaticStatus {
  readonly id: number
  readonly chance: number
  readonly count: number
  readonly applied?: boolean
  readonly uncertain?: boolean
  readonly countUncertain?: boolean
  readonly record?: NativeRecord
  readonly ref?: EntityRef
}
export interface EffectiveModifiers {
  readonly stats: Readonly<Record<string, number | null>>
  readonly tags: ReadonlySet<string>
  readonly abilityDamage: Readonly<Record<string, number | null>>
  readonly abilityMP: Readonly<Record<string, number | null>>
  readonly abilityAP: Readonly<Record<string, number | null>>
  readonly elementGiven: Readonly<Record<string, number | null>>
  readonly elementTaken: Readonly<Record<string, number | null>>
  readonly physicalElements: readonly number[]
  readonly physicalStatuses: readonly AutomaticStatus[]
  readonly statusImmunities: readonly number[]
  readonly statusImmunityCategories: readonly number[]
  readonly records: readonly EffectiveModifierRecord[]
  readonly automaticStatuses: readonly AutomaticStatus[]
  readonly issues: readonly string[]
  readonly unknownFields: ReadonlySet<string>
}
export const NATIVE_MODIFIER_DEFAULTS: Readonly<Record<string, number | null>> = Object.freeze(modifierData.defaults)
const PERCENT = 100
const PERMANENT_STATUS_COUNT = 255
const STATUS_CATEGORIES = Object.freeze({ buff: 1, debuff: 2, stance: 3 })
const operations = modifierData.operations as Readonly<Record<string, readonly { readonly field: string; readonly operation: string }[]>>
const groups = ['equipment', 'passive', 'status'] as const
const add = (a: number, b: number) => evaluateExpression(['add', a, b], {})
const multiply = (a: number, b: number) => calculateFormula('multiplyPercent', [a, b])
const required = (value: unknown): number => { if (!nativeInteger(value)) throw new Error('Unknown native integer'); return value }
const idMapNames = ['abilityDamage', 'abilityMP', 'abilityAP', 'elementGiven', 'elementTaken'] as const
const nullableAdditions = new Set(['MaxBuffCount', 'MaxDebuffCount'])
const damageCaps = new Set(['MaxDamageTaken', 'MaxDamageGiven'])
const recordOnlyModifiers = new Set(['Reaction', 'JPBoost', 'EnableEquipType', 'ReplaceAttackWith', 'ForceTurnAbility', 'SetAppearanceToJob', 'SetActorTexture', 'RestrictCommandTo', 'HiddenIntent'])

type MutableModifiers = {
  stats: Record<string, number | null>
  tags: Set<string>
  abilityDamage: Record<string, number | null>
  abilityMP: Record<string, number | null>
  abilityAP: Record<string, number | null>
  elementGiven: Record<string, number | null>
  elementTaken: Record<string, number | null>
  physicalElements: number[]
  physicalStatuses: AutomaticStatus[]
  statusImmunities: number[]
  statusImmunityCategories: number[]
  records: EffectiveModifierRecord[]
  automaticStatuses: AutomaticStatus[]
  issues: string[]
  unknownFields: Set<string>
}
const empty = (): MutableModifiers => ({ stats: { ...NATIVE_MODIFIER_DEFAULTS }, tags: new Set(), abilityDamage: {}, abilityMP: {}, abilityAP: {}, elementGiven: {}, elementTaken: {}, physicalElements: [], physicalStatuses: [], statusImmunities: [], statusImmunityCategories: [], records: [], automaticStatuses: [], issues: [], unknownFields: new Set() })
const mapDefault = (name: typeof idMapNames[number]) => name === 'abilityMP' || name === 'abilityAP' ? 0 : PERCENT

function applyRecord(source: EffectiveModifierRecord, target: MutableModifiers, level: number | null, turn: number | null): void {
  target.records.push(source)
  if (!Array.isArray(source.record.StatMods)) {
    target.issues.push(`${source.label}: numeric effects are unknown.`)
    target.unknownFields.add('*')
    return
  }
  for (const mod of source.record.StatMods) {
    const name = jsonRecord(mod) ? PC_RULES.statMods[String(mod.Tag)]?.name : undefined
    if (!jsonRecord(mod) || !name) {
      target.issues.push(`${source.label}: invalid or unsupported numeric modifier.`)
      target.unknownFields.add('*')
      continue
    }
    const scalar = operations[name]
    if (scalar) {
      for (const { field, operation } of scalar) {
        if (target.unknownFields.has(field)) continue
        try {
          const value = required(mod.Value1)
          const current = target.stats[field] ?? 0
          const amount = operation === 'level' ? calculateFormula('perLevel', [value, required(level), required(mod.Value2)]) : operation === 'turn' ? calculateFormula('perTurn', [value, required(turn), required(mod.Value2)]) : value
          target.stats[field] = ['add', 'level', 'turn'].includes(operation) ? add(current, amount) : multiply(current, operation === 'percent' ? add(PERCENT, value) : operation === 'repeatCap' ? add(PERCENT, evaluateExpression(['mul', value, required(mod.Value2)], {})) : value)
        } catch {
          target.stats[field] = null
          target.unknownFields.add(field)
          target.issues.push(`${source.label}: ${name} has an unavailable numeric input.`)
        }
      }
      continue
    }
    let affected = ({ PElement: 'PElements', PStatusApply: 'PStatusApplies', Mult_AbilityDmg: 'AbilityDmgMult', Flat_AbilityMPCost: 'AbilityMPCostFlat', Flat_AbilityAPCost: 'AbilityAPCostFlat', Mult_ElementDmg_Given: 'ElementDmgGivenMults', Mult_ElementDmg_Taken: 'ElementDmgTakenMults' } as Readonly<Record<string, string>>)[name] ?? name
    try {
      if (damageCaps.has(name)) {
        target.stats[name] = Math.min(target.stats[name] ?? required(mod.Value1), required(mod.Value1))
      } else if (name === 'PElement') target.physicalElements.push(required(mod.Value1))
      else if (name === 'StatusImmunity') target.statusImmunities.push(required(mod.Value1))
      else if (name === 'ImmuneToStatusCategory') target.statusImmunityCategories.push(required(mod.Value1))
      else if (name === 'PStatusApply') target.physicalStatuses.push({ id: required(mod.Value1), chance: required(mod.Value2), count: required(mod.Value3), ref: source.ref })
      else if (name === 'StatusAuto') target.automaticStatuses.push({ id: required(mod.Value1), chance: required(mod.Value2), count: required(mod.Value3), ref: source.ref })
      else if (['Mult_AbilityDmg', 'Flat_AbilityMPCost', 'Flat_AbilityAPCost', 'Mult_ElementDmg_Given', 'Mult_ElementDmg_Taken'].includes(name)) {
        const mapName = name === 'Mult_AbilityDmg' ? 'abilityDamage' : name === 'Flat_AbilityMPCost' ? 'abilityMP' : name === 'Flat_AbilityAPCost' ? 'abilityAP' : name === 'Mult_ElementDmg_Given' ? 'elementGiven' : 'elementTaken'
        const id = required(mod.Value1)
        affected = `${mapName}.${id}`
        const value = required(mod.Value2)
        const previous = Object.hasOwn(target[mapName], id) ? target[mapName][id] : mapDefault(mapName)
        target[mapName][id] = previous == null ? null : mapDefault(mapName) === 0 ? add(previous, value) : multiply(previous, add(PERCENT, value))
      } else if (['Addi_PDmgReturn', 'Addi_PDmgReturn_OnKill', 'Addi_MDmgReturn', 'Addi_MDmgReturn_OnKill', 'Flat_PDmgReturn', 'Addi_HealingReturn'].includes(name)) {
        const attribute = ({ 0: 'HP', 1: 'MP', 2: 'AP', 6: '' } as Readonly<Record<number, string>>)[required(mod.Value1)]
        if (attribute === undefined || attribute === '' && name !== 'Addi_HealingReturn') continue
        const family = name.includes('PDmg') ? 'PDmg' : name.includes('MDmg') ? 'MDmg' : 'Healing'
        const field = `${family}${attribute}Return${name.endsWith('_OnKill') ? 'OnKill' : ''}${name.startsWith('Flat') ? 'Flat' : 'Addi'}`
        affected = field
        target.stats[field] = add(target.stats[field] ?? 0, required(mod.Value2))
      } else if (!recordOnlyModifiers.has(name)) {
        target.tags.add(name)
      }
    } catch {
      target.unknownFields.add(affected)
      if (Object.hasOwn(target.stats, affected)) target.stats[affected] = null
      for (const mapName of idMapNames) if (affected.startsWith(`${mapName}.`)) target[mapName][affected.slice(mapName.length + 1)] = null
      target.issues.push(`${source.label}: ${name} has an unavailable numeric input.`)
    }
  }
}

export function aggregateStatModifiers(records: readonly EffectiveModifierRecord[], level: number | null, turnCount: number | null = 0): EffectiveModifiers {
  const result = empty()
  for (const group of groups) {
    const value = empty()
    for (const record of records) if (record.group === group) applyRecord(record, value, level, turnCount)
    for (const [field, base] of Object.entries(NATIVE_MODIFIER_DEFAULTS)) {
      try {
        if (value.unknownFields.has(field) || result.unknownFields.has(field)) result.stats[field] = null
        else if (damageCaps.has(field)) result.stats[field] = value.stats[field] === null ? result.stats[field]! : Math.min(result.stats[field] ?? value.stats[field]!, value.stats[field]!)
        else if (nullableAdditions.has(field)) result.stats[field] = result.stats[field] === null && value.stats[field] === null ? null : add(result.stats[field] ?? 0, value.stats[field] ?? 0)
        else result.stats[field] = base === PERCENT ? multiply(result.stats[field]!, value.stats[field]!) : add(result.stats[field]!, value.stats[field]!)
      } catch { result.stats[field] = null; result.unknownFields.add(field); result.issues.push(`${field}: accumulated modifiers exceed the supported native integer range.`) }
    }
    for (const name of idMapNames) for (const [id, incoming] of Object.entries(value[name])) {
      const current = Object.hasOwn(result[name], id) ? result[name][id] : mapDefault(name)
      try { result[name][id] = incoming === null || current == null ? null : mapDefault(name) === 0 ? add(current, incoming) : multiply(current, incoming) }
      catch { result[name][id] = null; result.unknownFields.add(`${name}.${id}`); result.issues.push(`${name} #${id}: accumulated modifiers exceed the supported native integer range.`) }
    }
    for (const name of value.tags) result.tags.add(name)
    for (const field of value.unknownFields) result.unknownFields.add(field)
    for (const id of value.physicalElements) if (!result.physicalElements.includes(id)) result.physicalElements.push(id)
    result.physicalStatuses.push(...value.physicalStatuses)
    result.statusImmunities.push(...value.statusImmunities)
    result.statusImmunityCategories.push(...value.statusImmunityCategories)
    result.automaticStatuses.push(...value.automaticStatuses)
    result.records.push(...value.records)
    result.issues.push(...value.issues)
  }
  return result
}

export function resolveLinkedStatus(source: EntityRef, id: number, resolve: DefinitionResolver, mode = 'standard'): { readonly record?: NativeRecord; readonly ref?: EntityRef } {
  const definition = resolve(source)
  const catalog = catalogClassSource(source, resolve)?.ref ?? (source.kind === 'catalog' ? source : undefined)
  if (!catalog || !definition) return {}
  const identity = 'legacy' in definition ? bundledModIdentity(definition) : undefined
  const project = definition.fields[MOD_PROJECT_FIELD]
  const importedKey = project?.state === 'known' && typeof project.value === 'string' && project.value.startsWith('crystal-edit:') && !('legacy' in definition && jsonRecord(definition.legacy) && definition.legacy.modRecordVersion === 3) ? encodeURIComponent(project.value.slice('crystal-edit:'.length)) : undefined
  const candidates = [`crystal-edit:Statuses:${id}`, ...(importedKey ? [bundledModEntityId(importedKey, 'Statuses', id)] : []), ...(identity ? [bundledModEntityId(identity.key, 'Statuses', id)] : []), nativeEntityId('status', id)]
  for (const entityId of candidates) {
    const ref = { ...catalog, entityId: entityId as typeof catalog.entityId }
    const record = nativeStatRecord(ref, 'status', resolve, mode)
    if (record) return { record, ref }
  }
  const trusted = nativeIdentity(definition) || crystalEditPlanningRecord(definition)
  return trusted ? { record: nativeById('status', id, mode) } : {}
}

export interface EffectiveModifierOptions {
  readonly mode?: string
  readonly turnCount?: number | null
  readonly statuses?: readonly EntityRef[]
  readonly includeAutomaticStatuses?: boolean
  readonly previouslyAppliedStatuses?: readonly EntityRef[]
  readonly currentHP?: number | null
}

function automaticStatusCount(status: AutomaticStatus, modifiers: EffectiveModifiers): number {
  if (status.count === PERMANENT_STATUS_COUNT) return status.count
  const category = required(status.record?.Category)
  if (category !== STATUS_CATEGORIES.buff && category !== STATUS_CATEGORIES.debuff) return status.count
  const family = category === STATUS_CATEGORIES.buff ? 'Buff' : 'Debuff'
  const permanent = `Applied${family}sArePerma`
  if (modifiers.unknownFields.has('*') || modifiers.unknownFields.has(`tag.${permanent}`)) throw new Error('Automatic status duration is unknown')
  if (modifiers.tags.has(permanent)) return PERMANENT_STATUS_COUNT
  return required(calculateCombat('statusDuration', [status.count, category, false, false, ...['DurationFlat', 'DurationAddi'].flatMap(suffix => [required(modifiers.stats[`${family}${suffix}`]), required(modifiers.stats[`Apply${family}${suffix}`])])]))
}

export function collectEffectiveModifiers(content: BuildRevisionContent, slots: readonly SlotDefinition[], sourceResolve: DefinitionResolver, options: EffectiveModifierOptions = {}): EffectiveModifiers {
  const scope = calculationModResolver(sourceResolve)
  const resolve = scope.resolve
  const mode = options.mode ?? content.calculation?.pcMode ?? 'standard'
  const level = content.calculation?.level ?? null
  const turn = options.turnCount === undefined ? 0 : options.turnCount
  const records: EffectiveModifierRecord[] = []
  const issues: string[] = []
  const gear = slots.map(slot => ({ slot, selection: content.equipment[slot.id], record: content.equipment[slot.id] ? nativeStatRecord(content.equipment[slot.id]!.ref, 'equipment', resolve, mode) : undefined }))
  const main = gear.find(entry => equipmentRole(entry.slot) === 'mainHand')
  const off = gear.find(entry => equipmentRole(entry.slot) === 'offHand')
  if (main?.selection?.allocationId && main.selection.allocationId === off?.selection?.allocationId && entityDefinitionKey(main.selection.ref) === entityDefinitionKey(off.selection.ref)) { off.selection = null; off.record = undefined }
  const paired = new Set<NativeRecord>()
  for (const role of ['hand', 'accessory']) {
    const candidates = gear.filter(entry => role === 'hand' ? ['mainHand', 'offHand'].includes(equipmentRole(entry.slot) ?? '') : equipmentRole(entry.slot) === 'accessory')
    if (candidates.length === 2 && candidates[0]!.record && candidates[1]!.record && candidates[0]!.record.ID === candidates[1]!.record.ID && nativeInteger(candidates[0]!.record.ID) && Array.isArray(candidates[0]!.record.StatMods) && candidates[0]!.record.StatMods.some(mod => jsonRecord(mod) && mod.Tag === PC_RULES.equipment.pairedTag)) candidates.forEach(entry => paired.add(entry.record!))
  }
  for (const entry of gear) if (entry.selection) {
    const record = { record: entry.record ?? {}, ref: entry.selection.ref, label: resolve(entry.selection.ref)?.name ?? entry.slot.label, group: 'equipment' as const }
    records.push(record)
    if (entry.record && paired.has(entry.record)) records.push({ ...record, label: `${record.label} paired bonus` })
  }
  const innates = (ref: EntityRef | null) => {
    if (!ref) return
    const job = nativeStatRecord(ref, 'job', resolve, mode)
    if (!job || !Array.isArray(job.PassiveIDs)) { issues.push('Class innate list is unknown.'); records.push({ record: {}, label: 'Class innate', group: 'passive' }); return }
    const source = catalogClassSource(ref, resolve)
    const definition = source?.definition
    const binding = !crystalEditPlanningRecord(definition) && (nativeIdentity(definition ?? { fields: {} })?.database === 'job' || source?.ref.catalogId === NATIVE_DATA.catalogId && Object.hasOwn(NATIVE_DATA.bindings, source.ref.entityId))
    const mod = definition && 'legacy' in definition ? bundledModIdentity(definition) : undefined
    const metadata = definition && 'legacy' in definition && jsonRecord(definition.legacy) ? definition.legacy : undefined
    const links = jsonRecord(metadata?.passiveEntityIds) ? metadata.passiveEntityIds : {}
    const model = definition?.fields['Crystal Edit model type']
    const version = definition?.fields[CRYSTAL_EDIT_VERSION_FIELD]
    const imported = model?.state === 'known' && model.value === 'Jobs' && version?.state === 'known' && supportsCrystalEditVersion(version.value)
    for (const id of job.PassiveIDs) {
      const target = typeof id === 'number' ? links[String(id)] ?? (mod ? bundledModEntityId(mod.key, 'Passives', id) : undefined) : undefined
      const linkedRef = source && typeof target === 'string' ? { ...source.ref, entityId: target as typeof source.ref.entityId } : undefined
      const nativeRef = source && typeof id === 'number' && binding ? { ...source.ref, entityId: nativeEntityId('passive', id) } : undefined
      const aliasRef = source && typeof id === 'number' ? { ...source.ref, entityId: `crystal-edit:Passives:${id}` as typeof source.ref.entityId } : undefined
      const effectiveRef = linkedRef ?? nativeRef ?? aliasRef
      const passive = effectiveRef ? nativeStatRecord(effectiveRef, 'passive', resolve, mode) ?? (typeof id === 'number' && (binding || imported) && !linkedRef ? nativeById('passive', id, mode) : undefined) : undefined
      if (!passive || typeof passive.IsInnate !== 'boolean') { records.push({ record: {}, label: 'Class innate', group: 'passive' }); continue }
      if (passive.IsInnate) records.push({ record: passive, ref: effectiveRef && resolve(effectiveRef) ? effectiveRef : ref, label: typeof passive.Name === 'string' ? passive.Name : 'Class innate', group: 'passive' })
    }
  }
  innates(content.primaryClass)
  for (const selection of content.passives) records.push({ record: nativeStatRecord(selection.ref, 'passive', resolve, mode) ?? {}, ref: selection.ref, label: resolve(selection.ref)?.name ?? 'Equipped passive', group: 'passive' })
  if (records.some(source => source.group === 'passive' && Array.isArray(source.record.StatMods) && source.record.StatMods.some(mod => jsonRecord(mod) && mod.Tag === PC_RULES.equipment.secondaryInnatesTag))) innates(content.secondaryClass)
  const activeIDs = new Set<unknown>()
  for (const ref of options.statuses ?? []) {
    const record = nativeStatRecord(ref, 'status', resolve, mode) ?? {}
    if (nativeInteger(record.ID) && activeIDs.has(record.ID)) continue
    activeIDs.add(record.ID)
    records.push({ record, ref, label: resolve(ref)?.name ?? 'Active status', group: 'status' })
  }
  const result = aggregateStatModifiers(records, level, turn)
  return applyAutomaticStatuses({ ...result, issues: [...issues, ...result.issues, ...scope.issues] }, level, resolve, options)
}

export function applyAutomaticStatuses(result: EffectiveModifiers, level: number | null, resolve: DefinitionResolver, options: EffectiveModifierOptions = {}): EffectiveModifiers {
  const mode = options.mode ?? 'standard'
  const turn = options.turnCount === undefined ? 0 : options.turnCount
  const records = [...result.records]
  const issues = [...result.issues]
  const autos = result.automaticStatuses.map(status => ({ ...status, ...(status.ref ? resolveLinkedStatus(status.ref, status.id, resolve, mode) : {}) }))
  if (!options.includeAutomaticStatuses) return { ...result, automaticStatuses: autos }
  const uncertain: EffectiveModifierRecord[] = []
  const uncertainIssues = new Map<number, string>()
  const removedByEvents = new Set<number>()
  const explicit = new Set(records.filter(source => source.group === 'status').map(source => source.record.ID))
  const selected = new Set(explicit)
  const history = (options.previouslyAppliedStatuses ?? []).map(ref => nativeStatRecord(ref, 'status', resolve, mode)?.ID)
  for (const status of autos) {
    if (status.chance <= 0 || status.count <= 0) continue
    if (selected.has(status.id)) { status.applied = true; continue }
    const previous = autos.find(value => value.id === status.id && value.applied)
    if (previous) {
      if (previous.record?.ReApplyResistance === true || previous.count === PERMANENT_STATUS_COUNT) continue
      if (status.chance >= PERCENT && status.count === PERMANENT_STATUS_COUNT && previous.record?.ReApplyResistance === false) { previous.count = PERMANENT_STATUS_COUNT; previous.countUncertain = false }
      else if (status.chance < PERCENT || previous.countUncertain || previous.record?.ReApplyResistance !== false) previous.countUncertain = true
      else {
        try { previous.count = add(previous.count, status.count) }
        catch { previous.countUncertain = true }
      }
      continue
    }
    const label = typeof status.record?.Name === 'string' ? status.record.Name : `Status #${status.id}`
    if (!status.record || !Array.isArray(status.record.StatMods)) { status.uncertain = true; issues.push(`${label}: automatic status effects are unknown.`); uncertain.push({ record: {}, label, ref: status.ref, group: 'status' }); continue }
    const activeModifiers = aggregateStatModifiers(records, level, turn)
    if (activeModifiers.statusImmunities.includes(status.id) || typeof status.record.Category === 'number' && activeModifiers.statusImmunityCategories.includes(status.record.Category)) continue
    if (status.record.Category === STATUS_CATEGORIES.stance && records.some(source => source.group === 'status' && source.record.Category === STATUS_CATEGORIES.stance && options.statuses?.some(ref => nativeStatRecord(ref, 'status', resolve, mode)?.ID === source.record.ID))) continue
    if (status.record.ReApplyResistance === true && history.includes(status.id)) continue
    if (options.currentHP === 0 && status.record.PersistsThroughDeath === false) continue
    const source = { record: status.record, label, ref: status.ref, group: 'status' as const }
    try {
      const count = automaticStatusCount(status, activeModifiers)
      status.countUncertain = uncertain.some(value => automaticStatusCount(status, aggregateStatModifiers([...records, value], level, turn)) !== count)
      status.count = count
    } catch { status.countUncertain = true }
    const possible = aggregateStatModifiers(uncertain.filter(value => value.record.ID !== status.id), level, turn)
    const unknownImmunity = (value: EffectiveModifiers) => value.unknownFields.has('*') || value.unknownFields.has('StatusImmunity') || value.unknownFields.has('ImmuneToStatusCategory') || typeof status.record!.Category !== 'number' && value.statusImmunityCategories.length > 0
    const uncertainImmunity = unknownImmunity(activeModifiers) || unknownImmunity(possible) || possible.statusImmunities.includes(status.id) || typeof status.record.Category === 'number' && possible.statusImmunityCategories.includes(status.record.Category)
    const uncertainHistory = status.record.ReApplyResistance !== false && history.some(id => id === undefined || id === status.id)
    if (uncertainImmunity || uncertainHistory || status.chance < PERCENT || turn !== 0 && (status.count !== PERMANENT_STATUS_COUNT || status.countUncertain) || options.currentHP == null && status.record.PersistsThroughDeath !== true || options.currentHP === 0 && status.record.PersistsThroughDeath === undefined) { status.uncertain = true; uncertain.push(source); if (status.record.StatMods.length) uncertainIssues.set(status.id, `${label}: select this status if it was applied at battle start and is still active.`) }
    else {
      const prior = autos.filter(value => value.id === status.id && value.uncertain)
      status.countUncertain ||= prior.length > 0 && (status.count !== PERMANENT_STATUS_COUNT || status.record.ReApplyResistance !== false && prior.some(value => value.count !== PERMANENT_STATUS_COUNT))
      for (const value of prior) value.uncertain = false
      for (let index = uncertain.length - 1; index >= 0; index--) if (uncertain[index]!.record.ID === status.id) uncertain.splice(index, 1)
      uncertainIssues.delete(status.id)
      records.push(source); explicit.add(status.id); status.applied = true
    }
  }
  const inspectedEvents = new Set<number>()
  for (const status of autos) if ((status.applied || status.uncertain) && !inspectedEvents.has(status.id) && !options.statuses?.some(ref => nativeStatRecord(ref, 'status', resolve, mode)?.ID === status.id)) {
    inspectedEvents.add(status.id)
    for (const mod of Array.isArray(status.record?.StatMods) ? status.record.StatMods : []) {
      if (!jsonRecord(mod)) continue
      const name = PC_RULES.statMods[String(mod.Tag)]?.name
      if (!['SetStatusOnApply', 'RemoveStatusOnApply', 'StatusImmunity'].includes(name ?? '')) continue
      if (status.count !== PERMANENT_STATUS_COUNT) status.countUncertain = true
      const id = nativeInteger(mod.Value1) ? mod.Value1 : undefined
      if (id === undefined) { uncertain.push({ record: {}, label: 'Automatic status application', group: 'status' }); continue }
      if (options.statuses?.some(ref => nativeStatRecord(ref, 'status', resolve, mode)?.ID === id)) continue
      if (name === 'RemoveStatusOnApply' || name === 'StatusImmunity' || typeof mod.Value2 === 'number' && mod.Value2 < 0) {
        removedByEvents.add(id)
        const affected = autos.find(value => value.id === id)
        if (affected?.applied || affected?.uncertain) { affected.uncertain = true; affected.applied = false }
      }
      else if (!explicit.has(id)) {
        const linked = status.ref ? resolveLinkedStatus(status.ref, id, resolve, mode) : {}
        uncertain.push({ record: linked.record ?? {}, ref: linked.ref, label: `Status #${id} applied by an automatic status`, group: 'status' })
        if (!autos.some(value => value.id === id)) autos.push({ id, chance: PERCENT, count: nativeInteger(mod.Value2) ? mod.Value2 : 0, ...linked, uncertain: true })
      }
      issues.push('Automatic statuses change other statuses. Select the statuses that are active afterward.')
    }
  }
  const confirmed = aggregateStatModifiers(records, level, turn)
  for (const [category, cap] of [[STATUS_CATEGORIES.buff, confirmed.stats.MaxBuffCount], [STATUS_CATEGORIES.debuff, confirmed.stats.MaxDebuffCount]] as const) if (cap !== null) {
    const active = records.filter(source => source.group === 'status' && source.record.Category === category)
    if (active.length > cap!) for (const source of active) if (!options.statuses?.some(ref => nativeStatRecord(ref, 'status', resolve, mode)?.ID === source.record.ID)) {
      if (nativeInteger(source.record.ID)) removedByEvents.add(source.record.ID)
      const automatic = autos.find(value => value.id === source.record.ID)
      if (automatic) { automatic.uncertain = true; automatic.applied = false }
      issues.push('Too many automatic statuses to calculate. Select the statuses that are active afterward.')
    }
  }
  const effective = aggregateStatModifiers(records, level, turn)
  const unknownFields = new Set(effective.unknownFields)
  const stats = { ...effective.stats }
  const maps = Object.fromEntries(idMapNames.map(name => [name, { ...effective[name] }])) as Record<typeof idMapNames[number], Record<string, number | null>>
  const alternatives = [...uncertain.map(source => aggregateStatModifiers([...records, source], level, turn)), ...[...removedByEvents].map(id => aggregateStatModifiers(records.filter(source => source.group !== 'status' || source.record.ID !== id), level, turn))]
  if (result.unknownFields.has('StatusAuto')) unknownFields.add('*')
  for (const withStatus of alternatives) {
    for (const field of withStatus.unknownFields) unknownFields.add(field)
    for (const field of Object.keys(stats)) if (stats[field] !== withStatus.stats[field]) { stats[field] = null; unknownFields.add(field) }
    for (const name of idMapNames) for (const id of new Set([...Object.keys(withStatus[name]), ...Object.keys(effective[name])])) if ((withStatus[name][id] ?? mapDefault(name)) !== (effective[name][id] ?? mapDefault(name))) { unknownFields.add(`${name}.${id}`); maps[name][id] = null }
    for (const [field, key] of [['PElements', 'physicalElements'], ['PStatusApplies', 'physicalStatuses'], ['StatusImmunity', 'statusImmunities'], ['ImmuneToStatusCategory', 'statusImmunityCategories']] as const) if (JSON.stringify(withStatus[key]) !== JSON.stringify(effective[key])) unknownFields.add(field)
    for (const tag of new Set([...withStatus.tags, ...effective.tags])) if (withStatus.tags.has(tag) !== effective.tags.has(tag)) unknownFields.add(`tag.${tag}`)
  }
  return { ...effective, ...maps, stats, unknownFields, automaticStatuses: autos, issues: [...new Set([...issues, ...uncertainIssues.values(), ...effective.issues])] }
}
