import { describe, expect, it } from 'vitest'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { NativeLocalDataSchema } from '../interchange/native-schema'
import { splitWorkspace } from '../workspace/documents'
import { validateWorkspaceClosure } from '../workspace/closure'
import { checkpointContentDigest } from './checkpoint-identity'
import { sha256 } from '../interchange/util'
import { asId } from './core'
import { addTestBuild, createTestLocalData, TEST_NOW } from './test-helpers'
import { saveSharedTeam, resolveCheckpoint, admitLaunchLocalData } from './team-checkpoints'
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
    for (const value of ['x'.repeat(1024 * 1024), 'Synthetic \u{1f4a0}\u0000'.repeat(64 * 1024)]) {
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

  it('rejects prelaunch Teams without rewriting their checkpoints', () => {
    const before = legacy(), unchanged = structuredClone(before)
    expect(() => admitLaunchLocalData(before, [])).toThrow()
    expect(before).toEqual(unchanged)
  })

  it('admits supported Teams exactly and requires a setup for an empty Team', () => {
    const before = fixture()
    expect(admitLaunchLocalData(before, [])).toEqual(before)
    expect(() => saveSharedTeam(before, { id: teamId, title: 'Empty', gameSetupRevisionId: 'missing' as never, slots: [null, null, null, null], now: TEST_NOW })).toThrow()
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

  it('rejects newer roots and malformed source lineage', () => {
    expect(() => admitLaunchLocalData({ ...fixture(), schemaVersion: '4.0.0' }, [])).toThrow()
    const before = fixture()
    expect(() => admitLaunchLocalData({ ...before, buildRevisions: { [build]: { ...before.buildRevisions[build], parentRevisionId: 'missing' } } }, [])).toThrow()
  })
})
