import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountDatabase } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId, cipherRef } from '../workspace/account-cache'
import { openAccountRepository } from '../workspace/account-repository'
import { seedNativePublicationWorkspace } from './native-publication.test-helpers'
import { openAccountWorkspace } from '../workspace/account-graph'
import { preparePublicationAttempt, stagePublicationRecord } from '../account/sync/publication'
import { openRemoteProjection } from '../account/sync/projection'

let database: AccountDatabase | undefined
afterEach(async () => { invalidateProfile(); await database?.delete() })
it('mappingContextPreservesPhysicalSeedHeadSeparatelyFromBaselineSelection', async () => {
  const { captureMappingContext } = await import('../account/sync/mapping-context')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  await seedNativePublicationWorkspace(database, token)
  const fence = (await database.profileMeta.get('active'))!
  const local = await openAccountWorkspace(database, token, fence.head)
  const attempt = await preparePublicationAttempt(database, token, local, null, new Map(), 0)
  const heads = new Map(attempt.final.heads.map(ref => [ref.documentId, ref.revisionId]))
  const baseline = (await openRemoteProjection(database, token, heads, local.head, 0))!
  const unit = [...baseline.units.values()].find(value => value.body.kind === 'library-defaults')!
  expect((await captureMappingContext(database, token, baseline, unit.key)).recordPhysicalHead).toBeNull()
  const physical = (await openRemoteProjection(database, token, new Map([...heads, [unit.ref.documentId, unit.ref.revisionId]]), local.head, 0))!
  expect(physical.units.get(unit.key)!.ref).toEqual(unit.ref)
  expect((await captureMappingContext(database, token, physical, unit.key)).recordPhysicalHead).toBe(unit.ref.revisionId)
  expect(await database.profileMeta.get('active')).toEqual(fence)
})
it('rejectsWrongLineageNonDescendantAndCorruptedBodiesWithoutChangingLocalAuthority', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  await seedNativePublicationWorkspace(database, token)
  const fence = (await database.profileMeta.get('active'))!
  const local = await openAccountWorkspace(database, token, fence.head)
  const attempt = await preparePublicationAttempt(database, token, local, null, new Map(), 0)
  const heads = new Map(attempt.final.heads.map(ref => [ref.documentId, ref.revisionId]))
  const projection = (await openRemoteProjection(database, token, heads, local.head, 0))!
  const unit = [...projection.units.values()].find(value => value.body.kind === 'library-defaults')!
  const orphan = await stagePublicationRecord(database, token, unit.body, projection.lineageId)
  await expect(openRemoteProjection(database, token, new Map([...heads, [orphan.descriptor.documentId, orphan.revisionId]]), local.head, 0)).rejects.toThrow('INTEGRITY_FAILED')
  const foreign = await stagePublicationRecord(database, token, unit.body, accountLocalId(), unit.ref)
  await expect(openRemoteProjection(database, token, new Map([...heads, [foreign.descriptor.documentId, foreign.revisionId]]), local.head, 0)).rejects.toThrow('INTEGRITY_FAILED')
  const valid = await stagePublicationRecord(database, token, unit.body, projection.lineageId, unit.ref)
  const advanced = new Map([...heads, [valid.descriptor.documentId, valid.revisionId]])
  expect((await openRemoteProjection(database, token, advanced, local.head, 0))!.units.get(unit.key)!.ref).toEqual(cipherRef(valid))
  const { assertProjectionAdvance, assertProjectionSuccessor } = await import('../account/sync/projection')
  const { stagePublicationPages } = await import('../account/sync/publication')
  const accepted = (await openRemoteProjection(database, token, advanced, local.head, 0))!
  const effective = { lineageId: accepted.lineageId, control: accepted.control, units: await stagePublicationPages(database, token, 'local-effective-units', [...accepted.units.values()].map(unit => ({ key: unit.key, body: unit.body.ref, publication: unit.ref })), entry => [entry.body, entry.publication]) }
  await assertProjectionAdvance(database, token, accepted, effective)
  await expect(assertProjectionAdvance(database, token, projection, effective)).rejects.toThrow('INTEGRITY_FAILED')
  await expect(assertProjectionSuccessor(database, token, projection, accepted)).rejects.toThrow('INTEGRITY_FAILED')
  const chunk = (await database.stagedCipherChunks.get([valid.payloadId, 0]))!
  const corrupted = chunk.bytes.slice(); corrupted[0] ^= 1
  await database.stagedCipherChunks.put({ ...chunk, bytes: corrupted })
  await expect(openRemoteProjection(database, token, advanced, local.head, 0)).rejects.toThrow()
  expect(await database.profileMeta.get('active')).toEqual(fence)
  expect((await openAccountWorkspace(database, token, (await database.profileMeta.get('active'))!.head)).state).toEqual(local.state)
})
it('projectsRecordedPartyAfterIndependentChildBookkeepingWithoutRewritingOriginalFrames', async () => {
  const { createTestLocalData, addTestTeam, addTestBuild, TEST_GAME_SETUP_REVISION_ID, TEST_PLAYTHROUGH_ID } = await import('../domain/test-helpers')
  const { updateCharacter, createScenario } = await import('../domain')
  const { prepareAccountWorkspace } = await import('../workspace/account-graph')
  const { activateLocalAccountCommit } = await import('./account-database')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const team = addTestTeam(createTestLocalData()), data = addTestBuild(team.localData, 'baseline-only-build', team.memberIds[0], {})
  const state: import('../workspace/documents').WorkspaceState = { planner: { localData: data, lineage: { rootLocalDataId: data.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
  const base = await prepareAccountWorkspace(database, token, state)
  const fence = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: base.head, records: base.records })
  const edited = updateCharacter(data, { characterId: team.memberIds[0], name: 'Independent child edit' })
  const target = createScenario(edited, { label: 'Recorded party', memberIds: team.memberIds, baseline: { kind: 'recordedParty', playthroughRevision: edited.playthroughs[TEST_PLAYTHROUGH_ID].revision, assignments: { [team.memberIds[0]]: Object.values(data.buildRevisions)[0].id } }, gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID })
  const prepared = await prepareAccountWorkspace(database, token, { ...state, planner: { ...state.planner, localData: target } }, base.opened)
  await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: fence, head: prepared.head, records: prepared.records })
  const owner = base.entries.find(entry => entry.kind === 'playthrough')!
  expect(prepared.entries.find(entry => entry.kind === 'playthrough')!.ref).toEqual(owner.ref)
  const publication = await preparePublicationAttempt(database, token, prepared.opened, null, new Map(), 0)
  const projection = await openRemoteProjection(database, token, new Map(publication.final.heads.map(ref => [ref.documentId, ref.revisionId])), prepared.head, target.revision)
  expect(projection!.workspace.state.planner.localData.playthroughs[TEST_PLAYTHROUGH_ID].scenarios).toEqual(target.playthroughs[TEST_PLAYTHROUGH_ID].scenarios)
  const scenario = prepared.entries.find(entry => entry.kind === 'scenario' && entry.sourceBookkeeping)!
  expect(scenario.sourceBookkeeping!.owner).toEqual(owner.ref)
  expect(scenario.sourceBookkeeping!.revision).toBe(target.playthroughs[TEST_PLAYTHROUGH_ID].revision)
  expect(projection!.workspace.entries.find(entry => entry.key === scenario.key)).toEqual(scenario)
  const reopened = await openAccountWorkspace(database, token, prepared.head)
  expect(reopened.state.planner.localData).toEqual(target)
  const { archiveWorkspaceUnit } = await import('../workspace/pending-content')
  const { inspectWorkspaceClosure } = await import('../workspace/closure')
  const { blobIdentity, readBlob } = await import('../workspace/blobs')
  const output = new Map<string, import('../workspace/documents').WorkspaceState['blobs'][number]>()
  const closure = await archiveWorkspaceUnit(reopened, scenario.key, output)
  const portable = { ...state, blobs: [...output.values()] }
  const inspected = await inspectWorkspaceClosure(portable, closure)
  expect(inspected.refs.has(blobIdentity(prepared.entries.find(entry => entry.kind === 'build-checkpoint')!.ref))).toBe(true)
  expect(inspected.root.ref.documentId).toBe(scenario.ref.documentId)
  expect(inspected.value).toEqual((await reopened.readCaptured(scenario.ref)).document.value)
  expect(JSON.parse(new TextDecoder().decode(await readBlob(output.get(blobIdentity(owner.ref))!.content, 100000)))).toEqual((await base.opened.readCaptured(owner.ref)).document.value)
  const originalOwnerBytes = await readBlob(base.opened.payloads.get(owner.key)!, 100000)
  expect(await readBlob(projection!.workspace.payloads.get(owner.key)!, 100000)).toEqual(originalOwnerBytes)
  const heads = new Map(publication.final.heads.map(ref => [ref.documentId, ref.revisionId]))
  const selected = projection!.units.get(scenario.key)!
  const { sourceBookkeeping: evidence, ...missing } = scenario
  const invalid = [missing, { ...scenario, sourceBookkeeping: { ...evidence!, baselineCheckpoints: [] } }, { ...scenario, sourceBookkeeping: { ...evidence!, baselineCheckpoints: evidence!.baselineCheckpoints.map(value => ({ ...value, ref: owner.ref })) } }, { ...scenario, sourceBookkeeping: { ...evidence!, owner: scenario.ref } }, { ...scenario, sourceBookkeeping: { ...evidence!, revision: 0 } }, { ...scenario, sourceBookkeeping: { ...evidence!, ownerKey: '["playthrough","foreign"]' } }]
  for (const entry of invalid) {
    const envelope = await stagePublicationRecord(database, token, entry, projection!.lineageId, selected.ref)
    await expect(openRemoteProjection(database, token, new Map([...heads, [envelope.descriptor.documentId, envelope.revisionId]]), prepared.head, target.revision)).rejects.toThrow()
  }
  const { projectPlanner } = await import('../workspace/planner-journal')
  const adopted = projectPlanner(state.planner, projection!.workspace.state.planner, true)
  expect(adopted.localData.revision).toBe(0)
  expect(adopted.localData.playthroughs[TEST_PLAYTHROUGH_ID].revision).toBe(edited.playthroughs[TEST_PLAYTHROUGH_ID].revision)
  const installed = await prepareAccountWorkspace(database, token, { ...projection!.workspace.state, planner: adopted }, projection!.workspace)
  const currentFence = (await database.profileMeta.get('active'))!
  await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: currentFence, head: installed.head, records: installed.records })
  const repository = await openAccountRepository(token)
  expect((await repository.previewImport(await repository.exportPlannerBackup(), 'recorded-party.zip')).proposed.localData).toEqual(adopted.localData)
  expect(() => projectPlanner({ ...state.planner, localData: { ...data, playthroughs: { ...data.playthroughs, [TEST_PLAYTHROUGH_ID]: { ...data.playthroughs[TEST_PLAYTHROUGH_ID], revision: Number.MAX_SAFE_INTEGER } } } }, projection!.workspace.state.planner, false)).toThrow('overflow')

})
async function frozenScenarioFixture() {
  const { createTestLocalData, addTestTeam, addTestBuild, TEST_GAME_SETUP_REVISION_ID, TEST_PLAYTHROUGH_ID } = await import('../domain/test-helpers')
  const { createScenario } = await import('../domain')
  const { prepareAccountWorkspace, AccountWorkspaceRootSchema, openLegacyLocalAccountWorkspace } = await import('../workspace/account-graph')
  const { stageAccountJson, openAccountJson } = await import('../workspace/account-cache')
  const { stageAccountSource } = await import('../workspace/account-streams')
  const { buildIndexPages } = await import('../workspace/directory')
  const { activateLocalAccountCommit } = await import('./account-database')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const team = addTestTeam(createTestLocalData())
  const firstBuild = addTestBuild(team.localData, 'legacy-baseline', team.memberIds[0], {})
  const built = addTestBuild(firstBuild, 'legacy-second-baseline', team.memberIds[1], {})
  const data = createScenario(built, { label: 'Legacy party', memberIds: team.memberIds, baseline: { kind: 'recordedParty', playthroughRevision: built.playthroughs[TEST_PLAYTHROUGH_ID].revision, assignments: { [team.memberIds[0]]: Object.values(built.buildRevisions)[0].id, [team.memberIds[1]]: Object.values(built.buildRevisions)[1].id } }, gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID })
  const state: import('../workspace/documents').WorkspaceState = { planner: { localData: data, lineage: { rootLocalDataId: data.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
  const modern = await prepareAccountWorkspace(database, token, state)
  await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: modern.head, records: modern.records })
  const scenario = modern.entries.find(entry => entry.sourceBookkeeping)!, checkpoint = modern.entries.find(entry => entry.kind === 'build-checkpoint')!
  const record = (await database.encryptedRevisions.get(scenario.ref.revisionId))!
  // Construct the frozen pre-extension on-disk format, whose physical scenario edges omitted baseline assignments
  const legacyBody = await stageAccountSource(database, token, modern.opened.payloads.get(scenario.key)!, record.descriptor.dependencies.filter(ref => !modern.entries.some(entry => entry.kind === 'build-checkpoint' && entry.ref.revisionId === ref.revisionId)), undefined, scenario.ref.documentId)
  const records = [legacyBody]
  const legacyEntries = modern.entries.map(entry => { if (entry.key !== scenario.key) return entry; const { sourceBookkeeping: _source, ...rest } = entry; return { ...rest, ref: cipherRef(legacyBody) } })
  const index = await buildIndexPages(legacyEntries, async page => { const record = await stageAccountJson(database!, token, page, [...page.children, ...page.entries.map(entry => entry.ref)]); records.push(record); return cipherRef(record) })
  const oldRoot = await openAccountJson(database, token, modern.head, AccountWorkspaceRootSchema)
  const { sourceEvidenceVersion: _version, ...unmarkedRoot } = oldRoot
  const legacyRoot = await stageAccountJson(database, token, { ...unmarkedRoot, index }, [index, oldRoot.allocations, oldRoot.playthroughBookkeeping!.index])
  records.push(legacyRoot)
  const fence = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: (await database.profileMeta.get('active'))!, head: cipherRef(legacyRoot), records })
  const originalCiphertext = (await database.stagedCipherChunks.get([legacyBody.payloadId, 0]))!.bytes.slice()
  await expect(openAccountWorkspace(database, token, fence.head)).rejects.toThrow('Missing recorded-party')
  const legacy = await openLegacyLocalAccountWorkspace(database, token, fence.head)
  expect(legacy.state.planner.localData).toEqual(data)
  return { token, database, data, state, modern, scenario, checkpoint, legacyBody, legacy, fence, originalCiphertext, unmarkedRoot, index, oldRoot }
}

