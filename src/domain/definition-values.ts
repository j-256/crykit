import type { CatalogEntity, JsonValue, Knowledge, PersonalDefinition } from './types'

export function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, normalize(entry)]))
    return value
  }
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

const CONTRIBUTION_FIELDS = new Set(['Accuracy', 'Agility', 'Attack', 'Crit. Chance', 'Crit. Damage', 'Def. Pierce', 'Defense', 'Dexterity', 'Evasion', 'Luck', 'Max. HP', 'Max. MP', 'Mind', 'Res. Pierce', 'Resistance', 'Speed', 'Spirit', 'Strength', 'Vitality'])

function numericKnowledge(value: Knowledge<JsonValue> | undefined): Knowledge<number> {
  const valid = (candidate: JsonValue): candidate is number => typeof candidate === 'number' && Number.isFinite(candidate)
  if (value?.state === 'known' && valid(value.value)) return { ...value, value: value.value }
  if (value?.state === 'conflicting' && value.claims.every(claim => valid(claim.value))) return { state: 'conflicting', claims: value.claims.map(claim => ({ ...claim, value: claim.value as number })) }
  if (value?.state === 'unknown' || value?.state === 'notApplicable') return value
  return { state: 'unknown', reason: 'The definition does not establish a valid numeric planning value' }
}

export function synchronizePlanningField(entity: CatalogEntity, field: string): CatalogEntity
export function synchronizePlanningField(entity: PersonalDefinition, field: string): PersonalDefinition
export function synchronizePlanningField(entity: CatalogEntity | PersonalDefinition, field: string): CatalogEntity | PersonalDefinition {
  const value = entity.fields[field]
  const normalized = field.toLocaleLowerCase().trim()
  if (normalized === 'pp' || normalized === 'pp cost') return { ...entity, ppCost: numericKnowledge(value) }
  if (normalized === 'description') {
    const { rawDescription: _description, ...rest } = entity
    return value?.state === 'known' && typeof value.value === 'string' ? { ...rest, rawDescription: value.value } : rest
  }
  if (CONTRIBUTION_FIELDS.has(field) && entity.kind === 'item') {
    const numeric = numericKnowledge(value)
    const contribution = numeric.state === 'known' ? { ...numeric, value: { value: numeric.value, unit: 'listed flat value' } } : numeric.state === 'conflicting' ? { ...numeric, claims: numeric.claims.map(claim => ({ ...claim, value: { value: claim.value, unit: 'listed flat value' } })) } : numeric
    return { ...entity, listedContributions: { ...entity.listedContributions, [field]: contribution } }
  }
  return entity
}
