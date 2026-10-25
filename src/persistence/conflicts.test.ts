import 'fake-indexeddb/auto'
import { appendFileSync } from 'node:fs'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { vi } from 'vitest'
import { createServiceFixture, type ServiceFixture } from '../../worker/testing/service-fixture'
import * as opaque from '../account/crypto/opaque'
import type { UnlockResult } from '../account/auth-client'
import { openAccountRepository } from '../workspace/account-repository'
import { prepareManagedSync, seedManagedWorkspace, openManagedNativeWorkspace } from './managed-sync.test-helpers'
import { registerSyncProjectionGuard, runSyncIteration } from '../account/sync/outbox'
import { SyncError } from '../account/sync/client'
import { afterEach, expect, it } from 'vitest'
import { AccountDatabase } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId } from '../workspace/account-cache'
import { prepareAccountWorkspace } from '../workspace/account-graph'
import { createWorkspaceConflict } from '../workspace/conflicts'
import { inspectWorkspaceClosure, validateWorkspaceClosure } from '../workspace/closure'
import { editorClosureFixture } from '../workspace/test-helpers'
import { blobIdentity, readBlob } from '../workspace/blobs'
import type { WorkspaceState } from '../workspace/documents'
let database: AccountDatabase | undefined
afterEach(async () => { invalidateProfile(); await database?.delete() })
it('invalidEditorDraftsKeepBothCompleteClosuresAndExactBytes', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const fixture = await editorClosureFixture()
  const state: WorkspaceState = { ...fixture.state, editorDocuments: [fixture.file], retainedContent: [], blobs: fixture.blobs.filter(blob => blob.ref.encoding === 'utf16le') }
  const base = await prepareAccountWorkspace(database, token, state)
  await database.encryptedRevisions.bulkAdd(base.records)
  const local = await prepareAccountWorkspace(database, token, { ...state, editorDocuments: [{ ...fixture.file, revision: 1, filename: 'this-invalid.json' }] }, base.opened)
  await database.encryptedRevisions.bulkAdd(local.records)
  const remote = await prepareAccountWorkspace(database, token, { ...state, editorDocuments: [{ ...fixture.file, revision: 1, filename: 'other-invalid.json', unfinished: { ...fixture.file.unfinished, editedPath: ['other'] } }] }, base.opened)
  await database.encryptedRevisions.bulkAdd(remote.records)
  const result = await createWorkspaceConflict({ base: base.opened, local: local.opened, remote: remote.opened, privateKey: '["editor","editor-1"]' })
  expect(result.conflict.branches).toHaveLength(2)
  expect(result.conflict.branches.map(branch => branch.role)).toEqual(['local-pending', 'accepted-cloud'])
  expect(result.conflict.commonAncestor.kind).toBe('present')
  const retained = { ...remote.opened.state, conflicts: [result.conflict], blobs: result.blobs }
  await validateWorkspaceClosure(retained)
  for (const [index, branch] of result.conflict.branches.entries()) {
    const inspected = await inspectWorkspaceClosure(retained, branch.closure)
    expect(inspected.value).toEqual(index === 0 ? local.opened.state.editorDocuments[0] : remote.opened.state.editorDocuments[0])
    const ref = fixture.file.unfinished.text
    expect(await readBlob(retained.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(ref))!.content, ref.byteLength)).toEqual(new Uint8Array([0x00, 0xd8]))
  }
  await expect(createWorkspaceConflict({ base: { ...base.opened, entries: base.opened.entries.filter(entry => entry.kind !== 'editor') }, local: local.opened, remote: remote.opened, privateKey: '["editor","editor-1"]' })).rejects.toThrow()
})

