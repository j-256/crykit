import type { CatalogEntity, JsonValue, Knowledge, SourceRef } from '../domain/types'

const STRUCTURED_CHEST_LOCATION = /^Chest:\s*(.+)$/i
const PROSE_CHEST_LOCATION = /^(?:(?:It|This|One)\s+)?can be found in (?:a|the) chest,?\s+in\s+(.+?)[.]?$/i

function normalizedClaimValue(field: string, value: JsonValue): JsonValue {
  if (field !== 'Location' || typeof value !== 'string') return value
  const normalized = value.trim()
  const match = STRUCTURED_CHEST_LOCATION.exec(normalized) ?? PROSE_CHEST_LOCATION.exec(normalized)
  const location = match?.[1].replace(/[.]$/, '').trim()
  return location ? `Chest: ${location}` : value
}

function uniqueSources(sources: readonly SourceRef[]): readonly SourceRef[] {
  return Array.from(new Map(sources.map(source => [JSON.stringify(source), source])).values())
}

export function coalesceEquivalentSourceClaims(field: string, value: Knowledge<JsonValue>): Knowledge<JsonValue> {
  if (value.state !== 'conflicting' || value.claims.length < 2 || value.claims.some(claim => claim.note !== undefined)) return value
  const normalized = value.claims.map(claim => normalizedClaimValue(field, claim.value))
  if (normalized.some(candidate => JSON.stringify(candidate) !== JSON.stringify(normalized[0]))) return value
  return { state: 'known', value: normalized[0]!, sources: uniqueSources(value.claims.flatMap(claim => claim.sources)) }
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
