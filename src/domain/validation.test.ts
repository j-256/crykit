import { describe, expect, it } from 'vitest'
import { NATIVE_SCOPE_UNVERIFIED } from './native-game'

import {
  asId,
  createPersonalDefinition,
  createScenario,
  effectiveScenarioAssignments,
  entityDefinitionKey,
  observeInventory,
  replaceScenarioBuild,
  requirePlaythrough,
  upsertCharacterClassProgress,
  upsertLearnedNode,
  validateScenario,
} from './index'
import {
  HAND_SLOT,
  SECOND_HAND_SLOT,
  TEST_NOW,
  TEST_GAME_SETUP_REVISION_ID,
  addTestBuild,
  addTestCharacter,
  addTestDefinition,
  addTestScenario,
  addTestTeam,
  createTestLocalData,
  known,
  personalRef,
} from './test-helpers'
import type {
  BuildRevisionId,
  CatalogEntity,
  CatalogId,
  CatalogIndex,
  CatalogRevisionId,
  CatalogSnapshot,
  CharacterId,
  EntityId,
  EntityRef,
  InventoryPositionId,
  PersonalDefinitionId,
  LocalData,
  ScenarioId,
} from './types'

function observe(
  localData: LocalData,
  definition: string,
  quantity: { readonly kind: 'exact' | 'atLeast'; readonly value: number } | { readonly kind: 'unknown' },
  possession: 'owned' | 'notOwned' | 'unknown' = 'owned',
  protectedQuantity = 0,
): LocalData {
  return observeInventory(localData, {
    positionId: asId<InventoryPositionId>(`${definition}-position`),
    ref: personalRef(definition),
    possession,
    quantity,
    protectedQuantity,
    now: TEST_NOW,
  })
}

function assignment(character: string, build: string): Readonly<Record<string, BuildRevisionId>> {
  return { [character]: asId<BuildRevisionId>(`${build}-revision`) }
}

function hasIssue(localData: LocalData, scenario = 'scenario', code: string): boolean {
  return validateScenario(localData, asId<ScenarioId>(scenario)).issues.some((issue) => issue.code === code)
}

function withCatalogLock(localData: LocalData, revision = 'revision-a'): LocalData {
  const gameSetup = localData.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
  return {
    ...localData,
    gameSetups: {
      ...localData.gameSetups,
      [TEST_GAME_SETUP_REVISION_ID]: {
        ...gameSetup,
        catalogLock: { catalog: asId<CatalogRevisionId>(revision) },
      },
    },
  }
}

function catalogSnapshot(revision: string, applicability: CatalogSnapshot['applicability']): CatalogSnapshot {
  return {
    id: asId<CatalogId>('catalog'),
    revisionId: asId<CatalogRevisionId>(revision),
    schemaVersion: 'test',
    checksum: `checksum-${revision}`,
    importedAt: TEST_NOW,
    applicability,
    rights: known('test fixture'),
    entities: {},
    claims: [],
  }
}

