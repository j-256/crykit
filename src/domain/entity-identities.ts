import type { CatalogEntity, CatalogSnapshot, EntityId } from './types'

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function catalogEntity(catalog: CatalogSnapshot, id: string): CatalogEntity | undefined {
  if (Object.hasOwn(catalog.entities, id)) return catalog.entities[id]
  const metadata = catalog.legacy
  if (!objectRecord(metadata) || metadata.modCompositionVersion !== 3) return undefined
  const identities = metadata.crystalEditIdentities
  const target = objectRecord(identities) ? identities[id] : undefined
  return typeof target === 'string' && Object.hasOwn(catalog.entities, target) ? catalog.entities[target] : undefined
}

export function baseGameEntityId(database: string, id: number, mode = 'base'): EntityId {
  return `base:${database}:${id}${mode === 'base' ? '' : `:mode:${encodeURIComponent(mode)}`}` as EntityId
}
