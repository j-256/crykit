import { describe, expect, it } from 'vitest'

import {
  asId,
  createPersonalDefinition,
  createScenario,
  effectiveScenarioAssignments,
  entityDefinitionKey,
  observeInventory,
  replaceScenarioBuild,
  upsertCharacterClassProgress,
  upsertLearnedNode,
  validateScenario,
} from './index'
import {
  HAND_SLOT,
  SECOND_HAND_SLOT,
  TEST_NOW,
  TEST_RULESET_REVISION_ID,
  addTestBuild,
  addTestCharacter,
  addTestDefinition,
  addTestScenario,
  createTestProfile,
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
  Profile,
  ScenarioId,
} from './types'

function observe(
  profile: Profile,
  definition: string,
  quantity: { readonly kind: 'exact' | 'atLeast'; readonly value: number } | { readonly kind: 'unknown' },
  possession: 'owned' | 'notOwned' | 'unknown' = 'owned',
  protectedQuantity = 0,
): Profile {
  return observeInventory(profile, {
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

function hasIssue(profile: Profile, scenario = 'scenario', code: string): boolean {
  return validateScenario(profile, asId<ScenarioId>(scenario)).issues.some((issue) => issue.code === code)
}

function withCatalogLock(profile: Profile, revision = 'revision-a'): Profile {
  const ruleset = profile.rulesets[TEST_RULESET_REVISION_ID]!
  return {
    ...profile,
    rulesets: {
      ...profile.rulesets,
      [TEST_RULESET_REVISION_ID]: {
        ...ruleset,
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
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'item')
    profile = observe(profile, 'item', { kind: 'exact', value: 1 })
    profile = addTestBuild(profile, 'first-build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    profile = addTestBuild(profile, 'second-build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    profile = addTestScenario(profile, assignment('character', 'first-build'))

    expect(validateScenario(profile, asId<ScenarioId>('scenario')).dimensions.inventory.status).toBe('valid')
  })

  it('reports one confirmed copy assigned to two simultaneous characters', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'first-character')
    profile = addTestCharacter(profile, 'second-character')
    profile = addTestDefinition(profile, 'item')
    profile = observe(profile, 'item', { kind: 'exact', value: 1 })
    profile = addTestBuild(profile, 'first-build', 'first-character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    profile = addTestBuild(profile, 'second-build', 'second-character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    profile = addTestScenario(profile, {
      ...assignment('first-character', 'first-build'),
      ...assignment('second-character', 'second-build'),
    })

    const report = validateScenario(profile, asId<ScenarioId>('scenario'))
    expect(report.dimensions.inventory.status).toBe('invalid')
    expect(report.issues.some((issue) => issue.code === 'STOCK_SHORTAGE')).toBe(true)
  })

  it('replaces a recorded baseline assignment instead of layering the override', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'item')
    profile = observe(profile, 'item', { kind: 'exact', value: 1 })
    profile = addTestBuild(profile, 'recorded-build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    profile = addTestBuild(profile, 'replacement-build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    profile = createScenario(profile, {
      id: asId<ScenarioId>('scenario'),
      label: 'Replacement',
      baseline: {
        kind: 'recordedParty',
        profileRevision: profile.revision,
        assignments: assignment('character', 'recorded-build'),
      },
      assignments: assignment('character', 'replacement-build'),
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      now: TEST_NOW,
    })

    expect(effectiveScenarioAssignments(profile.scenarios.scenario!)).toEqual(
      assignment('character', 'replacement-build'),
    )
    expect(validateScenario(profile, asId<ScenarioId>('scenario')).dimensions.inventory.status).toBe('valid')
  })

  it('can explicitly remove a baseline character assignment', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'item')
    profile = addTestBuild(profile, 'recorded-build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    profile = createScenario(profile, {
      id: asId<ScenarioId>('scenario'),
      label: 'Removal',
      baseline: {
        kind: 'recordedParty',
        profileRevision: profile.revision,
        assignments: assignment('character', 'recorded-build'),
      },
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      now: TEST_NOW,
    })
    profile = replaceScenarioBuild(profile, {
      scenarioId: asId<ScenarioId>('scenario'),
      characterId: asId<CharacterId>('character'),
      buildRevisionId: null,
      now: TEST_NOW,
    })

    expect(effectiveScenarioAssignments(profile.scenarios.scenario!)).toEqual({})
  })

  it('confirms sufficiency when an at-least bound covers demand', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'first-character')
    profile = addTestCharacter(profile, 'second-character')
    profile = addTestDefinition(profile, 'item')
    profile = observe(profile, 'item', { kind: 'atLeast', value: 2 })
    profile = addTestBuild(profile, 'first-build', 'first-character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    profile = addTestBuild(profile, 'second-build', 'second-character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    profile = addTestScenario(profile, {
      ...assignment('first-character', 'first-build'),
      ...assignment('second-character', 'second-build'),
    })

    expect(validateScenario(profile, asId<ScenarioId>('scenario')).dimensions.inventory.status).toBe('valid')
  })

  it('keeps supply undetermined when demand exceeds only the known lower bound', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'first-character')
    profile = addTestCharacter(profile, 'second-character')
    profile = addTestDefinition(profile, 'item')
    profile = observe(profile, 'item', { kind: 'atLeast', value: 1 })
    profile = addTestBuild(profile, 'first-build', 'first-character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    profile = addTestBuild(profile, 'second-build', 'second-character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    profile = addTestScenario(profile, {
      ...assignment('first-character', 'first-build'),
      ...assignment('second-character', 'second-build'),
    })

    expect(validateScenario(profile, asId<ScenarioId>('scenario')).dimensions.inventory.status).toBe('undetermined')
  })

  it('does not turn unknown current possession into a hard shortage', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'item')
    profile = observe(profile, 'item', { kind: 'unknown' }, 'unknown')
    profile = addTestBuild(profile, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    profile = addTestScenario(profile, assignment('character', 'build'))

    const report = validateScenario(profile, asId<ScenarioId>('scenario'))
    expect(report.dimensions.inventory.status).toBe('undetermined')
    expect(report.issues.some((issue) => issue.code === 'STOCK_SHORTAGE')).toBe(false)
  })

  it('does not enforce stock when the scenario disables stock checks', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'item')
    profile = addTestBuild(profile, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    profile = createScenario(profile, {
      id: asId<ScenarioId>('scenario'),
      label: 'Informational scenario',
      assignments: assignment('character', 'build'),
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      inventoryPolicy: { enforceStock: false, includeProtected: false },
      now: TEST_NOW,
    })

    const report = validateScenario(profile, asId<ScenarioId>('scenario'))
    expect(report.dimensions.inventory.status).toBe('notApplicable')
    expect(report.issues.some((entry) => entry.code.startsWith('STOCK_'))).toBe(false)
  })

  it('does not manufacture stock from a protected quantity', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'item')
    profile = observe(profile, 'item', { kind: 'atLeast', value: 1 }, 'owned', 2)
    profile = addTestBuild(profile, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    profile = addTestScenario(profile, assignment('character', 'build'))

    expect(profile.inventory['item-position']?.quantity).toEqual({ kind: 'atLeast', value: 1 })
    expect(validateScenario(profile, asId<ScenarioId>('scenario')).dimensions.inventory.status).toBe('undetermined')
  })

  it('retains unchanged recorded-party members when another assignment is replaced', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'first-character')
    profile = addTestCharacter(profile, 'second-character')
    profile = addTestDefinition(profile, 'first-item')
    profile = addTestDefinition(profile, 'second-item')
    profile = addTestBuild(profile, 'first-recorded', 'first-character', {
      [HAND_SLOT]: { ref: personalRef('first-item') },
    })
    profile = addTestBuild(profile, 'first-replacement', 'first-character', {})
    profile = addTestBuild(profile, 'second-recorded', 'second-character', {
      [HAND_SLOT]: { ref: personalRef('second-item') },
    })
    profile = createScenario(profile, {
      id: asId<ScenarioId>('scenario'),
      label: 'Partial replacement',
      baseline: {
        kind: 'recordedParty',
        profileRevision: profile.revision,
        assignments: {
          ...assignment('first-character', 'first-recorded'),
          ...assignment('second-character', 'second-recorded'),
        },
      },
      assignments: assignment('first-character', 'first-replacement'),
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      now: TEST_NOW,
    })

    expect(effectiveScenarioAssignments(profile.scenarios.scenario!)).toEqual({
      ...assignment('first-character', 'first-replacement'),
      ...assignment('second-character', 'second-recorded'),
    })
  })
})