async function frozenRecordedPartyFixture() {
  const f = await frozenScenarioFixture()
  const { token, database, data, legacy, scenario, fence, unmarkedRoot, oldRoot } = f
  const { blobIdentity } = await import('../workspace/blobs')
  const { archiveWorkspaceUnit } = await import('../workspace/pending-content')
  const { inspectWorkspaceClosure } = await import('../workspace/closure')
  const { buildIndexPages } = await import('../workspace/directory')
  const { stageAccountJson } = await import('../workspace/account-cache')
  const { stageAccountSource } = await import('../workspace/account-streams')
  const { activateLocalAccountCommit } = await import('./account-database')
  const oldPortable = new Map<string, import('../workspace/documents').WorkspaceState['blobs'][number]>()
  const oldClosure = await archiveWorkspaceUnit(legacy, scenario.key, oldPortable)
  const { inspectLegacyLocalWorkspaceClosure } = await import('../workspace/closure')
  const oldState = { ...legacy.state, blobs: [...oldPortable.values()] }
  await expect(inspectWorkspaceClosure(oldState, oldClosure)).rejects.toThrow('Missing recorded-party')
  await inspectLegacyLocalWorkspaceClosure(oldState, oldClosure)
  const groupId = accountLocalId()
  const pending = { version: 1 as const, kind: 'pending-content' as const, id: `${groupId}:${scenario.key}`, groupId, unit: { kind: 'record' as const, privateKey: scenario.key }, base: { kind: 'present' as const, closure: oldClosure }, target: oldClosure }
  const pendingState = { ...oldState, retainedContent: [pending] }
  const { validatedLegacyLocalWorkspaceRetentionEdges, archiveTypedReferences } = await import('../workspace/closure')
  const { splitWorkspace } = await import('../workspace/documents')
  const { workspaceDocumentSource } = await import('../workspace/document-codec')
  const { hashBlob } = await import('../workspace/blobs')
  const edges = await validatedLegacyLocalWorkspaceRetentionEdges(pendingState)
  const fixtureEntries = [...legacy.entries], fixtureRecords: import('./account-database').CipherRecord[] = []
  const fixtureDocuments = new Map(splitWorkspace(pendingState).filter(value => value.kind === 'blob' || value.kind === 'blob-reference' || value.kind === 'retained-content').map(value => [value.key, value]))
  const fixtureBindings = new Map<string, import('./account-database').CipherRef>()
  async function stageFixture(key: string): Promise<import('./account-database').CipherRef> {
    if (fixtureBindings.has(key)) return fixtureBindings.get(key)!
    const document = fixtureDocuments.get(key)!
    const refs = document.kind === 'blob' ? edges.get((JSON.parse(key) as string[])[1]) ?? [] : archiveTypedReferences(document.kind, document.value)
    const dependencies: import('./account-database').CipherRef[] = []
    for (const ref of refs) dependencies.push(await stageFixture(JSON.stringify(['blob', blobIdentity(ref)])))
    const source = workspaceDocumentSource(document), record = await stageAccountSource(database!, token, source, [...new Map(dependencies.map(ref => [blobIdentity(ref), ref])).values()])
    fixtureRecords.push(record); fixtureBindings.set(key, cipherRef(record)); fixtureEntries.push({ key, kind: document.kind, ref: cipherRef(record), digest: await hashBlob(source) })
    return cipherRef(record)
  }
  for (const key of fixtureDocuments.keys()) await stageFixture(key)
  const pendingIndex = await buildIndexPages(fixtureEntries, async page => { const record = await stageAccountJson(database!, token, page, [...page.children, ...page.entries.map(entry => entry.ref)]); fixtureRecords.push(record); return cipherRef(record) })
  const allocationIndex = await buildIndexPages(fixtureEntries.map(entry => ({ key: entry.key, documentId: entry.ref.documentId })), async page => { const record = await stageAccountJson(database!, token, page, page.children); fixtureRecords.push(record); return cipherRef(record) })
  const pendingRoot = await stageAccountJson(database, token, { ...unmarkedRoot, index: pendingIndex, allocations: allocationIndex }, [pendingIndex, allocationIndex, oldRoot.playthroughBookkeeping!.index])
  fixtureRecords.push(pendingRoot)
  const { stageMappedWorkspaceIntent } = await import('../workspace/account-intents')
  const operationId = accountLocalId()
  const intent = await stageMappedWorkspaceIntent(database, token, { version: 1, kind: 'mapped-workspace-intent', operationId, portableGroupId: groupId, operation: 'workspace-command', mode: 'additive', original: { base: legacy.head, target: legacy.head }, base: legacy.head, target: legacy.head, localRevision: data.revision, changes: [] })
  fixtureRecords.push(...intent.records)
  const pendingFence = await activateLocalAccountCommit(database, token, { version: 1, id: operationId, expected: fence, head: cipherRef(pendingRoot), records: fixtureRecords, intent: cipherRef(intent.record), intentStatus: 'mapped-local' })
  await expect(openAccountWorkspace(database, token, pendingFence.head)).rejects.toThrow('Missing recorded-party')
  return { ...f, pendingFence, pending, intent, operationId }
}

