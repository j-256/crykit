import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createServiceFixture } from '../../worker/testing/service-fixture'
import * as opaque from '../account/crypto/opaque'
import { accountLocalId } from '../workspace/account-cache'
import type { ServiceFixture } from '../../worker/testing/service-fixture'
import { AccountDatabase } from '../persistence/account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import type { UnlockResult } from '../account/auth-client'
import { openAccountRepository } from '../workspace/account-repository'
import { registerSyncProjectionGuard, runSyncIteration } from '../account/sync/outbox'
import { SyncError } from '../account/sync/client'
import type { OwnedFileOutcome } from '../workspace/owned-file-command'

import { prepareManagedSync, seedManagedWorkspace } from './managed-sync.test-helpers'

let database: AccountDatabase | undefined
let service: ServiceFixture | undefined
afterEach(async () => { vi.unstubAllGlobals(); invalidateProfile(); await database?.delete(); await service?.dispose() })
it('publishesAndPullsAnAuthenticatedWorkspaceThroughActualWorkerRoutes', async () => {
  service = await createServiceFixture({ now: 1_800_000_000_000 })
  const session = await customer(service)
  const token = installProfile(session.accountId, crypto.getRandomValues(new Uint8Array(32)), session as Omit<UnlockResult, 'key'>)
  let repository = await openAccountRepository(token)
  database = new AccountDatabase(token.accountId)
  registerSyncProjectionGuard(token, () => true)
  let chunks = 0, maximum = 0
  const requests: { method: string; path: string }[] = []
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    requests.push({ method: init.method ?? 'GET', path })
    if (path.includes('/chunks/')) chunks++
    const headers = new Headers(init.headers)
    headers.set('cookie', session.headers.cookie)
    headers.set('origin', 'http://127.0.0.1')
    return service!.request(path, { ...init, headers })
  })
  let outcome: import('../account/sync/scheduler').SyncOutcome | undefined
  const settle = async () => {
    await prepareManagedSync(database!, token)
    for (let iteration = 0; iteration < 160; iteration++) {
      chunks = 0
      try { outcome = await runSyncIteration(token, new AbortController().signal) }
      catch (error) { if (!(error instanceof SyncError && error.code === 'SERVICE_UNAVAILABLE')) throw error }
      maximum = Math.max(maximum, chunks)
      if (outcome?.state === 'synced') break
    }
    expect(outcome?.state).toBe('synced')
    repository = await openAccountRepository(token)
  }
  await settle()
  const before = await repository.load()
  await repository.save({ ...before.localData, modSetup: { version: 1, state: 'skipped' } }, before.revision)
  expect(await database.outbox.count()).toBe(1)
  expect((await database.outbox.toArray())[0].publicationBase).toEqual((await database.syncState.get('projection'))!.ref)
  outcome = undefined
  await settle()
  expect(maximum).toBeLessThanOrEqual(16)
  expect(requests.some(value => value.path.endsWith('/commits'))).toBe(true)
  expect(await repository.readWorkspace()).toBeDefined()
  expect(await database.outbox.count()).toBe(0)
  const saved = await repository.load()
  expect(saved.canUndo).toBe(true)
  expect((await repository.previewImport(await repository.exportPlannerBackup(), 'native.zip')).proposed.localData).toEqual(saved.localData)
  const commitsBefore = requests.filter(value => value.path.endsWith('/commits')).length
  expect((await runSyncIteration(token, new AbortController().signal)).state).toBe('synced')
  expect(requests.filter(value => value.path.endsWith('/commits'))).toHaveLength(commitsBefore)
})

it('adopts remote physical identities before publishing a migrated second-device original', async () => {
  const { createBlankLocalData } = await import('../domain/local-data')
  const { prepareAccountWorkspace } = await import('../workspace/account-graph')
  const { activateLocalAccountCommit } = await import('./account-database')
  const { readIncrementalMappedRoot } = await import('../workspace/account-local-mapping')
  const { captureWorkspaceSnapshot, openHistoricalSnapshot, disposeWorkspaceSnapshot } = await import('../workspace/snapshot')
  const intents = await import('../workspace/account-intents')
  service = await createServiceFixture({ now: 1_800_000_000_000 })
  const session = await customer(service, 'adopt_evidence'), key = crypto.getRandomValues(new Uint8Array(32))
  const originalFactory = Dexie.dependencies.indexedDB, databases: AccountDatabase[] = []
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers); headers.set('cookie', session.headers.cookie); headers.set('origin', 'http://127.0.0.1')
    return service!.request(path, { ...init, headers })
  })
  const state = (localData: import('../domain/types').LocalData): import('../workspace/documents').WorkspaceState => ({ planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } })
  const openDevice = () => {
    invalidateProfile(); Dexie.dependencies.indexedDB = new IDBFactory()
    const token = installProfile(session.accountId, key.slice(), session), db = new AccountDatabase(token.accountId)
    databases.push(db); registerSyncProjectionGuard(token, () => true)
    return { token, db }
  }
  const settle = async (device: ReturnType<typeof openDevice>) => {
    await prepareManagedSync(device.db, device.token)
    for (let turn = 0; turn < 160; turn++) {
      try { const result = await runSyncIteration(device.token, new AbortController().signal); if (result.state === 'synced') return; expect(result.moreWork).toBe(true) }
      catch (error) { if (!(error instanceof SyncError && error.code === 'SERVICE_UNAVAILABLE')) throw error }
    }
    throw new Error('Migrated evidence did not publish')
  }
  let spy: ReturnType<typeof vi.spyOn> | undefined
  try {
    const first = openDevice(), shared = state(createBlankLocalData())
    await seedManagedWorkspace(first.db, first.token, shared)
    await openAccountRepository(first.token); await settle(first)
    const second = openDevice(), original = state(createBlankLocalData())
    const native = await prepareAccountWorkspace(second.db, second.token, original)
    await activateLocalAccountCommit(second.db, second.token, { version: 1, id: accountLocalId(), expected: undefined, head: native.head, records: native.records, intentStatus: 'mapped-local' })
    await openAccountRepository(second.token)
    const stage = intents.stageMappedWorkspaceIntent, predecessors: unknown[] = []
    spy = vi.spyOn(intents, 'stageMappedWorkspaceIntent').mockImplementation(async (...args) => {
      const selected = (await second.db.profileMeta.get('active'))!
      const predecessor = await readIncrementalMappedRoot(second.db, second.token, selected)
      expect(args[2].base).toEqual(predecessor)
      predecessors.push(predecessor)
      return stage(...args)
    })
    await settle(second)
    expect(predecessors).toHaveLength(1)
    expect(await second.db.outbox.count()).toBe(0)
    const repository = await openAccountRepository(second.token)
    expect((await repository.load()).localData).toEqual(shared.planner.localData)
    const snapshot = await captureWorkspaceSnapshot(repository)
    try {
      expect(snapshot.version).toBe(2)
      if (snapshot.version !== 2) throw new Error('The migrated original is missing')
      expect(snapshot.historicalEvidence.snapshots).toHaveLength(1)
      const historical = await openHistoricalSnapshot(snapshot, snapshot.historicalEvidence.snapshots[0].id)
      try { expect(historical.state.planner).toEqual(original.planner); expect(historical.state.libraryDefaults).toEqual(original.libraryDefaults) }
      finally { await disposeWorkspaceSnapshot(historical) }
    } finally { await disposeWorkspaceSnapshot(snapshot) }
  } finally { spy?.mockRestore(); invalidateProfile(); for (const db of databases) await db.delete(); Dexie.dependencies.indexedDB = originalFactory }
})

