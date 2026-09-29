import { describe, expect, it } from 'vitest'
import { validateNativeProfileGraph } from '../interchange/native'

import {
  asId,
  coalesceDefinitionOverrides,
  createBuild,
  createScenario,
  createDefinitionOverride,
  createPersonalDefinition,
  logicalEntityKey,
  MAX_LONG_TEXT_LENGTH,
  MAX_SHORT_TEXT_LENGTH,
  observeInventory,
  preferredDefinitionRef,
  preferredPersonalDefinitions,
  resolveDefinition,
  saveBuildRevision,
  updateRulesetRevision,
  upsertLearnedNode,
  validateScenario,
} from './index'
import {
  HAND_SLOT,
  TEST_NOW,
  TEST_RULESET_REVISION_ID,
  addTestCharacter,
  addTestTeam,
  createTestProfile,
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
  RulesetRevisionId,
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
      occupiesSlots: known(1),
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
    { value: { shop: 'Synthetic weapon shop', floor: 0, open: false }, sources: [{ sourceId: 'https://example.com/table', locator: 'Weapons > Sword', snapshot: 'revision 2', applicability: 'Synthetic ruleset' }], note: 'A more specific description' },
  ],
}

const CLAIM_CATALOG: CatalogSnapshot = {
  ...CATALOG,
  entities: { sword: { ...CATALOG.entities.sword!, fields: { ...CATALOG.entities.sword!.fields, Location: LOCATION_CLAIMS, Other: LOCATION_CLAIMS } } },
}

