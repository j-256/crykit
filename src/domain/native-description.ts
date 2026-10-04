import { nativeRecord, type NativeGameSnapshot, type NativeRecord } from './native-game'
import type { JsonValue } from './types'

export interface NativeDescription {
  readonly lines: readonly string[]
  readonly complete: boolean
  readonly unresolved: readonly string[]
}

const MAX_TEXT_LENGTH = 16_384
const MAX_VOCAB_DEPTH = 8
const MAX_REFERENCE_DEPTH = 4
const PERCENT = 100
const MATCH_ATTRIBUTE = 'Match'
const VOCAB_ALIASES: Readonly<Record<string, string>> = Object.freeze({"Sep": "Colon_Sep", "HP": "HP", "MP": "MP", "AP": "AP", "TT_SHORT": "TT_SHORT", "TT": "TT", "CT_SHORT": "CT_SHORT", "CT": "CT", "Exp": "Exp", "JP": "JP", "Jxp": "JXP", "Jobs": "Jobs", "Job": "Job", "SubJob": "SubJob", "PP": "PP", "Atlas": "Atlas", "Threat": "Threat", "BottomThreat": "BottomThreat", "TopThreat": "TopThreat", "bottomThreat": "bottomThreat", "topThreat": "topThreat", "HomePoint": "HomePoint", "Crystal": "Crystal", "Currency": "Currency", "Sequoia": "Sequoia", "Flame": "Flame", "GameMaster": "GameMaster", "Banning": "Banning", "Banned": "Banned", "Bans": "Bans", "Ban": "Ban", "more": "FORMAT_m_more", "less": "FORMAT_m_less", "MaxHP": "MaxHP", "MaxMP": "MaxMP", "MaxAP": "MaxAP", "STR": "STR", "VIT": "VIT", "DEX": "DEX", "AGI": "AGI", "MND": "MND", "SPI": "SPI", "SPD": "SPD", "LCK": "LCK", "PAtk": "PAtk", "PDef": "PDef", "MDef": "MDef", "PCritChance": "PCritChance", "PCritDmg": "PCritDmg", "PAcc": "PAcc", "PEva": "PEva", "PPen": "PPen", "MPen": "MPen", "Variance": "PVarRate", "Buff": "Buff", "Debuff": "Debuff", "Consumables": "Consumables", "Tools": "Tools", "Artifacts": "Artifacts"})
const VOCAB_PATTERN = new RegExp(`@V[.](${Object.keys(VOCAB_ALIASES).sort((left, right) => right.length - left.length).join('|')})`, 'g')
const ATTRIBUTES = Object.freeze({ HP: 'HP', MP: 'MP', AP: 'AP' })
const PERMANENT_STATUS_COUNT = 255
const STATUS_DECREMENTS = ['DecrementOnFixedInterval', 'DecrementOnEachUserTurn', 'DecrementOnDmgTaken', 'DecrementOnPDmgTaken', 'DecrementOnPDmgEvaded', 'DecrementOnPDmgGiven', 'DecrementOnMDmgTaken', 'DecrementOnMDmgEvaded', 'DecrementOnMDmgGiven', 'DecrementOnHealTaken', 'DecrementOnHealGiven', 'DecrementOnCritGiven', 'DecrementOnEffect'] as const
const PATCH_FAMILIES: Readonly<Record<string, string>> = Object.freeze({ ability: 'Abilities', equipment: 'Equipment', item: 'Items', passive: 'Passives', status: 'Statuses', job: 'Jobs' })
const COMPLEX_STAT_TAGS = new Set(['DamageOnApply', 'DamageRateOnApply', 'Addi_PDmgReturn', 'Addi_PDmgReturn_OnKill', 'Flat_PDmgReturn', 'Addi_MDmgReturn', 'Addi_MDmgReturn_OnKill', 'Addi_HealingReturn', 'Reaction', 'RemoveStatusOnApply', 'SetStatusOnApply', 'SetStatusAfterRemoval', 'SetStatusAfterExpiry', 'ForceTurnAbility', 'ReplaceAttackWith'])
const COMPLEX_ABILITY_TAGS = new Set(['ThreatGainFlat', 'DamagePerTargetDebuff', 'DamagePerSelfBuff', 'ConsumeComboTokens', 'ThreatGainMult', 'StatusRequiredTarget', 'StatusRequiredUser', 'StatusRestrictedTarget', 'StatusRestrictedUser', 'DamageReturnRateOverflow_100', 'DamageReturnRateOnKill_100', 'DamageReturnRateNoOverflow_100', 'RandomStatusUser', 'RandomStatusTarget', 'RemoveAllStatusCategory', 'RemoveOneFromStatusCategory', 'CopyAllStatusCategoryToSelf', 'DamageRateVsStatus', 'AddSpecificStatusCountTarget', 'AddSpecificStatusCountUser', 'AddToSpecificStatusCountTarget', 'AddToSpecificStatusCountUser', 'HealingRateVsStatus', 'BottomThreatDamageMult', 'NotBottomThreatDamageMult', 'SetSubJob', 'Teleport', 'SetMountType', 'SetMountToMyQuintar', 'ServiceShortcut', 'ChangeMonster', 'GetLevel'])

