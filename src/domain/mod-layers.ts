import { withdrawnCatalog } from './withdrawn-catalogs'
import { DomainError } from './core'
import { classFields, jsonRecord, LEARN_NODE_TYPES } from './crystal-edit'
import { catalogEntity } from './entity-identities'
import { bundledModIdentity } from './bundled-mods'
import type { BundledLibraryMod } from './mod-library'
import { assertModIdentityMappings, mappedModId, modIdentityMappings, originalModIdentity, remapModRecord } from './mod-identities'
import { CRYSTAL_EDIT_LOCALIZATION_FIELD, CRYSTAL_EDIT_VERSION_FIELD, interpretCrystalEditRecord, supportsCrystalEditVersion } from './crystal-edit-compatibility'
import { gameRecordFacts } from './game-record-facts'
import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { nativeIdentity } from './native-game'
import type { CatalogEntity, CatalogRevisionId, CatalogSnapshot, EntityId, GameSetupRevision, ModCatalogPin, ModComposition, ModDefinitionLink } from './types'

export const MOD_CATALOG_SCHEMA = 'game-setup-mod-catalog-1'
export const CRYSTAL_EDIT_CATALOG_SCHEMA = 'crystal-edit-json-1'
export const MOD_COMPOSITION_VERSION = 3
export const MAX_MOD_LAYERS = 100
const MAX_NATIVE_ID = 0xffffffff
const MODEL_KEY = /^crystal-edit:(Jobs|Abilities|Passives|Equipment|Items|Monsters|Statuses|Recipes|Biomes|Genders):(0|[1-9]\d*)$/
const BASELINE_METADATA_KEYS = ['nativeIdentityBindings', 'nativeModeIdentityBindings', 'nativeEnums'] as const
const NATIVE_MOD_FAMILIES: Readonly<Record<string, string>> = Object.freeze({ job: 'Jobs', ability: 'Abilities', passive: 'Passives', equipment: 'Equipment', item: 'Items', monster: 'Monsters', status: 'Statuses', recipe: 'Recipes', biome: 'Biomes', gender: 'Genders' })

export function modCatalogTitle(catalog: CatalogSnapshot): string {
  return jsonRecord(catalog.legacy) && typeof catalog.legacy.projectTitle === 'string' ? catalog.legacy.projectTitle : catalog.id.replace(/^crystal-edit:/, '')
}

export function modCatalogForPin(catalogs: readonly CatalogSnapshot[], pin: ModCatalogPin): CatalogSnapshot | undefined {
  return catalogs.find(catalog => catalog.id === pin.catalogId && catalog.revisionId === pin.catalogRevisionId)
}

export function modModelRecords(catalog: CatalogSnapshot): ReadonlyMap<string, CatalogEntity> {
  const identities = jsonRecord(catalog.legacy) && jsonRecord(catalog.legacy.crystalEditIdentities) ? catalog.legacy.crystalEditIdentities : {}
  const keys = new Map<string, string>()
  for (const [key, target] of Object.entries(identities)) {
    if (!MODEL_KEY.test(key) || typeof target !== 'string' || keys.has(target)) throw new DomainError('INVALID_INPUT', 'Imported mod models require unique native family and ID identities')
    keys.set(target, key)
  }
  const models = new Map<string, CatalogEntity>()
  for (const entity of Object.values(catalog.entities)) {
    const key = keys.get(entity.id)
    const identity = key && MODEL_KEY.exec(key)
    if (!identity || Number(identity[2]) > MAX_NATIVE_ID || models.has(key!)) throw new DomainError('INVALID_INPUT', 'Imported mod models require native family and ID identities')
    models.set(key!, entity)
  }
  return models
}

export function modCatalogRevision(id: GameSetupRevision['id']): CatalogRevisionId {
  return `mod-setup:${id}` as CatalogRevisionId
}

