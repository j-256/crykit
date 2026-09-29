import { CRYSTAL_EDIT_FIELDS, EQUIPMENT_TYPES, jsonRecord } from './crystal-edit'
import type { CatalogEntity, EquipmentRole, JsonValue, Knowledge, PersonalDefinition, SlotDefinition, SourceRef } from './types'

export type MechanicsDefinition = CatalogEntity | PersonalDefinition
export type EquipmentType = typeof EQUIPMENT_TYPES[number]
export const GUIDE_MECHANICS_SOURCE: SourceRef = { sourceId: 'community:geef-modding-guide', locator: 'Game synopsis; Equipment; Jobs; Stat Mod glossary', applicability: 'Documented planning mechanics; effects outside the supported calculation are listed separately' }
export const EQUIPMENT_ROLE_LABELS: Readonly<Record<EquipmentRole, string>> = Object.freeze({ mainHand: 'Main hand', offHand: 'Off hand', head: 'Head', body: 'Body', accessory: 'Accessory' })
const PLAN_ROLES: Readonly<Record<string, EquipmentRole>> = Object.freeze({ 'plan-main-hand': 'mainHand', 'plan-off-hand': 'offHand', 'plan-head': 'head', 'plan-body': 'body', 'plan-accessory-1': 'accessory', 'plan-accessory-2': 'accessory' })
const WIKI_EQUIPMENT_TYPES: Readonly<Record<string, string>> = Object.freeze({ swords: 'Sword', axes: 'Axe', daggers: 'Dagger', rapiers: 'Rapier', katanas: 'Katana', spears: 'Spear', scythes: 'Scythe', bows: 'Bow', staves: 'Staff', wands: 'Wand', wand: 'Wand', books: 'Book', shields: 'Shield', 'heavy helmets': 'Heavy Head', 'medium headgear': 'Medium Head', 'light hats': 'Light Head', 'heavy armor': 'Heavy Body', 'medium armor': 'Medium Body', 'light armor': 'Light Body', accessories: 'Accessory', 'two-handed staff': 'Staff' })
const WIKI_CATEGORY_TWO_HANDED: Readonly<Record<string, boolean>> = Object.freeze({ books: true, bows: true, daggers: false, katanas: false, rapiers: false, scythes: true, spears: true, staves: true, wands: false, wand: false, 'two-handed staff': true })

export function knownField(definition: Pick<MechanicsDefinition, 'fields'> | undefined, label: string): JsonValue | undefined {
  const field = definition?.fields[label]
  return field?.state === 'known' ? field.value : undefined
}

export function crystalEditRecord(definition: Pick<MechanicsDefinition, 'fields'> | undefined): Readonly<Record<string, JsonValue>> | undefined {
  const record = knownField(definition, 'Crystal Edit source record')
  return jsonRecord(record) ? record : undefined
}

export function equipmentRole(slot: Pick<SlotDefinition, 'kind' | 'id' | 'equipmentRole'>): EquipmentRole | undefined {
  return slot.kind === 'equipment' && slot.equipmentRole !== null ? slot.equipmentRole ?? PLAN_ROLES[slot.id] : undefined
}

export interface EquipmentFacts {
  readonly type?: string
  readonly twoHanded?: boolean
  readonly unique?: boolean
  readonly sources: readonly SourceRef[]
}

export function equipmentFacts(definition: MechanicsDefinition): EquipmentFacts {
  const record = crystalEditRecord(definition)
  if (record) return {
    ...(typeof record.EquipmentType === 'number' && EQUIPMENT_TYPES[record.EquipmentType] ? { type: EQUIPMENT_TYPES[record.EquipmentType] } : {}),
    ...(typeof record.IsTwoHanded === 'boolean' ? { twoHanded: record.IsTwoHanded } : {}),
    ...(typeof record.IsOneOnly === 'boolean' ? { unique: record.IsOneOnly } : {}),
    sources: definition.sources,
  }
  const categories = knownField(definition, 'Category')
  const types = new Set(Array.isArray(categories) ? categories.flatMap(value => typeof value === 'string' && WIKI_EQUIPMENT_TYPES[value.toLowerCase()] ? [WIKI_EQUIPMENT_TYPES[value.toLowerCase()]!] : []) : [])
  const type = types.size === 1 ? [...types][0] : undefined
  const hands = knownField(definition, 'Hands')
  const handsConflicting = definition.fields.Hands?.state === 'conflicting'
  const handTexts = Object.entries(definition.fields).filter(([key, value]) => key.includes('Hands') && value.state === 'known').flatMap(([, value]) => value.state === 'known' && typeof value.value === 'string' ? [value.value] : [])
  const parsedHands = [...new Set(handTexts.flatMap(text => [...text.matchAll(/\b([12])-Handed\b/gi)].map(match => match[1]!)))]
  const categoryHandedness = [...new Set(Array.isArray(categories) ? categories.flatMap(value => typeof value === 'string' && Object.hasOwn(WIKI_CATEGORY_TWO_HANDED, value.toLowerCase()) ? [WIKI_CATEGORY_TWO_HANDED[value.toLowerCase()]!] : []) : [])]
  const explicitHandCount = hands === 1 || hands === 2 ? hands : parsedHands.length === 1 ? Number(parsedHands[0]) : undefined
  const categoryTwoHanded = categoryHandedness.length === 1 ? categoryHandedness[0] : undefined
  const handsDisagree = hands === 1 || hands === 2 ? parsedHands.some(value => Number(value) !== hands) || categoryHandedness.some(value => value !== (hands === 2)) : parsedHands.length === 1 && categoryHandedness.some(value => value !== (Number(parsedHands[0]) === 2))
  const twoHanded = handsConflicting || handsDisagree || categoryHandedness.length > 1 ? undefined : explicitHandCount !== undefined ? explicitHandCount === 2 : categoryTwoHanded ?? (type && !isWeapon(type) ? false : undefined)
  const effects = knownField(definition, 'Other effects')
  const unique = knownField(definition, 'Unique')
  return { type, twoHanded, ...(unique === 'Yes' || typeof effects === 'string' && /\b(?:can only equip one|only one can be equipped|one only)\b/i.test(effects) ? { unique: true } : unique === 'No' ? { unique: false } : {}), sources: definition.sources }
}