export function nativeDescriptionRecord(snapshot: NativeGameSnapshot, family: string, id: number, mode = 'base'): NativeRecord | undefined {
  if (!Number.isSafeInteger(id) || id < 0) return undefined
  if (mode !== 'base') {
    const patches = snapshot.databases.patch
    const patch = Array.isArray(patches) ? patches.find(value => nativeRecord(value) && value.Name === mode) : undefined
    if (!nativeRecord(patch)) return undefined
    const records = PATCH_FAMILIES[family] ? patch[PATCH_FAMILIES[family]!] : undefined
    const record = Array.isArray(records) ? records.find(value => nativeRecord(value) && value.ID === id) : undefined
    if (nativeRecord(record)) return record
  }
  const records = snapshot.databases[family]
  const record = Array.isArray(records) ? records.find(value => nativeRecord(value) && value.ID === id) : undefined
  return nativeRecord(record) ? record : undefined
}

export function nativeVocabularyText(text: string, general: NativeRecord, trim = true): string | undefined {
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

export function describeNativeRecord(snapshot: NativeGameSnapshot, family: string, record: NativeRecord, mode = 'base', depth = 0, isItem = false): NativeDescription {
  if (mode !== 'base' && (!Array.isArray(snapshot.databases.patch) || !snapshot.databases.patch.some(patch => nativeRecord(patch) && patch.Name === mode))) return { lines: [], complete: false, unresolved: ['Unknown native mode'] }
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
    if (!target || depth >= MAX_REFERENCE_DEPTH) { unresolved.push(`Unresolved ${database} description`); return }
    const result = describeNativeRecord(snapshot, database, target, mode, depth + 1, item)
    lines.push(...result.lines)
    unresolved.push(...result.unresolved)
  }
  const statusConditions = (status: NativeRecord, count: number): string | undefined => {
    const conditions: string[] = []
    const keys: Readonly<Record<string, readonly [string, string]>> = {
      DecrementOnFixedInterval: ['INTERVAL', 'INTERVALS'], DecrementOnEachUserTurn: ['TURN', 'TURNS'],
      DecrementOnDmgTaken: ['DMG_TAKEN', 'DMGS_TAKEN'], DecrementOnPDmgTaken: ['PDMG_TAKEN', 'PDMGS_TAKEN'], DecrementOnMDmgTaken: ['MDMG_TAKEN', 'MDMGS_TAKEN'],
      DecrementOnPDmgGiven: ['PDMG_GIVEN', 'PDMGS_GIVEN'], DecrementOnMDmgGiven: ['MDMG_GIVEN', 'MDMGS_GIVEN'],
      DecrementOnPDmgEvaded: ['PEVA_TAKEN', 'PEVAS_TAKEN'], DecrementOnMDmgEvaded: ['MEVA_TAKEN', 'MEVAS_TAKEN'],
      DecrementOnHealTaken: ['HEAL_TAKEN', 'HEALS_TAKEN'], DecrementOnHealGiven: ['HEAL_GIVEN', 'HEALS_GIVEN'], DecrementOnCritGiven: ['CRIT_GIVEN', 'CRITS_GIVEN'],
    }
    for (const [field, pair] of Object.entries(keys)) if (status[field] === true) {
      const condition = vocab(`DESC_STATUS_${pair[count > 1 ? 1 : 0]}`)
      if (condition === undefined) return undefined
      conditions.push(condition)
    }
    if (status.DecrementOnEffect === true) {
      const survives = Array.isArray(status.StatMods) && status.StatMods.some(modifier => nativeRecord(modifier) && enumName('SangStatModTag', modifier.Tag) === 'CantBeOneHitKOd')
      const condition = survives ? vocab(`DESC_STATUS_${count > 1 ? 'HITS_SURVIVED' : 'HIT_SURVIVED'}`) : undefined
      if (condition === undefined) return undefined
      conditions.push(condition)
    }
    return conditions.length ? conditions.join(vocab('DESC_STATUS_DELIM_B') ?? ', or ') : undefined
  }
  const statusApplication = (status: NativeRecord, count: number, chance: number, label: string | undefined): string | undefined => {
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(chance) || chance < 0 || chance > PERCENT || count <= 0 || !label || typeof status.Name !== 'string') return undefined
    const instantKill = Array.isArray(status.StatMods) && status.StatMods.some(modifier => nativeRecord(modifier) && enumName('SangStatModTag', modifier.Tag) === 'InstantKill')
    const permanent = count === PERMANENT_STATUS_COUNT || (STATUS_DECREMENTS.every(key => status[key] === false) && enumName('SangStatusCategory', status.Category) !== 'Strict' && status.ID !== 46)
    let duration = ''
    if (!instantKill && !permanent && status.HideDurationFromDescription !== true) {
      const conditions = statusConditions(status, count)
      if (!conditions) return undefined
      duration = ` for ${count} ${conditions}`
    }
    return `${label}: ${status.Name}${duration}${permanent && !instantKill ? ' (permanent)' : ''}${chance !== PERCENT ? ` (${chance}% chance)` : ''}.`
  }
  if (typeof record.Description === 'string' && record.Description.trim()) add(sourceText(record.Description), 'Authored description contains unsupported vocabulary')
  if (family === 'equipment' || family === 'passive' || family === 'status') {
    if (record.HideStatModsFromDescription !== true && !Array.isArray(record.StatMods)) unresolved.push('Invalid stat modifiers')
    if (record.HideStatModsFromDescription !== true && Array.isArray(record.StatMods)) for (const modifier of record.StatMods) {
      if (!nativeRecord(modifier)) { unresolved.push('Invalid stat modifier'); continue }
      const tag = enumName('SangStatModTag', modifier.Tag)
      const value1 = modifier.Value1
      const value2 = modifier.Value2
      const value3 = modifier.Value3
      if (!tag || typeof value1 !== 'number' || typeof value2 !== 'number' || !Number.isSafeInteger(value1) || !Number.isSafeInteger(value2)) { unresolved.push('Unknown stat modifier'); continue }
      const templates = vocabulary.StatModText
      const template = Array.isArray(templates) && typeof modifier.Tag === 'number' && typeof templates[modifier.Tag] === 'string' ? templates[modifier.Tag] as string : ''
      const format = (first = value1, second = value2, label?: string) => formatNativeTemplate(sourceText(template) ?? '', general, first, second, label)
      let text: string | undefined
      if (family === 'status' && tag === 'InstantKill') continue
      if (/_PerLevel$/.test(tag)) text = value2 > 0 ? join(format(value1, value2, vocab('WinStatMod_PerLevel_p1')), value2 === 1 ? vocab('WinStatMod_PerLevel_p2') : join(vocab('WinStatMod_PerLevel_p3a'), value2, vocab('WinStatMod_PerLevel_p3b'))) : undefined
      else if (/_PerTurn$/.test(tag)) text = join(format(value1, value2, vocab('WinStatMod_PerTurn_p1')), vocab('WinStatMod_PerTurn_p2'), vocab(value1 * value2 > 0 ? 'WinStatMod_PerTurn_p3a' : 'WinStatMod_PerTurn_p3b'), value1 * value2, vocab('WinStatMod_PerTurn_p4'))
      else if (tag === 'PElement') text = format(0, 0, listName('ElementNames', value1))
      else if (tag === 'Mult_ElementDmg_Taken' || tag === 'Mult_ElementDmg_Given') {
        const element = listName('ElementNames', value1)
        const direction = tag.endsWith('Taken') ? 'Taken' : 'Given'
        if (element) text = value2 === -PERCENT
          ? join(vocab(`WinStatMod_NoElementDmg${direction}_p1`), element, vocab(`WinStatMod_NoElementDmg${direction}_p2`))
          : value2 < -PERCENT
            ? join(vocab(`WinStatMod_ElementDmg${direction}Heals_p1`), element, vocab(`WinStatMod_ElementDmg${direction}Heals_p2`), -value2 - PERCENT, vocab('Percent'), vocab(`WinStatMod_ElementDmg${direction}Heals_p3`))
            : format(value2, 0, element)
      } else if (/^Mult_[PM]Dmg_(Given|Taken)_100$/.test(tag) && value1 === 0) text = vocab(({ Mult_PDmg_Given_100: 'WinStatMod_NoPDmgGiven', Mult_PDmg_Taken_100: 'WinStatMod_NoPDmgTaken', Mult_MDmg_Given_100: 'WinStatMod_NoMDmgGiven', Mult_MDmg_Taken_100: 'WinStatMod_NoMDmgTaken' } as Readonly<Record<string, string>>)[tag]!)
      else if (tag === 'Mult_Healing_Taken_100' && value1 === -PERCENT) text = vocab('WinStatMod_HealingTakenDamages')
      else if (['Addi_PDmgReturn', 'Addi_PDmgReturn_OnKill', 'Flat_PDmgReturn', 'Addi_MDmgReturn', 'Addi_MDmgReturn_OnKill', 'Addi_HealingReturn'].includes(tag)) {
        const attribute = enumName('SangAbilityAttribute', value1)
        if (attribute && Object.hasOwn(ATTRIBUTES, attribute)) {
          const healing = tag === 'Addi_HealingReturn'
          const kind = healing ? 'HEAL' : tag.includes('PDmg') ? 'PHYS' : 'MAGI'
          const direction = (healing ? value2 < 0 : value2 >= 0) ? 'RECOIL' : 'ABSORB'
          text = format(Math.abs(value2), 0, vocab(`${attribute}_${direction}_${kind}`))
        }
      }
      else if (tag === 'StatusImmunity') text = join(vocab('DESC_STATUS_IMMUNE_TO_'), name('status', value1))
      else if (tag === 'StatusAuto' || tag === 'PStatusApply') {
        const status = nativeDescriptionRecord(snapshot, 'status', value1, mode)
        if (status && typeof value3 === 'number' && value3 > 0) {
          text = statusApplication(status, value3, value2, tag === 'StatusAuto' ? vocab('DESC_STATUS_ON_BATTLE_START') : vocab(enumName('SangStatusCategory', status.Category) === 'Debuff' ? 'DESC_STATUS_ON_HIT_INFLICT' : 'DESC_STATUS_ON_HIT_APPLY'))
          child('status', value1)
        }
      } else if (tag === 'ImmuneToStatusCategory') {
        const category = enumName('SangStatusCategory', value1)
        text = format(value1, value2, category && ['Buff', 'Debuff', 'Stance'].includes(category) ? vocab(`${category}s`) : undefined)
      } else if (tag === 'EnableEquipType') text = join(vocab('WinStatMod_EnableEquipType_p1'), listName('EquipmentNames', value1), vocab('WinStatMod_EnableEquipType_p2'))
      else if (tag === 'JPBoost' || tag === 'SetAppearanceToJob') text = format(0, value2, name('job', value1))
      else if (tag === 'RestrictCommandTo') text = format(value1, value2, name('job', value1, 'AbilitiesName'))
      else if (['Flat_AbilityAPCost', 'Flat_AbilityMPCost', 'Mult_AbilityDmg'].includes(tag)) text = format(0, value2, name('ability', value1))
      else if (tag === 'BonusDoubledWhenPaired') continue
      else if (!COMPLEX_STAT_TAGS.has(tag)) text = format()
      add(text, `Stat modifier: ${tag}`)
    }
    if (family === 'equipment' && record.IsOneOnly === true) add(vocab('POPUP_OnlyOneCanBeEquipped'), 'Equipment quantity restriction')
    if (family === 'equipment' && Array.isArray(record.StatMods) && record.StatMods.some(modifier => nativeRecord(modifier) && enumName('SangStatModTag', modifier.Tag) === 'BonusDoubledWhenPaired')) add(join(vocab('POPUP_BonusIsDoubledWithAnother_p1'), typeof record.Name === 'string' ? record.Name : undefined, vocab('POPUP_BonusIsDoubledWithAnother_p2')), 'Equipment paired bonus')
  }
  if (family === 'status') {
    if (record.RemoveOnDmgTaken === true) add(vocab('DESC_STATUS_REMOVED_BY_DAMAGE'), 'Status removal')
    if (record.ReApplyResistance === true) add(vocab(enumName('SangStatusCategory', record.Category) === 'Debuff' ? 'DESC_STATUS_RESIST_REINFLICT' : 'DESC_STATUS_RESIST_REAPPLY'), 'Status resistance')
    if (depth === 0 && record.HideDurationFromDescription !== true && STATUS_DECREMENTS.some(key => record[key] === true)) add(join(vocab('DESC_STATUS_GENERIC_DURATION'), ' ', statusConditions(record, 1), '.'), 'Status duration')
  }
  if (family === 'ability') {
    const modifiers = Array.isArray(record.AbilityMods) ? record.AbilityMods.filter(nativeRecord) : []
    if (!Array.isArray(record.AbilityMods) || modifiers.length !== record.AbilityMods.length) unresolved.push('Invalid ability modifiers')
    const hasTag = (tag: string) => modifiers.some(modifier => enumName('SangAbilityModTag', modifier.Tag) === tag)
    const target = enumName('SangAbilityTarget', record.Target)
    const scope = enumName('SangAbilityScope', record.Scope)
    const attribute = enumName('SangAbilityAttribute', record.Attribute)
    const hasStance = ['TargetStatuses', 'UserStatuses'].some(key => Array.isArray(record[key]) && record[key].some(setter => nativeRecord(setter) && typeof setter.StatusID === 'number' && enumName('SangStatusCategory', nativeDescriptionRecord(snapshot, 'status', setter.StatusID, mode)?.Category) === 'Stance'))
    if (record.HideScopeFromDescription !== true) {
      let scopeText: string | undefined
      if (hasTag('Escape')) scopeText = vocab(record.IsPAbil ? 'WinAbilityMod_WeaponSkill' : record.IsMAbil ? 'WinAbilityMod_Magic' : 'WinAbilityMod_Ability')
      else if (target === 'SelfOnly' && hasStance) scopeText = join(vocab('WinAbilityMod_StanceChange'), record.IsMAbil ? vocab('WinAbilityMod_magic_Brc') : '')
      else {
        let scopeKey: string | undefined
        if (target === 'SelfOnly' || target === 'DeadSelfOnly') scopeKey = 'SelfOnly'
        else if (scope === 'Everything') scopeKey = 'EverythingTargeted'
        else if ((scope === 'Single' || scope === 'Multiple') && target) scopeKey = `${scope === 'Single' ? 'Single' : 'Multi'}${record.ScopeLocked ? target === 'Enemy' ? 'Enemy' : 'Ally' : 'Target'}`
        if (scopeKey) scopeText = vocab(`WinAbilityMod_${scopeKey}`)
        if (record.IsBasic) scopeText = join(scopeText, vocab(record.IsMAbil ? 'WinAbilityMod_basicMagic' : 'WinAbilityMod_basicAttack'))
        else if (record.IsPAbil) {
          unresolved.push('Weapon type scope details')
        } else if (record.IsMAbil) scopeText = join(scopeText, vocab('WinAbilityMod_magic'))
        else if (hasStance) scopeText = join(scopeText, vocab('WinAbilityMod_stanceChange'))
        else if (!isItem) scopeText = join(scopeText, vocab('WinAbilityMod_ability'))
      }
      add(scopeText === undefined ? undefined : `${scopeText}.`, 'Ability scope')
      if (hasStance) add(vocab(typeof record.CTCost === 'number' && record.CTCost > 0 ? 'WinAbilityMod_DoesNotUseTurn_Charges' : 'WinAbilityMod_DoesNotUseTurn'), 'Stance turn cost')
      if (target === 'OtherOnly' || target === 'DeadOrAlive') add(vocab(`WinAbilityMod_${target}`), 'Ability target restriction')
    }
    const costs = ['HP', 'MP', 'AP', 'CT', 'CD'].flatMap(key => {
      const value = record[`${key}Cost`]
      return typeof value === 'number' && value > 0 ? [`${value}${key === 'HP' ? '%' : ''} ${key}`] : []
    })
    if (costs.length) add(`Cost: ${costs.join(', ')}.`)
    const powerFields = ['BasePower', 'BasePAtkRate', 'ScalingPower', 'ScalingPAtkRate']
    const hasFormulaPower = powerFields.some(key => typeof record[key] === 'number' && record[key] !== 0)
    const fixedPower = typeof record.BasePower === 'number' && Number.isSafeInteger(record.BasePower) && ['BasePAtkRate', 'ScalingPower', 'ScalingPAtkRate', 'StrRate', 'VitRate', 'DexRate', 'AgiRate', 'MndRate', 'SpiRate', 'SpdRate', 'LckRate', 'PDefRate', 'MDefRate'].every(key => record[key] === 0 || record[key] === null) && record.IsPAbil === false && record.IsMAbil === false && attribute !== undefined && Object.hasOwn(ATTRIBUTES, attribute)
    if (record.HideDamageFromDescription !== true && hasFormulaPower && !fixedPower) unresolved.push('Ability power formula')
    if (hasFormulaPower && !fixedPower) unresolved.push('Ability defense and scaling details')
    const powerLabel = (heals: boolean) => {
      if (target === 'DeadAlly' || target === 'DeadSelfOnly') return vocab('WinAbilityMod_ReviveDead')
      if (heals && modifiers.some(modifier => ['DamageReturnRateOverflow_100', 'DamageReturnRateNoOverflow_100'].includes(enumName('SangAbilityModTag', modifier.Tag) ?? '') && modifier.Value1 === record.Attribute && modifier.Value2 === -PERCENT)) return vocab('WinAbilityMod_Transfer')
      return vocab(heals ? attribute === 'MP' ? 'WinAbilityMod_Restore' : attribute === 'AP' ? 'WinAbilityMod_Accumulate' : 'WinAbilityMod_Recovery' : 'WinAbilityMod_Damage')
    }
    if (record.HideDamageFromDescription !== true && fixedPower && typeof record.BasePower === 'number' && record.BasePower !== 0) add(join(powerLabel(record.BasePower < 0), vocab('Colon_Sep'), Math.abs(record.BasePower), ' ', attribute && vocab(attribute)), 'Ability fixed power')
    for (const modifier of modifiers) {
      const tag = enumName('SangAbilityModTag', modifier.Tag)
      const value1 = modifier.Value1
      const value2 = modifier.Value2
      if (!tag || typeof value1 !== 'number' || typeof value2 !== 'number' || !Number.isSafeInteger(value1) || !Number.isSafeInteger(value2)) { unresolved.push('Unknown ability modifier'); continue }
      const percentage = /^DamageRate(User)?(Current|Missing|Max)_100$/.test(tag)
      if (percentage ? record.HideDamageFromDescription === true : tag !== 'NeverMiss' && record.HideModsFromDescription === true) continue
      const templates = vocabulary.AbilityModText
      const template = Array.isArray(templates) && typeof modifier.Tag === 'number' && typeof templates[modifier.Tag] === 'string' ? templates[modifier.Tag] as string : ''
      const format = (first = value1, second = value2, label?: string, attr?: string) => formatNativeTemplate(sourceText(template) ?? '', general, first, second, label, attr)
      let text: string | undefined
      if (percentage) {
        const sourceAttribute = enumName('SangAbilityAttribute', value2)
        const resolved = sourceAttribute === MATCH_ATTRIBUTE ? attribute : sourceAttribute
        const attr = resolved && ATTRIBUTES[resolved as keyof typeof ATTRIBUTES]
        if (attr) text = format(value1, 0, powerLabel(value1 < 0), vocab(attr))
      } else if (tag === 'ItemRequired' || tag === 'ConsumeItem') {
        const item = name('item', value1)
        text = join(tag === 'ConsumeItem' ? format(value1, Math.abs(value2), vocab(value2 < 0 ? 'FORMAT_P_Provides' : 'Consumes')) : format(value1, 0), ' ', item, (tag === 'ConsumeItem' ? Math.abs(value2) !== 1 : value2 > 1) ? ` x${Math.abs(value2)}` : '')
      } else if (tag === 'JobRequired' || tag === 'SubJobRequired') text = join(format(value1, 0), ' ', name('job', value1, tag === 'JobRequired' ? 'Name' : 'AbilitiesName'))
      else if (tag === 'ThreatGainMult') text = value1 === -PERCENT ? vocab('WinAbilityMod_GenNoThreat') : value1 === PERCENT ? vocab('WinAbilityMod_Gen2xThreat') : format(value1, 0)
      else if (!COMPLEX_ABILITY_TAGS.has(tag)) text = format()
      add(text, `Ability modifier: ${tag}`)
    }
    if (record.IsBasic === true) add(vocab('WinAbilityMod_AccumulatesAP'), 'Basic attack AP')
    for (const [key, label, offset] of [['BaseAcc', 'PAcc', PERCENT], ['BaseCritChance', 'PCritChance', 0], ['BaseCritDmg', 'PCritDmg', 0], ['BaseVar', 'PVarRate', 0]] as const) {
      const value = record[key]
      if (typeof value === 'number' && value !== 0) add(join(vocab(label), vocab('Colon_Sep'), record.IsPAbil && (key === 'BaseCritChance' || key === 'BaseCritDmg') && value >= 0 ? vocab('Plus') : '', value + offset, vocab('Percent')), `Ability ${key}`)
    }
    if (typeof record.Element === 'number') add(join(listName('ElementNames', record.Element), ' ', vocab('WinAbilityMod_Elemental')), 'Ability element')
    if (record.IsPAbil === true || record.IsMAbil === true) unresolved.push('Ability combat details')
    if (record.HideStatusesFromDescription !== true) for (const key of ['TargetStatuses', 'UserStatuses']) {
      const statuses = record[key]
      if (!Array.isArray(statuses)) { unresolved.push('Invalid status applications'); continue }
      for (const setter of statuses) {
        if (!nativeRecord(setter)) { unresolved.push('Invalid status application'); continue }
        if (setter.Count === 0) continue
        const status = typeof setter.StatusID === 'number' ? nativeDescriptionRecord(snapshot, 'status', setter.StatusID, mode) : undefined
        if (!status || typeof setter.Chance !== 'number' || typeof setter.Count !== 'number' || !Number.isSafeInteger(setter.Chance) || !Number.isSafeInteger(setter.Count) || setter.Chance < 0 || setter.Chance > PERCENT) { unresolved.push('Status application'); continue }
        if (setter.Count < 0) add(join(vocab(key === 'UserStatuses' ? 'DESC_STATUS_SELF_CLEAR_' : 'DESC_STATUS_REMOVE_'), typeof status.Name === 'string' ? status.Name : undefined, setter.Chance !== 0 && setter.Chance !== PERCENT ? ` (${setter.Chance}%)` : ''), 'Status removal')
        else {
          const debuff = enumName('SangStatusCategory', status.Category) === 'Debuff'
          const label = key === 'UserStatuses' ? debuff ? 'DESC_STATUS_SELF_INFLICT' : 'DESC_STATUS_SELF_APPLY' : debuff ? 'DESC_STATUS_INFLICT' : 'DESC_STATUS_APPLY'
          add(statusApplication(status, setter.Count, setter.Chance, vocab(label)), 'Status application')
          child('status', setter.StatusID)
        }
      }
    }
  }
  if (family === 'item') {
    if (typeof record.AbilityID === 'number') child('ability', record.AbilityID, true)
    if (record.SpecialBonus !== undefined && record.SpecialBonus !== 0) unresolved.push('Item special behavior')
    if ((typeof record.AbilityID === 'number' || record.IsCombat === true) && record.IsConsumable === false) add(vocab('WinItem_UnlimitedUse') ?? 'Unlimited use.')
    if (typeof record.MapForBiomeID === 'number') { const biome = name('biome', record.MapForBiomeID); add(biome ? `Map of ${biome}.` : undefined, 'Map region') }
    if (typeof record.IncreaseMaxCapacityForItemID === 'number' && typeof record.IncreaseMaxCapacityBy === 'number') {
      const item = name('item', record.IncreaseMaxCapacityForItemID)
      add(item ? `Increase maximum ${item} capacity by ${record.IncreaseMaxCapacityBy}.` : undefined, 'Item capacity')
    }
    if (typeof record.Flavor === 'string' && record.Flavor.trim()) add(sourceText(record.Flavor), 'Item flavor vocabulary')
    if (!lines.length) unresolved.push('Item behavior has no supported description')
  }
  if (!['ability', 'equipment', 'passive', 'status', 'item'].includes(family)) unresolved.push('Definition family')
  return { lines: [...new Set(lines)], complete: unresolved.length === 0 && lines.length > 0, unresolved: [...new Set(unresolved)] }
}
