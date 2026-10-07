import { nativeDescription } from '../catalog/native-description'
import { STARTER_CATALOG_ID } from '../catalog/catalog-ids'
import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { nativeDefinitionLabel, nativeDisplayDescription, nativeGameplayScopeLabel, nativeIdentity, nativeRecord, nativeSourceRecord } from '../domain/native-game'
import { effectText } from '../domain/mechanics-facts'
import { definitionLineageRootRef, sameLogicalEntity } from '../domain/definitions'
import type { CatalogEntity, EntityRef, JsonValue, Knowledge, PersonalDefinition, LocalData, ValidationIssue } from '../domain/types'
import type { DefinitionOption } from './definitions'

type Definition = CatalogEntity | PersonalDefinition
const REFERENCE_ARTICLES = new Set([
  'base:item:ref-62',
  'base:item:ref-68',
  'base:item:ref-70',
  'base:item:ref-88',
  'base:item:ref-112',
  'base:item:ref-113',
  'base:item:ref-122',
  'base:item:ref-127',
  'base:item:ref-128',
  'base:item:ref-138',
  'base:item:ref-139',
  'base:item:ref-169',
  'base:item:ref-183',
  'base:item:ref-189',
  'base:item:ref-194',
  'base:item:ref-196',
  'base:item:ref-199',
  'base:item:ref-217',
])
const DECISION_FIELDS = /^(stat bonuses|stat|other effects|other|effects?|attack|defense|magic|resistance|strength|vitality|dexterity|agility|mind|spirit|speed|luck|hp|mp|weapons?|armor|innate passives?|command|pp|cost|cost \(copper\))$/i
const SUMMARY_LINE_FIELDS = /^(stat bonuses|stat|other effects|other|effects?)$/i
const SUMMARY_EFFECT_FIELDS = ['Other effects', 'Effects', 'Effect', 'Other'] as const
const FLAT_CONTRIBUTION_UNITS = new Set(['displayed', 'listed flat value'])
const NATIVE_NUMERIC_TEMPLATES = (() => {
  const system = NATIVE_GAME_DATA.databases.system
  const vocabulary = nativeRecord(system) && nativeRecord(system.Vocab) ? system.Vocab : undefined
  const general = nativeRecord(vocabulary?.General) ? vocabulary.General : {}
  const templates = vocabulary?.StatModText
  return new Map(Array.isArray(templates) ? templates.flatMap((template, tag) => {
    if (typeof template !== 'string') return []
    const match = /^(.+)@V\.Sep\[v1s\](%)?$/.exec(template)
    if (!match) return []
    const label = match[1]!.replace(/@V\.(\w+)/g, (token, key: string) => typeof general[key] === 'string' ? general[key] as string : token).trim()
    return label && !/[@[\]\r\n]/.test(label) ? [[tag, { label, percent: Boolean(match[2]) }]] : []
  }) : [])
})()
const NATIVE_PERCENT_SUMMARY_LABELS = (() => {
  const system = NATIVE_GAME_DATA.databases.system
  const vocabulary = nativeRecord(system) && nativeRecord(system.Vocab) ? system.Vocab : undefined
  const templates = vocabulary?.StatModText
  const suffix = '@V.Sep[v1s]%'
  return new Map(Array.isArray(templates) ? templates.flatMap((template, tag) => {
    if (typeof template !== 'string' || !template.endsWith(suffix)) return []
    const label = template.slice(0, -suffix.length).trim()
    return label && !/[@[\]\r\n]/.test(label) ? [[tag, label]] : []
  }) : [])
})()

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
  const normalized = value.toLocaleLowerCase().replace(/\blisted flat value\b/g, '').replace(/\+/g, '').replace(/\bgrants immunity to\b/g, 'immune to').replace(/\.(?!\d)|(?<!\d)\.|:/g, '').replace(/\s+/g, ' ').trim()
  return normalized.replace(/\s/g, '')
}

function numericFactKey(label: string, value: number): string {
  return JSON.stringify([label.toLocaleLowerCase().replace(/\s+/g, ' ').trim(), value])
}

