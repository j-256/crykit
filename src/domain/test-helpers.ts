import {
  addGameSetupRevision,
  asId,
  asTimestamp,
  captureCharacter,
  createBlankLocalData,
  createBuild,
  createCharacter,
  createPersonalDefinition,
  createPlaythrough,
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
  LocalData,
  LocalDataId,
  PlaythroughId,
  GameSetupId,
  GameSetupRevisionId,
  ScenarioId,
  SlotId,
} from './types'

export const TEST_NOW = asTimestamp('2026-01-02T03:04:05.000Z')
export const TEST_GAME_SETUP_ID = asId<GameSetupId>('gameSetup')
export const TEST_GAME_SETUP_REVISION_ID = asId<GameSetupRevisionId>('gameSetup-revision')
export const TEST_PLAYTHROUGH_ID = asId<PlaythroughId>('playthrough')
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

export function createTestLocalData(ppCostsNonNegative: Knowledge<boolean> = known(true), ppLimit: Knowledge<number> = known(10)): LocalData {
  let localData = createBlankLocalData({ id: asId<LocalDataId>('localData'), now: TEST_NOW })
  localData = addGameSetupRevision(localData, {
    id: TEST_GAME_SETUP_REVISION_ID,
    gameSetupId: TEST_GAME_SETUP_ID,
    label: 'Verified test Game Setup',
    platform: known('test'),
    gameVersion: known('1'),
    mode: known('test'),
    mods: known([]),
    ppLimit,
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
  localData = createPlaythrough(localData, {
    id: TEST_PLAYTHROUGH_ID,
    label: 'Test playthrough',
    currentGameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
    now: TEST_NOW,
  })
  return localData
}

export function addTestCharacter(localData: LocalData, value: string): LocalData {
  const characterId = asId<CharacterId>(value)
  let next = createCharacter(localData, { id: characterId, name: value, now: TEST_NOW })
  next = captureCharacter(next, {
    characterId,
    now: TEST_NOW,
  })
  return next
}

export function addTestTeam(localData: LocalData, preferredMemberValues: readonly string[] = []): { readonly localData: LocalData; readonly memberIds: readonly CharacterId[] } {
  const memberValues = [...new Set(preferredMemberValues)]
  for (let index = 1; memberValues.length < TEAM_SIZE; index += 1) {
    const value = `test-team-member-${index}`
    if (!memberValues.includes(value)) memberValues.push(value)
  }
  let next = localData
  for (const value of memberValues) {
    if (!next.playthroughs[TEST_PLAYTHROUGH_ID]?.characters[value]) next = addTestCharacter(next, value)
  }
  return { localData: next, memberIds: memberValues.map(value => asId<CharacterId>(value)) }
}

export interface AddTestDefinitionOptions {
  readonly kind?: CatalogEntityKind
  readonly slotKinds?: Knowledge<readonly string[]>
  readonly ppCost?: Knowledge<number>
  readonly requirements?: Knowledge<readonly EntityRequirement[]>
  readonly grants?: Knowledge<readonly string[]>
}

export function addTestDefinition(
  localData: LocalData,
  value: string,
  options: AddTestDefinitionOptions = {},
): LocalData {
  const kind = options.kind ?? 'item'
  const passive = kind === 'passive' || kind === 'innate'
  return createPersonalDefinition(localData, {
    id: asId<PersonalDefinitionId>(value),
    kind,
    name: value,
    ...(passive ? {} : { slotKinds: options.slotKinds ?? known([HAND_SLOT, SECOND_HAND_SLOT]) }),
    ...(passive ? { ppCost: options.ppCost ?? known(0) } : {}),
    requirements: options.requirements ?? known([]),
    grants: options.grants ?? known([]),
    now: TEST_NOW,
  })
}

export function addTestBuild(
  localData: LocalData,
  buildValue: string,
  _characterValue: string,
  equipment: Readonly<Record<string, BuildSelection | null>>,
  options: {
    readonly primaryClass?: EntityRef | null
    readonly secondaryClass?: EntityRef | null
    readonly catalogLock?: Readonly<Record<string, CatalogRevisionId>>
    readonly passives?: readonly BuildSelection[]
  } = {},
): LocalData {
  const buildId = asId<BuildId>(buildValue)
  let next = createBuild(localData, {
    id: buildId,
    gameSetupId: TEST_GAME_SETUP_ID,
    title: buildValue,
    now: TEST_NOW,
  })
  next = saveBuildRevision(next, {
    buildId,
    id: asId<BuildRevisionId>(`${buildValue}-revision`),
    gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
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
  localData: LocalData,
  assignments: Readonly<Record<string, BuildRevisionId | null>>,
  value = 'scenario',
): LocalData {
  const team = addTestTeam(localData, Object.keys(assignments))
  return createScenario(team.localData, {
    id: asId<ScenarioId>(value),
    label: value,
    memberIds: team.memberIds,
    assignments,
    gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
    now: TEST_NOW,
  })
}
