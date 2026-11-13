import { SOURCE_REVISION_RECEIPTS } from '../../catalog/source-revisions'
import { type EntityRef, type PersonalDefinitionId, type CatalogId, type CatalogRevisionId, type EntityId } from '../../domain/types'
import { parseCatalogSourceId, parseSourceRevision, type CatalogSourceIdentity } from '../../domain/source-identity'
import { type EntityRouteNameResolver, bundledEntityRouteName, entityRouteSlug, isEntityRouteSlug } from '../entity-route-names'
import { boundedOpaque, encodeSegment, encodeIdentitySegment, decodeSegment, ENTITY_ID_RESERVED_SEGMENTS } from './segments.ts'

const RECORD_FAMILIES = new Set(['job', 'class', 'ability', 'passive', 'innate', 'equipment', 'item', 'monster', 'monster-magic', 'status', 'recipe', 'biome', 'gender', 'spark', 'troop', 'command', 'location', 'other'])
const RECORD_KEY = /^(?:0|[1-9][0-9]*|ref-[1-9][0-9]*)$/
const MAX_NATIVE_ID = 0xffffffff
const segment = (value: string) => encodeIdentitySegment(value, ENTITY_ID_RESERVED_SEGMENTS)
const validRecordKey = (value: string) => RECORD_KEY.test(value) && (value.startsWith('ref-') ? Number.isSafeInteger(Number(value.slice(4))) : Number(value) <= MAX_NATIVE_ID)

function recordSourceKey(source: CatalogSourceIdentity, revisionId: string): string | undefined {
  if (source.origin === 'vanilla') return undefined
  if (source.origin !== 'mod') return source.key
  const receipt = SOURCE_REVISION_RECEIPTS.find(receipt => receipt.id === `crystal-project/mod/${source.key}` && receipt.revisionId === revisionId)
  const payload = receipt?.payloadSource && parseCatalogSourceId(receipt.payloadSource.catalogId)
  return payload?.origin === 'imported' ? payload.key : source.key
}

function sourceRecord(source: CatalogSourceIdentity, entityId: string, revisionId: string): { readonly family: string; readonly key: string; readonly mode?: string } | undefined {
  const parts = entityId.split(':')
  const payloadKey = recordSourceKey(source, revisionId)
  if (source.origin === 'vanilla' && parts[0] === 'base' && (parts.length === 3 || parts.length === 5 && parts[3] === 'mode')) {
    const mode = parts.length === 5 ? decodeSegment(parts[4]!) : undefined
    if (parts.length === 5 && (!mode || mode === 'base')) return undefined
    if (RECORD_FAMILIES.has(parts[1]!) && validRecordKey(parts[2]!)) return { family: parts[1]!, key: parts[2]!, ...(mode ? { mode } : {}) }
  }
  if ((source.origin === 'mod' || source.origin === 'imported') && parts.length === 4 && parts[0] === 'mod' && parts[1] === payloadKey && RECORD_FAMILIES.has(parts[2]!) && validRecordKey(parts[3]!)) return { family: parts[2] === 'class' ? 'job' : parts[2]!, key: parts[3]! }
  return undefined
}

export function formatEntityRefPath(ref: EntityRef, resolveName: EntityRouteNameResolver = bundledEntityRouteName): string {
  if (ref.kind === 'personal') return `personal/${encodeSegment(ref.definitionId)}`
  if (!boundedOpaque(ref.entityId)) throw new Error('Route identifier is invalid')
  const source = parseCatalogSourceId(ref.catalogId)
  const slug = segment(entityRouteSlug(resolveName(ref)))
  // Effective records and synthetic workspace catalogs never borrow a public source route
  if (!source || ref.catalogRevisionId.startsWith('mod-setup:')) return `local/catalog/${encodeSegment(ref.catalogId)}/${encodeSegment(ref.catalogRevisionId)}/entries/${encodeSegment(ref.entityId)}/${slug}`
  if (!parseSourceRevision(source.origin, ref.catalogRevisionId)) throw new Error('Source revision is invalid')
  const record = sourceRecord(source, ref.entityId, ref.catalogRevisionId)
  const identity = record ? `${record.mode ? `mode/${segment(record.mode)}/` : ''}${record.family}/${segment(record.key)}` : `entries/${encodeSegment(ref.entityId)}`
  return `${ref.catalogId}/${ref.catalogRevisionId}/${identity}/${slug}`
}

export function parseEntityRefPath(segments: readonly string[], offset = 0): { readonly ref: EntityRef; readonly consumed: number } | undefined {
  if (segments[offset] === 'personal') {
    const definitionId = decodeSegment(segments[offset + 1] ?? '')
    return definitionId ? { ref: { kind: 'personal', definitionId: definitionId as PersonalDefinitionId }, consumed: 2 } : undefined
  }
  let cursor = offset
  let catalogId: string | undefined
  let catalogRevisionId: string | undefined
  let source: CatalogSourceIdentity | undefined
  const local = segments[cursor] === 'local' && segments[cursor + 1] === 'catalog'
  if (local) {
    catalogId = decodeSegment(segments[cursor + 2] ?? '')
    catalogRevisionId = decodeSegment(segments[cursor + 3] ?? '')
    if (!catalogId || !catalogRevisionId || parseCatalogSourceId(catalogId) && !catalogRevisionId.startsWith('mod-setup:')) return undefined
    cursor += 4
  } else {
    if (segments[cursor] !== 'crystal-project') return undefined
    const length = segments[cursor + 1] === 'vanilla' ? 2 : 3
    catalogId = segments.slice(cursor, cursor + length).join('/')
    source = parseCatalogSourceId(catalogId)
    catalogRevisionId = segments[cursor + length]
    if (!source || !catalogRevisionId || !parseSourceRevision(source.origin, catalogRevisionId)) return undefined
    cursor += length + 1
  }
  let mode: string | undefined
  if (segments[cursor] === 'mode') {
    mode = decodeSegment(segments[cursor + 1] ?? '')
    if (source?.origin !== 'vanilla' || !mode || mode === 'base') return undefined
    cursor += 2
  }
  const family = segments[cursor]
  const key = decodeSegment(segments[cursor + 1] ?? '')
  const slug = decodeSegment(segments[cursor + 2] ?? '')
  if (!key || !slug || !isEntityRouteSlug(slug)) return undefined
  let entityId: string
  if (family === 'entries' && !mode) {
    entityId = key
    // Structured records have exactly one encoding, so opaque keys cannot alias them
    if (source && sourceRecord(source, entityId, catalogRevisionId)) return undefined
  } else {
    if (local || !source || source.origin === 'guide' || !family || !RECORD_FAMILIES.has(family) || !validRecordKey(key)) return undefined
    entityId = source.origin === 'vanilla' ? `base:${family}:${key}${mode ? `:mode:${encodeURIComponent(mode)}` : ''}` : `mod:${recordSourceKey(source, catalogRevisionId)}:${family === 'job' ? 'class' : family}:${key}`
    if (source.origin !== 'vanilla' && family === 'class') return undefined
  }
  if (!boundedOpaque(entityId)) return undefined
  return { ref: { kind: 'catalog', catalogId: catalogId as CatalogId, catalogRevisionId: catalogRevisionId as CatalogRevisionId, entityId: entityId as EntityId }, consumed: cursor + 3 - offset }
}
