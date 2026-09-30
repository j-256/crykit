import type { CatalogEntity, CatalogSnapshot, EntityId, Knowledge, JsonValue, SourceRef } from '../domain/types'

export interface TravelUnlockGroup {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly entityIds: readonly EntityId[]
}

export const TRAVEL_UNLOCK_GROUPS: readonly TravelUnlockGroup[] = Object.freeze([
  { id: 'mounts', label: 'Mount instruments', description: 'Permanent mount instruments, including the upgraded Quintar and Salmon calls.', entityIds: ['wiki:item:quintar-flute', 'wiki:item:quintar-ocarina', 'wiki:item:ibek-bell', 'wiki:item:owl-drum', 'wiki:item:salmon-violin', 'wiki:item:salmon-cello'] as EntityId[] },
  { id: 'stones', label: 'Shrine stones', description: 'Reusable travel stones. Single-use shards are separate inventory items.', entityIds: ['wiki:item:gaea-stone', 'wiki:item:mercury-stone', 'wiki:item:poseidon-stone', 'wiki:item:mars-stone', 'wiki:item:ganymede-stone', 'wiki:item:triton-stone', 'wiki:item:callisto-stone', 'wiki:item:europa-stone', 'wiki:item:dione-stone', 'wiki:item:neptune-stone', 'wiki:item:new-world-stone', 'wiki:item:old-world-stone'] as EntityId[] },
  { id: 'capabilities', label: 'Capability items', description: 'Exploration tools, fishing rods, and passes that open up more of the game.', entityIds: ['wiki:item:treasure-finder', 'wiki:item:home-point-stone', 'wiki:item:babel-quintar', 'base:item:quintar-pass', 'wiki:item:skeleton-key', 'wiki:item:luxury-pass', 'base:item:luxury-pass-v2', 'wiki:item:watering-can', 'base:item:flimsy-rod', 'base:item:tough-rod', 'base:item:super-rod'] as EntityId[] },
])

const APPLICABILITY = 'Community wiki evidence; Nintendo Switch and enabled-mod applicability are unverified'
const TOOLS_SOURCE: SourceRef = { sourceId: 'https://crystal-project.fandom.com/wiki/Tools?oldid=7601', snapshot: 'revision 7601', applicability: APPLICABILITY }

interface ItemSupplement {
  readonly slug: string
  readonly name: string
  readonly description: string
  readonly location: string
  readonly source: SourceRef
}

function itemDefinition(item: ItemSupplement): CatalogEntity {
  const known = (value: JsonValue): Knowledge<JsonValue> => ({ state: 'known', value, sources: [item.source] })
  return {
    id: `wiki:item:${item.slug}` as EntityId,
    kind: 'item',
    name: item.name,
    aliases: [],
    rawDescription: `${item.description} ${item.location}`,
    fields: { Category: known(['Tools']), Description: known(item.description), Location: known(item.location) },
    sources: [item.source],
    slotKinds: { state: 'notApplicable', reason: 'This travel tool is not equipment' },
    ppCost: { state: 'notApplicable', reason: 'PP does not apply to this travel tool' },
    requirements: { state: 'unknown', reason: 'The source describes acquisition, but does not establish normalized build requirements', sources: [item.source] },
    grants: { state: 'notApplicable', reason: 'Travel capabilities do not grant build permissions' },
  }
}

export function addTravelUnlockDefinitions(base: CatalogSnapshot): CatalogSnapshot {
  const mounts = base.entities['wiki:other:mounts']
  const mountSource = (section: string): SourceRef => {
    const field = mounts?.fields[`Section: ${section}`]
    const source = field?.state === 'known' ? field.sources?.[0] : undefined
    if (!source) throw new Error(`Missing mount acquisition source: ${section}`)
    return source
  }
  const supplements: readonly ItemSupplement[] = [
    { slug: 'ibek-bell', name: 'Ibek Bell', description: 'Summons an Ibek mount.', location: 'Reward for clearing the Ancient Reservoir in Poko Poko Desert.', source: mountSource('Ibek') },
    { slug: 'owl-drum', name: 'Owl Drum', description: 'Summons an Owl mount.', location: "Reach the Callisto Shrine at the summit of Land's End.", source: mountSource('Owl') },
    { slug: 'salmon-cello', name: 'Salmon Cello', description: 'Summons the faster Salmon mount.', location: 'Finish first in the Salmon Run.', source: mountSource('Salmon') },
    { slug: 'new-world-stone', name: 'New World Stone', description: 'Reusable travel to New World Temple.', location: 'New World Temple Shop, Castle Sequoia.', source: { ...TOOLS_SOURCE, locator: 'Tools according to Archive > row 29, New World Stone' } },
    { slug: 'old-world-stone', name: 'Old World Stone', description: 'Reusable travel to The Old World Temple.', location: 'Particular Ore. The Tools table does not give further acquisition requirements.', source: { ...TOOLS_SOURCE, locator: 'Tools according to Archive > row 31, Old World Stone' } },
  ]
  const entities = { ...base.entities }
  for (const item of supplements) {
    const entity = itemDefinition(item)
    if (entities[entity.id]) throw new Error(`Travel supplement would replace a catalog definition: ${entity.id}`)
    entities[entity.id] = entity
  }
  return { ...base, entities }
}
