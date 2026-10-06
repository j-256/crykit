import { nativeRecord, type NativeGameSnapshot, type NativeRecord } from './native-game'
import type { NativeDescription } from './native-description/model.ts'
import { createNativeDescriptionContext } from './native-description/context.ts'
import { describeStatModifiers } from './native-description/stats.ts'
import { describeStatus } from './native-description/statuses.ts'
import { describeAbility } from './native-description/abilities.ts'
import { describeItem } from './native-description/items.ts'

export type { NativeDescription } from './native-description/model.ts'
export { nativeDescriptionRecord } from './native-description/records.ts'
export { nativeVocabularyText, formatNativeTemplate } from './native-description/templates.ts'

export function describeNativeRecord(snapshot: NativeGameSnapshot, family: string, record: NativeRecord, mode = 'base', depth = 0, isItem = false): NativeDescription {
  if (mode !== 'base' && (!Array.isArray(snapshot.databases.patch) || !snapshot.databases.patch.some(patch => nativeRecord(patch) && patch.Name === mode))) return { lines: [], complete: false, unresolved: ['Unknown native mode'] }
  const context = createNativeDescriptionContext(snapshot, mode, depth, (childFamily, childRecord, childDepth, childIsItem) => describeNativeRecord(snapshot, childFamily, childRecord, mode, childDepth, childIsItem))
  const { add, sourceText, lines, unresolved } = context
  // Family renderers share one accumulator to preserve authored, effect, and child-description order
  if (typeof record.Description === 'string' && record.Description.trim()) add(sourceText(record.Description), 'Authored description contains unsupported vocabulary')
  if (family === 'equipment' || family === 'passive' || family === 'status') describeStatModifiers(context, family, record)
  if (family === 'status') describeStatus(context, record)
  if (family === 'ability') describeAbility(context, record, isItem)
  if (family === 'item') describeItem(context, record)
  if (!['ability', 'equipment', 'passive', 'status', 'item'].includes(family)) unresolved.push('Definition family')
  return { lines: [...new Set(lines)], complete: unresolved.length === 0 && lines.length > 0, unresolved: [...new Set(unresolved)] }
}
