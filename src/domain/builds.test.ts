import { describe, expect, it } from 'vitest'

import {
  asId,
  captureCharacter,
  compareBuildRevisions,
  createBuild,
  saveBuildRevision,
} from './index'
import {
  HAND_SLOT,
  TEST_NOW,
  TEST_RULESET_REVISION_ID,
  addTestCharacter,
  addTestDefinition,
  createTestProfile,
  known,
  personalRef,
} from './test-helpers'
import type {
  BuildId,
  BuildRevisionId,
  CatalogId,
  CatalogRevisionId,
  CharacterId,
  EntityId,
  PersonalDefinitionId,
  SlotId,
} from './types'

describe('build revisions and descriptive comparison', () => {
  it('keeps observed final stats separate from item-listed contributions', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'first-item')
    profile = addTestDefinition(profile, 'second-item')
    profile = captureCharacter(profile, {
      characterId: asId<CharacterId>('character'),
      displayedStats: { power: { value: known(100), unit: 'displayed' } },
      selections: { [HAND_SLOT]: personalRef('first-item') },
      now: TEST_NOW,
    })
    profile = createBuild(profile, {
      id: asId<BuildId>('build'),
      title: 'Build',
      kind: 'character',
      characterId: asId<CharacterId>('character'),
      now: TEST_NOW,
    })
    profile = saveBuildRevision(profile, {
      buildId: asId<BuildId>('build'),
      id: asId<BuildRevisionId>('first-revision'),
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      content: {
        primaryClass: null,
        secondaryClass: null,
        selections: { [HAND_SLOT]: { ref: personalRef('first-item') } },
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })
    profile = saveBuildRevision(profile, {
      buildId: asId<BuildId>('build'),
      id: asId<BuildRevisionId>('second-revision'),
      parentRevisionId: asId<BuildRevisionId>('first-revision'),
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      content: {
        primaryClass: null,
        secondaryClass: null,
        selections: { [HAND_SLOT]: { ref: personalRef('second-item') } },
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })

    const comparison = compareBuildRevisions(
      profile.buildRevisions['first-revision']!,
      profile.buildRevisions['second-revision']!,
    )
    const character = profile.characters.character!
    expect(character.snapshots[character.currentSnapshotId!]?.displayedStats.power?.value).toEqual(known(100))
    expect(comparison.differences.map((difference) => difference.path)).toEqual([
      `content.selections.${HAND_SLOT}`,
    ])
    expect(comparison.differences.some((difference) => difference.path.includes('displayedStats'))).toBe(false)
  })

  it('creates a new checkpoint when a build is rebased to another catalog revision', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'item')
    profile = createBuild(profile, {
      id: asId<BuildId>('build'),
      title: 'Build',
      kind: 'character',
      characterId: asId<CharacterId>('character'),
      now: TEST_NOW,
    })
    profile = saveBuildRevision(profile, {
      buildId: asId<BuildId>('build'),
      id: asId<BuildRevisionId>('old-revision'),
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      catalogLock: { catalog: asId<CatalogRevisionId>('old-catalog') },
      content: {
        primaryClass: null,
        secondaryClass: null,
        selections: { [HAND_SLOT]: { ref: personalRef('item') } },
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })
    const oldCheckpoint = profile.buildRevisions['old-revision']
    profile = saveBuildRevision(profile, {
      buildId: asId<BuildId>('build'),
      id: asId<BuildRevisionId>('new-revision'),
      parentRevisionId: asId<BuildRevisionId>('old-revision'),
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      catalogLock: { catalog: asId<CatalogRevisionId>('new-catalog') },
      content: oldCheckpoint!.content,
      now: TEST_NOW,
    })

    expect(profile.buildRevisions['old-revision']).toBe(oldCheckpoint)
    expect(profile.buildRevisions['old-revision']?.catalogLock.catalog).toBe('old-catalog')
    expect(profile.buildRevisions['new-revision']?.catalogLock.catalog).toBe('new-catalog')
    expect(profile.builds.build?.latestRevisionId).toBe('new-revision')
  })

  it('reports allocation grouping changes even when the selected definition is unchanged', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'item')
    profile = createBuild(profile, {
      id: asId<BuildId>('build'),
      title: 'Build',
      kind: 'character',
      characterId: asId<CharacterId>('character'),
      now: TEST_NOW,
    })
    profile = saveBuildRevision(profile, {
      buildId: asId<BuildId>('build'),
      id: asId<BuildRevisionId>('first-revision'),
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      content: {
        primaryClass: null,
        secondaryClass: null,
        selections: { [HAND_SLOT]: { ref: personalRef('item'), allocationId: 'first-copy' } },
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })
    profile = saveBuildRevision(profile, {
      buildId: asId<BuildId>('build'),
      id: asId<BuildRevisionId>('second-revision'),
      parentRevisionId: asId<BuildRevisionId>('first-revision'),
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      content: {
        primaryClass: null,
        secondaryClass: null,
        selections: { [HAND_SLOT]: { ref: personalRef('item'), allocationId: 'second-copy' } },
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })

    expect(compareBuildRevisions(
      profile.buildRevisions['first-revision']!,
      profile.buildRevisions['second-revision']!,
    ).differences.map((difference) => difference.path)).toEqual([
      `content.selections.${HAND_SLOT}`,
    ])
  })

  it('rejects commands based on a stale profile revision', () => {
    const profile = createTestProfile()

    expect(() =>
      createBuild(profile, {
        id: asId<BuildId>('build'),
        title: 'Build',
        kind: 'template',
        expectedRevision: profile.revision - 1,
        now: TEST_NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  })

  it('rejects build content with structurally missing references or slots', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = createBuild(profile, {
      id: asId<BuildId>('build'),
      title: 'Build',
      kind: 'character',
      characterId: asId<CharacterId>('character'),
      now: TEST_NOW,
    })
    expect(() => saveBuildRevision(profile, {
      buildId: asId<BuildId>('build'),
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      content: {
        primaryClass: { kind: 'personal', definitionId: asId<PersonalDefinitionId>('missing-class') },
        secondaryClass: null,
        selections: {},
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'MISSING_PERSONAL_DEFINITION' }))

    profile = addTestDefinition(profile, 'item')
    expect(() => saveBuildRevision(profile, {
      buildId: asId<BuildId>('build'),
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      content: {
        primaryClass: null,
        secondaryClass: null,
        selections: { [asId<SlotId>('unknown-slot')]: { ref: personalRef('item') } },
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('rejects catalog content outside the supplied build lock', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = createBuild(profile, {
      id: asId<BuildId>('build'),
      title: 'Build',
      kind: 'character',
      characterId: asId<CharacterId>('character'),
      now: TEST_NOW,
    })
    expect(() => saveBuildRevision(profile, {
      buildId: asId<BuildId>('build'),
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      catalogLock: { catalog: asId<CatalogRevisionId>('revision-a') },
      content: {
        primaryClass: null,
        secondaryClass: null,
        selections: {
          [HAND_SLOT]: {
            ref: {
              kind: 'catalog',
              catalogId: asId<CatalogId>('catalog'),
              catalogRevisionId: asId<CatalogRevisionId>('revision-b'),
              entityId: asId<EntityId>('item'),
            },
          },
        },
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })
})