it('sameBuildAndEditDeleteKeepBothClosures', async () => {
  const { addTestBuild, createTestLocalData, TEST_GAME_SETUP_REVISION_ID } = await import('../domain/test-helpers')
  const { saveBuildRevision } = await import('../domain/builds')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const fixture = await editorClosureFixture()
  const localData = addTestBuild(createTestLocalData(), 'build', 'Build', {})
  const state = { ...fixture.state, retainedContent: [], blobs: [], planner: { ...fixture.state.planner, localData, lineage: { rootLocalDataId: localData.id } } }
  const base = await prepareAccountWorkspace(database, token, state)
  await database.encryptedRevisions.bulkAdd(base.records)
  const branch = async (notes: string) => {
    const next = saveBuildRevision(localData, { buildId: localData.builds.build.id, id: 'same-checkpoint' as import('../domain/types').BuildRevisionId, gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID, content: { ...localData.buildRevisions[localData.builds.build.latestRevisionId!].content, rotationNotes: notes } })
    const prepared = await prepareAccountWorkspace(database!, token, { ...state, planner: { ...state.planner, localData: next } }, base.opened)
    await database!.encryptedRevisions.bulkAdd(prepared.records)
    return prepared.opened
  }
  const local = await branch('Pending notes'), remote = await branch('Accepted notes')
  const result = await createWorkspaceConflict({ base: base.opened, local, remote, privateKey: '["build","build"]' })
  const retained = { ...remote.state, conflicts: [result.conflict], blobs: result.blobs }
  await validateWorkspaceClosure(retained)
  for (const [index, branch] of result.conflict.branches.entries()) {
    const inspected = await inspectWorkspaceClosure(retained, branch.closure)
    expect(inspected.value).toEqual((index === 0 ? local : remote).state.planner.localData.builds.build)
    const entry = (index === 0 ? local : remote).entries.find(entry => entry.key === '["build-checkpoint","same-checkpoint"]')!
    const blob = retained.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(entry.ref))!
    const bytes = await readBlob(blob.content, blob.ref.byteLength)
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual((index === 0 ? local : remote).state.planner.localData.buildRevisions['same-checkpoint'])
  }
  const { stagePublicationRecord } = await import('../account/sync/publication')
  const { readOriginalPublication } = await import('../account/sync/conflict-authority')
  const { cipherRef } = await import('../workspace/account-cache')
  const { selectCapturedBranch } = await import('../account/sync/branch-selection')
  const selected = await stagePublicationRecord(database, token, local.entries.find(entry => entry.kind === 'build')!, accountLocalId())
  const selectedEvidence = await readOriginalPublication(database, token, cipherRef(selected))
  const { captureOriginalUnit } = await import('../account/sync/captured-unit')
  const archiveSource = await captureOriginalUnit(remote, selectedEvidence)
  await expect(captureOriginalUnit(remote, { ...selectedEvidence, digest: '0'.repeat(64) })).rejects.toThrow('INTEGRITY_FAILED')
  expect(archiveSource.allocations.find(entry => entry.key === '["build-checkpoint","same-checkpoint"]')!.documentId).toBe(local.entries.find(entry => entry.key === '["build-checkpoint","same-checkpoint"]')!.ref.documentId)
  const { archiveWorkspaceUnit } = await import('../workspace/pending-content')
  const refreshedBlobs = new Map(retained.blobs.map(blob => [blobIdentity(blob.ref), blob]))
  const refreshedArchive = await archiveWorkspaceUnit(archiveSource, selectedEvidence.privateKey, refreshedBlobs, selectedEvidence)
  const refreshedInspection = await inspectWorkspaceClosure({ ...retained, blobs: [...refreshedBlobs.values()] }, refreshedArchive)
  expect(refreshedInspection.documents.get('["build-checkpoint","same-checkpoint"]')!.value).toEqual(local.state.planner.localData.buildRevisions['same-checkpoint'])
  const chosen = await selectCapturedBranch(remote, local, selectedEvidence)
  expect(chosen.state.planner.localData.buildRevisions).toEqual(local.state.planner.localData.buildRevisions)
  expect(chosen.state.planner.localData.buildRevisions['same-checkpoint'].revision).toBe(2)
  expect(chosen.entries.find(entry => entry.key === '["build-checkpoint","same-checkpoint"]')!.ref).toEqual(local.entries.find(entry => entry.key === '["build-checkpoint","same-checkpoint"]')!.ref)
  const { prepareBuildConfigurationCopy } = await import('../account/sync/build-copy')
  const keptEnvelope = await stagePublicationRecord(database, token, remote.entries.find(entry => entry.kind === 'build')!, selectedEvidence.lineageId)
  const keptEvidence = await readOriginalPublication(database, token, cipherRef(keptEnvelope))
  const copied = await prepareBuildConfigurationCopy(database, token, { ...remote, state: retained }, local, selectedEvidence, keptEvidence, result.conflict)
  expect(Object.keys(copied.workspace.state.planner.localData.builds)).toHaveLength(2)
  const copyBuild = Object.values(copied.workspace.state.planner.localData.builds).find(build => build.id !== 'build')!
  expect(copied.workspace.state.planner.localData.buildRevisions[copyBuild.latestRevisionId!]).toMatchObject({ revision: 1, content: { rotationNotes: 'Pending notes' } })
  expect(copied.workspace.state.planner.localData.buildRevisions[copyBuild.latestRevisionId!].parentRevisionId).toBeUndefined()
  expect(copied.workspace.state.planner.localData.buildRevisions['same-checkpoint']).toEqual(remote.state.planner.localData.buildRevisions['same-checkpoint'])
  const copiedState = { ...copied.workspace.state, conflicts: [{ ...result.conflict, disposition: { kind: 'resolved' as const, choice: 'both' as const, result: copied.result } }] }
  await validateWorkspaceClosure(copiedState)
  const independentlyInspected = await inspectWorkspaceClosure(copiedState, copied.result)
  expect(independentlyInspected.buildCopy?.copy.id).toBe(copyBuild.id)
  expect(independentlyInspected.buildCopy?.sourceCheckpoint.content.rotationNotes).toBe('Pending notes')
  const { validateBuildCopy, assertBuildCopyOriginals } = await import('../workspace/build-copy')
  const evidence = independentlyInspected.buildCopy!
  const keptClosed = await inspectWorkspaceClosure(copiedState, evidence.relation.kept)
  const copyClosed = await inspectWorkspaceClosure(copiedState, evidence.relation.copy)
  const sourceClosed = await inspectWorkspaceClosure(copiedState, evidence.relation.source)
  expect(() => validateBuildCopy(evidence.relation, keptClosed, copyClosed, keptClosed)).toThrow('native configuration clone')
  expect(() => validateBuildCopy(evidence.relation, keptClosed, keptClosed, sourceClosed)).toThrow('identities mismatch')
  expect(() => assertBuildCopyOriginals(evidence, result.conflict.branches[1].closure, result.conflict.branches[0].closure)).toThrow('frozen original')
  expect(local.state.planner.localData.buildRevisions['same-checkpoint'].content.rotationNotes).toBe('Pending notes')
  expect(remote.state.planner.localData.buildRevisions['same-checkpoint'].content.rotationNotes).toBe('Accepted notes')

  const deleted = await prepareAccountWorkspace(database, token, { ...state, planner: { ...state.planner, localData: { ...localData, builds: {}, buildRevisions: {} } } }, base.opened)
  await database.encryptedRevisions.bulkAdd(deleted.records)
  const editDelete = await createWorkspaceConflict({ base: base.opened, local, remote: deleted.opened, privateKey: '["build","build"]' })
  expect((await inspectWorkspaceClosure({ ...deleted.opened.state, blobs: editDelete.blobs }, editDelete.conflict.branches[1].closure)).root.kind).toBe('tombstone')
})

