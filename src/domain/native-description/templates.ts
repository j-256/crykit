import type { NativeRecord } from '../native-game'
import { MAX_TEXT_LENGTH, PERCENT } from './model.ts'

const MAX_VOCAB_DEPTH = 8
const VOCAB_ALIASES: Readonly<Record<string, string>> = Object.freeze({"Sep": "Colon_Sep", "HP": "HP", "MP": "MP", "AP": "AP", "TT_SHORT": "TT_SHORT", "TT": "TT", "CT_SHORT": "CT_SHORT", "CT": "CT", "Exp": "Exp", "JP": "JP", "Jxp": "JXP", "Jobs": "Jobs", "Job": "Job", "SubJob": "SubJob", "PP": "PP", "Atlas": "Atlas", "Threat": "Threat", "BottomThreat": "BottomThreat", "TopThreat": "TopThreat", "bottomThreat": "bottomThreat", "topThreat": "topThreat", "HomePoint": "HomePoint", "Crystal": "Crystal", "Currency": "Currency", "Sequoia": "Sequoia", "Flame": "Flame", "GameMaster": "GameMaster", "Banning": "Banning", "Banned": "Banned", "Bans": "Bans", "Ban": "Ban", "more": "FORMAT_m_more", "less": "FORMAT_m_less", "MaxHP": "MaxHP", "MaxMP": "MaxMP", "MaxAP": "MaxAP", "STR": "STR", "VIT": "VIT", "DEX": "DEX", "AGI": "AGI", "MND": "MND", "SPI": "SPI", "SPD": "SPD", "LCK": "LCK", "PAtk": "PAtk", "PDef": "PDef", "MDef": "MDef", "PCritChance": "PCritChance", "PCritDmg": "PCritDmg", "PAcc": "PAcc", "PEva": "PEva", "PPen": "PPen", "MPen": "MPen", "Variance": "PVarRate", "Buff": "Buff", "Debuff": "Debuff", "Consumables": "Consumables", "Tools": "Tools", "Artifacts": "Artifacts"})
const VOCAB_PATTERN = new RegExp(`@V[.](${Object.keys(VOCAB_ALIASES).sort((left, right) => right.length - left.length).join('|')})`, 'g')

export function nativeVocabularyText(text: string, general: NativeRecord, trim = true): string | undefined {
  // Alias matching prefers longer names; bounded repeated expansion handles nested vocabulary safely
  // Unknown tokens and cycles stay unresolved instead of returning a plausible partial description
  if (text.length > MAX_TEXT_LENGTH) return undefined
  let result = text
  for (let depth = 0; depth < MAX_VOCAB_DEPTH && /@V\./.test(result); depth++) {
    const previous = result
    result = result.replace(VOCAB_PATTERN, (token, key: string) => typeof general[VOCAB_ALIASES[key] ?? key] === 'string' ? general[VOCAB_ALIASES[key] ?? key] as string : token)
    if (result === previous || result.length > MAX_TEXT_LENGTH) return undefined
  }
  return /@\w/.test(result) ? undefined : trim ? result.trim() : result
}

export function formatNativeTemplate(template: string, general: NativeRecord, value1: number, value2 = 0, label?: string, attribute?: string): string | undefined {
  if (!Number.isSafeInteger(value1) || !Number.isSafeInteger(value2) || !template.trim() || template.length > MAX_TEXT_LENGTH) return undefined
  const expanded = nativeVocabularyText(template, general, false)
  if (expanded === undefined) return undefined
  let unsupported = false
  const result = expanded.replace(/\[([^\]]+)\]/g, (token, key: string) => {
    if (key === 'amp') return '&'
    if (key === 'l' || key === 'attr') {
      const value = key === 'l' ? label : attribute
      if (value !== undefined) return value
      unsupported = true
      return token
    }
    const numeric = /^([vr])([12])([sa~]?)$/.exec(key)
    if (numeric) {
      // Rate tokens are offsets from 100; signed and inverted forms must retain native sign semantics
      const value = (numeric[2] === '1' ? value1 : value2) - (numeric[1] === 'r' ? PERCENT : 0)
      if (numeric[3] === 's') return `${value >= 0 ? '+' : '-'}${Math.abs(value)}`
      if (numeric[3] === '~') return `${value >= 0 ? '-' : '+'}${Math.abs(value)}`
      return String(numeric[3] === 'a' ? Math.abs(value) : value)
    }
    const word = /^([iImMdDpP])([vr])([12])(~?)$/.exec(key)
    if (word) {
      const value = ((word[3] === '1' ? value1 : value2) - (word[2] === 'r' ? PERCENT : 0)) * (word[4] ? -1 : 1)
      const forms: Readonly<Record<string, readonly [string, string]>> = { i: ['increased', 'decreased'], m: ['more', 'less'], d: ['damage', 'healing'], p: ['provides', 'removes'] }
      const selected = forms[word[1]!.toLowerCase()]![value >= 0 ? 0 : 1]!
      const capitalized = word[1] === word[1]!.toUpperCase() ? selected[0]!.toUpperCase() + selected.slice(1) : selected
      const translated = general[`FORMAT_${word[1]}_${capitalized}`]
      if (typeof translated === 'string') return translated
    }
    unsupported = true
    return token
  })
  return unsupported || /[\[\]]/.test(result) ? undefined : nativeVocabularyText(result, general)
}
