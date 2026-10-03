import type { EntityId } from '../domain/types'
import { baseGameEntityId } from '../domain/entity-identities'

export interface VanillaClassSealPair {
  readonly classEntityId: EntityId
  readonly sealEntityId: EntityId
}

function pair(classId: number, sealId: number): VanillaClassSealPair {
  return {
    classEntityId: baseGameEntityId('job', classId),
    sealEntityId: baseGameEntityId('equipment', sealId),
  }
}

export const VANILLA_CLASS_SEAL_PAIRS: readonly VanillaClassSealPair[] = Object.freeze([
  pair(0, 564),
  pair(5, 565),
  pair(2, 566),
  pair(4, 567),
  pair(3, 568),
  pair(14, 569),
  pair(1, 570),
  pair(8, 571),
  pair(13, 572),
  pair(10, 573),
  pair(7, 574),
  pair(17, 575),
  pair(6, 576),
  pair(18, 577),
  pair(12, 578),
  pair(11, 579),
  pair(9, 580),
  pair(20, 581),
  pair(19, 582),
  pair(15, 583),
  pair(21, 585),
  pair(23, 586),
  pair(16, 584),
  pair(22, 587),
])
