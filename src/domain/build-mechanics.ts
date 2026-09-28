import { entityDefinitionKey } from './core'
import { CRYSTAL_EDIT_FIELDS } from './crystal-edit'
import { classEquipmentTypes, classInnateText, crystalEditRecord, effectText, equipmentFacts, equipmentFitsRole, equipmentRole, isWeapon, knownField, permissionEffects, type MechanicsDefinition } from './mechanics-facts'
import type { BuildRevisionContent, EntityRef, SlotDefinition } from './types'

export type DefinitionResolver = (ref: EntityRef) => MechanicsDefinition | undefined
export interface MechanicsIssue { readonly code: string; readonly status: 'invalid' | 'undetermined'; readonly message: string; readonly slotId?: string }
export interface BuildEffects { readonly text: string; readonly name: string; readonly definition: MechanicsDefinition }

export function innateEffects(content: BuildRevisionContent, resolve: DefinitionResolver): readonly BuildEffects[] {
  if (!content.primaryClass) return []
  const primary = resolve(content.primaryClass)
  if (!primary) return []
  const text = classInnateText(primary)
  if (text !== undefined) {
    if (text === "Gain the innate passive(s) of your current Sub-Command's Class." && content.secondaryClass) {
      const secondary = resolve(content.secondaryClass)
      const inherited = classInnateText(secondary)
      if (secondary && inherited && inherited !== text) return [{ text: inherited, name: `${primary.name} via ${secondary.name} innate`, definition: secondary }]
    }
    return [{ text, name: `${primary.name} innate`, definition: primary }]
  }
  const ids = knownField(primary, CRYSTAL_EDIT_FIELDS.passives)
  const ref = content.primaryClass
  return ref.kind === 'catalog' && Array.isArray(ids) ? ids.flatMap(id => {
    const definition = typeof id === 'number' ? resolve({ ...ref, entityId: `crystal-edit:Passives:${id}` as typeof ref.entityId }) : undefined
    return definition && crystalEditRecord(definition)?.IsInnate === true ? [{ text: effectText(definition) ?? '', name: `${primary.name}: ${definition.name}`, definition }] : []
  }) : []
}

