import { describe, expect, it } from 'vitest'

import {
  asId,
  captureCharacter,
  cloneBuild,
  compareBuildRevisions,
  createBuild,
  MAX_SHORT_TEXT_LENGTH,
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
  it('clones the latest checkpoint without changing the source build or personal state', () => {
    let profile = createTestProfile()
    profile = addTestCharacter(profile, 'character')
    profile = addTestDefinition(profile, 'item')
    profile = createBuild(profile, {
      id: asId<BuildId>('source-build'),
      title: 'Source build',
      kind: 'character',
      characterId: asId<CharacterId>('character'),
      state: 'hypothetical',
      tags: ['support', 'test'],
      favorite: true,
      now: TEST_NOW,
    })
    profile = saveBuildRevision(profile, {
      buildId: asId<BuildId>('source-build'),
      id: asId<BuildRevisionId>('source-revision'),
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      catalogLock: { catalog: asId<CatalogRevisionId>('catalog-revision') },
      content: {
        primaryClass: null,
        secondaryClass: null,
        selections: { [HAND_SLOT]: { ref: personalRef('item'), allocationId: 'copy-one' } },
        rotationNotes: 'Use after setup',
        contextAssumptions: ['Known test condition'],
      },
      note: 'Named checkpoint',
      now: TEST_NOW,
    })
    const before = profile
    const sourceBuild = profile.builds['source-build']
    const sourceRevision = profile.buildRevisions['source-revision']

    profile = cloneBuild(profile, {
      sourceBuildId: asId<BuildId>('source-build'),
      id: asId<BuildId>('cloned-build'),
      revisionId: asId<BuildRevisionId>('cloned-revision'),
      expectedRevision: profile.revision,
      now: '2026-01-03T00:00:00.000Z',
    })

    expect(profile.revision).toBe(before.revision + 1)
    expect(profile.changes.at(-1)).toMatchObject({
      command: 'build.clone',
      previousRevision: before.revision,
      nextRevision: profile.revision,
      changedPaths: ['builds.cloned-build', 'buildRevisions.cloned-revision'],
    })
    expect(profile.builds['source-build']).toBe(sourceBuild)
    expect(profile.buildRevisions['source-revision']).toBe(sourceRevision)
    expect(profile.scenarios).toBe(before.scenarios)
    expect(profile.inventory).toBe(before.inventory)
    expect(profile.characters).toBe(before.characters)
    expect(profile.builds['cloned-build']).toEqual(expect.objectContaining({
      id: 'cloned-build',
      revision: 1,
      latestRevisionId: 'cloned-revision',
      title: 'Source build (copy)',
      kind: 'character',
      characterId: 'character',
      state: 'draft',
      tags: ['support', 'test'],
      favorite: true,
    }))
    expect(profile.buildRevisions['cloned-revision']).toEqual(expect.objectContaining({
      id: 'cloned-revision',
      buildId: 'cloned-build',
      revision: 1,
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      catalogLock: { catalog: 'catalog-revision' },
      content: sourceRevision?.content,
      note: 'Named checkpoint',
    }))
    expect(profile.buildRevisions['cloned-revision']?.parentRevisionId).toBeUndefined()
    expect(profile.buildRevisions['cloned-revision']?.content).not.toBe(sourceRevision?.content)
  })

  it('rejects a generated or explicit clone title beyond the native text boundary', () => {
    let profile = createTestProfile()
    profile = createBuild(profile, {
      id: asId<BuildId>('source-build'),
      title: 'x'.repeat(MAX_SHORT_TEXT_LENGTH),
      kind: 'template',
      now: TEST_NOW,
    })
    profile = saveBuildRevision(profile, {
      buildId: asId<BuildId>('source-build'),
      id: asId<BuildRevisionId>('source-revision'),
      rulesetRevisionId: TEST_RULESET_REVISION_ID,
      content: {
        primaryClass: null,
        secondaryClass: null,
        selections: {},
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })

    expect(() => cloneBuild(profile, {
      sourceBuildId: asId<BuildId>('source-build'),
      id: asId<BuildId>('default-title-clone'),
      revisionId: asId<BuildRevisionId>('default-title-revision'),
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => cloneBuild(profile, {
      sourceBuildId: asId<BuildId>('source-build'),
      id: asId<BuildId>('explicit-title-clone'),
      revisionId: asId<BuildRevisionId>('explicit-title-revision'),
      title: 'x'.repeat(MAX_SHORT_TEXT_LENGTH + 1),
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

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
