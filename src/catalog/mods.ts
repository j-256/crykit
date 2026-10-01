import { definitionLineageRootRef } from '../domain/definitions'
import { modState, type ModState } from '../domain/mods'
import type { CatalogSnapshot, EntityRef, LocalData, GameSetupRevision } from '../domain/types'
import { EQUIPMENT_EXPANSION_ENTITY_IDS } from './equipment-expansion'
import { SWITCH_CLASS_RECORDS } from './switch'
import { STARTER_CATALOG_ID, STARTER_CATALOG_REVISION_ID } from './starter'
import { bundledModIdentity } from '../domain/bundled-mods'
import { nativeRecord } from '../domain/native-game'
import { catalogEntity } from '../domain/entity-identities'
import moonlightLinks from './moonlight-project-links-v1.json' with { type: 'json' }

export const MOONLIGHT_PROJECT_MOD = 'Moonlight Project'

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
      MOONLIGHT_PROJECT_MOD,
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
  gameVersion: '1.6.6',
  enabledMods: Object.freeze([
    'Passive Trainer',
    'Doge Shield',
    'Equipment Expansion',
    MOONLIGHT_PROJECT_MOD,
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
const CURRENT_EQUIPMENT_EXPANSION_IDS = new Set(EQUIPMENT_EXPANSION_ENTITY_IDS)
const MOONLIGHT_OBSERVED_CLASS_IDS = new Set(moonlightLinks.classes.map(entry => entry.observationEntityId))
const REQUIRED_MOD_BY_ENTITY: ReadonlyMap<string, string> = new Map([
  ...SWITCH_CLASS_RECORDS.flatMap(record => {
    const mod = MOONLIGHT_OBSERVED_CLASS_IDS.has(record.id) ? MOONLIGHT_PROJECT_MOD : record.requiredMod
    return mod ? [record.id, ...record.skills.map(([id]) => id), ...(record.innate ? [record.innate.id] : [])].map(id => [id, mod] as const) : []
  }),
  ['mod:bloodmage:class:bloodmage', 'Bloodmage'],
  ['mod:forcemage:class:forcemage', 'Forcemage'],
  ['mod:doge-shield:item:doge-shield', 'Doge Shield'],
  ['mod:additional-boss-yasha-tar:monster:yasha-tar', 'Additional Boss: Yasha Tar'],
  ['mod:additional-boss-pinga:monster:pinga', 'Additional Boss: Pinga'],
  ['mod:additional-boss-quintar-husk:monster:quintar-husk', 'Additional Boss: Quintar Husk'],
  ['mod:additional-boss-elder-entities:monster:elder-entities', 'Additional Boss: Elder Entities'],
])

export interface DefinitionModAvailability {
  readonly state: ModState
  readonly requiredMod?: string
}

export function definitionModAvailability(localData: LocalData, ref: EntityRef, gameSetup?: GameSetupRevision, catalogs: readonly CatalogSnapshot[] = []): DefinitionModAvailability {
  const root = definitionLineageRootRef(localData, ref)
  const catalog = root.kind === 'catalog' ? catalogs.find(value => value.id === root.catalogId && value.revisionId === root.catalogRevisionId) : undefined
  const entity = root.kind === 'catalog' && catalog ? catalogEntity(catalog, root.entityId) : undefined
  const effectiveLayer = entity?.fields['Effective mod layer']
  if (effectiveLayer?.state === 'known' && typeof effectiveLayer.value === 'string') return { requiredMod: effectiveLayer.value, state: gameSetup?.catalogLock[catalog!.id] === catalog!.revisionId ? 'enabled' : 'unknown' }
  const bundledMod = entity && bundledModIdentity(entity)
  if (bundledMod) return { requiredMod: bundledMod.requiredMod, state: modState(gameSetup, bundledMod.requiredMod) }
  const explicitMod = nativeRecord(entity?.legacy) ? entity.legacy.requiredMod : undefined
  if (typeof explicitMod === 'string') return { requiredMod: explicitMod, state: modState(gameSetup, explicitMod) }
  const baselineRevision = gameSetup?.modComposition && root.kind === 'catalog' && root.catalogId === gameSetup.modComposition.baseline.catalogId && root.catalogRevisionId === gameSetup.catalogLock[root.catalogId] ? gameSetup.modComposition.baseline.catalogRevisionId : root.kind === 'catalog' ? root.catalogRevisionId : undefined
  const validCatalog = root.kind === 'catalog' && root.catalogId === STARTER_CATALOG_ID && baselineRevision !== undefined && baselineRevision === STARTER_CATALOG_REVISION_ID
  const equipmentExpansion = validCatalog && CURRENT_EQUIPMENT_EXPANSION_IDS.has(root.entityId)
  const requiredMod = validCatalog ? equipmentExpansion ? 'Equipment Expansion' : REQUIRED_MOD_BY_ENTITY.get(root.entityId) : undefined
  return requiredMod ? { state: modState(gameSetup, requiredMod), requiredMod } : { state: 'unknown' }
}

export function modAvailabilityLabel(availability: DefinitionModAvailability): string | undefined {
  if (!availability.requiredMod) return undefined
  const state = availability.state === 'unknown' ? 'enabled status not recorded' : availability.state === 'conflicting' ? 'enabled status has conflicting records' : availability.state
  return `${availability.requiredMod} mod: ${state}`
}

export function modPlanningReason(availability: DefinitionModAvailability | undefined): string | undefined {
  if (!availability?.requiredMod || availability.state === 'enabled') return undefined
  const reason = availability.state === 'disabled' ? "Mod disabled in this Build's Game Setup" : availability.state === 'conflicting' ? "Conflicting mod settings in this Build's Game Setup" : "Mod status unknown in this Build's Game Setup"
  return `${reason}. You can still select it.`
}
