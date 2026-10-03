import { DEFAULT_CATALOG } from '../catalog/bundled'
import { previewImport } from '../interchange/import'
import type { EntityId, ModComposition } from './types'

export async function syntheticModLayers() {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  const first = await previewImport(encode({ ID: 'layer-a', Title: 'Layer A', EditorVersion: 34, Jobs: [{ ID: 0, Name: 'First Fighter', HPRating: 70, EquipmentTypes: [0], AbilityIDs: [8], PassiveIDs: [2] }], Equipment: [{ ID: 50, Name: 'First Sword', EquipmentType: 0, IsTwoHanded: false }], Items: [{ ID: 50, Name: 'Different family' }] }), 'a.json')
  const second = await previewImport(encode({ ID: 'layer-b', Title: 'Layer B', EditorVersion: 34, Jobs: [{ ID: 0, Name: 'Second Fighter', HPRating: 0, AbilityIDs: [], PassiveIDs: [2] }], Abilities: [{ ID: 8, Name: 'Shared Ability' }], Passives: [{ ID: 2, Name: 'Shared Passive', PP: 2, IsInnate: true, Description: 'Equip anything regardless of current Class.' }] }), 'b.json')
  const catalogs = [DEFAULT_CATALOG, first.proposed.catalogs[0]!, second.proposed.catalogs[0]!]
  const composition: ModComposition = { baseline: { catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId }, layers: catalogs.slice(1).map(catalog => ({ catalogId: catalog.id, catalogRevisionId: catalog.revisionId, enabled: true })), links: [{ modelKey: 'crystal-edit:Jobs:0', targetEntityId: 'base:job:0' as EntityId }] }
  return { catalogs, composition, first, second }
}