it('twoDevicesPullIndependentChildrenAndRecordedPartyWithoutEchoOrSourceRewriting', async () => {
  const { createTestLocalData, addTestTeam, TEST_GAME_SETUP_REVISION_ID, TEST_PLAYTHROUGH_ID } = await import('../domain/test-helpers')
  const { updateCharacter, createScenario, createPersonalDefinition } = await import('../domain')
  const { createBlankLocalData } = await import('../domain/local-data')
  const { openAccountWorkspace } = await import('../workspace/account-graph')
  const { readIncrementalMappedRoot } = await import('../workspace/account-local-mapping')
  const key = crypto.getRandomValues(new Uint8Array(32)), originalFactory = Dexie.dependencies.indexedDB
  service = await createServiceFixture({ now: 1_800_000_000_000 })
  const session = await customer(service, 'devices')
  const factories = [new IDBFactory(), new IDBFactory()]
  const databases: AccountDatabase[] = []
  let commits = 0
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (path.endsWith('/commits')) commits++
    const headers = new Headers(init.headers); headers.set('cookie', session.headers.cookie); headers.set('origin', 'http://127.0.0.1')
    return service!.request(path, { ...init, headers })
  })
  const switchDevice = async (index: number, initial?: import('../domain/types').LocalData) => {
    invalidateProfile(); Dexie.dependencies.indexedDB = factories[index]
    const token = installProfile(session.accountId, key.slice(), session)
    const db = new AccountDatabase(token.accountId); databases.push(db)
    if (!await db.profileMeta.get('active')) {
      const localData = initial ?? createBlankLocalData()
      const state: import('../workspace/documents').WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
      await seedManagedWorkspace(db, token, state)
    }
    registerSyncProjectionGuard(token, () => true)
    let repo = await openAccountRepository(token)
    const settle = async () => {
      await prepareManagedSync(db, token)
      for (let turn = 0; turn < 150; turn++) {
        try { const result = await runSyncIteration(token, new AbortController().signal); if (result.state === 'synced') { repo = await openAccountRepository(token); return } if (!result.moreWork) throw new Error(`Unexpected ${result.state}`) }
        catch (error) { if (!(error instanceof SyncError && error.code === 'SERVICE_UNAVAILABLE')) throw error }
      }
      throw new Error('Sync did not settle within bounded turns')
    }
    return { token, db, get repo() { return repo }, settle }
  }
  try {
    const team = addTestTeam(createTestLocalData())
    let a = await switchDevice(0, team.localData)
    await a.settle()
    let b = await switchDevice(1)
    await b.settle()
    const b0 = await b.repo.load()
    expect(b0.localData.revision).toBe(0)
    a = await switchDevice(0)
    const a0 = await a.repo.load()
    const ownerBefore = (await openAccountWorkspace(a.db, a.token, (await readIncrementalMappedRoot(a.db, a.token, (await a.db.profileMeta.get('active'))!))!)).entries.find(value => value.kind === 'playthrough')!
    const edited = updateCharacter(a0.localData, { characterId: team.memberIds[0], name: 'Remote child' })
    const scenario = createScenario(edited, { label: 'Captured party', memberIds: team.memberIds, baseline: { kind: 'recordedParty', playthroughRevision: edited.playthroughs[TEST_PLAYTHROUGH_ID].revision, assignments: {} }, gameSetupRevisionId: TEST_GAME_SETUP_REVISION_ID })
    await a.repo.save(scenario, a0.revision)
    const original = await a.repo.readWorkspace()
    await a.settle()
    b = await switchDevice(1)
    await b.settle()
    const b1 = await b.repo.load(), pulled = await b.repo.readWorkspace()
    expect(b1.localData.playthroughs[TEST_PLAYTHROUGH_ID].characters).toEqual(original.planner.localData.playthroughs[TEST_PLAYTHROUGH_ID].characters)
    expect(b1.localData.playthroughs[TEST_PLAYTHROUGH_ID].scenarios).toEqual(original.planner.localData.playthroughs[TEST_PLAYTHROUGH_ID].scenarios)
    expect(b1.localData.revision).toBe(1)
    expect(b1.canUndo).toBe(false)
    expect(pulled.planner.history).toEqual(original.planner.history)
    const mapped = await openAccountWorkspace(b.db, b.token, (await readIncrementalMappedRoot(b.db, b.token, (await b.db.profileMeta.get('active'))!))!)
    expect(mapped.entries.find(value => value.kind === 'playthrough')!.ref).toEqual(ownerBefore.ref)
    expect((await b.repo.previewImport(await b.repo.exportPlannerBackup(), 'device.zip')).proposed.localData).toEqual(b1.localData)
    const count = commits; await b.settle(); expect(commits).toBe(count)
    await b.repo.save(createPersonalDefinition(b1.localData, { kind: 'item', name: 'Second device item' }), b1.revision)
    await b.settle()
    const bSaved = await b.repo.readWorkspace()
    a = await switchDevice(0)
    await a.settle()
    const aFinal = await a.repo.load()
    expect(Object.values(aFinal.localData.personalDefinitions).some(value => value.name === 'Second device item')).toBe(true)
    expect((await a.repo.readWorkspace()).planner.history).toEqual(bSaved.planner.history)
    expect(aFinal.revision).toBeGreaterThan(original.planner.localData.revision)
    expect(aFinal.canUndo).toBe(false)
    expect((await a.repo.previewImport(await a.repo.exportPlannerBackup(), 'return.zip')).proposed.localData).toEqual(aFinal.localData)
  } finally {
    invalidateProfile()
    for (const db of databases) await db.delete()
    Dexie.dependencies.indexedDB = originalFactory
  }
})

