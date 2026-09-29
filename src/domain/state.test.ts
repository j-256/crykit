import { describe, expect, it } from 'vitest'

import {
  asId,
  asTimestamp,
  captureCharacter,
  createBlankLocalData,
  createCharacter,
  createPersonalDefinition,
  createPlaythrough,
  entityRefKey,
  linkInventoryPosition,
  MAX_ID_LENGTH,
  observeInventory,
  recordInventoryEvent,
  requirePlaythrough,
  upsertLearnedNode,
  upsertProgress,
} from './index'
import type {
  CatalogId,
  CatalogRevisionId,
  CharacterId,
  EntityId,
  InventoryEventId,
  InventoryPositionId,
  PersonalDefinitionId,
  LocalDataId,
  ProgressRecordId,
  SourceRef,
} from './types'

const NOW = asTimestamp('2026-01-02T03:04:05.000Z')

function personal(definitionId: string) {
  return { kind: 'personal' as const, definitionId: asId<PersonalDefinitionId>(definitionId) }
}

function catalog(revision: string) {
  return {
    kind: 'catalog' as const,
    catalogId: asId<CatalogId>('catalog'),
    catalogRevisionId: asId<CatalogRevisionId>(revision),
    entityId: asId<EntityId>('entity'),
  }
}

function createTrackedLocalData() {
  return createPlaythrough(
    createBlankLocalData({ id: asId<LocalDataId>('localData'), now: NOW }),
    { label: 'Test playthrough', now: NOW },
  )
}