describe('PP bounds and character readiness', () => {
  it('uses an unlocked class as a character-local permission source', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'class', { kind: 'class', grants: known(['special-use']) })
    profile = addTestDefinition(profile, 'requiring-item', {
      requirements: known([{ kind: 'permission', permission: 'special-use' }]),
    })
    profile = upsertCharacterClassProgress(profile, {
      characterId: asId<CharacterId>('character'),
      classRef: personalRef('class'),
      unlocked: known(true),
      now: TEST_NOW,
    })
    profile = observe(profile, 'requiring-item', { kind: 'exact', value: 1 })
    profile = addTestBuild(profile, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('requiring-item') },
    }, { primaryClass: personalRef('class') })
    profile = addTestScenario(profile, assignment('character', 'build'))

    const report = validateScenario(profile, asId<ScenarioId>('scenario'))
    expect(report.issues.some((entry) => entry.code.startsWith('REQUIRED_PERMISSION'))).toBe(false)
    expect(report.issues.some((entry) => entry.code === 'UNSUPPORTED_PERMISSION_CYCLE')).toBe(false)
  })

  it('does not bootstrap a permission from a class with unresolved requirements', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'class', {
      kind: 'class',
      requirements: { state: 'unknown' },
      grants: known(['special-use']),
    })
    profile = addTestDefinition(profile, 'invalid-grant', {
      slotKinds: known([SECOND_HAND_SLOT]),
      grants: known(['special-use']),
    })
    profile = addTestDefinition(profile, 'requiring-item', {
      requirements: known([{ kind: 'permission', permission: 'special-use' }]),
    })
    profile = upsertCharacterClassProgress(profile, {
      characterId: asId<CharacterId>('character'),
      classRef: personalRef('class'),
      unlocked: known(true),
      now: TEST_NOW,
    })
    profile = observe(profile, 'invalid-grant', { kind: 'exact', value: 1 })
    profile = observe(profile, 'requiring-item', { kind: 'exact', value: 1 })
    profile = addTestBuild(profile, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('invalid-grant') },
      [SECOND_HAND_SLOT]: { ref: personalRef('requiring-item') },
    }, { primaryClass: personalRef('class') })
    profile = addTestScenario(profile, assignment('character', 'build'))

    const report = validateScenario(profile, asId<ScenarioId>('scenario'))
    expect(report.issues.some((entry) => entry.code === 'PERMISSION_GRANT_UNKNOWN' && entry.status === 'undetermined')).toBe(true)
    expect(report.issues.some((entry) => entry.code === 'REQUIRED_PERMISSION_SOURCE_INVALID')).toBe(false)
  })

  it('rejects a non-class definition used as a class selection', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'item')
    profile = addTestBuild(profile, 'build', 'character', {}, {
      primaryClass: personalRef('item'),
    })
    profile = addTestScenario(profile, assignment('character', 'build'))

    expect(hasIssue(profile, 'scenario', 'CLASS_ENTITY_KIND_INVALID')).toBe(true)
    expect(validateScenario(profile, asId<ScenarioId>('scenario')).dimensions.characterReadiness.status).toBe('invalid')
  })

  it('proves PP invalidity from an over-cap subtotal only under a nonnegative-cost rule', () => {
    let profile = createTestProfile(known(true))
    profile = addTestCharacter(profile, 'character', 5)
    profile = addTestDefinition(profile, 'known-passive', { kind: 'passive', ppCost: known(6) })
    profile = addTestDefinition(profile, 'unknown-passive', { kind: 'passive', ppCost: { state: 'unknown' } })
    profile = upsertLearnedNode(profile, {
      characterId: asId<CharacterId>('character'),
      ref: personalRef('known-passive'),
      kind: 'passive',
      learned: known(true),
      now: TEST_NOW,
    })
    profile = upsertLearnedNode(profile, {
      characterId: asId<CharacterId>('character'),
      ref: personalRef('unknown-passive'),
      kind: 'passive',
      learned: known(true),
      now: TEST_NOW,
    })
    profile = addTestBuild(profile, 'build', 'character', {}, { passives: [{ ref: personalRef('known-passive') }, { ref: personalRef('unknown-passive') }] })
    profile = addTestScenario(profile, assignment('character', 'build'))

    expect(hasIssue(profile, 'scenario', 'PP_CAPACITY_EXCEEDED_BY_KNOWN_SUBTOTAL')).toBe(true)
  })

  it('keeps PP unresolved when an unknown cost could exceed the remaining budget', () => {
    let profile = createTestProfile(known(true))
    profile = addTestCharacter(profile, 'character', 5)
    profile = addTestDefinition(profile, 'known-passive', { kind: 'passive', ppCost: known(4) })
    profile = addTestDefinition(profile, 'unknown-passive', { kind: 'passive', ppCost: { state: 'unknown' } })
    for (const definition of ['known-passive', 'unknown-passive']) {
      profile = upsertLearnedNode(profile, {
        characterId: asId<CharacterId>('character'),
        ref: personalRef(definition),
        kind: 'passive',
        learned: known(true),
        now: TEST_NOW,
      })
    }
    profile = addTestBuild(profile, 'build', 'character', {}, { passives: [{ ref: personalRef('known-passive') }, { ref: personalRef('unknown-passive') }] })
    profile = addTestScenario(profile, assignment('character', 'build'))

    expect(validateScenario(profile, asId<ScenarioId>('scenario')).dimensions.passives.status).toBe('undetermined')
    expect(hasIssue(profile, 'scenario', 'PP_TOTAL_UNKNOWN')).toBe(true)
  })

  it('does not prove an over-cap subtotal when unknown costs may be negative', () => {
    let profile = createTestProfile({ state: 'unknown' })
    profile = addTestCharacter(profile, 'character', 5)
    profile = addTestDefinition(profile, 'known-passive', { kind: 'passive', ppCost: known(6) })
    profile = addTestDefinition(profile, 'unknown-passive', { kind: 'passive', ppCost: { state: 'unknown' } })
    for (const definition of ['known-passive', 'unknown-passive']) {
      profile = upsertLearnedNode(profile, {
        characterId: asId<CharacterId>('character'),
        ref: personalRef(definition),
        kind: 'passive',
        learned: known(true),
        now: TEST_NOW,
      })
    }
    profile = addTestBuild(profile, 'build', 'character', {}, { passives: [{ ref: personalRef('known-passive') }, { ref: personalRef('unknown-passive') }] })
    profile = addTestScenario(profile, assignment('character', 'build'))

    expect(hasIssue(profile, 'scenario', 'PP_CAPACITY_EXCEEDED_BY_KNOWN_SUBTOTAL')).toBe(false)
    expect(hasIssue(profile, 'scenario', 'PP_TOTAL_UNKNOWN')).toBe(true)
  })
})

