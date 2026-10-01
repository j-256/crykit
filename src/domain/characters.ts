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
  requirePlaythrough,
  updatePlaythrough,
} from './core'
import { logicalEntityKey } from './definitions'
import { validateCalculationPlan } from './calculation-plan'
import { MAX_ID_LENGTH, MAX_SHORT_TEXT_LENGTH } from './limits'
import type {
  Character,
  CharacterClassProgress,
  CharacterId,
  CharacterSnapshot,
  CharacterSnapshotId,
  BuildCalculationPlan,
  EntityRef,
  Knowledge,
  LearnedNode,
  LearnedNodeKind,
  ObservedStat,
  PartyProgressRecord,
  LocalData,
  PlaythroughId,
  ProgressRecordId,
  ProgressStage,
  GameSetupRevisionId,
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
  readonly playthroughId?: PlaythroughId
  readonly id?: CharacterId
  readonly name: string
  readonly appearanceLabel?: string
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function createCharacter(localData: LocalData, input: CreateCharacterInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const playthrough = requirePlaythrough(localData, input.playthroughId)
  const name = input.name.trim()
  if (!name) {
    throw new DomainError('INVALID_INPUT', 'Character name must not be empty')
  }
  const id = input.id ?? createId<CharacterId>('character')
  if (playthrough.characters[id]) {
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
  return updatePlaythrough(
    localData,
    playthrough.id,
    { characters: { ...playthrough.characters, [id]: character } },
    'character.create',
    [`characters.${id}`],
    at,
  )
}

export interface UpdateCharacterInput {
  readonly playthroughId?: PlaythroughId
  readonly characterId: CharacterId
  readonly name?: string
  readonly appearanceLabel?: string
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function updateCharacter(localData: LocalData, input: UpdateCharacterInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const playthrough = requirePlaythrough(localData, input.playthroughId)
  const current = playthrough.characters[input.characterId]
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
  return updatePlaythrough(
    localData,
    playthrough.id,
    { characters: { ...playthrough.characters, [character.id]: character } },
    'character.update',
    [`characters.${character.id}`],
    at,
  )
}

export interface CaptureCharacterInput {
  readonly playthroughId?: PlaythroughId
  readonly characterId: CharacterId
  readonly snapshotId?: CharacterSnapshotId
  readonly gameSetupRevisionId?: GameSetupRevisionId
  readonly observedAt?: Timestamp | string
  readonly level?: Knowledge<number>
  readonly primaryClass?: Knowledge<EntityRef>
  readonly secondaryClass?: Knowledge<EntityRef>
  readonly displayedStats?: Readonly<Record<string, ObservedStat>>
  readonly equipment?: Readonly<Record<string, EntityRef | null>>
  readonly passives?: Knowledge<readonly EntityRef[]>
  readonly calculation?: BuildCalculationPlan
  readonly sources?: readonly SourceRef[]
  readonly note?: string
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

const UNKNOWN_NUMBER: Knowledge<number> = { state: 'unknown' }
const UNKNOWN_REF: Knowledge<EntityRef> = { state: 'unknown' }
const UNKNOWN_REFS: Knowledge<readonly EntityRef[]> = { state: 'unknown' }

export function captureCharacter(localData: LocalData, input: CaptureCharacterInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const playthrough = requirePlaythrough(localData, input.playthroughId)
  const current = playthrough.characters[input.characterId]
  if (!current) {
    throw new DomainError('MISSING_CHARACTER', `Character does not exist: ${input.characterId}`)
  }
  validateNonnegativeKnowledge(input.level, 'Character level')
  const gameSetupRevisionId = input.gameSetupRevisionId ?? playthrough.currentGameSetupRevisionId
  if (gameSetupRevisionId && !Object.hasOwn(localData.gameSetups, gameSetupRevisionId)) {
    throw new DomainError('MISSING_GAME_SETUP', 'The snapshot Game Setup revision is unavailable')
  }
  for (const ref of [...knowledgeValues(input.primaryClass), ...knowledgeValues(input.secondaryClass)]) {
    assertPersonalDefinitionRef(localData, ref)
  }
  for (const [key, stat] of Object.entries(input.displayedStats ?? {})) {
    if (!key.trim()) throw new DomainError('INVALID_INPUT', 'Displayed stat key must not be empty')
    assertTextLength(key, 'Displayed stat key', MAX_ID_LENGTH)
    if (!stat.unit.trim()) throw new DomainError('INVALID_INPUT', `Displayed stat ${key} unit must not be empty`)
    assertTextLength(stat.unit, `Displayed stat ${key} unit`, MAX_SHORT_TEXT_LENGTH)
    for (const value of knowledgeValues(stat.value)) assertFiniteNumber(value, `Displayed stat ${key}`)
  }
  for (const ref of Object.values(input.equipment ?? {})) {
    if (ref) assertPersonalDefinitionRef(localData, ref)
  }
  for (const refs of knowledgeValues(input.passives)) for (const ref of refs) assertPersonalDefinitionRef(localData, ref)
  if (input.calculation) validateCalculationPlan(input.calculation, ref => assertPersonalDefinitionRef(localData, ref))
  const snapshotId = input.snapshotId ?? createId<CharacterSnapshotId>('characterSnapshot')
  if (current.snapshots[snapshotId]) {
    throw new DomainError('DUPLICATE_ID', `Character snapshot already exists: ${snapshotId}`)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const snapshot: CharacterSnapshot = {
    id: snapshotId,
    ...(gameSetupRevisionId === undefined ? {} : { gameSetupRevisionId }),
    recordedAt: at,
    level: input.level ?? UNKNOWN_NUMBER,
    primaryClass: input.primaryClass ?? UNKNOWN_REF,
    secondaryClass: input.secondaryClass ?? UNKNOWN_REF,
    displayedStats: input.displayedStats ?? {},
    equipment: input.equipment ?? {},
    passives: input.passives ?? UNKNOWN_REFS,
    ...(input.calculation ? { calculation: structuredClone(input.calculation) } : {}),
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
  return updatePlaythrough(
    localData,
    playthrough.id,
    { characters: { ...playthrough.characters, [character.id]: character } },
    'character.capture',
    [`characters.${character.id}.snapshots.${snapshotId}`, `characters.${character.id}.currentSnapshotId`],
    at,
  )
}

export interface UpsertCharacterClassProgressInput {
  readonly playthroughId?: PlaythroughId
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
  localData: LocalData,
  input: UpsertCharacterClassProgressInput,
): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const playthrough = requirePlaythrough(localData, input.playthroughId)
  const current = playthrough.characters[input.characterId]
  if (!current) {
    throw new DomainError('MISSING_CHARACTER', `Character does not exist: ${input.characterId}`)
  }
  assertPersonalDefinitionRef(localData, input.classRef)
  validateNonnegativeKnowledge(input.observedLp, 'Observed LP')
  const key = logicalEntityKey(localData, input.classRef)
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
  return updatePlaythrough(
    localData,
    playthrough.id,
    { characters: { ...playthrough.characters, [character.id]: character } },
    'character.classProgress.upsert',
    [`characters.${character.id}.classProgress.${key}`],
    at,
  )
}

export interface UpsertLearnedNodeInput {
  readonly playthroughId?: PlaythroughId
  readonly characterId: CharacterId
  readonly ref: EntityRef
  readonly kind: LearnedNodeKind
  readonly learned?: Knowledge<boolean>
  readonly actualPaidLp?: Knowledge<number>
  readonly sources?: readonly SourceRef[]
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function upsertLearnedNode(localData: LocalData, input: UpsertLearnedNodeInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const playthrough = requirePlaythrough(localData, input.playthroughId)
  const current = playthrough.characters[input.characterId]
  if (!current) {
    throw new DomainError('MISSING_CHARACTER', `Character does not exist: ${input.characterId}`)
  }
  assertPersonalDefinitionRef(localData, input.ref)
  validateNonnegativeKnowledge(input.actualPaidLp, 'Actual paid LP')
  const key = logicalEntityKey(localData, input.ref)
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
  return updatePlaythrough(
    localData,
    playthrough.id,
    { characters: { ...playthrough.characters, [character.id]: character } },
    'character.learnedNode.upsert',
    [`characters.${character.id}.learnedNodes.${key}`],
    at,
  )
}

export interface UpsertProgressInput {
  readonly playthroughId?: PlaythroughId
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

export function upsertProgress(localData: LocalData, input: UpsertProgressInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const playthrough = requirePlaythrough(localData, input.playthroughId)
  assertPersonalDefinitionRef(localData, input.subject)
  const matching = Object.values(playthrough.progress).find(
    (record) => logicalEntityKey(localData, record.subject) === logicalEntityKey(localData, input.subject),
  )
  const current = input.id === undefined ? matching : playthrough.progress[input.id]
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
  return updatePlaythrough(
    localData,
    playthrough.id,
    { progress: { ...playthrough.progress, [id]: record } },
    current ? 'progress.update' : 'progress.create',
    [`progress.${id}`],
    at,
  )
}

export const updateProgress = upsertProgress
