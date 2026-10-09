import { entityDefinitionKey } from './core'
import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS } from './crystal-edit'
import { nativeEntityId, nativeIdentity, nativeRecord, nativeSourceRecord } from './native-game'
import { bundledModEntityId, bundledModIdentity } from './bundled-mods'
import { classEquipmentTypes, classInnateText, definitionSourceRecord, definitionPermissionEffects, effectText, equipmentFacts, equipmentFitsRole, equipmentRole, isWeapon, knownField, permissionEffects, type MechanicsDefinition } from './mechanics-facts'
import { passivePosition } from './passive-loadout'
import type { BuildRevisionContent, EntityRef, SlotDefinition } from './types'

export type DefinitionResolver = (ref: EntityRef) => MechanicsDefinition | undefined
export interface MechanicsIssue { readonly code: string; readonly status: 'invalid' | 'undetermined'; readonly message: string; readonly slotId?: string }
export interface BuildEffects { readonly text: string; readonly name: string; readonly definition: MechanicsDefinition }
export interface BuildEquipmentPermissions {
  readonly primaryName?: string
  readonly classTypes?: readonly string[]
  readonly permissions: ReadonlySet<string>
  readonly unresolvedEffects: boolean
  readonly dualWield: boolean
  readonly twoHanded: boolean
}
export interface EquipmentPermissionAssessment { readonly status: 'valid' | 'invalid' | 'undetermined'; readonly reason?: string }
type EquipmentPermissionContent = Pick<BuildRevisionContent, 'primaryClass' | 'secondaryClass' | 'passives'>
const EQUIPMENT_PERMISSION_PREFIX = 'equipment:'

export function catalogClassSource(ref: EntityRef, resolve: DefinitionResolver): { ref: Extract<EntityRef, { kind: 'catalog' }>; definition: MechanicsDefinition } | undefined {
  const visited = new Set<string>()
  let current = ref
  while (current.kind === 'personal') {
    if (visited.has(current.definitionId)) return undefined
    visited.add(current.definitionId)
    const definition = resolve(current)
    if (!definition || !('baseRef' in definition) || !definition.baseRef) return undefined
    current = definition.baseRef
  }
  const definition = resolve(current)
  return definition ? { ref: current, definition } : undefined
}

function classPassiveDefinitions(ref: EntityRef, resolve: DefinitionResolver): readonly (MechanicsDefinition | undefined)[] | undefined {
  const primary = resolve(ref)
  if (!primary) return undefined
  const source = catalogClassSource(ref, resolve)
  const native = nativeIdentity(primary) ?? (source && nativeIdentity(source.definition))
  const ids = knownField(primary, CLASS_FIELDS.passives) ?? knownField(primary, CRYSTAL_EDIT_FIELDS.passives)
  const mod = source && 'legacy' in source.definition ? bundledModIdentity(source.definition) : undefined
  const links = source && 'legacy' in source.definition && nativeRecord(source.definition.legacy) && nativeRecord(source.definition.legacy.passiveEntityIds) ? source.definition.legacy.passiveEntityIds : {}
  return source && Array.isArray(ids) ? ids.map(id => {
    if (typeof id !== 'number') return undefined
    const linked = links[String(id)]
    const candidates = typeof linked === 'string' ? [linked as typeof source.ref.entityId]
      : mod ? [bundledModEntityId(mod.key, 'Passives', id)]
      : native ? [nativeEntityId('passive', id, native.mode), nativeEntityId('passive', id)] : []
    return candidates.map(entityId => resolve({ ...source.ref, entityId })).find(value => value !== undefined)
  }) : undefined
}

function unresolvedClassInnates(ref: EntityRef | null, resolve: DefinitionResolver): boolean {
  const definition = ref && resolve(ref)
  if (!definition || !definitionSourceRecord(definition)) return false
  const passives = classPassiveDefinitions(ref!, resolve)
  return !passives || passives.some(passive => {
    const record = definitionSourceRecord(passive)
    return typeof record?.IsInnate !== 'boolean' || record.IsInnate && !Array.isArray(record.StatMods)
  })
}