it('migratesOnlyTheExactValidatedLegacySnapshotAndRetainsOriginalScenarioCiphertextAcrossALocalRace', async () => {
  const { token, database, state, modern, scenario, checkpoint, legacyBody, legacy, fence, originalCiphertext, pendingFence, intent, operationId, unmarkedRoot, index, oldRoot } = await frozenRecordedPartyFixture()
  const { openOrMapAccountWorkspace, MappedWorkspaceIntentSchema } = await import('../workspace/account-intents')
  const { openLegacyLocalAccountWorkspace } = await import('../workspace/account-graph')
  const { stageAccountJson, openAccountJson } = await import('../workspace/account-cache')
  const { activateLocalAccountCommit } = await import('./account-database')
  const { inspectWorkspaceClosure } = await import('../workspace/closure')
  const { archiveWorkspaceUnit } = await import('../workspace/pending-content')
  const { readBlob, blobIdentity } = await import('../workspace/blobs')
  // Missing exact original intent context fails without promoting a partial strict view
  const row = (await database.outbox.get(operationId))!
  await database.outbox.delete(operationId)
  await expect(openOrMapAccountWorkspace(database, token, pendingFence)).rejects.toThrow('Original pending source context')
  expect(await database.profileMeta.get('active')).toEqual(pendingFence)
  expect(await database.syncState.count()).toBe(0)
  await database.outbox.put(row)
  const { prepareSourceEvidenceMigration } = await import('../workspace/account-source-migration')
  const pendingSnapshot = await openLegacyLocalAccountWorkspace(database, token, pendingFence.head)
  const migration = await prepareSourceEvidenceMigration(database, token, pendingFence.head, new Map([[pendingFence.head.revisionId, pendingSnapshot], [legacy.head.revisionId, legacy]]), [intent.value])
  const racedFence = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: pendingFence, head: pendingFence.head, records: [] })
  await expect(activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: pendingFence, ...migration })).rejects.toThrow('another tab')
  expect(await database.syncState.count()).toBe(0)
  expect(await database.profileMeta.get('active')).toEqual(racedFence)
  const falselyMarked = await stageAccountJson(database, token, { ...unmarkedRoot, sourceEvidenceVersion: 1, index }, [index, oldRoot.allocations, oldRoot.playthroughBookkeeping!.index])
  await database.encryptedRevisions.put(falselyMarked)
  await expect(openLegacyLocalAccountWorkspace(database, token, cipherRef(falselyMarked))).rejects.toThrow('Missing recorded-party')
  const migrated = await openOrMapAccountWorkspace(database, token, racedFence)
  expect(await openAccountJson(database, token, row.ref, MappedWorkspaceIntentSchema)).toEqual(intent.value)
  expect(await database.outbox.get(operationId)).toEqual(row)
  const migratedPending = migrated.workspace.state.retainedContent[0]
  if (migratedPending.kind !== 'pending-content') throw new Error('Missing migrated pending content')
  expect((await inspectWorkspaceClosure(migrated.workspace.state, migratedPending.target)).refs.has(blobIdentity(checkpoint.ref))).toBe(true)
  expect((await inspectWorkspaceClosure(migrated.workspace.state, migratedPending.base.kind === 'present' ? migratedPending.base.closure : migratedPending.target)).value).toEqual((await legacy.readCaptured(cipherRef(legacyBody))).document.value)
  expect(migrated.workspace.head).not.toEqual(fence.head)
  expect(migrated.workspace.sourceEvidenceVersion).toBe(1)
  expect((await openAccountWorkspace(database, token, fence.head)).entries.find(entry => entry.key === scenario.key)!.ref).toEqual(cipherRef(legacyBody))
  const association = migrated.workspace.entries.find(entry => entry.key === scenario.key)!.sourceBookkeeping!
  expect(association.origin).toBe('legacy-local-migration')
  expect(association.scenarioDependencies).toBe('legacy-s02')
  expect(association.scenario).toEqual(cipherRef(legacyBody))
  expect(association.baselineCheckpoints).toEqual(modern.entries.filter(entry => entry.kind === 'build-checkpoint').map(entry => ({ key: entry.key, ref: entry.ref })))
  expect((await database.stagedCipherChunks.get([legacyBody.payloadId, 0]))!.bytes).toEqual(originalCiphertext)
  const portable = new Map<string, import('../workspace/documents').WorkspaceState['blobs'][number]>()
  const closure = await archiveWorkspaceUnit(migrated.workspace, scenario.key, portable)
  expect((await inspectWorkspaceClosure({ ...state, blobs: [...portable.values()] }, closure)).refs.has(blobIdentity(checkpoint.ref))).toBe(true)
  const attempt = await preparePublicationAttempt(database, token, migrated.workspace, null, new Map(), 0)
  const projected = (await openRemoteProjection(database, token, new Map(attempt.final.heads.map(ref => [ref.documentId, ref.revisionId])), fence.head, 0))!
  expect(await readBlob(projected.workspace.payloads.get(scenario.key)!, 100000)).toEqual(await readBlob(legacy.payloads.get(scenario.key)!, 100000))
  expect((await database.encryptedRevisions.get(legacyBody.revisionId))!.descriptor).toEqual(legacyBody.descriptor)
})