it('binarySavesRetainBothWholeFilesWithoutReinterpretingUnsupportedBytes', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const fixture = await editorClosureFixture()
  const original = await fixture.add(new Uint8Array([0, 255, 128, 0, 17]), 'save-original', 'bytes')
  const pending = await fixture.add(new Uint8Array([0, 255, 128, 3, 17]), 'save-pending', 'bytes')
  const accepted = await fixture.add(new Uint8Array([0, 255, 128, 9, 17]), 'save-accepted', 'bytes')
  const file: import('../workspace/documents').SaveWorkspaceDocument = { version: 1, id: 'save', revision: 0, filename: 'synthetic.sav', original, working: original, pendingForm: { unresolvedField: 'preserve' }, requirements: [], coverage: { status: 'unsupported', diagnostics: ['Synthetic unsupported codec'] }, createdAt: '2026-01-01', updatedAt: '2026-01-01', exportedRevision: null }
  const state: WorkspaceState = { ...fixture.state, retainedContent: [], blobs: fixture.blobs.filter(blob => blob.ref.encoding === 'bytes'), saveDocuments: [file] }
  const base = await prepareAccountWorkspace(database, token, state); await database.encryptedRevisions.bulkAdd(base.records)
  const local = await prepareAccountWorkspace(database, token, { ...state, saveDocuments: [{ ...file, revision: 1, working: pending, pendingForm: { unresolvedField: 'pending' } }] }, base.opened); await database.encryptedRevisions.bulkAdd(local.records)
  const remote = await prepareAccountWorkspace(database, token, { ...state, saveDocuments: [{ ...file, revision: 1, working: accepted }] }, base.opened); await database.encryptedRevisions.bulkAdd(remote.records)
  const captured = await createWorkspaceConflict({ base: base.opened, local: local.opened, remote: remote.opened, privateKey: '["save","save"]' })
  const retained = { ...remote.opened.state, conflicts: [captured.conflict], blobs: captured.blobs }
  await validateWorkspaceClosure(retained)
  for (const [index, branch] of captured.conflict.branches.entries()) {
    const value = (await inspectWorkspaceClosure(retained, branch.closure)).value as typeof file
    expect(value).toEqual((index === 0 ? local : remote).opened.state.saveDocuments[0])
    expect(value.coverage.status).toBe('unsupported')
    expect(await readBlob(retained.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(value.working))!.content, value.working.byteLength)).toEqual(new Uint8Array([0, 255, 128, index === 0 ? 3 : 9, 17]))
    expect(value.original).toEqual(original)
  }
})

