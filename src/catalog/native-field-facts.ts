import { DEFAULT_CATALOG } from './bundled'
import { NATIVE_GAME_DATA } from './native-game'
import { nativeDescription, nativeDescriptionSourceMatches } from './native-description'
import { projectSourceSemantics } from './source-semantics'
import { sameValue } from '../domain/definition-values'
import { EQUIPMENT_TYPES } from '../domain/crystal-edit'
import { equipmentCategory } from '../domain/equipment-categories'
import { nativeIdentity, nativeRecord, nativeSourceRecord, NATIVE_SOURCE_PREFIX } from '../domain/native-game'
import type { CatalogEntity, CatalogSnapshot, JsonValue, Knowledge } from '../domain/types'

export const FLAT_STAT_FIELDS: Readonly<Record<string, string>> = Object.freeze({ Attack: 'Flat_PAtk', Defense: 'Flat_PDef', Resistance: 'Flat_MDef', 'Def pierce': 'Flat_PPen', 'Res pierce': 'Flat_MPen', Accuracy: 'Flat_PAccRating', Evasion: 'Flat_PEvaRating', Strength: 'Flat_Str', Vitality: 'Flat_Vit', Dexterity: 'Flat_Dex', Agility: 'Flat_Agi', Mind: 'Flat_Mnd', Spirit: 'Flat_Spi', Speed: 'Flat_Spd', Luck: 'Flat_Lck', 'Max hp': 'Flat_HP', 'Max mp': 'Flat_MP' })
const SHOUDU_STEW_ID = 'base:item:132'
const STAT_LABELS: Readonly<Record<string, string>> = Object.freeze({ 'Def. Pierce': 'Def pierce', 'Res. Pierce': 'Res pierce', 'Max. HP': 'Max hp', 'Max. MP': 'Max mp' })

export interface NativeFieldFact {
  readonly field: string
  readonly original: Knowledge<JsonValue>
  readonly value: Knowledge<JsonValue>
  readonly differs: boolean
  readonly evidence: string
  readonly redundantWith?: string
}

export function nativeFieldFacts(catalog: CatalogSnapshot, entity: CatalogEntity): readonly NativeFieldFact[] {
  const baseline = DEFAULT_CATALOG.entities[entity.id]
  const identity = nativeIdentity(entity)
  const record = nativeSourceRecord(entity)
  if (catalog.id !== DEFAULT_CATALOG.id || catalog.revisionId !== DEFAULT_CATALOG.revisionId || catalog.checksum !== DEFAULT_CATALOG.checksum || catalog.legacy !== DEFAULT_CATALOG.legacy && !sameValue(catalog.legacy, DEFAULT_CATALOG.legacy) || !nativeRecord(catalog.legacy) || catalog.legacy.sourceContentDigest !== NATIVE_GAME_DATA.contentDigest || !nativeDescriptionSourceMatches(NATIVE_GAME_DATA) || !baseline || !identity || !record || entity !== baseline && !sameValue(baseline, entity) && !sameValue(projectSourceSemantics(baseline), entity)) return []
  const sources = entity.sources.filter(source => source.sourceId.startsWith(NATIVE_SOURCE_PREFIX))
  const result: NativeFieldFact[] = []
  if (identity.database === 'equipment' && typeof record.EquipmentType === 'number' && Number.isSafeInteger(record.EquipmentType)) {
    const category = equipmentCategory(record.EquipmentType)
    const enumName = NATIVE_GAME_DATA.enums.EquipmentType?.[String(record.EquipmentType)]
    const original = entity.fields['Equipment Type']
    if (category && enumName === EQUIPMENT_TYPES[record.EquipmentType]?.replaceAll(' ', '') && original?.state === 'known' && original.value === `${enumName} (code ${record.EquipmentType})`) {
      const value: Knowledge<JsonValue> = { state: 'known', value: category.typeLabel, sources }
      const evidence = `Database/equipment.dat/${identity.databaseId}/EquipmentType; EquipmentType.${enumName} = ${record.EquipmentType}`
      result.push({ field: 'Equipment Type', original, value, differs: false, evidence })
      const alias = entity.fields.Type
      const labels: readonly string[] = [category.typeLabel, category.label, EQUIPMENT_TYPES[record.EquipmentType]!, enumName]
      const aliasLabel = alias?.state === 'known' && typeof alias.value === 'string' ? alias.value.trim().toLowerCase() : undefined
      if (alias && aliasLabel && labels.some(label => label.toLowerCase() === aliasLabel)) result.push({ field: 'Type', original: alias, value, differs: false, evidence, redundantWith: 'Equipment Type' })
    }
  }
  const flatValue = (field: string): number | undefined => {
    const tag = FLAT_STAT_FIELDS[STAT_LABELS[field] ?? field]
    if (!tag || !Array.isArray(record.StatMods)) return undefined
    const modifiers = record.StatMods.filter(nativeRecord).filter(modifier => NATIVE_GAME_DATA.enums.SangStatModTag?.[String(modifier.Tag)] === tag)
    const modifier = modifiers.length === 1 ? modifiers[0] : undefined
    return modifier && typeof modifier.Value1 === 'number' && Number.isSafeInteger(modifier.Value1) && modifier.Value2 === 0 && modifier.Value3 === 0 ? modifier.Value1 : undefined
  }
  if (identity.database === 'equipment' && Array.isArray(record.StatMods)) for (const [field, tag] of Object.entries(FLAT_STAT_FIELDS)) {
    const original = entity.fields[field]
    if (original?.state !== 'known' || typeof original.value !== 'number' || !sameValue(original, baseline.fields[field])) continue
    const value = flatValue(field)
    if (value === undefined) continue
    result.push({ field, original, value: { state: 'known', value, sources }, differs: original.value !== value, evidence: `Database/equipment.dat/${identity.databaseId}/StatMods; ${tag}` })
  }
  if (identity.database === 'equipment') for (const [field, original] of Object.entries(entity.fields)) {
    if (field !== 'Stat' && field !== 'Stat bonuses' && !field.includes('/') || original.state !== 'known' || typeof original.value !== 'string' || !sameValue(original, baseline.fields[field])) continue
    const lines = original.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const nativeLines = lines.map(line => {
      const match = /^([A-Za-z. ]+?)(?::\s*|\s+)([+-]?\d+)$/.exec(line)
      const value = match ? flatValue(match[1]!) : undefined
      if (!match || value === undefined) return undefined
      return { text: `${match[1]}: ${value >= 0 ? '+' : ''}${value}`, differs: Number(match[2]) !== value }
    })
    if (!nativeLines.length || nativeLines.some(line => !line)) continue
    result.push({ field, original, value: { state: 'known', value: nativeLines.map(line => line!.text).join('\n'), sources }, differs: nativeLines.some(line => line!.differs), evidence: `Database/equipment.dat/${identity.databaseId}/StatMods; exact named flat modifiers` })
  }
  const original = entity.fields.Effect
  const description = entity.id === SHOUDU_STEW_ID ? nativeDescription(entity) : undefined
  if (description?.complete && original && sameValue(original, baseline.fields.Effect)) result.push({ field: 'Effect', original, value: { state: 'known', value: description.lines.join('\n'), sources }, differs: true, evidence: 'Database/item.dat/132/AbilityID; Database/ability.dat/362/AbilityMods; DamageRateMissing_100: Value1=-100, Value2=Match, Attribute=HP' })
  return result
}
