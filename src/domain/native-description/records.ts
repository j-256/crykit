import { nativeRecord, type NativeGameSnapshot, type NativeRecord } from '../native-game'

const PATCH_FAMILIES: Readonly<Record<string, string>> = Object.freeze({ ability: 'Abilities', equipment: 'Equipment', item: 'Items', passive: 'Passives', status: 'Statuses', job: 'Jobs' })

export function nativeDescriptionRecord(snapshot: NativeGameSnapshot, family: string, id: number, mode = 'base'): NativeRecord | undefined {
  if (!Number.isSafeInteger(id) || id < 0) return undefined
  if (mode !== 'base') {
    const patches = snapshot.databases.patch
    const patch = Array.isArray(patches) ? patches.find(value => nativeRecord(value) && value.Name === mode) : undefined
    // Known modes may inherit sparse base records; an unknown mode cannot borrow base facts
    if (!nativeRecord(patch)) return undefined
    const records = PATCH_FAMILIES[family] ? patch[PATCH_FAMILIES[family]!] : undefined
    const record = Array.isArray(records) ? records.find(value => nativeRecord(value) && value.ID === id) : undefined
    if (nativeRecord(record)) return record
  }
  const records = snapshot.databases[family]
  const record = Array.isArray(records) ? records.find(value => nativeRecord(value) && value.ID === id) : undefined
  return nativeRecord(record) ? record : undefined
}
