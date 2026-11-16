import { bundledCatalogForSnapshot } from './bundled'
import { sameCatalogLegacy } from '../interchange/native'
import { NATIVE_GAME_DATA } from './native-game'
import { nativeDescriptionSourceMatches } from './native-description'
import { sameValue } from '../domain/definition-values'
import { EQUIPMENT_TYPES } from '../domain/crystal-edit'
import { equipmentCategory } from '../domain/equipment-categories'
import { nativeIdentity, nativeRecord, nativeSourceRecord, NATIVE_SOURCE_PREFIX } from '../domain/native-game'
import type { CatalogEntity, CatalogSnapshot, JsonValue, Knowledge } from '../domain/types'

export const FLAT_STAT_FIELDS: Readonly<Record<string, string>> = Object.freeze({ Attack: 'Flat_PAtk', Defense: 'Flat_PDef', Resistance: 'Flat_MDef', 'Def pierce': 'Flat_PPen', 'Res pierce': 'Flat_MPen', Accuracy: 'Flat_PAccRating', Evasion: 'Flat_PEvaRating', Strength: 'Flat_Str', Vitality: 'Flat_Vit', Dexterity: 'Flat_Dex', Agility: 'Flat_Agi', Mind: 'Flat_Mnd', Spirit: 'Flat_Spi', Speed: 'Flat_Spd', Luck: 'Flat_Lck', 'Max hp': 'Flat_HP', 'Max mp': 'Flat_MP' })

export interface NativeFieldFact {
  readonly field: string
  readonly original: Knowledge<JsonValue>
  readonly value: Knowledge<JsonValue>
  readonly differs: boolean
  readonly evidence: string
  readonly redundantWith?: string
}

export function nativeFieldFacts(catalog: CatalogSnapshot, entity: CatalogEntity): readonly NativeFieldFact[] {
  const snapshot = bundledCatalogForSnapshot(catalog)
  const baseline = snapshot?.entities[entity.id]
  const identity = nativeIdentity(entity)
  const record = nativeSourceRecord(entity)
  if (!snapshot || !sameCatalogLegacy(catalog, snapshot) || !nativeRecord(catalog.legacy) || catalog.legacy.sourceContentDigest !== NATIVE_GAME_DATA.contentDigest || !nativeDescriptionSourceMatches(NATIVE_GAME_DATA) || !baseline || !identity || !record || entity !== baseline && !sameValue(baseline, entity)) return []
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
  return result
}
