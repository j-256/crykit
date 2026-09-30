import type { SlotDefinition } from '../domain/types'
import type { DefinitionOption } from './definitions'
import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS } from '../domain/crystal-edit'
import { equipmentFacts, equipmentFitsRole, equipmentRole } from '../domain/mechanics-facts'
import { nativeSourceRecord } from '../domain/native-game'

const WEAPON_CATEGORIES = ['Axes', 'Bows', 'Daggers', 'Katanas', 'Rapiers', 'Scythes', 'Spears', 'Staves', 'Swords', 'Wands', 'Wand', 'Two-Handed Staff']
const HAND_CATEGORIES = [...WEAPON_CATEGORIES, 'Shields', 'Books', 'Pouches', 'Tools']
const HEAD_CATEGORIES = ['Heavy helmets', 'Light hats', 'Medium headgear']
const BODY_CATEGORIES = ['Heavy armor', 'Light armor', 'Medium armor']
const KNOWN_CATEGORIES = new Set([...HAND_CATEGORIES, ...HEAD_CATEGORIES, ...BODY_CATEGORIES, 'Accessories', 'Consumables', 'Crafting', 'Fishing', 'Key Items', 'Keys', 'Maps', 'Seeds'])

export function commandName(option: DefinitionOption): string | undefined {
  const command = option.record.fields[CLASS_FIELDS.command] ?? option.record.fields[CRYSTAL_EDIT_FIELDS.command] ?? Object.entries(option.record.fields).find(([key]) => key.toLowerCase() === 'command')?.[1]
  return command?.state === 'known' && typeof command.value === 'string' ? command.value : undefined
}

export function matchesSlot(option: DefinitionOption, label: string) {
  if (option.kind === 'item' && nativeSourceRecord(option.record)) {
    const slot = label.toLowerCase()
    const role = slot.includes('accessory') ? 'accessory' : slot === 'head' ? 'head' : slot === 'body' ? 'body' : slot.includes('main hand') ? 'mainHand' : slot.includes('off hand') ? 'offHand' : undefined
    const type = equipmentFacts(option.record).type
    if (role) return type ? equipmentFitsRole(type, role) : false
  }
  if (option.kind !== 'item' || option.category?.state !== 'known') return true
  const categories = Array.isArray(option.category.value) ? option.category.value : [option.category.value]
  const known = categories.filter((value): value is string => typeof value === 'string' && KNOWN_CATEGORIES.has(value))
  if (!known.length) return true
  const slot = label.toLowerCase()
  const expected = slot.includes('accessory') ? ['Accessories'] : slot === 'head' ? HEAD_CATEGORIES : slot === 'body' ? BODY_CATEGORIES : slot.includes('hand') ? HAND_CATEGORIES : undefined
  return !expected || known.some((category) => expected.includes(category))
}

export function matchesEquipmentSlot(option: DefinitionOption, slot: SlotDefinition): boolean {
  if (option.record.slotKinds?.state === 'known') return option.record.slotKinds.value.includes(slot.id)
  const role = equipmentRole(slot)
  const type = equipmentFacts(option.record).type
  return role && type ? equipmentFitsRole(type, role) : matchesSlot(option, slot.label)
}
