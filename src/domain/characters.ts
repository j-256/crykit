import {
  asTimestamp,
  assertExpectedRevision,
  assertFiniteNumber,
  assertNonnegativeInteger,
  assertPersonalDefinitionRef,
  assertTextLength,
  createId,
  DomainError,
  nowTimestamp,
  updateProfile,
} from './core'
import { logicalEntityKey } from './definitions'
import { MAX_ID_LENGTH, MAX_SHORT_TEXT_LENGTH } from './limits'
import type {
  Character,
  CharacterClassProgress,
  CharacterId,
  CharacterSnapshot,
  CharacterSnapshotId,
  EntityRef,
  Knowledge,
  LearnedNode,
  LearnedNodeKind,
  ObservedStat,
  PartyProgressRecord,
  Profile,
  ProgressRecordId,
  ProgressStage,
  RulesetRevisionId,
  SourceRef,
  Timestamp,
} from './types'

function knowledgeValues<Value>(knowledge: Knowledge<Value> | undefined): readonly Value[] {
  if (knowledge?.state === 'known') return [knowledge.value]
  if (knowledge?.state === 'conflicting') return knowledge.claims.map((claim) => claim.value)
  return []
}

function validateNonnegativeKnowledge(knowledge: Knowledge<number> | undefined, label: string): void {
  for (const value of knowledgeValues(knowledge)) assertNonnegativeInteger(value, label)
}

