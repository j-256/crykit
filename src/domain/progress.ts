import { asTimestamp, assertExpectedRevision, DomainError, nowTimestamp, updateProfile } from './core'
import { logicalEntityKey } from './definitions'
import { upsertProgress } from './characters'
import type { EntityRef, Knowledge, PartyProgressRecord, Profile, ProgressStage, Timestamp } from './types'

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

export function advanceClassSealProgress(profile: Profile, input: AdvanceClassSealProgressInput): Profile {
  const current = Object.values(profile.progress).find(record => logicalEntityKey(profile, record.subject) === logicalEntityKey(profile, input.subject))
  const facts = classSealStageFacts(nextClassSealStage(classSealStage(current)))
  return upsertProgress(profile, {
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

export function setClassSealProgressBatch(profile: Profile, input: SetClassSealProgressBatchInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  if (input.selections.length === 0) return profile
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const facts = classSealStageFacts(input.stage)
  const seen = new Set<string>()
  const changedPaths: string[] = []
  let staged = profile
  for (const selection of input.selections) {
    const key = logicalEntityKey(profile, selection.subject)
    if (seen.has(key)) throw new DomainError('DUPLICATE_REFERENCE', 'Bulk progress selection repeats a class subject')
    seen.add(key)
    const current = Object.values(staged.progress).find(record => logicalEntityKey(staged, record.subject) === key)
    staged = upsertProgress(staged, {
      ...(current ? { id: current.id, subject: current.subject } : { subject: selection.subject }),
      displayName: selection.displayName,
      ...facts,
      expectedRevision: staged.revision,
      now: at,
    })
    const updated = Object.values(staged.progress).find(record => logicalEntityKey(staged, record.subject) === key)
    if (updated) changedPaths.push(`progress.${updated.id}`)
  }
  return updateProfile(profile, { progress: staged.progress }, 'progress.bulkSetStage', changedPaths, at)
}
