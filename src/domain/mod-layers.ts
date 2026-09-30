import { DomainError } from './core'
import { jsonRecord, LEARN_NODE_TYPES } from './crystal-edit'
import type { CatalogEntity, CatalogRevisionId, CatalogSnapshot, EntityId, GameSetupRevision, ModCatalogPin, ModComposition } from './types'

export const MOD_CATALOG_SCHEMA = 'game-setup-mod-catalog-1'
export const CRYSTAL_EDIT_CATALOG_SCHEMA = 'crystal-edit-json-1'
export const MAX_MOD_LAYERS = 100
const MAX_NATIVE_ID = 0xffffffff
const MODEL_KEY = /^crystal-edit:(Jobs|Abilities|Passives|Equipment|Items|Monsters|Statuses|Recipes|Biomes):(0|[1-9]\d*)$/

export function modCatalogTitle(catalog: CatalogSnapshot): string {
  return jsonRecord(catalog.legacy) && typeof catalog.legacy.projectTitle === 'string' ? catalog.legacy.projectTitle : catalog.id.replace(/^crystal-edit:/, '')
}

export function modCatalogForPin(catalogs: readonly CatalogSnapshot[], pin: ModCatalogPin): CatalogSnapshot | undefined {
  return catalogs.find(catalog => catalog.id === pin.catalogId && catalog.revisionId === pin.catalogRevisionId)
}

export function modCatalogRevision(id: GameSetupRevision['id']): CatalogRevisionId {
  return `mod-setup:${id}` as CatalogRevisionId
}

export function assertModComposition(composition: ModComposition): void {
  if (composition.layers.length > MAX_MOD_LAYERS) throw new DomainError('INVALID_INPUT', `A Game Setup supports up to ${MAX_MOD_LAYERS} imported mod layers`)
  const projects = new Set<string>()
  for (const layer of composition.layers) {
    if (projects.has(layer.catalogId)) throw new DomainError('INVALID_INPUT', 'Choose only one revision of each imported mod project')
    projects.add(layer.catalogId)
  }
  const keys = new Set<string>()
  for (const link of composition.links) {
    const match = MODEL_KEY.exec(link.modelKey)
    if (!match || Number(match[2]) > MAX_NATIVE_ID || keys.has(link.modelKey)) throw new DomainError('INVALID_INPUT', 'Mod replacement links require unique native model identities')
    keys.add(link.modelKey)
  }
}

export interface ModLayerChange {
  readonly modelKey: string
  readonly entity: CatalogEntity
  readonly source: ModCatalogPin
  readonly sourceTitle: string
  readonly superseded: readonly string[]
  readonly targetEntityId: EntityId
  readonly targetState: 'linked' | 'separate' | 'unresolved'
}

export interface ModLayerResult {
  readonly entities: Readonly<Record<string, CatalogEntity>>
  readonly identities: Readonly<Record<string, string>>
  readonly changes: readonly ModLayerChange[]
  readonly unresolvedReferences: readonly string[]
}

export function composeModLayers(composition: ModComposition, catalogs: readonly CatalogSnapshot[]): ModLayerResult {
  assertModComposition(composition)
  const baseline = modCatalogForPin(catalogs, composition.baseline)
  if (!baseline || baseline.schemaVersion === MOD_CATALOG_SCHEMA || baseline.schemaVersion === CRYSTAL_EDIT_CATALOG_SCHEMA) throw new DomainError('INVALID_INPUT', 'The mod baseline must be an available original catalog revision')
  const winners = new Map<string, Omit<ModLayerChange, 'targetEntityId' | 'targetState'>>()
  const availableModels = new Map<string, CatalogEntity>()
  for (const layer of composition.layers) {
    const catalog = modCatalogForPin(catalogs, layer)
    if (!catalog || catalog.schemaVersion !== CRYSTAL_EDIT_CATALOG_SCHEMA) throw new DomainError('INVALID_INPUT', 'An imported mod layer references an unavailable Crystal Edit revision')
    for (const entity of Object.values(catalog.entities)) {
      const identity = MODEL_KEY.exec(entity.id)
      if (!identity || Number(identity[2]) > MAX_NATIVE_ID) throw new DomainError('INVALID_INPUT', 'Imported mod models require native family and ID identities')
      availableModels.set(entity.id, entity)
      if (!layer.enabled) continue
      const previous = winners.get(entity.id)
      winners.set(entity.id, { modelKey: entity.id, entity, source: layer, sourceTitle: modCatalogTitle(catalog), superseded: previous ? [...previous.superseded, previous.sourceTitle] : [] })
    }
  }
  const links = new Map(composition.links.map(link => [link.modelKey, link.targetEntityId]))
  const occupiedTargets = new Map<string, string>()
  for (const link of composition.links) {
    if (!availableModels.has(link.modelKey)) throw new DomainError('INVALID_INPUT', 'A replacement link references a model absent from the chosen mod revisions')
    if (link.targetEntityId === null) continue
    const target = baseline.entities[link.targetEntityId]
    const definition = availableModels.get(link.modelKey)
    if (!target || target.kind !== definition?.kind) throw new DomainError('INVALID_INPUT', 'A bundled replacement target must exist and have the same definition kind')
    if (occupiedTargets.has(link.targetEntityId)) throw new DomainError('INVALID_INPUT', 'Different native model identities cannot replace the same bundled definition')
    occupiedTargets.set(link.targetEntityId, link.modelKey)
  }
  const entities: Record<string, CatalogEntity> = { ...baseline.entities }
  const identities: Record<string, string> = {}
  const changes: ModLayerChange[] = []
  for (const [modelKey, winner] of winners) {
    const target = links.get(modelKey)
    const targetEntityId = target ?? modelKey as EntityId
    const targetState = target ? 'linked' : links.has(modelKey) ? 'separate' : 'unresolved'
    const entity: CatalogEntity = { ...winner.entity, id: targetEntityId, fields: { ...winner.entity.fields, 'Effective mod layer': { state: 'known', value: winner.sourceTitle, sources: winner.entity.sources } } }
    entities[targetEntityId] = entity
    identities[modelKey] = targetEntityId
    changes.push({ ...winner, entity, targetEntityId, targetState, superseded: target ? [baseline.entities[target]!.name + ' (bundled)', ...winner.superseded] : winner.superseded })
  }
  const missing = new Set<string>()
  for (const change of changes) {
    const field = change.entity.fields['Crystal Edit source record']
    const record = field?.state === 'known' && jsonRecord(field.value) ? field.value : undefined
    if (!record) continue
    for (const [key, family] of [['AbilityIDs', 'Abilities'], ['PassiveIDs', 'Passives']] as const) {
      if (Array.isArray(record[key])) for (const id of record[key]) if (!identities[`crystal-edit:${family}:${id}`]) missing.add(`${family} #${id}`)
    }
    if (Array.isArray(record.LearnTree)) for (const column of record.LearnTree) if (Array.isArray(column)) for (const node of column) {
      if (!jsonRecord(node)) continue
      const family = node.NodeType === LEARN_NODE_TYPES.ability ? 'Abilities' : node.NodeType === LEARN_NODE_TYPES.passive ? 'Passives' : undefined
      if (family && !identities[`crystal-edit:${family}:${node.DataID}`]) missing.add(`${family} #${node.DataID}`)
    }
  }
  return { entities, identities, changes, unresolvedReferences: [...missing] }
}

