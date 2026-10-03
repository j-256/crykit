import { EQUIPMENT_TYPES } from '../domain/crystal-edit'
import type { JsonValue, Knowledge } from '../domain/types'

export const EQUIPMENT_CATEGORIES = Object.freeze({
  Sword: { key: 'equipment:sword', label: 'Swords', group: 'Weapons', sourceLabels: ['Sword', 'Swords'] },
  Axe: { key: 'equipment:axe', label: 'Axes', group: 'Weapons', sourceLabels: ['Axe', 'Axes'] },
  Dagger: { key: 'equipment:dagger', label: 'Daggers', group: 'Weapons', sourceLabels: ['Dagger', 'Daggers'] },
  Rapier: { key: 'equipment:rapier', label: 'Rapiers', group: 'Weapons', sourceLabels: ['Rapier', 'Rapiers'] },
  Katana: { key: 'equipment:katana', label: 'Katanas', group: 'Weapons', sourceLabels: ['Katana', 'Katanas'] },
  Spear: { key: 'equipment:spear', label: 'Spears', group: 'Weapons', sourceLabels: ['Spear', 'Spears'] },
  Scythe: { key: 'equipment:scythe', label: 'Scythes', group: 'Weapons', sourceLabels: ['Scythe', 'Scythes'] },
  Bow: { key: 'equipment:bow', label: 'Bows', group: 'Weapons', sourceLabels: ['Bow', 'Bows'] },
  Staff: { key: 'equipment:staff', label: 'Staves', group: 'Weapons', sourceLabels: ['Staff', 'Staves', 'Staffs', 'Two-handed staff'] },
  Wand: { key: 'equipment:wand', label: 'Wands', group: 'Weapons', sourceLabels: ['Wand', 'Wands'] },
  Book: { key: 'equipment:book', label: 'Books', group: 'Weapons', sourceLabels: ['Book', 'Books'] },
  Shield: { key: 'equipment:shield', label: 'Shields', group: 'Accessories & shields', sourceLabels: ['Shield', 'Shields'] },
  'Heavy Head': { key: 'equipment:heavy-head', label: 'Heavy helmets', group: 'Armor & headgear', sourceLabels: ['Heavy Head', 'Heavy helmets'] },
  'Medium Head': { key: 'equipment:medium-head', label: 'Medium headgear', group: 'Armor & headgear', sourceLabels: ['Medium Head', 'Medium headgear'] },
  'Light Head': { key: 'equipment:light-head', label: 'Light hats', group: 'Armor & headgear', sourceLabels: ['Light Head', 'Light hats'] },
  'Heavy Body': { key: 'equipment:heavy-body', label: 'Heavy armor', group: 'Armor & headgear', sourceLabels: ['Heavy Body', 'Heavy armor'] },
  'Medium Body': { key: 'equipment:medium-body', label: 'Medium armor', group: 'Armor & headgear', sourceLabels: ['Medium Body', 'Medium armor'] },
  'Light Body': { key: 'equipment:light-body', label: 'Light armor', group: 'Armor & headgear', sourceLabels: ['Light Body', 'Light armor'] },
  Accessory: { key: 'equipment:accessory', label: 'Accessories', group: 'Accessories & shields', sourceLabels: ['Accessory', 'Accessories'] },
} as const)

const SOURCE_CATEGORY_PREFIX = 'category:'
export const EQUIPMENT_CATEGORY_KEY = `${SOURCE_CATEGORY_PREFIX}Equipment`
const equipmentByKey = new Map(Object.values(EQUIPMENT_CATEGORIES).map(category => [category.key as string, category]))
const equipmentBySourceLabel = new Map<string, string>(Object.values(EQUIPMENT_CATEGORIES).flatMap(category => category.sourceLabels.map(label => [label.toLowerCase(), category.key])))

export function equipmentCategory(code: number) {
  const type = EQUIPMENT_TYPES[code]
  return type ? EQUIPMENT_CATEGORIES[type as keyof typeof EQUIPMENT_CATEGORIES] : undefined
}

export function referenceCategoryKey(sourceLabel: string): string {
  return equipmentBySourceLabel.get(sourceLabel.trim().toLowerCase()) ?? `${SOURCE_CATEGORY_PREFIX}${encodeURIComponent(sourceLabel.trim())}`
}

export function referenceCategoryLabel(key: string): string {
  const equipment = equipmentByKey.get(key)
  if (equipment) return equipment.label
  if (!key.startsWith(SOURCE_CATEGORY_PREFIX)) return key
  try {
    return decodeURIComponent(key.slice(SOURCE_CATEGORY_PREFIX.length))
  } catch {
    return key
  }
}

export function referenceCategorySearchText(key: string): string {
  const category = equipmentByKey.get(key)
  return category ? [category.label, ...category.sourceLabels].join('\n') : referenceCategoryLabel(key)
}

export function referenceEquipmentCategoryGroup(key: string) {
  return equipmentByKey.get(key)?.group
}

export function referenceCategoryKeys(value: Knowledge<JsonValue>): Knowledge<JsonValue> {
  const keys = (raw: JsonValue): readonly string[] => (Array.isArray(raw) ? raw : [raw])
    .filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
    .map(referenceCategoryKey)
  if (value.state === 'known') return { ...value, value: keys(value.value) }
  if (value.state === 'conflicting') return { ...value, claims: value.claims.map(claim => ({ ...claim, value: keys(claim.value) })) }
  return value
}