it('projectionReaderReusesExactRefsOnlyInsideOneReadAndKeepsAssociationAndProfileGuards', async () => {
  const { createProjectionReader } = await import('../account/sync/projection-reader')
  const { capturedRecordReader, validateCapturedWorkspaceRecords } = await import('../workspace/account-evidence')
  const { vi } = await import('vitest')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  await seedNativePublicationWorkspace(database, token)
  const local = await openAccountWorkspace(database, token, (await database.profileMeta.get('active'))!.head)
  const entry = local.entries.find(value => value.kind === 'library-defaults')!
  const read = vi.fn(capturedRecordReader(database, token, new Map()))
  const pass = createProjectionReader(token, read)
  const first = await pass.read(entry.ref)
  expect(await pass.read({ ...entry.ref })).toBe(first)
  expect(read).toHaveBeenCalledTimes(1)
  await expect(pass.read({ ...entry.ref, documentId: accountLocalId() })).rejects.toThrow()
  expect(read).toHaveBeenCalledTimes(2)
  await expect(validateCapturedWorkspaceRecords(pass.read, [entry.ref], new Map([[entry.key, accountLocalId()]]), new Map())).rejects.toThrow('Foreign captured workspace allocation')
  expect(read).toHaveBeenCalledTimes(2)
  pass.dispose()
  await expect(pass.read(entry.ref)).rejects.toThrow('LOCAL_INTEGRITY_FAILED')
  const independent = createProjectionReader(token, read)
  expect(await independent.read(entry.ref)).not.toBe(first)
  expect(read).toHaveBeenCalledTimes(3)
  invalidateProfile()
  await expect(independent.read(entry.ref)).rejects.toThrow('PROFILE_CHANGED')
  independent.dispose()
})

