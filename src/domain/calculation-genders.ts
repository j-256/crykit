import { NATIVE_DATA, PC_RULES } from './calculation-rules'
import { STAT_KEYS, type GrowthStat } from './crystal-edit'
import type { BuildCalculationPlan } from './types'

export const GENDER_SELECTION_VERSION = 1
export const MAX_GENDER_ID = 0x7fffffff
const EXTRA_GENDER_PREFIX = 'id:'
export interface GenderDefinition {
  readonly id: number
  readonly name: string
  readonly boosts: Readonly<Record<GrowthStat, boolean | null>>
  readonly source: string
  readonly sourceKind: 'native' | 'mod'
  readonly nameSource?: string
  readonly issues: readonly string[]
}

export function genderDefinition(record: Readonly<Record<string, unknown>>, source: string, sourceKind: GenderDefinition['sourceKind']): GenderDefinition {
  const missing = STAT_KEYS.filter(stat => typeof record[PC_RULES.stats[stat]!.gender!] !== 'boolean')
  return {
    id: record.ID as number,
    name: typeof record.Name === 'string' ? record.Name : `Gender #${record.ID}`,
    boosts: Object.fromEntries(STAT_KEYS.map(stat => [stat, typeof record[PC_RULES.stats[stat]!.gender!] === 'boolean' ? record[PC_RULES.stats[stat]!.gender!] : null])) as GenderDefinition['boosts'],
    source,
    sourceKind,
    issues: missing.length ? [`${source}: gender ${record.ID} has missing or invalid bonus flags (${missing.join(', ')}).`] : [],
  }
}

export function nativeGenderDefinitions(mode = 'standard'): readonly GenderDefinition[] {
  const patch = NATIVE_DATA.patches.find(patch => patch.name.toLowerCase() === mode)?.records.gender as readonly Readonly<Record<string, unknown>>[] | undefined
  return NATIVE_DATA.records.gender.map(record => genderDefinition({ ...record, ...patch?.find(value => value.ID === record.ID) }, `PC 1.6.9 ${mode} game data`, 'native'))
}

export function calculationGenderId(plan: Pick<BuildCalculationPlan, 'gender' | 'genderSelection'> | undefined): number | undefined {
  return plan?.genderSelection?.id ?? (plan?.gender ? PC_RULES.genders[plan.gender] : undefined)
}

export function calculationGenderLabel(plan: Pick<BuildCalculationPlan, 'gender' | 'genderSelection'> | undefined, genders = nativeGenderDefinitions()): string {
  const id = calculationGenderId(plan)
  return id === undefined ? 'Not specified (no bonus preview)' : genders.find(gender => gender.id === id)?.name ?? `Unavailable gender #${id}`
}

export function calculationGenderValue(plan: Pick<BuildCalculationPlan, 'gender' | 'genderSelection'> | undefined): string {
  return plan?.genderSelection ? genderOptionValue(plan.genderSelection.id) : plan?.gender ?? ''
}

export function genderOptionValue(id: number): string {
  return id === PC_RULES.genders.male ? 'male' : id === PC_RULES.genders.female ? 'female' : `${EXTRA_GENDER_PREFIX}${id}`
}

export function selectCalculationGender<Plan extends Pick<BuildCalculationPlan, 'gender' | 'genderSelection'>>(plan: Plan, value: string): Plan {
  return { ...plan, gender: value === 'male' || value === 'female' ? value : undefined, genderSelection: value.startsWith(EXTRA_GENDER_PREFIX) ? { version: GENDER_SELECTION_VERSION, id: Number(value.slice(EXTRA_GENDER_PREFIX.length)) } : undefined }
}
