import { DEFAULT_CATALOG } from './bundled'
import { NATIVE_GAME_DATA } from './native-game'
import { nativeDescription, nativeDescriptionSourceMatches } from './native-description'
import { FLAT_STAT_FIELDS } from './native-field-facts'
import { projectSourceSemantics } from './source-semantics'
import { sameValue } from '../domain/definition-values'
import { nativeIdentity, nativeRecord, nativeSourceRecord, NATIVE_SOURCE_PREFIX } from '../domain/native-game'
import type { CatalogEntity, CatalogSnapshot, JsonValue, Knowledge } from '../domain/types'

const FIELDS_BY_TAG = new Map(Object.entries(FLAT_STAT_FIELDS).map(([field, tag]) => [tag, field]))
const SUMMARY_FIELDS = new Set(['Stat', 'Stat bonuses', 'Effect', 'Other effects'])
const SLASH_STAT_FIELDS = new Set([...Object.keys(FLAT_STAT_FIELDS), 'Def. Pierce', 'Res. Pierce', 'Max. HP', 'Max. MP'])

export interface NativeEquipmentFact {
  readonly field: string
  readonly value: Knowledge<JsonValue>
  readonly evidence: string
}

export interface NativeEquipmentProjection {
  readonly facts: readonly NativeEquipmentFact[]
  readonly archivedFields: readonly (readonly [string, Knowledge<JsonValue>])[]
}

export function nativeEquipmentFacts(catalog: CatalogSnapshot, entity: CatalogEntity): NativeEquipmentProjection | undefined {
  const baseline = DEFAULT_CATALOG.entities[entity.id]
  const identity = nativeIdentity(entity)
  const record = nativeSourceRecord(entity)
  if (catalog.id !== DEFAULT_CATALOG.id || catalog.revisionId !== DEFAULT_CATALOG.revisionId || catalog.checksum !== DEFAULT_CATALOG.checksum || catalog.legacy !== DEFAULT_CATALOG.legacy && !sameValue(catalog.legacy, DEFAULT_CATALOG.legacy) || !nativeRecord(catalog.legacy) || catalog.legacy.sourceContentDigest !== NATIVE_GAME_DATA.contentDigest || !nativeDescriptionSourceMatches(NATIVE_GAME_DATA) || !baseline || identity?.database !== 'equipment' || !record || entity !== baseline && !sameValue(baseline, entity) && !sameValue(projectSourceSemantics(baseline), entity)) return undefined
  if (!Array.isArray(record.StatMods) || !record.StatMods.every(modifier => nativeRecord(modifier) && ['Tag', 'Value1', 'Value2', 'Value3'].every(field => typeof modifier[field] === 'number' && Number.isSafeInteger(modifier[field])) && typeof NATIVE_GAME_DATA.enums.SangStatModTag?.[String(modifier.Tag)] === 'string')) return undefined
  const sources = entity.sources.filter(source => source.sourceId.startsWith(NATIVE_SOURCE_PREFIX))
  const locator = sources.find(source => source.locator)?.locator ?? `Native equipment ID ${identity.databaseId}; ${identity.mode} mode`
  const facts: NativeEquipmentFact[] = []
  const tags = record.StatMods.map(modifier => nativeRecord(modifier) ? modifier.Tag : undefined)
  for (const modifier of record.StatMods) {
    if (!nativeRecord(modifier)) continue
    const tag = NATIVE_GAME_DATA.enums.SangStatModTag?.[String(modifier.Tag)]
    const field = tag && FIELDS_BY_TAG.get(tag)
    if (!field || typeof modifier.Value1 !== 'number' || modifier.Value2 !== 0 || modifier.Value3 !== 0 || tags.filter(candidate => candidate === modifier.Tag).length !== 1) continue
    facts.push({ field, value: { state: 'known', value: modifier.Value1, sources }, evidence: `${locator}; StatMods; ${tag}` })
  }
  const complete = record.HideStatModsFromDescription !== true && nativeDescription(entity)?.complete === true
  const archivedFields = complete ? Object.entries(entity.fields).filter(([field]) => SUMMARY_FIELDS.has(field) || field.includes('/') && field.split('/').every(component => SLASH_STAT_FIELDS.has(component.trim()))) : []
  return { facts, archivedFields }
}
