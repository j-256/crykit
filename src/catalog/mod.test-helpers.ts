import type { BundledModSnapshot } from '../domain/bundled-mods'
import type { BundledLibraryMod } from '../domain/mod-library'
import type { CatalogId, CatalogSnapshot, CatalogRevisionId, EntityId } from '../domain/types'

export const SYNTHETIC_MOD_SNAPSHOT: BundledModSnapshot = {
  schemaVersion: 1, key: 'synthetic-library', requiredMod: 'Synthetic Library', contentDigest: 'synthetic-fixture',
  source: { projectId: 'synthetic-library', title: 'Synthetic Library', version: '2.2', editorVersion: 34, sha256: 'a'.repeat(64), timestamp: null, author: 'Synthetic Author', steamWorkshopFileId: null },
  families: {
    Jobs: [{ ID: 26, Name: 'Synthetic Class', IsUnselectableJob: false, IsUnselectableSubJob: false, IsNotCrystalJob: false, HPRating: 80, MPRating: 80, StrRating: 80, VitRating: 80, DexRating: 80, AgiRating: 80, MndRating: 80, SpiRating: 80, SpdRating: 80, LckRating: 80, EquipmentTypes: [0], AbilityIDs: [565], PassiveIDs: [9000], LearnTree: [[{ NodeType: 2, DataID: 565, LP: 4, PrereqLeft: false, PrereqMiddle: false, PrereqRight: false }, { NodeType: 3, DataID: 9000, LP: 2, PrereqLeft: false, PrereqMiddle: false, PrereqRight: false }]] }],
    Abilities: [{ ID: 565, Name: 'Synthetic Technique', Description: 'Synthetic action', IsPAbil: false, IsMAbil: true, JP: 400, MPCost: 0, APCost: 0, HPCost: 0, CTCost: 0, CDCost: 0, AbilityMods: [] }],
    Passives: [{ ID: 9000, Name: 'Synthetic Passive', PP: 2, StatMods: [], IsInnate: true, IsLearnable: true, IsDefaultLocked: false, JP: 200 }],
    Equipment: [{ ID: 9000, Name: 'Synthetic Blade', EquipmentType: 0, IsTwoHanded: false, StatMods: [{ Tag: 40, Value1: 7, Value2: 0 }] }],
  },
}

export const SYNTHETIC_BUNDLED_MOD: BundledLibraryMod = {
  id: 'crystal-edit:synthetic-library' as CatalogId, key: 'synthetic-library', title: 'Synthetic Library', declaredVersion: '2.2', editorVersion: 34, sourceDigest: `sha256:${'a'.repeat(64)}`, models: { Jobs: [26], Abilities: [565], Passives: [9000], Equipment: [9000] }, catalogNames: ['Synthetic Library'],
}

// This fixture uses attributed reference observations, not Crystal Edit project records
export function referenceObservationFixture(catalog: CatalogSnapshot, entityIds: ReadonlyMap<string, EntityId>): CatalogSnapshot {
  const entities = Object.fromEntries(Object.values(catalog.entities).map(entity => {
    const id = entityIds.get(entity.id) ?? entity.id
    return [id, { ...entity, id, fields: { ...entity.fields, ...(entity.id.startsWith('mod:equipment-expansion:') ? { 'Source mod': { state: 'known' as const, value: 'Equipment Expansion', sources: [{ sourceId: 'synthetic-reference-observation' }] } } : {}) } }]
  }))
  return { ...catalog, id: 'synthetic-reference-observations' as CatalogId, revisionId: 'synthetic-observations-v1' as CatalogRevisionId, checksum: 'synthetic-observations', entities }
}
