import {
  addRulesetRevision,
  asId,
  asTimestamp,
  captureCharacter,
  createBlankProfile,
  createBuild,
  createCharacter,
  createPersonalDefinition,
  createScenario,
  saveBuildRevision,
  TEAM_SIZE,
} from './index'
import type {
  BuildId,
  BuildRevisionId,
  BuildSelection,
  CatalogRevisionId,
  CatalogEntityKind,
  CharacterId,
  EntityRef,
  EntityRequirement,
  Knowledge,
  PersonalDefinitionId,
  Profile,
  ProfileId,
  RulesetId,
  RulesetRevisionId,
  ScenarioId,
  SlotId,
} from './types'

export const TEST_NOW = asTimestamp('2026-01-02T03:04:05.000Z')
export const TEST_RULESET_ID = asId<RulesetId>('ruleset')
export const TEST_RULESET_REVISION_ID = asId<RulesetRevisionId>('ruleset-revision')
export const HAND_SLOT = asId<SlotId>('hand')
export const SECOND_HAND_SLOT = asId<SlotId>('second-hand')
export const PASSIVE_SLOT = asId<SlotId>('passive-1')
export const SECOND_PASSIVE_SLOT = asId<SlotId>('passive-2')

export function known<Value>(value: Value): Knowledge<Value> {
  return { state: 'known', value }
}

export function personalRef(value: string) {
  return { kind: 'personal' as const, definitionId: asId<PersonalDefinitionId>(value) }
}

export function createTestProfile(ppCostsNonNegative: Knowledge<boolean> = known(true)): Profile {
  let profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: TEST_NOW })
  profile = addRulesetRevision(profile, {
    id: TEST_RULESET_REVISION_ID,
    rulesetId: TEST_RULESET_ID,
    label: 'Verified test ruleset',
    platform: known('test'),
    gameVersion: known('1'),
    mode: known('test'),
    mods: known([]),
    ppCostsNonNegative,
    slots: [
      {
        id: HAND_SLOT,
        kind: 'equipment',
        label: 'Hand',
        order: 0,
        acceptedEntityKinds: known(['item']),
        provenance: 'verified',
        sources: [],
      },
      {
        id: SECOND_HAND_SLOT,
        kind: 'equipment',
        label: 'Second hand',
        order: 1,
        acceptedEntityKinds: known(['item']),
        provenance: 'verified',
        sources: [],
      },
    ],
    now: TEST_NOW,
  })
  return profile
}

export function addTestCharacter(profile: Profile, value: string, ppCapacity = 10): Profile {
  const characterId = asId<CharacterId>(value)
  let next = createCharacter(profile, { id: characterId, name: value, now: TEST_NOW })
  next = captureCharacter(next, {
    characterId,
    ppCapacity: known(ppCapacity),
    now: TEST_NOW,
  })
  return next
}

export function addTestTeam(profile: Profile, preferredMemberValues: readonly string[] = []): { readonly profile: Profile; readonly memberIds: readonly CharacterId[] } {
  const memberValues = [...new Set(preferredMemberValues)]
  for (let index = 1; memberValues.length < TEAM_SIZE; index += 1) {
    const value = `test-team-member-${index}`
    if (!memberValues.includes(value)) memberValues.push(value)
  }
  let next = profile
  for (const value of memberValues) {
    if (!next.characters[value]) next = addTestCharacter(next, value)
  }
  return { profile: next, memberIds: memberValues.map(value => asId<CharacterId>(value)) }
}

export interface AddTestDefinitionOptions {
  readonly kind?: CatalogEntityKind
  readonly slotKinds?: Knowledge<readonly string[]>
  readonly occupiesSlots?: Knowledge<number>
  readonly ppCost?: Knowledge<number>
  readonly requirements?: Knowledge<readonly EntityRequirement[]>
  readonly grants?: Knowledge<readonly string[]>
}

export function addTestDefinition(
  profile: Profile,
  value: string,
  options: AddTestDefinitionOptions = {},
): Profile {
  const kind = options.kind ?? 'item'
  const passive = kind === 'passive' || kind === 'innate'
  return createPersonalDefinition(profile, {
    id: asId<PersonalDefinitionId>(value),
    kind,
    name: value,
    ...(passive ? {} : { slotKinds: options.slotKinds ?? known([HAND_SLOT, SECOND_HAND_SLOT]) }),
    ...(passive ? {} : { occupiesSlots: options.occupiesSlots ?? known(1) }),
    ...(passive ? { ppCost: options.ppCost ?? known(0) } : {}),
    requirements: options.requirements ?? known([]),
    grants: options.grants ?? known([]),
    now: TEST_NOW,
  })
}

export function addTestBuild(
  profile: Profile,
  buildValue: string,
  characterValue: string,
  equipment: Readonly<Record<string, BuildSelection | null>>,
  options: {
    readonly primaryClass?: EntityRef | null
    readonly secondaryClass?: EntityRef | null
    readonly catalogLock?: Readonly<Record<string, CatalogRevisionId>>
    readonly passives?: readonly BuildSelection[]
  } = {},
): Profile {
  const buildId = asId<BuildId>(buildValue)
  let next = createBuild(profile, {
    id: buildId,
    title: buildValue,
    kind: 'character',
    characterId: asId<CharacterId>(characterValue),
    now: TEST_NOW,
  })
  next = saveBuildRevision(next, {
    buildId,
    id: asId<BuildRevisionId>(`${buildValue}-revision`),
    rulesetRevisionId: TEST_RULESET_REVISION_ID,
    ...(options.catalogLock === undefined ? {} : { catalogLock: options.catalogLock }),
    content: {
      primaryClass: options.primaryClass ?? null,
      secondaryClass: options.secondaryClass ?? null,
      equipment,
      passives: options.passives ?? [],
      contextAssumptions: [],
    },
    now: TEST_NOW,
  })
  return next
}

export function addTestScenario(
  profile: Profile,
  assignments: Readonly<Record<string, BuildRevisionId | null>>,
  value = 'scenario',
): Profile {
  const team = addTestTeam(profile, Object.keys(assignments))
  return createScenario(team.profile, {
    id: asId<ScenarioId>(value),
    label: value,
    memberIds: team.memberIds,
    assignments,
    rulesetRevisionId: TEST_RULESET_REVISION_ID,
    now: TEST_NOW,
  })
}