it('dLegacyLocalRouteAuthenticatesTheRealFrozenRecordedPartyGraph', async () => {
  const f = await frozenRecordedPartyFixture()
  const { openInactiveAccountWorkspace } = await import('../workspace/account-inactive-graph')
  const { exactAccountTables } = await import('./account-inactive-test-helpers')
  const before = await exactAccountTables(f.database)
  for (const head of [f.fence.head, f.pendingFence.head]) {
    await expect(openInactiveAccountWorkspace(f.database, f.token, head)).rejects.toThrow('Missing recorded-party')
    const opened = await openInactiveAccountWorkspace(f.database, f.token, head, { inputFormat: 'legacy-local-graph' })
    try {
      expect(opened.origin).toBe('legacy-v1-empty')
      expect(opened.workspace.state.planner.localData).toEqual(f.data)
      expect(opened.workspace.entries.find(entry => entry.key === f.scenario.key)!.ref).toEqual(cipherRef(f.legacyBody))
      await opened.check()
      expect((await opened.workspace.readCaptured(cipherRef(f.legacyBody))).document.value).toEqual((await f.legacy.readCaptured(cipherRef(f.legacyBody))).document.value)
      if (head === f.pendingFence.head) expect(opened.workspace.state.retainedContent).toEqual([f.pending])
    } finally { await opened.dispose() }
  }
  expect(await exactAccountTables(f.database)).toEqual(before)
  expect((await f.database.stagedCipherChunks.get([f.legacyBody.payloadId, 0]))!.bytes).toEqual(f.originalCiphertext)
})

it('legacyDOriginalAndPendingRowsSurviveRebindAndModernDerivation', async () => {
  const f = await frozenRecordedPartyFixture()
  const d = await import('../workspace/account-inactive-graph')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { prepareLegacySourceContext, AccountWorkspaceRootV1Schema } = await import('../workspace/account-graph')
  const { openAccountJson } = await import('../workspace/account-cache')
  const { archiveWorkspaceUnit } = await import('../workspace/pending-content')
  const { inspectWorkspaceClosure } = await import('../workspace/closure')
  const { readBlob, blobIdentity } = await import('../workspace/blobs')
  const { exactAccountTables } = await import('./account-inactive-test-helpers')
  const child = createAccountPreparationOwner(f.database, f.token), parent = createAccountPreparationOwner(f.database, f.token)
  const targetOwner = createAccountPreparationOwner(f.database, f.token), finalOwner = createAccountPreparationOwner(f.database, f.token)
  const original = await d.openInactiveAccountWorkspace(f.database, f.token, f.fence.head, { owner: child, inputFormat: 'legacy-local-graph' })
  const rebound = await d.rebindInactiveAccountWorkspace(f.database, f.token, original, parent)
  const pending = await d.openInactiveAccountWorkspace(f.database, f.token, f.pendingFence.head, { inputFormat: 'legacy-local-graph' })
  let target: import('../workspace/account-inactive-graph').PreparedInactiveAccountWorkspace | undefined
  let final: import('../workspace/account-inactive-graph').InactiveAccountWorkspace | undefined
  try {
    const sameRoot = await d.openInactiveAccountWorkspace(f.database, f.token, rebound.head, { sourceAssociation: rebound, inputFormat: 'legacy-local-graph' })
    await sameRoot.check(); await sameRoot.dispose()
    expect((await rebound.workspace.readCaptured(cipherRef(f.legacyBody))).document.value).toEqual((await f.legacy.readCaptured(cipherRef(f.legacyBody))).document.value)
    const source = await prepareLegacySourceContext(f.database, f.token, rebound.workspace)
    const semantic = await prepareLegacySourceContext(f.database, f.token, pending.workspace)
    expect(source.capture).toBeDefined(); expect(semantic.capture).toBeDefined()
    expect(await f.database.syncState.toArray()).toEqual([])
    // This fixture has only one pending unit and both original intent sides select this exact source
    expect(f.intent.value.original).toEqual({ base: rebound.head, target: rebound.head })
    expect(f.intent.value.base).toEqual(rebound.head); expect(f.intent.value.target).toEqual(rebound.head)
    const blobs = new Map<string, import('../workspace/documents').WorkspaceState['blobs'][number]>()
    const closure = await archiveWorkspaceUnit(source.opened, f.scenario.key, blobs)
    const state = { ...semantic.opened.state, blobs: [...blobs.values()], retainedContent: [{ ...f.pending, base: { kind: 'present' as const, closure }, target: closure }] }
    const inspected = await inspectWorkspaceClosure(state, closure)
    expect(inspected.root.ref).toMatchObject(cipherRef(f.legacyBody))
    expect(inspected.refs.has(blobIdentity(f.checkpoint.ref))).toBe(true)
    const baseline = await exactAccountTables(f.database)
    // Runtime inputFormat extras must not send a marked successor back through the legacy route
    const options = { owner: targetOwner, sourceOrigin: pending, semanticBase: semantic.opened, rootFormat: 'preserve' as const, inputFormat: 'legacy-local-graph' }
    target = await d.prepareInactiveAccountWorkspace(f.database, f.token, state, options)
    expect(await f.database.syncState.toArray()).toEqual([])
    expect((await openAccountJson(f.database, f.token, target.head, AccountWorkspaceRootV1Schema, targetOwner)).sourceEvidenceVersion).toBe(1)
    const independent = await d.openInactiveAccountWorkspace(f.database, f.token, target.head, { owner: targetOwner })
    await independent.check(); await independent.dispose()
    final = await d.rebindInactiveAccountWorkspace(f.database, f.token, target.opened, finalOwner)
    await final.check()
    const captured = await final.workspace.readCaptured(cipherRef(f.legacyBody))
    expect(captured.sourceBookkeeping?.origin).toBe('legacy-local-migration')
    expect(await readBlob(captured.source, captured.source.byteLength)).toEqual(await readBlob(f.legacy.payloads.get(f.scenario.key)!, captured.source.byteLength))
    const retained = final.workspace.state.retainedContent[0]
    if (retained.kind !== 'pending-content' || retained.base.kind !== 'present') throw new Error('Missing modern pending sides')
    expect(retained.id).toBe(f.pending.id); expect(retained.groupId).toBe(f.intent.value.portableGroupId)
    for (const side of [retained.base.closure, retained.target]) expect((await inspectWorkspaceClosure(final.workspace.state, side)).value).toEqual(captured.document.value)
    expect((await f.database.stagedCipherChunks.get([f.legacyBody.payloadId, 0]))!.bytes).toEqual(f.originalCiphertext)
    expect(await f.database.encryptedRevisions.get(f.legacyBody.revisionId)).toEqual(f.legacyBody)
    await final.dispose(); await finalOwner.abandon(); await targetOwner.abandon()
    expect(await exactAccountTables(f.database)).toEqual(baseline)
  } finally { await final?.dispose(); await target?.opened.dispose(); await pending.dispose(); await rebound.dispose(); await original.dispose(); await child.abandon(); await parent.abandon(); await targetOwner.abandon(); await finalOwner.abandon() }
})