export function modReplacementKindMatches(target: CatalogEntity, incoming: CatalogEntity): boolean {
  return target.kind === incoming.kind || ['innate', 'passive'].includes(target.kind) && ['innate', 'passive'].includes(incoming.kind)
}

export function nativeModReplacementLinks(baseline: CatalogSnapshot, incoming: CatalogSnapshot): ModComposition['links'] {
  const targets = new Map<string, CatalogEntity[]>()
  for (const entity of Object.values(baseline.entities)) {
    const native = nativeIdentity(entity)
    const family = native && native.mode === 'base' ? NATIVE_MOD_FAMILIES[native.database] : undefined
    if (!native || !family) continue
    const key = `crystal-edit:${family}:${native.databaseId}`
    targets.set(key, [...targets.get(key) ?? [], entity])
  }
  return [...modModelRecords(incoming)].flatMap(([modelKey, entity]) => {
    const candidates = targets.get(modelKey)
    return candidates?.length === 1 && modReplacementKindMatches(candidates[0]!, entity) ? [{ modelKey, targetEntityId: candidates[0]!.id }] : []
  })
}

export function bundledModReplacementLinks(baseline: CatalogSnapshot, incoming: CatalogSnapshot, bundled: readonly BundledLibraryMod[]): ModComposition['links'] {
  const mod = bundled.find(value => value.id === incoming.id)
  if (!mod) return []
  const models = modModelRecords(incoming)
  const candidates = new Map<string, { readonly rank: number; readonly entities: readonly CatalogEntity[] }>()
  for (const entity of Object.values(baseline.entities)) {
    const identity = bundledModIdentity(entity)
    const source = mod.sourceRecordField && entity.fields[mod.sourceRecordField]
    const native = mod.nativeBaseReplacements && nativeIdentity(entity)
    const family = native && native.mode === 'base' ? NATIVE_MOD_FAMILIES[native.database] : undefined
    const modelKey = identity?.key === mod.key ? `crystal-edit:${identity.family}:${identity.modelId}`
      : source && source.state === 'known' && jsonRecord(source.value) && typeof source.value.ID === 'number' ? `crystal-edit:Passives:${source.value.ID}`
      : family && native && mod.models[family]?.includes(native.databaseId) ? `crystal-edit:${family}:${native.databaseId}` : undefined
    if (modelKey) {
      const rank = identity?.key === mod.key ? 3 : source && source.state === 'known' ? 2 : 1
      const previous = candidates.get(modelKey)
      if (!previous || rank > previous.rank) candidates.set(modelKey, { rank, entities: [entity] })
      else if (rank === previous.rank) candidates.set(modelKey, { rank, entities: [...previous.entities, entity] })
    }
  }
  return [...models].flatMap(([modelKey, entity]) => {
    const targets = candidates.get(modelKey)?.entities
    const [, family, id] = modelKey.split(':')
    return targets?.length === 1 && modReplacementKindMatches(targets[0]!, entity) ? [{ modelKey, ...(!originalModIdentity(family!, Number(id)) ? { projectId: incoming.id } : {}), targetEntityId: targets[0]!.id }] : []
  })
}

export function assertModComposition(composition: ModComposition): void {
  assertModIdentityMappings(composition)
  if (composition.version === 3 && !composition.identityMappings) throw new DomainError('INVALID_INPUT', 'Project-scoped compositions require persisted identity mappings')
  if (composition.version !== undefined && composition.version !== 2 && composition.version !== MOD_COMPOSITION_VERSION) throw new DomainError('INVALID_INPUT', 'Unsupported mod composition version')
  if (composition.layers.length > MAX_MOD_LAYERS) throw new DomainError('INVALID_INPUT', `A Game Setup supports up to ${MAX_MOD_LAYERS} imported mod layers`)
  const projects = new Set<string>()
  for (const layer of composition.layers) {
    if (projects.has(layer.catalogId)) throw new DomainError('INVALID_INPUT', 'Choose only one revision of each imported mod project')
    projects.add(layer.catalogId)
  }
  const keys = new Set<string>()
  for (const link of composition.links) {
    const match = MODEL_KEY.exec(link.modelKey)
    if (link.projectId && (composition.version !== 3 || !composition.layers.some(layer => layer.catalogId === link.projectId) || match && originalModIdentity(match[1]!, Number(match[2])))) throw new DomainError('INVALID_INPUT', 'Project replacement links require an added identity from a selected version 3 layer')
    if (!match || Number(match[2]) > MAX_NATIVE_ID || keys.has(modLinkKey(link))) throw new DomainError('INVALID_INPUT', 'Mod replacement links require unique native model identities')
    keys.add(modLinkKey(link))
  }
}