it('unionsDisjointHistoricalOriginalsAndReexportsThemOnBothDevices', async () => {
  const { activateLocalAccountCommit } = await import('./account-database')
  const { openAccountWorkspace, prepareAccountWorkspaceWithEvidence } = await import('../workspace/account-graph')
  const { createAccountInheritedEvidencePreparation } = await import('../workspace/account-evidence-snapshots')
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const { inheritWorkspaceSnapshot } = await import('../interchange/workspace-backup-evidence')
  const { stageMappedWorkspaceIntent, mappedChanges } = await import('../workspace/account-intents')
  const { cipherRef } = await import('../workspace/account-cache')
  const { captureWorkspaceSnapshot, disposeWorkspaceSnapshot, openHistoricalSnapshot } = await import('../workspace/snapshot')
  const { exportWorkspaceBackup, readWorkspaceBackup } = await import('../interchange/workspace-backup')
  const { readBlob } = await import('../workspace/blobs')
  const { prepareIncrementalBaseline, activateIncrementalBaseline, readIncrementalMappedRoot } = await import('../workspace/account-local-mapping')
  const { prepareManagedAccountProjection } = await import('../workspace/account-managed-projection')
  const key = crypto.getRandomValues(new Uint8Array(32)), originalFactory = Dexie.dependencies.indexedDB
  const factories = [new IDBFactory(), new IDBFactory()], databases: AccountDatabase[] = []
  service = await createServiceFixture({ now: 1_800_000_000_000 })
  const session = await customer(service, 'history_devices')
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers); headers.set('cookie', session.headers.cookie); headers.set('origin', 'http://127.0.0.1')
    return service!.request(path, { ...init, headers })
  })
  const device = async (index: number) => {
    invalidateProfile(); Dexie.dependencies.indexedDB = factories[index]
    const token = installProfile(session.accountId, key.slice(), session)
    const db = new AccountDatabase(token.accountId); databases.push(db)
    let repo = await openAccountRepository(token)
    const fence = (await db.profileMeta.get('active'))!
    // Node runs the actual mapper preparation and activation; browser tests own its Worker transport
    if (!await readIncrementalMappedRoot(db, token, fence)) await activateIncrementalBaseline(db, token, await prepareIncrementalBaseline(db, token, fence))
    registerSyncProjectionGuard(token, () => true)
    const settle = async () => {
      for (let turn = 0; turn < 160; turn++) {
        try {
          const result = await runSyncIteration(token, new AbortController().signal)
          if (result.state === 'synced') { repo = await openAccountRepository(token); return }
          if (!result.moreWork) throw new Error(`Unexpected ${result.state}`)
        }
        catch (error) { if (!(error instanceof SyncError && error.code === 'SERVICE_UNAVAILABLE')) throw error }
      }
      throw new Error('Historical sync did not settle')
    }
    return { token, db, get repo() { return repo }, settle }
  }
  const stageHistory = async (selected: Awaited<ReturnType<typeof device>>, label: string) => {
    const fence = (await selected.db.profileMeta.get('active'))!, mapped = (await readIncrementalMappedRoot(selected.db, selected.token, fence))!
    const source = await openAccountWorkspace(selected.db, selected.token, mapped)
    const fixture = await editorClosureFixture()
    const current = { version: 1 as const, snapshotId: `current-${label}`, capturedAt: '2026-10-13', revisionVector: {}, state: fixture.state }
    const historical = { ...current, snapshotId: `historical-${label}`, state: { ...fixture.state, editorDocuments: [{ ...fixture.file, unfinished: { ...fixture.file.unfinished, fieldState: { original: `\ud800${label}` } } }] } }
    const inherited = await inheritWorkspaceSnapshot(current, [historical])
    const operation = createAccountInheritedEvidencePreparation(selected.db, selected.token)
    try {
      const evidence = await operation.prepare({ additions: [inherited] })
      const successor = await prepareAccountWorkspaceWithEvidence(selected.db, selected.token, source.state, evidence, source)
      const id = accountLocalId(), intent = await stageMappedWorkspaceIntent(selected.db, selected.token, {
        version: 1, kind: 'mapped-workspace-intent', operationId: id, portableGroupId: accountLocalId(), operation: 'workspace-command', mode: 'replace',
        original: { base: source.head, target: successor.head }, base: source.head, target: successor.head, localRevision: fence.headRevision + 1,
        changes: mappedChanges(source, successor.opened),
      })
      const projection = await prepareManagedAccountProjection(selected.db, selected.token, fence, successor, { id, ref: cipherRef(intent.record), records: intent.records })
      try { await activateLocalAccountCommit(selected.db, selected.token, projection.prepared) }
      finally { await projection.dispose() }
    } finally { await operation.abandon(); await disposeWorkspaceSnapshot(inherited) }
  }
  const assertExport = async (selected: Awaited<ReturnType<typeof device>>) => {
    const snapshot = await captureWorkspaceSnapshot(selected.repo)
    try {
      expect(snapshot.version).toBe(2)
      if (snapshot.version !== 2) throw new Error('Missing historical evidence')
      expect(snapshot.historicalEvidence.snapshots).toHaveLength(2)
      const metadata = []
      for (const member of snapshot.historicalEvidence.snapshots) {
        const historical = await openHistoricalSnapshot(snapshot, member.id)
        try {
          const body = historical.state.blobs.find(blob => blob.ref.documentId === 'text')!
          expect(await readBlob(body.content, body.ref.byteLength)).toEqual(new Uint8Array([0x00, 0xd8]))
          metadata.push(historical.state.editorDocuments[0].unfinished.fieldState)
        } finally { await disposeWorkspaceSnapshot(historical) }
      }
      expect(metadata).toEqual(expect.arrayContaining([{ original: '\ud800A' }, { original: '\ud800B' }]))
      const exported = await readWorkspaceBackup(exportWorkspaceBackup(snapshot))
      try { expect(exported.version).toBe(2); if (exported.version === 2) expect(exported.historicalEvidence).toEqual(snapshot.historicalEvidence) }
      finally { await disposeWorkspaceSnapshot(exported) }
    } finally { await disposeWorkspaceSnapshot(snapshot) }
  }
  try {
    let a = await device(0)
    await a.settle()
    let b = await device(1)
    await b.settle()
    a = await device(0)
    await stageHistory(a, 'A')
    b = await device(1)
    await stageHistory(b, 'B')
    a = await device(0)
    await a.settle()
    b = await device(1)
    await b.settle()
    a = await device(0)
    await a.settle()
    await assertExport(a)
    b = await device(1)
    await assertExport(b)
  } finally { invalidateProfile(); for (const db of databases) await db.delete(); Dexie.dependencies.indexedDB = originalFactory }
}, 180_000)

