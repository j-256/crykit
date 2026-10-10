import { nativeRecord, type NativeRecord } from '../native-game'
import type { NativeDescriptionContext } from './context.ts'
import { PERCENT, ATTRIBUTES } from './model.ts'
import { nativeDescriptionRecord } from './records.ts'
import { formatNativeTemplate } from './templates.ts'
import { statusApplication } from './statuses.ts'

const COMPLEX_STAT_TAGS = new Set(['DamageOnApply', 'DamageRateOnApply', 'Addi_PDmgReturn', 'Addi_PDmgReturn_OnKill', 'Flat_PDmgReturn', 'Addi_MDmgReturn', 'Addi_MDmgReturn_OnKill', 'Addi_HealingReturn', 'Reaction', 'RemoveStatusOnApply', 'SetStatusOnApply', 'SetStatusAfterRemoval', 'SetStatusAfterExpiry', 'ForceTurnAbility', 'ReplaceAttackWith'])

export function describeStatModifiers(context: NativeDescriptionContext, family: string, record: NativeRecord): void {
  const { snapshot, mode, vocabulary, general, sourceText, enumName, join, vocab, listName, name, child, add, lines, unresolved } = context
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
          text = statusApplication(context, status, value3, value2, tag === 'StatusAuto' ? vocab('DESC_STATUS_ON_BATTLE_START') : vocab(enumName('SangStatusCategory', status.Category) === 'Debuff' ? 'DESC_STATUS_ON_HIT_INFLICT' : 'DESC_STATUS_ON_HIT_APPLY'))
          const effects = child('status', value1)
          // An on-hit status is conditional, not an unconditional equipment modifier
          // Keep its explanation with the trigger and chance even in truncated summaries
          if (tag === 'PStatusApply') text = text && (effects.length ? `${text} ${status.Name} effect: ${effects.join(' ')}` : text)
          else lines.push(...effects)
        }
      } else if (tag === 'ImmuneToStatusCategory') {
        const category = enumName('SangStatusCategory', value1)
        text = format(value1, value2, category && ['Buff', 'Debuff', 'Stance'].includes(category) ? vocab(`${category}s`) : undefined)
      } else if (tag === 'EnableEquipType') text = join(vocab('WinStatMod_EnableEquipType_p1'), listName('EquipmentNames', value1), vocab('WinStatMod_EnableEquipType_p2'))
      else if (tag === 'JPBoost' || tag === 'SetAppearanceToJob') text = format(0, value2, name('job', value1))
      else if (tag === 'RestrictCommandTo') text = format(value1, value2, name('job', value1, 'AbilitiesName'))
      else if (['Flat_AbilityAPCost', 'Flat_AbilityMPCost', 'Mult_AbilityDmg'].includes(tag)) text = format(0, value2, name('ability', value1))
      else if (tag === 'BonusDoubledWhenPaired') continue
      // Complex effects need their own reviewed interpreter; a generic template could hide missing rules
      else if (!COMPLEX_STAT_TAGS.has(tag)) text = format()
      add(text, `Stat modifier: ${tag}`)
    }
    if (family === 'equipment' && record.IsOneOnly === true) add(vocab('POPUP_OnlyOneCanBeEquipped'), 'Equipment quantity restriction')
    if (family === 'equipment' && Array.isArray(record.StatMods) && record.StatMods.some(modifier => nativeRecord(modifier) && enumName('SangStatModTag', modifier.Tag) === 'BonusDoubledWhenPaired')) add(join(vocab('POPUP_BonusIsDoubledWithAnother_p1'), typeof record.Name === 'string' ? record.Name : undefined, vocab('POPUP_BonusIsDoubledWithAnother_p2')), 'Equipment paired bonus')
}
