import { entityDefinitionKey } from './core'
import { growthRatings, STAT_KEYS } from './crystal-edit'
import { innateEffects, type DefinitionResolver } from './build-mechanics'
import { estimateGrowth } from './growth'
import { crystalEditRecord, effectText, equipmentFacts, equipmentRole, isWeapon, permissionEffects, type MechanicsDefinition } from './mechanics-facts'
import type { BuildRevisionContent, EntityRef, SlotDefinition, SourceRef } from './types'

export const DERIVED_STATS = ['ATK', 'DEF', 'RES', 'CRIT', 'CRIT_DAMAGE', 'ACC', 'EVA', 'PPEN', 'MPEN', 'TT'] as const
export const CALCULATED_STATS = [...STAT_KEYS, ...DERIVED_STATS] as const
export type CalculatedStat = typeof CALCULATED_STATS[number]
export const STAT_LABELS: Readonly<Record<CalculatedStat, string>> = Object.freeze({ HP: 'Max HP', MP: 'Max MP', STR: 'Strength', VIT: 'Vitality', DEX: 'Dexterity', AGI: 'Agility', MND: 'Mind', SPI: 'Spirit', SPD: 'Speed', LUK: 'Luck', ATK: 'Attack', DEF: 'Defense', RES: 'Resistance', CRIT: 'Crit chance (%)', CRIT_DAMAGE: 'Crit bonus damage (%)', ACC: 'Accuracy', EVA: 'Evasion', PPEN: 'Defense pierce (%)', MPEN: 'Resistance pierce (%)', TT: 'Turn time' })
const STAT_ALIASES: Readonly<Record<string, CalculatedStat>> = Object.freeze({ hp: 'HP', 'max hp': 'HP', mp: 'MP', 'max mp': 'MP', str: 'STR', strength: 'STR', vit: 'VIT', vitality: 'VIT', dex: 'DEX', dexterity: 'DEX', agi: 'AGI', agility: 'AGI', mnd: 'MND', mind: 'MND', spi: 'SPI', spirit: 'SPI', spd: 'SPD', speed: 'SPD', luk: 'LUK', luck: 'LUK', atk: 'ATK', attack: 'ATK', def: 'DEF', defense: 'DEF', res: 'RES', resistance: 'RES', accuracy: 'ACC', evasion: 'EVA', 'crit chance': 'CRIT', 'crit damage': 'CRIT_DAMAGE', 'def pierce': 'PPEN', 'res pierce': 'MPEN' })
const PERCENT_POINTS = new Set<CalculatedStat>(['CRIT', 'CRIT_DAMAGE', 'PPEN', 'MPEN'])
const STAT_TEXT_FIELDS = ['Stat', 'Stat bonuses', 'Other effects', 'Other', 'Effect']
const DOCUMENTED_DUAL_WIELD_RATE = 0.65
const TURN_TIME_SPEED_LIMIT = 600
const normalizeLabel = (label: string) => label.toLowerCase().replaceAll('.', '').replace(/\s+/g, ' ').trim()
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export interface StatContribution { readonly stat: CalculatedStat; readonly kind: 'flat' | 'percent'; readonly value: number; readonly label: string; readonly sources: readonly SourceRef[] }
export interface StatRange { readonly low: number; readonly high: number }
export interface StatEstimate { readonly base: StatRange | null; readonly value: StatRange | null; readonly flat: number; readonly percent: number }
export interface BuildStatEstimate {
  readonly stats: Readonly<Record<CalculatedStat, StatEstimate>>
  readonly contributions: readonly StatContribution[]
  readonly excluded: readonly string[]
  readonly issues: readonly string[]
}

function parseStatLine(line: string): { stat: CalculatedStat; kind: 'flat' | 'percent'; value: number } | undefined {
  const match = /^([A-Za-z. ]+?)\s*:?\s*([+-]?\d+(?:\.\d+)?)\s*(%)?\.?$/.exec(line.trim())
  const stat = match ? STAT_ALIASES[normalizeLabel(match[1]!)] : undefined
  if (!match || !stat) return undefined
  return { stat, kind: match[3] && !PERCENT_POINTS.has(stat) ? 'percent' : 'flat', value: Number(match[2]) }
}

