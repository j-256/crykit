import { STAT_KEYS, MAX_GROWTH_RATING, type GrowthStat } from './crystal-edit'
import { calculateFormula, PC_LEVEL_CAP, PC_RULES } from './calculation-rules'
import { calculationGenderId, nativeGenderDefinitions } from './calculation-genders'
import type { GameRuleResolution } from './game-rules'
import { nativeInteger } from './native-number'
import type { NativeRecord } from './pc-stats'
import type { BuildCalculationPlan } from './types'

export interface GrowthAllocation { readonly levels: number; readonly record?: NativeRecord }
export interface GrowthResult {
  readonly stats: Readonly<Record<GrowthStat, number | null>>
  readonly issues: readonly string[]
}

export function calculateGrowth(level: number, primary: NativeRecord | undefined, history: readonly GrowthAllocation[], gender?: BuildCalculationPlan['gender'], gameRules?: GameRuleResolution, genderSelection?: BuildCalculationPlan['genderSelection']): GrowthResult {
  const issues: string[] = [...gameRules?.issues ?? []]
  const levelValid = Number.isInteger(level) && level >= 1 && level <= PC_LEVEL_CAP
  if (!levelValid) issues.push(`Level must be a whole number from 1 to ${PC_LEVEL_CAP}`)
  const historyValid = history.every(row => Number.isInteger(row.levels) && row.levels >= 0 && row.levels <= PC_LEVEL_CAP)
  if (!historyValid) issues.push('Growth levels must be nonnegative whole numbers within the level limit')
  const total = history.reduce((sum, row) => sum + row.levels, 0)
  if (historyValid && levelValid && total !== level) issues.push(`Allocate ${level} growth levels; ${total} assigned`)
  const id = calculationGenderId({ gender, genderSelection })
  const genderRecord = (gameRules?.genders ?? nativeGenderDefinitions()).find(record => record.id === id)
  if (id !== undefined && !genderRecord) issues.push(`Gender #${id} is unavailable in this Game Setup`)
  if (genderRecord) issues.push(...genderRecord.issues)
  const rulesValid = !gameRules?.issues.length && (id === undefined || Boolean(genderRecord && !genderRecord.issues.length))
  const stats = Object.fromEntries(STAT_KEYS.map(stat => {
    const descriptor = PC_RULES.stats[stat]!
    const rating = primary?.[descriptor.rating!]
    const relevant = history.filter(row => row.levels > 0)
    const validRating = (value: unknown): value is number => nativeInteger(value) && value >= 0 && value <= MAX_GROWTH_RATING
    const complete = validRating(rating) && relevant.every(row => validRating(row.record?.[descriptor.rating!]))
    if (!complete) issues.push(`${stat}: a native class growth rating is missing or invalid`)
    const accumulated = complete ? relevant.reduce((sum, row) => sum + row.levels * (row.record![descriptor.rating!] as number), 0) : null
    let value: number | null = null
    if (rulesValid && levelValid && historyValid && total === level && complete && nativeInteger(accumulated)) {
      try { value = calculateFormula(descriptor.formula!, [level, rating as number, accumulated!, Number(genderRecord?.boosts[stat] === true)]) }
      catch { issues.push(`${stat}: native arithmetic is outside the supported range`) }
    }
    return [stat, value]
  })) as Record<GrowthStat, number | null>
  return { stats, issues }
}