export function unavailableClassCommand(ref: EntityRef, resolve: DefinitionResolver): boolean {
  const definition = resolve(ref)
  if (!definition || definition.kind !== 'class' || !definitionSourceRecord(definition)) return false
  const ids = knownField(definition, CLASS_FIELDS.abilities) ?? knownField(definition, CRYSTAL_EDIT_FIELDS.abilities)
  const command = knownField(definition, CLASS_FIELDS.command) ?? knownField(definition, CRYSTAL_EDIT_FIELDS.command)
  if (!Array.isArray(ids) || typeof command !== 'string') return true
  const source = catalogClassSource(ref, resolve)
  if (!source) return true
  const native = nativeIdentity(source.definition)
  const mod = 'legacy' in source.definition ? bundledModIdentity(source.definition) : undefined
  // Command membership grants these abilities; the class's learn tree and unrelated passives do not
  return ids.some(id => {
    if (typeof id !== 'number') return true
    const candidates = [`crystal-edit:Abilities:${id}` as typeof source.ref.entityId, ...(mod ? [bundledModEntityId(mod.key, 'Abilities', id)] : []), ...(native ? [nativeEntityId('ability', id, native.mode), nativeEntityId('ability', id)] : [])]
    return !candidates.some(entityId => { const child = resolve({ ...source.ref, entityId }); return child && ['ability', 'monsterMagic'].includes(child.kind) })
  })
}

export function innateEffects(content: Pick<BuildRevisionContent, 'primaryClass' | 'secondaryClass'>, resolve: DefinitionResolver): readonly BuildEffects[] {
  if (!content.primaryClass) return []
  const primary = resolve(content.primaryClass)
  if (!primary) return []
  const source = catalogClassSource(content.primaryClass, resolve)
  const native = nativeIdentity(primary) ?? (source && nativeIdentity(source.definition))
  const text = native ? undefined : classInnateText(primary)
  if (text !== undefined) {
    if (text === "Gain the innate passive(s) of your current Sub-Command's Class." && content.secondaryClass) {
      const secondary = resolve(content.secondaryClass)
      const inherited = classInnateText(secondary)
      if (secondary && inherited && inherited !== text) return [{ text: inherited, name: `${primary.name} via ${secondary.name} innate`, definition: secondary }]
    }
    return [{ text, name: `${primary.name} innate`, definition: primary }]
  }
  return (classPassiveDefinitions(content.primaryClass, resolve) ?? []).flatMap(definition => {
    return definition && definitionSourceRecord(definition)?.IsInnate === true ? [{ text: effectText(definition) ?? '', name: `${primary.name}: ${definition.name}`, definition }] : []
  })
}

export function buildEquipmentPermissions(content: EquipmentPermissionContent, resolve: DefinitionResolver): BuildEquipmentPermissions {
  const primary = content.primaryClass ? resolve(content.primaryClass) : undefined
  const classTypes = classEquipmentTypes(primary)
  const innates = innateEffects(content, resolve)
  const effects = innates.map(effect => definitionSourceRecord(effect.definition) ? definitionPermissionEffects(effect.definition) : permissionEffects(effect.text))
  for (const selection of content.passives) {
    const definition = resolve(selection.ref)
    effects.push(!definition || !['passive', 'innate'].includes(definition.kind)
      ? { equipment: [], dualWield: false, twoHanded: false, complete: false }
      : definitionPermissionEffects(definition))
  }
  const permissions = new Set(classTypes ?? [])
  for (const effect of effects) for (const type of effect.equipment) permissions.add(type)
  const passiveIds = knownField(primary, CLASS_FIELDS.passives) ?? knownField(primary, CRYSTAL_EDIT_FIELDS.passives)
  const explicitlyNoPassives = Array.isArray(passiveIds) && passiveIds.length === 0
  return {
    primaryName: primary?.name,
    classTypes,
    permissions,
    dualWield: effects.some(effect => effect.dualWield),
    twoHanded: effects.some(effect => effect.twoHanded),
    unresolvedEffects: effects.some(effect => !effect.complete) || unresolvedClassInnates(content.primaryClass, resolve) || Boolean(primary && !classInnateText(primary) && !explicitlyNoPassives && innates.length === 0),
  }
}

export function requiredEquipmentTypes(definition: MechanicsDefinition): readonly string[] | undefined {
  const requirements = definition.requirements
  if (requirements?.state === 'conflicting') return undefined
  if (requirements?.state === 'known') return requirements.value.flatMap(requirement => requirement.kind === 'permission' && requirement.permission.startsWith(EQUIPMENT_PERMISSION_PREFIX) ? [requirement.permission.slice(EQUIPMENT_PERMISSION_PREFIX.length)] : [])
  const type = equipmentFacts(definition).type
  return type ? [type] : undefined
}