it('portablePublicationAssociationRejectsWrongBodyKeyDigestAndDocument', async () => {
  const { archiveWorkspaceUnit } = await import('../workspace/pending-content')
  const { stagePublicationRecord } = await import('../account/sync/publication')
  const { cipherRef } = await import('../workspace/account-cache')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const fixture = await editorClosureFixture()
  const state: WorkspaceState = { ...fixture.state, editorDocuments: [fixture.file], retainedContent: [], blobs: fixture.blobs.filter(blob => blob.ref.encoding === 'utf16le') }
  const base = await prepareAccountWorkspace(database, token, state)
  await database.encryptedRevisions.bulkAdd(base.records)
  const entry = base.entries.find(entry => entry.kind === 'editor')!, lineageId = accountLocalId()
  const envelope = await stagePublicationRecord(database, token, entry, lineageId)
  const evidence = { version: 1 as const, ref: cipherRef(envelope), lineageId, body: entry.ref, valueKind: entry.kind, privateKey: entry.key, digest: entry.digest, parents: [...envelope.descriptor.parents] }
  const blobs = new Map(state.blobs.map(blob => [blobIdentity(blob.ref), blob]))
  const closure = await archiveWorkspaceUnit(base.opened, entry.key, blobs, evidence)
  const closed = { ...state, blobs: [...blobs.values()] }
  expect((await inspectWorkspaceClosure(closed, closure)).publication).toEqual(evidence)
  for (const wrong of [{ ...evidence, digest: '0'.repeat(64) }, { ...evidence, privateKey: '["editor","foreign"]' }, { ...evidence, body: { ...entry.ref, revisionId: accountLocalId() } }, { ...evidence, ref: { ...evidence.ref, documentId: accountLocalId() } }]) {
    await expect(archiveWorkspaceUnit(base.opened, entry.key, new Map(), wrong)).rejects.toThrow()
  }
})


