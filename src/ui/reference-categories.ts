import { EQUIPMENT_CATEGORIES } from '../domain/equipment-categories'
import type { JsonValue, Knowledge } from '../domain/types'

export { EQUIPMENT_CATEGORIES, equipmentCategory } from '../domain/equipment-categories'

const SOURCE_CATEGORY_PREFIX = 'category:'
export const EQUIPMENT_CATEGORY_KEY = `${SOURCE_CATEGORY_PREFIX}Equipment`
const equipmentByKey = new Map(Object.values(EQUIPMENT_CATEGORIES).map(category => [category.key as string, category]))
const equipmentBySourceLabel = new Map<string, string>(Object.values(EQUIPMENT_CATEGORIES).flatMap(category => category.sourceLabels.map(label => [label.toLowerCase(), category.key])))

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
