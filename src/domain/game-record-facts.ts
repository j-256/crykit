import { CLASS_FIELDS, classFields, EQUIPMENT_TYPES } from './crystal-edit'
import { nativeRecord, type NativeRecord } from './native-game'
import type { CatalogEntityKind, JsonValue, Knowledge, SourceRef } from './types'

export const GAME_RECORD_FIELD = 'Crystal Edit source record'
export type GameEnums = Readonly<Record<string, Readonly<Record<string, string>>>>
const RESOURCE_COSTS = ['HP', 'MP', 'AP', 'CT', 'CD'] as const
const JP_PER_LP = 100
const INTERNAL_KEYS = new Set(['ID', 'Name', 'Description', 'Comments', 'Flavor', 'LearnTree', 'AbilityIDs', 'PassiveIDs', 'StatMods', 'AbilityMods', ...RESOURCE_COSTS.map(resource => `${resource}Cost`)])
const ENUM_FIELDS: Readonly<Record<string, string>> = Object.freeze({ Element: 'ElementType', Scope: 'SangAbilityScope', Target: 'SangAbilityTarget', Attribute: 'SangAbilityAttribute', EquipmentType: 'EquipmentType', SpecialBonus: 'ItemSpecialBonus' })

export function gameFieldLabel(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/IDs$/, ' IDs').replace(/ID$/, ' ID')
}

export function gameRecordFacts(record: NativeRecord, kind: CatalogEntityKind, source: SourceRef, enums: GameEnums): Readonly<Record<string, Knowledge<JsonValue>>> {
  const fieldSource: SourceRef = { sourceId: source.sourceId, locator: source.locator }
  const known = (value: JsonValue): Knowledge<JsonValue> => ({ state: 'known', value, sources: [fieldSource] })
  const fields: Record<string, Knowledge<JsonValue>> = {}
  if (kind === 'class') Object.assign(fields, classFields(record, fieldSource, CLASS_FIELDS))
  if (typeof record.Description === 'string' && record.Description.trim()) fields.Description = known(record.Description)
  else if (record.Description === null || record.Description === '') fields.Description = { state: 'notApplicable', reason: 'No authored description; see the definition values and effects' }
  if (typeof record.Flavor === 'string' && record.Flavor.trim()) fields.Flavor = known(record.Flavor)
  for (const [key, value] of Object.entries(record)) {
    if (INTERNAL_KEYS.has(key) || (kind === 'class' && /Rating$/.test(key)) || /Texture|Animation|Color|SortOrder|ScaledOrder|PreferredHand|PreferredHead|PreferredBody|WeaponHold/.test(key)) continue
    const enumType = ENUM_FIELDS[key]
    const name = enumType && typeof value === 'number' ? enums[enumType]?.[String(value)] : undefined
    fields[kind === 'item' && key === 'Cost' ? 'Cost (copper)' : gameFieldLabel(key)] = known(name ?? value)
  }
  if (kind === 'ability' || kind === 'monsterMagic') {
    for (const resource of RESOURCE_COSTS) if (typeof record[`${resource}Cost`] === 'number') fields[`${resource} cost`] = known(record[`${resource}Cost`]!)
    if (RESOURCE_COSTS.every(resource => typeof record[`${resource}Cost`] === 'number')) fields.Cost = known(RESOURCE_COSTS.filter(resource => record[`${resource}Cost`] !== 0).map(resource => `${record[`${resource}Cost`]}${resource === 'HP' ? '%' : ''} ${resource}`).join('\n') || 'None')
    if (typeof record.IsPAbil === 'boolean' && typeof record.IsMAbil === 'boolean') fields.Type = known(record.IsPAbil ? record.IsMAbil ? 'Physical and magical ability' : 'Physical ability' : record.IsMAbil ? 'Magical ability' : 'Ability')
  }
  if (typeof record.JP === 'number') fields['Learning cost'] = known(record.JP / JP_PER_LP)
  if ((kind === 'passive' || kind === 'innate') && typeof record.PP === 'number') fields.Cost = known(`${record.PP} PP`)
  if (kind === 'item' && typeof record.EquipmentType === 'number') {
    fields['Equipment type'] = known(EQUIPMENT_TYPES[record.EquipmentType] ?? record.EquipmentType)
    if (typeof record.IsTwoHanded === 'boolean') fields.Hands = known(record.IsTwoHanded ? 2 : 1)
    if (typeof record.IsOneOnly === 'boolean') fields.Unique = known(record.IsOneOnly)
  }
  for (const [key, codebook] of [['StatMods', 'SangStatModTag'], ['AbilityMods', 'SangAbilityModTag']] as const) {
    if (!Array.isArray(record[key])) continue
    fields[key === 'StatMods' ? 'Stat modifiers' : 'Ability modifiers'] = known(record[key].map(modifier => nativeRecord(modifier) ? { ...modifier, Name: enums[codebook]?.[String(modifier.Tag)] ?? `Unsupported modifier code ${modifier.Tag}` } : modifier))
  }
  return fields
}
