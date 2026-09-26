import { definitionLineageRootRef } from '../domain/definitions'
import { modState, type ModState } from '../domain/mods'
import type { EntityRef, Profile, RulesetRevision } from '../domain/types'
import { STARTER_NAME_RECORDS } from './data'
import { STARTER_CATALOG_ID, STARTER_CATALOG_REVISION_ID } from './starter'

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

// Associations come from the bundled Equipment Expansion sheet and publisher DLC descriptions
// Exact identities keep unrelated imports and same-name personal definitions unclassified
const REQUIRED_MOD_BY_ENTITY: ReadonlyMap<string, string> = new Map([
  ...STARTER_NAME_RECORDS.filter(record => record[3] === 'equipment-expansion-sheet').map(record => [record[0], 'Equipment Expansion'] as const),
  ['mod-pack-2:class:bloodmage', 'Bloodmage'],
  ['mod-pack-2:class:tempest', 'Tempest'],
  ['mod-pack-2:class:forcemage', 'Forcemage'],
  ['mod-pack-2:class:barbarian', 'Barbarian'],
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

export function definitionModAvailability(profile: Profile, ref: EntityRef, ruleset?: RulesetRevision): DefinitionModAvailability {
  const root = definitionLineageRootRef(profile, ref)
  const requiredMod = root.kind === 'catalog' && root.catalogId === STARTER_CATALOG_ID && root.catalogRevisionId === STARTER_CATALOG_REVISION_ID ? REQUIRED_MOD_BY_ENTITY.get(root.entityId) : undefined
  return requiredMod ? { state: modState(ruleset, requiredMod), requiredMod } : { state: 'unknown' }
}

export function modAvailabilityLabel(availability: DefinitionModAvailability): string | undefined {
  if (!availability.requiredMod) return undefined
  const state = availability.state === 'unknown' ? 'setting unknown' : availability.state === 'conflicting' ? 'setting conflicts' : availability.state
  return `${availability.requiredMod}: ${state}`
}
