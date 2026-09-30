import { asTimestamp, assertExpectedRevision, DomainError, nowTimestamp, requirePlaythrough, updatePlaythrough } from './core'
import { logicalEntityKey } from './definitions'
import { upsertProgress } from './characters'
import type { EntityRef, Knowledge, LocalData, PartyProgressRecord, ProgressStage, Timestamp } from './types'

export const CLASS_SEAL_STAGES: readonly ProgressStage[] = Object.freeze([
  'notAcquired',
  'unlocked',
  'mastered',
  'sealAcquired',
])

const STAGE_INDEX = new Map(CLASS_SEAL_STAGES.map((stage, index) => [stage, index]))

const BOOLEAN_FACTS: Readonly<Record<ProgressStage, {
  readonly unlocked: boolean
  readonly partyMastery: boolean
  readonly collection: boolean
}>> = Object.freeze({
  notAcquired: { unlocked: false, partyMastery: false, collection: false },
  unlocked: { unlocked: true, partyMastery: false, collection: false },
  mastered: { unlocked: true, partyMastery: true, collection: false },
  sealAcquired: { unlocked: true, partyMastery: true, collection: true },
})

function known(value: boolean): Knowledge<boolean> {
  return { state: 'known', value }
}

export function classSealStage(record?: PartyProgressRecord): ProgressStage {
  if (!record) return 'notAcquired'
  if (record.stage.state === 'known' && STAGE_INDEX.has(record.stage.value)) return record.stage.value
  if (record.collection.state === 'known' && record.collection.value) return 'sealAcquired'
  if (record.partyMastery.state === 'known' && record.partyMastery.value) return 'mastered'
  if (record.unlocked.state === 'known' && record.unlocked.value) return 'unlocked'
  return 'notAcquired'
}

export function nextClassSealStage(stage: ProgressStage): ProgressStage {
  const index = STAGE_INDEX.get(stage) ?? 0
  return CLASS_SEAL_STAGES[(index + 1) % CLASS_SEAL_STAGES.length]!
}

export function classSealStageFacts(stage: ProgressStage): {
  readonly stage: Knowledge<ProgressStage>
  readonly unlocked: Knowledge<boolean>
  readonly partyMastery: Knowledge<boolean>
  readonly collection: Knowledge<boolean>
} {
  const facts = BOOLEAN_FACTS[stage]
  return {
    stage: { state: 'known', value: stage },
    unlocked: known(facts.unlocked),
    partyMastery: known(facts.partyMastery),
    collection: known(facts.collection),
  }
}

export interface AdvanceClassSealProgressInput {
  readonly subject: EntityRef
  readonly displayName: string
  readonly expectedRevision?: number
  readonly now?: string
}

export function advanceClassSealProgress(localData: LocalData, input: AdvanceClassSealProgressInput): LocalData {
  const playthrough = requirePlaythrough(localData)
  const current = Object.values(playthrough.progress).find(record => logicalEntityKey(localData, record.subject) === logicalEntityKey(localData, input.subject))
  const facts = classSealStageFacts(nextClassSealStage(classSealStage(current)))
  return upsertProgress(localData, {
    ...(current ? { id: current.id, subject: current.subject } : { subject: input.subject }),
    displayName: input.displayName,
    ...facts,
    expectedRevision: input.expectedRevision,
    now: input.now,
  })
}

export interface ClassSealProgressSelection {
  readonly subject: EntityRef
  readonly displayName: string
}

export interface SetClassSealProgressBatchInput {
  readonly selections: readonly ClassSealProgressSelection[]
  readonly stage: ProgressStage
  readonly expectedRevision?: number
  readonly now?: Timestamp | string
}

export function setClassSealProgressBatch(localData: LocalData, input: SetClassSealProgressBatchInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  if (input.selections.length === 0) return localData
  const playthrough = requirePlaythrough(localData)
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const facts = classSealStageFacts(input.stage)
  const seen = new Set<string>()
  const changedPaths: string[] = []
  let staged = localData
  for (const selection of input.selections) {
    const key = logicalEntityKey(localData, selection.subject)
    if (seen.has(key)) throw new DomainError('DUPLICATE_REFERENCE', 'Bulk progress selection repeats a class subject')
    seen.add(key)
    const stagedPlaythrough = requirePlaythrough(staged, playthrough.id)
    const current = Object.values(stagedPlaythrough.progress).find(record => logicalEntityKey(staged, record.subject) === key)
    staged = upsertProgress(staged, {
      playthroughId: playthrough.id,
      ...(current ? { id: current.id, subject: current.subject } : { subject: selection.subject }),
      displayName: selection.displayName,
      ...facts,
      expectedRevision: staged.revision,
      now: at,
    })
    const updated = Object.values(requirePlaythrough(staged, playthrough.id).progress).find(record => logicalEntityKey(staged, record.subject) === key)
    if (updated) changedPaths.push(`progress.${updated.id}`)
  }
  return updatePlaythrough(localData, playthrough.id, { progress: requirePlaythrough(staged, playthrough.id).progress }, 'progress.bulkSetStage', changedPaths, at)
}

export function acquisitionState(record?: PartyProgressRecord): Knowledge<boolean> {
  return record?.collection ?? { state: 'known', value: false }
}

export interface SetAcquisitionProgressInput {
  readonly subject: EntityRef
  readonly displayName: string
  readonly acquired: boolean
  readonly expectedRevision?: number
  readonly now?: Timestamp | string
}

export function setAcquisitionProgress(localData: LocalData, input: SetAcquisitionProgressInput): LocalData {
  const current = Object.values(requirePlaythrough(localData).progress).find(record => logicalEntityKey(localData, record.subject) === logicalEntityKey(localData, input.subject))
  const notApplicable = { state: 'notApplicable' } as const
  return upsertProgress(localData, {
    ...(current ? { id: current.id, subject: current.subject } : { subject: input.subject }),
    displayName: input.displayName,
    collection: { state: 'known', value: input.acquired },
    ...(!current ? { stage: notApplicable, unlocked: notApplicable, partyMastery: notApplicable, masterLocation: notApplicable } : {}),
    expectedRevision: input.expectedRevision,
    now: input.now,
  })
}
