import { savedCatalogVersion } from './legacy-definition.test-helpers'
import { describe, expect, it } from 'vitest'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { equipmentFacts } from './mechanics-facts'

import {
  asId,
  coalesceDefinitionOverrides,
  createBuild,
  createScenario,
  revisePersonalDefinition,
  createPersonalDefinition,
  logicalEntityKey,
  MAX_LONG_TEXT_LENGTH,
  MAX_SHORT_TEXT_LENGTH,
  observeInventory,
  preferredDefinitionRef,
  preferredPersonalDefinitions,
  resolveDefinition,
  requirePlaythrough,
  saveBuildRevision,
  updateGameSetupRevision,
  upsertLearnedNode,
  validateScenario,
} from './index'
import {
  HAND_SLOT,
  TEST_GAME_SETUP_ID,
  TEST_NOW,
  TEST_GAME_SETUP_REVISION_ID,
  addTestCharacter,
  addTestTeam,
  createTestLocalData,
  known,
  personalRef,
} from './test-helpers'
import type {
  BuildId,
  BuildRevisionId,
  CatalogId,
  CatalogRef,
  CatalogRevisionId,
  CharacterId,
  CatalogSnapshot,
  EntityId,
  InventoryPositionId,
  JsonValue,
  Knowledge,
  PersonalDefinitionId,
  GameSetupRevisionId,
  ScenarioId,
} from './types'

const BASE_REF: CatalogRef = {
  kind: 'catalog',
  catalogId: asId<CatalogId>('built-in'),
  catalogRevisionId: asId<CatalogRevisionId>('names-1'),
  entityId: asId<EntityId>('sword'),
}

const CATALOG: CatalogSnapshot = {
  id: BASE_REF.catalogId,
  revisionId: BASE_REF.catalogRevisionId,
  schemaVersion: 'test',
  checksum: 'synthetic-checksum',
  importedAt: TEST_NOW,
  applicability: known('synthetic'),
  rights: known('synthetic fixture'),
  entities: {
    sword: {
      id: BASE_REF.entityId,
      kind: 'item',
      name: 'Sword',
      aliases: ['Blade'],
      rawDescription: 'Original description',
      fields: {
        category: known('weapon'),
        unsupported: known({ preserved: true }),
      },
      slotKinds: known([HAND_SLOT]),
      ppCost: known(2),
      listedContributions: { attack: known({ value: 4, unit: 'displayed' }) },
      requirements: known([]),
      grants: known(['equip.sword']),
      sources: [{ sourceId: 'synthetic' }],
    },
  },
  claims: [],
}

const LOCATION_CLAIMS: Knowledge<JsonValue> = {
  state: 'conflicting',
  claims: [
    { value: 'Synthetic market', sources: [{ sourceId: 'https://example.com/item', locator: 'Item page', snapshot: 'revision 1' }] },
    { value: { shop: 'Synthetic weapon shop', floor: 0, open: false }, sources: [{ sourceId: 'https://example.com/table', locator: 'Weapons > Sword', snapshot: 'revision 2', applicability: 'Synthetic gameSetup' }], note: 'A more specific description' },
  ],
}

const CLAIM_CATALOG: CatalogSnapshot = {
  ...CATALOG,
  entities: { sword: { ...CATALOG.entities.sword!, fields: { ...CATALOG.entities.sword!.fields, Location: LOCATION_CLAIMS, Other: LOCATION_CLAIMS } } },
}

const CUSTOM_REF = personalRef('custom-root')

function customData(catalog = CATALOG) {
  return createPersonalDefinition(createTestLocalData(), { ...catalog.entities.sword!, id: CUSTOM_REF.definitionId, now: TEST_NOW })
}