function corroboratedNativePercentFacts(record: Definition): ReadonlySet<string> {
  if (!nativeDescription(record)) return new Set()
  const version = record.fields['Game version']
  const modifiers = nativeSourceRecord(record)?.StatMods
  if (!nativeIdentity(record) || version?.state !== 'known' || version.value !== NATIVE_GAME_DATA.source.gameVersion || !Array.isArray(modifiers)) return new Set()
  return new Set(modifiers.flatMap(modifier => {
    if (!nativeRecord(modifier) || typeof modifier.Tag !== 'number' || typeof modifier.Value1 !== 'number' || !Number.isFinite(modifier.Value1) || modifier.Value2 !== 0 || modifier.Value3 !== 0) return []
    const label = NATIVE_PERCENT_SUMMARY_LABELS.get(modifier.Tag)
    return label ? [numericFactKey(label, modifier.Value1)] : []
  }))
}

function numericSummaryFact(line: string): { readonly key: string; readonly label: string; readonly value: number; readonly percent: boolean } | undefined {
  const match = /^([^:]+?)(?::\s*|\s+)([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(%)?$/.exec(line)
  return match ? { key: numericFactKey(match[1]!, Number(match[2])), label: match[1]!.trim(), value: Number(match[2]), percent: match[3] === '%' } : undefined
}

function sourceSummaryFactLines(record: Definition): readonly string[] {
  const lines: string[] = []
  const seen = new Set<string>()
  const statFragments = new Set<string>()
  const contributionLabels = new Set(Object.keys(record.listedContributions ?? {}).map(label => label.toLocaleLowerCase()))
  const add = (line: string) => {
    const trimmed = line.trim().replace(/^([^:]+):\s*\1:\s*/i, '$1: ')
    const identity = summaryIdentity(trimmed)
    if (!trimmed || seen.has(identity)) return false
    seen.add(identity)
    lines.push(trimmed)
    return true
  }
  const sourceDescription = nativeSourceRecord(record)?.Description
  const nativeEffect = typeof sourceDescription === 'string' && sourceDescription.trim() ? sourceDescription : undefined
  const description = nativeEffect ?? (['passive', 'innate'].includes(record.kind) ? effectText(record) : undefined)
  if (description) for (const line of description.split(/\r?\n/)) add(line)
  const preferredEffect = SUMMARY_EFFECT_FIELDS.find(label => {
    const value = record.fields[label]
    return value?.state === 'known' && typeof value.value === 'string' && value.value.trim() !== '' && value.value !== '-'
  })
  const fields = Object.fromEntries(Object.entries(record.fields).filter(([label, value]) => !SUMMARY_EFFECT_FIELDS.some(field => field === label) || value.state !== 'known' || !nativeEffect && label === preferredEffect))
  for (const [label, contribution] of Object.entries(record.listedContributions ?? {})) {
    if (contribution.state !== 'known') {
      add(`${label}: ${compactKnowledge(contribution)}`)
      continue
    }
    const { value, unit, condition } = contribution.value
    const displayedUnit = FLAT_CONTRIBUTION_UNITS.has(unit.trim().toLocaleLowerCase()) ? '' : ` ${unit}`
    add(`${label}: ${value > 0 ? '+' : ''}${value}${displayedUnit}${condition ? ` when ${condition}` : ''}`)
  }
  for (const fact of decisionFacts({ ...record, fields })) {
    if (contributionLabels.has(fact.label.toLocaleLowerCase())) continue
    if (fact.value.state === 'known' && typeof fact.value.value === 'string' && SUMMARY_LINE_FIELDS.test(fact.label)) {
      const statField = /^(stat|stat bonuses)$/i.test(fact.label)
      for (const line of fact.value.value.split(statField ? /\r?\n|,\s*/ : /\r?\n/)) {
        if (add(line) && statField) statFragments.add(line.trim())
      }
    } else {
      add(`${fact.label}: ${compactKnowledge(fact.value)}`)
    }
  }
  const nativePercentFacts = corroboratedNativePercentFacts(record)
  const explicitPercentFacts = new Set(lines.flatMap(line => {
    const fact = numericSummaryFact(line)
    return fact?.percent && nativePercentFacts.has(fact.key) ? [fact.key] : []
  }))
  return lines.filter(line => {
    if (!statFragments.has(line)) return true
    const fact = numericSummaryFact(line)
    return !fact || fact.percent || !explicitPercentFacts.has(fact.key)
  }).sort((left, right) => Number(/^cost:/i.test(left)) - Number(/^cost:/i.test(right)) || Number(!/attack|defense|resistance/i.test(left)) - Number(!/attack|defense|resistance/i.test(right)))
}

function nativeNumericSummaryFacts(record: Definition) {
  if (!nativeDescription(record)) return []
  const version = record.fields['Game version']
  const modifiers = nativeSourceRecord(record)?.StatMods
  if (!nativeIdentity(record) || version?.state !== 'known' || version.value !== NATIVE_GAME_DATA.source.gameVersion || !Array.isArray(modifiers) || record.fields['Crystal Edit source record'] || 'revision' in record) return []
  return modifiers.flatMap(modifier => {
    if (!nativeRecord(modifier) || typeof modifier.Tag !== 'number' || typeof modifier.Value1 !== 'number' || !Number.isFinite(modifier.Value1) || modifier.Value2 !== 0 || modifier.Value3 !== 0) return []
    const template = NATIVE_NUMERIC_TEMPLATES.get(modifier.Tag)
    return template ? [{ ...template, value: modifier.Value1, line: `${template.label}: ${modifier.Value1 > 0 ? '+' : ''}${modifier.Value1}${template.percent ? '%' : ''}` }] : []
  })
}

function sameStat(left: { readonly label: string; readonly percent: boolean }, right: { readonly label: string; readonly percent: boolean }) {
  return left.label.toLocaleLowerCase() === right.label.toLocaleLowerCase() && left.percent === right.percent
}

export function nativeListedStat(record: Definition, label: string): number | undefined {
  const displayLabel = /^(HP|MP)$/i.test(label) ? `Max. ${label.toUpperCase()}` : label
  return nativeNumericSummaryFacts(record).find(fact => !fact.percent && fact.label.toLocaleLowerCase() === displayLabel.toLocaleLowerCase())?.value
}

export function summaryFactLines(record: Definition): readonly string[] {
  const native = nativeNumericSummaryFacts(record)
  const source = sourceSummaryFactLines(record)
  if (!native.length) return source
  const resolved = source.map(line => {
    const fact = numericSummaryFact(line)
    return fact ? native.find(candidate => sameStat(candidate, fact))?.line ?? line : line
  })
  return [...new Set([...resolved, ...native.map(fact => fact.line)])].sort((left, right) => Number(/^cost:/i.test(left)) - Number(/^cost:/i.test(right)) || Number(!/attack|defense|resistance/i.test(left)) - Number(!/attack|defense|resistance/i.test(right)))
}

export function nativeStatSourceNotice(record: Definition): string | undefined {
  const native = nativeNumericSummaryFacts(record)
  const differs = sourceSummaryFactLines(record).some(line => {
    const fact = numericSummaryFact(line)
    return fact && native.some(candidate => sameStat(candidate, fact) && candidate.value !== fact.value)
  })
  return differs ? `Source stat values differ; ${nativeGameplayScopeLabel(NATIVE_GAME_DATA.source.platform, NATIVE_GAME_DATA.source.gameVersion)} values shown. Original claims are in provenance.` : undefined
}

export function definitionChoiceSourceLabel(option: DefinitionOption): string {
  const identity = nativeIdentity(option.record)
  if (!identity) return option.sourceLabel
  const level = nativeSourceRecord(option.record)?.Level
  return `${nativeDefinitionLabel(option.record)} · ${identity.database} ${identity.databaseId}${typeof level === 'number' && option.kind === 'item' ? ` · level ${level}` : ''}`
}

export function selectionSummaryLines(option: DefinitionOption): readonly string[] {
  const native = nativeDescription(option.record)
  const source = summaryFactLines(option.record)
  const retained = native?.complete ? source.filter(line => /^(cost|pp):/i.test(line)) : source
  const identities = new Set<string>()
  const lines = [...(native?.lines ?? []), ...retained].map(line => line.replace(/[\t ]+/g, ' ')).filter(line => {
    const identity = summaryIdentity(line)
    if (identities.has(identity)) return false
    identities.add(identity)
    return true
  })
  if (lines.length) return lines
  return (option.description ?? nativeDisplayDescription(option.record))?.split(/\r?\n/).map(line => line.trim()).filter(Boolean) ?? []
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