it('publishesRestoredHistoricalOriginalsForExactReexportOnAnotherDevice', async () => {
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const { exportWorkspaceBackup, readWorkspaceBackup } = await import('../interchange/workspace-backup')
  const { captureWorkspaceSnapshot, disposeWorkspaceSnapshot, openHistoricalSnapshot } = await import('../workspace/snapshot')
  const { previewAccountWorkspaceRestore, stageAccountWorkspaceRestore, activateAccountWorkspaceRestore, releaseAccountWorkspaceRestorePreview, releaseAccountWorkspaceRestoreStage } = await import('../workspace/account-restore')
  const { readBlob } = await import('../workspace/blobs')
  const key = crypto.getRandomValues(new Uint8Array(32)), originalFactory = Dexie.dependencies.indexedDB
  const factories = [new IDBFactory(), new IDBFactory()], databases: AccountDatabase[] = []
  service = await createServiceFixture({ now: 1_800_000_000_000 })
  const session = await customer(service, 'restore_devices')
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers); headers.set('cookie', session.headers.cookie); headers.set('origin', 'http://127.0.0.1')
    return service!.request(path, { ...init, headers })
  })
  const device = async (index: number) => {
    invalidateProfile(); Dexie.dependencies.indexedDB = factories[index]
    const token = installProfile(session.accountId, key.slice(), session)
    const db = new AccountDatabase(token.accountId); databases.push(db)
    let repo = await openAccountRepository(token)
    registerSyncProjectionGuard(token, () => true)
    const settle = async () => {
      await prepareManagedSync(db, token)
      for (let turn = 0; turn < 160; turn++) {
        try { const result = await runSyncIteration(token, new AbortController().signal); if (result.state === 'synced') { repo = await openAccountRepository(token); return } if (!result.moreWork) throw new Error(`Unexpected ${result.state}`) }
        catch (error) { if (!(error instanceof SyncError && error.code === 'SERVICE_UNAVAILABLE')) throw error }
      }
      throw new Error('Restored history did not settle')
    }
    return { token, db, get repo() { return repo }, settle }
  }
  try {
    const a = await device(0)
    await a.settle()
    const fixture = await editorClosureFixture()
    const source = { version: 1 as const, snapshotId: 'restored-on-a', capturedAt: '2026-10-13', revisionVector: {}, state: { ...fixture.state, editorDocuments: [{ ...fixture.file, unfinished: { ...fixture.file.unfinished, fieldState: { original: '\ud800restored' } } }] } }
    const backup = await readWorkspaceBackup(exportWorkspaceBackup(source))
    try {
      const preview = await previewAccountWorkspaceRestore(a.db, a.token, backup)
      try {
        const stage = await stageAccountWorkspaceRestore(preview)
        try { await activateAccountWorkspaceRestore(stage) }
        finally { await releaseAccountWorkspaceRestoreStage(stage) }
      } finally { releaseAccountWorkspaceRestorePreview(preview) }
    } finally { await disposeWorkspaceSnapshot(backup) }
    await a.settle()
    const b = await device(1)
    await b.settle()
    const captured = await captureWorkspaceSnapshot(b.repo)
    try {
      expect(captured.version).toBe(2)
      if (captured.version !== 2) throw new Error('Restored original was not carried to device B')
      expect(captured.historicalEvidence.snapshots).toHaveLength(1)
      const historical = await openHistoricalSnapshot(captured, captured.historicalEvidence.snapshots[0].id)
      try {
        expect(historical.state.editorDocuments[0].unfinished.fieldState).toEqual({ original: '\ud800restored' })
        const original = historical.state.blobs.find(blob => blob.ref.documentId === 'text')!
        expect(await readBlob(original.content, original.ref.byteLength)).toEqual(new Uint8Array([0x00, 0xd8]))
      } finally { await disposeWorkspaceSnapshot(historical) }
      const exported = await readWorkspaceBackup(exportWorkspaceBackup(captured))
      try { expect(exported.version).toBe(2); if (exported.version === 2) expect(exported.historicalEvidence).toEqual(captured.historicalEvidence) }
      finally { await disposeWorkspaceSnapshot(exported) }
    } finally { await disposeWorkspaceSnapshot(captured) }
  } finally { invalidateProfile(); for (const db of databases) await db.delete(); Dexie.dependencies.indexedDB = originalFactory }
}, 120_000)

it('revivesExpiredAcceptedRegistrationWithExactOriginalCiphertextAndANewRegistrationReceipt', async () => {
  const { EncryptedOutbox, transferBudget } = await import('../account/sync/outbox')
  const { SyncClient } = await import('../account/sync/client')
  const { stageAccountBytes } = await import('../workspace/account-cache')
  service = await createServiceFixture({ now: 1_800_000_000_000 })
  const session = await customer(service, 'revival')
  const token = installProfile(session.accountId, crypto.getRandomValues(new Uint8Array(32)), session)
  database = new AccountDatabase(token.accountId)
  const starts: string[] = [], chunks: Uint8Array[] = [], requests: string[] = []
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (path.endsWith('/uploads')) starts.push(init.body as string)
    if (path.includes('/chunks/') && init.method === 'PUT') chunks.push((init.body as Uint8Array).slice())
    if (path.endsWith('/commits')) requests.push(init.body as string)
    const headers = new Headers(init.headers); headers.set('cookie', session.headers.cookie); headers.set('origin', 'http://127.0.0.1')
    return service!.request(path, { ...init, headers })
  })
  const record = await stageAccountBytes(database, token, new TextEncoder().encode('Exact retained staging body'), [])
  await database.encryptedRevisions.add(record)
  const outbox = new EncryptedOutbox(database, token), client = new SyncClient(token, new AbortController().signal)
  const input = { version: 1 as const, mutationId: accountLocalId(), revisions: [record.descriptor], heads: [], expected: [] }
  await outbox.prepare(input)
  service.failNext('sync.commit.after')
  await expect(outbox.advance(input.mutationId, client, transferBudget())).rejects.toThrow('SERVICE_UNAVAILABLE')
  expect((await outbox.advance(input.mutationId, client, transferBudget()))!.mutationId).toBe(input.mutationId)
  const generation = (await service.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id = ?').bind(record.descriptor.uploadId).first<string>('generation'))!
  await service.db.prepare('UPDATE storage_generations SET expires_at = 0 WHERE id = ?').bind(generation).run()
  await service.runJobs()
  expect(await service.db.prepare('SELECT state FROM storage_generations WHERE id = ?').bind(generation).first('state')).toBe('closed')
  expect(await outbox.verifyReadiness(input.mutationId, client)).toBe(false)
  const revived = await outbox.prepareRevival(input.mutationId)
  expect(revived).not.toBe(input.mutationId)
  const result = await outbox.advance(revived, client, transferBudget())
  expect(result!.mutationId).toBe(revived)
  expect(starts).toEqual([starts[0], starts[0]])
  expect(chunks).toEqual([chunks[0], chunks[0]])
  expect(JSON.parse(requests[1])).toEqual({ ...JSON.parse(requests[0]), mutationId: revived })
  expect((await database.encryptedRevisions.get(record.revisionId))!.descriptor).toEqual(record.descriptor)
  expect(await outbox.verifyReadiness(revived, client)).toBe(true)
  const original = (await outbox.read(input.mutationId))!
  expect(original.request).toBe(JSON.stringify(input))
  expect(original.receipt!.mutationId).toBe(input.mutationId)
})

