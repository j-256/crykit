import { describe, expect, it } from 'vitest'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { NativeLocalDataSchema } from '../interchange/native-schema'
import { splitWorkspace } from '../workspace/documents'
import { validateWorkspaceClosure } from '../workspace/closure'
import { checkpointContentDigest } from './checkpoint-identity'
import { sha256 } from '../interchange/util'
import { asId } from './core'
import { addTestBuild, createTestLocalData, TEST_NOW } from './test-helpers'
import { saveSharedTeam, resolveCheckpoint, migrateLocalData250 } from './team-checkpoints'
import type { BuildRevisionId, TeamId } from './types'

const build = asId<BuildRevisionId>('build-revision')
const teamId = asId<TeamId>('team-owned')
const fixture = () => addTestBuild(createTestLocalData(), 'build', '', {})
const legacy = () => {
  const { teamRevisions: _revisions, ...data } = fixture()
  return { ...data, schemaVersion: '2.4.0', teams: { [teamId]: { id: teamId, title: 'Team', revision: 3, slots: [build, null, build, null], createdAt: TEST_NOW, updatedAt: TEST_NOW } } }
}

describe('Team-owned checkpoint graph', () => {
  it('matches Web Crypto checkpoint identities across SHA block boundaries', async () => {
    for (const size of [0, 1, 53, 54, 55, 56, 62, 63, 64, 65, 1000, 1024]) {
      const value = 'x'.repeat(size)
      expect(checkpointContentDigest(value)).toBe(await sha256(new TextEncoder().encode(JSON.stringify(value))))
    }
    expect(checkpointContentDigest({ z: 1, a: [2, null] })).toBe(checkpointContentDigest({ a: [2, null], z: 1 }))
  })
  it('copiesTeamSlotsWithoutChangingBuildHistory', () => {
    const before = fixture()
    const next = saveSharedTeam(before, { id: teamId, title: 'Owned', gameSetupRevisionId: before.buildRevisions[build]!.gameSetupRevisionId, slots: [build, null, build, null], now: TEST_NOW })
    expect(next.builds).toEqual(before.builds)
    expect(next.buildRevisions).toEqual(before.buildRevisions)
    const team = next.teams[teamId]!
    expect(team.kind).toBe('shared')
    if (team.kind !== 'shared') throw new Error('Expected shared Team')
    const revision = next.teamRevisions[team.latestRevisionId]!
    expect(revision.slots).toHaveLength(4)
    expect(revision.slots.map(slot => slot?.sourceBuildRevisionId ?? null)).toEqual([build, null, build, null])
    expect(revision.slots[0]!.content).toEqual(before.buildRevisions[build]!.content)
    expect(revision.slots[0]!.content).not.toBe(before.buildRevisions[build]!.content)
    expect(revision.slots[0]!.id).not.toBe(revision.slots[2]!.id)
  })

  it('migratesEquivalentButRetainsMixedSetups', () => {
    const before = legacy()
    const next = migrateLocalData250(before, [])
    expect(next.teams[teamId]!.kind).toBe('shared')
    expect(next.builds).toEqual(before.builds)
    expect(next.buildRevisions).toEqual(before.buildRevisions)
    const second = { ...before.buildRevisions[build]!, id: asId<BuildRevisionId>('other'), catalogLock: { unavailable: 'different-pin' } }
    const mixed = { ...before, buildRevisions: { ...before.buildRevisions, other: second }, teams: { [teamId]: { ...before.teams[teamId]!, slots: [build, second.id, null, null] } } }
    expect(() => migrateLocalData250(mixed, [])).toThrow()
    const setup = before.gameSetups[second.gameSetupRevisionId]!
    const different = { ...setup, id: 'different-setup', label: setup.label, ppLimit: { state: 'known', value: 99 } }
    const validMixed = { ...mixed, gameSetups: { ...before.gameSetups, 'different-setup': different }, buildRevisions: { ...before.buildRevisions, other: { ...second, catalogLock: {}, gameSetupRevisionId: different.id } } }
    const result = migrateLocalData250(validMixed, [])
    expect(result.teams[teamId]!.kind).toBe('legacy-mixed')
    expect(result.teams[teamId]).toEqual({ ...validMixed.teams[teamId], kind: 'legacy-mixed' })
  })

  it('retains all-null legacy Teams exactly and requires a setup for a new empty Team', () => {
    const before = legacy()
    const empty = { ...before, teams: { [teamId]: { ...before.teams[teamId]!, slots: [null, null, null, null] } } }
    expect(migrateLocalData250(empty, []).teams[teamId]).toEqual({ ...empty.teams[teamId], kind: 'legacy-mixed' })
    expect(() => saveSharedTeam(fixture(), { id: teamId, title: 'Empty', gameSetupRevisionId: 'missing' as never, slots: [null, null, null, null], now: TEST_NOW })).toThrow()
  })

  it('scenarioAssignmentResolvesTeamOwnedContext', () => {
    const before = fixture()
    const next = saveSharedTeam(before, { id: teamId, title: 'Owned', gameSetupRevisionId: before.buildRevisions[build]!.gameSetupRevisionId, slots: [null, build, null, null], now: TEST_NOW })
    const team = next.teams[teamId]!
    if (team.kind !== 'shared') throw new Error('Expected shared Team')
    const revision = next.teamRevisions[team.latestRevisionId]!
    const resolved = resolveCheckpoint(next, { kind: 'team-slot', teamRevisionId: revision.id, slot: 1 })
    expect(resolved.setup.id).toBe(revision.gameSetupRevisionId)
    expect(resolved.catalogLock).toEqual(revision.catalogLock)
    expect(() => resolveCheckpoint(next, { kind: 'team-slot', teamRevisionId: revision.id, slot: 0 })).toThrow()
  })

  it('gives distinct historical contents stable bounded checkpoint identities', () => {
    const before = legacy()
    const changed = { ...before, teams: { [teamId]: { ...before.teams[teamId]!, revision: 4, slots: [null, build, null, null] } } }
    const one = migrateLocalData250(before, [])
    const two = migrateLocalData250(changed, [])
    expect(Object.keys(one.teamRevisions)).not.toEqual(Object.keys(two.teamRevisions))
    expect(migrateLocalData250(before, []).teamRevisions).toEqual(one.teamRevisions)
    const longId = 't'.repeat(1024)
    expect(() => migrateLocalData250({ ...before, teams: { [longId]: { ...before.teams[teamId]!, id: longId } } }, [])).not.toThrow()
  })

  it('retains unavailable personal refs only as bounded inert receipts across workspace mapping', async () => {
    const before = fixture()
    const ref = { kind: 'personal' as const, definitionId: 'unavailable' as never }
    const source = before.buildRevisions[build]!
    const content = { ...source.content, primaryClass: ref }
    const input = { title: 'Unavailable', gameSetupRevisionId: source.gameSetupRevisionId, slots: [{ id: 'slot' as never, content, createdAt: TEST_NOW }, null, null, null], now: TEST_NOW }
    expect(() => saveSharedTeam(before, input)).toThrow('receipt')
    const receipts = [{ ref, kind: 'class' as const, name: 'Historical class' }]
    const next = saveSharedTeam({ ...before, unavailableDefinitions: receipts }, input)
    expect(next.personalDefinitions[ref.definitionId]).toBeUndefined()
    const forged = structuredClone(next)
    const revision = Object.values(forged.teamRevisions)[0]!
    const slot = revision.slots[0]!
    expect(() => validateNativeLocalDataGraph({ ...forged, teamRevisions: { [revision.id]: { ...revision, slots: [{ ...slot, content: { ...slot.content, referenceNames: [{ ref: { kind: 'catalog', catalogId: 'foreign' as never, catalogRevisionId: 'foreign' as never, entityId: 'foreign' as never }, name: 'Foreign receipt' }] } }, null, null, null] } } }, [])).toThrow('display receipt')

    validateNativeLocalDataGraph(next, [])
    expect(NativeLocalDataSchema.safeParse({ ...next, unavailableDefinitions: [{ ...receipts[0], fields: { invented: 1 } }] }).success).toBe(false)
    expect(() => validateNativeLocalDataGraph({ ...next, unavailableDefinitions: [...receipts, ...receipts] }, [])).toThrow()
    const state = { planner: { localData: next, lineage: { rootLocalDataId: next.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1 as const, layers: [] } }
    await validateWorkspaceClosure(state)
    const docs = splitWorkspace(state)
    expect(docs.find(document => document.kind === 'workspace-preferences')!.value).toMatchObject({ unavailableDefinitions: receipts })
    expect(docs.some(document => document.kind === 'personal-definition')).toBe(false)
  })

  it('does not merge equal behavior with different exact Build catalog pins', () => {
    const before = legacy()
    const catalog = (revisionId: string) => ({ id: 'catalog' as never, revisionId: revisionId as never, schemaVersion: 'synthetic', checksum: revisionId, importedAt: TEST_NOW, applicability: { state: 'unknown' as const }, rights: { state: 'unknown' as const }, entities: {}, claims: [] })
    const one = { ...before.buildRevisions[build]!, catalogLock: { catalog: 'one' as never } }
    const two = { ...one, id: 'other' as never, catalogLock: { catalog: 'two' as never } }
    const mixed = { ...before, buildRevisions: { [build]: one, other: two }, teams: { [teamId]: { ...before.teams[teamId]!, slots: [one.id, two.id, null, null] } } }
    expect(migrateLocalData250(mixed, [catalog('one'), catalog('two')]).teams[teamId]).toEqual({ ...mixed.teams[teamId], kind: 'legacy-mixed' })
  })

  it('rejects newer roots and malformed source lineage', () => {
    expect(() => migrateLocalData250({ ...legacy(), schemaVersion: '2.6.0' }, [])).toThrow()
    const before = legacy()
    expect(() => migrateLocalData250({ ...before, buildRevisions: { [build]: { ...before.buildRevisions[build], parentRevisionId: 'missing' } } }, [])).toThrow()
  })
})
