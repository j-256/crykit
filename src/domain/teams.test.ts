import { describe, expect, it } from 'vitest'
import { adoptTeam, deleteTeam, recordBuildForCharacter, saveTeam } from './teams'
import { addTestBuild, addTestCharacter, addTestTeam, createTestLocalData, TEST_NOW, TEST_PLAYTHROUGH_ID } from './test-helpers'
import { asId, requirePlaythrough } from './core'
import { captureCharacter } from './characters'
import { saveBuildRevision } from './builds'
import type { BuildRevisionId, CharacterId } from './types'
import { validateNativeLocalDataGraph } from '../interchange/native'

const revisionId = asId<BuildRevisionId>('build-revision')
const teamFrom = (data = addTestBuild(createTestLocalData(), 'build', '', {})) => {
  const saved = saveTeam(data, { title: 'Synthetic Team', slots: [revisionId, revisionId, revisionId, revisionId], now: TEST_NOW })
  return { data: saved, team: Object.values(saved.teams)[0]! }
}

describe('independent Teams and optional tracking', () => {
  it('deletes only the saved Team while retaining checkpoints and adopted records', () => {
    const roster = addTestTeam(addTestBuild(createTestLocalData(), 'build', '', {}))
    const { data, team } = teamFrom(roster.localData)
    const adopted = adoptTeam(data, { teamId: team.id, characterIds: roster.memberIds, now: TEST_NOW })
    const removed = deleteTeam(adopted, { teamId: team.id, expectedRevision: adopted.revision, now: TEST_NOW })
    expect(removed.teams[team.id]).toBeUndefined()
    expect(removed.builds).toBe(adopted.builds)
    expect(removed.buildRevisions).toBe(adopted.buildRevisions)
    expect(removed.playthroughs).toBe(adopted.playthroughs)
    expect(removed.revision).toBe(adopted.revision + 1)
    expect(removed.changes.at(-1)).toMatchObject({ command: 'team.delete', changedPaths: [`teams.${team.id}`] })
    expect(() => deleteTeam(adopted, { teamId: team.id, expectedRevision: adopted.revision - 1 })).toThrow('revision')
    expect(() => deleteTeam(removed, { teamId: team.id })).toThrow('unavailable')
    validateNativeLocalDataGraph(removed, [])
  })

  it('creates and edits four build slots without any Playthrough or characters', () => {
    const builds = addTestBuild(createTestLocalData(), 'build', '', {})
    const original = { ...builds, selectedPlaythroughId: undefined, planningGameSetupRevisionId: undefined, playthroughs: {} }
    const { data, team } = teamFrom(original)
    expect(data.playthroughs).toBe(original.playthroughs)
    expect(team.slots).toEqual([revisionId, revisionId, revisionId, revisionId])
    expect(saveTeam(data, { ...team, slots: [revisionId, null, null, null] }).teams[team.id]?.revision).toBe(team.revision + 1)
    expect(() => saveTeam(data, { title: 'Bad shape', slots: [revisionId] })).toThrow('four')
    expect(() => saveTeam(data, { title: 'Missing build', slots: [asId<BuildRevisionId>('missing'), null, null, null] })).toThrow('unavailable')
    validateNativeLocalDataGraph(data, [])
  })

  it('keeps pinned Team checkpoints when a build gains another revision', () => {
    const { data, team } = teamFrom()
    const revision = data.buildRevisions[revisionId]!
    const next = saveBuildRevision(data, { buildId: revision.buildId, gameSetupRevisionId: revision.gameSetupRevisionId, content: revision.content, now: TEST_NOW })
    expect(next.teams[team.id]).toBe(team)
    expect(next.builds[revision.buildId]?.latestRevisionId).not.toBe(revisionId)
  })

  it('records one build on one character without a party, preserving history, learning, level, and inventory', () => {
    const characterId = asId<CharacterId>('solo')
    const original = captureCharacter(addTestCharacter(addTestBuild(createTestLocalData(), 'build', '', {}), 'solo'), { characterId, level: { state: 'known', value: 32 }, displayedStats: { HP: { value: { state: 'known', value: 999 }, unit: 'HP' } }, now: TEST_NOW })
    const before = requirePlaythrough(original)
    const result = recordBuildForCharacter(original, { characterId, buildRevisionId: revisionId, now: TEST_NOW })
    const after = requirePlaythrough(result)
    const character = after.characters[characterId]!
    const snapshot = character.snapshots[character.currentSnapshotId!]!
    expect(snapshot.level).toEqual({ state: 'known', value: 32 })
    expect(snapshot.displayedStats).toEqual({})
    expect(character.snapshots[before.characters[characterId]!.currentSnapshotId!]).toEqual(before.characters[characterId]!.snapshots[before.characters[characterId]!.currentSnapshotId!])
    expect(character.learnedNodes).toBe(before.characters[characterId]!.learnedNodes)
    expect(character.classProgress).toBe(before.characters[characterId]!.classProgress)
    expect(after.inventory).toBe(before.inventory)
    expect(after.scenarios).toEqual({})
    expect(result.teams).toBe(original.teams)
  })

  it('adopts a complete Team into an explicitly matched party while preserving its reusable definition', () => {
    const roster = addTestTeam(addTestBuild(createTestLocalData(), 'build', '', {}))
    const { data, team } = teamFrom(roster.localData)
    const before = requirePlaythrough(data)
    const adopted = adoptTeam(data, { teamId: team.id, characterIds: roster.memberIds, now: TEST_NOW })
    const after = requirePlaythrough(adopted)
    expect(adopted.teams).toBe(data.teams)
    expect(after.inventory).toBe(before.inventory)
    expect(after.progress).toBe(before.progress)
    for (const id of roster.memberIds) {
      expect(after.characters[id]?.currentSnapshotId).toBeDefined()
      expect(after.characters[id]?.learnedNodes).toBe(before.characters[id]?.learnedNodes)
    }
    const party = Object.values(after.scenarios).find(scenario => scenario.kind === 'recordedCurrent')!
    expect(party.memberIds).toEqual(roster.memberIds)
    expect(Object.values(party.assignments)).toEqual(team.slots)
    expect(() => adoptTeam(data, { teamId: team.id, characterIds: [...roster.memberIds.slice(1), roster.memberIds[1]!] })).toThrow('different')
    expect(data.playthroughs[TEST_PLAYTHROUGH_ID]).toBe(before)
    validateNativeLocalDataGraph(adopted, [])
  })
})
