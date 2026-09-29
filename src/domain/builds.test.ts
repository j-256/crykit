import { describe, expect, it } from 'vitest'

import {
  asId,
  captureCharacter,
  cloneBuild,
  compareBuildRevisions,
  createBuild,
  createGameSetupRevision,
  forkBuildToGameSetup,
  MAX_SHORT_TEXT_LENGTH,
  requirePlaythrough,
  saveBuildRevision,
} from './index'
import {
  HAND_SLOT,
  TEST_GAME_SETUP_ID,
  TEST_NOW,
  TEST_GAME_SETUP_REVISION_ID,
  addTestCharacter,
  addTestDefinition,
  createTestLocalData,
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
  GameSetupId,
  GameSetupRevisionId,
  PersonalDefinitionId,
  SlotId,
} from './types'

describe('build revisions and descriptive comparison', () => {
  it('forks an immutable checkpoint into a distinct logical Game Setup', () => {
    let localData = createTestLocalData()
    localData = createBuild(localData, {
      id: asId<BuildId>('original-build'),
      gameSetupId: TEST_GAME_SETUP_ID,
      title: 'Original Build',
      kind: 'build',
      now: TEST_NOW,
    })
    localData = saveBuildRevision(localData, {
      buildId: asId<BuildId>('original-build'),
      id: asId<BuildRevisionId>('original-revision'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      content: { primaryClass: null, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] },
      now: TEST_NOW,
    })
    const originalBuild = localData.builds['original-build']!
    const originalRevision = localData.buildRevisions['original-revision']!
    const sourceSetup = localData.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
    const targetRevisionId = asId<GameSetupRevisionId>('alternate-setup-revision')
    const targetSetupId = asId<GameSetupId>('alternate-setup')
    localData = createGameSetupRevision(localData, {
      id: targetRevisionId,
      gameSetupId: targetSetupId,
      label: 'Alternate Game Setup',
      slots: sourceSetup.slots,
      catalogLock: sourceSetup.catalogLock,
      now: TEST_NOW,
    })
    localData = forkBuildToGameSetup(localData, {
      sourceBuildId: originalBuild.id,
      targetGameSetupRevisionId: targetRevisionId,
      id: asId<BuildId>('forked-build'),
      revisionId: asId<BuildRevisionId>('forked-revision'),
      now: TEST_NOW,
    })

    expect(localData.builds['original-build']).toEqual(originalBuild)
    expect(localData.buildRevisions['original-revision']).toEqual(originalRevision)
    expect(localData.builds['forked-build']).toMatchObject({ gameSetupId: targetSetupId, title: 'Original Build (Alternate Game Setup)', latestRevisionId: 'forked-revision' })
    expect(localData.buildRevisions['forked-revision']).toMatchObject({ gameSetupRevisionId: targetRevisionId, content: originalRevision.content, note: 'Forked from Original Build' })
  })

  it('omits populated slots the target Game Setup does not define and records why', () => {
    let localData = addTestDefinition(createTestLocalData(), 'source-item')
    localData = createBuild(localData, {
      id: asId<BuildId>('source-build'),
      gameSetupId: TEST_GAME_SETUP_ID,
      title: 'Source Build',
      kind: 'build',
      now: TEST_NOW,
    })
    localData = saveBuildRevision(localData, {
      buildId: asId<BuildId>('source-build'),
      id: asId<BuildRevisionId>('source-revision'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      content: {
        primaryClass: null,
        secondaryClass: null,
        equipment: { [HAND_SLOT]: { ref: personalRef('source-item') } },
        passives: [],
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })
    const sourceBuild = localData.builds['source-build']!
    const sourceRevision = localData.buildRevisions['source-revision']!
    const sourceSetup = localData.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
    const targetRevisionId = asId<GameSetupRevisionId>('different-slots-revision')
    localData = createGameSetupRevision(localData, {
      id: targetRevisionId,
      gameSetupId: asId<GameSetupId>('different-slots'),
      label: 'Different Slots',
      slots: sourceSetup.slots.filter((slot) => slot.id !== HAND_SLOT),
      catalogLock: sourceSetup.catalogLock,
      now: TEST_NOW,
    })
    localData = forkBuildToGameSetup(localData, {
      sourceBuildId: sourceBuild.id,
      targetGameSetupRevisionId: targetRevisionId,
      id: asId<BuildId>('forked-build'),
      revisionId: asId<BuildRevisionId>('forked-revision'),
      now: TEST_NOW,
    })

    expect(localData.builds['source-build']).toBe(sourceBuild)
    expect(localData.buildRevisions['source-revision']).toBe(sourceRevision)
    expect(localData.buildRevisions['forked-revision']!.content).toEqual({
      primaryClass: null,
      secondaryClass: null,
      equipment: {},
      passives: [],
      contextAssumptions: ['Fork omitted 1 equipped selection from slots that Different Slots does not define. Inspect the original Build under Verified test Game Setup for the retained source values.'],
    })
  })

  it('clones the latest checkpoint without changing the source build or personal state', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'item')
    localData = createBuild(localData, {
      id: asId<BuildId>('source-build'),
      gameSetupId: TEST_GAME_SETUP_ID,
      title: 'Source build',
      kind: 'build',
      state: 'hypothetical',
      tags: ['support', 'test'],
      favorite: true,
      now: TEST_NOW,
    })
    localData = saveBuildRevision(localData, {
      buildId: asId<BuildId>('source-build'),
      id: asId<BuildRevisionId>('source-revision'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      catalogLock: { catalog: asId<CatalogRevisionId>('catalog-revision') },
      content: {
        primaryClass: null,
        secondaryClass: null,
        equipment: { [HAND_SLOT]: { ref: personalRef('item'), allocationId: 'copy-one' } },
        passives: [],
        rotationNotes: 'Use after setup',
        contextAssumptions: ['Known test condition'],
      },
      note: 'Named checkpoint',
      now: TEST_NOW,
    })
    const before = localData
    const sourceBuild = localData.builds['source-build']
    const sourceRevision = localData.buildRevisions['source-revision']

    localData = cloneBuild(localData, {
      sourceBuildId: asId<BuildId>('source-build'),
      id: asId<BuildId>('cloned-build'),
      revisionId: asId<BuildRevisionId>('cloned-revision'),
      expectedRevision: localData.revision,
      now: '2026-01-03T00:00:00.000Z',
    })

    expect(localData.revision).toBe(before.revision + 1)
    expect(localData.changes.at(-1)).toMatchObject({
      command: 'build.clone',
      previousRevision: before.revision,
      nextRevision: localData.revision,
      changedPaths: ['builds.cloned-build', 'buildRevisions.cloned-revision'],
    })
    expect(localData.builds['source-build']).toBe(sourceBuild)
    expect(localData.buildRevisions['source-revision']).toBe(sourceRevision)
    expect(requirePlaythrough(localData).scenarios).toBe(requirePlaythrough(before).scenarios)
    expect(requirePlaythrough(localData).inventory).toBe(requirePlaythrough(before).inventory)
    expect(requirePlaythrough(localData).characters).toBe(requirePlaythrough(before).characters)
    expect(localData.builds['cloned-build']).toEqual(expect.objectContaining({
      id: 'cloned-build',
      revision: 1,
      latestRevisionId: 'cloned-revision',
      title: 'Source build (copy)',
      kind: 'build',
      state: 'draft',
      tags: ['support', 'test'],
      favorite: true,
    }))
    expect(localData.buildRevisions['cloned-revision']).toEqual(expect.objectContaining({
      id: 'cloned-revision',
      buildId: 'cloned-build',
      revision: 1,
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      catalogLock: { catalog: 'catalog-revision' },
      content: sourceRevision?.content,
      note: 'Named checkpoint',
    }))
    expect(localData.buildRevisions['cloned-revision']?.parentRevisionId).toBeUndefined()
    expect(localData.buildRevisions['cloned-revision']?.content).not.toBe(sourceRevision?.content)
  })

  it('rejects a generated or explicit clone title beyond the native text boundary', () => {
    let localData = createTestLocalData()
    localData = createBuild(localData, {
      id: asId<BuildId>('source-build'),
      gameSetupId: TEST_GAME_SETUP_ID,
      title: 'x'.repeat(MAX_SHORT_TEXT_LENGTH),
      kind: 'template',
      now: TEST_NOW,
    })
    localData = saveBuildRevision(localData, {
      buildId: asId<BuildId>('source-build'),
      id: asId<BuildRevisionId>('source-revision'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      content: {
        primaryClass: null,
        secondaryClass: null,
        equipment: {},
        passives: [],
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })

    expect(() => cloneBuild(localData, {
      sourceBuildId: asId<BuildId>('source-build'),
      id: asId<BuildId>('default-title-clone'),
      revisionId: asId<BuildRevisionId>('default-title-revision'),
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => cloneBuild(localData, {
      sourceBuildId: asId<BuildId>('source-build'),
      id: asId<BuildId>('explicit-title-clone'),
      revisionId: asId<BuildRevisionId>('explicit-title-revision'),
      title: 'x'.repeat(MAX_SHORT_TEXT_LENGTH + 1),
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('keeps observed final stats separate from item-listed contributions', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'first-item')
    localData = addTestDefinition(localData, 'second-item')
    localData = captureCharacter(localData, {
      characterId: asId<CharacterId>('character'),
      displayedStats: { power: { value: known(100), unit: 'displayed' } },
      equipment: { [HAND_SLOT]: personalRef('first-item') },
      now: TEST_NOW,
    })
    localData = createBuild(localData, {
      id: asId<BuildId>('build'),
      gameSetupId: TEST_GAME_SETUP_ID,
      title: 'Build',
      kind: 'build',
      now: TEST_NOW,
    })
    localData = saveBuildRevision(localData, {
      buildId: asId<BuildId>('build'),
      id: asId<BuildRevisionId>('first-revision'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      content: {
        primaryClass: null,
        secondaryClass: null,
        equipment: { [HAND_SLOT]: { ref: personalRef('first-item') } },
        passives: [],
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })
    localData = saveBuildRevision(localData, {
      buildId: asId<BuildId>('build'),
      id: asId<BuildRevisionId>('second-revision'),
      parentRevisionId: asId<BuildRevisionId>('first-revision'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      content: {
        primaryClass: null,
        secondaryClass: null,
        equipment: { [HAND_SLOT]: { ref: personalRef('second-item') } },
        passives: [],
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })

    const comparison = compareBuildRevisions(
      localData.buildRevisions['first-revision']!,
      localData.buildRevisions['second-revision']!,
    )
    const character = requirePlaythrough(localData).characters.character!
    expect(character.snapshots[character.currentSnapshotId!]?.displayedStats.power?.value).toEqual(known(100))
    expect(comparison.differences.map((difference) => difference.path)).toEqual([
      `content.equipment.${HAND_SLOT}`,
    ])
    expect(comparison.differences.some((difference) => difference.path.includes('displayedStats'))).toBe(false)
  })

  it('creates a new checkpoint when a build is rebased to another catalog revision', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'item')
    localData = createBuild(localData, {
      id: asId<BuildId>('build'),
      gameSetupId: TEST_GAME_SETUP_ID,
      title: 'Build',
      kind: 'build',
      now: TEST_NOW,
    })
    localData = saveBuildRevision(localData, {
      buildId: asId<BuildId>('build'),
      id: asId<BuildRevisionId>('old-revision'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      catalogLock: { catalog: asId<CatalogRevisionId>('old-catalog') },
      content: {
        primaryClass: null,
        secondaryClass: null,
        equipment: { [HAND_SLOT]: { ref: personalRef('item') } },
        passives: [],
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })
    const oldCheckpoint = localData.buildRevisions['old-revision']
    localData = saveBuildRevision(localData, {
      buildId: asId<BuildId>('build'),
      id: asId<BuildRevisionId>('new-revision'),
      parentRevisionId: asId<BuildRevisionId>('old-revision'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      catalogLock: { catalog: asId<CatalogRevisionId>('new-catalog') },
      content: oldCheckpoint!.content,
      now: TEST_NOW,
    })

    expect(localData.buildRevisions['old-revision']).toBe(oldCheckpoint)
    expect(localData.buildRevisions['old-revision']?.catalogLock.catalog).toBe('old-catalog')
    expect(localData.buildRevisions['new-revision']?.catalogLock.catalog).toBe('new-catalog')
    expect(localData.builds.build?.latestRevisionId).toBe('new-revision')
  })

  it('reports allocation grouping changes even when the selected definition is unchanged', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = addTestDefinition(localData, 'item')
    localData = createBuild(localData, {
      id: asId<BuildId>('build'),
      gameSetupId: TEST_GAME_SETUP_ID,
      title: 'Build',
      kind: 'build',
      now: TEST_NOW,
    })
    localData = saveBuildRevision(localData, {
      buildId: asId<BuildId>('build'),
      id: asId<BuildRevisionId>('first-revision'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      content: {
        primaryClass: null,
        secondaryClass: null,
        equipment: { [HAND_SLOT]: { ref: personalRef('item'), allocationId: 'first-copy' } },
        passives: [],
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })
    localData = saveBuildRevision(localData, {
      buildId: asId<BuildId>('build'),
      id: asId<BuildRevisionId>('second-revision'),
      parentRevisionId: asId<BuildRevisionId>('first-revision'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      content: {
        primaryClass: null,
        secondaryClass: null,
        equipment: { [HAND_SLOT]: { ref: personalRef('item'), allocationId: 'second-copy' } },
        passives: [],
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })

    expect(compareBuildRevisions(
      localData.buildRevisions['first-revision']!,
      localData.buildRevisions['second-revision']!,
    ).differences.map((difference) => difference.path)).toEqual([
      `content.equipment.${HAND_SLOT}`,
    ])
  })

  it('rejects commands based on a stale localData revision', () => {
    const localData = createTestLocalData()

    expect(() =>
      createBuild(localData, {
        id: asId<BuildId>('build'),
        gameSetupId: TEST_GAME_SETUP_ID,
        title: 'Build',
        kind: 'template',
        expectedRevision: localData.revision - 1,
        now: TEST_NOW,
      }),
    ).toThrowError(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  })

  it('rejects build content with structurally missing references or slots', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = createBuild(localData, {
      id: asId<BuildId>('build'),
      gameSetupId: TEST_GAME_SETUP_ID,
      title: 'Build',
      kind: 'build',
      now: TEST_NOW,
    })
    expect(() => saveBuildRevision(localData, {
      buildId: asId<BuildId>('build'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      content: {
        primaryClass: { kind: 'personal', definitionId: asId<PersonalDefinitionId>('missing-class') },
        secondaryClass: null,
        equipment: {},
        passives: [],
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'MISSING_PERSONAL_DEFINITION' }))

    localData = addTestDefinition(localData, 'item')
    expect(() => saveBuildRevision(localData, {
      buildId: asId<BuildId>('build'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      content: {
        primaryClass: null,
        secondaryClass: null,
        equipment: { [asId<SlotId>('unknown-slot')]: { ref: personalRef('item') } },
        passives: [],
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('rejects catalog content outside the supplied build lock', () => {
    let localData = createTestLocalData()
    localData = addTestCharacter(localData, 'character')
    localData = createBuild(localData, {
      id: asId<BuildId>('build'),
      gameSetupId: TEST_GAME_SETUP_ID,
      title: 'Build',
      kind: 'build',
      now: TEST_NOW,
    })
    expect(() => saveBuildRevision(localData, {
      buildId: asId<BuildId>('build'),
      gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID,
      catalogLock: { catalog: asId<CatalogRevisionId>('revision-a') },
      content: {
        primaryClass: null,
        secondaryClass: null,
        equipment: {
          [HAND_SLOT]: {
            ref: {
              kind: 'catalog',
              catalogId: asId<CatalogId>('catalog'),
              catalogRevisionId: asId<CatalogRevisionId>('revision-b'),
              entityId: asId<EntityId>('item'),
            },
          },
        },
        passives: [],
        contextAssumptions: [],
      },
      now: TEST_NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })
})
