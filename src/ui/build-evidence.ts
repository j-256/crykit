import { STARTER_CATALOG_ID } from '../catalog/starter'
import { nativeSourceRecord } from '../domain/native-game'
import { definitionLineageRootRef, sameLogicalEntity } from '../domain/definitions'
import type { CatalogEntity, EntityRef, JsonValue, Knowledge, PersonalDefinition, LocalData, ValidationIssue } from '../domain/types'
import type { DefinitionOption } from './definitions'

type Definition = CatalogEntity | PersonalDefinition
const REFERENCE_ARTICLES = new Set([
  'axes', 'books', 'bows', 'daggers', 'heavy-armor', 'heavy-helmets', 'katanas',
  'light-armor', 'light-hats', 'medium-armor', 'medium-headgear', 'rapiers',
  'scythes', 'shields', 'spears', 'staves', 'swords', 'wands',
].map(name => `base:item:${name}`))
const DECISION_FIELDS = /^(stat bonuses|stat|other effects|other|effects?|attack|defense|magic|resistance|strength|vitality|dexterity|agility|mind|spirit|speed|luck|hp|mp|weapons?|armor|innate passives?|command|pp|cost|cost \(copper\))$/i
const SUMMARY_LINE_FIELDS = /^(stat bonuses|stat|other effects|other|effects?)$/i
const FLAT_CONTRIBUTION_UNITS = new Set(['displayed', 'listed flat value'])

export function isReferenceArticle(localData: LocalData, ref: EntityRef): boolean {
  const root = definitionLineageRootRef(localData, ref)
  return root.kind === 'catalog' && root.catalogId === STARTER_CATALOG_ID && REFERENCE_ARTICLES.has(root.entityId)
}

export function hasNameEvidenceOnly(record: Definition): boolean {
  if (nativeSourceRecord(record)) return false
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
    const monetaryCost = label === 'Cost (copper)'
    const displayed = monetaryCost && value.state === 'known' && typeof value.value === 'number' ? { ...value, value: `${value.value} Copper` } : value
    return [{ label: monetaryCost ? 'Cost' : label, value: displayed }]
  }).sort((left, right) => Number(/^cost$/i.test(left.label)) - Number(/^cost$/i.test(right.label)))
}

export function compactKnowledge(value?: Knowledge<unknown>): string {
  if (!value || value.state === 'unknown') return 'Unknown'
  if (value.state === 'conflicting') return 'Conflicting sources'
  if (value.state === 'notApplicable') return 'Not applicable'
  if (typeof value.value === 'object') return Array.isArray(value.value) ? value.value.map(String).join(', ') : 'See details'
  return String(value.value)
}

function summaryIdentity(value: string): string {
  return value.toLocaleLowerCase().replace(/\blisted flat value\b/g, '').replace(/\+/g, '').replace(/[.\s]/g, '')
}

export function summaryFactLines(record: Definition): readonly string[] {
  const lines: string[] = []
  const seen = new Set<string>()
  const contributionLabels = new Set(Object.keys(record.listedContributions ?? {}).map(label => label.toLocaleLowerCase()))
  const add = (line: string) => {
    const trimmed = line.trim()
    const identity = summaryIdentity(trimmed)
    if (!trimmed || seen.has(identity)) return
    seen.add(identity)
    lines.push(trimmed)
  }
  for (const [label, contribution] of Object.entries(record.listedContributions ?? {})) {
    if (contribution.state !== 'known') {
      add(`${label}: ${compactKnowledge(contribution)}`)
      continue
    }
    const { value, unit, condition } = contribution.value
    const displayedUnit = FLAT_CONTRIBUTION_UNITS.has(unit.trim().toLocaleLowerCase()) ? '' : ` ${unit}`
    add(`${label}: ${value > 0 ? '+' : ''}${value}${displayedUnit}${condition ? ` when ${condition}` : ''}`)
  }
  for (const fact of decisionFacts(record)) {
    if (contributionLabels.has(fact.label.toLocaleLowerCase())) continue
    if (fact.value.state === 'known' && typeof fact.value.value === 'string' && SUMMARY_LINE_FIELDS.test(fact.label)) {
      for (const line of fact.value.value.split(/\r?\n/)) add(line)
    } else {
      add(`${fact.label}: ${compactKnowledge(fact.value)}`)
    }
  }
  return lines.sort((left, right) => Number(/^cost:/i.test(left)) - Number(/^cost:/i.test(right)) || Number(!/attack|defense|resistance/i.test(left)) - Number(!/attack|defense|resistance/i.test(right)))
}

export function ppCostLabel(option: DefinitionOption): string {
  const cost = option.ppCost
  return cost?.state === 'known' ? `${cost.value} PP` : `PP: ${compactKnowledge(cost).toLowerCase()}`
}

export function similarNameOptions(localData: LocalData, options: readonly DefinitionOption[]): ReadonlyMap<string, readonly DefinitionOption[]> {
  const groups = new Map<string, DefinitionOption[]>()
  for (const option of options) {
    const key = `${option.kind}:${option.name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')}`
    const group = groups.get(key) ?? []
    group.push(option)
    groups.set(key, group)
  }
  return new Map([...groups.values()].filter((group) => group.length > 1).flatMap((group) => group.flatMap((option) => {
    const alternatives = group.filter((other) => !sameLogicalEntity(localData, option.ref, other.ref))
    return alternatives.length ? [[option.key, alternatives] as const] : []
  })))
}

export function groupValidationIssues(issues: readonly ValidationIssue[]): readonly (readonly ValidationIssue[])[] {
  const groups = new Map<string, ValidationIssue[]>()
  for (const issue of issues) {
    const key = JSON.stringify([issue.status, issue.code, issue.code === 'GAME_SETUP_FIELD_UNKNOWN' ? '' : issue.message])
    const group = groups.get(key) ?? []
    group.push(issue)
    groups.set(key, group)
  }
  return [...groups.values()]
}
