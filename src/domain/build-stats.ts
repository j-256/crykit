import { calculationModResolver } from './calculation-mods'
import type { GameRuleResolution } from './game-rules'
import { entityDefinitionKey } from './core'
import { growthRatings, STAT_KEYS } from './crystal-edit'
import { innateEffects, type DefinitionResolver } from './build-mechanics'
import { estimateGrowth } from './growth'
import { definitionSourceRecord, effectText, equipmentFacts, equipmentRole, isWeapon, permissionEffects, type MechanicsDefinition } from './mechanics-facts'
import type { BuildRevisionContent, EntityRef, SlotDefinition, SourceRef } from './types'
import { calculatePCStats, selectedPCStats } from './pc-stats'
import { guideGenderBonuses } from './calculation-plan'
import { calculateFormula, GUIDE_RULES } from './calculation-rules'

export const DERIVED_STATS = ['ATK', 'DEF', 'RES', 'CRIT', 'CRIT_DAMAGE', 'ACC', 'EVA', 'PPEN', 'MPEN', 'TT'] as const
export const CALCULATED_STATS = [...STAT_KEYS, ...DERIVED_STATS] as const
export type CalculatedStat = typeof CALCULATED_STATS[number]
export const STAT_LABELS: Readonly<Record<CalculatedStat, string>> = Object.freeze({ HP: 'Max HP', MP: 'Max MP', STR: 'Strength', VIT: 'Vitality', DEX: 'Dexterity', AGI: 'Agility', MND: 'Mind', SPI: 'Spirit', SPD: 'Speed', LUK: 'Luck', ATK: 'Attack', DEF: 'Defense', RES: 'Resistance', CRIT: 'Crit chance (%)', CRIT_DAMAGE: 'Crit bonus damage (%)', ACC: 'Accuracy', EVA: 'Evasion', PPEN: 'Defense pierce (%)', MPEN: 'Resistance pierce (%)', TT: 'Turn time' })
const STAT_ALIASES: Readonly<Record<string, CalculatedStat>> = Object.freeze({ hp: 'HP', 'max hp': 'HP', mp: 'MP', 'max mp': 'MP', str: 'STR', strength: 'STR', vit: 'VIT', vitality: 'VIT', dex: 'DEX', dexterity: 'DEX', agi: 'AGI', agility: 'AGI', mnd: 'MND', mind: 'MND', spi: 'SPI', spirit: 'SPI', spd: 'SPD', speed: 'SPD', luk: 'LUK', luck: 'LUK', atk: 'ATK', attack: 'ATK', def: 'DEF', defense: 'DEF', res: 'RES', resistance: 'RES', accuracy: 'ACC', evasion: 'EVA', 'crit chance': 'CRIT', 'crit damage': 'CRIT_DAMAGE', 'def pierce': 'PPEN', 'res pierce': 'MPEN' })
const PERCENT_POINTS = new Set<CalculatedStat>(['CRIT', 'CRIT_DAMAGE', 'PPEN', 'MPEN'])
const STAT_TEXT_FIELDS = ['Stat', 'Stat bonuses', 'Other effects', 'Other', 'Effect']
const DOCUMENTED_DUAL_WIELD_RATE = GUIDE_RULES.dualWieldRate
const TURN_TIME_SPEED_LIMIT = GUIDE_RULES.speedLimit
const normalizeLabel = (label: string) => label.toLowerCase().replaceAll('.', '').replace(/\s+/g, ' ').trim()
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const DIRECT_STAT_MODS = GUIDE_RULES.statModifiers as unknown as Readonly<Record<number, readonly [CalculatedStat, 'flat' | 'percent']>>

export interface StatContribution { readonly stat: CalculatedStat; readonly kind: 'flat' | 'percent'; readonly value: number; readonly label: string; readonly sources: readonly SourceRef[] }
export interface StatRange { readonly low: number; readonly high: number }
export interface StatEstimate { readonly base: StatRange | null; readonly value: StatRange | null; readonly flat: number; readonly percent: number }
export interface BuildStatEstimate {
  readonly stats: Readonly<Record<CalculatedStat, StatEstimate>>
  readonly contributions: readonly StatContribution[]
  readonly excluded: readonly string[]
  readonly issues: readonly string[]
}