describe('localData state separation', () => {
  it('starts blank with no personal or reference state', () => {
    const localData = createBlankLocalData({ id: asId<LocalDataId>('localData'), now: NOW })

    expect(localData.revision).toBe(0)
    expect(localData.personalDefinitions).toEqual({})
    expect(localData.builds).toEqual({})
    expect(localData.playthroughs).toEqual({})
  })

  it('records a historical acquisition without inventing current stock', () => {
    let localData = createTrackedLocalData()
    const definitionId = asId<PersonalDefinitionId>('unmatched-item')
    localData = createPersonalDefinition(localData, {
      id: definitionId,
      kind: 'item',
      name: 'Unmatched item',
      now: NOW,
    })
    localData = recordInventoryEvent(localData, {
      id: asId<InventoryEventId>('event'),
      ref: personal(definitionId),
      kind: 'acquired',
      quantity: { state: 'unknown', reason: 'historical note omitted amount' },
      now: NOW,
    })

    expect(requirePlaythrough(localData).inventory).toEqual({})
    expect(requirePlaythrough(localData).inventoryEvents.event?.quantity).toEqual({
      state: 'unknown',
      reason: 'historical note omitted amount',
    })
  })

  it('links an unmatched observation without losing its original name', () => {
    let localData = createTrackedLocalData()
    const definitionId = asId<PersonalDefinitionId>('placeholder')
    const positionId = asId<InventoryPositionId>('position')
    localData = createPersonalDefinition(localData, {
      id: definitionId,
      kind: 'item',
      name: 'Original spelling',
      now: NOW,
    })
    localData = observeInventory(localData, {
      positionId,
      ref: personal(definitionId),
      observedName: 'Original spelling',
      possession: 'owned',
      quantity: { kind: 'unknown' },
      now: NOW,
    })
    localData = linkInventoryPosition(localData, { positionId, ref: catalog('revision-1'), now: NOW })

    expect(requirePlaythrough(localData).inventory.position?.observedName).toBe('Original spelling')
    expect(requirePlaythrough(localData).inventory.position?.ref).toEqual(catalog('revision-1'))
  })

  it('treats a current count as a replacement observation rather than an additive event', () => {
    let localData = createTrackedLocalData()
    const definitionId = asId<PersonalDefinitionId>('item')
    const positionId = asId<InventoryPositionId>('position')
    localData = createPersonalDefinition(localData, { id: definitionId, kind: 'item', name: 'Item', now: NOW })
    localData = observeInventory(localData, {
      positionId,
      ref: personal(definitionId),
      possession: 'owned',
      quantity: { kind: 'exact', value: 2 },
      now: NOW,
    })
    localData = observeInventory(localData, {
      positionId,
      ref: personal(definitionId),
      possession: 'owned',
      quantity: { kind: 'exact', value: 3 },
      now: NOW,
    })

    expect(requirePlaythrough(localData).inventory.position?.quantity).toEqual({ kind: 'exact', value: 3 })
    expect(requirePlaythrough(localData).inventoryEvents).toEqual({})
  })

  it('does not zero omitted positions when one position is updated', () => {
    let localData = createTrackedLocalData()
    const firstDefinition = asId<PersonalDefinitionId>('first')
    const secondDefinition = asId<PersonalDefinitionId>('second')
    localData = createPersonalDefinition(localData, { id: firstDefinition, kind: 'item', name: 'First', now: NOW })
    localData = createPersonalDefinition(localData, { id: secondDefinition, kind: 'item', name: 'Second', now: NOW })
    localData = observeInventory(localData, {
      positionId: asId<InventoryPositionId>('first-position'),
      ref: personal(firstDefinition),
      possession: 'owned',
      quantity: { kind: 'exact', value: 1 },
      now: NOW,
    })
    localData = observeInventory(localData, {
      positionId: asId<InventoryPositionId>('second-position'),
      ref: personal(secondDefinition),
      possession: 'owned',
      quantity: { kind: 'exact', value: 4 },
      now: NOW,
    })
    localData = observeInventory(localData, {
      positionId: asId<InventoryPositionId>('first-position'),
      ref: personal(firstDefinition),
      possession: 'notOwned',
      quantity: { kind: 'unknown' },
      now: NOW,
    })

    expect(requirePlaythrough(localData).inventory['first-position']?.quantity).toEqual({ kind: 'exact', value: 0 })
    expect(requirePlaythrough(localData).inventory['second-position']?.quantity).toEqual({ kind: 'exact', value: 4 })
  })

  it('preserves or explicitly clears an inventory observation date', () => {
    let localData = createTrackedLocalData()
    const definitionId = asId<PersonalDefinitionId>('item')
    const positionId = asId<InventoryPositionId>('position')
    localData = createPersonalDefinition(localData, { id: definitionId, kind: 'item', name: 'Item', now: NOW })
    localData = observeInventory(localData, {
      positionId,
      ref: personal(definitionId),
      possession: 'owned',
      quantity: { kind: 'exact', value: 1 },
      observedAt: '2025-05-01T00:00:00.000Z',
      now: NOW,
    })
    localData = observeInventory(localData, {
      positionId,
      ref: personal(definitionId),
      possession: 'owned',
      quantity: { kind: 'exact', value: 2 },
      now: NOW,
    })
    expect(requirePlaythrough(localData).inventory.position?.observedAt).toBe(asTimestamp('2025-05-01T00:00:00.000Z'))

    localData = observeInventory(localData, {
      positionId,
      ref: personal(definitionId),
      possession: 'owned',
      quantity: { kind: 'exact', value: 2 },
      observedAt: null,
      now: NOW,
    })
    expect(requirePlaythrough(localData).inventory.position?.observedAt).toBeUndefined()
  })

  it('keeps same-name definitions distinct by ID and type', () => {
    let localData = createTrackedLocalData()
    localData = createPersonalDefinition(localData, {
      id: asId<PersonalDefinitionId>('class-definition'),
      kind: 'class',
      name: 'Shared label',
      now: NOW,
    })
    localData = createPersonalDefinition(localData, {
      id: asId<PersonalDefinitionId>('innate-definition'),
      kind: 'innate',
      name: 'Shared label',
      now: NOW,
    })

    expect(Object.values(localData.personalDefinitions).map((definition) => definition.kind)).toEqual([
      'class',
      'innate',
    ])
  })

  it('rejects unresolved personal observation references and unsafe numeric values', () => {
    let localData = createTrackedLocalData()
    const characterId = asId<CharacterId>('character')
    localData = createCharacter(localData, { id: characterId, name: 'Character', now: NOW })
    expect(() => captureCharacter(localData, {
      characterId,
      primaryClass: { state: 'known', value: personal('missing-class') },
      now: NOW,
    })).toThrowError(expect.objectContaining({ code: 'MISSING_PERSONAL_DEFINITION' }))
    expect(() => captureCharacter(localData, {
      characterId,
      level: { state: 'known', value: Number.MAX_SAFE_INTEGER + 1 },
      now: NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => captureCharacter(localData, {
      characterId,
      displayedStats: {
        ['x'.repeat(MAX_ID_LENGTH + 1)]: { value: { state: 'known', value: 1 }, unit: 'displayed' },
      },
      now: NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('updates party progress without inventing character learning or inventory', () => {
    let localData = createTrackedLocalData()
    const classId = asId<PersonalDefinitionId>('class')
    const passiveId = asId<PersonalDefinitionId>('passive')
    const characterId = asId<CharacterId>('character')
    localData = createPersonalDefinition(localData, { id: classId, kind: 'class', name: 'Class', now: NOW })
    localData = createPersonalDefinition(localData, { id: passiveId, kind: 'passive', name: 'Optional node', now: NOW })
    localData = createCharacter(localData, { id: characterId, name: 'Character', now: NOW })
    localData = upsertLearnedNode(localData, {
      characterId,
      ref: personal(passiveId),
      kind: 'passive',
      learned: { state: 'unknown' },
      now: NOW,
    })
    const charactersBefore = requirePlaythrough(localData).characters
    localData = upsertProgress(localData, {
      id: asId<ProgressRecordId>('progress'),
      subject: personal(classId),
      displayName: 'Class',
      partyMastery: { state: 'known', value: true },
      collection: { state: 'known', value: true },
      now: NOW,
    })

    expect(requirePlaythrough(localData).characters).toBe(charactersBefore)
    expect(requirePlaythrough(localData).characters.character?.learnedNodes[entityRefKey(personal(passiveId))]?.learned).toEqual({
      state: 'unknown',
    })
    expect(requirePlaythrough(localData).inventory).toEqual({})
  })

  it('does not rewrite gameplay observations when only a source check date changes elsewhere', () => {
    let localData = createTrackedLocalData()
    const classId = asId<PersonalDefinitionId>('class')
    localData = createPersonalDefinition(localData, { id: classId, kind: 'class', name: 'Class', now: NOW })
    localData = upsertProgress(localData, {
      id: asId<ProgressRecordId>('progress'),
      subject: personal(classId),
      displayName: 'Class',
      collection: { state: 'known', value: true },
      observedAt: '2025-05-01T00:00:00.000Z',
      now: NOW,
    })
    const progressBefore = requirePlaythrough(localData).progress.progress
    const source: SourceRef = {
      sourceId: 'reference',
      checkedAt: asTimestamp('2026-02-01T00:00:00.000Z'),
    }
    localData = createPersonalDefinition(localData, {
      id: asId<PersonalDefinitionId>('unrelated'),
      kind: 'other',
      name: 'Source check',
      sources: [source],
      now: '2026-02-01T00:00:00.000Z',
    })

    expect(requirePlaythrough(localData).progress.progress).toBe(progressBefore)
    expect(requirePlaythrough(localData).progress.progress?.observedAt).toBe(asTimestamp('2025-05-01T00:00:00.000Z'))
  })

  it('preserves or explicitly clears a progress observation date', () => {
    let localData = createTrackedLocalData()
    const classId = asId<PersonalDefinitionId>('class')
    const progressId = asId<ProgressRecordId>('progress')
    localData = createPersonalDefinition(localData, { id: classId, kind: 'class', name: 'Class', now: NOW })
    localData = upsertProgress(localData, {
      id: progressId,
      subject: personal(classId),
      displayName: 'Class',
      observedAt: '2025-05-01T00:00:00.000Z',
      now: NOW,
    })
    localData = upsertProgress(localData, {
      id: progressId,
      subject: personal(classId),
      displayName: 'Class',
      now: NOW,
    })
    expect(requirePlaythrough(localData).progress.progress?.observedAt).toBe(asTimestamp('2025-05-01T00:00:00.000Z'))

    localData = upsertProgress(localData, {
      id: progressId,
      subject: personal(classId),
      displayName: 'Class',
      observedAt: null,
      now: NOW,
    })
    expect(requirePlaythrough(localData).progress.progress?.observedAt).toBeUndefined()
  })

  it('does not create two progress rows for one stable subject identity', () => {
    let localData = createTrackedLocalData()
    const classId = asId<PersonalDefinitionId>('class')
    localData = createPersonalDefinition(localData, { id: classId, kind: 'class', name: 'Class', now: NOW })
    localData = upsertProgress(localData, {
      id: asId<ProgressRecordId>('first'),
      subject: personal(classId),
      displayName: 'Class',
      now: NOW,
    })

    expect(() => upsertProgress(localData, {
      id: asId<ProgressRecordId>('second'),
      subject: personal(classId),
      displayName: 'Duplicate class',
      now: NOW,
    })).toThrowError(expect.objectContaining({ code: 'DUPLICATE_REFERENCE' }))
  })
})
