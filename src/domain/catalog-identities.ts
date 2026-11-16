import { bundledModEntityId, bundledModIdentity } from './bundled-mods'
import { nativeEntityId, nativeIdentity, nativeRecord } from './native-game'
import type { CatalogEntity, CatalogRef, CatalogSnapshot, EntityId, EntityRef, JsonValue } from './types'

export function compiledEntityId(entity: CatalogEntity): EntityId {
  const native = nativeIdentity(entity)
  if (native) return nativeEntityId(native.database, native.databaseId, native.mode)
  // System configuration uses native projection IDs and has no supplemental source identity
  if (/^base:system:[0-9]+$/.test(entity.id) && entity.sources.every(source => source.sourceId.startsWith('native-game:'))) return entity.id
  const mod = bundledModIdentity(entity)
  if (mod) return bundledModEntityId(mod.key, mod.family, mod.modelId)
  throw new Error(`Catalog definition has no native or mod identity: ${entity.id}`)
}

export function compileCatalogIdentities(source: CatalogSnapshot): CatalogSnapshot {
  const ids = new Map(Object.values(source.entities).map(entity => [entity.id as string, compiledEntityId(entity)]))
  if (new Set(ids.values()).size !== ids.size) throw new Error('Source definitions compile to conflicting catalog identities')
  const targetId = (id: string): EntityId => {
    const target = ids.get(id)
    if (!target) throw new Error(`Catalog identity target is missing: ${id}`)
    return target
  }
  const ref = (value: EntityRef): EntityRef => value.kind === 'catalog' && value.catalogId === source.id && value.catalogRevisionId === source.revisionId ? { ...value, entityId: targetId(value.entityId) } as CatalogRef : value
  const bindings = (value: JsonValue | undefined): JsonValue | undefined => nativeRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, id]) => [key, typeof id === 'string' ? targetId(id) : id])) : value
  const entities = Object.fromEntries(Object.values(source.entities).map(entity => {
    const id = targetId(entity.id)
    const requirements = entity.requirements?.state === 'known' ? { ...entity.requirements, value: entity.requirements.value.map(requirement => requirement.kind === 'selected' ? { ...requirement, ref: ref(requirement.ref) } : requirement) } : entity.requirements
    const legacy = nativeRecord(entity.legacy) && entity.legacy.passiveEntityIds ? { ...entity.legacy, passiveEntityIds: bindings(entity.legacy.passiveEntityIds)! } : entity.legacy
    return [id, { ...entity, id, ...(requirements ? { requirements } : {}), ...(legacy ? { legacy } : {}) }]
  }))
  const legacy = nativeRecord(source.legacy) ? { ...source.legacy } : undefined
  if (legacy) for (const key of ['nativeIdentityBindings', 'nativeModeIdentityBindings', 'crystalEditIdentities']) if (legacy[key]) legacy[key] = bindings(legacy[key])!
  return { ...source, entities, claims: source.claims.map(claim => ({ ...claim, entityId: targetId(claim.entityId) })), ...(legacy ? { legacy } : {}) }
}