it('publishesQueuedBulkIntentsAndPostTargetEditsThroughExactOwnLineageBridges', async () => {
  const { createBlankLocalData } = await import('../domain/local-data')
  const { createPersonalDefinition } = await import('../domain')
  const { openAccountJson } = await import('../workspace/account-cache')
  const { MappedWorkspaceIntentSchema } = await import('../workspace/account-intents')
  service = await createServiceFixture({ now: 1_800_000_000_000 })
  const session = await customer(service, 'queuedbulk')
  const token = installProfile(session.accountId, crypto.getRandomValues(new Uint8Array(32)), session)
  database = new AccountDatabase(token.accountId)
  const localData = createBlankLocalData()
  const state: import('../workspace/documents').WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
  await seedManagedWorkspace(database, token, state)
  let repository = await openAccountRepository(token)
  registerSyncProjectionGuard(token, () => true)
  const finals: import('../account/protocol').CommitRequest[] = []
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (path.endsWith('/commits')) { const value = JSON.parse(init.body as string) as import('../account/protocol').CommitRequest; if (value.heads.length) finals.push(value) }
    const headers = new Headers(init.headers); headers.set('cookie', session.headers.cookie); headers.set('origin', 'http://127.0.0.1')
    return service!.request(path, { ...init, headers })
  })
  const settle = async () => {
    await prepareManagedSync(database!, token)
    for (let turn = 0; turn < 400; turn++) {
      try { const outcome = await runSyncIteration(token, new AbortController().signal); if (outcome.state === 'synced') { repository = await openAccountRepository(token); return } if (!outcome.moreWork) throw new Error(`Unexpected ${outcome.state}`) }
      catch (error) { if (!(error instanceof SyncError && error.code === 'SERVICE_UNAVAILABLE')) throw error }
    }
    throw new Error('Queued operations did not settle')
  }
  await settle()
  // Initial publication completes before the two authored replacements are counted
  const firstBulkFinal = finals.length
  for (const label of ['First bulk', 'Second bulk']) {
    const before = await repository.load()
    const next = createPersonalDefinition(before.localData, { kind: 'item', name: label })
    const preview = await repository.previewImport(await repository.exportPlannerBackup(next), 'replacement.zip')
    await repository.commitImport(preview, { mode: 'replace', expectedRevision: before.revision })
  }
  const beforeLast = await repository.load()
  await repository.save({ ...beforeLast.localData, modSetup: { version: 1, state: 'skipped' } }, beforeLast.revision)
  await prepareManagedSync(database, token)
  const originals = await Promise.all((await database.outbox.toArray()).map(async row => ({ row, value: await openAccountJson(database!, token, row.ref, MappedWorkspaceIntentSchema) })))
  expect(originals).toHaveLength(3)
  const currentBefore = await repository.load()
  await settle()
  expect(await database.outbox.count()).toBe(0)
  expect((await repository.load()).localData).toEqual(currentBefore.localData)
  for (const original of originals) expect(await openAccountJson(database, token, original.row.ref, MappedWorkspaceIntentSchema)).toEqual(original.value)
  const unique = [...new Map(finals.slice(firstBulkFinal).map(value => [value.mutationId, value])).values()]
  expect(unique.filter(value => value.expectedPublicationEpoch !== undefined)).toHaveLength(2)
  expect(unique.at(-1)).not.toHaveProperty('expectedPublicationEpoch')
  expect(Object.keys((await repository.load()).localData.personalDefinitions)).toHaveLength(2)
})

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
it('freshStoragePublishesAfterSameShardChangesWithoutHistoricalPayloadClosure', async () => {
  const { createBlankLocalData } = await import('../domain/local-data')
  const { createPersonalDefinition } = await import('../domain')
  const { directoryShard } = await import('../workspace/directory')
  const { readRemoteState, readRemoteHeads } = await import('../account/sync/pull')
  const { openRemoteProjection } = await import('../account/sync/projection')
  const { DirectorySchema } = await import('../account/sync/publication')
  const { openAccountJson } = await import('../workspace/account-cache')
  service = await createServiceFixture({ now: 1_800_000_000_000 })
  const session = await customer(service, 'freshclosure'), key = crypto.getRandomValues(new Uint8Array(32))
  const originalFactory = Dexie.dependencies.indexedDB, dbs: AccountDatabase[] = [], paths: string[] = []
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    paths.push(path)
    const headers = new Headers(init.headers); headers.set('cookie', session.headers.cookie); headers.set('origin', 'http://127.0.0.1')
    return service!.request(path, { ...init, headers })
  })
  const device = async () => {
    invalidateProfile(); Dexie.dependencies.indexedDB = new IDBFactory()
    const token = installProfile(session.accountId, key.slice(), session), db = new AccountDatabase(token.accountId); dbs.push(db)
    const localData = createBlankLocalData()
    const state: import('../workspace/documents').WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
    await seedManagedWorkspace(db, token, state)
    registerSyncProjectionGuard(token, () => true)
    let repo = await openAccountRepository(token)
    const settle = async () => {
      await prepareManagedSync(db, token)
      for (let turn = 0; turn < 200; turn++) {
        try {
          const result = await runSyncIteration(token, new AbortController().signal)
          if (result.state === 'synced') { repo = await openAccountRepository(token); return }
          if (!result.moreWork) throw new Error(`Unexpected ${result.state}`)
        } catch (error) { if (!(error instanceof SyncError && error.code === 'SERVICE_UNAVAILABLE')) throw error }
      }
      throw new Error('Sync did not settle')
    }
    return { token, db, get repo() { return repo }, settle }
  }
  try {
    const a = await device(); await a.settle()
    const ids = ['same-shard-first']
    const shard = await directoryShard(JSON.stringify(['personal-definition', ids[0]]))
    for (let index = 0; ids.length < 2; index++) { const id = `same-shard-next-${index}`; if (await directoryShard(JSON.stringify(['personal-definition', id])) === shard) ids.push(id) }
    let historicalIndex!: import('./account-database').CipherRef, historicalDirectory!: import('./account-database').CipherRef
    for (const id of ids) {
      const before = await a.repo.load()
      await a.repo.save(createPersonalDefinition(before.localData, { id: id as import('../domain/types').PersonalDefinitionId, kind: 'item', name: id }), before.revision)
      await a.settle()
      if (id === ids[0]) {
        const remote = (await readRemoteState(a.db, a.token))!.value
        const { readIncrementalMappedRoot } = await import('../workspace/account-local-mapping')
        const projection = (await openRemoteProjection(a.db, a.token, await readRemoteHeads(a.db, a.token, remote.heads), (await readIncrementalMappedRoot(a.db, a.token, (await a.db.profileMeta.get('active'))!))!, 0))!
        historicalDirectory = projection.directories.get(shard)!.ref
        historicalIndex = (await openAccountJson(a.db, a.token, historicalDirectory, DirectorySchema)).index
      }
    }
    const record = (await a.db.encryptedRevisions.get(historicalIndex.revisionId))!
    const objects = await service.db.prepare('SELECT object_key FROM upload_chunks WHERE generation = (SELECT generation FROM upload_reservations WHERE upload_id = ?)').bind(record.descriptor.uploadId).all<{ object_key: string }>()
    expect(objects.results.length).toBeGreaterThan(0)
    // Make only the unretained intermediate page payload unavailable; immutable ancestry descriptors remain on the actual server
    for (const object of objects.results) { await service.objects.delete(object.object_key); expect(await service.objects.get(object.object_key)).toBeNull() }
    paths.length = 0
    const b = await device(); await b.settle()
    expect(await b.db.encryptedRevisions.get(historicalDirectory.revisionId)).toBeDefined()
    expect(await b.db.encryptedRevisions.get(historicalIndex.revisionId)).toBeUndefined()
    const loaded = await b.repo.load()
    expect(Object.keys(loaded.localData.personalDefinitions).sort()).toEqual(ids.sort())
    await b.repo.save(createPersonalDefinition(loaded.localData, { name: 'Fresh device save', kind: 'item' }), loaded.revision)
    await b.settle()
    expect(await b.db.outbox.count()).toBe(0)
    expect(paths.some(path => path.includes(historicalIndex.revisionId))).toBe(false)
    expect(Object.values((await b.repo.load()).localData.personalDefinitions).some(value => value.name === 'Fresh device save')).toBe(true)
  } finally { invalidateProfile(); for (const db of dbs) await db.delete(); Dexie.dependencies.indexedDB = originalFactory }
})