// This journey includes OPAQUE signup and sequential encrypted publication, pull, stale refresh and resolution phases
const CONFLICT_JOURNEY_BUDGET_MS = 150_000
const TRAFFIC_WINDOW_MS = 60_000
it.each(['editor', 'stale', 'build', 'build-stale', 'stale-before-save'] as const)('actualRecordConflictRetainsArchivedLoserOnThirdDeviceAndUnrelatedProgress %s', async scenario => {
  const stale = scenario.includes('stale'), build = scenario.includes('build'), staleBeforeSave = scenario === 'stale-before-save'
  const timing = (value: unknown) => {
    const line = JSON.stringify(value)
    console.info(line)
    if (process.env.CRYKIT_SYNC_PROOF_TIMINGS) appendFileSync(process.env.CRYKIT_SYNC_PROOF_TIMINGS, `${line}\n`)
  }
  let phaseStart = performance.now()
  const phase = (name: string) => { const at = performance.now(); timing({ journey: scenario, phase: name, elapsedMs: Math.round(at - phaseStart) }); phaseStart = at }
  const fixture = await createServiceFixture({ now: 1_800_000_000_000 }), session = await customer(fixture, 'conflicts')
  phase('service-and-opaque-session')
  const key = crypto.getRandomValues(new Uint8Array(32)), oldFactory = Dexie.dependencies.indexedDB
  const factories = [new IDBFactory(), new IDBFactory(), new IDBFactory()], databases: AccountDatabase[] = []
  const commits: import('../account/protocol').CommitRequest[] = []
  let loseFinalResponse = false, droppedMutation: string | undefined, committedBeforeResponseLoss = 0
  const reconciled = new Set<string>()
  const continuationCounters = new Map<string, { workId: string; processed: number }>()
  const transfers = { changes: 0, descriptors: 0, chunks: 0, commits: 0, unavailable: 0, sequence: 0 }
  const requestTimes: number[] = []
  let windowStart = 0, peakRequestsPerMinute = 0
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const started = performance.now()
    requestTimes.push(started)
    while (requestTimes[windowStart] <= started - TRAFFIC_WINDOW_MS) windowStart++
    peakRequestsPerMinute = Math.max(peakRequestsPerMinute, requestTimes.length - windowStart)
    if (path.endsWith('/commits')) { commits.push(JSON.parse(init.body as string)); transfers.commits++ }
    if (path.includes('/revisions/')) { if (path.includes('/chunks/')) transfers.chunks++; else transfers.descriptors++ }
    const headers = new Headers(init.headers); headers.set('cookie', session.headers.cookie); headers.set('origin', 'http://127.0.0.1')
    const response = await fixture.request(path, { ...init, headers })
    if (response.status === 429) timing({ journey: scenario, phase: 'admission-rejection', requests: requestTimes.length, peakRequestsPerMinute, stages: (await fixture.events()).filter(value => value.operation === 'admission' && value.code === 'RATE_LIMITED').map(value => value.stage) })
    if (response.status === 503) transfers.unavailable++
    if (path.endsWith('/commits') && JSON.parse(init.body as string).heads.length) {
      const input = JSON.parse(init.body as string)
      const progress = await fixture.db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(done),0) AS done FROM publication_pins WHERE account_id = ? AND mutation_id = ?').bind(session.accountId, input.mutationId).first()
      let continuation: unknown
      if (response.status === 503) {
        const evidence = (await response.clone().json() as { error: { continuation: { workId: string; processed: number } } }).error.continuation
        expect(evidence).toBeDefined()
        const previous = continuationCounters.get(input.mutationId)
        if (previous) { expect(evidence.workId).toBe(previous.workId); expect(evidence.processed).toBeGreaterThan(previous.processed) }
        continuationCounters.set(input.mutationId, evidence)
        continuation = { processed: evidence.processed, sameIncarnation: !previous || evidence.workId === previous.workId }
      }
      timing({ journey: scenario, phase: 'final-closure-validation', continuation, command: commits.findIndex(value => value.mutationId === input.mutationId), status: response.status, ...progress })
    }
    if (path.includes('/changes') && response.ok) {
      transfers.changes++
      const page = await response.clone().json() as { watermark: number; groups: { sequence: number }[] }
      transfers.sequence = Math.max(transfers.sequence, page.watermark ?? 0, ...(page.groups ?? []).map(value => value.sequence))
    }
    if (droppedMutation && path.endsWith(`/mutations/${droppedMutation}`) && response.ok) reconciled.add(droppedMutation)
    if (loseFinalResponse && path.endsWith('/commits') && response.ok && JSON.parse(init.body as string).heads.length) { loseFinalResponse = false; droppedMutation = JSON.parse(init.body as string).mutationId; committedBeforeResponseLoss = commits.filter(command => command.mutationId === droppedMutation).length; throw new TypeError('Synthetic lost final response') }
    return response
  })
  async function device(index: number, initial?: WorkspaceState) {
    invalidateProfile(); Dexie.dependencies.indexedDB = factories[index]
    const token = installProfile(session.accountId, key.slice(), session), db = new AccountDatabase(token.accountId); databases.push(db)
    if (initial && !await db.profileMeta.get('active')) {
      await seedManagedWorkspace(db, token, initial)
    }
    const repo = await openAccountRepository(token)
    registerSyncProjectionGuard(token, () => true)
    async function settle() {
      const started = performance.now(), before = { ...transfers }
      for (let turn = 0; turn < 240; turn++) {
        const iteration = performance.now()
        try {
          await prepareManagedSync(db, token)
          const result = await runSyncIteration(token, new AbortController().signal)
          if (!result.moreWork || performance.now() - iteration > 1000) timing({ journey: scenario, device: index, turn, state: result.state, moreWork: result.moreWork, iterationMs: Math.round(performance.now() - iteration), elapsedMs: Math.round(performance.now() - started), transfers: Object.fromEntries(Object.entries(transfers).map(([key, value]) => [key, value - before[key as keyof typeof before]])) })
          if (!result.moreWork) return result
        } catch (error) { if (!(error instanceof SyncError && error.code === 'SERVICE_UNAVAILABLE') && !(error instanceof TypeError && error.message === 'Synthetic lost final response')) throw error }
      }
      throw new Error('Conflict sync failed to settle')
    }
    return { token, db, repo, settle, open: () => openAccountRepository(token), native: () => openManagedNativeWorkspace(db, token) }
  }
  try {
    const editor = await editorClosureFixture()
    let initial: WorkspaceState = { ...editor.state, editorDocuments: [editor.file], retainedContent: [], blobs: editor.blobs.filter(blob => blob.ref.encoding === 'utf16le') }
    const { addTestBuild, createTestLocalData, TEST_GAME_SETUP_REVISION_ID } = await import('../domain/test-helpers')
    const { saveBuildRevision } = await import('../domain/builds')
    if (build) {
      const localData = addTestBuild(createTestLocalData(), 'build', 'Compared Build', {})
      initial = { ...initial, planner: { ...initial.planner, localData, lineage: { rootLocalDataId: localData.id } } }
    }
    const editBuild = (state: WorkspaceState, notes: string, checkpointId = 'same-checkpoint') => ({ ...state, planner: { ...state.planner, localData: saveBuildRevision(state.planner.localData, { buildId: 'build' as import('../domain/types').BuildId, id: checkpointId as import('../domain/types').BuildRevisionId, gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID, content: { ...state.planner.localData.buildRevisions[state.planner.localData.builds.build.latestRevisionId!].content, rotationNotes: notes } }) } })
    let a = await device(0, initial); expect((await a.settle()).state).toBe('synced')
    let b = await device(1); expect((await b.settle()).state).toBe('synced'); phase('initial-publication-and-second-device')
    const b0 = await (await b.open()).readWorkspace()
    const { directoryShard } = await import('../workspace/directory')
    const sameShard = await directoryShard(JSON.stringify(['editor', 'editor-1']))
    let independentId = 'unrelated-editor', suffix = 0
    while (await directoryShard(JSON.stringify(['editor', independentId])) !== sameShard) independentId = `unrelated-editor-${++suffix}`
    expect(await directoryShard(JSON.stringify(['editor', independentId]))).toBe(sameShard)
    await (await b.open()).commitWorkspace({ ...(build ? editBuild(b0, 'Pending local build') : b0), editorDocuments: [{ ...b0.editorDocuments[0], ...(build ? {} : { revision: 1, filename: 'Pending local.json' }) }, { ...b0.editorDocuments[0], id: independentId, filename: 'Independent progress.json' }] }, b0.planner.localData.revision)
    a = await device(0)
    const a0 = await (await a.open()).readWorkspace()
    await (await a.open()).commitWorkspace(build ? editBuild(a0, 'Accepted other build') : { ...a0, editorDocuments: [{ ...a0.editorDocuments[0], revision: 1, filename: 'Accepted other.json' }] }, a0.planner.localData.revision)
    expect((await a.settle()).state).toBe('synced')
    b = await device(1); expect((await b.settle()).state).toBe('conflict')
    const retained = await (await b.open()).readWorkspace()
    expect(retained.conflicts).toHaveLength(1)
    let conflict = retained.conflicts[0]
    expect(conflict.branches).toHaveLength(2)
    let third = await device(2); expect((await third.settle()).state).toBe('conflict')
    const inspected = await (await third.open()).readWorkspace(); phase('conflict-publication-and-third-device')
    expect(inspected.conflicts).toEqual(retained.conflicts)
    expect(inspected.editorDocuments.some(file => file.id === independentId && file.filename === 'Independent progress.json')).toBe(true)
    const names = []
    for (const branch of inspected.conflicts[0].branches) names.push((await inspectWorkspaceClosure(inspected, branch.closure)).value)
    expect(names).toMatchObject(build ? [{ id: 'build', latestRevisionId: 'same-checkpoint' }, { id: 'build', latestRevisionId: 'same-checkpoint' }] : [{ filename: 'Pending local.json' }, { filename: 'Accepted other.json' }])
    expect(commits.some(command => command.heads.length === 0 && command.revisions.length > 0)).toBe(true)
    const { resolveConflict } = await import('../workspace/conflicts')
    const { readRemoteState, readRemoteHeads } = await import('../account/sync/pull')
    const { openRemoteProjection } = await import('../account/sync/projection')
    const snapshot = (await readRemoteState(third.db, third.token))!.value
    let projection = (await openRemoteProjection(third.db, third.token, await readRemoteHeads(third.db, third.token, snapshot.heads), (await third.native()).head, inspected.planner.localData.revision))!
    let authority = projection.units.get(JSON.stringify(['conflict', conflict.id]))!.conflictAuthority!
    const { validateConflictAuthority } = await import('../account/sync/conflict-authority')
    await expect(validateConflictAuthority(third.db, third.token, inspected, { ...conflict, branches: [{ role: 'local-pending', closure: conflict.branches[1].closure }, { role: 'accepted-cloud', closure: conflict.branches[0].closure }] }, authority)).rejects.toThrow('INTEGRITY_FAILED')
    const loser = authority.branches[0].publication.ref
    expect(commits.some(command => command.heads.length === 0 && command.revisions.some(revision => revision.documentId === loser.documentId && revision.revisionId === loser.revisionId))).toBe(true)
    expect(commits.some(command => command.heads.some(head => head.revisionId === loser.revisionId))).toBe(false)
    const { assertUnchangedPublicationContinuation } = await import('../account/sync/conflict-authority')
    await expect(assertUnchangedPublicationContinuation(third.db, third.token, projection.units.get(conflict.unit.privateKey)!.ref, authority.branches[1].publication.ref)).resolves.toBeUndefined()
    const originals = await Promise.all(conflict.branches.map(async branch => {
      const unit = await inspectWorkspaceClosure(inspected, branch.closure)
      return Promise.all(inspected.blobs.filter(blob => unit.refs.has(blobIdentity(blob.ref))).map(async blob => ({ ref: blob.ref, bytes: await readBlob(blob.content, blob.ref.byteLength) })))
    }))
    if (build) loseFinalResponse = true
    if (!staleBeforeSave) await resolveConflict(third.token, conflict.id, build ? 'both' : 'this', inspected.planner.localData.revision)
    const savedChoice = await (await third.open()).readWorkspace()
    let savedBuildIds = Object.keys(savedChoice.planner.localData.builds).sort()
    if (stale) {
      const frozen = structuredClone(conflict)
      a = await device(0); expect((await a.settle()).state).toBe('conflict')
      const current = await (await a.open()).readWorkspace()
      await (await a.open()).commitWorkspace(build ? editBuild(current, 'New accepted build', 'later-checkpoint') : { ...current, editorDocuments: current.editorDocuments.map(file => file.id === 'editor-1' ? { ...file, revision: file.revision + 1, filename: 'New accepted work.json' } : file) }, current.planner.localData.revision)
      expect((await a.settle()).state).toBe('conflict'); phase('new-accepted-work')
      if (staleBeforeSave) {
        third = await device(2); expect((await third.settle()).state).toBe('conflict')
        const beforeChoice = await (await third.open()).readWorkspace()
        await expect(resolveConflict(third.token, frozen.id, 'this', beforeChoice.planner.localData.revision)).rejects.toThrow('STALE_CONFLICT_CHOICE')
        expect((await (await third.open()).readWorkspace()).conflicts).toEqual(beforeChoice.conflicts)
        expect(await third.db.outbox.count()).toBe(1)
      }
      loseFinalResponse = true
      third = await device(2); expect((await third.settle()).state).toBe('conflict')
      const refreshed = await (await third.open()).readWorkspace(); phase('stale-choice-successor-publication')
      expect(refreshed.conflicts).toHaveLength(2)
      expect(refreshed.conflicts.find(value => value.id === frozen.id)).toEqual(frozen)
      conflict = refreshed.conflicts.find(value => value.id !== frozen.id)!
      const currentRemote = (await readRemoteState(third.db, third.token))!.value
      projection = (await openRemoteProjection(third.db, third.token, await readRemoteHeads(third.db, third.token, currentRemote.heads), (await third.native()).head, refreshed.planner.localData.revision))!
      authority = projection.units.get(JSON.stringify(['conflict', conflict.id]))!.conflictAuthority!
      expect(authority.supersedes?.id).toBe(frozen.id)
      expect(droppedMutation).toBeDefined()
      expect(reconciled.has(droppedMutation!)).toBe(true)
      expect(commits.filter(command => command.mutationId === droppedMutation)).toHaveLength(committedBeforeResponseLoss)
      await expect(validateWorkspaceClosure({ ...refreshed, conflicts: [conflict] })).rejects.toThrow('Missing or contradictory conflict predecessor')
      b = await device(1); expect((await b.settle()).state).toBe('conflict'); phase('independent-successor-pull')
      const independent = await (await b.open()).readWorkspace()
      expect(independent.conflicts.find(value => value.id === frozen.id)).toEqual(frozen)
      const { publishedSupersededConflicts } = await import('../account/sync/conflict-status')
      expect([...(await publishedSupersededConflicts(b.token, independent))]).toEqual([frozen.id])
      expect([...(await publishedSupersededConflicts(b.token, { ...independent, conflicts: independent.conflicts.filter(value => value.id !== conflict.id) }))]).toEqual([])
      expect([...(await publishedSupersededConflicts(b.token, { ...independent, conflicts: independent.conflicts.map(value => value.id === conflict.id ? { ...value, branches: frozen.branches } : value) }))]).toEqual([])
      for (const comparison of independent.conflicts) for (const branch of comparison.branches) await inspectWorkspaceClosure(independent, branch.closure)
      phase('independent-successor-inspection')
      third = await device(2)

      await resolveConflict(third.token, conflict.id, build ? 'both' : 'this', refreshed.planner.localData.revision)
      savedBuildIds = Object.keys((await (await third.open()).readWorkspace()).planner.localData.builds).sort()
    }
    expect((await third.settle()).state).toBe('synced')
    const resolved = await (await third.open()).readWorkspace(); phase('explicit-resolution-publication')
    if (build) {
      expect(Object.values(resolved.planner.localData.builds)).toHaveLength(2)
      expect(Object.keys(resolved.planner.localData.builds).sort()).toEqual(savedBuildIds)
      expect(resolved.planner.localData.buildRevisions[resolved.planner.localData.builds.build.latestRevisionId!].content.rotationNotes).toBe(stale ? 'New accepted build' : 'Accepted other build')
      const copied = Object.values(resolved.planner.localData.builds).find(value => value.id !== 'build')!
      expect(resolved.planner.localData.buildRevisions[copied.latestRevisionId!]).toMatchObject({ revision: 1, content: { rotationNotes: 'Pending local build' } })
      expect(reconciled.has(droppedMutation!)).toBe(true)
      expect(commits.filter(command => command.mutationId === droppedMutation)).toHaveLength(committedBeforeResponseLoss)
      const disposition = resolved.conflicts.find(value => value.id === conflict.id)!.disposition
      expect(disposition.kind).toBe('resolved')
      if (disposition.kind === 'resolved') expect((await inspectWorkspaceClosure(resolved, disposition.result)).buildCopy?.copy.id).toBe(copied.id)
    } else expect(resolved.editorDocuments.find(file => file.id === 'editor-1')!.filename).toBe('Pending local.json')
    expect(resolved.conflicts.find(value => value.id === conflict.id)!.disposition.kind).toBe('resolved')
    expect(resolved.conflicts.find(value => value.id === conflict.id)!.branches).toEqual(conflict.branches)
    const snapshotAfter = (await readRemoteState(third.db, third.token))!.value
    const afterProjection = (await openRemoteProjection(third.db, third.token, await readRemoteHeads(third.db, third.token, snapshotAfter.heads), (await third.native()).head, resolved.planner.localData.revision))!
    const actual = (await third.db.encryptedRevisions.get(afterProjection.units.get(conflict.unit.privateKey)!.ref.revisionId))!
    expect(actual.descriptor.parents).toEqual([authority.branches[0].publication.ref.revisionId, projection.units.get(conflict.unit.privateKey)!.ref.revisionId])
    for (const branch of resolved.conflicts[0].branches) await inspectWorkspaceClosure(resolved, branch.closure)
    for (const branch of originals) for (const original of branch) {
      const retainedBlob = resolved.blobs.find(blob => blobIdentity(blob.ref) === blobIdentity(original.ref))!
      expect(retainedBlob.ref).toEqual(original.ref)
      expect(await readBlob(retainedBlob.content, retainedBlob.ref.byteLength)).toEqual(original.bytes)
    }

  } finally {
    timing({ journey: scenario, phase: 'request-headroom', requests: requestTimes.length, peakRequestsPerMinute })
    vi.unstubAllGlobals(); invalidateProfile(); for (const db of databases) await db.delete(); Dexie.dependencies.indexedDB = oldFactory; await fixture.dispose()
  }
}, CONFLICT_JOURNEY_BUDGET_MS)

