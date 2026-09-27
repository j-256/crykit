import { MAX_GROWTH_RATING, STAT_KEYS, type GrowthRatings, type GrowthStat } from './crystal-edit'

export const GUIDE_GROWTH_SOURCE = Object.freeze({ sourceId: 'community:geef-modding-guide', locator: 'Game synopsis > Growths', applicability: 'Community formula estimate before equipment and passive effects; game rounding is unspecified' })
export const GUIDE_LEVEL_CAP = 60
const GUIDE_FORMULAS = Object.freeze({
  HP: { base: 50, baseRating: 1, level: 9.533, growth: 0.113, primaryWeight: 1, historyWeight: 1, divisor: 2, bonus: 10, bonusLevel: 1.5 },
  MP: { base: 6, baseRating: 0.24, level: 0.25, growth: 0.0355, primaryWeight: 3, historyWeight: 2, divisor: 5, bonus: 6, bonusLevel: 0.233 },
  core: { base: 5, baseRating: 0.1, level: 1.25, growth: 0.0275, primaryWeight: 1, historyWeight: 1, divisor: 2, bonus: 3, bonusLevel: 0.2 },
})
export interface GrowthAllocation { readonly levels: number; readonly ratings: GrowthRatings }
export interface GrowthEstimate {
  readonly stats: Readonly<Record<GrowthStat, { readonly value: number | null; readonly base: number | null; readonly level: number; readonly growth: number | null; readonly bonus: number }>>
  readonly issues: readonly string[]
}

export function estimateGrowth(level: number, primary: GrowthRatings, history: readonly GrowthAllocation[], bonuses: readonly GrowthStat[] = []): GrowthEstimate {
  const issues: string[] = []
  const levelValid = Number.isInteger(level) && level >= 1 && level <= GUIDE_LEVEL_CAP
  if (!levelValid) issues.push(`Level must be a whole number from 1 to ${GUIDE_LEVEL_CAP}`)
  const historyValid = history.every(entry => Number.isInteger(entry.levels) && entry.levels >= 0 && entry.levels <= GUIDE_LEVEL_CAP)
  if (!historyValid) issues.push('Growth levels must be nonnegative whole numbers within the level limit')
  const total = history.reduce((sum, entry) => sum + entry.levels, 0)
  if (historyValid && levelValid && total !== level) issues.push(`Allocate ${level} growth levels; ${total} assigned`)
  const validRating = (rating: number | undefined): rating is number => typeof rating === 'number' && Number.isFinite(rating) && rating >= 0 && rating <= MAX_GROWTH_RATING
  const stats = Object.fromEntries(STAT_KEYS.map(stat => {
    const rating = primary[stat]
    const formula = GUIDE_FORMULAS[stat === 'HP' || stat === 'MP' ? stat : 'core']
    const relevant = history.filter(entry => entry.levels > 0)
    const complete = validRating(rating) && relevant.every(entry => validRating(entry.ratings[stat]))
    if (!complete) issues.push(`${stat}: a class growth rating is missing or invalid`)
    const accumulated = complete ? relevant.reduce((sum, entry) => sum + entry.levels * entry.ratings[stat]!, 0) : null
    const base = validRating(rating) ? formula.base + formula.baseRating * rating : null
    const levelPart = levelValid ? formula.level * level : 0
    const growth = accumulated !== null && validRating(rating) && levelValid ? formula.growth * (formula.primaryWeight * rating * level + formula.historyWeight * accumulated) / formula.divisor : null
    const bonus = bonuses.includes(stat) && levelValid ? formula.bonus + formula.bonusLevel * level : 0
    const value = levelValid && historyValid && total === level && base !== null && growth !== null ? base + levelPart + growth + bonus : null
    return [stat, { value, base, level: levelPart, growth, bonus }]
  })) as unknown as GrowthEstimate['stats']
  return { stats, issues }
}