async function initialEditorOverlap(negative?: string) {
  const { createEditorRepository } = await import('../workspace/editor-repository')
  const { readEditorContent } = await import('../workspace/editor-document')
  const { resolveOwnedFileReceipt } = await import('../workspace/owned-file-command')
  service = await createServiceFixture({ now: 1_800_000_000_000 })
  const session = await customer(service, 'editor_overlap')
  const token = installProfile(session.accountId, crypto.getRandomValues(new Uint8Array(32)), session)
  database = new AccountDatabase(token.accountId)
  let repository = await openAccountRepository(token)
  const hooks = { async onOutcome(outcome: OwnedFileOutcome) {
    if (outcome.status === 'saved' && outcome.receipt) {
      repository = (await resolveOwnedFileReceipt(outcome.receipt)).repository
      editor = createEditorRepository(repository, hooks)
    }
  } }
  let editor = createEditorRepository(repository, hooks)
  registerSyncProjectionGuard(token, () => true)
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers); headers.set('cookie', session.headers.cookie); headers.set('origin', 'http://127.0.0.1')
    return service!.request(path, { ...init, headers })
  })
  const original = new TextEncoder().encode('{"original":1}\r\n')
  const file = await editor.importFile({ filename: 'overlap.json', text: new TextDecoder().decode(original), bytes: original, referenceId: 'native' })
  await editor.saveUnfinished(file.id, { text: '{"unfinished":', editedPath: [], fieldState: null, validation: 'invalid' }, file.revision)
  expect(await database.outbox.count()).toBe(2)
  expect((await database.outbox.toArray()).every(row => !row.publicationBase)).toBe(true)
  let synced = false, negativesChecked = false
  const checkUnprovenChains = async () => {
    const { z } = await import('zod')
    const { openAccountJson, stageAccountJson, cipherRef } = await import('../workspace/account-cache')
    const { readSyncState, writeSyncState, TransportCommandSchema } = await import('../account/sync/outbox')
    const { MappedWorkspaceIntentSchema } = await import('../workspace/account-intents')
    const operationSchema = z.object({ accepted: z.boolean(), intentRef: z.object({ documentId: z.string(), revisionId: z.string() }).optional(), target: z.object({ documentId: z.string(), revisionId: z.string() }), finalMutationId: z.string(), lineageId: z.string().optional(), newLineageId: z.string() }).passthrough()
    const accepted = await Promise.all((await database!.syncState.toArray()).filter(row => row.id.startsWith('accepted:')).map(async row => ({ row, value: await openAccountJson(database!, token, row.ref, operationSchema) })))
    if (accepted.length !== 2) return false
    const initial = accepted.find(item => !item.value.intentRef)!, intervening = accepted.find(item => item.value.intentRef)!
    const intent = await openAccountJson(database!, token, intervening.value.intentRef!, MappedWorkspaceIntentSchema)
    const pendingRow = (await database!.outbox.toArray())[0]
    const pending = await openAccountJson(database!, token, pendingRow.ref, MappedWorkspaceIntentSchema)
    expect(initial.value.target).toEqual(intent.base)
    expect(intervening.value.target).toEqual(pending.base)
    expect(intent.localRevision).toBeLessThan(pending.localRevision)
    const before = await database!.profileMeta.get('active')
    const reject = async (label: string, row: import('./account-database').EncryptedSyncState, value: unknown, dependencies?: import('./account-database').CipherRef[]) => {
      if (negative !== label) return
      const original = row
      await writeSyncState(database!, token, row.id, value, row, dependencies ?? (await database!.encryptedRevisions.get(row.ref.revisionId))!.descriptor.dependencies)
      try {
        await expect(runSyncIteration(token, new AbortController().signal), label).rejects.toThrow('HEAD_CONFLICT')
        expect(await database!.profileMeta.get('active'), label).toEqual(before)
        expect(await database!.outbox.count(), label).toBe(1)
      } finally { await database!.syncState.put(original) }
    }
    const raw = z.record(z.string(), z.unknown())
    const initialRoot = await openAccountJson(database!, token, initial.value.target, raw)
    const initialRecord = (await database!.encryptedRevisions.get(initial.value.target.revisionId))!
    const equalRoot = await stageAccountJson(database!, token, initialRoot, initialRecord.descriptor.dependencies)
    await database!.encryptedRevisions.add(equalRoot)
    expect(await openAccountJson(database!, token, cipherRef(equalRoot), raw)).toEqual(initialRoot)
    await reject('content-equivalent initial full ref is insufficient', initial.row, { ...initial.value, target: cipherRef(equalRoot) })
    await reject('unaccepted initial evidence is insufficient', initial.row, { ...initial.value, accepted: false })
    await reject('foreign initial lineage is insufficient', initial.row, { ...initial.value, lineageId: accountLocalId() })
    await reject('broken lineage link is insufficient', intervening.row, { ...intervening.value, lineageId: accountLocalId() })
    const command = (await readSyncState(database!, token, `command:${initial.value.finalMutationId}`, TransportCommandSchema))!
    await reject('missing initial receipt is insufficient', command.row, { ...command.value, receipt: undefined })
    const changedIntent = async (label: string, changed: typeof intent) => {
      const record = (await database!.encryptedRevisions.get(intervening.value.intentRef!.revisionId))!
      const prepared = await stageAccountJson(database!, token, changed, record.descriptor.dependencies)
      await database!.encryptedRevisions.add(prepared)
      await reject(label, intervening.row, { ...intervening.value, intentRef: cipherRef(prepared), target: changed.target })
    }
    await changedIntent('broken full initial-to-intent base is insufficient', { ...intent, base: cipherRef(equalRoot) })
    await changedIntent('non-increasing local revisions are insufficient', { ...intent, localRevision: pending.localRevision })
    await changedIntent('terminal target mismatch is insufficient', { ...intent, target: initial.value.target })
    return true
  }
  await prepareManagedSync(database, token)
  for (let iteration = 0; iteration < 180; iteration++) {
    try {
      if (negative && !negativesChecked && await database.outbox.count() === 1) {
        negativesChecked = await checkUnprovenChains()
        if (negativesChecked) return
      }
      const result = await runSyncIteration(token, new AbortController().signal)
      if (result.state === 'synced') { synced = true; break }
    } catch (error) { if (!(error instanceof SyncError && error.code === 'SERVICE_UNAVAILABLE')) throw error }
  }
  expect(synced).toBe(true)
  expect(negative).toBeUndefined()
  expect(await database.outbox.count()).toBe(0)
  repository = await openAccountRepository(token)
  const state = await repository.readWorkspace(), content = await readEditorContent(state, state.editorDocuments[0])
  expect(content.originalBytes).toEqual(original)
  expect(content.lastAppliedText).toBe(new TextDecoder().decode(original))
  expect(content.unfinishedText).toBe('{"unfinished":')
  expect(state.conflicts).toEqual([])
}
it('publishes consecutive encrypted Editor intents captured before initial cloud acceptance', () => initialEditorOverlap())
it.each([
  'content-equivalent initial full ref is insufficient',
  'unaccepted initial evidence is insufficient',
  'foreign initial lineage is insufficient',
  'broken lineage link is insufficient',
  'missing initial receipt is insufficient',
  'broken full initial-to-intent base is insufficient',
  'non-increasing local revisions are insufficient',
  'terminal target mismatch is insufficient',
])('rejects an unproven encrypted initial chain: %s', negative => initialEditorOverlap(negative))

