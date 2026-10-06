import type { NativeRecord } from '../native-game'
import type { NativeDescriptionContext } from './context.ts'

export function describeItem(context: NativeDescriptionContext, record: NativeRecord): void {
  const { child, add, vocab, name, sourceText, lines, unresolved } = context
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
