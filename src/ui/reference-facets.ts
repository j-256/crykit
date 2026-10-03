import type { CatalogClaim, CatalogEntity, CatalogEntityKind, JsonValue, Knowledge, QueryValue } from '../domain/types'
import { normalizeImportedFieldName } from '../interchange/field-names'
import { nativeIdentity, nativeSourceRecord } from '../domain/native-game'
import { bundledModRecord } from '../domain/bundled-mods'
import { equipmentCategory, EQUIPMENT_CATEGORY_KEY, referenceCategoryKeys, referenceCategoryLabel, referenceEquipmentCategoryGroup } from './reference-categories'

export const REFERENCE_FACETS = [
  { key: 'classes', label: 'Class', parameter: 'class', fields: ['class', 'associated class'], kinds: ['class', 'command', 'ability', 'passive', 'innate', 'monsterMagic'] },
  { key: 'slots', label: 'Equipment slot', parameter: 'slot', fields: ['slot', 'slot kind', 'slot kinds', 'equipment slot'], kinds: ['item'] },
  { key: 'elements', label: 'Element', parameter: 'element', fields: ['element', 'elements'], kinds: ['item', 'ability', 'monsterMagic', 'monster', 'status'] },
  { key: 'mods', label: 'Source mod', parameter: 'mod', fields: ['source mod', 'required mod', 'mod'], kinds: [] },
] as const

export type ReferenceFacetKey = typeof REFERENCE_FACETS[number]['key']
export type ReferenceFacetFilters = Readonly<Partial<Record<ReferenceFacetKey, readonly string[]>>>
export type FacetRecord = Pick<CatalogEntity, 'kind' | 'fields'> & Partial<Pick<CatalogEntity, 'name' | 'slotKinds' | 'legacy'>>

export const OPTIONAL_REFERENCE_AUDIENCES = [
  { value: 'technical', label: 'Technical mechanics', description: 'Engine modifier identifiers for modding and mechanics research' },
  { value: 'diagnostic', label: 'Catalog diagnostics', description: 'Catalog coverage and extraction diagnostics' },
  { value: 'about', label: 'About & history', description: 'Game, developer, release, and media articles' },
  { value: 'tooling', label: 'Tools & modding', description: 'External tools and modding articles' },
  { value: 'alternatives', label: 'Other sources & mode variants', description: 'Overlapping supplemental definitions and native mode overrides' },
] as const

export type OptionalReferenceAudience = typeof OPTIONAL_REFERENCE_AUDIENCES[number]['value']
export type ReferenceAudience = 'default' | OptionalReferenceAudience

const TECHNICAL_REFERENCE_PREFIXES = ['base:mechanic:stat:', 'base:mechanic:ability:'] as const
const DIAGNOSTIC_REFERENCE_IDS = new Set(['base:other:catalog-coverage-gaps'])
const ABOUT_REFERENCE_IDS = new Set(['andrew-willman', 'crystal-project-demo', 'crystal-project-game', 'patch-notes', 'soundtrack'].map(name => `base:other:${name}`))
const TOOLING_REFERENCE_IDS = new Set(['base:other:cheat-engine'])
const REFERENCE_ARTIFACT_IDS = new Set(['bgtest', 'defender'].map(name => `base:other:${name}`))

export function referenceAudience(entity: Pick<CatalogEntity, 'id'>): ReferenceAudience {
  const id = String(entity.id)
  if (TECHNICAL_REFERENCE_PREFIXES.some(prefix => id.startsWith(prefix))) return 'technical'
  if (DIAGNOSTIC_REFERENCE_IDS.has(id)) return 'diagnostic'
  if (ABOUT_REFERENCE_IDS.has(id)) return 'about'
  if (TOOLING_REFERENCE_IDS.has(id)) return 'tooling'
  return 'default'
}

export function isReferenceArtifact(entity: Pick<CatalogEntity, 'id'>): boolean {
  return REFERENCE_ARTIFACT_IDS.has(String(entity.id))
}

const CATEGORY_FIELDS = new Set(['category', 'categories', 'class category', 'equipment type', 'item type', 'type'])

export function facetStringValues(value: Knowledge<JsonValue>): readonly string[] {
  if (value.state === 'conflicting') return value.claims.flatMap(claim => facetStringValues({ state: 'known', value: claim.value }))
  if (value.state !== 'known') return []
  const values = Array.isArray(value.value) ? value.value : [value.value]
  return values.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map(entry => entry.trim())
}

export function combineFacetKnowledge(values: readonly Knowledge<JsonValue>[]): QueryValue {
  if (values.some(value => value.state === 'conflicting')) return {
    state: 'conflicting',
    claims: values.flatMap(value => value.state === 'conflicting'
      ? value.claims.map(claim => ({ ...claim, value: facetStringValues({ state: 'known', value: claim.value }) }))
      : value.state === 'known' ? [{ value: facetStringValues(value), sources: value.sources ?? [] }] : []),
  }
  const known = values.flatMap(facetStringValues)
  if (known.length) return { state: 'known', value: [...new Set(known)] }
  if (values.length && values.every(value => value.state === 'notApplicable')) return { state: 'notApplicable' }
  return { state: 'unknown', reason: 'The source does not establish this facet' }
}

function fieldEntries(entity: FacetRecord, claims: readonly CatalogClaim[]) {
  return [...Object.entries(entity.fields), ...claims.map(claim => [claim.field, claim.value] as const)]
    .map(([field, value]) => [normalizeImportedFieldName(field), value] as const)
}