it.each(['fresh', 'migrated'] as const)('publishes %s managed encrypted commands through actual Worker routes while retaining the operative journal and native backup', async origin => {
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const { createAccountLocalStore } = await import('../workspace/account-local-store')
  const { prepareLocalWorkspace } = await import('../workspace/local-root')
  const { activateLocalAccountCommit } = await import('./account-database')
  const { openAccountManagedRepository } = await import('../workspace/account-managed-repository')
  const { prepareIncrementalBaseline, activateIncrementalBaseline, prepareIncrementalMapping, activateIncrementalMapping } = await import('../workspace/account-local-mapping')
  const { createPersonalDefinition } = await import('../domain')
  service = await createServiceFixture({ now: 1_800_000_000_000 })
  const session = await customer(service, 'managed_dispatch')
  const token = installProfile(session.accountId, crypto.getRandomValues(new Uint8Array(32)), session)
  database = new AccountDatabase(token.accountId)
  const store = createAccountLocalStore(database, token), fixture = await editorClosureFixture(), operation = accountLocalId()
  const pull = await import('../account/sync/pull'), activate = pull.activatePulledState
  const activation = vi.spyOn(pull, 'activatePulledState').mockImplementation(async (...args) => {
    await activate(...args)
    if (args[9]) expect((await database!.outbox.get(args[9].id))?.publicationBase).toEqual((await database!.syncState.get('projection'))?.ref)
  })
  try {
    let fence
    if (origin === 'migrated') {
      const { prepareAccountWorkspace } = await import('../workspace/account-graph')
      const { prepareAccountManagedMigration } = await import('../workspace/account-managed-migration')
      const native = await prepareAccountWorkspace(database, token, fixture.state)
      const before = await activateLocalAccountCommit(database, token, { version: 1, id: operation, expected: undefined, head: native.head, records: native.records })
      const migration = await prepareAccountManagedMigration(database, token, before)
      try { fence = await activateLocalAccountCommit(database, token, migration.prepared) }
      finally { await migration.dispose() }
    } else {
      const initial = await prepareLocalWorkspace(store.adapter, operation, fixture.state, store.lifetime)
      fence = await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, initial, undefined)); store.committed(operation)
    }
    // Worker lifetime and transport are covered by the browser producer; this composition uses its exact durable tickets
    if (origin === 'fresh') await activateIncrementalBaseline(database, token, await prepareIncrementalBaseline(database, token, fence))
    registerSyncProjectionGuard(token, () => true)
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      const headers = new Headers(init.headers); headers.set('cookie', session.headers.cookie); headers.set('origin', 'http://127.0.0.1')
      return service!.request(path, { ...init, headers })
    })
    const settle = async () => {
      for (let turn = 0; turn < 160; turn++) {
        try {
          const callsBefore = activation.mock.calls.length
          const outcome = await runSyncIteration(token, new AbortController().signal)
          if (origin === 'migrated' && activation.mock.calls.slice(callsBefore).some(call => !!call[6] || !!call[9])) expect(outcome).toEqual({ state: 'syncing', moreWork: true })
          if (outcome.state === 'synced') return
        } catch (error) { if (!(error instanceof SyncError && error.code === 'SERVICE_UNAVAILABLE')) throw error }
      }
      throw new Error('Managed account publication did not settle')
    }
    await settle()
    if (origin === 'migrated') {
      const accepted = activation.mock.calls.findIndex(call => !!call[6])
      const followup = activation.mock.calls.findIndex((call, index) => index > accepted && !!call[9])
      expect(accepted).toBeGreaterThanOrEqual(0)
      expect(followup).toBeGreaterThan(accepted)
      expect(activation.mock.calls[accepted][9]).toBeUndefined()
      expect(activation.mock.calls[followup][5]).toBeUndefined()
      expect(activation.mock.calls[followup][6]).toBeUndefined()
    }
    let repository = await openAccountManagedRepository(database, token, (await database.profileMeta.get('active'))!)
    const before = await repository.load()
    const saved = await repository.save(createPersonalDefinition(before.localData, { kind: 'item', name: 'Managed published item' }), before.revision)
    const exact = await repository.readWorkspace()
    const row = (await database.outbox.toArray())[0]!
    expect(row.status).toBe('unmapped-local')
    await activateIncrementalMapping(database, token, await prepareIncrementalMapping(database, token, row))
    await settle()
    expect(await database.outbox.count()).toBe(0)
    repository = await openAccountManagedRepository(database, token, (await database.profileMeta.get('active'))!)
    expect((await repository.readWorkspace()).planner).toEqual(exact.planner)
    expect((await repository.readWorkspace()).editorDocuments).toEqual(fixture.state.editorDocuments)
    expect((await repository.load()).canUndo).toBe(true)
    expect((await repository.previewImport(await repository.exportPlannerBackup(), 'managed.zip')).proposed.localData).toEqual(saved.localData)
    const undone = await repository.undo(saved.localData.revision)
    expect(undone.localData.personalDefinitions).toEqual(before.localData.personalDefinitions)
  } finally { activation.mockRestore(); await store.dispose() }
}, 60_000)