// A saved composition cannot be rebuilt from different revisions without changing its meaning
// Only recognized historical gaps qualify; arbitrary missing imports still fail validation
export function hasWithdrawnModDependencies(composition: ModComposition, catalogs: readonly CatalogSnapshot[]): boolean {
  assertModComposition(composition)
  const missing = [composition.baseline, ...composition.layers].filter(pin => !modCatalogForPin(catalogs, pin))
  if (missing.some(pin => !withdrawnCatalog(pin))) throw new DomainError('INVALID_INPUT', 'A mod composition references an unavailable catalog revision')
  return missing.length > 0
}

export interface ModLayerChange {
  readonly modelKey: string
  readonly originalModelKey?: string
  readonly identityProjectId?: ModCatalogPin['catalogId']
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
  readonly sourceIdentities: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly changes: readonly ModLayerChange[]
  readonly unresolvedReferences: readonly string[]
}

export function composeModLayers(composition: ModComposition, catalogs: readonly CatalogSnapshot[]): ModLayerResult {
  assertModComposition(composition)
  const baseline = modCatalogForPin(catalogs, composition.baseline)
  if (!baseline || baseline.schemaVersion === MOD_CATALOG_SCHEMA || baseline.schemaVersion === CRYSTAL_EDIT_CATALOG_SCHEMA) throw new DomainError('INVALID_INPUT', 'The mod baseline must be an available original catalog revision')
  const mappings = modIdentityMappings(composition, catalogs)
  if (composition.version === 3 && mappings.length !== composition.identityMappings?.length) throw new DomainError('INVALID_INPUT', 'Project identity mappings are incomplete for the pinned mod revisions')
  const scoped = composition.version === 3
  const winners = new Map<string, Omit<ModLayerChange, 'targetEntityId' | 'targetState'>>()
  const links = new Map(composition.links.map(link => [modLinkKey(link), link.targetEntityId]))
  const availableModels = new Map<string, CatalogEntity>()
  for (const layer of composition.layers) {
    const catalog = modCatalogForPin(catalogs, layer)
    if (!catalog || catalog.schemaVersion !== CRYSTAL_EDIT_CATALOG_SCHEMA) throw new DomainError('INVALID_INPUT', 'An imported mod layer references an unavailable Crystal Edit revision')
    for (const [originalModelKey, originalEntity] of modModelRecords(catalog)) {
      const [, family, originalId] = originalModelKey.split(':')
      const added = scoped && !originalModIdentity(family!, Number(originalId))
      const modelKey = scoped ? `crystal-edit:${family}:${mappedModId(mappings, catalog.id, family!, Number(originalId))}` : originalModelKey
      const linkKey = modLinkKey({ modelKey: originalModelKey, ...(added ? { projectId: catalog.id } : {}) })
      availableModels.set(linkKey, originalEntity)
      const entity = scoped ? remappedModEntity(originalEntity, family!, catalog.id, mappings) : originalEntity
      if (!layer.enabled) continue
      const previous = winners.get(modelKey)
      const localization = composition.version !== undefined && jsonRecord(catalog.legacy) && jsonRecord(catalog.legacy.gameRules) && catalog.legacy.gameRules.localization === true
      const target = links.get(linkKey)
      const original = previous?.entity ?? (target ? baseline.entities[target] : undefined)
      if (localization && !original) continue
      // Localization changes display text and source attribution without replacing mechanical fields
      const effective = localization ? { ...original!, ...(scoped ? { sources: [...original!.sources, ...entity.sources] } : {}), name: entity.name, ...(entity.rawDescription !== undefined ? { rawDescription: entity.rawDescription } : {}), fields: { ...original!.fields, ...(entity.fields.Description ? { Description: entity.fields.Description } : {}) } } : entity
      winners.set(modelKey, { modelKey, ...(scoped ? { originalModelKey, identityProjectId: localization ? previous?.identityProjectId ?? previous?.source.catalogId ?? layer.catalogId : layer.catalogId } : {}), entity: effective, source: layer, sourceTitle: modCatalogTitle(catalog), superseded: previous ? [...previous.superseded, previous.sourceTitle] : [] })
    }
  }
  const occupiedTargets = new Map<string, string>()
  for (const link of composition.links) {
    if (!availableModels.has(modLinkKey(link))) throw new DomainError('INVALID_INPUT', 'A replacement link references a model absent from the chosen mod revisions')
    if (link.targetEntityId === null) continue
    const target = catalogEntity(baseline, link.targetEntityId)
    const definition = availableModels.get(modLinkKey(link))
    if (!target || !definition || !modReplacementKindMatches(target, definition)) throw new DomainError('INVALID_INPUT', 'A bundled replacement target must exist and have the same definition kind')
    if (occupiedTargets.has(target.id)) throw new DomainError('INVALID_INPUT', 'Different native model identities cannot replace the same bundled definition')
    occupiedTargets.set(target.id, link.modelKey)
  }
  const entities: Record<string, CatalogEntity> = { ...baseline.entities }
  const identities: Record<string, string> = {}
  const changes: ModLayerChange[] = []
  const sourceIdentities: Record<string, Record<string, string>> = {}
  for (const [modelKey, winner] of winners) {
    const originalKey = winner.originalModelKey ?? modelKey
    const [, family, originalId] = originalKey.split(':')
    const added = scoped && !originalModIdentity(family!, Number(originalId))
    const linkKey = modLinkKey({ modelKey: originalKey, ...(added ? { projectId: winner.identityProjectId ?? winner.source.catalogId } : {}) })
    const target = links.get(linkKey)
    const targetEntityId = target ?? winner.entity.id
    // Explicit null and newly added records remain separate; absent replacement links stay unresolved
    const targetState = target ? 'linked' : links.has(linkKey) || added ? 'separate' : 'unresolved'
    const record = winner.entity.fields['Crystal Edit source record']
    // Unversioned compositions retain their historical target kind so old backups are not reinterpreted
    const kind = composition.version !== undefined ? ['innate', 'passive'].includes(winner.entity.kind) && record?.state === 'known' && jsonRecord(record.value) && typeof record.value.IsInnate === 'boolean' ? record.value.IsInnate ? 'innate' : 'passive' : winner.entity.kind : target ? baseline.entities[target]!.kind : winner.entity.kind
    const entity: CatalogEntity = { ...winner.entity, id: targetEntityId, kind, fields: { ...winner.entity.fields, 'Effective mod layer': { state: 'known', value: winner.sourceTitle, sources: winner.entity.sources } } }
    entities[targetEntityId] = entity
    identities[modelKey] = targetEntityId
    ;(sourceIdentities[winner.identityProjectId ?? winner.source.catalogId] ??= {})[originalKey] = targetEntityId
    changes.push({ ...winner, entity, targetEntityId, targetState, superseded: target ? [baseline.entities[target]!.name + ' (bundled)', ...winner.superseded] : winner.superseded })
  }
  const nativeReferences = new Map<string, EntityId>(Object.values(baseline.entities).flatMap(entity => {
    const identity = nativeIdentity(entity)
    const family = identity && identity.mode === 'base' ? NATIVE_MOD_FAMILIES[identity.database] : undefined
    return family ? [[`crystal-edit:${family}:${identity!.databaseId}`, entity.id] as const] : []
  }))
  for (const [index, change] of changes.entries()) {
    const field = change.entity.fields['Crystal Edit source record']
    if (change.entity.kind !== 'class' || field?.state !== 'known' || !jsonRecord(field.value) || !Array.isArray(field.value.PassiveIDs)) continue
    const passives = Object.fromEntries(field.value.PassiveIDs.flatMap(id => {
      const target = identities[`crystal-edit:Passives:${id}`] ?? (composition.version !== undefined && typeof id === 'number' ? nativeReferences.get(`crystal-edit:Passives:${id}`) : undefined)
      return target ? [[String(id), target]] : []
    }))
    const entity = { ...change.entity, legacy: { ...(jsonRecord(change.entity.legacy) ? change.entity.legacy : {}), passiveEntityIds: passives } }
    entities[entity.id] = entity
    changes[index] = { ...change, entity }
  }
  const missing = new Set<string>()
  const available = (family: string, id: unknown) => Boolean(identities[`crystal-edit:${family}:${id}`]) || composition.version !== undefined && nativeReferences.has(`crystal-edit:${family}:${id}`)
  for (const change of changes) {
    const field = change.entity.fields['Crystal Edit source record']
    const record = field?.state === 'known' && jsonRecord(field.value) ? field.value : undefined
    if (!record) continue
    for (const [key, family] of [['AbilityIDs', 'Abilities'], ['PassiveIDs', 'Passives']] as const) {
      if (Array.isArray(record[key])) for (const id of record[key]) if (!available(family, id)) missing.add(`${family} #${id}`)
    }
    if (Array.isArray(record.LearnTree)) for (const column of record.LearnTree) if (Array.isArray(column)) for (const node of column) {
      if (!jsonRecord(node)) continue
      const family = node.NodeType === LEARN_NODE_TYPES.ability ? 'Abilities' : node.NodeType === LEARN_NODE_TYPES.passive ? 'Passives' : undefined
      if (family && !available(family, node.DataID)) missing.add(`${family} #${node.DataID}`)
    }
  }
  return { entities, identities, sourceIdentities, changes, unresolvedReferences: [...missing] }
}

