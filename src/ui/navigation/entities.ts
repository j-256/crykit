import { type EntityRef, type PersonalDefinitionId, type CatalogId, type CatalogRevisionId, type EntityId } from '../../domain/types'
import { type EntityRouteNameResolver, bundledEntityRouteName, entityRouteSlug, isEntityRouteSlug } from '../entity-route-names'
import { STARTER_CATALOG_ID, STARTER_CATALOG_REVISION_ID } from '../../catalog/catalog-ids'
import { boundedOpaque, encodeSegment, encodeIdentitySegment, decodeSegment, ENTITY_ID_RESERVED_SEGMENTS } from './segments.ts'

const ENTITY_ID_MIN_SEGMENTS: ReadonlyMap<string, number> = new Map([['base', 3], ['mod', 4]])

const BUNDLED_CATALOG_ROUTE_ALIAS = 'v1'

const CATALOG_ROUTE_ALIAS_PATTERN = /^v[0-9]+$/

const OPAQUE_ENTITY_ID_SEGMENT = 'id'

function entityIdentitySegments(entityId: string): readonly string[] | undefined {
  const parts = entityId.split(':')
  const minimum = ENTITY_ID_MIN_SEGMENTS.get(parts[0]!)
  return minimum && parts.length >= minimum && parts.every(part => boundedOpaque(part)) ? parts : undefined
}

export function formatEntityRefPath(ref: EntityRef, resolveName: EntityRouteNameResolver = bundledEntityRouteName): string {
  // Exact IDs and catalog pins resolve records; the trailing slug is descriptive and replaceable
  if (ref.kind === 'personal') return `personal/${encodeSegment(ref.definitionId)}`
  if (!boundedOpaque(ref.entityId)) throw new Error('Route identifier is invalid')
  const parts = entityIdentitySegments(ref.entityId)
  const entityPath = parts ? parts.map(part => encodeIdentitySegment(part, ENTITY_ID_RESERVED_SEGMENTS)).join('/') : `${OPAQUE_ENTITY_ID_SEGMENT}/${encodeSegment(ref.entityId)}`
  const slug = encodeIdentitySegment(entityRouteSlug(resolveName(ref)), ENTITY_ID_RESERVED_SEGMENTS)
  const bundled = ref.catalogId === STARTER_CATALOG_ID && ref.catalogRevisionId === STARTER_CATALOG_REVISION_ID
  // Escape alias-shaped literal IDs before parsing so an imported v1 catalog stays distinct from the bundled alias
  const catalogId = encodeIdentitySegment(ref.catalogId, CATALOG_ROUTE_ALIAS_PATTERN.test(ref.catalogId) ? new Set([ref.catalogId]) : new Set())
  const catalogPath = bundled ? BUNDLED_CATALOG_ROUTE_ALIAS : `${catalogId}/${encodeSegment(ref.catalogRevisionId)}`
  return `catalog/${catalogPath}/${entityPath}/${slug}`
}

export function parseEntityRefPath(segments: readonly string[], offset = 0): { readonly ref: EntityRef; readonly consumed: number } | undefined {
  if (segments[offset] === 'personal') {
    const definitionId = decodeSegment(segments[offset + 1] ?? '')
    return definitionId ? { ref: { kind: 'personal', definitionId: definitionId as PersonalDefinitionId }, consumed: 2 } : undefined
  }
  if (segments[offset] !== 'catalog') return undefined
  const alias = segments[offset + 1] ?? ''
  const bundled = alias === BUNDLED_CATALOG_ROUTE_ALIAS
  if (!bundled && CATALOG_ROUTE_ALIAS_PATTERN.test(alias)) return undefined
  const catalogId = bundled ? STARTER_CATALOG_ID : decodeSegment(alias)
  const catalogRevisionId = bundled ? STARTER_CATALOG_REVISION_ID : decodeSegment(segments[offset + 2] ?? '')
  const identityOffset = offset + (bundled ? 2 : 3)
  let consumed = bundled ? 2 : 3
  let entityId: string | undefined
  if (segments[identityOffset] === OPAQUE_ENTITY_ID_SEGMENT) {
    const opaque = decodeSegment(segments[identityOffset + 1] ?? '')
    if (opaque && !entityIdentitySegments(opaque)) entityId = opaque
    const slug = decodeSegment(segments[identityOffset + 2] ?? '')
    if (!slug || !isEntityRouteSlug(slug)) return undefined
    consumed += 3
  } else if (ENTITY_ID_MIN_SEGMENTS.has(segments[identityOffset] ?? '')) {
    const parts: string[] = []
    for (let cursor = identityOffset; cursor < segments.length && !ENTITY_ID_RESERVED_SEGMENTS.has(segments[cursor]!); cursor += 1) {
      const part = decodeSegment(segments[cursor]!)
      if (!part || part.includes(':')) return undefined
      parts.push(part)
    }
    const slug = parts.pop()
    if (!slug || !isEntityRouteSlug(slug)) return undefined
    const joined = parts.join(':')
    if (boundedOpaque(joined) && entityIdentitySegments(joined)) entityId = joined
    consumed += parts.length + 1
  }
  return catalogId && catalogRevisionId && entityId
    ? { ref: { kind: 'catalog', catalogId: catalogId as CatalogId, catalogRevisionId: catalogRevisionId as CatalogRevisionId, entityId: entityId as EntityId }, consumed }
    : undefined
}
