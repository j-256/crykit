import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS, jsonRecord } from './crystal-edit'
import type { CatalogEntity, CatalogSnapshot, JsonValue, Knowledge } from './types'

export const MOD_SEARCH_PREVIEW_FIELD = 'bundledSearchPreview'
const SEARCH_DESCRIPTION_LIMIT = 4000
const SEARCH_FIELDS = new Set(['Description', 'Type', 'Category', 'Cost', 'Learning cost', 'Stat modifiers', 'Ability modifiers', 'Hands', 'Unique', 'Class', 'Crystal Edit model ID', 'Crystal Edit model type', 'Crystal Edit editor version', 'Crystal Edit localization project', 'Source mod project ID', ...Object.values(CLASS_FIELDS), ...Object.values(CRYSTAL_EDIT_FIELDS)])
const SEARCH_ARRAY_FIELDS = new Set(['StatMods', 'EquipmentTypes', 'AbilityIDs', 'PassiveIDs', 'LearnTree'])
const SEARCH_ARTWORK_FIELDS = new Set(['ActorTexturePathM', 'ActorTexturePathF', 'TexturePath'])

export function isModSearchPreview(catalog: CatalogSnapshot): boolean {
  return jsonRecord(catalog.legacy) && catalog.legacy[MOD_SEARCH_PREVIEW_FIELD] === true
}

export function modSearchCatalog(catalog: CatalogSnapshot): CatalogSnapshot {
  const entities: Record<string, CatalogEntity> = {}
  for (const entity of Object.values(catalog.entities)) {
    const fields: Record<string, Knowledge<JsonValue>> = {}
    for (const [key, field] of Object.entries(entity.fields)) if (SEARCH_FIELDS.has(key)) {
      const value = Object.fromEntries(Object.entries(field).filter(([key]) => key !== 'sources')) as Knowledge<JsonValue>
      fields[key] = value.state === 'known' && typeof value.value === 'string' ? { ...value, value: value.value.slice(0, SEARCH_DESCRIPTION_LIMIT) } : value
    }
    const raw = entity.fields['Crystal Edit source record']
    if (raw?.state === 'known' && jsonRecord(raw.value)) fields['Crystal Edit source record'] = { state: 'known', sources: raw.sources, value: Object.fromEntries(Object.entries(raw.value).filter(([key, value]) => key === 'ID' || key === 'Name' || typeof value === 'number' || typeof value === 'boolean' || SEARCH_ARRAY_FIELDS.has(key) || SEARCH_ARTWORK_FIELDS.has(key))) }
    entities[entity.id] = { id: entity.id, kind: entity.kind, name: entity.name, aliases: entity.aliases, fields, sources: entity.sources.slice(0, 1), ...(entity.rawDescription ? { rawDescription: entity.rawDescription.slice(0, SEARCH_DESCRIPTION_LIMIT) } : {}), ...(entity.ppCost ? { ppCost: entity.ppCost } : {}) }
  }
  return { ...catalog, entities, legacy: { ...(jsonRecord(catalog.legacy) ? catalog.legacy : {}), gameRules: null, [MOD_SEARCH_PREVIEW_FIELD]: true } }
}

export function mergeModSearchCatalogs(loaded: readonly CatalogSnapshot[], previews: readonly CatalogSnapshot[]): readonly CatalogSnapshot[] {
  const projects = new Set(loaded.map(catalog => catalog.id))
  return [...loaded, ...previews.filter(catalog => !projects.has(catalog.id))]
}