const password = 'synthetic sync acceptance password'
function post(f: ServiceFixture, path: string, body: object) { return f.request(`/api/v1/${path}`, { method: 'POST', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
async function customer(f: ServiceFixture, name = 'sync') {
  const registration = await opaque.startRegistration(password)
  const started = await post(f, 'auth/signup/start', { email: `${name}@example.org`, username: `${name}_user`, registrationRequest: registration.request })
  expect(started.status).toBe(200)
  const start = await started.json() as { attemptId: string; accountId: string; credentialId: string; registrationResponse: string }
  const registered = await opaque.finishRegistration(registration.state, start.registrationResponse, password, start.credentialId)
  expect((await post(f, 'auth/signup/finish', { attemptId: start.attemptId, transactionId: accountLocalId(), registrationRecord: registered.record, accountEnvelope: { version: 1, algorithm: 'xchacha20poly1305-ietf', nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url'), ciphertext: Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString('base64url') }, remember: true })).status).toBe(200)
  await f.runJobs()
  expect((await post(f, 'auth/verify', { capability: (await f.emails()).at(-1)!.capability })).status).toBe(200)
  const login = await opaque.startLogin(password)
  const challenge = await (await post(f, 'auth/login/start', { email: `${name}@example.org`, role: 'password', startLoginRequest: login.request })).json() as { attemptId: string; credentialId: string; loginResponse: string }
  const finish = await opaque.finishLogin(login.state, challenge.loginResponse, password, challenge.credentialId)
  const response = await post(f, 'auth/login/finish', { attemptId: challenge.attemptId, finishLoginRequest: finish.request, remember: true })
  expect(response.status).toBe(200)
  const session = await response.json() as Omit<UnlockResult, 'key'>
  return { ...session, headers: { cookie: response.headers.get('set-cookie')!.split(';')[0], 'x-csrf-token': session.csrf } }
}