describe('scenario stock semantics', () => {
  it('does not reserve stock for alternative library builds', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'item')
    localData = observe(localData, 'item', { kind: 'exact', value: 1 })
    localData = addTestBuild(localData, 'first-build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    localData = addTestBuild(localData, 'second-build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    localData = addTestScenario(localData, assignment('character', 'first-build'))

    expect(validateScenario(localData, asId<ScenarioId>('scenario')).dimensions.inventory.status).toBe('valid')
  })

  it('reports one confirmed copy assigned to two simultaneous characters', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'first-character')
    localData = addTestCharacter(localData, 'second-character')
    localData = addTestDefinition(localData, 'item')
    localData = observe(localData, 'item', { kind: 'exact', value: 1 })
    localData = addTestBuild(localData, 'first-build', 'first-character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    localData = addTestBuild(localData, 'second-build', 'second-character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    localData = addTestScenario(localData, {
      ...assignment('first-character', 'first-build'),
      ...assignment('second-character', 'second-build'),
    })

    const report = validateScenario(localData, asId<ScenarioId>('scenario'))
    expect(report.dimensions.inventory.status).toBe('invalid')
    expect(report.issues.some((issue) => issue.code === 'STOCK_SHORTAGE')).toBe(true)
  })

  it('replaces a recorded baseline assignment instead of layering the override', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'item')
    localData = observe(localData, 'item', { kind: 'exact', value: 1 })
    localData = addTestBuild(localData, 'recorded-build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    localData = addTestBuild(localData, 'replacement-build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    const team = addTestTeam(localData, ['character'])
    localData = team.localData
    localData = createScenario(localData, {
      id: asId<ScenarioId>('scenario'),
      label: 'Replacement',
      memberIds: team.memberIds,
      baseline: {
        kind: 'recordedParty',
        playthroughRevision: requirePlaythrough(localData).revision,
        assignments: assignment('character', 'recorded-build'),
      },
      assignments: assignment('character', 'replacement-build'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      now: TEST_NOW,
    })

    expect(effectiveScenarioAssignments(requirePlaythrough(localData).scenarios.scenario!)).toEqual(
      assignment('character', 'replacement-build'),
    )
    expect(validateScenario(localData, asId<ScenarioId>('scenario')).dimensions.inventory.status).toBe('valid')
  })

  it('can explicitly remove a baseline character assignment', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'item')
    localData = addTestBuild(localData, 'recorded-build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    const team = addTestTeam(localData, ['character'])
    localData = team.localData
    localData = createScenario(localData, {
      id: asId<ScenarioId>('scenario'),
      label: 'Removal',
      memberIds: team.memberIds,
      baseline: {
        kind: 'recordedParty',
        playthroughRevision: requirePlaythrough(localData).revision,
        assignments: assignment('character', 'recorded-build'),
      },
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      now: TEST_NOW,
    })
    localData = replaceScenarioBuild(localData, {
      scenarioId: asId<ScenarioId>('scenario'),
      characterId: asId<CharacterId>('character'),
      buildRevisionId: null,
      now: TEST_NOW,
    })

    expect(effectiveScenarioAssignments(requirePlaythrough(localData).scenarios.scenario!)).toEqual({})
  })

  it('confirms sufficiency when an at-least bound covers demand', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'first-character')
    localData = addTestCharacter(localData, 'second-character')
    localData = addTestDefinition(localData, 'item')
    localData = observe(localData, 'item', { kind: 'atLeast', value: 2 })
    localData = addTestBuild(localData, 'first-build', 'first-character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    localData = addTestBuild(localData, 'second-build', 'second-character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    localData = addTestScenario(localData, {
      ...assignment('first-character', 'first-build'),
      ...assignment('second-character', 'second-build'),
    })

    expect(validateScenario(localData, asId<ScenarioId>('scenario')).dimensions.inventory.status).toBe('valid')
  })

  it('keeps supply undetermined when demand exceeds only the known lower bound', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'first-character')
    localData = addTestCharacter(localData, 'second-character')
    localData = addTestDefinition(localData, 'item')
    localData = observe(localData, 'item', { kind: 'atLeast', value: 1 })
    localData = addTestBuild(localData, 'first-build', 'first-character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    localData = addTestBuild(localData, 'second-build', 'second-character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    localData = addTestScenario(localData, {
      ...assignment('first-character', 'first-build'),
      ...assignment('second-character', 'second-build'),
    })

    expect(validateScenario(localData, asId<ScenarioId>('scenario')).dimensions.inventory.status).toBe('undetermined')
  })

  it('does not turn unknown current possession into a hard shortage', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'item')
    localData = observe(localData, 'item', { kind: 'unknown' }, 'unknown')
    localData = addTestBuild(localData, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    localData = addTestScenario(localData, assignment('character', 'build'))

    const report = validateScenario(localData, asId<ScenarioId>('scenario'))
    expect(report.dimensions.inventory.status).toBe('undetermined')
    expect(report.issues.some((issue) => issue.code === 'STOCK_SHORTAGE')).toBe(false)
  })

  it('does not enforce stock when the scenario disables stock checks', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'item')
    localData = addTestBuild(localData, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    const team = addTestTeam(localData, ['character'])
    localData = team.localData
    localData = createScenario(localData, {
      id: asId<ScenarioId>('scenario'),
      label: 'Informational scenario',
      memberIds: team.memberIds,
      assignments: assignment('character', 'build'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      inventoryPolicy: { enforceStock: false, includeProtected: false },
      now: TEST_NOW,
    })

    const report = validateScenario(localData, asId<ScenarioId>('scenario'))
    expect(report.dimensions.inventory.status).toBe('notApplicable')
    expect(report.issues.some((entry) => entry.code.startsWith('STOCK_'))).toBe(false)
  })

  it('does not manufacture stock from a protected quantity', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'item')
    localData = observe(localData, 'item', { kind: 'atLeast', value: 1 }, 'owned', 2)
    localData = addTestBuild(localData, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    localData = addTestScenario(localData, assignment('character', 'build'))

    expect(requirePlaythrough(localData).inventory['item-position']?.quantity).toEqual({ kind: 'atLeast', value: 1 })
    expect(validateScenario(localData, asId<ScenarioId>('scenario')).dimensions.inventory.status).toBe('undetermined')
  })

  it('retains unchanged recorded-party members when another assignment is replaced', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'first-character')
    localData = addTestCharacter(localData, 'second-character')
    localData = addTestDefinition(localData, 'first-item')
    localData = addTestDefinition(localData, 'second-item')
    localData = addTestBuild(localData, 'first-recorded', 'first-character', {
      [HAND_SLOT]: { ref: personalRef('first-item') },
    })
    localData = addTestBuild(localData, 'first-replacement', 'first-character', {})
    localData = addTestBuild(localData, 'second-recorded', 'second-character', {
      [HAND_SLOT]: { ref: personalRef('second-item') },
    })
    const team = addTestTeam(localData, ['first-character', 'second-character'])
    localData = team.localData
    localData = createScenario(localData, {
      id: asId<ScenarioId>('scenario'),
      label: 'Partial replacement',
      memberIds: team.memberIds,
      baseline: {
        kind: 'recordedParty',
        playthroughRevision: requirePlaythrough(localData).revision,
        assignments: {
          ...assignment('first-character', 'first-recorded'),
          ...assignment('second-character', 'second-recorded'),
        },
      },
      assignments: assignment('first-character', 'first-replacement'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      now: TEST_NOW,
    })

    expect(effectiveScenarioAssignments(requirePlaythrough(localData).scenarios.scenario!)).toEqual({
      ...assignment('first-character', 'first-replacement'),
      ...assignment('second-character', 'second-recorded'),
    })
  })
})

