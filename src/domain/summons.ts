import { SUMMONS, type Summon, type SummonId } from '../catalog/summons'
import { STARTER_CATALOG_ID } from '../catalog/starter'
import { upsertProgress } from './characters'
import { assertExpectedRevision, DomainError, requirePlaythrough } from './core'
import { logicalEntityKey, logicalEntityRef } from './definitions'
import type { EntityRef, Knowledge, LocalData, PartyProgressRecord, PlaythroughId, Timestamp } from './types'

export function summonUnlockState(summon: Summon, record?: PartyProgressRecord): Knowledge<boolean> {
  return summon.starting ? { state: 'known', value: true } : record?.unlocked ?? { state: 'known', value: false }
}

export function toggleSummonProgress(localData: LocalData, input: {
  readonly summonId: SummonId
  readonly subject: EntityRef
  readonly displayName: string
  readonly playthroughId: PlaythroughId
  readonly expectedRevision?: number
  readonly now?: Timestamp | string
}): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const summon = SUMMONS.find(summon => summon.id === input.summonId)
  if (!summon) throw new DomainError('INVALID_INPUT', 'The summon does not exist')
  const root = logicalEntityRef(localData, input.subject)
  if (root.kind !== 'catalog' || root.catalogId !== STARTER_CATALOG_ID || root.entityId !== input.summonId) throw new DomainError('INVALID_INPUT', 'The reference does not match the summon')
  const playthrough = requirePlaythrough(localData, input.playthroughId)
  if (summon.starting) throw new DomainError('INVALID_INPUT', 'The starting summon is always unlocked')
  const key = logicalEntityKey(localData, input.subject)
  const current = Object.values(playthrough.progress).find(record => logicalEntityKey(localData, record.subject) === key)
  const state = summonUnlockState(summon, current)
  const notApplicable = { state: 'notApplicable' } as const
  return upsertProgress(localData, {
    playthroughId: playthrough.id,
    ...(current ? { id: current.id, subject: current.subject } : { subject: input.subject }),
    displayName: input.displayName,
    unlocked: { state: 'known', value: !(state.state === 'known' && state.value) },
    ...(!current ? { stage: notApplicable, collection: notApplicable, partyMastery: notApplicable, masterLocation: notApplicable } : {}),
    expectedRevision: input.expectedRevision,
    now: input.now,
  })
}