describe('slot, allocation, and permission checks', () => {
  it('treats missing slot and permission fields as unknown rather than unrestricted', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = createPersonalDefinition(profile, {
      id: asId<PersonalDefinitionId>('item'),
      kind: 'item',
      name: 'Incomplete item',
      now: TEST_NOW,
    })
    profile = observe(profile, 'item', { kind: 'exact', value: 1 })
    profile = addTestBuild(profile, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    profile = addTestScenario(profile, assignment('character', 'build'))

    expect(validateScenario(profile, asId<ScenarioId>('scenario')).dimensions.equipment.status).toBe('undetermined')
    expect(hasIssue(profile, 'scenario', 'ENTITY_SLOT_UNKNOWN')).toBe(true)
    expect(hasIssue(profile, 'scenario', 'PERMISSION_REQUIREMENTS_UNKNOWN')).toBe(true)
  })

  it('keeps conflicting handedness unresolved', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'item', {
      slotKinds: {
        state: 'conflicting',
        claims: [
          { value: [HAND_SLOT], sources: [{ sourceId: 'one' }] },
          { value: [SECOND_HAND_SLOT], sources: [{ sourceId: 'two' }] },
        ],
      },
    })
    profile = observe(profile, 'item', { kind: 'exact', value: 1 })
    profile = addTestBuild(profile, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('item') },
    })
    profile = addTestScenario(profile, assignment('character', 'build'))

    expect(hasIssue(profile, 'scenario', 'ENTITY_SLOT_UNKNOWN')).toBe(true)
  })

  it('uses one copy for a verified two-slot allocation group', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'two-slot-item', { occupiesSlots: known(2) })
    profile = observe(profile, 'two-slot-item', { kind: 'exact', value: 1 })
    profile = addTestBuild(profile, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('two-slot-item'), allocationId: 'same-copy' },
      [SECOND_HAND_SLOT]: { ref: personalRef('two-slot-item'), allocationId: 'same-copy' },
    })
    profile = addTestScenario(profile, assignment('character', 'build'))

    expect(validateScenario(profile, asId<ScenarioId>('scenario')).dimensions.inventory.status).toBe('valid')
    expect(hasIssue(profile, 'scenario', 'SLOT_OCCUPANCY_MISMATCH')).toBe(false)
  })

  it('rejects an allocation ID reused for different definitions', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'first-item')
    profile = addTestDefinition(profile, 'second-item')
    profile = observe(profile, 'first-item', { kind: 'exact', value: 1 })
    profile = observe(profile, 'second-item', { kind: 'exact', value: 1 })
    profile = addTestBuild(profile, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('first-item'), allocationId: 'reused' },
      [SECOND_HAND_SLOT]: { ref: personalRef('second-item'), allocationId: 'reused' },
    })
    profile = addTestScenario(profile, assignment('character', 'build'))

    expect(hasIssue(profile, 'scenario', 'ALLOCATION_GROUP_MIXED_REFERENCES')).toBe(true)
  })

  it('does not let a selection grant its own required permission', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'self-enabling-item', {
      requirements: known([{ kind: 'permission', permission: 'special-use' }]),
      grants: known(['special-use']),
    })
    profile = observe(profile, 'self-enabling-item', { kind: 'exact', value: 1 })
    profile = addTestBuild(profile, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('self-enabling-item') },
    })
    profile = addTestScenario(profile, assignment('character', 'build'))

    expect(hasIssue(profile, 'scenario', 'UNSUPPORTED_PERMISSION_CYCLE')).toBe(true)
  })

  it('does not share equipment permissions across characters', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'granting-character')
    profile = addTestCharacter(profile, 'requiring-character')
    profile = addTestDefinition(profile, 'granting-item', { grants: known(['special-use']) })
    profile = addTestDefinition(profile, 'requiring-item', {
      requirements: known([{ kind: 'permission', permission: 'special-use' }]),
    })
    profile = observe(profile, 'granting-item', { kind: 'exact', value: 1 })
    profile = observe(profile, 'requiring-item', { kind: 'exact', value: 1 })
    profile = addTestBuild(profile, 'granting-build', 'granting-character', {
      [HAND_SLOT]: { ref: personalRef('granting-item') },
    })
    profile = addTestBuild(profile, 'requiring-build', 'requiring-character', {
      [HAND_SLOT]: { ref: personalRef('requiring-item') },
    })
    profile = addTestScenario(profile, {
      ...assignment('granting-character', 'granting-build'),
      ...assignment('requiring-character', 'requiring-build'),
    })

    expect(hasIssue(profile, 'scenario', 'REQUIRED_PERMISSION_MISSING')).toBe(true)
  })

  it('does not use a mechanically invalid selection as a permission source', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'invalid-grant', {
      slotKinds: known([SECOND_HAND_SLOT]),
      grants: known(['special-use']),
    })
    profile = addTestDefinition(profile, 'requiring-item', {
      requirements: known([{ kind: 'permission', permission: 'special-use' }]),
    })
    profile = observe(profile, 'invalid-grant', { kind: 'exact', value: 1 })
    profile = observe(profile, 'requiring-item', { kind: 'exact', value: 1 })
    profile = addTestBuild(profile, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('invalid-grant') },
      [SECOND_HAND_SLOT]: { ref: personalRef('requiring-item') },
    })
    profile = addTestScenario(profile, assignment('character', 'build'))

    expect(hasIssue(profile, 'scenario', 'REQUIRED_PERMISSION_SOURCE_INVALID')).toBe(true)
  })

  it('does not let two selected requirements validate each other circularly', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'first-item')
    profile = addTestDefinition(profile, 'second-item')
    profile = {
      ...profile,
      personalDefinitions: {
        ...profile.personalDefinitions,
        'first-item': { ...profile.personalDefinitions['first-item']!, requirements: known([{ kind: 'selected', ref: personalRef('second-item') }]) },
        'second-item': { ...profile.personalDefinitions['second-item']!, requirements: known([{ kind: 'selected', ref: personalRef('first-item') }]) },
      },
    }
    profile = observe(profile, 'first-item', { kind: 'exact', value: 1 })
    profile = observe(profile, 'second-item', { kind: 'exact', value: 1 })
    profile = addTestBuild(profile, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('first-item') },
      [SECOND_HAND_SLOT]: { ref: personalRef('second-item') },
    })
    profile = addTestScenario(profile, assignment('character', 'build'))

    expect(hasIssue(profile, 'scenario', 'REQUIRED_SELECTION_CYCLE')).toBe(true)
  })

  it('keeps a definitely missing requirement invalid beside an unresolved cycle', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'first-item')
    profile = addTestDefinition(profile, 'second-item')
    profile = {
      ...profile,
      personalDefinitions: {
        ...profile.personalDefinitions,
        'first-item': {
          ...profile.personalDefinitions['first-item']!,
          requirements: known([
            { kind: 'selected', ref: personalRef('missing-item') },
            { kind: 'selected', ref: personalRef('second-item') },
          ]),
        },
        'second-item': { ...profile.personalDefinitions['second-item']!, requirements: known([{ kind: 'selected', ref: personalRef('first-item') }]) },
      },
    }
    profile = observe(profile, 'first-item', { kind: 'exact', value: 1 })
    profile = observe(profile, 'second-item', { kind: 'exact', value: 1 })
    profile = addTestBuild(profile, 'build', 'character', {
      [HAND_SLOT]: { ref: personalRef('first-item') },
      [SECOND_HAND_SLOT]: { ref: personalRef('second-item') },
    })
    profile = addTestScenario(profile, assignment('character', 'build'))

    const report = validateScenario(profile, asId<ScenarioId>('scenario'))
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
      occupiesSlots: known(1),
      requirements: known([]),
      grants: known([]),
      sources: [],
    }
  }

  it('matches current stock to an old pinned build by stable catalog entity identity', () => {
    const oldRef = catalogRef('old')
    const newRef = catalogRef('new')
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = observeInventory(profile, {
      positionId: asId<InventoryPositionId>('position'),
      ref: newRef,
      possession: 'owned',
      quantity: { kind: 'exact', value: 1 },
      now: TEST_NOW,
    })
    profile = addTestBuild(profile, 'build', 'character', {
      [HAND_SLOT]: { ref: oldRef },
    }, { catalogLock: { catalog: asId<CatalogRevisionId>('old') } })
    profile = createScenario(profile, {
      id: asId<ScenarioId>('scenario'),
      label: 'Pinned',
      assignments: assignment('character', 'build'),
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      now: TEST_NOW,
    })
    const catalogs: CatalogIndex = {
      snapshots: {},
      entitiesByRef: { [entityDefinitionKey(oldRef)]: catalogEntity('Old definition') },
    }

    expect(validateScenario(profile, asId<ScenarioId>('scenario'), catalogs).dimensions.inventory.status).toBe('valid')
  })

  it('does not substitute a same-identity newer definition for a missing pinned revision', () => {
    const oldRef = catalogRef('old')
    const newRef = catalogRef('new')
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = observeInventory(profile, {
      positionId: asId<InventoryPositionId>('position'),
      ref: newRef,
      possession: 'owned',
      quantity: { kind: 'exact', value: 1 },
      now: TEST_NOW,
    })
    profile = addTestBuild(profile, 'build', 'character', {
      [HAND_SLOT]: { ref: oldRef },
    }, { catalogLock: { catalog: asId<CatalogRevisionId>('old') } })
    profile = addTestScenario(profile, assignment('character', 'build'))
    const catalogs: CatalogIndex = {
      snapshots: {},
      entitiesByRef: { [entityDefinitionKey(newRef)]: catalogEntity('Replacement with same name') },
    }
    const report = validateScenario(profile, asId<ScenarioId>('scenario'), catalogs)

    expect(report.issues.some((issue) => issue.code === 'DEFINITION_UNAVAILABLE')).toBe(true)
    expect(report.dimensions.inventory.status).toBe('valid')
  })

  it('rejects a catalog selection outside its build revision lock', () => {
    const lockedRef = catalogRef('revision-a')
    const selectedRef = catalogRef('revision-b')
    let profile = withCatalogLock(createTestProfile())
    profile = addTestCharacter(profile, 'character')
    profile = observeInventory(profile, {
      positionId: asId<InventoryPositionId>('position'),
      ref: selectedRef,
      possession: 'owned',
      quantity: { kind: 'exact', value: 1 },
      now: TEST_NOW,
    })
    profile = addTestBuild(profile, 'build', 'character', {
      [HAND_SLOT]: { ref: lockedRef },
    })
    profile = addTestScenario(profile, assignment('character', 'build'))
    const revision = profile.buildRevisions['build-revision']!
    profile = {
      ...profile,
      buildRevisions: {
        ...profile.buildRevisions,
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

    const report = validateScenario(profile, asId<ScenarioId>('scenario'), catalogs)
    expect(report.issues.some((entry) => entry.code === 'CATALOG_REFERENCE_REVISION_MISMATCH')).toBe(true)
    expect(report.dimensions.rulesetCertainty.status).toBe('invalid')
  })
})

