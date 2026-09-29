import { describe, expect, it } from 'vitest'
import { addGameSetupRevision, asId, captureCharacter, compareCharacterSnapshots, requirePlaythrough, setPlaythroughGameSetup, snapshotSlots } from './index'
import { addTestCharacter, createTestLocalData, HAND_SLOT, known, personalRef, TEST_NOW, TEST_GAME_SETUP_REVISION_ID } from './test-helpers'
import type { CharacterId, CharacterSnapshot, CharacterSnapshotId, LocalData, GameSetupRevisionId } from './types'

const characterId = asId<CharacterId>('synthetic-character')
function current(localData: LocalData): CharacterSnapshot {
  const character = requirePlaythrough(localData).characters[characterId]!
  return character.snapshots[character.currentSnapshotId!]!
}
function fixture(): CharacterSnapshot {
  return current(addTestCharacter(createTestLocalData(), characterId))
}

describe('recorded snapshot comparison', () => {
  it('reports numeric differences only for known values with matching field names and units', () => {
    const left = { ...fixture(), level: known(20), displayedStats: { HP: { value: known(300), unit: 'points' }, MP: { value: known(30), unit: 'points' }, speed: { value: { state: 'unknown' } as const, unit: 'points' }, old: { value: known(10), unit: 'points' } } }
    const right = { ...left, level: known(22), displayedStats: { HP: { value: known(350), unit: 'points' }, MP: { value: known(30), unit: '%' }, speed: { value: known(40), unit: 'points' }, renamed: { value: known(15), unit: 'points' } } }
    const rows = compareCharacterSnapshots(left, right)
    expect(rows.find((row) => row.key === 'level')).toMatchObject({ changed: true, delta: 2 })
    expect(rows.find((row) => row.key === 'stat:HP')).toMatchObject({ changed: true, delta: 50 })
    for (const key of ['stat:MP', 'stat:speed', 'stat:old', 'stat:renamed']) expect(rows.find((row) => row.key === key)).not.toHaveProperty('delta')
    expect(rows.find((row) => row.key === 'stat:old')?.right).toEqual({ kind: 'unrecorded' })
    expect(rows.find((row) => row.key === 'stat:renamed')?.left).toEqual({ kind: 'unrecorded' })
  })

  it('keeps empty, absent, unknown, conflicting, and not applicable distinct', () => {
    const left: CharacterSnapshot = { ...fixture(), equipment: { hand: null }, displayedStats: { absent: { value: { state: 'unknown' }, unit: 'displayed' }, certainty: { value: { state: 'notApplicable', reason: 'Not observed for this form' }, unit: 'points' } } }
    const right: CharacterSnapshot = { ...left, equipment: {}, displayedStats: { certainty: { value: { state: 'conflicting', claims: [{ value: 1, sources: [] }, { value: 2, sources: [] }] }, unit: 'points' } } }
    const rows = compareCharacterSnapshots(left, right)
    expect(rows.find((row) => row.key === 'slot:hand')).toMatchObject({ changed: true, left: { kind: 'selection', value: null }, right: { kind: 'selection', value: undefined } })
    expect(rows.find((row) => row.key === 'stat:absent')).toMatchObject({ changed: true, left: { value: { state: 'unknown' } }, right: { kind: 'unrecorded' } })
    expect(rows.find((row) => row.key === 'stat:certainty')).toMatchObject({ changed: true, left: { value: { state: 'notApplicable' } }, right: { value: { state: 'conflicting' } } })
    expect(rows.find((row) => row.key === 'stat:certainty')).not.toHaveProperty('delta')
  })

  it('compares exact definition references and observation details without depending on object key order', () => {
    const left = { ...fixture(), primaryClass: known(personalRef('class-a')), equipment: { hand: personalRef('item-a') } }
    const right = { ...left, primaryClass: known(personalRef('class-b')), equipment: { hand: personalRef('item-b') } }
    expect(compareCharacterSnapshots(left, right).filter((row) => row.changed).map((row) => row.key)).toEqual(['primaryClass', 'slot:hand'])
    expect(compareCharacterSnapshots(left, { ...left, equipment: { hand: { definitionId: personalRef('item-a').definitionId, kind: 'personal' } } }).some((row) => row.changed)).toBe(false)
    expect(compareCharacterSnapshots(left, { ...left, level: { state: 'unknown', reason: 'Screen not checked' } }).find((row) => row.key === 'level')?.changed).toBe(true)
  })

  it('compares the exact claims in non-known passive lists', () => {
    const left = { ...fixture(), passives: { state: 'conflicting', claims: [{ value: [personalRef('passive-a')], sources: [] }] } as const }
    const right = { ...left, passives: { state: 'conflicting', claims: [{ value: [personalRef('passive-b')], sources: [] }] } as const }
    expect(compareCharacterSnapshots(left, right).find((row) => row.key === 'passives')).toMatchObject({ changed: true, left: { kind: 'references' }, right: { kind: 'references' } })
  })

  it('treats imported prototype-shaped stat and slot keys as own data', () => {
    const snapshot = fixture()
    const left = { ...snapshot, displayedStats: Object.fromEntries([['__proto__', { value: known(1), unit: 'points' }]]), equipment: Object.fromEntries([['constructor', null]]) }
    const rows = compareCharacterSnapshots(left, snapshot)
    expect(rows.find((row) => row.key === 'stat:__proto__')?.right).toEqual({ kind: 'unrecorded' })
    expect(rows.find((row) => row.key === 'slot:constructor')?.right).toEqual({ kind: 'selection', value: undefined })
  })
})

