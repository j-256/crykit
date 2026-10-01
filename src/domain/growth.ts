import { MAX_GROWTH_RATING, STAT_KEYS, type GrowthRatings, type GrowthStat } from './crystal-edit'
import { calculateFormula, GUIDE_RULES } from './calculation-rules'

export const GUIDE_GROWTH_SOURCE = Object.freeze({ sourceId: 'community:geef-modding-guide', locator: 'Game synopsis > Growths', applicability: 'Community formula estimate before equipment and passive effects; game rounding is unspecified' })
export const GUIDE_LEVEL_CAP = GUIDE_RULES.levelCap
const GUIDE_FORMULAS = GUIDE_RULES.growth
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
    const base = validRating(rating) ? calculateFormula('growthBase', [rating, formula.base, formula.baseRating], GUIDE_RULES) : null
    const levelPart = levelValid ? calculateFormula('growthLevel', [level, formula.level], GUIDE_RULES) : 0
    const growth = accumulated !== null && validRating(rating) && levelValid ? calculateFormula('growthHistory', [level, rating, accumulated, formula.growth, formula.primaryWeight, formula.historyWeight, formula.divisor], GUIDE_RULES) : null
    const bonus = bonuses.includes(stat) && levelValid ? calculateFormula('growthBonus', [level, formula.bonus, formula.bonusLevel], GUIDE_RULES) : 0
    const value = levelValid && historyValid && total === level && base !== null && growth !== null ? calculateFormula('growthTotal', [base, levelPart, growth, bonus], GUIDE_RULES) : null
    return [stat, { value, base, level: levelPart, growth, bonus }]
  })) as unknown as GrowthEstimate['stats']
  return { stats, issues }
}
