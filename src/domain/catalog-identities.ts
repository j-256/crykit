import { bundledModEntityId, bundledModIdentity } from './bundled-mods'
import { nativeEntityId, nativeIdentity, nativeRecord } from './native-game'
import type { CatalogEntity, CatalogRef, CatalogSnapshot, EntityId, EntityRef, JsonValue } from './types'

export type SupplementalEntityIds = Readonly<Record<string, number>>

export function compiledEntityId(entity: CatalogEntity, supplementalIds: SupplementalEntityIds): EntityId {
  const native = nativeIdentity(entity)
  if (native) return nativeEntityId(native.database, native.databaseId, native.mode)
  const mod = bundledModIdentity(entity)
  if (mod) return bundledModEntityId(mod.key, mod.family, mod.modelId)
  const id = supplementalIds[entity.id]
  const parts = entity.id.split(':')
  if (!Number.isSafeInteger(id) || id! <= 0 || !['base', 'mod'].includes(parts[0]!) || parts.length < 3) throw new Error(`Missing supplemental identity allocation: ${entity.id}`)
  const family = entity.kind === 'monsterMagic' ? 'monster-magic' : entity.kind
  const scope = parts[0] === 'mod' ? `mod:${parts[1]}:${family}` : parts[1] === 'mechanic' ? parts.slice(0, -1).join(':') : `base:${family}`
  return `${scope}:ref-${id}` as EntityId
}

export function compileCatalogIdentities(source: CatalogSnapshot, supplementalIds: SupplementalEntityIds): CatalogSnapshot {
  const allocations = Object.values(supplementalIds)
  if (allocations.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(allocations).size !== allocations.length) throw new Error('Supplemental identity allocations must be unique positive integers')
  const ids = new Map(Object.values(source.entities).map(entity => [entity.id as string, compiledEntityId(entity, supplementalIds)]))
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