export function composeModCatalog(gameSetup: GameSetupRevision, catalogs: readonly CatalogSnapshot[]): CatalogSnapshot | undefined {
  if (!gameSetup.modComposition) return undefined
  const baseline = modCatalogForPin(catalogs, gameSetup.modComposition.baseline)!
  const result = composeModLayers(gameSetup.modComposition, catalogs)
  const metadata = jsonRecord(baseline.legacy) ? baseline.legacy : {}
  const preserved = Object.fromEntries(BASELINE_METADATA_KEYS.flatMap(key => metadata[key] === undefined ? [] : [[key, metadata[key]]]))
  return { ...baseline, revisionId: modCatalogRevision(gameSetup.id), schemaVersion: MOD_CATALOG_SCHEMA, checksum: `composition:${gameSetup.id}`, importedAt: gameSetup.createdAt, entities: Object.fromEntries(result.changes.map(change => [change.targetEntityId, change.entity])), claims: [], applicability: { state: 'unknown', reason: 'User-selected mod priority and bundled links; game load order and platform parity are unverified' }, rights: { state: 'unknown', reason: 'Source catalogs retain their individual rights' }, legacy: { ...preserved, ...(gameSetup.modComposition.version ? { modCompositionVersion: gameSetup.modComposition.version } : {}), modGameSetupRevisionId: gameSetup.id, modBaseline: { ...gameSetup.modComposition.baseline }, crystalEditIdentities: result.identities, ...(gameSetup.modComposition.version === 3 ? { modSourceIdentities: result.sourceIdentities } : {}), unresolvedReferences: result.unresolvedReferences } }
}