describe('scenario revision locks', () => {
  it('rejects a scenario lock that differs from its ruleset even when its build agrees', () => {
    const lock = { catalog: asId<CatalogRevisionId>('arbitrary') }
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestBuild(profile, 'build', 'character', {}, { catalogLock: lock })
    profile = createScenario(profile, {
      id: asId<ScenarioId>('scenario'),
      label: 'Mismatched lock',
      assignments: assignment('character', 'build'),
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      catalogLock: lock,
      now: TEST_NOW,
    })

    expect(hasIssue(profile, 'scenario', 'SCENARIO_CATALOG_LOCK_MISMATCH')).toBe(true)
  })

  it('reports a missing pinned catalog snapshot even for an all-personal build', () => {
    let profile = withCatalogLock(createTestProfile())
    profile = addTestCharacter(profile, 'character')
    profile = addTestBuild(profile, 'build', 'character', {})
    profile = addTestScenario(profile, assignment('character', 'build'))

    expect(hasIssue(profile, 'scenario', 'CATALOG_SNAPSHOT_UNAVAILABLE')).toBe(true)
  })

  it.each([
    [{ state: 'unknown' } as const, 'CATALOG_APPLICABILITY_UNKNOWN', 'undetermined'],
    [{ state: 'notApplicable', reason: 'different platform' } as const, 'CATALOG_NOT_APPLICABLE', 'invalid'],
  ])('uses pinned catalog applicability in ruleset certainty', (applicability, code, status) => {
    let profile = withCatalogLock(createTestProfile())
    profile = createScenario(profile, {
      id: asId<ScenarioId>('scenario'),
      label: 'Catalog applicability',
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      now: TEST_NOW,
    })
    const catalogs: CatalogIndex = {
      snapshots: { snapshot: catalogSnapshot('revision-a', applicability) },
      entitiesByRef: {},
    }

    const report = validateScenario(profile, asId<ScenarioId>('scenario'), catalogs)
    expect(report.issues.some((entry) => entry.code === code)).toBe(true)
    expect(report.dimensions.rulesetCertainty.status).toBe(status)
  })

  it('rejects future baseline revisions in commands and validation', () => {
    let profile = createTestProfile()
    expect(() => createScenario(profile, {
      id: asId<ScenarioId>('future'),
      label: 'Future baseline',
      baseline: { kind: 'recordedParty', profileRevision: profile.revision + 1, assignments: {} },
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))

    profile = createScenario(profile, {
      id: asId<ScenarioId>('scenario'),
      label: 'Valid baseline',
      baseline: { kind: 'recordedParty', profileRevision: profile.revision, assignments: {} },
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      now: TEST_NOW,
    })
    const scenario = profile.scenarios.scenario!
    profile = {
      ...profile,
      scenarios: {
        ...profile.scenarios,
        scenario: {
          ...scenario,
          baseline: { kind: 'recordedParty', profileRevision: profile.revision + 1, assignments: {} },
        },
      },
    }

    expect(hasIssue(profile, 'scenario', 'SCENARIO_BASELINE_REVISION_INVALID')).toBe(true)
  })
})
