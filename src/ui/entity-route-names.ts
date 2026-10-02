import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { nativeDisplayName, nativeIdentity, nativeSourceRecord } from '../domain/native-game'
import type { CatalogRef, CatalogSnapshot } from '../domain/types'

export type EntityRouteNameResolver = (ref: CatalogRef) => string | undefined

export const MAX_ENTITY_SLUG_LENGTH = 160
const UNNAMED_ENTITY_SLUG = 'definition'
const ENTITY_SLUG_PATTERN = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u

// Reviewed Windows 1.6.9 variants agree with the pinned wiki levels and artwork
const REVIEWED_MONSTER_NAMES = new Map([
  [57, { name: 'Brutish Quintar (Red)', level: 22, texture: 'Monster/Z18_QuintarBrutishRed' }],
  [316, { name: 'Brutish Quintar (Desert)', level: 52, texture: 'Monster/Z18_QuintarBrutishYellow' }],
])

export function entityRouteSlug(name: string | undefined): string {
  const slug = name?.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, MAX_ENTITY_SLUG_LENGTH).replace(/[\uD800-\uDBFF]$|-$/u, '')
  return slug || UNNAMED_ENTITY_SLUG
}

export function isEntityRouteSlug(value: string): boolean {
  return value.length <= MAX_ENTITY_SLUG_LENGTH && ENTITY_SLUG_PATTERN.test(value)
}

export function createEntityRouteNameResolver(catalogs: readonly CatalogSnapshot[]): EntityRouteNameResolver {
  const snapshots = new Map(catalogs.map(catalog => [JSON.stringify([catalog.id, catalog.revisionId]), catalog]))
  return ref => {
    const catalog = snapshots.get(JSON.stringify([ref.catalogId, ref.catalogRevisionId]))
    const entity = catalog && Object.hasOwn(catalog.entities, ref.entityId) ? catalog.entities[ref.entityId] : undefined
    if (!entity) return undefined
    const identity = nativeIdentity(entity)
    const reviewed = identity?.database === 'monster' && identity.mode === 'base' ? REVIEWED_MONSTER_NAMES.get(identity.databaseId) : undefined
    const record = reviewed && nativeSourceRecord(entity)
    const bundled = BUNDLED_CATALOGS.some(snapshot => snapshot.id === ref.catalogId && snapshot.revisionId === ref.catalogRevisionId)
    if (bundled && reviewed && entity.name === 'Brutish Quintar' && record?.Level === reviewed.level && record.TexturePath === reviewed.texture) return reviewed.name
    return nativeDisplayName(entity)
  }
}

export const bundledEntityRouteName = createEntityRouteNameResolver(BUNDLED_CATALOGS)
