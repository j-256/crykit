import { skillAcceptsWeapon, skillWeaponRule, type SkillWeaponRule, type WeaponType } from '../domain/skill-weapons'
import type { ModState } from '../domain/mods'
import { nativeIdentity, nativeRecord } from '../domain/native-game'
import { partitionQuery } from '../domain/query'
import { normalizeImportedFieldName } from '../interchange/field-names'
import { projectSourceSemantics } from '../catalog/source-semantics'
import { combineFacetKnowledge, facetStringValues, isReferenceArtifact, referenceAudience, referenceCategoryKnowledge, referenceFieldFacets, REFERENCE_FACETS, type FacetRecord, type ReferenceAudience, type ReferenceFacetFilters, type ReferenceFacetKey } from './reference-facets'
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
  readonly weaponRule: Knowledge<SkillWeaponRule>
  readonly knowledgeCounts: KnowledgeCounts
  readonly audience: ReferenceAudience
}

export interface NumericBound {
  readonly min?: number
  readonly max?: number
  readonly unit: string
}

export interface ReferenceFilters extends ReferenceFacetFilters {
  readonly query: string
  readonly kinds: readonly CatalogEntityKind[]
  readonly categories: readonly string[]
  readonly sources: readonly string[]
  readonly pp?: NumericBound
  readonly weapon?: WeaponType
  readonly unrestrictedWeaponSkills?: ModState
}

