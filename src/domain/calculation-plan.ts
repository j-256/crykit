import { PC_LEVEL_CAP, PC_MODEL } from './calculation-rules'
import type { BuildCalculationPlan, EntityRef } from './types'
import { DomainError } from './core'
import { STAT_KEYS } from './crystal-edit'
import { GENDER_SELECTION_VERSION, MAX_GENDER_ID } from './calculation-genders'

export const CALCULATION_GENDERS = ['male', 'female'] as const
export const CALCULATION_GENDER_LABELS = Object.freeze({ male: 'Male', female: 'Female' })

export function defaultCalculation(primaryClass: EntityRef | null, level: number | null = PC_LEVEL_CAP): BuildCalculationPlan {
  return { model: PC_MODEL, growthMode: 'primary', pcMode: 'standard', level, growth: [{ classRef: primaryClass, levels: level }], bonuses: [], statuses: [] }
}

export function followPrimary(plan: BuildCalculationPlan, primaryClass: EntityRef | null): BuildCalculationPlan
export function followPrimary(plan: BuildCalculationPlan | undefined, primaryClass: EntityRef | null): BuildCalculationPlan | undefined
export function followPrimary(plan: BuildCalculationPlan | undefined, primaryClass: EntityRef | null): BuildCalculationPlan | undefined {
  return plan?.growthMode === 'primary' ? { ...plan, growth: [{ classRef: primaryClass, levels: plan.level }] } : plan
}

export function changeCalculationLevel(plan: BuildCalculationPlan, level: number | null, primaryClass: EntityRef | null): BuildCalculationPlan {
  return followPrimary({ ...plan, level }, primaryClass)
}

export function growthAllowance(plan: BuildCalculationPlan, index: number): number {
  const others = plan.growth.filter((_, position) => position !== index)
  if (plan.level === null || others.some(row => row.levels === null)) return 0
  return Math.max(0, plan.level - others.reduce((total, row) => total + row.levels!, 0))
}

export function changeGrowthLevels(plan: BuildCalculationPlan, index: number, levels: number | null): BuildCalculationPlan {
  const limit = Math.max(growthAllowance(plan, index), plan.growth[index]?.levels ?? 0)
  const bounded = levels === null ? null : Math.max(0, Math.min(limit, Math.trunc(levels)))
  return { ...plan, growthMode: 'manual', growth: plan.growth.map((row, position) => position === index ? { ...row, levels: bounded } : row) }
}

export function validateCalculationPlan(plan: BuildCalculationPlan, assertRef: (ref: EntityRef, label: string) => void): void {
  if (plan.level !== null && (!Number.isInteger(plan.level) || plan.level < 1 || plan.level > PC_LEVEL_CAP)) throw new DomainError('INVALID_INPUT', `Calculation level must be a whole number from 1 to ${PC_LEVEL_CAP} or unknown`)
  if (plan.growth.length > PC_LEVEL_CAP) throw new DomainError('INVALID_INPUT', 'Too many growth allocations')
  if (plan.bonuses.some(stat => !STAT_KEYS.includes(stat)) || new Set(plan.bonuses).size !== plan.bonuses.length) throw new DomainError('INVALID_INPUT', 'Calculation stat bonuses must be unique supported stats')
  for (const row of plan.growth) {
    if (row.classRef) assertRef(row.classRef, 'Growth class')
    if (row.levels !== null && (!Number.isInteger(row.levels) || row.levels < 0 || row.levels > PC_LEVEL_CAP)) throw new DomainError('INVALID_INPUT', `Growth levels must be a whole number from 0 to ${PC_LEVEL_CAP} or unknown`)
  }
  for (const ref of plan.statuses) assertRef(ref, 'Calculation status')
  if (plan.ability) assertRef(plan.ability, 'Calculation ability')
  if (plan.targetEvasion != null && (!Number.isFinite(plan.targetEvasion) || plan.targetEvasion < 0)) throw new DomainError('INVALID_INPUT', 'Target evasion must be nonnegative or unknown')
  if (plan.model !== undefined && plan.model !== PC_MODEL) throw new DomainError('INVALID_INPUT', 'Unsupported calculation model')
  if (plan.growthMode !== undefined && !['primary', 'manual'].includes(plan.growthMode)) throw new DomainError('INVALID_INPUT', 'Unsupported growth mode')
  if (plan.pcMode !== undefined && !['standard', 'vanilla', 'chaos'].includes(plan.pcMode)) throw new DomainError('INVALID_INPUT', 'Unsupported PC balance mode')
  if (plan.gender !== undefined && !CALCULATION_GENDERS.includes(plan.gender)) throw new DomainError('INVALID_INPUT', 'Unsupported calculation gender')
  if (plan.genderSelection !== undefined && (plan.genderSelection.version !== GENDER_SELECTION_VERSION || !Number.isInteger(plan.genderSelection.id) || plan.genderSelection.id < 0 || plan.genderSelection.id > MAX_GENDER_ID || plan.gender !== undefined)) throw new DomainError('INVALID_INPUT', 'Choose one supported calculation gender selection')
}