describe('PP bounds and character readiness', () => {
  it('uses an unlocked class as a character-local permission source', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'class', { kind: 'class', grants: known(['special-use']) })
    localData = addTestDefinition(localData, 'requiring-item', {
      requirements: known([{ kind: 'permission', permission: 'special-use' }]),
    })
    localData = upsertCharacterClassProgress(localData, {
      characterId: asId<CharacterId>('character'),
      classRef: personalRef('class'),
      unlocked: known(true),
      now: TEST_NOW,
    })
    localData = observe(localData, 'requiring-item', { kind: 'exact', value: 1 })
    localData = addTestBuild(localData, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('requiring-item') },
    }, { primaryClass: personalRef('class') })
    localData = addTestScenario(localData, assignment('character', 'build'))

    const report = validateScenario(localData, asId<ScenarioId>('scenario'))
    expect(report.issues.some((entry) => entry.code.startsWith('REQUIRED_PERMISSION'))).toBe(false)
    expect(report.issues.some((entry) => entry.code === 'UNSUPPORTED_PERMISSION_CYCLE')).toBe(false)
  })

  it('does not bootstrap a permission from a class with unresolved requirements', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'class', {
      kind: 'class',
      requirements: { state: 'unknown' },
      grants: known(['special-use']),
    })
    localData = addTestDefinition(localData, 'invalid-grant', {
      slotKinds: known([SECOND_HAND_SLOT]),
      grants: known(['special-use']),
    })
    localData = addTestDefinition(localData, 'requiring-item', {
      requirements: known([{ kind: 'permission', permission: 'special-use' }]),
    })
    localData = upsertCharacterClassProgress(localData, {
      characterId: asId<CharacterId>('character'),
      classRef: personalRef('class'),
      unlocked: known(true),
      now: TEST_NOW,
    })
    localData = observe(localData, 'invalid-grant', { kind: 'exact', value: 1 })
    localData = observe(localData, 'requiring-item', { kind: 'exact', value: 1 })
    localData = addTestBuild(localData, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('invalid-grant') },
      [SECOND_HAND_SLOT]: { ref: personalRef('requiring-item') },
    }, { primaryClass: personalRef('class') })
    localData = addTestScenario(localData, assignment('character', 'build'))

    const report = validateScenario(localData, asId<ScenarioId>('scenario'))
    expect(report.issues.some((entry) => entry.code === 'PERMISSION_GRANT_UNKNOWN' && entry.status === 'undetermined')).toBe(true)
    expect(report.issues.some((entry) => entry.code === 'REQUIRED_PERMISSION_SOURCE_INVALID')).toBe(false)
  })

  it('rejects a non-class definition used as a class selection', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'item')
    localData = addTestBuild(localData, 'build', 'character', {}, {
      primaryClass: personalRef('item'),
    })
    localData = addTestScenario(localData, assignment('character', 'build'))

    expect(hasIssue(localData, 'scenario', 'CLASS_ENTITY_KIND_INVALID')).toBe(true)
    expect(validateScenario(localData, asId<ScenarioId>('scenario')).dimensions.characterReadiness.status).toBe('invalid')
  })

  it('proves PP invalidity from an over-cap subtotal only under a nonnegative-cost rule', () => {
    let localData = createTestLocalData(known(true), known(5))
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'known-passive', { kind: 'passive', ppCost: known(6) })
    localData = addTestDefinition(localData, 'unknown-passive', { kind: 'passive', ppCost: { state: 'unknown' } })
    localData = upsertLearnedNode(localData, {
      characterId: asId<CharacterId>('character'),
      ref: personalRef('known-passive'),
      kind: 'passive',
      learned: known(true),
      now: TEST_NOW,
    })
    localData = upsertLearnedNode(localData, {
      characterId: asId<CharacterId>('character'),
      ref: personalRef('unknown-passive'),
      kind: 'passive',
      learned: known(true),
      now: TEST_NOW,
    })
    localData = addTestBuild(localData, 'build', 'character', {}, { passives: [{ ref: personalRef('known-passive') }, { ref: personalRef('unknown-passive') }] })
    localData = addTestScenario(localData, assignment('character', 'build'))

    const report = validateScenario(localData, asId<ScenarioId>('scenario'))
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'PP_LIMIT_EXCEEDED', inputs: { limit: 5, knownSubtotal: 6 } }))
  })

  it('keeps PP unresolved when an unknown cost could exceed the remaining budget', () => {
    let localData = createTestLocalData(known(true), known(5))
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'known-passive', { kind: 'passive', ppCost: known(4) })
    localData = addTestDefinition(localData, 'unknown-passive', { kind: 'passive', ppCost: { state: 'unknown' } })
    for (const definition of ['known-passive', 'unknown-passive']) {
      localData = upsertLearnedNode(localData, {
        characterId: asId<CharacterId>('character'),
        ref: personalRef(definition),
        kind: 'passive',
        learned: known(true),
        now: TEST_NOW,
      })
    }
    localData = addTestBuild(localData, 'build', 'character', {}, { passives: [{ ref: personalRef('known-passive') }, { ref: personalRef('unknown-passive') }] })
    localData = addTestScenario(localData, assignment('character', 'build'))

    expect(validateScenario(localData, asId<ScenarioId>('scenario')).dimensions.passives.status).toBe('undetermined')
    expect(hasIssue(localData, 'scenario', 'PP_COST_UNKNOWN')).toBe(true)
  })

  it('does not prove an over-cap subtotal when unknown costs may be negative', () => {
    let localData = createTestLocalData({ state: 'unknown' }, known(5))
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'known-passive', { kind: 'passive', ppCost: known(6) })
    localData = addTestDefinition(localData, 'unknown-passive', { kind: 'passive', ppCost: { state: 'unknown' } })
    for (const definition of ['known-passive', 'unknown-passive']) {
      localData = upsertLearnedNode(localData, {
        characterId: asId<CharacterId>('character'),
        ref: personalRef(definition),
        kind: 'passive',
        learned: known(true),
        now: TEST_NOW,
      })
    }
    localData = addTestBuild(localData, 'build', 'character', {}, { passives: [{ ref: personalRef('known-passive') }, { ref: personalRef('unknown-passive') }] })
    localData = addTestScenario(localData, assignment('character', 'build'))

    expect(hasIssue(localData, 'scenario', 'PP_LIMIT_EXCEEDED')).toBe(false)
    expect(hasIssue(localData, 'scenario', 'PP_COST_UNKNOWN')).toBe(true)
  })
})