export function isWeapon(type: string): boolean {
  return EQUIPMENT_TYPES.slice(0, EQUIPMENT_TYPES.indexOf('Shield')).includes(type)
}

export function equipmentFitsRole(type: string, role: EquipmentRole): boolean {
  if (isWeapon(type)) return role === 'mainHand' || role === 'offHand'
  if (type === 'Shield') return role === 'offHand'
  if (type.endsWith(' Head')) return role === 'head'
  if (type.endsWith(' Body')) return role === 'body'
  return type === 'Accessory' && role === 'accessory'
}

export function classEquipmentTypes(definition: MechanicsDefinition | undefined): readonly string[] | undefined {
  if (definition?.kind !== 'class') return undefined
  if (definition.grants?.state === 'conflicting') return undefined
  const field = definition.fields[CRYSTAL_EDIT_FIELDS.equipment]
  if (field?.state !== 'known' || !Array.isArray(field.value) || !field.value.every(value => typeof value === 'string' && EQUIPMENT_TYPES.includes(value))) return undefined
  if (definition.grants?.state === 'known') return definition.grants.value.filter(value => value.startsWith('equipment:')).map(value => value.slice('equipment:'.length))
  return field.value as readonly string[]
}

export function effectText(definition: MechanicsDefinition): string | undefined {
  const field = knownField(definition, definition.kind === 'status' ? 'Effect' : 'Description')
  return typeof field === 'string' ? field : undefined
}

export interface PermissionEffects { readonly equipment: readonly string[]; readonly dualWield: boolean; readonly twoHanded: boolean; readonly complete: boolean }

export function permissionEffects(text: string | undefined): PermissionEffects {
  const equipment: string[] = []
  let dualWield = false
  let twoHanded = false
  if (!text) return { equipment, dualWield, twoHanded, complete: false }
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  let complete = true
  for (const line of lines) {
    const match = /^Enable equipping (.+) regardless of current Class\.$/i.exec(line)
    if (match && EQUIPMENT_TYPES.includes(match[1]!)) equipment.push(match[1]!)
    else if (/^Equip anything regardless of current Class\.$/i.test(line)) equipment.push(...EQUIPMENT_TYPES)
    else if (/^Equip two One-Handed weapons at the same time to attack with each one, but decrease Attack by 35%\.\*?$/i.test(line)) dualWield = true
    else if (/^Hold a One-Handed weapon with both hands to increase its attack by \d+\.?$/i.test(line)) twoHanded = true
    else if (/\b(equip|weapon|hand)\b/i.test(line)) complete = false
  }
  return { equipment, dualWield, twoHanded, complete }
}

export function classInnateText(definition: MechanicsDefinition | undefined): string | undefined {
  const innate = knownField(definition, 'Innate passive(s)')
  return typeof innate === 'string' ? innate.split('\n').map(line => line.replace(/^[^:]+:\s*/, '')).join('\n') : undefined
}

export const equipmentPermission = (type: string) => `equipment:${type}`

export function passivePointCost(definition: MechanicsDefinition): Knowledge<number> | undefined {
  const cost = crystalEditRecord(definition)?.PP
  return fillUnknown(definition.ppCost, typeof cost === 'number' && Number.isSafeInteger(cost) && cost >= 0 ? cost : undefined, definition.sources)
}

function fillUnknown<T>(original: Knowledge<T> | undefined, value: T | undefined, sources: readonly SourceRef[]): Knowledge<T> | undefined {
  return (!original || original.state === 'unknown') && value !== undefined ? { state: 'known', value, sources: [...sources, GUIDE_MECHANICS_SOURCE] } : original
}

export function definitionWithMechanics<T extends MechanicsDefinition>(definition: T, slots: readonly SlotDefinition[]): T {
  const equipment = equipmentFacts(definition)
  const permissions = classEquipmentTypes(definition)
  const effects = permissionEffects(effectText(definition))
  const passive = definition.kind === 'passive' || definition.kind === 'innate'
  const record = crystalEditRecord(definition)
  const knownPassive = passive && !record && effects.complete
  const mappedSlots = slots.every(slot => equipmentRole(slot) !== undefined)
  return {
    ...definition,
    slotKinds: fillUnknown(definition.slotKinds, passive ? undefined : equipment.type && mappedSlots ? slots.filter(slot => equipmentRole(slot) && equipmentFitsRole(equipment.type!, equipmentRole(slot)!)).map(slot => slot.id as string) : undefined, definition.sources),
    requirements: fillUnknown(definition.requirements, permissions || knownPassive ? [] : equipment.type ? [{ kind: 'permission' as const, permission: equipmentPermission(equipment.type) }] : undefined, definition.sources),
    grants: fillUnknown(definition.grants, permissions ? permissions.map(equipmentPermission) : knownPassive ? effects.equipment.map(equipmentPermission) : undefined, definition.sources),
    ppCost: passive ? passivePointCost(definition) : definition.ppCost,
  }
}
