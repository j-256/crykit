import type { CatalogEntityKind } from './types'

const ARTWORK_KINDS: Readonly<Record<string, CatalogEntityKind>> = Object.freeze({ Jobs: 'class', Equipment: 'item', Items: 'item', Abilities: 'ability', Statuses: 'status', Monsters: 'monster' })
export const MOD_ARTWORK_FAMILIES = Object.keys(ARTWORK_KINDS)

export function modArtworkKind(family: string): CatalogEntityKind | undefined {
  return ARTWORK_KINDS[family]
}

export function modArtworkReference(family: string, record: Readonly<Record<string, unknown>>): readonly (string | number | null)[] | undefined {
  if (!modArtworkKind(family)) return undefined
  if (family === 'Jobs') return [typeof record.ActorTexturePathM === 'string' ? record.ActorTexturePathM : null, typeof record.ActorTexturePathF === 'string' ? record.ActorTexturePathF : null]
  if (typeof record.TexturePath !== 'string' || !record.TexturePath) return undefined
  return family === 'Monsters' ? [record.TexturePath] : [record.TexturePath, typeof record.TextureIndex === 'number' ? record.TextureIndex : null]
}
