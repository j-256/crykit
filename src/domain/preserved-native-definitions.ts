import receipts from '../catalog/preserved-native-definitions.json' with { type: 'json' }
import factReceipts from '../catalog/native-mod-fact-receipts.json' with { type: 'json' }
import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { catalogEntity } from './entity-identities'
import { modCatalogRevision, modCatalogForPin, modModelEntity, nativeModModelKey } from './mod-layers'
import { crystalEditPlanningRecord } from './crystal-edit-compatibility'
import { sameValue } from './definition-values'
import { gameRecordFacts } from './game-record-facts'
import { nativeIdentity, nativeSourceRecord, NATIVE_RECORD_FIELD } from './native-game'
import { withdrawnCatalog } from './withdrawn-catalogs'
import type { CatalogEntity, CatalogRef, CatalogSnapshot, JsonValue, Knowledge, LocalData, ModCatalogPin } from './types'

const preservedIds = new Set(receipts.entityIds)
const nativeRecordIds = new Set(factReceipts.nativeRecordEntityIds)

function preservedNativeContext(localData: LocalData, catalogs: readonly CatalogSnapshot[], ref: CatalogRef) {
  const origin = Object.values(localData.gameSetups).find(setup => setup.modComposition?.baseline.catalogId === ref.catalogId && modCatalogRevision(setup.id) === ref.catalogRevisionId && setup.catalogLock[ref.catalogId] === ref.catalogRevisionId)
  const baseline = origin?.modComposition?.baseline ?? ref
  if (baseline.catalogId !== receipts.source.id || baseline.catalogRevisionId !== receipts.source.revisionId || withdrawnCatalog(baseline)?.checksum !== receipts.source.checksum) return undefined
  const catalog = catalogs.find(catalog => catalog.id === receipts.equivalent.id && catalog.revisionId === receipts.equivalent.revisionId && catalog.checksum === receipts.equivalent.checksum)
  return catalog ? { catalog, composition: origin?.modComposition } : undefined
}

export function preservedNativeCatalog(localData: LocalData, catalogs: readonly CatalogSnapshot[], ref: CatalogRef): CatalogSnapshot | undefined {
  return preservedNativeContext(localData, catalogs, ref)?.catalog
}

function reviewedSourceFields(pin: ModCatalogPin, modelKey: string): readonly string[] | null | undefined {
  const receipt = factReceipts.sources.find(source => source.catalogId === pin.catalogId && source.interpretations.some(interpretation => pin.catalogRevisionId === `${source.checksum}:${interpretation}`))
  if (!receipt) return undefined
  // A complete native-model inventory distinguishes an absent override from an unavailable one
  return (receipt.records as Readonly<Record<string, readonly string[]>>)[modelKey] ?? null
}

function nativeFacts(entity: CatalogEntity, allowed: ReadonlySet<string>): CatalogEntity | undefined {
  const original = nativeSourceRecord(entity)
  const source = entity.sources.find(value => value.sourceId.startsWith('native-game:'))
  const identity = nativeIdentity(entity)
  if (!original || !source || !identity || !allowed.has('ID') || !allowed.has('Name') || ['passive', 'innate'].includes(entity.kind) && !allowed.has('IsInnate')) return undefined
  const record = Object.fromEntries(Object.entries(original).filter(([key]) => allowed.has(key)))
  const unknown = { state: 'unknown' as const, reason: 'This fact may be modified by an unavailable pinned mod source; upload the matching JSON to restore it' }
  const projected = gameRecordFacts(record, entity.kind, source, NATIVE_GAME_DATA.enums)
  const complete = gameRecordFacts(original, entity.kind, source, NATIVE_GAME_DATA.enums)
  const fields: Record<string, Knowledge<JsonValue>> = Object.fromEntries(Object.keys(complete).map(key => [key, projected[key] ?? unknown]))
  for (const key of ['Game platform', 'Game version', 'Mode data']) if (entity.fields[key]) fields[key] = entity.fields[key]
  fields[NATIVE_RECORD_FIELD] = { state: 'known', value: record, sources: [source] }
  // Rebuild only proven native facts, never wiki summaries or a vanilla copy of a changed field
  // Child membership stays known independently of each child's effects and learnability
  return { id: entity.id, kind: entity.kind, name: entity.name, aliases: [], sources: [source], fields, legacy: { native: { ...identity } }, ...(typeof record.Description === 'string' ? { rawDescription: record.Description } : {}), ...(['passive', 'innate'].includes(entity.kind) ? { ppCost: typeof record.PP === 'number' ? { state: 'known' as const, value: record.PP, sources: [source] } : unknown } : {}) }
}

export function preservedNativeDefinition(localData: LocalData, catalogs: readonly CatalogSnapshot[], ref: CatalogRef): CatalogEntity | undefined {
  if (!preservedIds.has(ref.entityId) && !nativeRecordIds.has(ref.entityId)) return undefined
  const context = preservedNativeContext(localData, catalogs, ref)
  const entity = context && catalogEntity(context.catalog, ref.entityId)
  if (!entity) return undefined

  // Complete definitions and native-record-only equivalences have separate receipts
  // Both bind exact revisions; equal names or IDs in another snapshot are insufficient
  const composition = context.composition
  const modelKey = nativeModModelKey(entity)
  const record = nativeSourceRecord(entity)
  let allowed = record && new Set(Object.keys(record))
  let projected = !preservedIds.has(ref.entityId)
  for (const layer of composition?.layers ?? []) {
    if (!layer.enabled) continue
    const links = composition!.links.filter(link => link.targetEntityId !== null && (link.targetEntityId === entity.id || link.modelKey === modelKey) && (!link.projectId || link.projectId === layer.catalogId))
    for (const link of links) {
      const source = modCatalogForPin(catalogs, layer)
      const replacement = source && modModelEntity(source, link.modelKey)
      if (source && !replacement) continue
      const unavailable = source ? undefined : reviewedSourceFields(layer, link.modelKey)
      if (unavailable === null) continue
      // Whole-record priority still applies: a later proven override supersedes an unknown earlier one
      // Preserve individual equal fields rather than making a learning-tree edit own the entire class
      if (!record || link.modelKey !== modelKey || !replacement && !unavailable) { allowed = undefined; continue }
      const incoming = replacement && crystalEditPlanningRecord(replacement)
      allowed = incoming ? new Set(Object.keys(record).filter(key => Object.hasOwn(incoming, key) && sameValue(record[key], incoming[key]))) : unavailable ? new Set(Object.keys(record).filter(key => !unavailable.includes(key))) : undefined
      projected = true
    }
  }
  return !allowed ? undefined : projected ? nativeFacts(entity, allowed) : entity
}