export function analyzeBuildEquipment(content: BuildRevisionContent, slots: readonly SlotDefinition[], resolve: DefinitionResolver, identity: (ref: EntityRef) => string = entityDefinitionKey): readonly MechanicsIssue[] {
  const issues: MechanicsIssue[] = []
  const add = (code: string, status: MechanicsIssue['status'], message: string, slotId?: string) => issues.push({ code, status, message, ...(slotId ? { slotId } : {}) })
  const primary = content.primaryClass ? resolve(content.primaryClass) : undefined
  const secondary = content.secondaryClass ? resolve(content.secondaryClass) : undefined
  for (const [definition, field, label] of [[primary, 'Primary class selection disabled', 'primary class'], [secondary, 'Secondary class selection disabled', 'sub-command']] as const) {
    if (definition && definition.kind !== 'class') add('CLASS_KIND', 'invalid', `${definition.name} is not a class`)
    if (knownField(definition, field) === true) add('CLASS_DISABLED', 'invalid', `${definition!.name} cannot be selected as the ${label} in its export`)
  }
  const classTypes = classEquipmentTypes(primary)
  const permissions = new Set(classTypes ?? [])
  const effects = innateEffects(content, resolve).map(effect => permissionEffects(effect.text))
  const passiveIds = new Set<string>()
  for (const slot of slots.filter(slot => slot.kind === 'passive')) {
    const selection = content.selections[slot.id]
    if (!selection) continue
    const definition = resolve(selection.ref)
    const key = identity(selection.ref)
    if (passiveIds.has(key)) add('DUPLICATE_PASSIVE', 'invalid', `${definition?.name ?? 'This passive'} is selected more than once`, slot.id)
    passiveIds.add(key)
    if (!definition || !['passive', 'innate'].includes(definition.kind)) {
      add('PASSIVE_DEFINITION', definition ? 'invalid' : 'undetermined', `${slot.label}: ${definition ? 'select a passive' : 'definition is unavailable'}`, slot.id)
      continue
    }
    if (crystalEditRecord(definition)?.IsLearnable === false) add('PASSIVE_NOT_LEARNABLE', 'invalid', `${definition.name} is not learnable as a selectable passive in its export`, slot.id)
    effects.push(crystalEditRecord(definition) ? { equipment: [], dualWield: false, twoHanded: false, complete: false } : permissionEffects(effectText(definition)))
  }
  for (const effect of effects) for (const type of effect.equipment) permissions.add(type)
  const dualWield = effects.some(effect => effect.dualWield)
  const twoHanded = effects.some(effect => effect.twoHanded)
  const passiveIdsField = knownField(primary, CRYSTAL_EDIT_FIELDS.passives)
  const explicitlyNoPassives = Array.isArray(passiveIdsField) && passiveIdsField.length === 0
  const unresolvedEffects = effects.some(effect => !effect.complete) || Boolean(primary && !classInnateText(primary) && !explicitlyNoPassives && innateEffects(content, resolve).length === 0)
  const equipment = slots.filter(slot => slot.kind === 'equipment').flatMap(slot => {
    const selection = content.selections[slot.id]
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
    const requiredTypes = requirements?.state === 'known' ? requirements.value.flatMap(requirement => requirement.kind === 'permission' && requirement.permission.startsWith('equipment:') ? [requirement.permission.slice('equipment:'.length)] : []) : facts.type ? [facts.type] : []
    if (requirements?.state === 'conflicting') add('EQUIPMENT_REQUIREMENTS_CONFLICT', 'undetermined', `${definition.name}: equipment requirement claims conflict`, slot.id)
    else for (const type of requiredTypes) if (!permissions.has(type)) add('CLASS_EQUIPMENT_PERMISSION', classTypes && !unresolvedEffects ? 'invalid' : 'undetermined', classTypes && !unresolvedEffects ? `${primary!.name} cannot equip ${type}; select a permission passive or change class` : `${type} permission is unresolved for the primary class and selected passives`, slot.id)
    const customOccupancy = definition.occupiesSlots?.state === 'known' && definition.occupiesSlots.value !== facts.hands
    if (customOccupancy || definition.occupiesSlots?.state === 'conflicting') add('CUSTOM_EQUIPMENT_OCCUPANCY', 'undetermined', `${definition.name}: scenario validation uses its explicit occupancy rules`, slot.id)
    return [{ slot, selection, definition, role, facts: customOccupancy || definition.occupiesSlots?.state === 'conflicting' ? { ...facts, hands: undefined } : facts, key: identity(selection.ref), allocation: selection.allocationId ?? `slot:${slot.id}` }]
  })
  const groups = new Map<string, typeof equipment>()
  for (const entry of equipment) groups.set(entry.allocation, [...(groups.get(entry.allocation) ?? []), entry])
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const first = group[0]!
    if (group.some(entry => entry.key !== first.key)) add('MIXED_EQUIPMENT_ALLOCATION', 'invalid', 'A shared copy must refer to the same equipment in both slots', first.slot.id)
    else if (group.length !== 2 || !group.some(entry => entry.role === 'mainHand') || !group.some(entry => entry.role === 'offHand')) add('EQUIPMENT_ALLOCATION_ROLES', 'invalid', `${first.definition.name}: only the two hand slots can share one item`, first.slot.id)
    else if (first.facts.hands !== 2 && !twoHanded) add('EQUIPMENT_ALLOCATION_HANDS', first.facts.hands === undefined || unresolvedEffects ? 'undetermined' : 'invalid', `${first.definition.name}: holding this copy in both hands requires a two-handed weapon or the Two-Handed effect`, first.slot.id)
  }
  const hands = equipment.filter(entry => entry.role === 'mainHand' || entry.role === 'offHand')
  for (const entry of hands) {
    if (entry.facts.type && isWeapon(entry.facts.type) && entry.facts.hands === undefined && hands.some(other => other !== entry && other.allocation !== entry.allocation)) add('HAND_OCCUPANCY_UNKNOWN', 'undetermined', `${entry.definition.name}: hand occupancy is unresolved alongside the other hand selection`, entry.slot.id)
    if (entry.facts.hands === 2 && hands.some(other => other !== entry && other.allocation !== entry.allocation)) add('TWO_HAND_CONFLICT', 'invalid', `${entry.definition.name} occupies both hands; remove the other item or group the same copy`, entry.slot.id)
    if (entry.role === 'offHand' && entry.facts.type && isWeapon(entry.facts.type) && entry.facts.hands !== 2 && !dualWield && !groups.get(entry.allocation)?.some(other => other.role === 'mainHand' && other !== entry && twoHanded)) add('DUAL_WIELD_REQUIRED', unresolvedEffects || entry.facts.hands === undefined ? 'undetermined' : 'invalid', `${entry.definition.name} in the off hand requires Dual Wield or a shared two-handed allocation`, entry.slot.id)
  }
  for (const entry of equipment.filter(entry => entry.facts.unique)) {
    const copies = new Set(equipment.filter(other => other.key === entry.key).map(other => other.allocation))
    if (copies.size > 1 && equipment.find(other => other.key === entry.key) === entry) add('UNIQUE_EQUIPMENT', 'invalid', `${entry.definition.name} allows only one equipped copy`, entry.slot.id)
  }
  return issues
}
