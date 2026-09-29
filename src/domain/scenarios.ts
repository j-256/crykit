import {
  asTimestamp,
  assertExpectedRevision,
  assertNonnegativeInteger,
  createId,
  DomainError,
  nowTimestamp,
  requirePlaythrough,
  updatePlaythrough,
} from './core'
import type {
  BuildRevisionId,
  CatalogRevisionId,
  CharacterId,
  InventoryPolicy,
  LocalData,
  Playthrough,
  PlaythroughId,
  GameSetupRevisionId,
  ScenarioBaseline,
  ScenarioId,
  ScenarioKind,
  TeamScenario,
  Timestamp,
} from './types'

export interface CreateScenarioInput {
  readonly playthroughId?: PlaythroughId
  readonly id?: ScenarioId
  readonly label: string
  readonly kind?: ScenarioKind
  readonly memberIds: readonly CharacterId[]
  readonly baseline?: ScenarioBaseline
  readonly assignments?: Readonly<Record<string, BuildRevisionId | null>>
  readonly gameSetupRevisionId: GameSetupRevisionId
  readonly catalogLock?: Readonly<Record<string, CatalogRevisionId>>
  readonly inventoryPolicy?: InventoryPolicy
  readonly activate?: boolean
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export const TEAM_SIZE = 4

function assertBuildRevisionExists(localData: LocalData, revisionId: BuildRevisionId): void {
  if (!localData.buildRevisions[revisionId]) {
    throw new DomainError('MISSING_BUILD_REVISION', `Build revision does not exist: ${revisionId}`)
  }
}

function validateAssignments(
  localData: LocalData,
  playthrough: Playthrough,
  assignments: Readonly<Record<string, BuildRevisionId | null>>,
): void {
  for (const [characterId, revisionId] of Object.entries(assignments)) {
    if (!playthrough.characters[characterId]) {
      throw new DomainError('MISSING_CHARACTER', `Character does not exist: ${characterId}`)
    }
    if (revisionId) {
      assertBuildRevisionExists(localData, revisionId)
    }
  }
}

function assertTeamMembers(playthrough: Playthrough, memberIds: readonly CharacterId[]): void {
  if (memberIds.length !== TEAM_SIZE || new Set(memberIds).size !== TEAM_SIZE) {
    throw new DomainError('INVALID_INPUT', `A team must contain exactly ${TEAM_SIZE} distinct characters`)
  }
  for (const characterId of memberIds) {
    if (!playthrough.characters[characterId]) {
      throw new DomainError('MISSING_CHARACTER', `Character does not exist: ${characterId}`)
    }
  }
}

function assertAssignmentsBelongToTeam(
  assignments: Readonly<Record<string, BuildRevisionId | null>>,
  memberIds: readonly CharacterId[],
): void {
  const members = new Set<string>(memberIds)
  const outsideMember = Object.keys(assignments).find(characterId => !members.has(characterId))
  if (outsideMember) {
    throw new DomainError('INVALID_INPUT', `Scenario assignment is outside the four-character team: ${outsideMember}`)
  }
}

export function createScenario(localData: LocalData, input: CreateScenarioInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const playthrough = requirePlaythrough(localData, input.playthroughId)
  const gameSetup = localData.gameSetups[input.gameSetupRevisionId]
  if (!gameSetup) {
    throw new DomainError('MISSING_GAME_SETUP', `Game Setup revision does not exist: ${input.gameSetupRevisionId}`)
  }
  const baseline = input.baseline ?? { kind: 'empty' }
  assertTeamMembers(playthrough, input.memberIds)
  if (baseline.kind === 'recordedParty') {
    assertNonnegativeInteger(baseline.playthroughRevision, 'Scenario baseline playthrough revision')
    if (baseline.playthroughRevision > playthrough.revision) {
      throw new DomainError('INVALID_INPUT', 'Scenario baseline cannot reference a future playthrough revision')
    }
    validateAssignments(localData, playthrough, baseline.assignments)
    assertAssignmentsBelongToTeam(baseline.assignments, input.memberIds)
  }
  const assignments = input.assignments ?? {}
  validateAssignments(localData, playthrough, assignments)
  assertAssignmentsBelongToTeam(assignments, input.memberIds)
  const id = input.id ?? createId<ScenarioId>('scenario')
  if (playthrough.scenarios[id]) {
    throw new DomainError('DUPLICATE_ID', `Scenario already exists: ${id}`)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const scenario: TeamScenario = {
    id,
    revision: 0,
    label: input.label.trim() || 'Untitled scenario',
    kind: input.kind ?? 'draft',
    memberIds: [...input.memberIds],
    baseline,
    assignments,
    gameSetupRevisionId: input.gameSetupRevisionId,
    catalogLock: input.catalogLock ?? gameSetup.catalogLock,
    inventoryPolicy: input.inventoryPolicy ?? { includeProtected: false, enforceStock: true },
    createdAt: at,
    updatedAt: at,
  }
  const activate = input.activate ?? playthrough.activeScenarioId === undefined
  return updatePlaythrough(
    localData,
    playthrough.id,
    {
      scenarios: { ...playthrough.scenarios, [id]: scenario },
      ...(activate ? { activeScenarioId: id } : {}),
    },
    'scenario.create',
    [`scenarios.${id}`, ...(activate ? ['activeScenarioId'] : [])],
    at,
  )
}

export interface ReplaceScenarioBuildInput {
  readonly playthroughId?: PlaythroughId
  readonly scenarioId: ScenarioId
  readonly characterId: CharacterId
  readonly buildRevisionId: BuildRevisionId | null
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export interface ActivateScenarioInput {
  readonly playthroughId?: PlaythroughId
  readonly scenarioId: ScenarioId | null
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function activateScenario(localData: LocalData, input: ActivateScenarioInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const playthrough = requirePlaythrough(localData, input.playthroughId)
  if (input.scenarioId !== null && !Object.hasOwn(playthrough.scenarios, input.scenarioId)) {
    throw new DomainError('MISSING_SCENARIO', `Scenario does not exist: ${input.scenarioId}`)
  }
  const activeScenarioId = input.scenarioId ?? undefined
  if (playthrough.activeScenarioId === activeScenarioId) return localData
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  return updatePlaythrough(localData, playthrough.id, { activeScenarioId }, 'scenario.activate', ['activeScenarioId'], at)
}

export function replaceScenarioBuild(localData: LocalData, input: ReplaceScenarioBuildInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const playthrough = requirePlaythrough(localData, input.playthroughId)
  const current = playthrough.scenarios[input.scenarioId]
  if (!current) {
    throw new DomainError('MISSING_SCENARIO', `Scenario does not exist: ${input.scenarioId}`)
  }
  if (!playthrough.characters[input.characterId]) {
    throw new DomainError('MISSING_CHARACTER', `Character does not exist: ${input.characterId}`)
  }
  if (!current.memberIds.includes(input.characterId)) {
    throw new DomainError('INVALID_INPUT', `Character is not a member of this four-character team: ${input.characterId}`)
  }
  if (input.buildRevisionId) {
    assertBuildRevisionExists(localData, input.buildRevisionId)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const scenario: TeamScenario = {
    ...current,
    revision: current.revision + 1,
    assignments: { ...current.assignments, [input.characterId]: input.buildRevisionId },
    updatedAt: at,
  }
  return updatePlaythrough(
    localData,
    playthrough.id,
    { scenarios: { ...playthrough.scenarios, [scenario.id]: scenario } },
    'scenario.replaceBuild',
    [`scenarios.${scenario.id}.assignments.${input.characterId}`],
    at,
  )
}

export interface UpdateScenarioInput {
  readonly playthroughId?: PlaythroughId
  readonly scenarioId: ScenarioId
  readonly label?: string
  readonly kind?: ScenarioKind
  readonly inventoryPolicy?: InventoryPolicy
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function updateScenario(localData: LocalData, input: UpdateScenarioInput): LocalData {
  assertExpectedRevision(localData, input.expectedRevision)
  const playthrough = requirePlaythrough(localData, input.playthroughId)
  const current = playthrough.scenarios[input.scenarioId]
  if (!current) {
    throw new DomainError('MISSING_SCENARIO', `Scenario does not exist: ${input.scenarioId}`)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const scenario: TeamScenario = {
    ...current,
    revision: current.revision + 1,
    label: input.label?.trim() || current.label,
    kind: input.kind ?? current.kind,
    inventoryPolicy: input.inventoryPolicy ?? current.inventoryPolicy,
    updatedAt: at,
  }
  return updatePlaythrough(
    localData,
    playthrough.id,
    { scenarios: { ...playthrough.scenarios, [scenario.id]: scenario } },
    'scenario.update',
    [`scenarios.${scenario.id}`],
    at,
  )
}

export function effectiveScenarioAssignments(
  scenario: TeamScenario,
): Readonly<Record<string, BuildRevisionId>> {
  const members = new Set<string>(scenario.memberIds)
  const assignments: Record<string, BuildRevisionId> =
    scenario.baseline.kind === 'recordedParty'
      ? Object.fromEntries(Object.entries(scenario.baseline.assignments).filter(([characterId]) => members.has(characterId)))
      : {}
  for (const [characterId, revisionId] of Object.entries(scenario.assignments)) {
    if (!members.has(characterId)) continue
    if (revisionId === null) {
      delete assignments[characterId]
    } else {
      assignments[characterId] = revisionId
    }
  }
  return assignments
}
