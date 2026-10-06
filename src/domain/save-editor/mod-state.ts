import { type CrystalSave, type BsonDocument } from '../../interchange/crystal-save.ts'
import { type SaveEditorCatalog, type SaveEditorMode, saveEditorCatalogForMode } from '../save-editor-mods'
import { number, flags, int, object, document, list, array, string, unsignedBigInt } from './values.ts'
import { LEGACY_HEADER, type Family } from './model.ts'

const MOD_GROUP_FIELDS = Object.freeze({ abilities: 'Abilities', animations: 'Animations', biomes: 'Biomes', difficulties: 'Difficulties', equipment: 'Equipment', genders: 'Genders', items: 'Items', jobs: 'Jobs', monsters: 'Monsters', passives: 'Passives', recipes: 'Recipes', sparks: 'Sparks', statuses: 'Statuses', troops: 'Troops', entities: 'Entities' })

export function saveEditorMode(save: CrystalSave, nativeCatalog: SaveEditorCatalog): SaveEditorMode {
  const bodyMode = number(flags(save).value.PatchMode ?? int(0), 'Patch mode')
  if (save.header.patchMode !== bodyMode) throw new Error('Header and party game modes disagree')
  return saveEditorCatalogForMode(nativeCatalog, bodyMode).mode
}

export function partyModDocument(save: CrystalSave): BsonDocument {
  return object(save.party.value.Mods ?? (save.header.version < LEGACY_HEADER.mods ? document({ IsModded: { type: 'boolean', value: false }, Mods: list([]), Redirects: list([]) }) : undefined), 'Mods')
}

export function partyModList(mods: BsonDocument): { id: string; title: string; version: string; steamWorkshopFileId: bigint }[] {
  return array(mods.value.Mods, 'Mods').map((entry, index) => {
    const value = object(entry, `Mod ${index + 1}`).value
    return { id: string(value.ID, 'Mod ID'), title: string(value.Title, 'Mod title'), version: string(value.Version, 'Mod version'), steamWorkshopFileId: unsignedBigInt(value.SteamWorkshopFileID, 'Steam Workshop ID') }
  })
}

export function partyModMaps(mods: BsonDocument): CrystalSave['header']['modIdMaps'] {
  return array(mods.value.Redirects, 'Mod redirects').map((entry, index) => {
    const value = object(entry, `Mod redirect ${index + 1}`).value
    const groups: CrystalSave['header']['modIdMaps'][number]['groups'] = Object.create(null)
    for (const [group, field] of Object.entries(MOD_GROUP_FIELDS)) {
      const collection = object(value[field], `${field} redirects`).value
      const ids = array(collection.IDs, `${field} redirect IDs`).map(pair => {
        const item = object(pair, `${field} redirect`).value
        return { originalId: number(item.O, 'Original ID'), newId: number(item.N, 'New ID') }
      })
      if (number(collection.Count, `${field} redirect count`) !== ids.length) throw new Error(`${field} redirect count is inconsistent`)
      groups[group] = ids
    }
    return { modId: string(value.ModID, 'Redirect mod ID'), groups }
  })
}

export function sameModList(left: CrystalSave['header']['mods'], right: CrystalSave['header']['mods']): boolean {
  return left.length === right.length && left.every((mod, index) => {
    const other = right[index]
    return other && mod.id === other.id && mod.title === other.title && mod.version === other.version && mod.steamWorkshopFileId === other.steamWorkshopFileId
  })
}

export function sameModMaps(left: CrystalSave['header']['modIdMaps'], right: CrystalSave['header']['modIdMaps']): boolean {
  return left.length === right.length && left.every((map, index) => {
    const other = right[index]
    if (!other || map.modId !== other.modId) return false
    return Object.keys(MOD_GROUP_FIELDS).every(group => {
      const pairs = map.groups[group] ?? []
      const otherPairs = other.groups[group] ?? []
      return pairs.length === otherPairs.length && pairs.every((pair, pairIndex) => pair.originalId === otherPairs[pairIndex]?.originalId && pair.newId === otherPairs[pairIndex]?.newId)
    })
  })
}

export function nativeBound(catalog: SaveEditorCatalog, family: Family): number {
  return Math.max(-1, ...catalog.records[family].keys()) + 1
}
