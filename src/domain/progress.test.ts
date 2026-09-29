import { describe, expect, it } from 'vitest'

import { BUNDLED_CATALOG_REVISION_ID } from '../catalog/bundled-catalog'
import { STARTER_CATALOG_ID } from '../catalog/starter'
import {
  advanceClassSealProgress,
  asId,
  classSealStage,
  classSealStageFacts,
  createBlankProfile,
  nextClassSealStage,
  setClassSealProgressBatch,
  upsertProgress,
} from './index'
import type { EntityId, ProfileId } from './types'

const NOW = '2026-09-29T12:00:00.000Z'
const SUBJECT = {
  kind: 'catalog' as const,
  catalogId: STARTER_CATALOG_ID,
  catalogRevisionId: BUNDLED_CATALOG_REVISION_ID,
  entityId: asId<EntityId>('base:class:warrior'),
}
const SECOND_SUBJECT = {
  ...SUBJECT,
  entityId: asId<EntityId>('base:class:monk'),
}

describe('class seal progress', () => {
  it('cycles through the four playthrough states and writes coherent facts', () => {
    let profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: NOW })
    const inventory = profile.inventory
    const characters = profile.characters

    expect(classSealStage()).toBe('notAcquired')
    for (const stage of ['unlocked', 'mastered', 'sealAcquired', 'notAcquired'] as const) {
      profile = advanceClassSealProgress(profile, { subject: SUBJECT, displayName: 'Warrior', expectedRevision: profile.revision, now: NOW })
      const record = Object.values(profile.progress)[0]
      expect(record).toBeDefined()
      expect(classSealStage(record)).toBe(stage)
      expect(record).toMatchObject(classSealStageFacts(stage))
    }

    expect(profile.inventory).toBe(inventory)
    expect(profile.characters).toBe(characters)
  })

  it('keeps secondary observations when the board advances an existing class', () => {
    let profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: NOW })
    profile = upsertProgress(profile, {
      subject: SUBJECT,
      displayName: 'Warrior',
      ...classSealStageFacts('unlocked'),
      masterLocation: { state: 'known', value: 'Synthetic dojo' },
      observedAt: '2026-09-28',
      now: NOW,
    })

    profile = advanceClassSealProgress(profile, { subject: SUBJECT, displayName: 'Warrior', expectedRevision: profile.revision, now: NOW })
    const record = Object.values(profile.progress)[0]!
    expect(classSealStage(record)).toBe('mastered')
    expect(record.masterLocation).toEqual({ state: 'known', value: 'Synthetic dojo' })
    expect(record.observedAt).toBe('2026-09-28')
  })

  it('derives a display stage from imported facts when the stage is unknown', () => {
    let profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: NOW })
    profile = upsertProgress(profile, {
      subject: SUBJECT,
      displayName: 'Warrior',
      stage: { state: 'unknown' },
      collection: { state: 'known', value: true },
      now: NOW,
    })
    expect(classSealStage(Object.values(profile.progress)[0])).toBe('sealAcquired')
    expect(nextClassSealStage('sealAcquired')).toBe('notAcquired')
  })

  it('sets several classes in one profile revision while preserving unrelated data', () => {
    let profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: NOW })
    profile = upsertProgress(profile, {
      subject: SUBJECT,
      displayName: 'Warrior',
      ...classSealStageFacts('unlocked'),
      masterLocation: { state: 'known', value: 'Synthetic dojo' },
      observedAt: '2026-09-28',
      now: NOW,
    })
    const inventory = profile.inventory
    const characters = profile.characters

    const updated = setClassSealProgressBatch(profile, {
      selections: [
        { subject: SUBJECT, displayName: 'Warrior' },
        { subject: SECOND_SUBJECT, displayName: 'Monk' },
      ],
      stage: 'sealAcquired',
      expectedRevision: profile.revision,
      now: NOW,
    })

    expect(updated.revision).toBe(profile.revision + 1)
    expect(Object.values(updated.progress)).toHaveLength(2)
    expect(Object.values(updated.progress).map(classSealStage)).toEqual(['sealAcquired', 'sealAcquired'])
    expect(Object.values(updated.progress)[0]?.masterLocation).toEqual({ state: 'known', value: 'Synthetic dojo' })
    expect(Object.values(updated.progress)[0]?.observedAt).toBe('2026-09-28')
    expect(updated.changes.at(-1)).toMatchObject({ command: 'progress.bulkSetStage' })
    expect(updated.changes.at(-1)?.changedPaths).toHaveLength(2)
    expect(updated.inventory).toBe(inventory)
    expect(updated.characters).toBe(characters)
  })

  it('rejects duplicate class subjects in a bulk update', () => {
    const profile = createBlankProfile({ id: asId<ProfileId>('profile'), now: NOW })
    expect(() => setClassSealProgressBatch(profile, {
      selections: [
        { subject: SUBJECT, displayName: 'Warrior' },
        { subject: SUBJECT, displayName: 'Warrior again' },
      ],
      stage: 'mastered',
      expectedRevision: profile.revision,
      now: NOW,
    })).toThrow('Bulk progress selection repeats a class subject')
  })
})
