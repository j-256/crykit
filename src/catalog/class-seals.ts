import type { EntityId } from '../domain/types'

export interface VanillaClassSealPair {
  readonly classEntityId: EntityId
  readonly sealEntityId: EntityId
}

function pair(classSlug: string): VanillaClassSealPair {
  return {
    classEntityId: `base:class:${classSlug}` as EntityId,
    sealEntityId: `base:item:${classSlug}-seal` as EntityId,
  }
}

export const VANILLA_CLASS_SEAL_PAIRS: readonly VanillaClassSealPair[] = Object.freeze([
  pair('warrior'),
  pair('monk'),
  pair('rogue'),
  pair('cleric'),
  pair('wizard'),
  pair('warlock'),
  pair('fencer'),
  pair('shaman'),
  pair('scholar'),
  pair('aegis'),
  pair('hunter'),
  pair('chemist'),
  pair('reaper'),
  pair('ninja'),
  pair('nomad'),
  pair('dervish'),
  pair('beatsmith'),
  pair('samurai'),
  pair('assassin'),
  pair('valkyrie'),
  pair('summoner'),
  pair('beastmaster'),
  pair('weaver'),
  pair('mimic'),
])
