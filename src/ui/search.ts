import { partitionQuery } from '../domain/query'
import { normalizeImportedFieldName } from '../interchange/field-names'
import type {
  CatalogClaim,
  CatalogEntity,
  CatalogEntityKind,
  CatalogSnapshot,
  JsonValue,
  Knowledge,
  QueryNode,
  QueryRecord,
  QueryValue,
} from '../domain/types'

export interface ReferenceEntityKey {
  readonly catalogId: string
  readonly catalogRevisionId: string
  readonly entityId: string
}

export interface KnowledgeCounts {
  readonly known: number
  readonly unknown: number
  readonly conflicting: number
  readonly notApplicable: number
}

export interface ReferenceSearchItem {
  readonly key: string
  readonly keyParts: ReferenceEntityKey
  readonly entity: CatalogEntity
  readonly catalog: CatalogSnapshot
  readonly claims: readonly CatalogClaim[]
  readonly projection: QueryRecord
  readonly categories: readonly string[]
  readonly sources: readonly string[]
  readonly ppCost: Knowledge<number>
  readonly knowledgeCounts: KnowledgeCounts
}

export interface NumericBound {
  readonly min?: number
  readonly max?: number
  readonly unit: string
}

export interface ReferenceFilters {
  readonly query: string
  readonly kinds: readonly CatalogEntityKind[]
  readonly categories: readonly string[]
  readonly sources: readonly string[]
  readonly pp?: NumericBound
}

export interface ReferenceSearchPartition {
  readonly confirmed: readonly ReferenceSearchItem[]
  readonly possible: readonly ReferenceSearchItem[]
  readonly excluded: readonly ReferenceSearchItem[]
  readonly query: QueryNode
}

export interface FacetOption {
  readonly value: string
  readonly count: number
}

const CATEGORY_FIELDS = new Set(['category', 'class category', 'equipment type', 'item type', 'type'])
const PP_FIELDS = new Set(['pp', 'pp cost'])

function compareText(left: string, right: string): number {
  const normalizedLeft = left.normalize('NFKC').toLocaleLowerCase()
  const normalizedRight = right.normalize('NFKC').toLocaleLowerCase()
  if (normalizedLeft < normalizedRight) return -1
  if (normalizedLeft > normalizedRight) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

function jsonStrings(value: JsonValue): readonly string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.trim())
  return []
}

function knowledgeStringValues(value: Knowledge<JsonValue>): readonly string[] {
  if (value.state === 'known') return jsonStrings(value.value)
  if (value.state === 'conflicting') return value.claims.flatMap((claim) => jsonStrings(claim.value))
  return []
}

function stringKnowledge(values: readonly Knowledge<JsonValue>[]): QueryValue {
  const known = values.flatMap((value) => value.state === 'known' ? jsonStrings(value.value) : [])
  const conflicts = values.filter((value) => value.state === 'conflicting')
  if (conflicts.length > 0) {
    return {
      state: 'conflicting',
      claims: conflicts.flatMap((value) => value.state === 'conflicting'
        ? value.claims.map((claim) => ({ value: jsonStrings(claim.value), sources: claim.sources, ...(claim.note === undefined ? {} : { note: claim.note }) }))
        : []),
    }
  }
  if (known.length > 0) return { state: 'known', value: Array.from(new Set(known)) }
  if (values.length > 0 && values.every((value) => value.state === 'notApplicable')) return { state: 'notApplicable' }
  return { state: 'unknown', reason: 'The source does not establish this facet' }
}

function numberKnowledge(value: Knowledge<JsonValue> | undefined): Knowledge<number> | undefined {
  if (!value) return undefined
  if (value.state === 'known') {
    return typeof value.value === 'number'
      ? { state: 'known', value: value.value, ...(value.sources === undefined ? {} : { sources: value.sources }) }
      : { state: 'unknown', reason: 'The documented PP value is not numeric', ...(value.sources === undefined ? {} : { sources: value.sources }) }
  }
  if (value.state === 'conflicting') {
    const numericClaims = value.claims.filter((claim) => typeof claim.value === 'number')
    return numericClaims.length === value.claims.length
      ? { state: 'conflicting', claims: numericClaims.map((claim) => ({ value: claim.value as number, sources: claim.sources, ...(claim.note === undefined ? {} : { note: claim.note }) })) }
      : { state: 'unknown', reason: 'Conflicting PP claims include nonnumeric values' }
  }
  return value
}

