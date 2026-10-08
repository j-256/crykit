import { describe, expect, it } from 'vitest'

import { VANILLA_CATALOG_REVISION_ID } from '../catalog/vanilla-catalog'
import { STARTER_CATALOG_ID } from '../catalog/starter'
import {
  advanceClassSealProgress,
  acquisitionState,
  asId,
  classSealStage,
  classSealStageFacts,
  nextClassSealStage,
  requirePlaythrough,
  setClassSealProgressBatch,
  setAcquisitionProgress,
  createPlaythrough,
  upsertProgress,
} from './index'
import { createTestLocalData } from './test-helpers'
import type { EntityId } from './types'

const NOW = '2026-09-29T12:00:00.000Z'
const SUBJECT = {
  kind: 'catalog' as const,
  catalogId: STARTER_CATALOG_ID,
  catalogRevisionId: VANILLA_CATALOG_REVISION_ID,
  entityId: asId<EntityId>('base:job:0'),
}
const SECOND_SUBJECT = {
  ...SUBJECT,
  entityId: asId<EntityId>('base:job:5'),
}

describe('class seal progress', () => {
  it('cycles through the four playthrough states and writes coherent facts', () => {
    let localData = createTestLocalData()
    const inventory = requirePlaythrough(localData).inventory
    const characters = requirePlaythrough(localData).characters

    expect(classSealStage()).toBe('notAcquired')
    for (const stage of ['unlocked', 'mastered', 'sealAcquired', 'notAcquired'] as const) {
      localData = advanceClassSealProgress(localData, { subject: SUBJECT, displayName: 'Warrior', expectedRevision: localData.revision, now: NOW })
      const record = Object.values(requirePlaythrough(localData).progress)[0]
      expect(record).toBeDefined()
      expect(classSealStage(record)).toBe(stage)
      expect(record).toMatchObject(classSealStageFacts(stage))
    }

    expect(requirePlaythrough(localData).inventory).toBe(inventory)
    expect(requirePlaythrough(localData).characters).toBe(characters)
  })

  it('keeps secondary observations when the board advances an existing class', () => {
    let localData = createTestLocalData()
    localData = upsertProgress(localData, {
      subject: SUBJECT,
      displayName: 'Warrior',
      ...classSealStageFacts('unlocked'),
      masterLocation: { state: 'known', value: 'Synthetic dojo' },
      observedAt: '2026-09-28',
      now: NOW,
    })

    localData = advanceClassSealProgress(localData, { subject: SUBJECT, displayName: 'Warrior', expectedRevision: localData.revision, now: NOW })
    const record = Object.values(requirePlaythrough(localData).progress)[0]!
    expect(classSealStage(record)).toBe('mastered')
    expect(record.masterLocation).toEqual({ state: 'known', value: 'Synthetic dojo' })
    expect(record.observedAt).toBe('2026-09-28')
  })

  it('derives a display stage from imported facts when the stage is unknown', () => {
    let localData = createTestLocalData()
    localData = upsertProgress(localData, {
      subject: SUBJECT,
      displayName: 'Warrior',
      stage: { state: 'unknown' },
      collection: { state: 'known', value: true },
      now: NOW,
    })
    expect(classSealStage(Object.values(requirePlaythrough(localData).progress)[0])).toBe('sealAcquired')
    expect(nextClassSealStage('sealAcquired')).toBe('notAcquired')
  })

  it('sets several classes in one local data revision while preserving unrelated data', () => {
    let localData = createTestLocalData()
    localData = upsertProgress(localData, {
      subject: SUBJECT,
      displayName: 'Warrior',
      ...classSealStageFacts('unlocked'),
      masterLocation: { state: 'known', value: 'Synthetic dojo' },
      observedAt: '2026-09-28',
      now: NOW,
    })
    const inventory = requirePlaythrough(localData).inventory
    const characters = requirePlaythrough(localData).characters

    const updated = setClassSealProgressBatch(localData, {
      selections: [
        { subject: SUBJECT, displayName: 'Warrior' },
        { subject: SECOND_SUBJECT, displayName: 'Monk' },
      ],
      stage: 'sealAcquired',
      expectedRevision: localData.revision,
      now: NOW,
    })

    expect(updated.revision).toBe(localData.revision + 1)
    expect(Object.values(requirePlaythrough(updated).progress)).toHaveLength(2)
    expect(Object.values(requirePlaythrough(updated).progress).map(classSealStage)).toEqual(['sealAcquired', 'sealAcquired'])
    expect(Object.values(requirePlaythrough(updated).progress)[0]?.masterLocation).toEqual({ state: 'known', value: 'Synthetic dojo' })
    expect(Object.values(requirePlaythrough(updated).progress)[0]?.observedAt).toBe('2026-09-28')
    expect(updated.changes.at(-1)).toMatchObject({ command: 'progress.bulkSetStage' })
    expect(updated.changes.at(-1)?.changedPaths).toHaveLength(2)
    expect(requirePlaythrough(updated).inventory).toBe(inventory)
    expect(requirePlaythrough(updated).characters).toBe(characters)
  })

  it('rejects duplicate class subjects in a bulk update', () => {
    const localData = createTestLocalData()
    expect(() => setClassSealProgressBatch(localData, {
      selections: [
        { subject: SUBJECT, displayName: 'Warrior' },
        { subject: SUBJECT, displayName: 'Warrior again' },
      ],
      stage: 'mastered',
      expectedRevision: localData.revision,
      now: NOW,
    })).toThrow('Bulk progress selection repeats a class subject')
  })
})

