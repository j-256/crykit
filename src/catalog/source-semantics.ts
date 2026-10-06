import type { CatalogEntity, JsonValue, Knowledge, SourceRef } from '../domain/types'

const STRUCTURED_CHEST_LOCATION = /^Chest:\s*(.+)$/i
const PROSE_CHEST_LOCATION = /^(?:(?:It|This|One)\s+)?can be found in (?:a|the) chest,?\s+in\s+(.+?)[.]?$/i
const CANONICAL_ACQUISITION_LINE = /^(?:(?:Shop|Chest|Craft|Drop|Reward|Steal|Start):|Fishing(?:\s|$))/i
const ACQUISITION_LINE = /^(?:(?:Shop|Chest|Craft|Drop|Reward|Steal|Start|Location|Drops from):|Fishing(?:\s|$))/i
const GENERIC_CRAFTING_LOCATION = /^Obtained\s+(?:by|via)\s+Crafting\b[\s\S]*$/i
const COST_CURRENCY = /\b(?:Copper|Silver)\b/gi
const MIN_SHARED_LOCATION_WORDS = 2
const MIN_LOCATION_WORD_OVERLAP = 0.4
const STRONG_LOCATION_WORD_OVERLAP = 0.75
const LOCATION_STOP_WORDS = new Set([
  'a', 'also', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'before', 'by', 'can', 'chest', 'craft', 'drop', 'each', 'equipment', 'fish', 'fishing', 'for', 'found', 'from', 'given', 'has', 'have', 'in', 'into', 'is', 'it', 'item', 'location', 'merchant', 'more', 'obtained', 'of', 'on', 'one', 'or', 'purchased', 'receive', 'reward', 'shop', 'start', 'steal', 'stolen', 'the', 'these', 'this', 'to', 'traded', 'trading', 'via', 'was', 'were', 'will', 'with', 'you', 'your',
])
const WORD_EQUIVALENTS = Object.freeze<Record<string, string>>({
  armour: 'armor',
  bosses: 'boss',
  chests: 'chest',
  classes: 'class',
  knickknacks: 'knickknack',
  seals: 'seal',
  shops: 'shop',
  weapons: 'weapon',
})
const ACQUISITION_METHODS = Object.freeze([
  ['chest', /\bchests?\b/i],
  ['shop', /\b(?:shops?|purchas\w*|sold|merchants?|vendors?)\b/i],
  ['craft', /(?:^|\n)\s*Craft:|\b(?:obtained|made)\s+(?:by|via)\s+crafting\b|\btrad(?:e|ed|ing)\b/i],
  ['drop', /\bdrop\w*\b/i],
  ['steal', /\b(?:steal\w*|stole\w*|stolen)\b/i],
  ['reward', /\b(?:rewards?|prizes?|given|gift\w*|win|winning)\b/i],
  ['start', /\b(?:start\w*|initial equipment)\b/i],
  ['fishing', /\bfish\w*\b/i],
  ['catch', /\b(?:catch\w*|caught)\b/i],
] as const)

function normalizedClaimValue(field: string, value: JsonValue): JsonValue {
  if (field !== 'Location' || typeof value !== 'string') return value
  const normalized = value.trim()
  const match = STRUCTURED_CHEST_LOCATION.exec(normalized) ?? PROSE_CHEST_LOCATION.exec(normalized)
  const location = match?.[1].replace(/[.]$/, '').trim()
  return location ? `Chest: ${location}` : value
}

