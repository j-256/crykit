import { definitionSourceRecord, type MechanicsDefinition } from './mechanics-facts'
import type { BuildStatEstimate, CalculatedStat, StatRange } from './build-stats'
import { calculateCombat } from './combat-calculations'
import type { CombatValue } from './combat-expression'
import { nativeInteger } from './native-number'
import type { NativeRecord } from './pc-stats'

const NATIVE_STATS = Object.freeze({ STR: 'Str', VIT: 'Vit', DEX: 'Dex', AGI: 'Agi', MND: 'Mnd', SPI: 'Spi', SPD: 'Spd', LUK: 'Lck' })
export const ABILITY_COSTS = ['HP', 'MP', 'AP', 'CT', 'CD'] as const
export interface AbilityEstimate {
  readonly baseAmount: StatRange | null
  readonly costs: Readonly<Record<typeof ABILITY_COSTS[number], number | null>>
  readonly learning: { readonly jp: number; readonly displayedLp: number; readonly requiredWholeLp: number } | null
  readonly notes: readonly string[]
}

export function learningCost(jp: unknown): AbilityEstimate['learning'] {
  return nativeInteger(jp) && jp >= 0 ? { jp, displayedLp: calculateCombat('learningLP', [jp]) as number, requiredWholeLp: calculateCombat('learningWholeLP', [jp]) as number } : null
}

export function estimateAbility(definition: MechanicsDefinition, stats: BuildStatEstimate['stats'], numericRecord: NativeRecord | undefined = definitionSourceRecord(definition)): AbilityEstimate {
  const record = numericRecord
  const notes: string[] = []
  const costs = Object.fromEntries(ABILITY_COSTS.map(cost => [cost, nativeInteger(record?.[`${cost}Cost`]) && (record![`${cost}Cost`] as number) >= 0 ? record![`${cost}Cost`] : null])) as AbilityEstimate['costs']
  const learning = learningCost(record?.JP)
  let baseAmount: StatRange | null = null
  if (record) {
    const coefficients = ['BasePower', 'BasePAtkRate', ...Object.values(NATIVE_STATS).map(stat => `${stat}Rate`)]
    const complete = coefficients.every(key => nativeInteger(record[key])) && ['ScalingPower', 'ScalingPAtkRate'].every(key => record[key] === null || nativeInteger(record[key])) && typeof record.PDefAsPAtk === 'boolean'
    const attackKey = record.PDefAsPAtk ? 'DEF' : 'ATK'
    const relevant = [attackKey, ...Object.keys(NATIVE_STATS)] as CalculatedStat[]
    if (complete && relevant.every(key => stats[key].value?.low === stats[key].value?.high && nativeInteger(stats[key].value?.low))) {
      const user = { Stats: Object.fromEntries(Object.entries(NATIVE_STATS).map(([key, name]) => [name, stats[key as CalculatedStat].value!.low])) }
      try {
        const value = calculateCombat('abilityPower', [stats[attackKey].value!.low, record as CombatValue, 0, user]) as number
        baseAmount = { low: value, high: value }
      } catch { notes.push('Native coefficient arithmetic could not be evaluated with these inputs') }
    }
    if (Array.isArray(record.AbilityMods) && record.AbilityMods.length) notes.push('Ability modifiers need battle context and are excluded from this coefficient stage')
  }
  if (!baseAmount) notes.push('Native coefficient power needs a supported numeric ability record and complete integer loadout stats')
  return { baseAmount, costs, learning, notes }
}
