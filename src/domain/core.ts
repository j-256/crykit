import type {
  ChangeEntry,
  ChangeId,
  DomainId,
  EntityRef,
  JsonValue,
  LocalData,
  Playthrough,
  PlaythroughId,
  Timestamp,
} from './types'
import { MAX_ID_LENGTH } from './limits'

export type DomainErrorCode =
  | 'DUPLICATE_ID'
  | 'DUPLICATE_REFERENCE'
  | 'ID_GENERATION_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'MISSING_BUILD'
  | 'MISSING_BUILD_REVISION'
  | 'MISSING_CHARACTER'
  | 'MISSING_INVENTORY_POSITION'
  | 'MISSING_PERSONAL_DEFINITION'
  | 'MISSING_GAME_SETUP'
  | 'MISSING_PLAYTHROUGH'
  | 'MISSING_SCENARIO'
  | 'REVISION_CONFLICT'

export class DomainError extends Error {
  readonly code: DomainErrorCode
  readonly details?: JsonValue

  constructor(code: DomainErrorCode, message: string, details?: JsonValue) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.details = details
  }
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/

export function asId<Id extends DomainId>(value: string): Id {
  if (value.trim().length === 0 || value.length > MAX_ID_LENGTH || CONTROL_CHARACTER.test(value)) {
    throw new DomainError('INVALID_INPUT', 'ID must be nonempty, bounded text without control characters')
  }
  return value as Id
}

export function asTimestamp(value: string): Timestamp {
  if (DATE_ONLY.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`)
    if (!Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value) {
      return value as Timestamp
    }
  }
  const match = UTC_TIMESTAMP.exec(value)
  if (match) {
    const [, datePart, timePart, fraction] = match
    const canonical = `${datePart}T${timePart}.${(fraction ?? '').padEnd(3, '0')}Z`
    const date = new Date(value)
    if (!Number.isNaN(date.valueOf()) && date.toISOString() === canonical) {
      return value as Timestamp
    }
  }
  throw new DomainError('INVALID_INPUT', 'Timestamp must be a valid date or ISO 8601 UTC timestamp')
}

export function nowTimestamp(): Timestamp {
  return new Date().toISOString() as Timestamp
}

export function createId<Id extends DomainId>(prefix: string): Id {
  const randomUuid = globalThis.crypto?.randomUUID
  if (!randomUuid) {
    throw new DomainError('ID_GENERATION_UNAVAILABLE', 'Secure ID generation is unavailable')
  }
  return `${prefix}_${randomUuid.call(globalThis.crypto)}` as Id
}

export function entityRefKey(ref: EntityRef): string {
  if (ref.kind === 'personal') {
    return JSON.stringify(['personal', ref.definitionId])
  }
  return JSON.stringify(['catalog', ref.catalogId, ref.entityId])
}

export function entityDefinitionKey(ref: EntityRef): string {
  if (ref.kind === 'personal') {
    return entityRefKey(ref)
  }
  return JSON.stringify(['catalog', ref.catalogId, ref.catalogRevisionId, ref.entityId])
}

export function sameEntityRef(left: EntityRef, right: EntityRef): boolean {
  return entityRefKey(left) === entityRefKey(right)
}

export function assertExpectedRevision(localData: LocalData, expectedRevision?: number): void {
  if (expectedRevision !== undefined && expectedRevision !== localData.revision) {
    throw new DomainError('REVISION_CONFLICT', 'LocalData revision does not match the expected revision', {
      actual: localData.revision,
      expected: expectedRevision,
    })
  }
}

type LocalDataUpdate = Partial<
  Pick<
    LocalData,
    | 'selectedPlaythroughId'
    | 'planningGameSetupRevisionId'
    | 'personalDefinitions'
    | 'gameSetups'
    | 'builds'
    | 'buildRevisions'
    | 'teams'
    | 'playthroughs'
    | 'importReceipts'
    | 'skillTreeLayouts'
  >
>

export function updateLocalData(
  localData: LocalData,
  update: LocalDataUpdate,
  command: string,
  changedPaths: readonly string[],
  recordedAt: Timestamp,
): LocalData {
  const nextRevision = localData.revision + 1
  const change: ChangeEntry = {
    id: createId<ChangeId>('change'),
    command,
    previousRevision: localData.revision,
    nextRevision,
    changedPaths,
    recordedAt,
  }
  return {
    ...localData,
    ...update,
    revision: nextRevision,
    updatedAt: recordedAt,
    changes: [...localData.changes, change].slice(-LOCAL_DATA_CHANGE_JOURNAL_LIMIT),
  }
}

export function selectedPlaythrough(localData: LocalData): Playthrough | undefined {
  return localData.selectedPlaythroughId
    ? localData.playthroughs[localData.selectedPlaythroughId]
    : undefined
}

export function requirePlaythrough(localData: LocalData, playthroughId?: PlaythroughId): Playthrough {
  const resolvedId = playthroughId ?? localData.selectedPlaythroughId
  const playthrough = resolvedId ? localData.playthroughs[resolvedId] : undefined
  if (!playthrough) throw new DomainError('MISSING_PLAYTHROUGH', 'Select a playthrough before changing tracked records')
  return playthrough
}

type PlaythroughUpdate = Partial<
  Pick<
    Playthrough,
    | 'currentGameSetupRevisionId'
    | 'activeScenarioId'
    | 'inventory'
    | 'inventoryEvents'
    | 'characters'
    | 'progress'
    | 'quintarBreeding'
    | 'scenarios'
    | 'goals'
    | 'skillTreeCaptures'
  >
>

export function updatePlaythrough(
  localData: LocalData,
  playthroughId: PlaythroughId,
  update: PlaythroughUpdate,
  command: string,
  changedPaths: readonly string[],
  recordedAt: Timestamp,
): LocalData {
  const playthrough = requirePlaythrough(localData, playthroughId)
  const nextPlaythrough: Playthrough = {
    ...playthrough,
    ...update,
    revision: playthrough.revision + 1,
    updatedAt: recordedAt,
  }
  return updateLocalData(
    localData,
    { playthroughs: { ...localData.playthroughs, [playthroughId]: nextPlaythrough } },
    command,
    changedPaths.map(path => `playthroughs.${playthroughId}.${path}`),
    recordedAt,
  )
}

export function assertNonnegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError('INVALID_INPUT', `${label} must be a nonnegative integer`, { value })
  }
}

export function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DomainError('INVALID_INPUT', `${label} must be a positive integer`, { value })
  }
}

export function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new DomainError('INVALID_INPUT', `${label} must be finite`, { value })
  }
}

export function assertTextLength(value: string, label: string, maximum: number): void {
  if (value.length > maximum) {
    throw new DomainError('INVALID_INPUT', `${label} must be at most ${maximum} characters`)
  }
}

export function assertPersonalDefinitionRef(
  localData: LocalData,
  ref: EntityRef,
  allowedDefinitionId?: string,
): void {
  if (
    ref.kind === 'personal' &&
    ref.definitionId !== allowedDefinitionId &&
    !localData.personalDefinitions[ref.definitionId]
  ) {
    throw new DomainError('MISSING_PERSONAL_DEFINITION', `Personal definition does not exist: ${ref.definitionId}`)
  }
}

const LOCAL_DATA_CHANGE_JOURNAL_LIMIT = 200