function gameStatContributions(definition: MechanicsDefinition, record: Readonly<Record<string, unknown>>): { readonly contributions: readonly StatContribution[]; readonly excluded: readonly string[]; readonly unknownStats: readonly CalculatedStat[] } {
  if (!Array.isArray(record.StatMods)) return { contributions: [], excluded: [], unknownStats: [] }
  const field = definition.fields['Native source record'] ?? definition.fields['Crystal Edit source record']
  const sources = field?.state === 'known' ? field.sources ?? definition.sources : definition.sources
  const contributions = new Map<string, StatContribution>()
  const excluded: string[] = []
  for (const modifier of record.StatMods) {
    if (!modifier || typeof modifier !== 'object' || Array.isArray(modifier) || !('Tag' in modifier) || !('Value1' in modifier) || !Number.isSafeInteger(modifier.Tag) || !finite(modifier.Value1)) {
      excluded.push(`${definition.name}: invalid StatMod was not applied`)
      continue
    }
    const mapped = DIRECT_STAT_MODS[modifier.Tag as number]
    if (!mapped) {
      excluded.push(`${definition.name}: StatMod tag ${String(modifier.Tag)} is listed but not applied to the numeric estimate`)
      continue
    }
    const [stat, kind] = mapped
    const key = `${stat}:${kind}`
    const previous = contributions.get(key)
    contributions.set(key, { stat, kind, value: (previous?.value ?? 0) + modifier.Value1, label: `${definition.name}: StatMod tag ${String(modifier.Tag)}`, sources })
  }
  return { contributions: [...contributions.values()], excluded: [...new Set(excluded)], unknownStats: [] }
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
  const record = definitionSourceRecord(definition)
  if (record && textOverride === undefined) return gameStatContributions(definition, record)
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
  try {
    const values = [fn(range.low), fn(range.high)]
    return values.every(Number.isFinite) ? { low: Math.min(...values), high: Math.max(...values) } : null
  } catch { return null }
}

