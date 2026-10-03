import identities from './class-tree-identities.json' with { type: 'json' }
import { LEARN_NODE_TYPES } from '../domain/crystal-edit'
import { baseGameEntityId } from '../domain/entity-identities'
import type { EntityId } from '../domain/types'

const DEITIES = Object.freeze({
  'base:ability:230': { title: 'Healing', monsterId: 96 },
  'base:ability:234': { title: 'Reflection', monsterId: 97 },
  'base:ability:223': { title: 'Fire', monsterId: 102 },
  'base:ability:224': { title: 'Ice', monsterId: 91 },
  'base:ability:226': { title: 'Wind', monsterId: 93 },
  'base:ability:227': { title: 'Earth', monsterId: 92 },
  'base:ability:225': { title: 'Thunder', monsterId: 94 },
  'base:ability:228': { title: 'The Deep', monsterId: 95 },
  'base:ability:231': { title: 'Shadow', monsterId: 98 },
  'base:ability:232': { title: 'Life', monsterId: 99 },
})

export type SummonId = keyof typeof DEITIES
const SUMMONER_JOB_ID = 21

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

const abilities = Object.values(identities.classes).find(entry => entry.nativeJobId === SUMMONER_JOB_ID)!.nodes.filter(node => node.nodeType === LEARN_NODE_TYPES.ability)
const firstRow = Math.min(...abilities.map(node => node.row))

export const SUMMONS: readonly Summon[] = Object.freeze(abilities.map(node => {
  const id = baseGameEntityId('ability', node.dataId) as SummonId
  if (!Object.hasOwn(DEITIES, id)) throw new Error(`Summon metadata is missing for ${id}`)
  const deity = DEITIES[id]
  return Object.freeze({ id, name: node.name, title: deity.title, label: `${node.name}, Deity of ${deity.title}`, monsterId: baseGameEntityId('monster', deity.monsterId), row: node.row - firstRow, column: node.column, starting: node.jp === 0 })
}))