it('authenticatedSubtreeNeverRelaxesUnmarkedV2OrTruthyLegacyRequests', async () => {
  const f = await frozenScenarioFixture()
  const { authenticateAccountWorkspaceSubtree } = await import('../workspace/account-graph')
  const { createAccountInheritedEvidencePreparation } = await import('../workspace/account-evidence-snapshots')
  const { stageAccountJson } = await import('../workspace/account-cache')
  const { openInactiveAccountWorkspace } = await import('../workspace/account-inactive-graph')
  const { exactAccountTables } = await import('./account-inactive-test-helpers')
  const operation = createAccountInheritedEvidencePreparation(f.database, f.token)
  const evidence = await operation.prepare({})
  await f.database.encryptedRevisions.bulkAdd([...evidence.records])
  try {
    const direct = await authenticateAccountWorkspaceSubtree(f.database, f.token, f.fence.head, { version: 1, legacyLocal: true })
    await direct.dispose()
    for (const legacyLocal of ['true', { value: true }]) {
      const options = { version: 1 as const, legacyLocal } as unknown as Parameters<typeof authenticateAccountWorkspaceSubtree>[3]
      await expect(authenticateAccountWorkspaceSubtree(f.database, f.token, f.fence.head, options)).rejects.toThrow('Missing recorded-party')
    }
    const smuggled = { inputFormat: 'workspace-graph' as const, legacyLocal: true }
    await expect(openInactiveAccountWorkspace(f.database, f.token, f.fence.head, smuggled)).rejects.toThrow('Missing recorded-party')
    for (const marked of [false, true]) {
      const root = { ...f.oldRoot, version: 2, inheritedEvidence: evidence.root, sourceEvidenceVersion: marked ? 1 : undefined }
      const valid = await stageAccountJson(f.database, f.token, root, [root.index, root.allocations, root.playthroughBookkeeping!.index, evidence.root])
      const invalidRoot = { ...root, index: f.index }
      const invalid = await stageAccountJson(f.database, f.token, invalidRoot, [f.index, root.allocations, root.playthroughBookkeeping!.index, evidence.root])
      await f.database.encryptedRevisions.bulkAdd([valid, invalid])
      const before = await exactAccountTables(f.database)
      for (const legacyLocal of [undefined, true] as const) {
        await expect(authenticateAccountWorkspaceSubtree(f.database, f.token, cipherRef(invalid), { version: 2, legacyLocal })).rejects.toThrow('Missing recorded-party')
        const opened = await authenticateAccountWorkspaceSubtree(f.database, f.token, cipherRef(valid), { version: 2, legacyLocal })
        expect(opened.workspace.state.planner.localData).toEqual(f.data)
        expect(opened.workspace.entries.find(entry => entry.key === f.scenario.key)!.sourceBookkeeping).toEqual(f.scenario.sourceBookkeeping)
        await opened.dispose()
      }
      await expect(openInactiveAccountWorkspace(f.database, f.token, cipherRef(valid), { inputFormat: 'legacy-local-graph' })).rejects.toThrow()
      const ordinary = await openInactiveAccountWorkspace(f.database, f.token, cipherRef(valid))
      await ordinary.check(); await ordinary.dispose()
      expect(await exactAccountTables(f.database)).toEqual(before)
    }
  } finally { await evidence.dispose(); await operation.abandon() }
})

it('dLegacyLocalRouteRejectsMarkedV1V2MalformedWrongRefAndFallback', async () => {
  const f = await frozenScenarioFixture()
  const { openInactiveAccountWorkspace } = await import('../workspace/account-inactive-graph')
  const { stageAccountJson } = await import('../workspace/account-cache')
  const { INDEX_PAGE_BYTES } = await import('../workspace/directory')
  const { exactAccountTables } = await import('./account-inactive-test-helpers')
  const roots = [
    { ...f.unmarkedRoot, index: f.index, sourceEvidenceVersion: 1 },
    { ...f.unmarkedRoot, kind: 'malformed-graph' },
    { ...f.unmarkedRoot, lineageId: 'x'.repeat(INDEX_PAGE_BYTES) },
  ]
  for (const root of roots) {
    const record = await stageAccountJson(f.database, f.token, root, [f.index, f.oldRoot.allocations, f.oldRoot.playthroughBookkeeping!.index])
    await f.database.encryptedRevisions.add(record)
    const before = await exactAccountTables(f.database)
    const result = openInactiveAccountWorkspace(f.database, f.token, cipherRef(record), { inputFormat: 'legacy-local-graph' })
    if (root.lineageId.length >= INDEX_PAGE_BYTES) await expect(result).rejects.toThrow('Workspace JSON exceeds format bound')
    else await expect(result).rejects.toThrow()
    await expect(openInactiveAccountWorkspace(f.database, f.token, cipherRef(record), { inputFormat: 'legacy-projection' })).rejects.toThrow()
    expect(await exactAccountTables(f.database)).toEqual(before)
  }
  const before = await exactAccountTables(f.database)
  await expect(openInactiveAccountWorkspace(f.database, f.token, f.modern.head, { inputFormat: 'legacy-local-graph' })).rejects.toThrow()
  const modern = await openInactiveAccountWorkspace(f.database, f.token, f.modern.head)
  await modern.dispose()
  await expect(openInactiveAccountWorkspace(f.database, f.token, { ...f.fence.head, documentId: accountLocalId() }, { inputFormat: 'legacy-local-graph' })).rejects.toThrow()
  for (const inputFormat of ['unknown', true, {}]) await expect(openInactiveAccountWorkspace(f.database, f.token, f.fence.head, { inputFormat } as unknown as Parameters<typeof openInactiveAccountWorkspace>[3])).rejects.toThrow()
  expect(await exactAccountTables(f.database)).toEqual(before)
})

