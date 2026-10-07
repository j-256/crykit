import { type BsonValue, type BsonDocument, type CrystalSave, CRYSTAL_SAVE_VERSION } from '../../interchange/crystal-save.ts'
import { type SaveEditorCatalog } from '../save-editor-mods'
import { type NativeRecord } from '../native-game'
import { type Family, type SaveInventoryKind, DEFAULT_LEVEL_CAP } from './model.ts'

const MAX_STOCK = 99

export function object(value: BsonValue | undefined, context: string): BsonDocument {
  if (value?.type !== 'document') throw new Error(`${context} must be a BSON document`)
  return value
}

export function array(value: BsonValue | undefined, context: string): BsonValue[] {
  if (value?.type !== 'array') throw new Error(`${context} must be a BSON array`)
  return value.value
}

export function number(value: BsonValue | undefined, context: string): number {
  if ((value?.type !== 'int32' && value?.type !== 'double') || !Number.isSafeInteger(value.value)) throw new Error(`${context} must be an integer`)
  return value.value
}

export function string(value: BsonValue | undefined, context: string): string {
  if (value?.type !== 'string') throw new Error(`${context} must be text`)
  return value.value
}

export function unsignedBigInt(value: BsonValue | undefined, context: string): bigint {
  if (value?.type === 'string' && /^\d+$/.test(value.value)) return BigInt(value.value)
  if (value?.type === 'int64' && value.value >= 0n) return value.value
  if ((value?.type === 'int32' || value?.type === 'double') && Number.isSafeInteger(value.value) && value.value >= 0) return BigInt(value.value)
  throw new Error(`${context} must be an unsigned integer`)
}

export function flag(value: BsonValue | undefined): boolean { return value?.type === 'boolean' && value.value }

export function int(value: number): BsonValue { return { type: 'int32', value } }

export function text(value: string): BsonValue { return { type: 'string', value } }

export function list(value: BsonValue[]): BsonValue { return { type: 'array', value } }

export function document(value: Record<string, BsonValue>): BsonDocument { return { type: 'document', value } }

export function numbers(value: BsonValue | undefined, context: string): number[] { return array(value, context).map(entry => number(entry, context)) }

export function bound(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be a whole number from ${minimum} to ${maximum}`)
}

export function known(catalog: SaveEditorCatalog, family: Family, id: number): NativeRecord {
  const result = catalog.records[family].get(id)
  if (!result) throw new Error(`Unknown ${family} ID ${id}; editing requires matching native definitions`)
  return result
}

// Legacy omissions use the native defaults; a missing modern field must still fail validation
export function flags(save: CrystalSave): BsonDocument { return object(save.party.value.GameplayFlags ?? (save.header.version < CRYSTAL_SAVE_VERSION ? document({}) : undefined), 'GameplayFlags') }

export function subJob(member: BsonDocument, save: CrystalSave): number | null {
  const value = member.value.SubJob
  return value?.type === 'null' || (!value && save.header.version < CRYSTAL_SAVE_VERSION) ? null : number(value, 'SubJob')
}

export function growthJob(member: BsonDocument, save: CrystalSave): number {
  const value = member.value.Growth
  return number(save.header.version < CRYSTAL_SAVE_VERSION && (!value || value.type === 'null') ? member.value.Job : value, 'Growth')
}

export function growthHistory(levels: BsonDocument, save: CrystalSave): number[] {
  const growth = numbers(levels.value.Entries, 'Growth levels')
  const history = levels.value.Hist ? numbers(levels.value.Hist, 'Growth history') : save.header.version < CRYSTAL_SAVE_VERSION ? [] : numbers(undefined, 'Growth history')
  return save.header.version < CRYSTAL_SAVE_VERSION ? Array.from({ length: Math.max(growth.length, history.length) }, (_, id) => Math.max(history[id] ?? 0, growth[id] ?? 0)) : history
}

export function stock(save: CrystalSave, kind: SaveInventoryKind): BsonValue[] {
  return array(object(save.party.value[kind === 'item' ? 'Items' : 'Equipment'], kind).value.Stock, `${kind} stock`)
}

export function stockId(entry: BsonValue, kind: SaveInventoryKind): number { return number(object(entry, 'Stock entry').value[kind === 'item' ? 'Item' : 'Equipment'], 'Stock ID') }

export function stockCount(entry: BsonValue): number { return number(object(entry, 'Stock entry').value.Count, 'Stock count') }

export function quantity(save: CrystalSave, kind: SaveInventoryKind, id: number): number { return stock(save, kind).filter(entry => stockId(entry, kind) === id).reduce((sum, entry) => sum + stockCount(entry), 0) }

export function equippedCount(save: CrystalSave, id: number): number { return save.members.reduce((sum, member) => sum + (flag(member.value.IsPresent) ? array(member.value.Equipment, 'Member equipment').filter(value => value.type !== 'null' && number(value, 'Equipped ID') === id).length : 0), 0) }

export function levelCap(save: CrystalSave): number {
  const values = flags(save).value
  if (flag(values.MaxLevelDown)) return number(values.MaxLevelDownVal, 'Level limit')
  return flag(values.MaxLevelUp) ? number(values.MaxLevelUpVal, 'Level cap') : DEFAULT_LEVEL_CAP
}

export function capacity(save: CrystalSave, catalog: SaveEditorCatalog, kind: SaveInventoryKind, id: number): number {
  const record = known(catalog, kind, id)
  const base = typeof record.MaxCapacity === 'number' ? record.MaxCapacity : 0
  if (kind === 'equipment') {
    // Stock is unequipped inventory, but the game's finite capacity includes present members' gear
    const randomizedEquipment = flag(object(save.party.value.RandomizerFlags ?? document({}), 'RandomizerFlags').value.Equipment)
    const limit = flag(flags(save).value.KeepEquipment) && !flag(flags(save).value.LimitlessEquipment) && !randomizedEquipment && base > 0 ? base : MAX_STOCK
    return Math.max(0, limit - equippedCount(save, id))
  }
  // Party.GetMaxCapacity returns the zero-capacity fallback before considering pouches
  if (base === 0) return record.MapForBiomeID !== null && record.MapForBiomeID !== undefined ? 1 : MAX_STOCK
  // Pouches are actual held item IDs, already resolved through any saved mod redirects
  // Count every matching pouch before applying the game's shared stock ceiling
  return Math.min(MAX_STOCK, stock(save, 'item').reduce((sum, entry) => {
    const pouch = catalog.records.item.get(stockId(entry, 'item'))
    return sum + (pouch?.IncreaseMaxCapacityForItemID === id && typeof pouch.IncreaseMaxCapacityBy === 'number' ? pouch.IncreaseMaxCapacityBy * stockCount(entry) : 0)
  }, base))
}
