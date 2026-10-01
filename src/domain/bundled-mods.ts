import { gameRecordFacts, GAME_RECORD_FIELD, type GameEnums } from './game-record-facts'
import { nativeRecord, type NativeRecord } from './native-game'
import type { CatalogEntity, CatalogEntityKind, EntityId, JsonValue, Knowledge, SourceRef } from './types'

export interface BundledModSnapshot {
  readonly schemaVersion: number
  readonly key: string
  readonly requiredMod: string
  readonly contentDigest: string
  readonly source: { readonly projectId: string; readonly title: string; readonly version: string; readonly editorVersion: number; readonly sha256: string; readonly timestamp: string | null; readonly author: string | null; readonly steamWorkshopFileId: string | null }
  readonly families: Readonly<Record<string, readonly NativeRecord[]>>
}
export const MOD_MODEL_KINDS: Readonly<Record<string, CatalogEntityKind>> = Object.freeze({ Jobs: 'class', Abilities: 'ability', Passives: 'passive', Equipment: 'item', Items: 'item', Monsters: 'monster', Statuses: 'status', Recipes: 'recipe', Biomes: 'location', Sparks: 'other', Troops: 'other' })
const MODEL_NAMES: Readonly<Record<string, string>> = Object.freeze({ Jobs: 'class', Abilities: 'ability', Passives: 'passive', Equipment: 'equipment', Items: 'item', Monsters: 'monster', Statuses: 'status', Recipes: 'recipe', Biomes: 'biome', Sparks: 'spark', Troops: 'troop' })

export function bundledModEntityId(key: string, family: string, id: number): EntityId {
  if (!MODEL_NAMES[family]) throw new Error(`Unsupported bundled mod family ${family}`)
  return `mod:${key}:${MODEL_NAMES[family]}:${id}` as EntityId
}

export function bundledModIdentity(entity: Pick<CatalogEntity, 'legacy'> & Partial<Pick<CatalogEntity, 'fields'>>): { readonly key: string; readonly family: string; readonly modelId: number; readonly version: string; readonly requiredMod: string } | undefined {
  const value = nativeRecord(entity.legacy) ? entity.legacy.bundledMod : undefined
  if (nativeRecord(value) && typeof value.key === 'string' && typeof value.family === 'string' && typeof value.modelId === 'number' && typeof value.version === 'string' && typeof value.requiredMod === 'string') return { key: value.key, family: value.family, modelId: value.modelId, version: value.version, requiredMod: value.requiredMod }
  const equipment = nativeRecord(entity.legacy) ? entity.legacy.equipmentExpansion : undefined
  const version = entity.fields?.['Mod version']
  return nativeRecord(equipment) && typeof equipment.family === 'string' && typeof equipment.modelId === 'number' && version?.state === 'known' && typeof version.value === 'string'
    ? { key: 'equipment-expansion', family: equipment.family, modelId: equipment.modelId, version: version.value, requiredMod: 'Equipment Expansion' } : undefined
}

export function bundledModLabel(entity: Pick<CatalogEntity, 'legacy' | 'fields'>): string | undefined {
  const identity = bundledModIdentity(entity)
  const source = entity.fields['Source mod']
  return identity ? `${source?.state === 'known' ? source.value : identity.key} ${identity.version} export` : undefined
}

export function bundledModRecord(entity: Pick<CatalogEntity, 'fields'>): NativeRecord | undefined {
  const field = entity.fields[GAME_RECORD_FIELD]
  return field?.state === 'known' && nativeRecord(field.value) ? field.value : undefined
}

export function buildBundledModEntities(snapshot: BundledModSnapshot, enums: GameEnums): Readonly<Record<string, CatalogEntity>> {
  const entities: Record<string, CatalogEntity> = {}
  for (const [family, records] of Object.entries(snapshot.families)) for (const [index, record] of records.entries()) {
    const kind = family === 'Passives' && record.IsInnate === true ? 'innate' : MOD_MODEL_KINDS[family]
    if (!kind || typeof record.ID !== 'number' || typeof record.Name !== 'string') throw new Error('Invalid bundled mod model identity')
    const id = bundledModEntityId(snapshot.key, family, record.ID)
    if (entities[id]) throw new Error('Duplicate bundled mod model identity')
    const source: SourceRef = { sourceId: `bundled-mod:${snapshot.key}:${snapshot.source.version}`, locator: `/${family}/${index}; model ID ${record.ID}`, snapshot: `${snapshot.source.title} ${snapshot.source.version}; SHA-256 ${snapshot.source.sha256}`, applicability: 'Exact values from this versioned mod export' }
    const known = (value: JsonValue): Knowledge<JsonValue> => ({ state: 'known', value, sources: [source] })
    entities[id] = { id, kind, name: record.Name.trim(), aliases: [], ...(typeof record.Description === 'string' && record.Description.trim() ? { rawDescription: record.Description } : {}),
      fields: { ...gameRecordFacts(record, kind, source, enums), Category: known([family === 'Jobs' ? 'Classes' : family, snapshot.source.title]), 'Source mod': known(snapshot.key === 'moonlight-project' ? 'Moonlight Project' : snapshot.source.title), 'Mod version': known(snapshot.source.version), 'Crystal Edit model ID': known(record.ID), 'Crystal Edit model type': known(family), [GAME_RECORD_FIELD]: known(record) },
      sources: [source], legacy: { bundledMod: { key: snapshot.key, family, modelId: record.ID, version: snapshot.source.version, requiredMod: snapshot.requiredMod, sourceDigest: snapshot.source.sha256 }, supplemental: false },
      ...(['passive', 'innate'].includes(kind) && typeof record.PP === 'number' ? { ppCost: { state: 'known' as const, value: record.PP, sources: [source] } } : {}),
    }
  }
  for (const job of Object.values(entities).filter(entity => entity.kind === 'class')) {
    const record = bundledModRecord(job)!
    for (const [field, family] of [['AbilityIDs', 'Abilities'], ['PassiveIDs', 'Passives']] as const) {
      if (!Array.isArray(record[field])) continue
      for (const id of record[field]) {
        if (typeof id !== 'number') continue
        const key = bundledModEntityId(snapshot.key, family, id)
        const target = entities[key]
        if (!target) continue
        const previous = target.fields.Class
        const classes = previous?.state === 'known' && Array.isArray(previous.value) ? previous.value : []
        entities[key] = { ...target, fields: { ...target.fields, Class: { state: 'known', value: [...new Set([...classes, job.name])], sources: [...(previous?.state === 'known' ? previous.sources ?? [] : []), ...job.sources] } } }
      }
    }
  }
  return entities
}