describe('two-state acquisition progress', () => {
  const instrument = { ...SUBJECT, entityId: asId<EntityId>('base:item:50') }

  it('records acquired and not acquired without altering inventory, learning, or class facts', () => {
    const initial = createTestLocalData()
    const playthrough = requirePlaythrough(initial)
    let localData = initial
    expect(acquisitionState()).toEqual({ state: 'known', value: false })
    for (const acquired of [true, false, true]) {
      localData = setAcquisitionProgress(localData, { subject: instrument, displayName: 'Ibek Bell', acquired, expectedRevision: localData.revision, now: NOW })
      const records = Object.values(requirePlaythrough(localData).progress)
      expect(records).toHaveLength(1)
      expect(acquisitionState(records[0])).toEqual({ state: 'known', value: acquired })
      expect(records[0]).toMatchObject({ subject: instrument, stage: { state: 'notApplicable' }, unlocked: { state: 'notApplicable' }, partyMastery: { state: 'notApplicable' } })
    }
    expect(requirePlaythrough(localData).inventory).toBe(playthrough.inventory)
    expect(requirePlaythrough(localData).characters).toBe(playthrough.characters)
    expect(localData.builds).toBe(initial.builds)
    expect(localData.gameSetups).toBe(initial.gameSetups)
  })

  it('preserves uncertain imports until explicitly confirmed and keeps their pinned subject', () => {
    let localData = createTestLocalData()
    const existingInstrument = { ...SUBJECT, entityId: asId<EntityId>('base:item:39') }
    const oldRef = { ...existingInstrument, catalogRevisionId: 'synthetic-other-revision' as typeof instrument.catalogRevisionId }
    for (const collection of [{ state: 'unknown' }, { state: 'conflicting', claims: [{ value: true, sources: [] }, { value: false, sources: [] }] }, { state: 'notApplicable' }] as const) {
      localData = upsertProgress(localData, { subject: oldRef, displayName: 'Imported instrument', collection, observedAt: '2026-09-28', now: NOW })
      const record = Object.values(requirePlaythrough(localData).progress)[0]!
      expect(acquisitionState(record)).toEqual(collection)
      localData = setAcquisitionProgress(localData, { subject: existingInstrument, displayName: 'Quintar Flute', acquired: false, expectedRevision: localData.revision, now: NOW })
      const updated = Object.values(requirePlaythrough(localData).progress)[0]!
      expect(updated.id).toBe(record.id)
      expect(updated.subject).toEqual(oldRef)
      expect(updated.observedAt).toBe('2026-09-28')
      expect(updated.collection).toEqual({ state: 'known', value: false })
    }
  })

  it('keeps acquisition observations scoped to the selected Playthrough and rejects stale writes', () => {
    let localData = createTestLocalData()
    localData = setAcquisitionProgress(localData, { subject: instrument, displayName: 'Ibek Bell', acquired: true, now: NOW })
    const first = requirePlaythrough(localData)
    expect(() => setAcquisitionProgress(localData, { subject: instrument, displayName: 'Ibek Bell', acquired: false, expectedRevision: localData.revision - 1 })).toThrow('LocalData revision does not match')
    localData = createPlaythrough(localData, { label: 'Second save', select: true, now: NOW })
    expect(Object.values(requirePlaythrough(localData).progress)).toHaveLength(0)
    localData = setAcquisitionProgress(localData, { subject: instrument, displayName: 'Ibek Bell', acquired: false, now: NOW })
    expect(localData.playthroughs[first.id]?.progress).toBe(first.progress)
    expect(Object.values(requirePlaythrough(localData).progress)[0]?.collection).toEqual({ state: 'known', value: false })
  })
})
