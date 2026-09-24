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
  readonly baseline?: ScenarioBaseline
  readonly assignments?: Readonly<Record<string, BuildRevisionId | null>>
  readonly rulesetRevisionId: RulesetRevisionId
  readonly catalogLock?: Readonly<Record<string, CatalogRevisionId>>
  readonly inventoryPolicy?: InventoryPolicy
  readonly activate?: boolean
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

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

export function createScenario(profile: Profile, input: CreateScenarioInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  const ruleset = profile.rulesets[input.rulesetRevisionId]
  if (!ruleset) {
    throw new DomainError('MISSING_RULESET', `Ruleset revision does not exist: ${input.rulesetRevisionId}`)
  }
  const baseline = input.baseline ?? { kind: 'empty' }
  if (baseline.kind === 'recordedParty') {
    assertNonnegativeInteger(baseline.profileRevision, 'Scenario baseline profile revision')
    if (baseline.profileRevision > profile.revision) {
      throw new DomainError('INVALID_INPUT', 'Scenario baseline cannot reference a future profile revision')
    }
    validateAssignments(profile, baseline.assignments)
  }
  const assignments = input.assignments ?? {}
  validateAssignments(profile, assignments)
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

export function replaceScenarioBuild(profile: Profile, input: ReplaceScenarioBuildInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  const current = profile.scenarios[input.scenarioId]
  if (!current) {
    throw new DomainError('MISSING_SCENARIO', `Scenario does not exist: ${input.scenarioId}`)
  }
  if (!profile.characters[input.characterId]) {
    throw new DomainError('MISSING_CHARACTER', `Character does not exist: ${input.characterId}`)
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
  const assignments: Record<string, BuildRevisionId> =
    scenario.baseline.kind === 'recordedParty' ? { ...scenario.baseline.assignments } : {}
  for (const [characterId, revisionId] of Object.entries(scenario.assignments)) {
    if (revisionId === null) {
      delete assignments[characterId]
    } else {
      assignments[characterId] = revisionId
    }
  }
  return assignments
}
