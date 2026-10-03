import type { StatRange } from './build-stats'
import { STAT_KEYS, type GrowthStat } from './crystal-edit'
import { calculatePCStats, selectedPCStats } from './pc-stats'
import type { DefinitionResolver } from './build-mechanics'
import type { BuildRevisionContent, EntityRef, SlotDefinition } from './types'
import { entityDefinitionKey } from './core'
import type { GameRuleResolution } from './game-rules'

export const STAT_BREAKDOWN_COLUMNS = ['base', 'equipment', 'level', 'gender', 'total'] as const
export type StatBreakdown = Readonly<Record<typeof STAT_BREAKDOWN_COLUMNS[number], StatRange | null>>

const exact = (value: number | null | undefined): StatRange | null => value == null ? null : { low: value, high: value }
const difference = (value: StatRange | null, baseline: StatRange | null): StatRange | null => {
  if (!value || !baseline) return null
  const low = value.low - baseline.low
  const high = value.high - baseline.high
  return { low: Math.min(low, high), high: Math.max(low, high) }
}

export function calculateStatBreakdown(content: BuildRevisionContent, slots: readonly SlotDefinition[], resolve: DefinitionResolver, _identity: (ref: EntityRef) => string = entityDefinitionKey, unknownInputs: readonly string[] = [], unknownSecondaryClass = false, gameRules?: GameRuleResolution): Readonly<Record<GrowthStat, StatBreakdown>> {
  return calculateStatBreakdownResult(content, slots, resolve, _identity, unknownInputs, unknownSecondaryClass, gameRules).stats
}

export function calculateStatBreakdownResult(content: BuildRevisionContent, slots: readonly SlotDefinition[], resolve: DefinitionResolver, _identity: (ref: EntityRef) => string = entityDefinitionKey, unknownInputs: readonly string[] = [], unknownSecondaryClass = false, gameRules?: GameRuleResolution): { readonly stats: Readonly<Record<GrowthStat, StatBreakdown>>; readonly issues: readonly string[] } {
  const plan = content.calculation
  const initialContent = { ...content, calculation: plan ? { ...plan, level: 1, growth: [{ classRef: content.primaryClass, levels: 1 }], bonuses: [], gender: undefined } : undefined }
  const current = calculatePCStats(content, slots, resolve, unknownInputs, unknownSecondaryClass, gameRules)
  const initial = calculatePCStats(initialContent, slots, resolve, [], false, gameRules)
  const total = selectedPCStats(current, plan?.gender)
  const stats = Object.fromEntries(STAT_KEYS.map(stat => [stat, {
    base: exact(initial.base[stat]),
    equipment: difference(exact(current.neutral[stat]), exact(current.base[stat])),
    level: difference(exact(current.base[stat]), exact(initial.base[stat])),
    gender: difference(exact(total[stat]), exact(current.neutral[stat])),
    total: exact(total[stat]),
  }])) as Record<GrowthStat, StatBreakdown>
  return { stats, issues: current.issues }
}
