import { nativeRecord, type NativeRecord } from '../native-game'
import type { NativeDescriptionContext } from './context.ts'
import { PERCENT, ATTRIBUTES } from './model.ts'
import { nativeDescriptionRecord } from './records.ts'
import { formatNativeTemplate } from './templates.ts'
import { statusApplication } from './statuses.ts'

const MATCH_ATTRIBUTE = 'Match'
const COMPLEX_ABILITY_TAGS = new Set(['ThreatGainFlat', 'DamagePerTargetDebuff', 'DamagePerSelfBuff', 'ConsumeComboTokens', 'ThreatGainMult', 'StatusRequiredTarget', 'StatusRequiredUser', 'StatusRestrictedTarget', 'StatusRestrictedUser', 'DamageReturnRateOverflow_100', 'DamageReturnRateOnKill_100', 'DamageReturnRateNoOverflow_100', 'RandomStatusUser', 'RandomStatusTarget', 'RemoveAllStatusCategory', 'RemoveOneFromStatusCategory', 'CopyAllStatusCategoryToSelf', 'DamageRateVsStatus', 'AddSpecificStatusCountTarget', 'AddSpecificStatusCountUser', 'AddToSpecificStatusCountTarget', 'AddToSpecificStatusCountUser', 'HealingRateVsStatus', 'BottomThreatDamageMult', 'NotBottomThreatDamageMult', 'SetSubJob', 'Teleport', 'SetMountType', 'SetMountToMyQuintar', 'ServiceShortcut', 'ChangeMonster', 'GetLevel'])

export function describeAbility(context: NativeDescriptionContext, record: NativeRecord, isItem: boolean): void {
  const { snapshot, mode, vocabulary, general, sourceText, enumName, join, vocab, listName, name, child, add, unresolved } = context
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
    // Fixed power is only complete when every scaling and defense input is explicitly null or zero
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
      // Damage visibility and modifier visibility are separate native controls; NeverMiss is exceptional
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
          add(statusApplication(context, status, setter.Count, setter.Chance, vocab(label)), 'Status application')
          context.lines.push(...child('status', setter.StatusID))
        }
      }
    }
}