describe('immutable custom definitions and saved catalog versions', () => {
  it('edits typed facts and clears derived values without changing source claims or historical revisions', () => {
    const originalCatalog = structuredClone(CLAIM_CATALOG)
    const first = revisePersonalDefinition(customData(CLAIM_CATALOG), { sourceRef: CUSTOM_REF, fieldUpdates: { Attack: known(15), Hands: known(2), PP: known(4), Detail: known({ enabled: false, values: [0, 'synthetic'] }) }, now: TEST_NOW })
    expect(first.definition.listedContributions?.Attack).toEqual(known({ value: 15, unit: 'listed flat value' }))
    expect(equipmentFacts(first.definition).twoHanded).toBe(true)
    expect(first.definition.ppCost).toEqual(known(4))
    expect(first.definition.fields.Location).toEqual(LOCATION_CLAIMS)
    const second = revisePersonalDefinition(first.localData, { sourceRef: first.ref, fieldUpdates: { Attack: { state: 'unknown', reason: 'Needs observation' }, Hands: null, PP: { state: 'notApplicable' }, Detail: null }, now: TEST_NOW })
    expect(second.definition.listedContributions?.Attack).toEqual({ state: 'unknown', reason: 'Needs observation' })
    expect(equipmentFacts(second.definition).twoHanded).toBeUndefined()
    expect(second.definition.ppCost).toEqual({ state: 'notApplicable' })
    expect(second.definition.fields.Detail).toBeUndefined()
    expect(second.localData.personalDefinitions[first.definition.id]).toEqual(first.definition)
    expect(CLAIM_CATALOG).toEqual(originalCatalog)
    expect(() => validateNativeLocalDataGraph(second.localData, [CLAIM_CATALOG])).not.toThrow()
  })

  it('preserves unresolved claims and saves an explicit choice with exact structured data and attribution', () => {
    const originalCatalog = structuredClone(CLAIM_CATALOG)
    const originalLocalData = observeInventory(customData(CLAIM_CATALOG), { ref: CUSTOM_REF, possession: 'owned', quantity: { kind: 'unknown' }, now: TEST_NOW })
    const unresolved = revisePersonalDefinition(originalLocalData, { sourceRef: CUSTOM_REF, now: TEST_NOW })
    expect(unresolved.definition.fields.Location).toEqual(LOCATION_CLAIMS)
    const resolved = revisePersonalDefinition(unresolved.localData, {
      sourceRef: unresolved.ref,
      fieldClaimSelections: { Location: 1 },
      now: TEST_NOW,
    })
    const selected = LOCATION_CLAIMS.claims[1]
    expect(resolved.definition.fields.Location).toEqual({ state: 'known', value: selected.value, sources: selected.sources })
    expect(resolved.definition.fields.Other).toEqual(LOCATION_CLAIMS)
    expect(resolved.definition.fields.unsupported).toEqual(CATALOG.entities.sword!.fields.unsupported)
    expect(resolved.definition.baseRef).toEqual(CUSTOM_REF)
    expect(resolved.definition.previousRevision).toEqual(unresolved.ref)
    expect(resolved.localData.personalDefinitions[unresolved.definition.id]?.fields.Location).toEqual(LOCATION_CLAIMS)
    expect(requirePlaythrough(resolved.localData).inventory).toEqual(requirePlaythrough(originalLocalData).inventory)
    expect(requirePlaythrough(resolved.localData).inventoryEvents).toEqual(requirePlaythrough(originalLocalData).inventoryEvents)
    expect(CLAIM_CATALOG).toEqual(originalCatalog)
    expect(() => validateNativeLocalDataGraph(resolved.localData, [CLAIM_CATALOG])).not.toThrow()
  })

  it.each<Readonly<Record<string, number>>>([
    { Location: -1 },
    { Location: 2 },
    { Location: 0.5 },
    { Location: Number.NaN },
    { Missing: 0 },
    { unsupported: 0 },
    { toString: 0 },
  ])('rejects invalid claim selections without changing the localData: %j', (fieldClaimSelections) => {
    const localData = customData(CLAIM_CATALOG)
    const original = structuredClone(localData)
    expect(() => revisePersonalDefinition(localData, { sourceRef: CUSTOM_REF, fieldClaimSelections, now: TEST_NOW })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(localData).toEqual(original)
  })

  it('requires one explicit category edit when a category claim is selected', () => {
    const categoryCatalog: CatalogSnapshot = { ...CATALOG, entities: { sword: { ...CATALOG.entities.sword!, fields: { Category: LOCATION_CLAIMS } } } }
    expect(() => revisePersonalDefinition(customData(categoryCatalog), { sourceRef: CUSTOM_REF, fieldClaimSelections: { Category: 0 }, category: known('edited'), now: TEST_NOW })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    const resolved = revisePersonalDefinition(customData(categoryCatalog), { sourceRef: CUSTOM_REF, fieldClaimSelections: { Category: 0 }, now: TEST_NOW })
    expect(resolved.definition.fields.Category).toMatchObject({ state: 'known', value: 'Synthetic market' })
  })

  it('keeps exact revisions while resolving a preferred immutable leaf', () => {
    const initial = revisePersonalDefinition(customData(CLAIM_CATALOG), {
      sourceRef: CUSTOM_REF,
      id: asId<PersonalDefinitionId>('sword-override-1'),
      name: 'Switch Sword',
      ppCost: known(3),
      now: TEST_NOW,
    })
    const revised = revisePersonalDefinition(initial.localData, {
      sourceRef: initial.ref,
      id: asId<PersonalDefinitionId>('sword-override-2'),
      name: 'Switch Sword+',
      aliases: ['Updated blade'],
      rawDescription: null,
      category: null,
      ppCost: null,
      now: '2026-01-03T00:00:00.000Z',
    })

    expect(initial.definition).toMatchObject({
      revision: 1,
      baseRef: CUSTOM_REF,
      name: 'Switch Sword',
      ppCost: known(3),
    })
    expect(revised.definition).toMatchObject({
      revision: 2,
      baseRef: CUSTOM_REF,
      previousRevision: initial.ref,
      name: 'Switch Sword+',
      fields: { unsupported: known({ preserved: true }) },
      slotKinds: known([HAND_SLOT]),
      listedContributions: { attack: known({ value: 4, unit: 'displayed' }) },
      requirements: known([]),
      grants: known(['equip.sword']),
    })
    expect(revised.definition.rawDescription).toBeUndefined()
    expect(revised.definition.ppCost).toBeUndefined()
    expect(resolveDefinition(revised.localData, [], initial.ref)?.name).toBe('Switch Sword')
    expect(preferredDefinitionRef(revised.localData, CUSTOM_REF)).toEqual(revised.ref)
    expect(preferredDefinitionRef(revised.localData, initial.ref)).toEqual(revised.ref)
    expect(preferredPersonalDefinitions(revised.localData).map((definition) => definition.id)).toEqual(['sword-override-2'])
    expect(logicalEntityKey(revised.localData, CUSTOM_REF)).toBe(logicalEntityKey(revised.localData, revised.ref))
    expect(() => revisePersonalDefinition(revised.localData, {
      sourceRef: initial.ref,
      name: 'Stale branch',
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  })

  it('canonicalizes edited category fields without changing other imported fields', () => {
    let localData = createPersonalDefinition(createTestLocalData(), {
      id: asId<PersonalDefinitionId>('categorized-source'),
      kind: 'item',
      name: 'Categorized source',
      fields: {
        Category: known('legacy'),
        ' category ': known('duplicate legacy'),
        unsupported: known({ preserved: true }),
      },
      now: TEST_NOW,
    })
    const preserved = revisePersonalDefinition(localData, {
      sourceRef: personalRef('categorized-source'),
      id: asId<PersonalDefinitionId>('categorized-preserved'),
      now: TEST_NOW,
    })
    expect(preserved.definition.fields).toEqual(localData.personalDefinitions['categorized-source']?.fields)

    const cleared = revisePersonalDefinition(preserved.localData, {
      sourceRef: preserved.ref,
      id: asId<PersonalDefinitionId>('categorized-cleared'),
      category: null,
      now: TEST_NOW,
    })
    expect(cleared.definition.fields).toEqual({ unsupported: known({ preserved: true }) })

    const replaced = revisePersonalDefinition(cleared.localData, {
      sourceRef: cleared.ref,
      id: asId<PersonalDefinitionId>('categorized-replaced'),
      category: known('canonical'),
      now: TEST_NOW,
    })
    expect(replaced.definition.fields).toEqual({
      unsupported: known({ preserved: true }),
      category: known('canonical'),
    })
  })

  it('rejects catalog cloning and revisions of saved catalog versions without changing data', () => {
    const saved = savedCatalogVersion(createTestLocalData(), [CATALOG], { sourceRef: BASE_REF, now: TEST_NOW })
    const original = structuredClone(saved.localData)
    for (const sourceRef of [BASE_REF, saved.ref, personalRef('missing')]) {
      expect(() => revisePersonalDefinition(saved.localData, { sourceRef, name: 'Rejected edit' })).toThrow('Only standalone custom definitions can be edited')
    }
    expect(saved.localData).toEqual(original)
    expect(resolveDefinition(saved.localData, [CATALOG], saved.ref)).toEqual(saved.definition)
    expect(() => validateNativeLocalDataGraph(saved.localData, [CATALOG])).not.toThrow()
  })

  it('uses base identity for stock without rewriting the stored observation', () => {
    const initial = savedCatalogVersion(createTestLocalData(), [CATALOG], {
      sourceRef: BASE_REF,
      id: asId<PersonalDefinitionId>('sword-override'),
      now: TEST_NOW,
    })
    const localData = observeInventory(initial.localData, {
      positionId: asId<InventoryPositionId>('sword-stock'),
      ref: BASE_REF,
      possession: 'owned',
      quantity: { kind: 'exact', value: 1 },
      now: TEST_NOW,
    })

    expect(requirePlaythrough(localData).inventory['sword-stock']?.ref).toEqual(BASE_REF)
    expect(logicalEntityKey(localData, requirePlaythrough(localData).inventory['sword-stock']!.ref)).toBe(logicalEntityKey(localData, initial.ref))
    expect(() => observeInventory(localData, {
      positionId: asId<InventoryPositionId>('duplicate-stock'),
      ref: initial.ref,
      possession: 'owned',
      quantity: { kind: 'exact', value: 1 },
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'DUPLICATE_REFERENCE' }))
  })

  it('uses one logical learning record across immutable personal revisions', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = createPersonalDefinition(localData, {
      id: asId<PersonalDefinitionId>('passive'),
      kind: 'passive',
      name: 'Passive',
      ppCost: known(1),
      requirements: known([]),
      grants: known([]),
      now: TEST_NOW,
    })
    localData = upsertLearnedNode(localData, {
      characterId: asId<CharacterId>('character'),
      ref: personalRef('passive'),
      kind: 'passive',
      learned: known(true),
      now: TEST_NOW,
    })
    const override = revisePersonalDefinition(localData, {
      sourceRef: personalRef('passive'),
      id: asId<PersonalDefinitionId>('passive-2'),
      name: 'Passive 2',
      now: TEST_NOW,
    })
    localData = createBuild(override.localData, {
      id: asId<BuildId>('passive-build'),
      gameSetupId: TEST_GAME_SETUP_ID,
      title: 'Passive build',
      now: TEST_NOW,
    })
    localData = saveBuildRevision(localData, {
      buildId: asId<BuildId>('passive-build'),
      id: asId<BuildRevisionId>('passive-revision'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      content: {
        primaryClass: null,
        secondaryClass: null,
        equipment: {},
        passives: [{ ref: override.ref }],
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })
    const team = addTestTeam(localData, ['character'])
    localData = team.localData
    localData = createScenario(localData, {
      id: asId<ScenarioId>('scenario'),
      label: 'Scenario',
      memberIds: team.memberIds,
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      assignments: { character: asId<BuildRevisionId>('passive-revision') },
      now: TEST_NOW,
    })

    const report = validateScenario(localData, asId<ScenarioId>('scenario'))
    expect(report.issues.map((issue) => issue.code)).not.toContain('LEARNING_UNKNOWN')
    expect(report.issues.map((issue) => issue.code)).not.toContain('PASSIVE_NOT_LEARNED')
    expect(Object.keys(requirePlaythrough(localData).characters.character!.learnedNodes)).toEqual([
      logicalEntityKey(localData, personalRef('passive')),
    ])
  })

  it('requires an override catalog base in a build lock', () => {
    let localData = createTestLocalData()
    const override = savedCatalogVersion(localData, [CATALOG], {
      sourceRef: BASE_REF,
      id: asId<PersonalDefinitionId>('locked-override'),
      now: TEST_NOW,
    })
    localData = createBuild(override.localData, {
      id: asId<BuildId>('build'),
      gameSetupId: TEST_GAME_SETUP_ID,
      title: 'Build',
      now: TEST_NOW,
    })
    const input = {
      buildId: asId<BuildId>('build'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      content: {
        primaryClass: null,
        secondaryClass: null,
        equipment: { [HAND_SLOT]: { ref: override.ref } },
        passives: [],
        contextAssumptions: [],
      },
      now: TEST_NOW,
    } as const

    expect(() => saveBuildRevision(localData, input)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    const saved = saveBuildRevision(localData, {
      ...input,
      id: asId<BuildRevisionId>('revision'),
      catalogLock: { [BASE_REF.catalogId]: BASE_REF.catalogRevisionId },
    })
    expect(saved.buildRevisions.revision?.content.equipment[HAND_SLOT]?.ref).toEqual(override.ref)
    const invalid = {
      ...saved,
      buildRevisions: {
        ...saved.buildRevisions,
        revision: { ...saved.buildRevisions.revision!, catalogLock: {} },
      },
    }
    expect(() => validateNativeLocalDataGraph(invalid, [CATALOG])).toThrowError(expect.objectContaining({
      code: 'schema-mismatch',
    }))
  })

  it('pins preferred override leaves in a new gameSetup revision without rewriting older gameSetups', () => {
    let localData = createTestLocalData()
    localData = createPersonalDefinition(localData, {
      id: asId<PersonalDefinitionId>('custom'),
      kind: 'item',
      name: 'Custom',
      now: TEST_NOW,
    })
    const revised = revisePersonalDefinition(localData, {
      sourceRef: personalRef('custom'),
      id: asId<PersonalDefinitionId>('custom-2'),
      name: 'Custom 2',
      now: TEST_NOW,
    })

    expect(() => coalesceDefinitionOverrides(revised.localData, {
      sourceGameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      definitionRefs: [personalRef('custom')],
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
    expect(() => coalesceDefinitionOverrides(revised.localData, {
      sourceGameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      definitionRefs: [revised.ref, revised.ref],
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'DUPLICATE_REFERENCE' }))

    const coalesced = coalesceDefinitionOverrides(revised.localData, {
      sourceGameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      id: asId<GameSetupRevisionId>('gameSetup-with-overrides'),
      definitionRefs: [revised.ref],
      now: TEST_NOW,
    })
    expect(coalesced.gameSetups[TEST_GAME_SETUP_REVISION_ID]?.definitionOverrides).toBeUndefined()
    expect(coalesced.gameSetups['gameSetup-with-overrides']?.definitionOverrides).toEqual([revised.ref])

    const nextDefinition = revisePersonalDefinition(coalesced, {
      sourceRef: revised.ref,
      id: asId<PersonalDefinitionId>('custom-3'),
      name: 'Custom 3',
      now: '2026-01-04T00:00:00.000Z',
    })
    const unrelatedGameSetupEdit = updateGameSetupRevision(nextDefinition.localData, {
      sourceRevisionId: asId<GameSetupRevisionId>('gameSetup-with-overrides'),
      id: asId<GameSetupRevisionId>('gameSetup-with-old-pin'),
      label: 'Renamed only',
      now: '2026-01-05T00:00:00.000Z',
    })
    expect(unrelatedGameSetupEdit.gameSetups['gameSetup-with-old-pin']?.definitionOverrides).toEqual([revised.ref])
    expect(() => validateNativeLocalDataGraph(unrelatedGameSetupEdit, [])).not.toThrow()
  })

  it('infers catalog locks and merges a selected logical root into an explicit gameSetup layer', () => {
    const catalogOverride = savedCatalogVersion(createTestLocalData(), [CATALOG], {
      sourceRef: BASE_REF,
      id: asId<PersonalDefinitionId>('catalog-override'),
      now: TEST_NOW,
    })
    const conflicting = updateGameSetupRevision(catalogOverride.localData, {
      sourceRevisionId: TEST_GAME_SETUP_REVISION_ID,
      id: asId<GameSetupRevisionId>('conflicting-source'),
      catalogLock: { [BASE_REF.catalogId]: asId<CatalogRevisionId>('other-revision') },
      now: TEST_NOW,
    })
    expect(() => coalesceDefinitionOverrides(conflicting, {
      sourceGameSetupRevisionId: asId<GameSetupRevisionId>('conflicting-source'),
      definitionRefs: [catalogOverride.ref],
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    let localData = createPersonalDefinition(catalogOverride.localData, {
      id: asId<PersonalDefinitionId>('custom-root'),
      kind: 'item',
      name: 'Custom root',
      now: TEST_NOW,
    })
    const customOverride = revisePersonalDefinition(localData, {
      sourceRef: personalRef('custom-root'),
      id: asId<PersonalDefinitionId>('custom-override'),
      now: TEST_NOW,
    })
    localData = coalesceDefinitionOverrides(customOverride.localData, {
      sourceGameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      id: asId<GameSetupRevisionId>('first-layer'),
      definitionRefs: [catalogOverride.ref, customOverride.ref],
      now: TEST_NOW,
    })
    expect(localData.planningGameSetupRevisionId).toBe(TEST_GAME_SETUP_REVISION_ID)
    expect(localData.gameSetups['first-layer']).toMatchObject({
      catalogLock: { [BASE_REF.catalogId]: BASE_REF.catalogRevisionId },
      definitionOverrides: [catalogOverride.ref, customOverride.ref],
    })

    const customNext = revisePersonalDefinition(localData, {
      sourceRef: customOverride.ref,
      id: asId<PersonalDefinitionId>('custom-override-2'),
      now: '2026-01-03T00:00:00.000Z',
    })
    const merged = coalesceDefinitionOverrides(customNext.localData, {
      sourceGameSetupRevisionId: asId<GameSetupRevisionId>('first-layer'),
      id: asId<GameSetupRevisionId>('second-layer'),
      definitionRefs: [customNext.ref],
      now: '2026-01-04T00:00:00.000Z',
    })
    expect(merged.gameSetups['second-layer']?.definitionOverrides).toEqual([catalogOverride.ref, customNext.ref])
    expect(() => validateNativeLocalDataGraph(merged, [CATALOG])).not.toThrow()
  })

  it('rejects editable text and PP values outside native bounds', () => {
    const localData = customData()
    expect(() => createPersonalDefinition(localData, {
      kind: 'item',
      name: 'x'.repeat(MAX_SHORT_TEXT_LENGTH + 1),
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => createPersonalDefinition(localData, {
      kind: 'item',
      name: 'Item',
      aliases: ['x'.repeat(MAX_SHORT_TEXT_LENGTH + 1)],
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => createPersonalDefinition(localData, {
      kind: 'item',
      name: 'Item',
      rawDescription: 'x'.repeat(MAX_LONG_TEXT_LENGTH + 1),
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => revisePersonalDefinition(localData, {
      sourceRef: CUSTOM_REF,
      category: known(''),
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => revisePersonalDefinition(localData, {
      sourceRef: CUSTOM_REF,
      ppCost: known(Number.NaN),
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })
})