export function assessEquipmentPermission(definition: MechanicsDefinition, context: BuildEquipmentPermissions): EquipmentPermissionAssessment {
  const types = requiredEquipmentTypes(definition)
  if (!types) return { status: 'undetermined', reason: definition.requirements?.state === 'conflicting' ? 'Equip requirements conflict' : 'Equipment type unknown' }
  const missing = types.filter(type => !context.permissions.has(type))
  if (!missing.length) return { status: 'valid' }
  return context.classTypes && !context.unresolvedEffects
    ? { status: 'invalid', reason: `${context.primaryName} cannot equip ${missing.join(', ')}` }
    : { status: 'undetermined', reason: 'Equip permission unknown' }
}

export function analyzeBuildEquipment(content: BuildRevisionContent, slots: readonly SlotDefinition[], resolve: DefinitionResolver, identity: (ref: EntityRef) => string = entityDefinitionKey): readonly MechanicsIssue[] {
  const issues: MechanicsIssue[] = []
  const add = (code: string, status: MechanicsIssue['status'], message: string, slotId?: string) => issues.push({ code, status, message, ...(slotId ? { slotId } : {}) })
  const primary = content.primaryClass ? resolve(content.primaryClass) : undefined
  const secondary = content.secondaryClass ? resolve(content.secondaryClass) : undefined
  for (const [definition, field, label, target] of [[primary, 'Primary class selection disabled', 'primary class', 'primary-class'], [secondary, 'Secondary class selection disabled', 'sub-command', 'secondary-class']] as const) {
    if (definition && definition.kind !== 'class') add('CLASS_KIND', 'invalid', `${definition.name} is not a class`, target)
    if (knownField(definition, field) === true) add('CLASS_DISABLED', 'invalid', `${definition!.name} cannot be selected as the ${label} in its export`, target)
  }
  // A sub-command contributes no innates by itself; learning-tree entries are not active effects
  if (unresolvedClassInnates(content.primaryClass, resolve)) add('CLASS_INNATE_DEFINITION', 'undetermined', `${primary!.name}: an innate's identity or effects are unavailable`, 'primary-class')
  const { classTypes, permissions, dualWield, twoHanded, unresolvedEffects } = buildEquipmentPermissions(content, resolve)
  const passiveIds = new Set<string>()
  for (const [index, selection] of content.passives.entries()) {
    const slot = passivePosition(index)
    const definition = resolve(selection.ref)
    const key = identity(selection.ref)
    if (passiveIds.has(key)) add('DUPLICATE_PASSIVE', 'invalid', `${definition?.name ?? 'This passive'} is selected more than once`, slot.id)
    passiveIds.add(key)
    if (!definition || !['passive', 'innate'].includes(definition.kind)) {
      add('PASSIVE_DEFINITION', definition ? 'invalid' : 'undetermined', `${slot.label}: ${definition ? 'select a passive' : 'definition is unavailable'}`, slot.id)
      continue
    }
    const record = definitionSourceRecord(definition)
    if (record && record.IsLearnable === undefined && definition.fields['Is Learnable']?.state === 'unknown') {
      add('PASSIVE_LEARNABILITY_UNKNOWN', 'undetermined', `${definition.name}: whether this passive can be learned is unresolved`, slot.id)
    } else if (record?.IsLearnable === false) {
      const nativeInnate = Boolean(nativeSourceRecord(definition)) && definition.kind === 'innate'
      add('PASSIVE_NOT_LEARNABLE', nativeInnate ? 'undetermined' : 'invalid', nativeInnate ? `${definition.name} cannot be learned in the base game; the mod that makes innates selectable is unverified` : `${definition.name} cannot be learned as an equipped passive in this source`, slot.id)
    }
  }
  const equipment = slots.flatMap(slot => {
    const selection = content.equipment[slot.id]
    if (!selection) return []
    const definition = resolve(selection.ref)
    const role = equipmentRole(slot)
    if (!definition) {
      add('EQUIPMENT_DEFINITION', 'undetermined', `${slot.label}: definition is unavailable`, slot.id)
      return []
    }
    const facts = equipmentFacts(definition)
    const allowedSlots = definition.slotKinds
    if (allowedSlots?.state === 'known') {
      if (!allowedSlots.value.includes(slot.id)) add('EQUIPMENT_ROLE', 'invalid', `${definition.name} does not allow ${slot.label} in its explicit slot rules`, slot.id)
    } else if (allowedSlots?.state === 'conflicting') add('EQUIPMENT_ROLE_CONFLICT', 'undetermined', `${definition.name}: explicit slot rules conflict`, slot.id)
    else if (!role || !facts.type) add('EQUIPMENT_TYPE_UNKNOWN', 'undetermined', `${slot.label}: ${!role ? 'choose an equipment role in settings' : `${definition.name}'s equipment category is unavailable`}`, slot.id)
    else if (!equipmentFitsRole(facts.type, role)) add('EQUIPMENT_ROLE', 'invalid', `${definition.name} (${facts.type}) does not fit ${slot.label}`, slot.id)
    const requirements = definition.requirements
    const requiredTypes = requiredEquipmentTypes(definition) ?? []
    if (requirements?.state === 'conflicting') add('EQUIPMENT_REQUIREMENTS_CONFLICT', 'undetermined', `${definition.name}: equipment requirement claims conflict`, slot.id)
    else for (const type of requiredTypes) if (!permissions.has(type)) add('CLASS_EQUIPMENT_PERMISSION', classTypes && !unresolvedEffects ? 'invalid' : 'undetermined', classTypes && !unresolvedEffects ? `${primary!.name} cannot equip ${type}; select a permission passive or change class` : `${type} permission is unresolved for the primary class and selected passives`, slot.id)
    return [{ slot, selection, definition, role, facts, key: identity(selection.ref), allocation: selection.allocationId ?? `slot:${slot.id}` }]
  })
  const groups = new Map<string, typeof equipment>()
  for (const entry of equipment) groups.set(entry.allocation, [...(groups.get(entry.allocation) ?? []), entry])
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const first = group[0]!
    if (group.some(entry => entry.key !== first.key)) add('MIXED_EQUIPMENT_ALLOCATION', 'invalid', 'Shared slots must select the same equipment', first.slot.id)
    else if (group.length !== 2 || !group.some(entry => entry.role === 'mainHand') || !group.some(entry => entry.role === 'offHand')) add('EQUIPMENT_ALLOCATION_ROLES', 'invalid', `${first.definition.name}: only the two hand slots can share one item`, first.slot.id)
    else if (first.facts.twoHanded !== true && !twoHanded) add('EQUIPMENT_ALLOCATION_HANDS', first.facts.twoHanded === undefined || unresolvedEffects ? 'undetermined' : 'invalid', `${first.definition.name}: holding this copy in both hands requires a two-handed weapon or the Two-Handed effect`, first.slot.id)
  }
  const hands = equipment.filter(entry => entry.role === 'mainHand' || entry.role === 'offHand')
  for (const entry of hands) {
    if (entry.facts.type && isWeapon(entry.facts.type) && entry.facts.twoHanded === undefined && hands.some(other => other !== entry && other.allocation !== entry.allocation)) add('HAND_OCCUPANCY_UNKNOWN', 'undetermined', `${entry.definition.name}: hand use is unknown with the other item selected`, entry.slot.id)
    if (entry.facts.twoHanded === true && hands.some(other => other !== entry && other.allocation !== entry.allocation)) add('TWO_HAND_CONFLICT', 'invalid', `${entry.definition.name} occupies both hands; remove the other item or group the same copy`, entry.slot.id)
    if (entry.role === 'offHand' && entry.facts.type && isWeapon(entry.facts.type) && entry.facts.twoHanded !== true && !dualWield && !groups.get(entry.allocation)?.some(other => other.role === 'mainHand' && other !== entry && twoHanded)) add('DUAL_WIELD_REQUIRED', unresolvedEffects || entry.facts.twoHanded === undefined ? 'undetermined' : 'invalid', `${entry.definition.name} in the off hand requires Dual Wield or a shared two-handed allocation`, entry.slot.id)
  }
  for (const entry of equipment.filter(entry => entry.facts.unique)) {
    const copies = new Set(equipment.filter(other => other.key === entry.key).map(other => other.allocation))
    if (copies.size > 1 && equipment.find(other => other.key === entry.key) === entry) add('UNIQUE_EQUIPMENT', 'invalid', `${entry.definition.name} allows only one equipped copy`, entry.slot.id)
  }
  return issues
}
