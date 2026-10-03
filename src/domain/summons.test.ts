import { savedCatalogVersion } from './legacy-definition.test-helpers'
import { describe, expect, it } from 'vitest'
import { BUNDLED_CATALOGS, DEFAULT_CATALOG } from '../catalog/bundled'
import { SUMMONS, type SummonId } from '../catalog/summons'
import { createPlaythrough, requirePlaythrough, upsertProgress } from './index'
import { summonUnlockState, toggleSummonProgress } from './summons'
import { createTestLocalData } from './test-helpers'
import type { CatalogRevisionId, EntityId } from './types'

const NOW = '2026-10-02T12:00:00.000Z'
const SUMMON = SUMMONS.find(summon => summon.name === 'Shaku')!
const STARTING_SUMMON = SUMMONS.find(summon => summon.starting)!
const SUBJECT = { kind: 'catalog' as const, catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: SUMMON.id as EntityId }

describe('summon unlock progress', () => {
  it('starts the battle summons gray and toggles only availability without altering character learning or class progress', () => {
    const initial = createTestLocalData()
    const playthrough = requirePlaythrough(initial)
    expect(summonUnlockState(SUMMON)).toEqual({ state: 'known', value: false })
    let localData = initial
    for (const value of [true, false, true]) {
      localData = toggleSummonProgress(localData, { summonId: SUMMON.id, subject: SUBJECT, displayName: SUMMON.label, playthroughId: playthrough.id, expectedRevision: localData.revision, now: NOW })
      const records = Object.values(requirePlaythrough(localData).progress)
      expect(records).toHaveLength(1)
      expect(summonUnlockState(SUMMON, records[0])).toEqual({ state: 'known', value })
      expect(records[0]).toMatchObject({ stage: { state: 'notApplicable' }, partyMastery: { state: 'notApplicable' }, collection: { state: 'notApplicable' } })
    }
    expect(requirePlaythrough(localData).characters).toBe(playthrough.characters)
    expect(requirePlaythrough(localData).inventory).toBe(playthrough.inventory)
    expect(localData.builds).toBe(initial.builds)
    expect(localData.gameSetups).toBe(initial.gameSetups)
  })

  it('keeps Pinga unlocked and rejects toggles while preserving older imported observations', () => {
    expect(STARTING_SUMMON.name).toBe('Pinga')
    expect(summonUnlockState(STARTING_SUMMON)).toEqual({ state: 'known', value: true })
    const subject = { ...SUBJECT, entityId: STARTING_SUMMON.id as EntityId }
    for (const unlocked of [{ state: 'known', value: false }, { state: 'unknown' }, { state: 'conflicting', claims: [{ value: true, sources: [] }, { value: false, sources: [] }] }, { state: 'notApplicable' }] as const) {
      const localData = upsertProgress(createTestLocalData(), { subject, displayName: 'Imported Pinga', unlocked, now: NOW })
      const record = Object.values(requirePlaythrough(localData).progress)[0]!
      expect(summonUnlockState(STARTING_SUMMON, record)).toEqual({ state: 'known', value: true })
      expect(() => toggleSummonProgress(localData, { summonId: STARTING_SUMMON.id, subject, displayName: STARTING_SUMMON.label, playthroughId: requirePlaythrough(localData).id })).toThrow('The starting summon is always unlocked')
      expect(record.unlocked).toEqual(unlocked)
    }
  })

  it('preserves uncertain imported observations and their reference pins until the user confirms them', () => {
    const oldSubject = { ...SUBJECT, catalogRevisionId: 'synthetic-old-revision' as CatalogRevisionId }
    for (const unlocked of [{ state: 'unknown' }, { state: 'conflicting', claims: [{ value: true, sources: [] }, { value: false, sources: [] }] }, { state: 'notApplicable' }] as const) {
      let localData = upsertProgress(createTestLocalData(), { subject: oldSubject, displayName: 'Imported summon', unlocked, observedAt: NOW, sources: [{ sourceId: 'synthetic-observation' }], now: NOW })
      const record = Object.values(requirePlaythrough(localData).progress)[0]!
      expect(summonUnlockState(SUMMON, record)).toEqual(unlocked)
      const override = savedCatalogVersion(localData, BUNDLED_CATALOGS, { sourceRef: SUBJECT, name: 'Personal summon' })
      localData = toggleSummonProgress(override.localData, { summonId: SUMMON.id, subject: override.ref, displayName: SUMMON.label, playthroughId: requirePlaythrough(localData).id, now: NOW })
      expect(Object.values(requirePlaythrough(localData).progress)).toHaveLength(1)
      expect(Object.values(requirePlaythrough(localData).progress)[0]).toMatchObject({ id: record.id, subject: oldSubject, unlocked: { state: 'known', value: true }, observedAt: NOW, sources: record.sources })
    }
  })

  it('targets the captured Playthrough even if selection changes before the save runs', () => {
    let localData = createTestLocalData()
    const first = requirePlaythrough(localData)
    localData = createPlaythrough(localData, { label: 'Second save', select: true, now: NOW })
    const second = requirePlaythrough(localData)
    localData = toggleSummonProgress(localData, { summonId: SUMMON.id, subject: SUBJECT, displayName: SUMMON.label, playthroughId: first.id, now: NOW })
    expect(requirePlaythrough(localData).progress).toBe(second.progress)
    expect(Object.values(localData.playthroughs[first.id]!.progress)[0]?.unlocked).toEqual({ state: 'known', value: true })
    expect(() => toggleSummonProgress(localData, { summonId: SUMMON.id, subject: SUBJECT, displayName: SUMMON.label, playthroughId: first.id, expectedRevision: localData.revision - 1 })).toThrow('LocalData revision does not match')
    expect(() => toggleSummonProgress(localData, { summonId: 'synthetic-invalid' as SummonId, subject: SUBJECT, displayName: 'Unknown', playthroughId: first.id })).toThrow('The summon does not exist')
    expect(() => toggleSummonProgress(localData, { summonId: SUMMON.id, subject: { ...SUBJECT, entityId: 'base:class:summoner' as EntityId }, displayName: SUMMON.label, playthroughId: first.id })).toThrow('The reference does not match the summon')
  })
})
