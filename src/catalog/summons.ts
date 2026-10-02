import identities from './class-tree-identities.json' with { type: 'json' }
import { LEARN_NODE_TYPES } from '../domain/crystal-edit'
import { baseGameEntityId } from '../domain/entity-identities'
import type { EntityId } from '../domain/types'

const DEITIES = Object.freeze({
  'base:summoner:ability:pinga': { title: 'Healing', monsterId: 96 },
  'base:summoner:ability:pah': { title: 'Reflection', monsterId: 97 },
  'base:summoner:ability:shaku': { title: 'Fire', monsterId: 102 },
  'base:summoner:ability:pamoa': { title: 'Ice', monsterId: 91 },
  'base:summoner:ability:niltsi': { title: 'Wind', monsterId: 93 },
  'base:summoner:ability:ioske': { title: 'Earth', monsterId: 92 },
  'base:summoner:ability:guaba': { title: 'Thunder', monsterId: 94 },
  'base:summoner:ability:coyote': { title: 'The Deep', monsterId: 95 },
  'base:summoner:ability:tira': { title: 'Shadow', monsterId: 98 },
  'base:summoner:ability:juses': { title: 'Life', monsterId: 99 },
})

export type SummonId = keyof typeof DEITIES

export interface Summon {
  readonly id: SummonId
  readonly name: string
  readonly title: string
  readonly label: string
  readonly monsterId: EntityId
  readonly row: number
  readonly column: number
  readonly starting: boolean
}

const abilities = identities.classes['base:class:summoner'].nodes.filter(node => node.nodeType === LEARN_NODE_TYPES.ability)
const firstRow = Math.min(...abilities.map(node => node.row))

export const SUMMONS: readonly Summon[] = Object.freeze(abilities.map(node => {
  if (!Object.hasOwn(DEITIES, node.entityId)) throw new Error(`Summon metadata is missing for ${node.entityId}`)
  const id = node.entityId as SummonId
  const deity = DEITIES[id]
  return Object.freeze({ id, name: node.name, title: deity.title, label: `${node.name}, Deity of ${deity.title}`, monsterId: baseGameEntityId('monster', deity.monsterId), row: node.row - firstRow, column: node.column, starting: node.jp === 0 })
}))
