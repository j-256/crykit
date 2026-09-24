import { describe, expect, it } from 'vitest'

import {
  asId,
  asTimestamp,
  captureCharacter,
  createBlankProfile,
  createCharacter,
  createPersonalDefinition,
  entityRefKey,
  linkInventoryPosition,
  MAX_ID_LENGTH,
  observeInventory,
  recordInventoryEvent,
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
  ProfileId,
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

describe('profile state separation', () => {
  it('starts blank with no personal or reference state', () => {
    const profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: NOW })

    expect(profile.revision).toBe(0)
    expect(profile.personalDefinitions).toEqual({})
    expect(profile.inventory).toEqual({})
    expect(profile.inventoryEvents).toEqual({})
    expect(profile.characters).toEqual({})
    expect(profile.progress).toEqual({})
    expect(profile.builds).toEqual({})
    expect(profile.scenarios).toEqual({})
  })

  it('records a historical acquisition without inventing current stock', () => {
    let profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: NOW })
    const definitionId = asId<PersonalDefinitionId>('unmatched-item')
    profile = createPersonalDefinition(profile, {
      id: definitionId,
      kind: 'item',
      name: 'Unmatched item',
      now: NOW,
    })
    profile = recordInventoryEvent(profile, {
      id: asId<InventoryEventId>('event'),
      ref: personal(definitionId),
      kind: 'acquired',
      quantity: { state: 'unknown', reason: 'historical note omitted amount' },
      now: NOW,
    })

    expect(profile.inventory).toEqual({})
    expect(profile.inventoryEvents.event?.quantity).toEqual({
      state: 'unknown',
      reason: 'historical note omitted amount',
    })
  })

  it('links an unmatched observation without losing its original name', () => {
    let profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: NOW })
    const definitionId = asId<PersonalDefinitionId>('placeholder')
    const positionId = asId<InventoryPositionId>('position')
    profile = createPersonalDefinition(profile, {
      id: definitionId,
      kind: 'item',
      name: 'Original spelling',
      now: NOW,
    })
    profile = observeInventory(profile, {
      positionId,
      ref: personal(definitionId),
      observedName: 'Original spelling',
      possession: 'owned',
      quantity: { kind: 'unknown' },
      now: NOW,
    })
    profile = linkInventoryPosition(profile, { positionId, ref: catalog('revision-1'), now: NOW })

    expect(profile.inventory.position?.observedName).toBe('Original spelling')
    expect(profile.inventory.position?.ref).toEqual(catalog('revision-1'))
  })

  it('treats a current count as a replacement observation rather than an additive event', () => {
    let profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: NOW })
    const definitionId = asId<PersonalDefinitionId>('item')
    const positionId = asId<InventoryPositionId>('position')
    profile = createPersonalDefinition(profile, { id: definitionId, kind: 'item', name: 'Item', now: NOW })
    profile = observeInventory(profile, {
      positionId,
      ref: personal(definitionId),
      possession: 'owned',
      quantity: { kind: 'exact', value: 2 },
      now: NOW,
    })
    profile = observeInventory(profile, {
      positionId,
      ref: personal(definitionId),
      possession: 'owned',
      quantity: { kind: 'exact', value: 3 },
      now: NOW,
    })

    expect(profile.inventory.position?.quantity).toEqual({ kind: 'exact', value: 3 })
    expect(profile.inventoryEvents).toEqual({})
  })

  it('does not zero omitted positions when one position is updated', () => {
    let profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: NOW })
    const firstDefinition = asId<PersonalDefinitionId>('first')
    const secondDefinition = asId<PersonalDefinitionId>('second')
    profile = createPersonalDefinition(profile, { id: firstDefinition, kind: 'item', name: 'First', now: NOW })
    profile = createPersonalDefinition(profile, { id: secondDefinition, kind: 'item', name: 'Second', now: NOW })
    profile = observeInventory(profile, {
      positionId: asId<InventoryPositionId>('first-position'),
      ref: personal(firstDefinition),
      possession: 'owned',
      quantity: { kind: 'exact', value: 1 },
      now: NOW,
    })
    profile = observeInventory(profile, {
      positionId: asId<InventoryPositionId>('second-position'),
      ref: personal(secondDefinition),
      possession: 'owned',
      quantity: { kind: 'exact', value: 4 },
      now: NOW,
    })
    profile = observeInventory(profile, {
      positionId: asId<InventoryPositionId>('first-position'),
      ref: personal(firstDefinition),
      possession: 'notOwned',
      quantity: { kind: 'unknown' },
      now: NOW,
    })

    expect(profile.inventory['first-position']?.quantity).toEqual({ kind: 'exact', value: 0 })
    expect(profile.inventory['second-position']?.quantity).toEqual({ kind: 'exact', value: 4 })
  })

  it('preserves or explicitly clears an inventory observation date', () => {
    let profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: NOW })
    const definitionId = asId<PersonalDefinitionId>('item')
    const positionId = asId<InventoryPositionId>('position')
    profile = createPersonalDefinition(profile, { id: definitionId, kind: 'item', name: 'Item', now: NOW })
    profile = observeInventory(profile, {
      positionId,
      ref: personal(definitionId),
      possession: 'owned',
      quantity: { kind: 'exact', value: 1 },
      observedAt: '2025-05-01T00:00:00.000Z',
      now: NOW,
    })
    profile = observeInventory(profile, {
      positionId,
      ref: personal(definitionId),
      possession: 'owned',
      quantity: { kind: 'exact', value: 2 },
      now: NOW,
    })
    expect(profile.inventory.position?.observedAt).toBe(asTimestamp('2025-05-01T00:00:00.000Z'))

    profile = observeInventory(profile, {
      positionId,
      ref: personal(definitionId),
      possession: 'owned',
      quantity: { kind: 'exact', value: 2 },
      observedAt: null,
      now: NOW,
    })
    expect(profile.inventory.position?.observedAt).toBeUndefined()
  })

  it('keeps same-name definitions distinct by ID and type', () => {
    let profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: NOW })
    profile = createPersonalDefinition(profile, {
      id: asId<PersonalDefinitionId>('class-definition'),
      kind: 'class',
      name: 'Shared label',
      now: NOW,
    })
    profile = createPersonalDefinition(profile, {
      id: asId<PersonalDefinitionId>('innate-definition'),
      kind: 'innate',
      name: 'Shared label',
      now: NOW,
    })

    expect(Object.values(profile.personalDefinitions).map((definition) => definition.kind)).toEqual([
      'class',
      'innate',
    ])
  })

  it('rejects unresolved personal observation references and unsafe numeric values', () => {
    let profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: NOW })
    const characterId = asId<CharacterId>('character')
    profile = createCharacter(profile, { id: characterId, name: 'Character', now: NOW })
    expect(() => captureCharacter(profile, {
      characterId,
      primaryClass: { state: 'known', value: personal('missing-class') },
      now: NOW,
    })).toThrowError(expect.objectContaining({ code: 'MISSING_PERSONAL_DEFINITION' }))
    expect(() => captureCharacter(profile, {
      characterId,
      level: { state: 'known', value: Number.MAX_SAFE_INTEGER + 1 },
      now: NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
    expect(() => captureCharacter(profile, {
      characterId,
      displayedStats: {
        ['x'.repeat(MAX_ID_LENGTH + 1)]: { value: { state: 'known', value: 1 }, unit: 'displayed' },
      },
      now: NOW,
    })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it('updates party progress without inventing character learning or inventory', () => {
    let profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: NOW })
    const classId = asId<PersonalDefinitionId>('class')
    const passiveId = asId<PersonalDefinitionId>('passive')
    const characterId = asId<CharacterId>('character')
    profile = createPersonalDefinition(profile, { id: classId, kind: 'class', name: 'Class', now: NOW })
    profile = createPersonalDefinition(profile, { id: passiveId, kind: 'passive', name: 'Optional node', now: NOW })
    profile = createCharacter(profile, { id: characterId, name: 'Character', now: NOW })
    profile = upsertLearnedNode(profile, {
      characterId,
      ref: personal(passiveId),
      kind: 'passive',
      learned: { state: 'unknown' },
      now: NOW,
    })
    const charactersBefore = profile.characters
    profile = upsertProgress(profile, {
      id: asId<ProgressRecordId>('progress'),
      subject: personal(classId),
      displayName: 'Class',
      partyMastery: { state: 'known', value: true },
      collection: { state: 'known', value: true },
      now: NOW,
    })

    expect(profile.characters).toBe(charactersBefore)
    expect(profile.characters.character?.learnedNodes[entityRefKey(personal(passiveId))]?.learned).toEqual({
      state: 'unknown',
    })
    expect(profile.inventory).toEqual({})
  })

  it('does not rewrite gameplay observations when only a source check date changes elsewhere', () => {
    let profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: NOW })
    const classId = asId<PersonalDefinitionId>('class')
    profile = createPersonalDefinition(profile, { id: classId, kind: 'class', name: 'Class', now: NOW })
    profile = upsertProgress(profile, {
      id: asId<ProgressRecordId>('progress'),
      subject: personal(classId),
      displayName: 'Class',
      collection: { state: 'known', value: true },
      observedAt: '2025-05-01T00:00:00.000Z',
      now: NOW,
    })
    const progressBefore = profile.progress.progress
    const source: SourceRef = {
      sourceId: 'reference',
      checkedAt: asTimestamp('2026-02-01T00:00:00.000Z'),
    }
    profile = createPersonalDefinition(profile, {
      id: asId<PersonalDefinitionId>('unrelated'),
      kind: 'other',
      name: 'Source check',
      sources: [source],
      now: '2026-02-01T00:00:00.000Z',
    })

    expect(profile.progress.progress).toBe(progressBefore)
    expect(profile.progress.progress?.observedAt).toBe(asTimestamp('2025-05-01T00:00:00.000Z'))
  })

  it('preserves or explicitly clears a progress observation date', () => {
    let profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: NOW })
    const classId = asId<PersonalDefinitionId>('class')
    const progressId = asId<ProgressRecordId>('progress')
    profile = createPersonalDefinition(profile, { id: classId, kind: 'class', name: 'Class', now: NOW })
    profile = upsertProgress(profile, {
      id: progressId,
      subject: personal(classId),
      displayName: 'Class',
      observedAt: '2025-05-01T00:00:00.000Z',
      now: NOW,
    })
    profile = upsertProgress(profile, {
      id: progressId,
      subject: personal(classId),
      displayName: 'Class',
      now: NOW,
    })
    expect(profile.progress.progress?.observedAt).toBe(asTimestamp('2025-05-01T00:00:00.000Z'))

    profile = upsertProgress(profile, {
      id: progressId,
      subject: personal(classId),
      displayName: 'Class',
      observedAt: null,
      now: NOW,
    })
    expect(profile.progress.progress?.observedAt).toBeUndefined()
  })

  it('does not create two progress rows for one stable subject identity', () => {
    let profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: NOW })
    const classId = asId<PersonalDefinitionId>('class')
    profile = createPersonalDefinition(profile, { id: classId, kind: 'class', name: 'Class', now: NOW })
    profile = upsertProgress(profile, {
      id: asId<ProgressRecordId>('first'),
      subject: personal(classId),
      displayName: 'Class',
      now: NOW,
    })

    expect(() => upsertProgress(profile, {
      id: asId<ProgressRecordId>('second'),
      subject: personal(classId),
      displayName: 'Duplicate class',
      now: NOW,
    })).toThrowError(expect.objectContaining({ code: 'DUPLICATE_REFERENCE' }))
  })
})