export interface PersonalDefinitionSearchOption {
  readonly record?: FacetRecord
  readonly modAvailability?: { readonly requiredMod?: string }
  readonly kind: CatalogEntityKind
  readonly name: string
  readonly aliases: readonly string[]
  readonly description?: string
  readonly category?: Knowledge<JsonValue>
  readonly ppCost?: Knowledge<number>
  readonly sourceLabel: string
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

const PP_FIELDS = new Set(['pp', 'pp cost'])

function compareText(left: string, right: string): number {
  const normalizedLeft = left.normalize('NFKC').toLocaleLowerCase()
  const normalizedRight = right.normalize('NFKC').toLocaleLowerCase()
  if (normalizedLeft < normalizedRight) return -1
  if (normalizedLeft > normalizedRight) return 1
  return left < right ? -1 : left > right ? 1 : 0
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

function personalPpCost(option: PersonalDefinitionSearchOption): Knowledge<number> {
  return option.ppCost ?? (
    option.kind === 'passive' || option.kind === 'innate'
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
  const projectedEntity = projectSourceSemantics(entity)
  const categoryKnowledge = referenceCategoryKnowledge(projectedEntity, claims)
  const categories = Array.from(new Set(categoryKnowledge.flatMap(facetStringValues))).sort(compareText)
  const sources = Array.from(new Set([
    catalog.id,
    ...projectedEntity.sources.map((source) => source.sourceId),
    ...claims.flatMap((claim) => claim.sources.map((source) => source.sourceId)),
  ].filter(Boolean))).sort(compareText)
  const ppCost = ppCostKnowledge(projectedEntity)
  const keyParts = { catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: projectedEntity.id }
  return {
    key: encodeReferenceEntityKey(keyParts),
    keyParts,
    entity: projectedEntity,
    catalog,
    claims,
    categories,
    sources,
    ppCost,
    weaponRule: skillWeaponRule(projectedEntity),
    knowledgeCounts: countKnowledge(entityKnowledge(projectedEntity, claims)),
    audience: referenceAudience(projectedEntity),
    projection: {
      text: { state: 'known', value: [projectedEntity.name, ...projectedEntity.aliases, projectedEntity.rawDescription ?? ''].join('\n').normalize('NFKC') },
      kind: { state: 'known', value: projectedEntity.kind },
      category: combineFacetKnowledge(categoryKnowledge),
      ...referenceFieldFacets(projectedEntity, claims),
      source: { state: 'known', value: sources },
      ppCost,
      ppCostUnit: ppUnitKnowledge(ppCost),
    },
  }
}

export function buildReferenceSearchItems(catalogs: readonly CatalogSnapshot[]): readonly ReferenceSearchItem[] {
  return catalogs
    .flatMap((catalog) => {
      const nativeNames = new Set(Object.values(catalog.entities).filter(entity => nativeIdentity(entity)?.mode === 'base').map(entity => `${entity.kind}:${entity.name.toLocaleLowerCase()}`))
      const claimsByEntity = new Map<string, CatalogClaim[]>()
      for (const claim of catalog.claims) {
        const claims = claimsByEntity.get(claim.entityId) ?? []
        claims.push(claim)
        claimsByEntity.set(claim.entityId, claims)
      }
      return Object.values(catalog.entities).filter((entity) => !isReferenceArtifact(entity)).map((entity) => {
        const item = projectReferenceEntity(catalog, entity, claimsByEntity.get(entity.id) ?? [])
        const native = nativeIdentity(entity)
        const alternative = native ? native.mode !== 'base' : nativeRecord(entity.legacy) && entity.legacy.supplemental === true && nativeNames.has(`${entity.kind}:${entity.name.toLocaleLowerCase()}`)
        return alternative && item.audience === 'default' ? { ...item, audience: 'alternatives' as const } : item
      })
    })
    .sort((left, right) => (
      compareText(left.entity.name, right.entity.name) ||
      compareText(left.entity.kind, right.entity.kind) ||
      Number(nativeIdentity(right.entity)?.mode === 'base') - Number(nativeIdentity(left.entity)?.mode === 'base') ||
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
    ...REFERENCE_FACETS.map(facet => facetNode(facet.key, filters[facet.key] ?? [])),
  ]) {
    if (node) children.push(node)
  }
  if (filters.pp && (filters.pp.min !== undefined || filters.pp.max !== undefined)) {
    children.push(...buildNumericBoundNodes('ppCost', filters.pp, 'PP'))
  }
  if (filters.weapon) children.push({ kind: 'predicate', field: 'weaponCompatible', operator: 'eq', value: true })
  return { kind: 'and', children }
}

export function partitionReferenceItems(
  items: readonly ReferenceSearchItem[],
  filters: ReferenceFilters,
): ReferenceSearchPartition {
  const query = buildReferenceQuery(filters)
  return { ...partitionQuery(items, query, (item) => filters.weapon ? { ...item.projection, weaponCompatible: skillAcceptsWeapon(item.weaponRule, filters.weapon, filters.unrestrictedWeaponSkills) } : item.projection), query }
}

export function personalDefinitionCategoryValues(option: PersonalDefinitionSearchOption): readonly string[] {
  return Array.from(new Set(personalCategoryKnowledge(option).flatMap(facetStringValues))).sort(compareText)
}

function personalCategoryKnowledge(option: PersonalDefinitionSearchOption): readonly Knowledge<JsonValue>[] {
  return [...(option.record ? referenceCategoryKnowledge(option.record) : []), ...(option.category ? [option.category] : [])]
}

export function personalDefinitionFacetValues(option: PersonalDefinitionSearchOption, field: ReferenceFacetKey): readonly string[] {
  return [...new Set(facetStringValues(referenceFieldFacets(option.record ?? { kind: option.kind, name: option.name, fields: {} }, [], option.modAvailability?.requiredMod)[field]))]
}

export function partitionPersonalDefinitionOptions<Option extends PersonalDefinitionSearchOption>(
  options: readonly Option[],
  filters: ReferenceFilters,
) {
  const query = buildReferenceQuery(filters)
  return {
    ...partitionQuery(options, query, (option): QueryRecord => {
      const ppCost = personalPpCost(option)
      return {
        text: { state: 'known', value: [option.name, ...option.aliases, option.description ?? '', option.kind, option.sourceLabel].join('\n').normalize('NFKC') },
        kind: { state: 'known', value: option.kind },
        category: combineFacetKnowledge(personalCategoryKnowledge(option)),
        ...referenceFieldFacets(option.record ?? { kind: option.kind, name: option.name, fields: {} }, [], option.modAvailability?.requiredMod),
        source: { state: 'known', value: ['Personal definitions'] },
        ppCost,
        ppCostUnit: ppUnitKnowledge(ppCost),
        ...(filters.weapon ? { weaponCompatible: skillAcceptsWeapon(skillWeaponRule(option.record ?? { kind: option.kind, fields: {} }), filters.weapon, filters.unrestrictedWeaponSkills) } : {}),
      }
    }),
    query,
  }
}

export function buildFacetOptions(items: readonly ReferenceSearchItem[], field: 'kind' | 'category' | 'source' | ReferenceFacetKey): readonly FacetOption[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    const values = field === 'kind' ? [item.entity.kind] : field === 'category' ? item.categories : field === 'source' ? item.sources : facetStringValues(item.projection[field] ?? { state: 'unknown' })
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
