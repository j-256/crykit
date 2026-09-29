import {
  asTimestamp,
  assertExpectedRevision,
  assertNonnegativeInteger,
  createId,
  DomainError,
  nowTimestamp,
  updateProfile,
} from './core'
import type {
  BuildRevisionId,
  CatalogRevisionId,
  CharacterId,
  InventoryPolicy,
  Profile,
  RulesetRevisionId,
  ScenarioBaseline,
  ScenarioId,
  ScenarioKind,
  TeamScenario,
  Timestamp,
} from './types'

export interface CreateScenarioInput {
  readonly id?: ScenarioId
  readonly label: string
  readonly kind?: ScenarioKind
  readonly memberIds?: readonly CharacterId[]
  readonly baseline?: ScenarioBaseline
  readonly assignments?: Readonly<Record<string, BuildRevisionId | null>>
  readonly rulesetRevisionId: RulesetRevisionId
  readonly catalogLock?: Readonly<Record<string, CatalogRevisionId>>
  readonly inventoryPolicy?: InventoryPolicy
  readonly activate?: boolean
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export const TEAM_SIZE = 4

function assertBuildRevisionExists(profile: Profile, revisionId: BuildRevisionId): void {
  if (!profile.buildRevisions[revisionId]) {
    throw new DomainError('MISSING_BUILD_REVISION', `Build revision does not exist: ${revisionId}`)
  }
}

function validateAssignments(
  profile: Profile,
  assignments: Readonly<Record<string, BuildRevisionId | null>>,
): void {
  for (const [characterId, revisionId] of Object.entries(assignments)) {
    if (!profile.characters[characterId]) {
      throw new DomainError('MISSING_CHARACTER', `Character does not exist: ${characterId}`)
    }
    if (revisionId) {
      assertBuildRevisionExists(profile, revisionId)
    }
  }
}

function assertTeamMembers(profile: Profile, memberIds: readonly CharacterId[]): void {
  if (memberIds.length !== TEAM_SIZE || new Set(memberIds).size !== TEAM_SIZE) {
    throw new DomainError('INVALID_INPUT', `A team must contain exactly ${TEAM_SIZE} distinct characters`)
  }
  for (const characterId of memberIds) {
    if (!profile.characters[characterId]) {
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

export function scenarioMemberIds(scenario: TeamScenario): readonly CharacterId[] {
  if (scenario.memberIds) return scenario.memberIds
  const inferred = [
    ...(scenario.baseline.kind === 'recordedParty' ? Object.keys(scenario.baseline.assignments) : []),
    ...Object.keys(scenario.assignments),
  ]
  return [...new Set(inferred)] as CharacterId[]
}

export function createScenario(profile: Profile, input: CreateScenarioInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  const ruleset = profile.rulesets[input.rulesetRevisionId]
  if (!ruleset) {
    throw new DomainError('MISSING_RULESET', `Ruleset revision does not exist: ${input.rulesetRevisionId}`)
  }
  const baseline = input.baseline ?? { kind: 'empty' }
  if (input.memberIds) assertTeamMembers(profile, input.memberIds)
  if (baseline.kind === 'recordedParty') {
    assertNonnegativeInteger(baseline.profileRevision, 'Scenario baseline profile revision')
    if (baseline.profileRevision > profile.revision) {
      throw new DomainError('INVALID_INPUT', 'Scenario baseline cannot reference a future profile revision')
    }
    validateAssignments(profile, baseline.assignments)
    if (input.memberIds) assertAssignmentsBelongToTeam(baseline.assignments, input.memberIds)
  }
  const assignments = input.assignments ?? {}
  validateAssignments(profile, assignments)
  if (input.memberIds) assertAssignmentsBelongToTeam(assignments, input.memberIds)
  const id = input.id ?? createId<ScenarioId>('scenario')
  if (profile.scenarios[id]) {
    throw new DomainError('DUPLICATE_ID', `Scenario already exists: ${id}`)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const scenario: TeamScenario = {
    id,
    revision: 0,
    label: input.label.trim() || 'Untitled scenario',
    kind: input.kind ?? 'draft',
    ...(input.memberIds ? { memberIds: [...input.memberIds] } : {}),
    baseline,
    assignments,
    rulesetRevisionId: input.rulesetRevisionId,
    catalogLock: input.catalogLock ?? ruleset.catalogLock,
    inventoryPolicy: input.inventoryPolicy ?? { includeProtected: false, enforceStock: true },
    createdAt: at,
    updatedAt: at,
  }
  const activate = input.activate ?? profile.activeScenarioId === undefined
  return updateProfile(
    profile,
    {
      scenarios: { ...profile.scenarios, [id]: scenario },
      ...(activate ? { activeScenarioId: id } : {}),
    },
    'scenario.create',
    [`scenarios.${id}`, ...(activate ? ['activeScenarioId'] : [])],
    at,
  )
}

export interface ReplaceScenarioBuildInput {
  readonly scenarioId: ScenarioId
  readonly characterId: CharacterId
  readonly buildRevisionId: BuildRevisionId | null
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export interface ActivateScenarioInput {
  readonly scenarioId: ScenarioId | null
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function activateScenario(profile: Profile, input: ActivateScenarioInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  if (input.scenarioId !== null && !Object.hasOwn(profile.scenarios, input.scenarioId)) {
    throw new DomainError('MISSING_SCENARIO', `Scenario does not exist: ${input.scenarioId}`)
  }
  const activeScenarioId = input.scenarioId ?? undefined
  if (profile.activeScenarioId === activeScenarioId) return profile
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  return updateProfile(profile, { activeScenarioId }, 'scenario.activate', ['activeScenarioId'], at)
}

export function replaceScenarioBuild(profile: Profile, input: ReplaceScenarioBuildInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  const current = profile.scenarios[input.scenarioId]
  if (!current) {
    throw new DomainError('MISSING_SCENARIO', `Scenario does not exist: ${input.scenarioId}`)
  }
  if (!profile.characters[input.characterId]) {
    throw new DomainError('MISSING_CHARACTER', `Character does not exist: ${input.characterId}`)
  }
  if (!scenarioMemberIds(current).includes(input.characterId)) {
    throw new DomainError('INVALID_INPUT', `Character is not a member of this four-character team: ${input.characterId}`)
  }
  if (input.buildRevisionId) {
    assertBuildRevisionExists(profile, input.buildRevisionId)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const scenario: TeamScenario = {
    ...current,
    revision: current.revision + 1,
    assignments: { ...current.assignments, [input.characterId]: input.buildRevisionId },
    updatedAt: at,
  }
  return updateProfile(
    profile,
    { scenarios: { ...profile.scenarios, [scenario.id]: scenario } },
    'scenario.replaceBuild',
    [`scenarios.${scenario.id}.assignments.${input.characterId}`],
    at,
  )
}

export interface UpdateScenarioInput {
  readonly scenarioId: ScenarioId
  readonly label?: string
  readonly kind?: ScenarioKind
  readonly inventoryPolicy?: InventoryPolicy
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function updateScenario(profile: Profile, input: UpdateScenarioInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  const current = profile.scenarios[input.scenarioId]
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
  return updateProfile(
    profile,
    { scenarios: { ...profile.scenarios, [scenario.id]: scenario } },
    'scenario.update',
    [`scenarios.${scenario.id}`],
    at,
  )
}

export function effectiveScenarioAssignments(
  scenario: TeamScenario,
): Readonly<Record<string, BuildRevisionId>> {
  const members = new Set<string>(scenarioMemberIds(scenario))
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