async function legacyAssociationFixture(view: boolean, present: boolean) {
  const f = await frozenScenarioFixture()
  const graph = await import('../workspace/account-graph')
  const d = await import('../workspace/account-inactive-graph')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { stageAccountJson } = await import('../workspace/account-cache')
  const source = await graph.prepareLegacySourceContext(f.database, f.token, f.legacy)
  await f.database.encryptedRevisions.bulkAdd(source.records)
  const modern = await graph.prepareAccountWorkspace(f.database, f.token, f.legacy.state, source.opened)
  await f.database.encryptedRevisions.bulkAdd(modern.records)
  async function write(value: unknown, dependencies: readonly import('./account-database').CipherRef[]) {
    const record = await stageAccountJson(f.database, f.token, value, dependencies)
    await f.database.encryptedRevisions.add(record)
    return cipherRef(record)
  }
  const original = f.fence.head, effective = modern.head
  const viewValue = { version: 1, kind: 'local-source-view', source: original, view: effective }
  const viewRef = await write(viewValue, [original, effective])
  const viewRow = { id: `source-view:${original.revisionId}`, ref: viewRef }
  if (view) await f.database.syncState.add(viewRow)
  const consumed = view ? effective : original
  // Modern view entries already carry evidence, so its authentic optional context has no additions
  const { z } = await import('zod')
  const { CipherRefSchema, openAccountJson } = await import('../workspace/account-cache')
  const contextValue = view ? { version: 1, kind: 'local-source-context', source: consumed, index: await write({ version: 1, entries: [], children: [] }, []) } : await openAccountJson(f.database, f.token, source.capture!.ref, z.object({ version: z.literal(1), kind: z.literal('local-source-context'), source: CipherRefSchema, index: CipherRefSchema }))
  const indexValue = await openAccountJson(f.database, f.token, contextValue.index, z.unknown())
  const contextRef = view ? await write(contextValue, [consumed, contextValue.index]) : source.capture!.ref
  const contextRow = { id: `source-context:${consumed.revisionId}`, ref: contextRef }
  if (present) await f.database.syncState.add(contextRow)
  const owner = createAccountPreparationOwner(f.database, f.token)
  const origin = await d.openInactiveAccountWorkspace(f.database, f.token, original, { owner, inputFormat: 'legacy-local-graph' })
  async function replaceIdentity(ref: import('./account-database').CipherRef, value: unknown, reencrypt: boolean) {
    const record = (await f.database.encryptedRevisions.get(ref.revisionId))!, payloadId = accountLocalId()
    if (reencrypt) {
      const { encryptRevision } = await import('../account/crypto/revisions')
      const { withAccountKey } = await import('../account/profile')
      const bytes = new TextEncoder().encode(JSON.stringify(value))
      const encrypted = await withAccountKey(f.token, key => encryptRevision(key, { format: 1, accountId: f.token.accountId, ...ref, parents: [], dependencies: record.descriptor.dependencies, protected: true, plainBytes: bytes.length }, accountLocalId(), (async function* () { yield bytes })(), { id: payloadId, write: async (index, bytes) => { await f.database.stagedCipherChunks.add({ payloadId, index, bytes }) } }))
      await f.database.encryptedRevisions.put({ revisionId: ref.revisionId, payloadId, descriptor: encrypted.descriptor })
    } else {
      const chunks = await f.database.stagedCipherChunks.where('payloadId').equals(record.payloadId).toArray()
      await f.database.stagedCipherChunks.bulkAdd(chunks.map(chunk => ({ ...chunk, payloadId })))
      await f.database.encryptedRevisions.put({ ...record, payloadId })
    }
    expect(await openAccountJson(f.database, f.token, ref, z.unknown())).toEqual(value)
  }
  async function mutate(change: string) {
    if (change === 'context-appearance') await f.database.syncState.put(contextRow)
    if (change === 'context-removal') await f.database.syncState.delete(contextRow.id)
    if (change === 'context-replacement') await f.database.syncState.put({ ...contextRow, ref: await write(contextValue, [consumed, contextValue.index]) })
    if (change === 'context-payload' || change === 'context-descriptor') await replaceIdentity(contextRef, contextValue, change.endsWith('descriptor'))
    if (change === 'index-payload' || change === 'index-descriptor') await replaceIdentity(contextValue.index, indexValue, change.endsWith('descriptor'))
    if (change === 'view-appearance') await f.database.syncState.put(viewRow)
    if (change === 'view-removal') await f.database.syncState.delete(viewRow.id)
    if (change === 'view-replacement') await f.database.syncState.put({ ...viewRow, ref: await write(viewValue, [original, effective]) })
    if (change === 'view-payload' || change === 'view-descriptor') await replaceIdentity(viewRef, viewValue, change.endsWith('descriptor'))
    if (change === 'fence') await f.database.profileMeta.put({ ...f.fence, headRevision: f.fence.headRevision + 1 })
    if (change === 'unconsumed-original') await f.database.syncState.put(source.capture!)
  }
  return { ...f, graph, d, owner, origin, source, original, effective, consumed, contextRow, viewRow, write, mutate, async close() { await origin.dispose(); await owner.abandon() } }
}

it.each([false, true].flatMap(view => [false, true].map(present => ({ view, present }))))('legacyDOriginalAndEffectiveRowsSurviveRebindAndModernDerivation: view=$view, present=$present', async ({ view, present }) => {
  const f = await legacyAssociationFixture(view, present)
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { exactAccountTables } = await import('./account-inactive-test-helpers')
  const parent = createAccountPreparationOwner(f.database, f.token), targetOwner = createAccountPreparationOwner(f.database, f.token)
  let rebound: import('../workspace/account-inactive-graph').InactiveAccountWorkspace | undefined
  let prepared: import('../workspace/account-inactive-graph').PreparedInactiveAccountWorkspace | undefined
  try {
    const subtree = await f.graph.authenticateAccountWorkspaceSubtree(f.database, f.token, f.original, { version: 1, legacyLocal: true })
    expect(subtree.observations()).toEqual([{ id: f.viewRow.id, row: view ? f.viewRow : undefined }, { id: f.contextRow.id, row: present ? f.contextRow : undefined }])
    expect(subtree.effectiveRoot).toEqual(view ? f.effective : f.original)
    await subtree.dispose()
    if (view) await f.mutate('unconsumed-original')
    const before = await exactAccountTables(f.database)
    rebound = await f.d.rebindInactiveAccountWorkspace(f.database, f.token, f.origin, parent)
    await rebound.check()
    prepared = await f.d.prepareInactiveAccountWorkspace(f.database, f.token, rebound.workspace.state, { owner: targetOwner, sourceOrigin: rebound, semanticBase: view || present ? rebound.workspace : f.source.opened, rootFormat: 'preserve' })
    await prepared.opened.check()
    expect((await prepared.opened.workspace.readCaptured(cipherRef(f.legacyBody))).sourceBookkeeping?.origin).toBe('legacy-local-migration')
    const gate = await f.d.prepareInactiveAccountSourceCheck(rebound)
    await f.database.transaction('rw', f.database.tables, () => gate.recheckInTransaction())
    await prepared.opened.dispose(); await targetOwner.abandon()
    expect(await exactAccountTables(f.database)).toEqual(before)
  } finally { await prepared?.opened.dispose(); await rebound?.dispose(); await parent.abandon(); await targetOwner.abandon(); await f.close() }
})