it('publishes the first pending copy once and preserves every original on a fresh second device', async () => {
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const { createGuestCopyService } = await import('../workspace/guest-copy')
  const { ownWorkspaceSnapshot, captureWorkspaceSnapshot, openHistoricalSnapshot, disposeWorkspaceSnapshot } = await import('../workspace/snapshot')
  const { blobIdentity, readBlob } = await import('../workspace/blobs')
  service = await createServiceFixture({ now: 1_800_000_000_000 })
  const session = await customer(service, 'first_copy'), key = crypto.getRandomValues(new Uint8Array(32))
  const originalFactory = Dexie.dependencies.indexedDB, databases: AccountDatabase[] = [], publications = new Set<string>()
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers); headers.set('cookie', session.headers.cookie); headers.set('origin', 'http://127.0.0.1')
    const response = await service!.request(path, { ...init, headers })
    if (path.endsWith('/commits') && response.ok) {
      const command = JSON.parse(init.body as string) as { mutationId: string; heads: unknown[] }
      if (command.heads.length) publications.add(command.mutationId)
    }
    return response
  })
  const fixture = await editorClosureFixture(), blank = { ...fixture.state, blobs: [], retainedContent: [] }
  const source = ownWorkspaceSnapshot({ version: 1, snapshotId: 'first-copy-original', capturedAt: fixture.file.updatedAt, revisionVector: {}, state: { ...fixture.state, editorDocuments: [fixture.file] } }, { check: async () => {}, dispose: async () => {} })
  const copy = createGuestCopyService(async () => source)
  const openDevice = async () => {
    invalidateProfile(); Dexie.dependencies.indexedDB = new IDBFactory()
    const token = installProfile(session.accountId, key.slice(), session), db = new AccountDatabase(token.accountId)
    databases.push(db); await seedManagedWorkspace(db, token, blank); registerSyncProjectionGuard(token, () => true)
    return { token, db }
  }
  const settle = async ({ token, db }: Awaited<ReturnType<typeof openDevice>>) => {
    await prepareManagedSync(db, token)
    for (let turn = 0; turn < 160; turn++) {
      try { const result = await runSyncIteration(token, new AbortController().signal); if (result.state === 'synced') return; expect(result.moreWork).toBe(true) }
      catch (error) { if (!(error instanceof SyncError && error.code === 'SERVICE_UNAVAILABLE')) throw error }
    }
    throw new Error('Initial copy did not settle')
  }
  try {
    const first = await openDevice()
    await copy.commitGuestCopy(first.token, await copy.previewGuestCopy(first.token, ['["editor","editor-1"]']))
    const localSelection = await first.db.profileMeta.get('active'), liveRepository = await openAccountRepository(first.token)
    await settle(first)
    expect(await first.db.profileMeta.get('active')).toEqual(localSelection)
    expect((await liveRepository.readWorkspace()).editorDocuments).toEqual([fixture.file])
    expect(publications.size).toBe(1)
    expect(await first.db.outbox.count()).toBe(0)
    const saved = await captureWorkspaceSnapshot(await openAccountRepository(first.token))
    let originalIds: string[]
    try {
      if (saved.version !== 2) throw new Error('Originals are missing')
      originalIds = saved.historicalEvidence.snapshots.map(member => member.id)
    } finally { await disposeWorkspaceSnapshot(saved) }
    const second = await openDevice()
    await settle(second)
    expect(publications.size).toBe(1)
    const received = await captureWorkspaceSnapshot(await openAccountRepository(second.token))
    try {
      expect(received.state.editorDocuments).toEqual([fixture.file])
      if (received.version !== 2) throw new Error('Synced originals are missing')
      expect(received.historicalEvidence.snapshots.map(member => member.id)).toEqual(originalIds)
      for (const member of received.historicalEvidence.snapshots) {
        const child = await openHistoricalSnapshot(received, member.id)
        try {
          for (const body of fixture.state.blobs) expect(await readBlob(child.state.blobs.find(value => blobIdentity(value.ref) === blobIdentity(body.ref))!.content, body.ref.byteLength)).toEqual(await readBlob(body.content, body.ref.byteLength))
        } finally { await disposeWorkspaceSnapshot(child) }
      }
    } finally { await disposeWorkspaceSnapshot(received) }
  } finally { await copy.dispose(); await disposeWorkspaceSnapshot(source); invalidateProfile(); for (const db of databases) await db.delete(); Dexie.dependencies.indexedDB = originalFactory; key.fill(0) }
})
