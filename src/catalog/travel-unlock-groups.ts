import type { EntityId } from '../domain/types'

export interface TravelUnlockGroup {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly entityIds: readonly EntityId[]
}

export const TRAVEL_UNLOCK_GROUPS: readonly TravelUnlockGroup[] = Object.freeze([
  { id: 'mounts', label: 'Mount instruments', description: 'Permanent mount instruments, including the upgraded Quintar and Salmon calls.', entityIds: ['base:item:39', 'base:item:115', 'base:item:50', 'base:item:49', 'base:item:48', 'base:item:114'] as EntityId[] },
  { id: 'stones', label: 'Shrine stones', description: 'Reusable travel stones. Single-use shards are separate inventory items.', entityIds: ['base:item:23', 'base:item:13', 'base:item:57', 'base:item:59', 'base:item:65', 'base:item:66', 'base:item:155', 'base:item:64', 'base:item:166', 'base:item:208', 'base:item:140', 'base:item:253'] as EntityId[] },
  { id: 'capabilities', label: 'Capability items', description: 'Exploration tools, fishing rods, and passes that open up more of the game.', entityIds: ['base:item:196', 'base:item:19', 'base:item:167', 'base:item:7', 'base:item:147', 'base:item:93', 'base:item:148', 'base:item:186', 'base:item:55', 'base:item:150', 'base:item:151'] as EntityId[] },
])
