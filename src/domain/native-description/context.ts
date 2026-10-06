import { nativeRecord, type NativeGameSnapshot, type NativeRecord } from '../native-game'
import type { JsonValue } from '../types'
import { MAX_TEXT_LENGTH, MAX_REFERENCE_DEPTH, PERCENT, type NativeDescription } from './model.ts'
import { nativeDescriptionRecord } from './records.ts'
import { nativeVocabularyText } from './templates.ts'

export function createNativeDescriptionContext(snapshot: NativeGameSnapshot, mode: string, depth: number, describeChild: (family: string, record: NativeRecord, depth: number, isItem: boolean) => NativeDescription) {
  const lines: string[] = []
  const unresolved: string[] = []
  const system = snapshot.databases.system
  const vocabulary = nativeRecord(system) && nativeRecord(system.Vocab) ? system.Vocab : {}
  const general = nativeRecord(vocabulary.General) ? vocabulary.General : {}
  const battle = nativeRecord(system) && nativeRecord(system.BattleConfig) ? system.BattleConfig : {}
  const staticKeys = ['StrWhileUnarmedBonusFlat', 'HealMultiWithPenaltyRate', 'PerfectHitAtChanceOrHigher', 'PDmgIncreasesMaxHPAbsorbRate', 'PDmgIncreasesMaxHPDecayRate', 'PerfectDodgeAtChanceOrLower', 'TargetSingleWithBonusRate']
  const specials: Record<string, string> = Object.fromEntries(staticKeys.flatMap(key => typeof battle[key] === 'number' && Number.isSafeInteger(battle[key]) ? [[key, String(battle[key])]] : []))
  if (typeof battle.DualWieldPAtkRate === 'number') specials.DualWieldPAtkPenalty = String(PERCENT - battle.DualWieldPAtkRate)
  if (typeof battle.TwoHandedPAtkFlat === 'number' && typeof battle.TwoHandedPAtkRate === 'number') specials.TwoHandedPAtkBonus = [battle.TwoHandedPAtkFlat ? String(battle.TwoHandedPAtkFlat) : '', battle.TwoHandedPAtkRate ? `${battle.TwoHandedPAtkRate}%` : ''].filter(Boolean).join(' & ')
  const sourceText = (text: string): string | undefined => {
    // Only reviewed reference and static-setting tokens expand; source text never executes
    if (text.length > MAX_TEXT_LENGTH) return undefined
    let expanded = text.replace(/@([AIEJMS])(\d+)\.(Name|Command)/g, (token, type: string, id: string, property: string) => {
      const family = ({ A: 'ability', I: 'item', E: 'equipment', J: 'job', M: 'monster', S: 'status' } as const)[type as 'A']
      const target = nativeDescriptionRecord(snapshot, family, Number(id), mode)
      const value = target?.[property === 'Command' && type === 'J' ? 'AbilitiesName' : property]
      return typeof value === 'string' ? value : token
    })
    for (const key of Object.keys(specials).sort((left, right) => right.length - left.length)) expanded = expanded.replaceAll(`@X.${key}`, specials[key]!)
    return nativeVocabularyText(expanded, general, false)
  }
  const add = (text: string | undefined, reason?: string) => {
    if (text?.trim()) lines.push(text.trim())
    else if (reason) unresolved.push(reason)
  }
  const vocab = (key: string) => typeof general[key] === 'string' ? nativeVocabularyText(general[key] as string, general, false) : undefined
  const join = (...parts: (string | number | undefined)[]) => parts.some(part => part === undefined) ? undefined : parts.join('')
  const name = (database: string, id: JsonValue | undefined, key = 'Name'): string | undefined => {
    const target = typeof id === 'number' ? nativeDescriptionRecord(snapshot, database, id, mode) : undefined
    return target && typeof target[key] === 'string' ? target[key] as string : undefined
  }
  const enumName = (type: string, id: JsonValue | undefined) => typeof id === 'number' ? snapshot.enums[type]?.[String(id)] : undefined
  const listName = (key: string, id: JsonValue | undefined) => {
    const values = vocabulary[key]
    return Array.isArray(values) && typeof id === 'number' && typeof values[id] === 'string' ? nativeVocabularyText(values[id] as string, general) : undefined
  }
  const child = (database: string, id: JsonValue | undefined, item = false) => {
    const target = typeof id === 'number' ? nativeDescriptionRecord(snapshot, database, id, mode) : undefined
    // Each nested family inherits the depth budget, including cycles through item abilities and statuses
    if (!target || depth >= MAX_REFERENCE_DEPTH) { unresolved.push(`Unresolved ${database} description`); return }
    const result = describeChild(database, target, depth + 1, item)
    // Keep child diagnostics with its lines so a useful fragment cannot conceal incomplete interpretation
    lines.push(...result.lines)
    unresolved.push(...result.unresolved)
  }
  return { snapshot, mode, depth, lines, unresolved, vocabulary, general, sourceText, add, vocab, join, name, enumName, listName, child }
}

export type NativeDescriptionContext = ReturnType<typeof createNativeDescriptionContext>