export function statContributions(definition: MechanicsDefinition, textOverride?: string): { readonly contributions: readonly StatContribution[]; readonly excluded: readonly string[]; readonly unknownStats: readonly CalculatedStat[] } {
  const contributions: StatContribution[] = []
  const excluded: string[] = []
  const unknownStats = new Set<CalculatedStat>()
  const record = crystalEditRecord(definition)
  if (record && textOverride === undefined) {
    if (!Array.isArray(record.StatMods) || record.StatMods.length) excluded.push(`${definition.name}: numeric Crystal Edit modifier tags are not mapped`)
    return { contributions, excluded, unknownStats: [] }
  }
  const candidates = new Map<string, StatContribution[]>()
  const add = (value: ReturnType<typeof parseStatLine>, label: string, sources: readonly SourceRef[]) => {
    if (!value) return
    const key = `${value.stat}:${value.kind}`
    candidates.set(key, [...(candidates.get(key) ?? []), { ...value, label: `${definition.name}: ${label}`, sources }])
  }
  const parseLines = (text: string, field: string, sources: readonly SourceRef[]) => {
    for (const line of text.split('\n').map(line => line.trim()).filter(Boolean)) {
      const parsed = parseStatLine(line)
      if (parsed) add(parsed, `${field} (${line})`, sources)
      else if (!['-', 'None'].includes(line) && !/^[12]-Handed$/i.test(line) && !/\b(?:only one can be equipped|one only)\b/i.test(line) && !(permissionEffects(line).equipment.length || permissionEffects(line).dualWield || permissionEffects(line).twoHanded)) excluded.push(`${definition.name}: ${line}`)
    }
  }
  if (textOverride !== undefined) parseLines(textOverride, 'Innate effect', definition.sources)
  else if (definition.kind === 'item') {
    for (const [field, knowledge] of Object.entries(definition.fields)) {
      const stat = STAT_ALIASES[normalizeLabel(field)]
      const relevant = stat || STAT_TEXT_FIELDS.includes(field) || field.includes('/') && field.split('/').some(part => STAT_ALIASES[normalizeLabel(part)])
      if (!relevant) continue
      if (knowledge.state !== 'known') {
        if (knowledge.state !== 'notApplicable') excluded.push(`${definition.name}: ${field} is ${knowledge.state}`)
        if (knowledge.state === 'conflicting') {
          if (stat) unknownStats.add(stat)
          for (const claim of knowledge.claims) if (typeof claim.value === 'string') for (const line of claim.value.split('\n')) {
            const parsed = parseStatLine(line)
            if (parsed) unknownStats.add(parsed.stat)
          }
        }
        continue
      }
      if (stat && finite(knowledge.value)) add({ stat, kind: 'flat', value: knowledge.value }, field, knowledge.sources ?? definition.sources)
      else if (stat && typeof knowledge.value === 'string') parseLines(`${field}: ${knowledge.value}`, field, knowledge.sources ?? definition.sources)
      else if (typeof knowledge.value === 'string') parseLines(knowledge.value, field, knowledge.sources ?? definition.sources)
    }
  } else {
    const text = effectText(definition)
    if (text !== undefined) parseLines(text, 'Effect', definition.sources)
    else excluded.push(`${definition.name}: effect description is unavailable`)
  }
  for (const entries of candidates.values()) {
    const values = new Set(entries.map(entry => entry.value))
    if (values.size === 1 && !unknownStats.has(entries[0]!.stat)) contributions.push(entries[0]!)
    else if (values.size > 1) {
      unknownStats.add(entries[0]!.stat)
      excluded.push(`${definition.name}: conflicting ${STAT_LABELS[entries[0]!.stat]} contributions (${[...values].join(', ')})`)
    }
  }
  return { contributions: contributions.filter(entry => !unknownStats.has(entry.stat)), excluded: [...new Set(excluded)], unknownStats: [...unknownStats] }
}

const exact = (value: number): StatRange => ({ low: value, high: value })
function transform(range: StatRange | null, fn: (value: number) => number): StatRange | null {
  if (!range) return null
  const values = [fn(range.low), fn(range.high)]
  return values.every(Number.isFinite) ? { low: Math.min(...values), high: Math.max(...values) } : null
}

