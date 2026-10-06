import { type CrystalSave, CRYSTAL_SAVE_VERSION } from '../../interchange/crystal-save.ts'
import { type SaveEditorCatalog } from '../save-editor-mods'
import { type SaveInventoryKind, EMPTY_DATE, ATLAS } from './model.ts'
import { stock, stockId, object, int, document, stockCount, list, array, number } from './values.ts'

const TREASURE_FINDER_BONUS = 4

export function setStock(save: CrystalSave, kind: SaveInventoryKind, id: number, count: number): void {
  const values = stock(save, kind)
  const index = values.findIndex(entry => stockId(entry, kind) === id)
  if (index >= 0) {
    if (count === 0) values.splice(index, 1)
    else object(values[index], 'Stock entry').value.Count = int(count)
  } else if (count > 0) values.push(document({ [kind === 'item' ? 'Item' : 'Equipment']: int(id), Count: int(count) }))
}

export function updateTreasureFinder(save: CrystalSave, catalog: SaveEditorCatalog): void {
  object(save.party.value.Items, 'Items').value.TF = { type: 'boolean', value: stock(save, 'item').some(entry => stockCount(entry) > 0 && ((Number(catalog.records.item.get(stockId(entry, 'item'))?.SpecialBonus) || 0) & TREASURE_FINDER_BONUS) !== 0) }
}

export function atlas(save: CrystalSave, family: 'Jobs' | 'Abilities' | 'Passives' | 'Items' | 'Equipment', id: number, state: number, now: Date): void {
  if (save.header.version < CRYSTAL_SAVE_VERSION) {
    save.party.value.Atlas ??= document({})
    object(save.party.value.Atlas, 'Atlas').value[family] ??= document({ Entries: list([]) })
  }
  const entries = array(object(object(save.party.value.Atlas, 'Atlas').value[family], `Atlas ${family}`).value.Entries, 'Atlas entries')
  while (entries.length <= id) entries.push(document({ ID: int(entries.length), S: int(0), HT: { type: 'datetime', value: EMPTY_DATE }, ST: { type: 'datetime', value: EMPTY_DATE }, AT: { type: 'datetime', value: EMPTY_DATE }, PT: { type: 'datetime', value: EMPTY_DATE }, BF: int(0) }))
  const entry = object(entries[id], 'Atlas entry')
  if (number(entry.value.ID, 'Atlas ID') !== id) throw new Error('Atlas entry identity does not match its position')
  if (number(entry.value.S, 'Atlas state') < state) {
    entry.value.S = int(state)
    entry.value[state === ATLAS.acquired ? 'AT' : 'ST'] = { type: 'datetime', value: BigInt(now.getTime()) }
  }
}