export function calculateBuildStats(content: BuildRevisionContent, slots: readonly SlotDefinition[], sourceResolve: DefinitionResolver, identity: (ref: EntityRef) => string = entityDefinitionKey, gameRules?: GameRuleResolution): BuildStatEstimate {
  const modScope = calculationModResolver(sourceResolve)
  const resolve = modScope.resolve
  const plan = content.calculation
  if (plan?.model) {
    const result = calculatePCStats(content, slots, sourceResolve, [], false, gameRules)
    return { stats: Object.fromEntries(CALCULATED_STATS.map(stat => {
      const values = plan.gender ? [selectedPCStats(result, plan.gender)[stat]] : [result.neutral[stat], result.male[stat], result.female[stat]]
      const base = result.base[stat]
      return [stat, { base: base == null ? null : { low: base, high: base }, value: values.some(value => value == null) ? null : { low: Math.min(...values as number[]), high: Math.max(...values as number[]) }, flat: 0, percent: 0 }]
    })) as Record<CalculatedStat, StatEstimate>, contributions: [], excluded: result.effects, issues: result.issues }
  }
  const contributions: StatContribution[] = []
  const excluded: string[] = []
  const issues: string[] = []
  const unknownStats = new Set<CalculatedStat>()
  const primary = content.primaryClass ? resolve(content.primaryClass) : undefined
  const innates = innateEffects(content, resolve)
  const effectTexts = innates.map(innate => innate.text)
  for (const innate of innates) {
    const parsed = statContributions(innate.definition, definitionSourceRecord(innate.definition) ? undefined : innate.text)
    contributions.push(...parsed.contributions.map(entry => ({ ...entry, label: `${innate.name}: ${entry.label}` })))
    excluded.push(...parsed.excluded)
    for (const stat of parsed.unknownStats) unknownStats.add(stat)
  }
  if (primary && !innates.length) excluded.push(`${primary.name}: innate passive definitions are unavailable`)
  const allocations = new Set<string>()
  const hands: { type?: string; twoHanded?: boolean; key: string; allocation: string }[] = []
  for (const slot of slots) {
    const selection = content.equipment[slot.id]
    if (!selection) continue
    const key = identity(selection.ref)
    const allocation = `${key}:${selection.allocationId ?? slot.id}`
    const definition = resolve(selection.ref)
    if (!definition) { excluded.push(`${slot.label}: definition is unavailable`); continue }
    if (equipmentRole(slot) === 'mainHand' || equipmentRole(slot) === 'offHand') hands.push({ type: equipmentFacts(definition).type, twoHanded: equipmentFacts(definition).twoHanded, key, allocation })
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
    if (!definitionSourceRecord(definition)) effectTexts.push(effectText(definition) ?? '')
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
  const growth = plan ? estimateGrowth(plan.level ?? NaN, growthRatings(primary ?? { fields: {} }), plan.growth.map(row => ({ levels: row.levels ?? NaN, ratings: growthRatings(row.classRef ? resolve(row.classRef) ?? { fields: {} } : { fields: {} }) })), guideGenderBonuses(plan)) : undefined
  if (growth) issues.push(...growth.issues)
  else issues.push('Set a level and allocate growth levels to estimate core stats')
  const stats = {} as Record<CalculatedStat, StatEstimate>
  const apply = (stat: CalculatedStat, base: StatRange | null) => {
    const selected = contributions.filter(entry => entry.stat === stat)
    const flat = selected.filter(entry => entry.kind === 'flat').reduce((sum, entry) => sum + entry.value, 0)
    const percent = selected.filter(entry => entry.kind === 'percent').reduce((sum, entry) => sum + entry.value, 0)
    let value: StatRange | null = null
    if (base && !unknownStats.has(stat)) {
      try {
        const candidates = [base.low, base.high].flatMap(part => [calculateFormula('flatBeforePercent', [part, flat, percent], GUIDE_RULES), calculateFormula('flatAfterPercent', [part, flat, percent], GUIDE_RULES)])
        if (Math.min(...candidates) >= 0) value = { low: Math.min(...candidates), high: Math.max(...candidates) }
      } catch { value = null }
      if (!value) issues.push(`${STAT_LABELS[stat]} falls outside the supported nonnegative stat range`)
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
    if (hands.every(entry => entry.twoHanded === false) && effectTexts.some(text => permissionEffects(text).dualWield)) {
      stats.ATK = { ...stats.ATK, value: transform(stats.ATK.value, value => value * DOCUMENTED_DUAL_WIELD_RATE) }
      issues.push('Dual-wield Attack uses the selected description\'s 35% reduction on the combined supported Attack; custom battle settings can change this')
    } else {
      stats.ATK = { ...stats.ATK, value: null }
      excluded.push('Two equipped weapons need an explicit Dual Wield effect and Attack rate')
    }
  } else if (hands.length === 2 && hands[0]!.twoHanded === false && hands[0]!.allocation === hands[1]!.allocation && effectTexts.some(text => permissionEffects(text).twoHanded)) {
    const bonus = effectTexts.flatMap(text => text.split('\n')).map(text => /^Hold a One-Handed weapon with both hands to increase its attack by (\d+)\.?$/i.exec(text)).find(Boolean)
    if (bonus) {
      contributions.push({ stat: 'ATK', kind: 'flat', value: Number(bonus[1]), label: 'Two-Handed bonus from the selected effect description', sources: primary?.sources ?? [] })
      apply('ATK', exact(0))
    }
  }
  apply('CRIT', transform(stats.DEX.value, dex => calculateFormula('critChance', [dex], GUIDE_RULES)))
  apply('CRIT_DAMAGE', transform(stats.DEX.value, dex => calculateFormula('critDamage', [dex], GUIDE_RULES)))
  apply('ACC', stats.AGI.value)
  apply('EVA', stats.AGI.value)
  apply('PPEN', transform(stats.STR.value, str => calculateFormula('penetration', [str], GUIDE_RULES)))
  apply('MPEN', transform(stats.MND.value, mnd => calculateFormula('penetration', [mnd], GUIDE_RULES)))
  const speed = stats.SPD.value
  apply('TT', speed && speed.high <= TURN_TIME_SPEED_LIMIT ? transform(speed, spd => calculateFormula('turnTime', [spd], GUIDE_RULES)) : null)
  if (speed && speed.high > TURN_TIME_SPEED_LIMIT) issues.push(`Turn time above ${TURN_TIME_SPEED_LIMIT} Speed requires a verified cap rule`)
  if (stats.CRIT.value && stats.CRIT.value.high > 100) issues.push('Crit chance exceeds 100%; the game cap is not applied')
  if (modScope.issues.size) {
    issues.push(...modScope.issues)
    for (const stat of CALCULATED_STATS) stats[stat] = { ...stats[stat], value: null }
  }
  return { stats, contributions, excluded: [...new Set(excluded)], issues: [...new Set(issues)] }
}

export function physicalHitChance(accuracy: number, evasion: number): number | null {
  if (!Number.isFinite(accuracy) || !Number.isFinite(evasion) || accuracy < 0 || evasion <= 0) return null
  if (accuracy === 0) return GUIDE_RULES.hitChance.zeroAccuracy
  const ratio = accuracy / evasion
  const band = GUIDE_RULES.hitChance.bands.find(band => 'exact' in band && band.exact !== undefined ? ratio === band.exact : 'lower' in band && band.lower !== undefined && ratio >= band.lower && (!('upper' in band) || band.upper === undefined || ratio < band.upper))
  return band?.chance ?? null
}