describe('immutable personal definition overrides', () => {
  it('preserves unresolved claims and saves an explicit choice with exact structured data and attribution', () => {
    const originalCatalog = structuredClone(CLAIM_CATALOG)
    const originalProfile = observeInventory(createTestProfile(), { ref: BASE_REF, possession: 'owned', quantity: { kind: 'unknown' }, now: TEST_NOW })
    const unresolved = createDefinitionOverride(originalProfile, [CLAIM_CATALOG], { sourceRef: BASE_REF, now: TEST_NOW })
    expect(unresolved.definition.fields.Location).toEqual(LOCATION_CLAIMS)
    const resolved = createDefinitionOverride(unresolved.profile, [CLAIM_CATALOG], {
      sourceRef: unresolved.ref,
      fieldClaimSelections: { Location: 1 },
      now: TEST_NOW,
    })
    const selected = LOCATION_CLAIMS.claims[1]
    expect(resolved.definition.fields.Location).toEqual({ state: 'known', value: selected.value, sources: selected.sources })
    expect(resolved.definition.fields.Other).toEqual(LOCATION_CLAIMS)
    expect(resolved.definition.fields.unsupported).toEqual(CATALOG.entities.sword!.fields.unsupported)
    expect(resolved.definition.baseRef).toEqual(BASE_REF)
    expect(resolved.definition.previousRevision).toEqual(unresolved.ref)
    expect(resolved.profile.personalDefinitions[unresolved.definition.id]?.fields.Location).toEqual(LOCATION_CLAIMS)
    expect(resolved.profile.inventory).toEqual(originalProfile.inventory)
    expect(resolved.profile.inventoryEvents).toEqual(originalProfile.inventoryEvents)
    expect(CLAIM_CATALOG).toEqual(originalCatalog)
    expect(() => validateNativeProfileGraph(resolved.profile, [CLAIM_CATALOG])).not.toThrow()
  })

  it.each<Readonly<Record<string, number>>>([
    { Location: -1 },
    { Location: 2 },
    { Location: 0.5 },
    { Location: Number.NaN },
    { Missing: 0 },
    { unsupported: 0 },
    { toString: 0 },
  ])('rejects invalid claim selections without changing the profile: %j', (fieldClaimSelections) => {
    const profile = createTestProfile()
    const original = structuredClone(profile)
    expect(() => createDefinitionOverride(profile, [CLAIM_CATALOG], { sourceRef: BASE_REF, fieldClaimSelections, now: TEST_NOW })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(profile).toEqual(original)
  })

  it('requires one explicit category edit when a category claim is selected', () => {
    const categoryCatalog: CatalogSnapshot = { ...CATALOG, entities: { sword: { ...CATALOG.entities.sword!, fields: { Category: LOCATION_CLAIMS } } } }
    expect(() => createDefinitionOverride(createTestProfile(), [categoryCatalog], { sourceRef: BASE_REF, fieldClaimSelections: { Category: 0 }, category: known('edited'), now: TEST_NOW })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    const resolved = createDefinitionOverride(createTestProfile(), [categoryCatalog], { sourceRef: BASE_REF, fieldClaimSelections: { Category: 0 }, now: TEST_NOW })
    expect(resolved.definition.fields.Category).toMatchObject({ state: 'known', value: 'Synthetic market' })
  })

  it('keeps exact revisions while resolving a preferred immutable leaf', () => {
    const initial = createDefinitionOverride(createTestProfile(), [CATALOG], {
      sourceRef: BASE_REF,
      id: asId<PersonalDefinitionId>('sword-override-1'),
      name: 'Switch Sword',
      ppCost: known(3),
      now: TEST_NOW,
    })
    const revised = createDefinitionOverride(initial.profile, [CATALOG], {
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
      baseRef: BASE_REF,
      name: 'Switch Sword',
      ppCost: known(3),
    })
    expect(revised.definition).toMatchObject({
      revision: 2,
      baseRef: BASE_REF,
      previousRevision: initial.ref,
      name: 'Switch Sword+',
      fields: { unsupported: known({ preserved: true }) },
      slotKinds: known([HAND_SLOT]),
      occupiesSlots: known(1),
      listedContributions: { attack: known({ value: 4, unit: 'displayed' }) },
      requirements: known([]),
      grants: known(['equip.sword']),
    })
    expect(revised.definition.rawDescription).toBeUndefined()
    expect(revised.definition.ppCost).toBeUndefined()
    expect(resolveDefinition(revised.profile, [CATALOG], initial.ref)?.name).toBe('Switch Sword')
    expect(preferredDefinitionRef(revised.profile, BASE_REF)).toEqual(revised.ref)
    expect(preferredDefinitionRef(revised.profile, initial.ref)).toEqual(revised.ref)
    expect(preferredPersonalDefinitions(revised.profile).map((definition) => definition.id)).toEqual(['sword-override-2'])
    expect(logicalEntityKey(revised.profile, BASE_REF)).toBe(logicalEntityKey(revised.profile, revised.ref))
    expect(() => createDefinitionOverride(revised.profile, [CATALOG], {
      sourceRef: initial.ref,
      name: 'Stale branch',
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  })

  it('canonicalizes edited category fields without changing other imported fields', () => {
    let profile = createPersonalDefinition(createTestProfile(), {
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
    const preserved = createDefinitionOverride(profile, [], {
      sourceRef: personalRef('categorized-source'),
      id: asId<PersonalDefinitionId>('categorized-preserved'),
      now: TEST_NOW,
    })
    expect(preserved.definition.fields).toEqual(profile.personalDefinitions['categorized-source']?.fields)

    const cleared = createDefinitionOverride(preserved.profile, [], {
      sourceRef: preserved.ref,
      id: asId<PersonalDefinitionId>('categorized-cleared'),
      category: null,
      now: TEST_NOW,
    })
    expect(cleared.definition.fields).toEqual({ unsupported: known({ preserved: true }) })

    const replaced = createDefinitionOverride(cleared.profile, [], {
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

  it('uses base identity for stock without rewriting the stored observation', () => {
    const initial = createDefinitionOverride(createTestProfile(), [CATALOG], {
      sourceRef: BASE_REF,
      id: asId<PersonalDefinitionId>('sword-override'),
      now: TEST_NOW,
    })
    const profile = observeInventory(initial.profile, {
      positionId: asId<InventoryPositionId>('sword-stock'),
      ref: BASE_REF,
      possession: 'owned',
      quantity: { kind: 'exact', value: 1 },
      now: TEST_NOW,
    })

    expect(profile.inventory['sword-stock']?.ref).toEqual(BASE_REF)
    expect(logicalEntityKey(profile, profile.inventory['sword-stock']!.ref)).toBe(logicalEntityKey(profile, initial.ref))
    expect(() => observeInventory(profile, {
      positionId: asId<InventoryPositionId>('duplicate-stock'),
      ref: initial.ref,
      possession: 'owned',
      quantity: { kind: 'exact', value: 1 },
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'DUPLICATE_REFERENCE' }))
  })

  it('uses one logical learning record across immutable personal revisions', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = createPersonalDefinition(profile, {
      id: asId<PersonalDefinitionId>('passive'),
      kind: 'passive',
      name: 'Passive',
      ppCost: known(1),
      requirements: known([]),
      grants: known([]),
      now: TEST_NOW,
    })
    profile = upsertLearnedNode(profile, {
      characterId: asId<CharacterId>('character'),
      ref: personalRef('passive'),
      kind: 'passive',
      learned: known(true),
      now: TEST_NOW,
    })
    const override = createDefinitionOverride(profile, [], {
      sourceRef: personalRef('passive'),
      id: asId<PersonalDefinitionId>('passive-2'),
      name: 'Passive 2',
      now: TEST_NOW,
    })
    profile = createBuild(override.profile, {
      id: asId<BuildId>('passive-build'),
      title: 'Passive build',
      kind: 'character',
      characterId: asId<CharacterId>('character'),
      now: TEST_NOW,
    })
    profile = saveBuildRevision(profile, {
      buildId: asId<BuildId>('passive-build'),
      id: asId<BuildRevisionId>('passive-revision'),
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      content: {
        primaryClass: null,
        secondaryClass: null,
        equipment: {},
        passives: [{ ref: override.ref }],
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })
    const team = addTestTeam(profile, ['character'])
    profile = team.profile
    profile = createScenario(profile, {
      id: asId<ScenarioId>('scenario'),
      label: 'Scenario',
      memberIds: team.memberIds,
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      assignments: { character: asId<BuildRevisionId>('passive-revision') },
      now: TEST_NOW,
    })

    const report = validateScenario(profile, asId<ScenarioId>('scenario'))
    expect(report.issues.map((issue) => issue.code)).not.toContain('LEARNING_UNKNOWN')
    expect(report.issues.map((issue) => issue.code)).not.toContain('PASSIVE_NOT_LEARNED')
    expect(Object.keys(profile.characters.character!.learnedNodes)).toEqual([
      logicalEntityKey(profile, personalRef('passive')),
    ])
  })

  it('requires an override catalog base in a build lock', () => {
    let profile = createTestProfile()
    const override = createDefinitionOverride(profile, [CATALOG], {
      sourceRef: BASE_REF,
      id: asId<PersonalDefinitionId>('locked-override'),
      now: TEST_NOW,
    })
    profile = createBuild(override.profile, {
      id: asId<BuildId>('build'),
      title: 'Build',
      kind: 'template',
      now: TEST_NOW,
    })
    const input = {
      buildId: asId<BuildId>('build'),
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      content: {
        primaryClass: null,
        secondaryClass: null,
        equipment: { [HAND_SLOT]: { ref: override.ref } },
        passives: [],
        contextAssumptions: [],
      },
      now: TEST_NOW,
    } as const

    expect(() => saveBuildRevision(profile, input)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    const saved = saveBuildRevision(profile, {
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
    expect(() => validateNativeProfileGraph(invalid, [CATALOG])).toThrowError(expect.objectContaining({
      code: 'schema-mismatch',
    }))
  })

  it('pins preferred override leaves in a new ruleset revision without rewriting older rulesets', () => {
    let profile = createTestProfile()
    profile = createPersonalDefinition(profile, {
      id: asId<PersonalDefinitionId>('custom'),
      kind: 'item',
      name: 'Custom',
      now: TEST_NOW,
    })
    const revised = createDefinitionOverride(profile, [], {
      sourceRef: personalRef('custom'),
      id: asId<PersonalDefinitionId>('custom-2'),
      name: 'Custom 2',
      now: TEST_NOW,
    })

    expect(() => coalesceDefinitionOverrides(revised.profile, {
      sourceRulesetRevisionId: TEST_RULESET_REVISION_ID,
      definitionRefs: [personalRef('custom')],
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
    expect(() => coalesceDefinitionOverrides(revised.profile, {
      sourceRulesetRevisionId: TEST_RULESET_REVISION_ID,
      definitionRefs: [revised.ref, revised.ref],
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'DUPLICATE_REFERENCE' }))

    const coalesced = coalesceDefinitionOverrides(revised.profile, {
      sourceRulesetRevisionId: TEST_RULESET_REVISION_ID,
      id: asId<RulesetRevisionId>('ruleset-with-overrides'),
      definitionRefs: [revised.ref],
      now: TEST_NOW,
    })
    expect(coalesced.rulesets[TEST_RULESET_REVISION_ID]?.definitionOverrides).toBeUndefined()
    expect(coalesced.rulesets['ruleset-with-overrides']?.definitionOverrides).toEqual([revised.ref])

    const nextDefinition = createDefinitionOverride(coalesced, [], {
      sourceRef: revised.ref,
      id: asId<PersonalDefinitionId>('custom-3'),
      name: 'Custom 3',
      now: '2026-01-04T00:00:00.000Z',
    })
    const unrelatedRulesetEdit = updateRulesetRevision(nextDefinition.profile, {
      sourceRevisionId: asId<RulesetRevisionId>('ruleset-with-overrides'),
      id: asId<RulesetRevisionId>('ruleset-with-old-pin'),
      label: 'Renamed only',
      now: '2026-01-05T00:00:00.000Z',
    })
    expect(unrelatedRulesetEdit.rulesets['ruleset-with-old-pin']?.definitionOverrides).toEqual([revised.ref])
    expect(() => validateNativeProfileGraph(unrelatedRulesetEdit, [])).not.toThrow()
  })

  it('infers catalog locks and merges a selected logical root into an explicit ruleset layer', () => {
    const catalogOverride = createDefinitionOverride(createTestProfile(), [CATALOG], {
      sourceRef: BASE_REF,
      id: asId<PersonalDefinitionId>('catalog-override'),
      now: TEST_NOW,
    })
    const conflicting = updateRulesetRevision(catalogOverride.profile, {
      sourceRevisionId: TEST_RULESET_REVISION_ID,
      id: asId<RulesetRevisionId>('conflicting-source'),
      catalogLock: { [BASE_REF.catalogId]: asId<CatalogRevisionId>('other-revision') },
      now: TEST_NOW,
    })
    expect(() => coalesceDefinitionOverrides(conflicting, {
      sourceRulesetRevisionId: asId<RulesetRevisionId>('conflicting-source'),
      definitionRefs: [catalogOverride.ref],
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    let profile = createPersonalDefinition(catalogOverride.profile, {
      id: asId<PersonalDefinitionId>('custom-root'),
      kind: 'item',
      name: 'Custom root',
      now: TEST_NOW,
    })
    const customOverride = createDefinitionOverride(profile, [], {
      sourceRef: personalRef('custom-root'),
      id: asId<PersonalDefinitionId>('custom-override'),
      now: TEST_NOW,
    })
    profile = coalesceDefinitionOverrides(customOverride.profile, {
      sourceRulesetRevisionId: TEST_RULESET_REVISION_ID,
      id: asId<RulesetRevisionId>('first-layer'),
      definitionRefs: [catalogOverride.ref, customOverride.ref],
      now: TEST_NOW,
    })
    expect(profile.activeRulesetRevisionId).toBe(TEST_RULESET_REVISION_ID)
    expect(profile.rulesets['first-layer']).toMatchObject({
      catalogLock: { [BASE_REF.catalogId]: BASE_REF.catalogRevisionId },
      definitionOverrides: [catalogOverride.ref, customOverride.ref],
    })

    const customNext = createDefinitionOverride(profile, [], {
      sourceRef: customOverride.ref,
      id: asId<PersonalDefinitionId>('custom-override-2'),
      now: '2026-01-03T00:00:00.000Z',
    })
    const merged = coalesceDefinitionOverrides(customNext.profile, {
      sourceRulesetRevisionId: asId<RulesetRevisionId>('first-layer'),
      id: asId<RulesetRevisionId>('second-layer'),
      definitionRefs: [customNext.ref],
      now: '2026-01-04T00:00:00.000Z',
    })
    expect(merged.rulesets['second-layer']?.definitionOverrides).toEqual([catalogOverride.ref, customNext.ref])
    expect(() => validateNativeProfileGraph(merged, [CATALOG])).not.toThrow()
  })

  it('rejects editable text and PP values outside native bounds', () => {
    const profile = createTestProfile()
    expect(() => createPersonalDefinition(profile, {
      kind: 'item',
      name: 'x'.repeat(MAX_SHORT_TEXT_LENGTH + 1),
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => createPersonalDefinition(profile, {
      kind: 'item',
      name: 'Item',
      aliases: ['x'.repeat(MAX_SHORT_TEXT_LENGTH + 1)],
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => createPersonalDefinition(profile, {
      kind: 'item',
      name: 'Item',
      rawDescription: 'x'.repeat(MAX_LONG_TEXT_LENGTH + 1),
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => createDefinitionOverride(profile, [CATALOG], {
      sourceRef: BASE_REF,
      category: known(''),
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => createDefinitionOverride(profile, [CATALOG], {
      sourceRef: BASE_REF,
      ppCost: known(Number.NaN),
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })
})