describe('slot, allocation, and permission checks', () => {
  it('treats missing slot and permission fields as unknown rather than unrestricted', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = createPersonalDefinition(localData, {
      id: asId<PersonalDefinitionId>('item'),
      kind: 'item',
      name: 'Incomplete item',
      now: TEST_NOW,
    })
    localData = observe(localData, 'item', { kind: 'exact', value: 1 })
    localData = addTestBuild(localData, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    localData = addTestScenario(localData, assignment('character', 'build'))

    expect(validateScenario(localData, asId<ScenarioId>('scenario')).dimensions.equipment.status).toBe('undetermined')
    expect(hasIssue(localData, 'scenario', 'ENTITY_SLOT_UNKNOWN')).toBe(true)
    expect(hasIssue(localData, 'scenario', 'PERMISSION_REQUIREMENTS_UNKNOWN')).toBe(true)
  })

  it('keeps conflicting handedness unresolved', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'item', {
      slotKinds: {
        state: 'conflicting',
        claims: [
          { value: [HAND_SLOT], sources: [{ sourceId: 'one' }] },
          { value: [SECOND_HAND_SLOT], sources: [{ sourceId: 'two' }] },
        ],
      },
    })
    localData = observe(localData, 'item', { kind: 'exact', value: 1 })
    localData = addTestBuild(localData, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    localData = addTestScenario(localData, assignment('character', 'build'))

    expect(hasIssue(localData, 'scenario', 'ENTITY_SLOT_UNKNOWN')).toBe(true)
  })

  it('uses one copy for a shared allocation group', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'shared-item')
    localData = observe(localData, 'shared-item', { kind: 'exact', value: 1 })
    localData = addTestBuild(localData, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('shared-item'), allocationId: 'same-copy' },
      [SECOND_HAND_SLOT]: { ref: personalRef('shared-item'), allocationId: 'same-copy' },
    })
    localData = addTestScenario(localData, assignment('character', 'build'))

    expect(validateScenario(localData, asId<ScenarioId>('scenario')).dimensions.inventory.status).toBe('valid')
  })

  it('rejects an allocation ID reused for different definitions', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'first-item')
    localData = addTestDefinition(localData, 'second-item')
    localData = observe(localData, 'first-item', { kind: 'exact', value: 1 })
    localData = observe(localData, 'second-item', { kind: 'exact', value: 1 })
    localData = addTestBuild(localData, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('first-item'), allocationId: 'reused' },
      [SECOND_HAND_SLOT]: { ref: personalRef('second-item'), allocationId: 'reused' },
    })
    localData = addTestScenario(localData, assignment('character', 'build'))

    expect(hasIssue(localData, 'scenario', 'ALLOCATION_GROUP_MIXED_REFERENCES')).toBe(true)
  })

  it('does not let a selection grant its own required permission', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'self-enabling-item', {
      requirements: known([{ kind: 'permission', permission: 'special-use' }]),
      grants: known(['special-use']),
    })
    localData = observe(localData, 'self-enabling-item', { kind: 'exact', value: 1 })
    localData = addTestBuild(localData, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('self-enabling-item') },
    })
    localData = addTestScenario(localData, assignment('character', 'build'))

    expect(hasIssue(localData, 'scenario', 'UNSUPPORTED_PERMISSION_CYCLE')).toBe(true)
  })

  it('does not share equipment permissions across characters', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'granting-character')
    localData = addTestCharacter(localData, 'requiring-character')
    localData = addTestDefinition(localData, 'granting-item', { grants: known(['special-use']) })
    localData = addTestDefinition(localData, 'requiring-item', {
      requirements: known([{ kind: 'permission', permission: 'special-use' }]),
    })
    localData = observe(localData, 'granting-item', { kind: 'exact', value: 1 })
    localData = observe(localData, 'requiring-item', { kind: 'exact', value: 1 })
    localData = addTestBuild(localData, 'granting-build', 'granting-character', {
      [HAND_SLOT]: { ref: personalRef('granting-item') },
    })
    localData = addTestBuild(localData, 'requiring-build', 'requiring-character', {
      [HAND_SLOT]: { ref: personalRef('requiring-item') },
    })
    localData = addTestScenario(localData, {
      ...assignment('granting-character', 'granting-build'),
      ...assignment('requiring-character', 'requiring-build'),
    })

    expect(hasIssue(localData, 'scenario', 'REQUIRED_PERMISSION_MISSING')).toBe(true)
  })

  it('does not use a mechanically invalid selection as a permission source', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'invalid-grant', {
      slotKinds: known([SECOND_HAND_SLOT]),
      grants: known(['special-use']),
    })
    localData = addTestDefinition(localData, 'requiring-item', {
      requirements: known([{ kind: 'permission', permission: 'special-use' }]),
    })
    localData = observe(localData, 'invalid-grant', { kind: 'exact', value: 1 })
    localData = observe(localData, 'requiring-item', { kind: 'exact', value: 1 })
    localData = addTestBuild(localData, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('invalid-grant') },
      [SECOND_HAND_SLOT]: { ref: personalRef('requiring-item') },
    })
    localData = addTestScenario(localData, assignment('character', 'build'))

    expect(hasIssue(localData, 'scenario', 'REQUIRED_PERMISSION_SOURCE_INVALID')).toBe(true)
  })

  it('does not let two selected requirements validate each other circularly', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'first-item')
    localData = addTestDefinition(localData, 'second-item')
    localData = {
      ...localData,
      personalDefinitions: {
        ...localData.personalDefinitions,
        'first-item': { ...localData.personalDefinitions['first-item']!, requirements: known([{ kind: 'selected', ref: personalRef('second-item') }]) },
        'second-item': { ...localData.personalDefinitions['second-item']!, requirements: known([{ kind: 'selected', ref: personalRef('first-item') }]) },
      },
    }
    localData = observe(localData, 'first-item', { kind: 'exact', value: 1 })
    localData = observe(localData, 'second-item', { kind: 'exact', value: 1 })
    localData = addTestBuild(localData, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('first-item') },
      [SECOND_HAND_SLOT]: { ref: personalRef('second-item') },
    })
    localData = addTestScenario(localData, assignment('character', 'build'))

    expect(hasIssue(localData, 'scenario', 'REQUIRED_SELECTION_CYCLE')).toBe(true)
  })

  it('keeps a definitely missing requirement invalid beside an unresolved cycle', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'first-item')
    localData = addTestDefinition(localData, 'second-item')
    localData = {
      ...localData,
      personalDefinitions: {
        ...localData.personalDefinitions,
        'first-item': {
          ...localData.personalDefinitions['first-item']!,
          requirements: known([
            { kind: 'selected', ref: personalRef('missing-item') },
            { kind: 'selected', ref: personalRef('second-item') },
          ]),
        },
        'second-item': { ...localData.personalDefinitions['second-item']!, requirements: known([{ kind: 'selected', ref: personalRef('first-item') }]) },
      },
    }
    localData = observe(localData, 'first-item', { kind: 'exact', value: 1 })
    localData = observe(localData, 'second-item', { kind: 'exact', value: 1 })
    localData = addTestBuild(localData, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('first-item') },
      [SECOND_HAND_SLOT]: { ref: personalRef('second-item') },
    })
    localData = addTestScenario(localData, assignment('character', 'build'))

    const report = validateScenario(localData, asId<ScenarioId>('scenario'))
    expect(report.issues.some((entry) => entry.code === 'REQUIRED_SELECTION_MISSING')).toBe(true)
    expect(report.dimensions.equipment.status).toBe('invalid')
  })
})