export interface CreateCharacterInput {
  readonly id?: CharacterId
  readonly name: string
  readonly appearanceLabel?: string
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function createCharacter(profile: Profile, input: CreateCharacterInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  const name = input.name.trim()
  if (!name) {
    throw new DomainError('INVALID_INPUT', 'Character name must not be empty')
  }
  const id = input.id ?? createId<CharacterId>('character')
  if (profile.characters[id]) {
    throw new DomainError('DUPLICATE_ID', `Character already exists: ${id}`)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const character: Character = {
    id,
    revision: 0,
    name,
    snapshots: {},
    classProgress: {},
    learnedNodes: {},
    createdAt: at,
    updatedAt: at,
    ...(input.appearanceLabel === undefined ? {} : { appearanceLabel: input.appearanceLabel }),
  }
  return updateProfile(
    profile,
    { characters: { ...profile.characters, [id]: character } },
    'character.create',
    [`characters.${id}`],
    at,
  )
}

export interface UpdateCharacterInput {
  readonly characterId: CharacterId
  readonly name?: string
  readonly appearanceLabel?: string
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function updateCharacter(profile: Profile, input: UpdateCharacterInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  const current = profile.characters[input.characterId]
  if (!current) {
    throw new DomainError('MISSING_CHARACTER', `Character does not exist: ${input.characterId}`)
  }
  const name = input.name?.trim() ?? current.name
  if (!name) {
    throw new DomainError('INVALID_INPUT', 'Character name must not be empty')
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const character: Character = {
    ...current,
    name,
    revision: current.revision + 1,
    updatedAt: at,
    ...(input.appearanceLabel === undefined ? {} : { appearanceLabel: input.appearanceLabel }),
  }
  return updateProfile(
    profile,
    { characters: { ...profile.characters, [character.id]: character } },
    'character.update',
    [`characters.${character.id}`],
    at,
  )
}

export interface CaptureCharacterInput {
  readonly characterId: CharacterId
  readonly snapshotId?: CharacterSnapshotId
  readonly rulesetRevisionId?: RulesetRevisionId
  readonly observedAt?: Timestamp | string
  readonly level?: Knowledge<number>
  readonly primaryClass?: Knowledge<EntityRef>
  readonly secondaryClass?: Knowledge<EntityRef>
  readonly displayedStats?: Readonly<Record<string, ObservedStat>>
  readonly ppCapacity?: Knowledge<number>
  readonly selections?: Readonly<Record<string, EntityRef | null>>
  readonly sources?: readonly SourceRef[]
  readonly note?: string
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

const UNKNOWN_NUMBER: Knowledge<number> = { state: 'unknown' }
const UNKNOWN_REF: Knowledge<EntityRef> = { state: 'unknown' }

export function captureCharacter(profile: Profile, input: CaptureCharacterInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  const current = profile.characters[input.characterId]
  if (!current) {
    throw new DomainError('MISSING_CHARACTER', `Character does not exist: ${input.characterId}`)
  }
  validateNonnegativeKnowledge(input.level, 'Character level')
  const rulesetRevisionId = input.rulesetRevisionId ?? profile.activeRulesetRevisionId
  if (rulesetRevisionId && !Object.hasOwn(profile.rulesets, rulesetRevisionId)) {
    throw new DomainError('MISSING_RULESET', 'The snapshot ruleset revision is unavailable')
  }
  validateNonnegativeKnowledge(input.ppCapacity, 'PP capacity')
  for (const ref of [...knowledgeValues(input.primaryClass), ...knowledgeValues(input.secondaryClass)]) {
    assertPersonalDefinitionRef(profile, ref)
  }
  for (const [key, stat] of Object.entries(input.displayedStats ?? {})) {
    if (!key.trim()) throw new DomainError('INVALID_INPUT', 'Displayed stat key must not be empty')
    assertTextLength(key, 'Displayed stat key', MAX_ID_LENGTH)
    if (!stat.unit.trim()) throw new DomainError('INVALID_INPUT', `Displayed stat ${key} unit must not be empty`)
    assertTextLength(stat.unit, `Displayed stat ${key} unit`, MAX_SHORT_TEXT_LENGTH)
    for (const value of knowledgeValues(stat.value)) assertFiniteNumber(value, `Displayed stat ${key}`)
  }
  for (const ref of Object.values(input.selections ?? {})) {
    if (ref) assertPersonalDefinitionRef(profile, ref)
  }
  const snapshotId = input.snapshotId ?? createId<CharacterSnapshotId>('characterSnapshot')
  if (current.snapshots[snapshotId]) {
    throw new DomainError('DUPLICATE_ID', `Character snapshot already exists: ${snapshotId}`)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const snapshot: CharacterSnapshot = {
    id: snapshotId,
    ...(rulesetRevisionId === undefined ? {} : { rulesetRevisionId }),
    recordedAt: at,
    level: input.level ?? UNKNOWN_NUMBER,
    primaryClass: input.primaryClass ?? UNKNOWN_REF,
    secondaryClass: input.secondaryClass ?? UNKNOWN_REF,
    displayedStats: input.displayedStats ?? {},
    ppCapacity: input.ppCapacity ?? UNKNOWN_NUMBER,
    selections: input.selections ?? {},
    sources: input.sources ?? [],
    ...(input.observedAt === undefined ? {} : { observedAt: asTimestamp(input.observedAt) }),
    ...(input.note === undefined ? {} : { note: input.note }),
  }
  const character: Character = {
    ...current,
    revision: current.revision + 1,
    currentSnapshotId: snapshotId,
    snapshots: { ...current.snapshots, [snapshotId]: snapshot },
    updatedAt: at,
  }
  return updateProfile(
    profile,
    { characters: { ...profile.characters, [character.id]: character } },
    'character.capture',
    [`characters.${character.id}.snapshots.${snapshotId}`, `characters.${character.id}.currentSnapshotId`],
    at,
  )
}

export interface UpsertCharacterClassProgressInput {
  readonly characterId: CharacterId
  readonly classRef: EntityRef
  readonly unlocked?: Knowledge<boolean>
  readonly coreTreeComplete?: Knowledge<boolean>
  readonly mastered?: Knowledge<boolean>
  readonly observedLp?: Knowledge<number>
  readonly sources?: readonly SourceRef[]
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

const UNKNOWN_BOOLEAN: Knowledge<boolean> = { state: 'unknown' }

export function upsertCharacterClassProgress(
  profile: Profile,
  input: UpsertCharacterClassProgressInput,
): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  const current = profile.characters[input.characterId]
  if (!current) {
    throw new DomainError('MISSING_CHARACTER', `Character does not exist: ${input.characterId}`)
  }
  assertPersonalDefinitionRef(profile, input.classRef)
  validateNonnegativeKnowledge(input.observedLp, 'Observed LP')
  const key = logicalEntityKey(profile, input.classRef)
  const prior = current.classProgress[key]
  const classProgress: CharacterClassProgress = {
    classRef: input.classRef,
    unlocked: input.unlocked ?? prior?.unlocked ?? UNKNOWN_BOOLEAN,
    coreTreeComplete: input.coreTreeComplete ?? prior?.coreTreeComplete ?? UNKNOWN_BOOLEAN,
    mastered: input.mastered ?? prior?.mastered ?? UNKNOWN_BOOLEAN,
    observedLp: input.observedLp ?? prior?.observedLp ?? UNKNOWN_NUMBER,
    sources: input.sources ?? prior?.sources ?? [],
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const character: Character = {
    ...current,
    revision: current.revision + 1,
    classProgress: { ...current.classProgress, [key]: classProgress },
    updatedAt: at,
  }
  return updateProfile(
    profile,
    { characters: { ...profile.characters, [character.id]: character } },
    'character.classProgress.upsert',
    [`characters.${character.id}.classProgress.${key}`],
    at,
  )
}

export interface UpsertLearnedNodeInput {
  readonly characterId: CharacterId
  readonly ref: EntityRef
  readonly kind: LearnedNodeKind
  readonly learned?: Knowledge<boolean>
  readonly actualPaidLp?: Knowledge<number>
  readonly sources?: readonly SourceRef[]
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function upsertLearnedNode(profile: Profile, input: UpsertLearnedNodeInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  const current = profile.characters[input.characterId]
  if (!current) {
    throw new DomainError('MISSING_CHARACTER', `Character does not exist: ${input.characterId}`)
  }
  assertPersonalDefinitionRef(profile, input.ref)
  validateNonnegativeKnowledge(input.actualPaidLp, 'Actual paid LP')
  const key = logicalEntityKey(profile, input.ref)
  const prior = current.learnedNodes[key]
  const learnedNode: LearnedNode = {
    ref: input.ref,
    kind: input.kind,
    learned: input.learned ?? prior?.learned ?? UNKNOWN_BOOLEAN,
    actualPaidLp: input.actualPaidLp ?? prior?.actualPaidLp ?? UNKNOWN_NUMBER,
    sources: input.sources ?? prior?.sources ?? [],
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const character: Character = {
    ...current,
    revision: current.revision + 1,
    learnedNodes: { ...current.learnedNodes, [key]: learnedNode },
    updatedAt: at,
  }
  return updateProfile(
    profile,
    { characters: { ...profile.characters, [character.id]: character } },
    'character.learnedNode.upsert',
    [`characters.${character.id}.learnedNodes.${key}`],
    at,
  )
}

export interface UpsertProgressInput {
  readonly id?: ProgressRecordId
  readonly subject: EntityRef
  readonly displayName: string
  readonly stage?: Knowledge<ProgressStage>
  readonly unlocked?: Knowledge<boolean>
  readonly partyMastery?: Knowledge<boolean>
  readonly collection?: Knowledge<boolean>
  readonly masterLocation?: Knowledge<string>
  readonly sources?: readonly SourceRef[]
  readonly observedAt?: Timestamp | string | null
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

const UNKNOWN_PROGRESS_STAGE: Knowledge<ProgressStage> = { state: 'unknown' }
const UNKNOWN_STRING: Knowledge<string> = { state: 'unknown' }

export function upsertProgress(profile: Profile, input: UpsertProgressInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  assertPersonalDefinitionRef(profile, input.subject)
  const matching = Object.values(profile.progress).find(
    (record) => logicalEntityKey(profile, record.subject) === logicalEntityKey(profile, input.subject),
  )
  const current = input.id === undefined ? matching : profile.progress[input.id]
  if (matching && matching.id !== current?.id) {
    throw new DomainError('DUPLICATE_REFERENCE', 'Another progress record already uses this subject')
  }
  const id = current?.id ?? input.id ?? createId<ProgressRecordId>('progress')
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const observedAt = input.observedAt === undefined
    ? current?.observedAt
    : input.observedAt === null
      ? undefined
      : asTimestamp(input.observedAt)
  const record: PartyProgressRecord = {
    id,
    revision: (current?.revision ?? -1) + 1,
    subject: input.subject,
    displayName: input.displayName.trim() || current?.displayName || 'Unnamed progress entry',
    stage: input.stage ?? current?.stage ?? UNKNOWN_PROGRESS_STAGE,
    unlocked: input.unlocked ?? current?.unlocked ?? UNKNOWN_BOOLEAN,
    partyMastery: input.partyMastery ?? current?.partyMastery ?? UNKNOWN_BOOLEAN,
    collection: input.collection ?? current?.collection ?? UNKNOWN_BOOLEAN,
    masterLocation: input.masterLocation ?? current?.masterLocation ?? UNKNOWN_STRING,
    sources: input.sources ?? current?.sources ?? [],
    updatedAt: at,
    ...(observedAt === undefined ? {} : { observedAt }),
  }
  return updateProfile(
    profile,
    { progress: { ...profile.progress, [id]: record } },
    current ? 'progress.update' : 'progress.create',
    [`progress.${id}`],
    at,
  )
}

export const updateProgress = upsertProgress
