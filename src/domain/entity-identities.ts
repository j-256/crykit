import type { CatalogEntity, CatalogSnapshot, EntityId } from './types'

export function catalogEntity(catalog: CatalogSnapshot, id: string): CatalogEntity | undefined {
  return Object.hasOwn(catalog.entities, id) ? catalog.entities[id] : undefined
}

export function baseGameEntityId(database: string, id: number, mode = 'base'): EntityId {
  return `base:${database}:${id}${mode === 'base' ? '' : `:mode:${encodeURIComponent(mode)}`}` as EntityId
}
