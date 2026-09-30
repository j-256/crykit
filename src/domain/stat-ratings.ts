import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS, STAT_KEYS, type GrowthStat } from './crystal-edit'
import type { CatalogEntity, Knowledge } from './types'

export const CLASS_RATING_STARS = 5
export const CLASS_RATING_PER_STAR = 20
export const CLASS_STAT_LABELS: Readonly<Record<GrowthStat, string>> = Object.freeze({ HP: 'Max. HP', MP: 'Max. MP', STR: 'Strength', VIT: 'Vitality', DEX: 'Dexterity', AGI: 'Agility', MND: 'Mind', SPI: 'Spirit', SPD: 'Speed', LUK: 'Luck' })
export const WIKI_STAT_RATING_FIELD = 'Stat growth'

export function isStatRatingField(field?: string): boolean {
  return field === CLASS_FIELDS.ratings || field === CRYSTAL_EDIT_FIELDS.ratings || field === WIKI_STAT_RATING_FIELD
}

export function classRatingField(entity: Pick<CatalogEntity, 'fields'>): readonly [string, Knowledge<unknown>] {
  if (Object.hasOwn(entity.fields, CLASS_FIELDS.ratings)) return [CLASS_FIELDS.ratings, entity.fields[CLASS_FIELDS.ratings]!]
  if (Object.hasOwn(entity.fields, CRYSTAL_EDIT_FIELDS.ratings)) return [CRYSTAL_EDIT_FIELDS.ratings, entity.fields[CRYSTAL_EDIT_FIELDS.ratings]!]
  return [WIKI_STAT_RATING_FIELD, entity.fields[WIKI_STAT_RATING_FIELD] ?? { state: 'unknown' }]
}

export function statRatingValues(field: string, value: unknown): Readonly<Record<GrowthStat, number | null>> {
  const points = field === CLASS_FIELDS.ratings || field === CRYSTAL_EDIT_FIELDS.ratings
  const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return Object.fromEntries(STAT_KEYS.map(stat => {
    const raw = record[points ? stat : CLASS_STAT_LABELS[stat]]
    const match = typeof raw === 'string' ? /^(\d+(?:\.\d+)?)\s+Stars?$/i.exec(raw.trim()) : undefined
    const numeric = typeof raw === 'number' ? raw : match ? Number(match[1]) : NaN
    const stars = points ? numeric / CLASS_RATING_PER_STAR : numeric
    return [stat, Number.isFinite(stars) && stars >= 0 ? stars : null]
  })) as Readonly<Record<GrowthStat, number | null>>
}