function ppCostKnowledge(entity: CatalogEntity): Knowledge<number> {
  if (entity.ppCost) return entity.ppCost
  const field = Object.entries(entity.fields).find(([name]) => PP_FIELDS.has(normalizeImportedFieldName(name)))?.[1]
  return numberKnowledge(field) ?? (
    entity.kind === 'passive' || entity.kind === 'innate'
      ? { state: 'unknown', reason: 'No numeric PP cost was supplied' }
      : { state: 'notApplicable', reason: 'PP cost does not apply to this definition kind' }
  )
}

function countKnowledge(values: readonly Knowledge<unknown>[]): KnowledgeCounts {
  const counts = { known: 0, unknown: 0, conflicting: 0, notApplicable: 0 }
  for (const value of values) counts[value.state] += 1
  return counts
}

function entityKnowledge(entity: CatalogEntity, claims: readonly CatalogClaim[]): readonly Knowledge<unknown>[] {
  const values: Knowledge<unknown>[] = [...Object.values(entity.fields), ...claims.map((claim) => claim.value)]
  if (entity.slotKinds) values.push(entity.slotKinds)
  if (entity.occupiesSlots) values.push(entity.occupiesSlots)
  if (entity.ppCost) values.push(entity.ppCost)
  if (entity.listedContributions) values.push(...Object.values(entity.listedContributions))
  if (entity.requirements) values.push(entity.requirements)
  if (entity.grants) values.push(entity.grants)
  return values
}

function ppUnitKnowledge(ppCost: Knowledge<number>): QueryValue {
  return ppCost.state === 'notApplicable'
    ? { state: 'notApplicable', reason: ppCost.reason }
    : { state: 'known', value: 'PP' }
}

export function encodeReferenceEntityKey(parts: ReferenceEntityKey): string {
  return JSON.stringify([parts.catalogId, parts.catalogRevisionId, parts.entityId])
}

export function decodeReferenceEntityKey(value: string): ReferenceEntityKey | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed.some((part) => typeof part !== 'string' || part.length === 0)) return undefined
    const [catalogId, catalogRevisionId, entityId] = parsed as [string, string, string]
    return { catalogId, catalogRevisionId, entityId }
  } catch {
    return undefined
  }
}

export function projectReferenceEntity(
  catalog: CatalogSnapshot,
  entity: CatalogEntity,
  suppliedClaims?: readonly CatalogClaim[],
): ReferenceSearchItem {
  const claims = suppliedClaims ?? catalog.claims.filter((claim) => claim.entityId === entity.id)
  const categoryKnowledge = [
    ...Object.entries(entity.fields),
    ...claims.map((claim) => [claim.field, claim.value] as const),
  ].filter(([field]) => CATEGORY_FIELDS.has(normalizeImportedFieldName(field))).map(([, value]) => value)
  const categories = Array.from(new Set(categoryKnowledge.flatMap(knowledgeStringValues))).sort(compareText)
  const sources = Array.from(new Set([
    catalog.id,
    ...entity.sources.map((source) => source.sourceId),
    ...claims.flatMap((claim) => claim.sources.map((source) => source.sourceId)),
  ].filter(Boolean))).sort(compareText)
  const ppCost = ppCostKnowledge(entity)
  const keyParts = { catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entity.id }
  return {
    key: encodeReferenceEntityKey(keyParts),
    keyParts,
    entity,
    catalog,
    claims,
    categories,
    sources,
    ppCost,
    knowledgeCounts: countKnowledge(entityKnowledge(entity, claims)),
    projection: {
      text: { state: 'known', value: [entity.name, ...entity.aliases, entity.rawDescription ?? ''].join('\n').normalize('NFKC') },
      kind: { state: 'known', value: entity.kind },
      category: stringKnowledge(categoryKnowledge),
      source: { state: 'known', value: sources },
      ppCost,
      ppCostUnit: ppUnitKnowledge(ppCost),
    },
  }
}