describe('catalog revision identity', () => {
  function catalogRef(revision: string): EntityRef {
    return {
      kind: 'catalog',
      catalogId: asId<CatalogId>('catalog'),
      catalogRevisionId: asId<CatalogRevisionId>(revision),
      entityId: asId<EntityId>('stable-item'),
    }
  }

  function catalogEntity(name: string): CatalogEntity {
    return {
      id: asId<EntityId>('stable-item'),
      kind: 'item',
      name,
      aliases: [],
      fields: {},
      slotKinds: known([HAND_SLOT]),
      requirements: known([]),
      grants: known([]),
      sources: [],
    }
  }

  it('matches current stock to an old pinned build by stable catalog entity identity', () => {
    const oldRef = catalogRef('old')
    const newRef = catalogRef('new')
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = observeInventory(localData, {
      positionId: asId<InventoryPositionId>('position'),
      ref: newRef,
      possession: 'owned',
      quantity: { kind: 'exact', value: 1 },
      now: TEST_NOW,
    })
    localData = addTestBuild(localData, 'build', 'character', {
      [HAND_SLOT]: { ref: oldRef },
    }, { catalogLock: { catalog: asId<CatalogRevisionId>('old') } })
    const team = addTestTeam(localData, ['character'])
    localData = team.localData
    localData = createScenario(localData, {
      id: asId<ScenarioId>('scenario'),
      label: 'Pinned',
      memberIds: team.memberIds,
      assignments: assignment('character', 'build'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      now: TEST_NOW,
    })
    const catalogs: CatalogIndex = {
      snapshots: {},
      entitiesByRef: { [entityDefinitionKey(oldRef)]: catalogEntity('Old definition') },
    }

    expect(validateScenario(localData, asId<ScenarioId>('scenario'), catalogs).dimensions.inventory.status).toBe('valid')
  })

  it('does not substitute a same-identity newer definition for a missing pinned revision', () => {
    const oldRef = catalogRef('old')
    const newRef = catalogRef('new')
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = observeInventory(localData, {
      positionId: asId<InventoryPositionId>('position'),
      ref: newRef,
      possession: 'owned',
      quantity: { kind: 'exact', value: 1 },
      now: TEST_NOW,
    })
    localData = addTestBuild(localData, 'build', 'character', {
      [HAND_SLOT]: { ref: oldRef },
    }, { catalogLock: { catalog: asId<CatalogRevisionId>('old') } })
    localData = addTestScenario(localData, assignment('character', 'build'))
    const catalogs: CatalogIndex = {
      snapshots: {},
      entitiesByRef: { [entityDefinitionKey(newRef)]: catalogEntity('Replacement with same name') },
    }
    const report = validateScenario(localData, asId<ScenarioId>('scenario'), catalogs)

    expect(report.issues.some((issue) => issue.code === 'DEFINITION_UNAVAILABLE')).toBe(true)
    expect(report.dimensions.inventory.status).toBe('valid')
  })

  it('rejects a catalog selection outside its build revision lock', () => {
    const lockedRef = catalogRef('revision-a')
    const selectedRef = catalogRef('revision-b')
    let localData = withCatalogLock(createTestLocalData())
    localData = addTestCharacter(localData, 'character')
    localData = observeInventory(localData, {
      positionId: asId<InventoryPositionId>('position'),
      ref: selectedRef,
      possession: 'owned',
      quantity: { kind: 'exact', value: 1 },
      now: TEST_NOW,
    })
    localData = addTestBuild(localData, 'build', 'character', {
      [HAND_SLOT]: { ref: lockedRef },
    })
    localData = addTestScenario(localData, assignment('character', 'build'))
    const revision = localData.buildRevisions['build-revision']!
    localData = {
      ...localData,
      buildRevisions: {
        ...localData.buildRevisions,
        'build-revision': {
          ...revision,
          content: { ...revision.content, equipment: { [HAND_SLOT]: { ref: selectedRef } } },
        },
      },
    }
    const catalogs: CatalogIndex = {
      snapshots: { locked: catalogSnapshot('revision-a', known('test')) },
      entitiesByRef: { [entityDefinitionKey(selectedRef)]: catalogEntity('Wrong revision') },
    }

    const report = validateScenario(localData, asId<ScenarioId>('scenario'), catalogs)
    expect(report.issues.some((entry) => entry.code === 'CATALOG_REFERENCE_REVISION_MISMATCH')).toBe(true)
    expect(report.dimensions.gameSetupCertainty.status).toBe('invalid')
  })
})

describe('scenario revision locks', () => {
  it('rejects a scenario lock that differs from its gameSetup even when its build agrees', () => {
    const lock = { catalog: asId<CatalogRevisionId>('arbitrary') }
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestBuild(localData, 'build', 'character', {}, { catalogLock: lock })
    const team = addTestTeam(localData, ['character'])
    localData = team.localData
    localData = createScenario(localData, {
      id: asId<ScenarioId>('scenario'),
      label: 'Mismatched lock',
      memberIds: team.memberIds,
      assignments: assignment('character', 'build'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      catalogLock: lock,
      now: TEST_NOW,
    })

    expect(hasIssue(localData, 'scenario', 'SCENARIO_CATALOG_LOCK_MISMATCH')).toBe(true)
  })

  it('reports a missing pinned catalog snapshot even for an all-personal build', () => {
    let localData = withCatalogLock(createTestLocalData())
    localData = addTestCharacter(localData, 'character')
    localData = addTestBuild(localData, 'build', 'character', {})
    localData = addTestScenario(localData, assignment('character', 'build'))

    expect(hasIssue(localData, 'scenario', 'CATALOG_SNAPSHOT_UNAVAILABLE')).toBe(true)
  })

  it.each([
    [{ state: 'unknown' } as const, 'CATALOG_APPLICABILITY_UNKNOWN', 'undetermined'],
    [{ state: 'notApplicable', reason: 'different platform' } as const, 'CATALOG_NOT_APPLICABLE', 'invalid'],
  ])('uses pinned catalog applicability in gameSetup certainty', (applicability, code, status) => {
    let localData = withCatalogLock(createTestLocalData())
    const team = addTestTeam(localData)
    localData = team.localData
    localData = createScenario(localData, {
      id: asId<ScenarioId>('scenario'),
      label: 'Catalog applicability',
      memberIds: team.memberIds,
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      now: TEST_NOW,
    })
    const catalogs: CatalogIndex = {
      snapshots: { snapshot: catalogSnapshot('revision-a', applicability) },
      entitiesByRef: {},
    }

    const report = validateScenario(localData, asId<ScenarioId>('scenario'), catalogs)
    expect(report.issues.some((entry) => entry.code === code)).toBe(true)
    expect(report.dimensions.gameSetupCertainty.status).toBe(status)
  })

  it.each([
    ['Windows', '1.6.9', false],
    ['Windows', '1.6.6', true],
    ['Nintendo Switch', '1.6.6', true],
    ['Nintendo Switch', '1.6.9', true],
    ['PC', '1.6.9', true],
  ])('retains native version scope uncertainty for %s %s', (platform, gameVersion, uncertain) => {
    let localData = withCatalogLock(createTestLocalData())
    const setup = localData.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
    localData = { ...localData, gameSetups: { ...localData.gameSetups, [setup.id]: { ...setup, platform: known(platform), gameVersion: known(gameVersion) } } }
    const team = addTestTeam(localData)
    localData = createScenario(team.localData, { id: asId<ScenarioId>('native-scope'), label: 'Native scope', memberIds: team.memberIds, gameSetupRevisionId: setup.id, now: TEST_NOW })
    const catalog = { ...catalogSnapshot('revision-a', known('Windows native data')), legacy: { nativeSource: { platform: 'Windows', gameVersion: '1.6.9' } } }
    const report = validateScenario(localData, asId<ScenarioId>('native-scope'), { snapshots: { snapshot: catalog }, entitiesByRef: {} })
    expect(report.issues.some(issue => issue.code === NATIVE_SCOPE_UNVERIFIED)).toBe(uncertain)
    if (uncertain) {
      expect(report.dimensions.gameSetupCertainty.status).toBe('undetermined')
      expect(report.issues.find(issue => issue.code === NATIVE_SCOPE_UNVERIFIED)?.message).toContain(`${platform} ${gameVersion}`)
    }
  })

  it('rejects future baseline revisions in commands and validation', () => {
    let localData = createTestLocalData()
    const team = addTestTeam(localData)
    localData = team.localData
    expect(() => createScenario(localData, {
      id: asId<ScenarioId>('future'),
      label: 'Future baseline',
      memberIds: team.memberIds,
      baseline: { kind: 'recordedParty', playthroughRevision: requirePlaythrough(localData).revision + 1, assignments: {} },
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))

    localData = createScenario(localData, {
      id: asId<ScenarioId>('scenario'),
      label: 'Valid baseline',
      memberIds: team.memberIds,
      baseline: { kind: 'recordedParty', playthroughRevision: requirePlaythrough(localData).revision, assignments: {} },
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      now: TEST_NOW,
    })
    const scenario = requirePlaythrough(localData).scenarios.scenario!
    const playthrough = requirePlaythrough(localData)
    localData = {
      ...localData,
      playthroughs: {
        ...localData.playthroughs,
        [playthrough.id]: {
          ...playthrough,
          scenarios: {
            ...playthrough.scenarios,
            scenario: {
              ...scenario,
              baseline: { kind: 'recordedParty', playthroughRevision: playthrough.revision + 1, assignments: {} },
            },
          },
        },
      },
    }

    expect(hasIssue(localData, 'scenario', 'SCENARIO_BASELINE_REVISION_INVALID')).toBe(true)
  })
})