export function composeModCatalog(gameSetup: GameSetupRevision, catalogs: readonly CatalogSnapshot[]): CatalogSnapshot | undefined {
  if (!gameSetup.modComposition) return undefined
  const baseline = modCatalogForPin(catalogs, gameSetup.modComposition.baseline)!
  const result = composeModLayers(gameSetup.modComposition, catalogs)
  return { ...baseline, revisionId: modCatalogRevision(gameSetup.id), schemaVersion: MOD_CATALOG_SCHEMA, checksum: `composition:${gameSetup.id}`, importedAt: gameSetup.createdAt, entities: Object.fromEntries(result.changes.map(change => [change.targetEntityId, change.entity])), claims: [], applicability: { state: 'unknown', reason: 'User-selected mod priority and bundled links; game load order and platform parity are unverified' }, rights: { state: 'unknown', reason: 'Source catalogs retain their individual rights' }, legacy: { ...(jsonRecord(baseline.legacy) && jsonRecord(baseline.legacy.nativeIdentityBindings) ? { nativeIdentityBindings: baseline.legacy.nativeIdentityBindings, nativeEnums: baseline.legacy.nativeEnums } : {}), modGameSetupRevisionId: gameSetup.id, modBaseline: { ...gameSetup.modComposition.baseline }, crystalEditIdentities: result.identities, unresolvedReferences: result.unresolvedReferences } }
}

export function expandModCatalogs(catalogs: readonly CatalogSnapshot[]): readonly CatalogSnapshot[] {
  if (!catalogs.some(catalog => catalog.schemaVersion === MOD_CATALOG_SCHEMA)) return catalogs
  return catalogs.map(catalog => {
    if (catalog.schemaVersion !== MOD_CATALOG_SCHEMA) return catalog
    const metadata = jsonRecord(catalog.legacy) ? catalog.legacy : undefined
    const pin = metadata?.modBaseline
    if (!jsonRecord(pin) || typeof pin.catalogId !== 'string' || typeof pin.catalogRevisionId !== 'string') throw new DomainError('INVALID_INPUT', 'An effective mod catalog requires an exact baseline pin')
    const baseline = modCatalogForPin(catalogs, pin as unknown as ModCatalogPin)
    if (!baseline || baseline.schemaVersion === MOD_CATALOG_SCHEMA) throw new DomainError('INVALID_INPUT', 'An effective mod baseline is unavailable or cyclic')
    const compact = compactModCatalog(catalog)
    return { ...compact, entities: { ...baseline.entities, ...compact.entities }, claims: baseline.claims.filter(claim => !Object.hasOwn(compact.entities, claim.entityId)) }
  })
}

export function compactModCatalog(catalog: CatalogSnapshot): CatalogSnapshot {
  if (catalog.schemaVersion !== MOD_CATALOG_SCHEMA) return catalog
  const identities = jsonRecord(catalog.legacy) && jsonRecord(catalog.legacy.crystalEditIdentities) ? catalog.legacy.crystalEditIdentities : undefined
  const changed = new Set(Object.values(identities ?? {}).filter((value): value is string => typeof value === 'string'))
  return { ...catalog, entities: Object.fromEntries(Object.entries(catalog.entities).filter(([key]) => changed.has(key))), claims: [] }
}

export function modEntity(catalog: CatalogSnapshot, entityId: string): CatalogEntity | undefined {
  const identities = jsonRecord(catalog.legacy) && jsonRecord(catalog.legacy.crystalEditIdentities) ? catalog.legacy.crystalEditIdentities : undefined
  const target = identities?.[entityId]
  const key = typeof target === 'string' ? target : entityId
  return Object.hasOwn(catalog.entities, key) ? catalog.entities[key] : undefined
}
