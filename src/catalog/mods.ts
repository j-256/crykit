import { definitionLineageRootRef } from '../domain/definitions'
import { modState, type ModState } from '../domain/mods'
import type { CatalogSnapshot, EntityRef, LocalData, GameSetupRevision } from '../domain/types'
import { STARTER_NAME_RECORDS } from './data'
import { EQUIPMENT_EXPANSION_ENTITY_IDS } from './equipment-expansion'
import { SWITCH_CLASS_RECORDS } from './switch'
import { STARTER_CATALOG_ID, STARTER_CATALOG_REVISION_ID } from './starter'
import { BUNDLED_CATALOG_REVISION_ID, BUNDLED_V1_CATALOG_REVISION_ID } from './bundled-catalog'

export const SWITCH_MOD_PACKS = Object.freeze([
  {
    id: 'switch-mod-pack-1',
    name: 'Mod Pack 1: Quality Fun',
    mods: Object.freeze([
      'Appearance Passives',
      'Pointier Hat',
      'Golden Quintar High Jump',
      'Cheap Maps',
      "Cheap Teleport Shards n' Stones",
      'Learnable Innate Skill',
      '1 PP Passives',
      'Unrestricted Weapon Skills',
      'Free Maps',
      'Modern Kids',
    ]),
  },
  {
    id: 'switch-mod-pack-2',
    name: 'Mod Pack 2: New Challenges',
    mods: Object.freeze([
      'Passive Trainer',
      'Doge Shield',
      'Equipment Expansion',
      'Moonlight Project Custom Bosses',
      'Bloodmage',
      'Additional Boss: Yasha Tar',
      'Additional Boss: Pinga',
      'Tempest',
      'Forcemage',
      'Barbarian',
      'Additional Boss: Quintar Husk',
      'Additional Boss: Elder Entities',
    ]),
  },
])

export const CONFIRMED_SWITCH_MOD_SETUP = Object.freeze({
  id: 'switch-confirmed-mod-setup',
  label: 'Switch: confirmed mod setup',
  platform: 'Nintendo Switch',
  gameVersion: null,
  enabledMods: Object.freeze([
    'Passive Trainer',
    'Doge Shield',
    'Equipment Expansion',
    'Moonlight Project Custom Bosses',
    'Bloodmage',
    'Additional Boss: Yasha Tar',
    'Additional Boss: Pinga',
    'Tempest',
    'Forcemage',
    'Barbarian',
    'Appearance Passives',
    'Pointier Hat',
    'Golden Quintar High Jump',
    'Cheap Maps',
    'Learnable Innate Skill',
    'Additional Boss: Quintar Husk',
    'Additional Boss: Elder Entities',
    'Free Maps',
  ]),
  disabledMods: Object.freeze([
    "Cheap Teleport Shards n' Stones",
    '1 PP Passives',
    'Unrestricted Weapon Skills',
    'Modern Kids',
  ]),
})

// Associations come from the Equipment Expansion sheet, publisher descriptions, and in-game confirmation
// Exact identities keep unrelated imports and same-name personal definitions unclassified
const STARTER_EQUIPMENT_EXPANSION_IDS = new Set(STARTER_NAME_RECORDS.filter(record => record[3] === 'equipment-expansion-sheet').map(record => record[0]))
const CURRENT_EQUIPMENT_EXPANSION_IDS = new Set(EQUIPMENT_EXPANSION_ENTITY_IDS)
const REQUIRED_MOD_BY_ENTITY: ReadonlyMap<string, string> = new Map([
  ...SWITCH_CLASS_RECORDS.flatMap(record => {
    const mod = record.requiredMod
    return mod ? [record.id, ...record.skills.map(([id]) => id), ...(record.innate ? [record.innate.id] : [])].map(id => [id, mod] as const) : []
  }),
  ['mod-pack-2:class:bloodmage', 'Bloodmage'],
  ['mod-pack-2:class:forcemage', 'Forcemage'],
  ['mod-pack-2:item:doge-shield', 'Doge Shield'],
  ['mod-pack-2:monster:yasha-tar', 'Additional Boss: Yasha Tar'],
  ['mod-pack-2:monster:pinga', 'Additional Boss: Pinga'],
  ['mod-pack-2:monster:quintar-husk', 'Additional Boss: Quintar Husk'],
  ['mod-pack-2:monster:elder-entities', 'Additional Boss: Elder Entities'],
])

export interface DefinitionModAvailability {
  readonly state: ModState
  readonly requiredMod?: string
}

export function definitionModAvailability(localData: LocalData, ref: EntityRef, gameSetup?: GameSetupRevision, catalogs: readonly CatalogSnapshot[] = []): DefinitionModAvailability {
  const root = definitionLineageRootRef(localData, ref)
  const catalog = root.kind === 'catalog' ? catalogs.find(value => value.id === root.catalogId && value.revisionId === root.catalogRevisionId) : undefined
  const effectiveLayer = root.kind === 'catalog' ? catalog?.entities[root.entityId]?.fields['Effective mod layer'] : undefined
  if (effectiveLayer?.state === 'known' && typeof effectiveLayer.value === 'string') return { requiredMod: effectiveLayer.value, state: gameSetup?.catalogLock[catalog!.id] === catalog!.revisionId ? 'enabled' : 'unknown' }
  const baselineRevision = gameSetup?.modComposition && root.kind === 'catalog' && root.catalogId === gameSetup.modComposition.baseline.catalogId && root.catalogRevisionId === gameSetup.catalogLock[root.catalogId] ? gameSetup.modComposition.baseline.catalogRevisionId : root.kind === 'catalog' ? root.catalogRevisionId : undefined
  const validCatalog = root.kind === 'catalog' && root.catalogId === STARTER_CATALOG_ID && (baselineRevision === STARTER_CATALOG_REVISION_ID || baselineRevision === BUNDLED_V1_CATALOG_REVISION_ID || baselineRevision === BUNDLED_CATALOG_REVISION_ID)
  const equipmentExpansion = validCatalog && (baselineRevision === BUNDLED_CATALOG_REVISION_ID ? CURRENT_EQUIPMENT_EXPANSION_IDS : STARTER_EQUIPMENT_EXPANSION_IDS).has(root.entityId)
  const requiredMod = validCatalog ? equipmentExpansion ? 'Equipment Expansion' : REQUIRED_MOD_BY_ENTITY.get(root.entityId) : undefined
  return requiredMod ? { state: modState(gameSetup, requiredMod), requiredMod } : { state: 'unknown' }
}

export function modAvailabilityLabel(availability: DefinitionModAvailability): string | undefined {
  if (!availability.requiredMod) return undefined
  const state = availability.state === 'unknown' ? 'enabled status not recorded' : availability.state === 'conflicting' ? 'enabled status has conflicting records' : availability.state
  return `${availability.requiredMod} mod: ${state}`
}