describe('snapshot slot context', () => {
  it('pins capture context and preserves older snapshots when a different gameSetup becomes active', () => {
    let localData = addTestCharacter(createTestLocalData(), characterId)
    const before = current(localData)
    expect(before.gameSetupRevisionId).toBe(TEST_GAME_SETUP_REVISION_ID)
    const originalGameSetup = localData.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
    const nextGameSetupId = asId<GameSetupRevisionId>('next-gameSetup')
    localData = addGameSetupRevision(localData, { ...originalGameSetup, id: nextGameSetupId, activate: true, slots: originalGameSetup.slots.map((slot) => ({ ...slot, label: `Changed ${slot.label}` })), now: TEST_NOW })
    localData = setPlaythroughGameSetup(localData, { gameSetupRevisionId: nextGameSetupId, now: TEST_NOW })
    expect(snapshotSlots(localData, before)[0]?.label).toBe('Hand')
    localData = captureCharacter(localData, { characterId, snapshotId: asId<CharacterSnapshotId>('next-snapshot'), now: TEST_NOW })
    expect(current(localData).gameSetupRevisionId).toBe(nextGameSetupId)
    expect(requirePlaythrough(localData).characters[characterId]!.snapshots[before.id]).toEqual(before)
    localData = captureCharacter(localData, { characterId, gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID, now: TEST_NOW })
    expect(current(localData).gameSetupRevisionId).toBe(TEST_GAME_SETUP_REVISION_ID)
    expect(() => captureCharacter(localData, { characterId, gameSetupRevisionId: asId<GameSetupRevisionId>('missing') })).toThrowError(expect.objectContaining({ code: 'MISSING_GAME_SETUP' }))
  })

  it('does not substitute active labels for legacy snapshots or hide unmapped selections', () => {
    const localData = createTestLocalData()
    const { gameSetupRevisionId: _context, ...legacy } = fixture()
    const snapshot = { ...legacy, equipment: { [HAND_SLOT]: null, orphan: personalRef('unresolved') } }
    expect(snapshotSlots(localData, snapshot)).toEqual([
      { id: HAND_SLOT, label: `Slot ${HAND_SLOT}`, kind: 'unmapped', selection: null },
      { id: 'orphan', label: 'Slot orphan', kind: 'unmapped', selection: personalRef('unresolved') },
    ])
    expect(snapshotSlots(localData, { ...snapshot, gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID }).at(-1)?.id).toBe('orphan')
  })
})