export function buildReferenceSearchItems(catalogs: readonly CatalogSnapshot[]): readonly ReferenceSearchItem[] {
  return catalogs
    .flatMap((catalog) => {
      const claimsByEntity = new Map<string, CatalogClaim[]>()
      for (const claim of catalog.claims) {
        const claims = claimsByEntity.get(claim.entityId) ?? []
        claims.push(claim)
        claimsByEntity.set(claim.entityId, claims)
      }
      return Object.values(catalog.entities).map((entity) => projectReferenceEntity(catalog, entity, claimsByEntity.get(entity.id) ?? []))
    })
    .sort((left, right) => (
      compareText(left.entity.name, right.entity.name) ||
      compareText(left.entity.kind, right.entity.kind) ||
      compareText(left.catalog.id, right.catalog.id) ||
      compareText(left.catalog.revisionId, right.catalog.revisionId) ||
      compareText(left.entity.id, right.entity.id)
    ))
}

function facetNode(field: string, values: readonly string[]): QueryNode | undefined {
  const unique = Array.from(new Set(values.filter(Boolean)))
  if (unique.length === 0) return undefined
  return { kind: 'or', children: unique.map((value) => ({ kind: 'predicate', field, operator: 'eq', value })) }
}

export function buildNumericBoundNodes(field: string, bound: NumericBound, expectedUnit: string): readonly QueryNode[] {
  const unit = bound.unit || expectedUnit
  const nodes: QueryNode[] = [{ kind: 'predicate', field: `${field}Unit`, operator: 'eq', value: unit }]
  if (Number.isFinite(bound.min)) nodes.push({ kind: 'predicate', field, operator: 'gte', value: bound.min })
  if (Number.isFinite(bound.max)) nodes.push({ kind: 'predicate', field, operator: 'lte', value: bound.max })
  return nodes
}

export function buildReferenceQuery(filters: ReferenceFilters): QueryNode {
  const children: QueryNode[] = []
  for (const token of filters.query.trim().split(/\s+/).filter(Boolean)) {
    children.push({ kind: 'predicate', field: 'text', operator: 'contains', value: token })
  }
  for (const node of [
    facetNode('kind', filters.kinds),
    facetNode('category', filters.categories),
    facetNode('source', filters.sources),
  ]) {
    if (node) children.push(node)
  }
  if (filters.pp && (filters.pp.min !== undefined || filters.pp.max !== undefined)) {
    children.push(...buildNumericBoundNodes('ppCost', filters.pp, 'PP'))
  }
  return { kind: 'and', children }
}

export function partitionReferenceItems(
  items: readonly ReferenceSearchItem[],
  filters: ReferenceFilters,
): ReferenceSearchPartition {
  const query = buildReferenceQuery(filters)
  return { ...partitionQuery(items, query, (item) => item.projection), query }
}

export function buildFacetOptions(items: readonly ReferenceSearchItem[], field: 'kind' | 'category' | 'source'): readonly FacetOption[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    const values = field === 'kind' ? [item.entity.kind] : field === 'category' ? item.categories : item.sources
    for (const value of new Set(values)) counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return Array.from(counts, ([value, count]) => ({ value, count })).sort((left, right) => compareText(left.value, right.value))
}

export function aggregateKnowledgeCounts(items: readonly ReferenceSearchItem[]): KnowledgeCounts {
  return items.reduce<KnowledgeCounts>((total, item) => ({
    known: total.known + item.knowledgeCounts.known,
    unknown: total.unknown + item.knowledgeCounts.unknown,
    conflicting: total.conflicting + item.knowledgeCounts.conflicting,
    notApplicable: total.notApplicable + item.knowledgeCounts.notApplicable,
  }), { known: 0, unknown: 0, conflicting: 0, notApplicable: 0 })
}