const legacyRaceCases = [false, true].flatMap(view => ['context-appearance', 'context-removal', 'context-replacement', 'context-payload', 'context-descriptor', 'index-payload', 'index-descriptor', 'fence', ...(view ? ['view-removal', 'view-replacement', 'view-payload', 'view-descriptor'] : ['view-appearance'])].flatMap(change => ['derivation', 'final-open', 'rebind', 'lazy-first', 'lazy-next', 'transaction'].map(phase => ({ view, change, phase }))))
it.each(legacyRaceCases)('legacy D keeps exact consumed sources: view=$view, $change at $phase', async ({ view, change, phase }) => {
  const f = await legacyAssociationFixture(view, change !== 'context-appearance')
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { exactAccountTables } = await import('./account-inactive-test-helpers')
  const parent = createAccountPreparationOwner(f.database, f.token)
  let baseline: Awaited<ReturnType<typeof exactAccountTables>> | undefined
  let mutated = false
  const mutate = async () => { if (!mutated) { mutated = true; await f.mutate(change); baseline = await exactAccountTables(f.database) } }
  try {
    if (phase === 'derivation') {
      await mutate()
      await expect(f.d.prepareInactiveAccountWorkspace(f.database, f.token, f.origin.workspace.state, { owner: parent, sourceOrigin: f.origin, semanticBase: f.source.opened, rootFormat: 'preserve' })).rejects.toThrow()
    } else if (phase === 'final-open') {
      const authenticate = f.graph.authenticateAccountWorkspaceSubtree
      vi.spyOn(f.graph, 'authenticateAccountWorkspaceSubtree').mockImplementation(async (...args) => { const result = await authenticate(...args); if (args[3].owner === parent) await mutate(); return result })
      await expect(f.d.openInactiveAccountWorkspace(f.database, f.token, f.original, { owner: parent, sourceAssociation: f.origin, inputFormat: 'legacy-local-graph' })).rejects.toThrow()
    } else if (phase === 'rebind') {
      const adopt = parent.adopt.bind(parent)
      vi.spyOn(parent, 'adopt').mockImplementation(async owner => { await adopt(owner); await mutate() })
      await expect(f.d.rebindInactiveAccountWorkspace(f.database, f.token, f.origin, parent)).rejects.toThrow()
    } else if (phase.startsWith('lazy')) {
      const source = f.origin.workspace.payloads.get(f.scenario.key)!
      const iterator = source.open()[Symbol.asyncIterator]()
      if (phase === 'lazy-next') expect((await iterator.next()).done).toBe(false)
      await mutate()
      await expect(iterator.next()).rejects.toThrow()
      await expect(f.origin.workspace.readCaptured(cipherRef(f.legacyBody))).rejects.toThrow()
      await iterator.return?.()
    } else {
      const { stageAccountJson } = await import('../workspace/account-cache')
      const gate = await f.d.prepareInactiveAccountSourceCheck(f.origin)
      await mutate()
      const candidate = await stageAccountJson(f.database, f.token, { synthetic: 'candidate-pointer' }, [], undefined, parent)
      const staged = await exactAccountTables(f.database)
      await expect(f.database.transaction('rw', f.database.tables, async () => {
        await f.database.encryptedRevisions.add(candidate)
        await gate.recheckInTransaction()
        await f.database.documentHeads.put(cipherRef(candidate))
        await f.database.syncState.put({ id: 'synthetic-legacy-pointer', ref: cipherRef(candidate) })
      })).rejects.toThrow()
      expect(await exactAccountTables(f.database)).toEqual(staged)
      await parent.abandon()
    }
    expect(mutated).toBe(true)
    expect(await exactAccountTables(f.database)).toEqual(baseline)
  } finally { vi.restoreAllMocks(); await parent.abandon(); await f.close() }
})

it('legacyEffectiveViewRequiresModernEvidenceAndExactEndpointIdentity', async () => {
  const f = await legacyAssociationFixture(true, false)
  const { openAccountJson } = await import('../workspace/account-cache')
  const { exactAccountTables } = await import('./account-inactive-test-helpers')
  try {
    const effective = await openAccountJson(f.database, f.token, f.effective, f.graph.AccountWorkspaceRootV1Schema)
    const values = [
      { ...effective, index: f.index },
      { ...effective, lineageId: accountLocalId() },
      { ...effective, localRevision: effective.localRevision + 1 },
      { ...effective, localUpdatedAt: '1900-01-01' },
      { ...effective, selections: { ...effective.selections, selectedPlaythroughId: 'foreign-playthrough' } },
    ]
    const endpoints = []
    for (const value of values) endpoints.push(await f.write(value, [value.index, value.allocations, value.playthroughBookkeeping!.index]))
    // A separately valid graph with the modern scenario ref cannot replace the frozen scenario frame
    endpoints.push(f.modern.head)
    for (const [index, view] of endpoints.entries()) {
      const wrapper = await f.write({ version: 1, kind: 'local-source-view', source: f.original, view }, [f.original, view])
      await f.database.syncState.put({ ...f.viewRow, ref: wrapper })
      const before = await exactAccountTables(f.database)
      const result = f.d.openInactiveAccountWorkspace(f.database, f.token, f.original, { inputFormat: 'legacy-local-graph' })
      if (index === 0) await expect(result).rejects.toThrow('Missing recorded-party')
      else await expect(result).rejects.toThrow()
      expect(await exactAccountTables(f.database)).toEqual(before)
    }
    for (const source of [{ ...f.original, documentId: accountLocalId() }, f.modern.head]) {
      const wrapper = await f.write({ version: 1, kind: 'local-source-view', source, view: f.effective }, [source, f.effective])
      await f.database.syncState.put({ ...f.viewRow, ref: wrapper })
      const before = await exactAccountTables(f.database)
      await expect(f.d.openInactiveAccountWorkspace(f.database, f.token, f.original, { inputFormat: 'legacy-local-graph' })).rejects.toThrow('Foreign source migration view')
      expect(await exactAccountTables(f.database)).toEqual(before)
    }
    await f.database.syncState.put(f.viewRow)
    const positive = await f.d.openInactiveAccountWorkspace(f.database, f.token, f.original, { inputFormat: 'legacy-local-graph' })
    await positive.check(); await positive.dispose()
  } finally { await f.close() }
})

it.each(['after-staging', 'after-return'] as const)('modern legacy derivation keeps original D authority %s', async phase => {
  const f = await legacyAssociationFixture(false, false)
  const { createAccountPreparationOwner } = await import('../workspace/account-prepared-records')
  const { exactAccountTables } = await import('./account-inactive-test-helpers')
  const owner = createAccountPreparationOwner(f.database, f.token)
  let target: import('../workspace/account-inactive-graph').PreparedInactiveAccountWorkspace | undefined
  const before = await exactAccountTables(f.database)
  try {
    if (phase === 'after-staging') {
      const authenticate = f.graph.authenticateAccountWorkspaceSubtree
      vi.spyOn(f.graph, 'authenticateAccountWorkspaceSubtree').mockImplementation(async (...args) => {
        const result = await authenticate(...args)
        if (args[3].owner === owner) await f.mutate('context-appearance')
        return result
      })
    }
    const preparing = f.d.prepareInactiveAccountWorkspace(f.database, f.token, f.origin.workspace.state, { owner, sourceOrigin: f.origin, semanticBase: f.source.opened, rootFormat: 'preserve' })
    if (phase === 'after-staging') await expect(preparing).rejects.toThrow()
    else {
      target = await preparing
      await f.mutate('context-appearance')
      await expect(target.opened.check()).rejects.toThrow()
      await expect(target.opened.workspace.readCaptured(cipherRef(f.legacyBody))).rejects.toThrow()
      const independent = await f.d.openInactiveAccountWorkspace(f.database, f.token, target.head, { owner })
      await independent.check(); await independent.dispose()
      await target.opened.dispose(); await owner.abandon()
    }
    expect(await exactAccountTables(f.database)).toEqual({ ...before, syncState: [f.contextRow] })
  } finally { vi.restoreAllMocks(); await target?.opened.dispose(); await owner.abandon(); await f.close() }
})
