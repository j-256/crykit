import { definitionSourceRecord, knownField, type MechanicsDefinition } from './mechanics-facts'
import type { BuildStatEstimate, CalculatedStat, StatRange } from './build-stats'

const JP_PER_LP = 100
const COEFFICIENT_STATS: Readonly<Record<string, CalculatedStat>> = Object.freeze({ Hp: 'HP', Mp: 'MP', Atk: 'ATK', Def: 'DEF', Res: 'RES', Str: 'STR', Vit: 'VIT', Dex: 'DEX', Agi: 'AGI', Mnd: 'MND', Spi: 'SPI', Spd: 'SPD', Luk: 'LUK' })
const NATIVE_RATES = Object.freeze({ STR: 'StrRate', VIT: 'VitRate', DEX: 'DexRate', AGI: 'AgiRate', MND: 'MndRate', SPI: 'SpiRate', SPD: 'SpdRate', LUK: 'LckRate' })
const COEFFICIENT_FACTOR = '(?:\\d+(?:\\.\\d+)?(?: (?:Hp|Mp|Atk|Def|Res|Str|Vit|Dex|Agi|Mnd|Spi|Spd|Luk))?|(?:Hp|Mp|Atk|Def|Res|Str|Vit|Dex|Agi|Mnd|Spi|Spd|Luk))'
const COEFFICIENT_TERM = new RegExp(`^${COEFFICIENT_FACTOR}(?: x ${COEFFICIENT_FACTOR})*$`)
export const ABILITY_COSTS = ['HP', 'MP', 'AP', 'CT', 'CD'] as const
export interface AbilityEstimate {
  readonly formula?: string
  readonly baseAmount: StatRange | null
  readonly costs: Readonly<Record<typeof ABILITY_COSTS[number], number | null>>
  readonly learning: { readonly jp: number; readonly displayedLp: number; readonly requiredWholeLp: number } | null
  readonly notes: readonly string[]
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function documentedCoefficients(text: string, stats: BuildStatEstimate['stats']): StatRange | null {
  if (text.length > 500) return null
  const sums: StatRange[] = []
  for (const term of text.split(/\s+\+\s+/)) {
    if (!COEFFICIENT_TERM.test(term.trim())) return null
    let low = 1
    let high = 1
    const tokens = term.trim().split(/\s+/)
    if (!tokens.length) return null
    let factors = 0
    for (const token of tokens) {
      if (token === 'x') continue
      if (/^\d+(?:\.\d+)?$/.test(token)) { low *= Number(token); high *= Number(token); factors += 1; continue }
      const stat = COEFFICIENT_STATS[token]
      const value = stat ? stats[stat].value : undefined
      if (!value) return null
      low *= value.low
      high *= value.high
      factors += 1
    }
    if (!factors || !Number.isFinite(low) || !Number.isFinite(high)) return null
    sums.push({ low, high })
  }
  return { low: sums.reduce((sum, term) => sum + term.low, 0), high: sums.reduce((sum, term) => sum + term.high, 0) }
}

export function estimateAbility(definition: MechanicsDefinition, stats: BuildStatEstimate['stats']): AbilityEstimate {
  const record = definitionSourceRecord(definition)
  const notes: string[] = []
  const costs = Object.fromEntries(ABILITY_COSTS.map(cost => {
    const direct = record ? record[`${cost}Cost`] : knownField(definition, cost === 'CT' || cost === 'CD' ? cost : `${cost} cost`)
    const text = knownField(definition, 'Cost')
    const match = !record && typeof text === 'string' ? new RegExp(`(?:^|\\n)(\\d+(?:\\.\\d+)?)(%?) ${cost}(?:$|\\n)`).exec(text) : null
    const value = finite(direct) && direct >= 0 ? direct : match ? Number(match[1]) : null
    return [cost, value]
  })) as unknown as AbilityEstimate['costs']
  const jp = record?.JP
  const learning = finite(jp) && jp >= 0 ? { jp, displayedLp: Math.floor(jp / JP_PER_LP), requiredWholeLp: Math.ceil(jp / JP_PER_LP) } : null
  if (learning && learning.displayedLp !== learning.requiredWholeLp) notes.push('The displayed LP cost rounds down; unlocking requires more whole LP than shown')
  let baseAmount: StatRange | null = null
  let formula: string | undefined
  if (record) {
    const base = record.BasePower
    const attackRate = record.BasePAtkRate
    const scaling = record.ScalingPower === null ? base : record.ScalingPower
    const scalingAttack = record.ScalingPAtkRate === null ? attackRate : record.ScalingPAtkRate
    if ([base, attackRate, scaling, scalingAttack, ...Object.values(NATIVE_RATES).map(key => record[key])].every(finite)) {
      const attack = stats.ATK.value
      const rates = Object.entries(NATIVE_RATES).map(([stat, field]) => ({ value: stats[stat as CalculatedStat].value, rate: record[field] as number }))
      if (((attackRate === 0 && scalingAttack === 0) || attack) && rates.every(entry => entry.rate === 0 || entry.value)) {
        const endpoints = [0, 1].map(end => {
          const atk = attack ? end ? attack.high : attack.low : 0
          const scaledStats = rates.reduce((sum, entry) => sum + (entry.value ? end ? entry.value.high : entry.value.low : 0) * entry.rate / 100, 0)
          return (base as number) + atk * (attackRate as number) / 100 + ((scaling as number) + atk * (scalingAttack as number) / 100) * scaledStats / 100
        })
        if (endpoints.every(Number.isFinite) && (attackRate as number) >= 0 && (scalingAttack as number) >= 0 && (scaling as number) >= 0 && rates.every(entry => entry.rate >= 0)) baseAmount = { low: Math.min(...endpoints), high: Math.max(...endpoints) }
      }
      formula = 'Base power + Attack contribution + scaled core-stat contribution'
    }
    if (Array.isArray(record.AbilityMods) && record.AbilityMods.length) notes.push('Ability modifiers are retained in the export but are outside this base-amount estimate')
    notes.push('Native weapon requirements, damage kind, targeting, and statuses remain available in the source record')
  } else {
    const description = knownField(definition, 'Description')
    if (typeof description === 'string') {
      const line = description.split('\n').find(line => /^(Damage|Recovery): /.test(line))
      formula = line?.replace(/^(Damage|Recovery): /, '')
      if (formula) baseAmount = documentedCoefficients(formula, stats)
      notes.push(...description.split('\n').filter(line => line.trim() && line !== `Damage: ${formula}` && line !== `Recovery: ${formula}`))
    }
  }
  if (!baseAmount) notes.push('The base amount needs missing stats or a formula outside the supported coefficient patterns')
  return { formula, baseAmount, costs, learning, notes }
}
