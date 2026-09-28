import { STARTER_CATALOG_ID } from '../catalog/starter'
import { definitionLineageRootRef, sameLogicalEntity } from '../domain/definitions'
import type { CatalogEntity, EntityRef, JsonValue, Knowledge, PersonalDefinition, Profile, ValidationIssue } from '../domain/types'
import type { DefinitionOption } from './definitions'

type Definition = CatalogEntity | PersonalDefinition
const REFERENCE_ARTICLES = new Set([
  'axes', 'books', 'bows', 'daggers', 'heavy-armor', 'heavy-helmets', 'katanas',
  'light-armor', 'light-hats', 'medium-armor', 'medium-headgear', 'rapiers',
  'scythes', 'shields', 'spears', 'staves', 'swords', 'wands',
].map((name) => `wiki:item:${name}`))
const DECISION_FIELDS = /^(stat bonuses|stat|other effects|other|effects?|attack|defense|magic|resistance|strength|vitality|dexterity|agility|mind|spirit|speed|luck|hp|mp|hands|weapons?|armor|innate passives?|command|pp|cost)$/i

export function isReferenceArticle(profile: Profile, ref: EntityRef): boolean {
  const root = definitionLineageRootRef(profile, ref)
  return root.kind === 'catalog' && root.catalogId === STARTER_CATALOG_ID && REFERENCE_ARTICLES.has(root.entityId)
}

export function hasNameEvidenceOnly(record: Definition): boolean {
  const legacy = 'legacy' in record ? record.legacy : undefined
  const wiki = legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? (legacy as Record<string, JsonValue>).wiki : undefined
  return Boolean(wiki && typeof wiki === 'object' && !Array.isArray(wiki) && (wiki as Record<string, JsonValue>).missingDetailPageOrRow === true)
}

export function decisionFacts(record: Definition): readonly { readonly label: string; readonly value: Knowledge<JsonValue> }[] {
  const seen = new Set<string>()
  return Object.entries(record.fields).flatMap(([label, value]) => {
    if (!DECISION_FIELDS.test(label)) return []
    if (value.state === 'known' && (value.value === '' || value.value === '-' || value.value === null)) return []
    const family = /^(stat|stat bonuses)$/i.test(label) ? 'stat' : /^(other|other effects|effects?)$/i.test(label) ? 'effects' : label.toLowerCase()
    const key = `${family}:${JSON.stringify(value.state === 'known' ? value.value : value)}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{ label, value }]
  })
}

export function compactKnowledge(value?: Knowledge<unknown>): string {
  if (!value || value.state === 'unknown') return 'Unknown'
  if (value.state === 'conflicting') return 'Conflicting sources'
  if (value.state === 'notApplicable') return 'Not applicable'
  if (typeof value.value === 'object') return Array.isArray(value.value) ? value.value.map(String).join(', ') : 'See details'
  return String(value.value)
}

export function sourcePpLabel(option: DefinitionOption): string {
  const cost = option.ppCost
  return cost?.state === 'known' ? `${cost.value} source PP` : `PP: ${compactKnowledge(cost).toLowerCase()}`
}

export function similarNameOptions(profile: Profile, options: readonly DefinitionOption[]): ReadonlyMap<string, readonly DefinitionOption[]> {
  const groups = new Map<string, DefinitionOption[]>()
  for (const option of options) {
    const key = `${option.kind}:${option.name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')}`
    const group = groups.get(key) ?? []
    group.push(option)
    groups.set(key, group)
  }
  return new Map([...groups.values()].filter((group) => group.length > 1).flatMap((group) => group.flatMap((option) => {
    const alternatives = group.filter((other) => !sameLogicalEntity(profile, option.ref, other.ref))
    return alternatives.length ? [[option.key, alternatives] as const] : []
  })))
}

export function groupValidationIssues(issues: readonly ValidationIssue[]): readonly (readonly ValidationIssue[])[] {
  const groups = new Map<string, ValidationIssue[]>()
  for (const issue of issues) {
    const key = JSON.stringify([issue.status, issue.code, issue.code === 'RULESET_FIELD_UNKNOWN' ? '' : issue.message])
    const group = groups.get(key) ?? []
    group.push(issue)
    groups.set(key, group)
  }
  return [...groups.values()]
}
