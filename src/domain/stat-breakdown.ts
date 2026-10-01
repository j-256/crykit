import { calculateBuildStats, type StatRange } from './build-stats'
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

export function calculateStatBreakdown(content: BuildRevisionContent, slots: readonly SlotDefinition[], resolve: DefinitionResolver, identity: (ref: EntityRef) => string = entityDefinitionKey, unknownInputs: readonly string[] = [], unknownSecondaryClass = false, gameRules?: GameRuleResolution): Readonly<Record<GrowthStat, StatBreakdown>> {
  const plan = content.calculation
  const initialContent = { ...content, calculation: plan ? { ...plan, level: 1, growth: [{ classRef: content.primaryClass, levels: 1 }], bonuses: [], gender: undefined } : undefined }
  if (plan?.model) {
    const current = calculatePCStats(content, slots, resolve, unknownInputs, unknownSecondaryClass, gameRules)
    const initial = calculatePCStats(initialContent, slots, resolve, [], false, gameRules)
    const total = selectedPCStats(current, plan.gender)
    return Object.fromEntries(STAT_KEYS.map(stat => [stat, {
      base: exact(initial.base[stat]),
      equipment: difference(exact(current.neutral[stat]), exact(current.base[stat])),
      level: difference(exact(current.base[stat]), exact(initial.base[stat])),
      gender: difference(exact(total[stat]), exact(current.neutral[stat])),
      total: exact(total[stat]),
    }])) as Record<GrowthStat, StatBreakdown>
  }
  const current = calculateBuildStats(content, slots, resolve, identity, gameRules)
  const neutral = calculateBuildStats({ ...content, calculation: plan ? { ...plan, bonuses: [], gender: undefined } : undefined }, slots, resolve, identity, gameRules)
  const initial = calculateBuildStats(initialContent, slots, resolve, identity, gameRules)
  const unknownLoadout = unknownInputs.length > 0 || unknownSecondaryClass
  return Object.fromEntries(STAT_KEYS.map(stat => [stat, {
    base: initial.stats[stat].base,
    equipment: unknownLoadout ? null : difference(neutral.stats[stat].value, neutral.stats[stat].base),
    level: difference(neutral.stats[stat].base, initial.stats[stat].base),
    gender: unknownLoadout ? null : difference(current.stats[stat].value, neutral.stats[stat].value),
    total: unknownLoadout ? null : current.stats[stat].value,
  }])) as Record<GrowthStat, StatBreakdown>
}
