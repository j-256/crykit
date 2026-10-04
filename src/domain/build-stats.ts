import type { GameRuleResolution } from './game-rules'
import { entityDefinitionKey } from './core'
import type { DefinitionResolver } from './build-mechanics'
import { STAT_KEYS } from './crystal-edit'
import type { BuildRevisionContent, EntityRef, SlotDefinition } from './types'
import { calculatePCStats, selectedPCStats } from './pc-stats'
import { calculateCombat } from './combat-calculations'
import { nativeInteger } from './native-number'

export const DERIVED_STATS = ['ATK', 'DEF', 'RES', 'CRIT', 'CRIT_DAMAGE', 'ACC', 'EVA', 'PPEN', 'MPEN', 'TT'] as const
export const CALCULATED_STATS = [...STAT_KEYS, ...DERIVED_STATS] as const
export type CalculatedStat = typeof CALCULATED_STATS[number]
export const STAT_LABELS: Readonly<Record<CalculatedStat, string>> = Object.freeze({ HP: 'Max HP', MP: 'Max MP', STR: 'Strength', VIT: 'Vitality', DEX: 'Dexterity', AGI: 'Agility', MND: 'Mind', SPI: 'Spirit', SPD: 'Speed', LUK: 'Luck', ATK: 'Attack', DEF: 'Defense', RES: 'Resistance', CRIT: 'Crit chance (%)', CRIT_DAMAGE: 'Crit bonus damage (%)', ACC: 'Accuracy', EVA: 'Evasion', PPEN: 'Defense pierce (%)', MPEN: 'Resistance pierce (%)', TT: 'Turn time' })
export interface StatRange { readonly low: number; readonly high: number }
export interface StatEstimate { readonly base: StatRange | null; readonly value: StatRange | null }
export interface BuildStatEstimate {
  readonly stats: Readonly<Record<CalculatedStat, StatEstimate>>
  readonly excluded: readonly string[]
  readonly issues: readonly string[]
}

export function calculateBuildStats(content: BuildRevisionContent, slots: readonly SlotDefinition[], resolve: DefinitionResolver, _identity: (ref: EntityRef) => string = entityDefinitionKey, gameRules?: GameRuleResolution, unknownInputs: readonly string[] = [], unknownSecondaryClass = false): BuildStatEstimate {
  const plan = content.calculation
  const result = calculatePCStats(content, slots, resolve, unknownInputs, unknownSecondaryClass, gameRules)
  return { stats: Object.fromEntries(CALCULATED_STATS.map(stat => {
    const value = selectedPCStats(result, plan?.gender, plan?.genderSelection)[stat]
    const base = result.base[stat]
    return [stat, { base: base == null ? null : { low: base, high: base }, value: value == null ? null : { low: value, high: value } }]
  })) as Record<CalculatedStat, StatEstimate>, excluded: result.effects, issues: result.issues }
}

export function physicalHitChance(accuracy: number, evasion: number): number | null {
  if (!nativeInteger(accuracy) || !nativeInteger(evasion) || accuracy < 0 || evasion < 0) return null
  return calculateCombat('physicalHitCurve', [accuracy, evasion]) as number
}