export function calculateBuildStats(content: BuildRevisionContent, slots: readonly SlotDefinition[], resolve: DefinitionResolver, identity: (ref: EntityRef) => string = entityDefinitionKey): BuildStatEstimate {
  const contributions: StatContribution[] = []
  const excluded: string[] = []
  const issues: string[] = []
  const unknownStats = new Set<CalculatedStat>()
  const primary = content.primaryClass ? resolve(content.primaryClass) : undefined
  const innates = innateEffects(content, resolve)
  const effectTexts = innates.map(innate => innate.text)
  for (const innate of innates) {
    const parsed = statContributions(innate.definition, crystalEditRecord(innate.definition) ? undefined : innate.text)
    contributions.push(...parsed.contributions.map(entry => ({ ...entry, label: `${innate.name}: ${entry.label}` })))
    excluded.push(...parsed.excluded)
    for (const stat of parsed.unknownStats) unknownStats.add(stat)
  }
  if (primary && !innates.length) excluded.push(`${primary.name}: innate passive definitions are unavailable`)
  const allocations = new Set<string>()
  const hands: { type?: string; hands?: number; key: string; allocation: string }[] = []
  for (const slot of slots) {
    const selection = content.equipment[slot.id]
    if (!selection) continue
    const key = identity(selection.ref)
    const allocation = `${key}:${selection.allocationId ?? slot.id}`
    const definition = resolve(selection.ref)
    if (!definition) { excluded.push(`${slot.label}: definition is unavailable`); continue }
    if (equipmentRole(slot) === 'mainHand' || equipmentRole(slot) === 'offHand') hands.push({ type: equipmentFacts(definition).type, hands: equipmentFacts(definition).hands, key, allocation })
    if (allocations.has(allocation)) continue
    allocations.add(allocation)
    const parsed = statContributions(definition)
    contributions.push(...parsed.contributions)
    excluded.push(...parsed.excluded)
    for (const stat of parsed.unknownStats) unknownStats.add(stat)
  }
  for (const [index, selection] of content.passives.entries()) {
    const definition = resolve(selection.ref)
    const key = identity(selection.ref)
    if (allocations.has(`passive:${key}`)) continue
    allocations.add(`passive:${key}`)
    if (!definition) { excluded.push(`Equipped passive ${index + 1}: definition is unavailable`); continue }
    const parsed = statContributions(definition)
    if (!crystalEditRecord(definition)) effectTexts.push(effectText(definition) ?? '')
    contributions.push(...parsed.contributions)
    excluded.push(...parsed.excluded)
    for (const stat of parsed.unknownStats) unknownStats.add(stat)
  }
  const statuses = new Set<string>()
  for (const ref of content.calculation?.statuses ?? []) {
    const key = identity(ref)
    if (statuses.has(key)) continue
    statuses.add(key)
    const definition = resolve(ref)
    if (!definition || definition.kind !== 'status') { excluded.push('A selected status definition is unavailable or is not a status'); continue }
    const parsed = statContributions(definition)
    contributions.push(...parsed.contributions)
    excluded.push(...parsed.excluded)
    for (const stat of parsed.unknownStats) unknownStats.add(stat)
  }
  const plan = content.calculation
  const growth = plan ? estimateGrowth(plan.level ?? NaN, growthRatings(primary ?? { fields: {} }), plan.growth.map(row => ({ levels: row.levels ?? NaN, ratings: growthRatings(row.classRef ? resolve(row.classRef) ?? { fields: {} } : { fields: {} }) })), plan.bonuses) : undefined
  if (growth) issues.push(...growth.issues)
  else issues.push('Set a level and allocate growth levels to estimate core stats')
  const stats = {} as Record<CalculatedStat, StatEstimate>
  const apply = (stat: CalculatedStat, base: StatRange | null) => {
    const selected = contributions.filter(entry => entry.stat === stat)
    const flat = selected.filter(entry => entry.kind === 'flat').reduce((sum, entry) => sum + entry.value, 0)
    const percent = selected.filter(entry => entry.kind === 'percent').reduce((sum, entry) => sum + entry.value, 0)
    let value: StatRange | null = null
    if (base && !unknownStats.has(stat)) {
      const rate = 1 + percent / 100
      const candidates = [base.low, base.high].flatMap(part => [(part + flat) * rate, part * rate + flat])
      if (candidates.every(Number.isFinite) && Math.min(...candidates) >= 0) value = { low: Math.min(...candidates), high: Math.max(...candidates) }
      else issues.push(`${STAT_LABELS[stat]} falls outside the supported nonnegative stat range`)
      if (flat && percent) issues.push(`${STAT_LABELS[stat]} shows both flat-before-percent and flat-after-percent estimates; stacking order is unspecified`)
    }
    stats[stat] = { base, value, flat, percent }
  }
  for (const stat of STAT_KEYS) apply(stat, growth?.stats[stat].value === null || growth?.stats[stat].value === undefined ? null : exact(growth.stats[stat].value))
  for (const stat of ['ATK', 'DEF', 'RES'] as const) apply(stat, exact(0))
  const distinctWeapons = new Set(hands.filter(entry => entry.type && isWeapon(entry.type)).map(entry => entry.allocation))
  if (distinctWeapons.size === 0) {
    stats.ATK = { ...stats.ATK, base: null, value: null }
    excluded.push('Unarmed Attack and its special bonuses need the project battle settings')
  } else if (distinctWeapons.size > 1) {
    if (hands.every(entry => entry.hands === 1) && effectTexts.some(text => permissionEffects(text).dualWield)) {
      stats.ATK = { ...stats.ATK, value: transform(stats.ATK.value, value => value * DOCUMENTED_DUAL_WIELD_RATE) }
      issues.push('Dual-wield Attack uses the selected description\'s 35% reduction on the combined supported Attack; custom battle settings can change this')
    } else {
      stats.ATK = { ...stats.ATK, value: null }
      excluded.push('Two equipped weapons need an explicit Dual Wield effect and Attack rate')
    }
  } else if (hands.length === 2 && hands[0]!.hands === 1 && hands[0]!.allocation === hands[1]!.allocation && effectTexts.some(text => permissionEffects(text).twoHanded)) {
    const bonus = effectTexts.flatMap(text => text.split('\n')).map(text => /^Hold a One-Handed weapon with both hands to increase its attack by (\d+)\.?$/i.exec(text)).find(Boolean)
    if (bonus) {
      contributions.push({ stat: 'ATK', kind: 'flat', value: Number(bonus[1]), label: 'Two-Handed bonus from the selected effect description', sources: primary?.sources ?? [] })
      apply('ATK', exact(0))
    }
  }
  apply('CRIT', transform(stats.DEX.value, dex => 100 * dex / (dex + 250)))
  apply('CRIT_DAMAGE', transform(stats.DEX.value, dex => 25 + (dex / 15) ** 1.35))
  apply('ACC', stats.AGI.value)
  apply('EVA', stats.AGI.value)
  apply('PPEN', transform(stats.STR.value, str => 100 * str / (str + 300)))
  apply('MPEN', transform(stats.MND.value, mnd => 100 * mnd / (mnd + 300)))
  const speed = stats.SPD.value
  apply('TT', speed && speed.high <= TURN_TIME_SPEED_LIMIT ? transform(speed, spd => 34 + (0.0175 * (spd - TURN_TIME_SPEED_LIMIT)) ** 2) : null)
  if (speed && speed.high > TURN_TIME_SPEED_LIMIT) issues.push(`Turn time above ${TURN_TIME_SPEED_LIMIT} Speed requires a verified cap rule`)
  if (stats.CRIT.value && stats.CRIT.value.high > 100) issues.push('Crit chance exceeds 100%; the game cap is not applied')
  return { stats, contributions, excluded: [...new Set(excluded)], issues: [...new Set(issues)] }
}

export function physicalHitChance(accuracy: number, evasion: number): number | null {
  if (!Number.isFinite(accuracy) || !Number.isFinite(evasion) || accuracy < 0 || evasion <= 0) return null
  if (accuracy === 0) return 0
  const ratio = accuracy / evasion
  if (ratio >= 1.5) return 100
  if (ratio >= 1.25) return 98
  if (ratio === 1) return 95
  if (ratio > 1 || ratio < 0.25) return null
  if (ratio >= 0.875) return 90
  if (ratio >= 0.75) return 80
  if (ratio >= 0.5) return 50
  return 20
}
