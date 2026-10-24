import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { AccountDatabase } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId } from '../workspace/account-cache'
import { openAccountWorkspace, prepareAccountWorkspace } from '../workspace/account-graph'
import { mappedChanges } from '../workspace/account-intents'
import { preparePublicationAttempt } from '../account/sync/publication'
import { openRemoteProjection } from '../account/sync/projection'
import { prepareConvergence } from '../account/sync/convergence'
import { createScenario, updateCharacter, updateScenario } from '../domain'
import { addTestBuild, addTestTeam, createTestLocalData, TEST_GAME_SETUP_REVISION_ID, TEST_PLAYTHROUGH_ID } from '../domain/test-helpers'
import { readBlob } from '../workspace/blobs'
import { inspectWorkspaceClosure } from '../workspace/closure'
import { archiveWorkspaceUnit } from '../workspace/pending-content'
import type { WorkspaceState } from '../workspace/documents'

const FIXTURE_FRAME_BYTES = 100_000
let database: AccountDatabase | undefined
afterEach(async () => { invalidateProfile(); await database?.delete() })
async function fixture() {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const team = addTestTeam(createTestLocalData())
  const data = addTestBuild(team.localData, 'baseline-build', team.memberIds[0], {})
  const state: WorkspaceState = { planner: { localData: data, lineage: { rootLocalDataId: data.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
  async function prepare(localData: typeof data, prior?: import('../workspace/account-graph').OpenAccountWorkspace) {
    const prepared = await prepareAccountWorkspace(database!, token, { ...state, planner: { ...state.planner, localData } }, prior)
    await database!.encryptedRevisions.bulkAdd(prepared.records)
    return prepared.opened
  }
  async function publish(target: import('../workspace/account-graph').OpenAccountWorkspace, previous?: import('../account/sync/projection').RemoteProjection) {
    const heads = new Map(previous ? [...previous.units.values()].filter(unit => unit.physical !== null).map(unit => [unit.ref.documentId, unit.physical!]) : [])
    if (previous) { heads.set(previous.control.documentId, previous.control.revisionId); for (const directory of previous.directories.values()) if (directory.physical !== null) heads.set(directory.ref.documentId, directory.physical) }
    const publication = await preparePublicationAttempt(database!, token, target, previous ?? null, heads, 0, previous ? mappedChanges(previous.workspace, target) : undefined, 'additive', previous ? { lineageId: previous.lineageId, parents: new Map([...previous.units.values()].map(unit => [unit.body.ref.revisionId, unit.ref])) } : undefined)
    for (const ref of publication.final.heads) heads.set(ref.documentId, ref.revisionId)
    return (await openRemoteProjection(database!, token, heads, target.head, target.state.planner.localData.revision))!
  }
  function scenario(localData: typeof data) {
    return createScenario(localData, { label: 'Recorded party', memberIds: team.memberIds, baseline: { kind: 'recordedParty', playthroughRevision: localData.playthroughs[TEST_PLAYTHROUGH_ID].revision, assignments: { [team.memberIds[0]]: Object.values(data.buildRevisions)[0].id } }, gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID })
  }
  return { token, team, data, state, prepare, publish, scenario }
}

it.each([false, true])('convergesNewRecordedPartyWithExactHistoricalOwnerAndCheckpointEvidence changed owner %s', async changedOwner => {
  const f = await fixture(), base = await f.prepare(f.data)
  const accepted = changedOwner ? await f.prepare({ ...f.data, playthroughs: { ...f.data.playthroughs, [TEST_PLAYTHROUGH_ID]: { ...f.data.playthroughs[TEST_PLAYTHROUGH_ID], label: 'Accepted owner' } } }, base) : base
  const remote = await f.publish(accepted)
  const edited = updateCharacter(f.data, { characterId: f.team.memberIds[0], name: 'Local child' })
  const local = await f.prepare(f.scenario(edited), base)
  const snapshot = structuredClone(local.state), entries = structuredClone(local.entries)
  const owner = accepted.entries.find(entry => entry.kind === 'playthrough')!
  const scenario = local.entries.find(entry => entry.kind === 'scenario')!
  const originalOwner = await readBlob(accepted.payloads.get(owner.key)!, FIXTURE_FRAME_BYTES)
  expect(scenario.sourceBookkeeping!.owner).toEqual(base.entries.find(entry => entry.kind === 'playthrough')!.ref)
  if (changedOwner) expect(scenario.sourceBookkeeping!.owner).not.toEqual(owner.ref)
  const originalScenario = await readBlob(local.payloads.get(scenario.key)!, FIXTURE_FRAME_BYTES)
  const result = await prepareConvergence(database!, f.token, base, local, remote, mappedChanges(base, local), new Map())
  const converged = await openAccountWorkspace(database!, f.token, result.target.head)
  expect(converged.entries.find(entry => entry.key === owner.key)!.ref).toEqual(owner.ref)
  expect(await readBlob(converged.payloads.get(owner.key)!, FIXTURE_FRAME_BYTES)).toEqual(originalOwner)
  expect(converged.entries.find(entry => entry.key === scenario.key)).toEqual(scenario)
  expect(await readBlob(converged.payloads.get(scenario.key)!, FIXTURE_FRAME_BYTES)).toEqual(originalScenario)
  expect(converged.state.planner.localData.playthroughs[TEST_PLAYTHROUGH_ID].revision).toBe(edited.playthroughs[TEST_PLAYTHROUGH_ID].revision)
  expect(converged.state.planner.localData.playthroughs[TEST_PLAYTHROUGH_ID].scenarios).toEqual(local.state.planner.localData.playthroughs[TEST_PLAYTHROUGH_ID].scenarios)
  const blobs = new Map<string, WorkspaceState['blobs'][number]>()
  const closure = await archiveWorkspaceUnit(converged, scenario.key, blobs)
  const captured = await inspectWorkspaceClosure({ ...converged.state, blobs: [...blobs.values()] }, closure)
  expect(captured.documents.has(local.entries.find(entry => entry.kind === 'build-checkpoint')!.key)).toBe(true)
  expect(local.state).toEqual(snapshot)
  expect(local.entries).toEqual(entries)
})

it('usesOnlyTheAcceptedScenarioFloorWhenTheNewerLocalBaselineConflicts', async () => {
  const f = await fixture(), base = await f.prepare(f.scenario(f.data)), initial = await f.publish(base)
  const original = Object.values(base.state.planner.localData.playthroughs[TEST_PLAYTHROUGH_ID].scenarios)[0]
  function branch(label: string, edits: number) {
    let data = base.state.planner.localData
    for (let index = 0; index < edits; index++) data = updateCharacter(data, { characterId: f.team.memberIds[0], name: `${label} ${index}` })
    data = updateScenario(data, { scenarioId: original.id, label })
    const playthrough = data.playthroughs[TEST_PLAYTHROUGH_ID]
    // Synthetic branches capture different valid baselines of the same scenario identity
    return { ...data, playthroughs: { ...data.playthroughs, [TEST_PLAYTHROUGH_ID]: { ...playthrough, scenarios: { ...playthrough.scenarios, [original.id]: { ...playthrough.scenarios[original.id], baseline: { ...original.baseline, playthroughRevision: playthrough.revision } } } } } }
  }
  const local = await f.prepare(branch('Pending', 4), base), accepted = await f.prepare(branch('Accepted', 1), base)
  const remote = await f.publish(accepted, initial)
  const parents = new Map([...initial.units.values()].map(unit => [unit.body.ref.revisionId, unit.ref]))
  const result = await prepareConvergence(database!, f.token, base, local, remote, mappedChanges(base, local), parents)
  const scenario = accepted.entries.find(entry => entry.kind === 'scenario')!
  expect(result.target.entries.find(entry => entry.key === scenario.key)).toEqual(scenario)
  expect(result.target.state.planner.localData.playthroughs[TEST_PLAYTHROUGH_ID].revision).toBe(accepted.state.planner.localData.playthroughs[TEST_PLAYTHROUGH_ID].revision)
  expect(result.target.state.planner.localData.playthroughs[TEST_PLAYTHROUGH_ID].revision).toBeLessThan(local.state.planner.localData.playthroughs[TEST_PLAYTHROUGH_ID].revision)
  expect(result.target.state.conflicts.some(conflict => conflict.unit.kind === 'record' && conflict.unit.privateKey === scenario.key)).toBe(true)
})

it('authenticatesExactSourceRefsBeforeCollectingFloorsAndKeepsProjectionTimeLocal', async () => {
  const { projectionBookkeeping } = await import('../account/sync/projection-bookkeeping')
  const f = await fixture(), base = await f.prepare(f.data)
  const edited = updateCharacter(f.data, { characterId: f.team.memberIds[0], name: 'New baseline' })
  const local = await f.prepare(f.scenario(edited), base)
  const entry = local.entries.find(entry => entry.kind === 'scenario')!
  const scenario = await local.readCaptured(entry.ref), evidence = scenario.sourceBookkeeping!
  const timestamp = '2026-02-01T00:00:00.000Z'
  const floor = edited.playthroughs[TEST_PLAYTHROUGH_ID].revision
  expect(evidence.revision).toBeGreaterThan(floor)
  expect(await projectionBookkeeping([scenario], local.readCaptured, timestamp)).toEqual(new Map([[TEST_PLAYTHROUGH_ID, { revision: floor, updatedAt: timestamp }]]))
  const invalid = [
    { ...scenario, ref: { ...scenario.ref, documentId: accountLocalId() } },
    { ...scenario, ref: { ...scenario.ref, revisionId: accountLocalId() } },
    { ...scenario, sourceBookkeeping: { ...evidence, revision: floor - 1 } },
    { ...scenario, sourceBookkeeping: undefined },
    { ...scenario, document: { ...scenario.document, value: { ...scenario.document.value as object, baseline: { kind: 'empty' } } } },
  ]
  for (const record of invalid) await expect(projectionBookkeeping([record], local.readCaptured, timestamp)).rejects.toThrow()
  for (const field of ['documentId', 'revisionId'] as const) {
    const wrongOwner = { ...evidence.owner, [field]: accountLocalId() }
    await expect(projectionBookkeeping([scenario], async ref => {
      const record = await local.readCaptured(ref)
      return ref.documentId === evidence.owner.documentId && ref.revisionId === evidence.owner.revisionId ? { ...record, ref: wrongOwner } : record
    }, timestamp)).rejects.toThrow('Invalid recorded-party source bookkeeping')
  }
})