function normalizedWord(word: string): string {
  const equivalent = WORD_EQUIVALENTS[word]
  if (equivalent) return equivalent
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

function semanticLocationWords(value: string): ReadonlySet<string> {
  const words = value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/'s\b/g, '')
    .match(/[\p{L}\p{N}]+/gu) ?? []
  return new Set(words.map(normalizedWord).filter(word => word.length > 1 && !LOCATION_STOP_WORDS.has(word)))
}

function acquisitionMethods(value: string): ReadonlySet<string> {
  return new Set(ACQUISITION_METHODS.filter(([, pattern]) => pattern.test(value)).map(([method]) => method))
}

function acquisitionSummaryScore(value: string): number {
  const lines = value.split('\n').map(line => line.trim()).filter(Boolean)
  const canonicalLines = lines.filter(line => CANONICAL_ACQUISITION_LINE.test(line)).length
  if (lines.length === 0 || canonicalLines === 0) return -1
  const compatibleProse = /\b(?:given|gift\w*|obtained|found|purchas\w*|drop\w*|st(?:eal|ole|olen)\w*|rewards?)\b/i
  if (lines.some(line => !ACQUISITION_LINE.test(line) && !compatibleProse.test(line))) return -1
  return canonicalLines * 1000 - (lines.length - canonicalLines) * 100 - value.length
}

function structuredAcquisitionTarget(value: string): ReadonlySet<string> | undefined {
  const target = /^(?:Drop|Drops from|Steal):\s*(.+?)(?:,|\s+in\b|\s+at\b|\s+grown\b|$)/im.exec(value)?.[1]
  if (!target) return undefined
  const words = semanticLocationWords(target)
  return words.size > 0 ? words : undefined
}

function compatibleLocationValue(values: readonly string[]): string | undefined {
  if (values.length !== 2) return undefined
  const scores = values.map(acquisitionSummaryScore)
  const summaryIndex = scores[0]! >= scores[1]! ? 0 : 1
  if (scores[summaryIndex]! < 0) return undefined
  const detailIndex = summaryIndex === 0 ? 1 : 0
  const summary = values[summaryIndex]!
  const detail = values[detailIndex]!
  if ((GENERIC_CRAFTING_LOCATION.test(summary) && /^Craft:/im.test(detail)) || (GENERIC_CRAFTING_LOCATION.test(detail) && /^Craft:/im.test(summary))) {
    return /^Craft:/im.test(summary) ? summary : detail
  }

  const summaryWords = semanticLocationWords(summary)
  const detailWords = semanticLocationWords(detail)
  const sharedWords = [...summaryWords].filter(word => detailWords.has(word))
  const smallestWordCount = Math.min(summaryWords.size, detailWords.size)
  const overlap = smallestWordCount === 0 ? 0 : sharedWords.length / smallestWordCount
  const summaryMethods = acquisitionMethods(summary)
  const detailMethods = acquisitionMethods(detail)
  const sharedMethod = [...summaryMethods].some(method => detailMethods.has(method))
  if (summaryWords.size === 0) return sharedMethod ? summary : undefined
  const hasLexicalEvidence = sharedWords.length >= MIN_SHARED_LOCATION_WORDS || overlap >= MIN_LOCATION_WORD_OVERLAP
  const target = structuredAcquisitionTarget(summary)
  const sharedTarget = target !== undefined && [...target].every(word => detailWords.has(word))
  const neutralDetail = summaryMethods.has('chest') && detailMethods.size === 0 && sharedWords.length >= MIN_SHARED_LOCATION_WORDS
  return (hasLexicalEvidence && (sharedMethod || overlap >= STRONG_LOCATION_WORD_OVERLAP || neutralDetail)) || sharedTarget ? summary : undefined
}

function presentationKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/(\p{L})-(\p{L})/gu, '$1 $2')
    .replace(/[.:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function costKey(value: string): string | undefined {
  const withoutCurrency = value.replace(COST_CURRENCY, ' ').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()
  return /^\d+(?: \d+)*$/.test(withoutCurrency) ? withoutCurrency.replaceAll(' ', ':') : undefined
}

function compatibleCostValue(values: readonly string[]): string | undefined {
  const keys = values.map(costKey)
  const hasExplicitCurrency = values.some(value => (value.match(COST_CURRENCY) ?? []).length > 0)
  if (keys.some(key => key === undefined) || keys.some(key => key !== keys[0]) || !hasExplicitCurrency) return undefined
  return [...values].sort((left, right) => {
    const currencyDifference = (right.match(COST_CURRENCY) ?? []).length - (left.match(COST_CURRENCY) ?? []).length
    return currencyDifference || right.length - left.length
  })[0]
}

function uniqueSources(sources: readonly SourceRef[]): readonly SourceRef[] {
  return Array.from(new Map(sources.map(source => [JSON.stringify(source), source])).values())
}

export function coalesceEquivalentSourceClaims(field: string, value: Knowledge<JsonValue>): Knowledge<JsonValue> {
  // Notes may distinguish claims that look equal; presentation normalization must not erase that evidence
  if (value.state !== 'conflicting' || value.claims.length < 2 || value.claims.some(claim => claim.note !== undefined)) return value
  const normalized = value.claims.map(claim => normalizedClaimValue(field, claim.value))
  let compatibleValue = normalized.every(candidate => JSON.stringify(candidate) === JSON.stringify(normalized[0])) ? normalized[0] : undefined
  const stringValues = normalized.every((candidate): candidate is string => typeof candidate === 'string') ? normalized : undefined
  if (compatibleValue === undefined && stringValues?.every(candidate => presentationKey(candidate) === presentationKey(stringValues[0]!))) compatibleValue = stringValues[0]
  if (compatibleValue === undefined && field === 'Location' && stringValues) compatibleValue = compatibleLocationValue(stringValues)
  if (compatibleValue === undefined && field === 'Cost' && stringValues) compatibleValue = compatibleCostValue(stringValues)
  return compatibleValue === undefined
    ? value
    : { state: 'known', value: compatibleValue, sources: uniqueSources(value.claims.flatMap(claim => claim.sources)) }
}

export function projectSourceSemantics(entity: CatalogEntity): CatalogEntity {
  let changed = false
  const fields = Object.fromEntries(Object.entries(entity.fields).map(([field, value]) => {
    const projected = coalesceEquivalentSourceClaims(field, value)
    if (projected !== value) changed = true
    return [field, projected]
  }))
  return changed ? { ...entity, fields } : entity
}