export function expandModCatalogs(catalogs: readonly CatalogSnapshot[]): readonly CatalogSnapshot[] {
  if (!catalogs.some(catalog => catalog.schemaVersion === MOD_CATALOG_SCHEMA)) return catalogs
  return catalogs.map(catalog => {
    if (catalog.schemaVersion !== MOD_CATALOG_SCHEMA) return catalog
    const metadata = jsonRecord(catalog.legacy) ? catalog.legacy : undefined
    const pin = metadata?.modBaseline
    if (!jsonRecord(pin) || typeof pin.catalogId !== 'string' || typeof pin.catalogRevisionId !== 'string') throw new DomainError('INVALID_INPUT', 'An effective mod catalog requires an exact baseline pin')
    const baseline = modCatalogForPin(catalogs, pin as unknown as ModCatalogPin)
    // Keep private imported changes available when the exact withdrawn baseline cannot be supplied
    if (!baseline && withdrawnCatalog(pin as unknown as ModCatalogPin)) return compactModCatalog(catalog)
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

export function modModelEntity(catalog: CatalogSnapshot, modelKey: string): CatalogEntity | undefined {
  if (!MODEL_KEY.test(modelKey)) return undefined
  const identities = jsonRecord(catalog.legacy) && jsonRecord(catalog.legacy.crystalEditIdentities) ? catalog.legacy.crystalEditIdentities : undefined
  const target = identities?.[modelKey]
  return typeof target === 'string' ? catalogEntity(catalog, target) : undefined
}

export function modLinkKey(link: Pick<ModDefinitionLink, 'projectId' | 'modelKey'>): string {
  return JSON.stringify([link.projectId ?? null, link.modelKey])
}

export function prepareModComposition(composition: ModComposition, catalogs: readonly CatalogSnapshot[]): ModComposition {
  const upgrading = composition.version !== MOD_COMPOSITION_VERSION
  const links = composition.links.map(link => {
    const [, family, id] = link.modelKey.split(':')
    if (link.projectId || originalModIdentity(family!, Number(id))) return link
    const owner = [...composition.layers.filter(layer => layer.enabled).reverse(), ...composition.layers.filter(layer => !layer.enabled).reverse()].find(layer => {
      const catalog = modCatalogForPin(catalogs, layer)
      return catalog && modModelRecords(catalog).has(link.modelKey)
    })
    return owner ? { ...link, projectId: owner.catalogId } : link
  })
  const next: ModComposition = { ...composition, version: MOD_COMPOSITION_VERSION, identityMappings: composition.identityMappings ?? [], links }
  const allocation = upgrading ? { ...next, layers: [...next.layers.filter(layer => layer.enabled).reverse(), ...next.layers.filter(layer => !layer.enabled).reverse()] } : next
  return { ...next, identityMappings: modIdentityMappings(allocation, catalogs) }
}

function remappedModEntity(entity: CatalogEntity, family: string, projectId: ModCatalogPin['catalogId'], mappings: ReturnType<typeof modIdentityMappings>): CatalogEntity {
  const field = entity.fields['Crystal Edit source record']
  if (field?.state !== 'known' || !jsonRecord(field.value)) return entity
  const version = entity.fields[CRYSTAL_EDIT_VERSION_FIELD]
  const localization = entity.fields[CRYSTAL_EDIT_LOCALIZATION_FIELD]
  if (localization?.state === 'known' && localization.value === true) return entity
  const converted = version?.state === 'known' && supportsCrystalEditVersion(version.value) ? interpretCrystalEditRecord(field.value, family, version.value) : field.value
  const record = remapModRecord(converted, family, projectId, mappings)
  const source = entity.sources[0]
  return { ...entity, legacy: { ...(jsonRecord(entity.legacy) ? entity.legacy : {}), modRecordVersion: 3 }, fields: { ...entity.fields, ...(source ? gameRecordFacts(record, entity.kind, source, NATIVE_GAME_DATA.enums) : {}), ...(family === 'Jobs' && source ? classFields(record, source) : {}), 'Crystal Edit original source record': field, 'Crystal Edit source record': { ...field, value: record } } }
}