export function referenceCategoryKnowledge(entity: FacetRecord, claims: readonly CatalogClaim[] = []): readonly Knowledge<JsonValue>[] {
  const record = nativeSourceRecord(entity) ?? bundledModRecord(entity)
  if (entity.kind === 'item' && record && typeof record.EquipmentType === 'number') {
    const category = equipmentCategory(record.EquipmentType)
    return [{ state: 'known', value: category ? [EQUIPMENT_CATEGORY_KEY, category.key] : [EQUIPMENT_CATEGORY_KEY] }]
  }
  return fieldEntries(entity, claims).filter(([field]) => CATEGORY_FIELDS.has(field)).map(([, value]) => referenceCategoryKeys(value))
}

export function referenceFieldFacets(entity: FacetRecord, claims: readonly CatalogClaim[] = [], requiredMod?: string): Record<ReferenceFacetKey, QueryValue> {
  const entries = fieldEntries(entity, claims)
  return Object.fromEntries(REFERENCE_FACETS.map(facet => {
    const values = entries.filter(([field]) => (facet.fields as readonly string[]).includes(field)).map(([, value]) => value)
    if (facet.key === 'classes' && entity.kind === 'class' && entity.name) values.push({ state: 'known', value: entity.name })
    if (facet.key === 'slots' && entity.kind === 'item' && entity.slotKinds) values.push(entity.slotKinds)
    if (facet.key === 'mods' && requiredMod) values.push({ state: 'known', value: requiredMod })
    else if (facet.key === 'mods' && !values.length && nativeIdentity(entity)) values.push({ state: 'known', value: 'Base game' })
    const applicable = !facet.kinds.length || (facet.kinds as readonly CatalogEntityKind[]).includes(entity.kind)
    return [facet.key, values.length || applicable ? combineFacetKnowledge(values) : { state: 'notApplicable' }]
  })) as Record<ReferenceFacetKey, QueryValue>
}

export const DEFINITION_KIND_GROUPS: readonly { readonly label: string; readonly kinds: readonly CatalogEntityKind[] }[] = [
  { label: 'Equipment & items', kinds: ['item', 'recipe'] },
  { label: 'Classes & skills', kinds: ['class', 'command', 'ability', 'passive', 'innate', 'monsterMagic'] },
  { label: 'World & effects', kinds: ['monster', 'location', 'status', 'other'] },
]

export const DEFINITION_KIND_LABELS: Record<CatalogEntityKind, string> = {
  item: 'Items', recipe: 'Recipes', class: 'Classes', command: 'Commands', ability: 'Abilities', passive: 'Passives', innate: 'Innates', monsterMagic: 'Monster Magic', monster: 'Monsters', location: 'Locations', status: 'Status effects', other: 'Other',
}

export const CATEGORY_GROUPS = ['Weapons', 'Armor & headgear', 'Accessories & shields', 'Items & crafting', 'Classes & skills', 'Skill types & effects', 'Status effects', 'World & exploration', 'Enemies & bosses', 'Enemy locations & levels', 'Enemy drops & abilities', 'Mods & reference', 'Other categories'] as const
export type CategoryGroup = typeof CATEGORY_GROUPS[number]

export function referenceCategoryGroup(value: string, kinds: readonly CatalogEntityKind[]): CategoryGroup {
  const equipmentGroup = referenceEquipmentCategoryGroup(value)
  if (equipmentGroup) return equipmentGroup
  const name = referenceCategoryLabel(value).trim().toLocaleLowerCase()
  if (/^(?:weapons?|axes?|books?|bows?|daggers?|katanas?|rapiers?|scythes?|spears?|staves|staff|staffs|swords?|wands?|two-handed staff)$/.test(name)) return 'Weapons'
  if (/^(?:(?:heavy|medium|light) )?(?:armou?r|helmets?|headgear|hats?)$/.test(name)) return 'Armor & headgear'
  if (/^(?:accessor(?:y|ies)|shields?)$/.test(name)) return 'Accessories & shields'
  if (/^(?:mod pack|nintendo switch|catalog metadata)/.test(name)) return 'Mods & reference'
  if (/^(?:monsters found in |level \d+ enemies)/.test(name)) return 'Enemy locations & levels'
  if (/^monsters (?:that |with )/.test(name)) return 'Enemy drops & abilities'
  if (/^(?:abilities that |single |multi-|self only|everything-targeted|stance change|weapon skill)/.test(name)) return 'Skill types & effects'
  if (['buffs', 'debuffs', 'stances', 'status effects'].includes(name)) return 'Status effects'
  if (['crafting', 'consumables', 'key items', 'keys', 'maps', 'seeds', 'tools', 'pouches', 'items'].includes(name)) return 'Items & crafting'
  if (kinds.some(kind => ['class', 'command', 'ability', 'passive', 'innate', 'monsterMagic'].includes(kind))) return 'Classes & skills'
  if (kinds.includes('item') || kinds.includes('recipe')) return 'Items & crafting'
  if (kinds.includes('monster')) return 'Enemies & bosses'
  if (kinds.includes('status')) return 'Status effects'
  if (kinds.includes('location') || ['exploration', 'fishing', 'gameplay', 'npcs', 'quintar breeding'].includes(name)) return 'World & exploration'
  return 'Other categories'
}
