import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createServiceFixture } from '../../worker/testing/service-fixture'
import { accountLocalId } from '../workspace/account-cache'
import type { ServiceFixture } from '../../worker/testing/service-fixture'
import { AccountDatabase } from '../persistence/account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import type { UnlockResult } from '../account/auth-client'
import { openAccountRepository } from '../workspace/account-repository'
import { registerSyncProjectionGuard, runSyncIteration } from '../account/sync/outbox'
import { SyncError } from '../account/sync/client'

import { prepareManagedSync, seedManagedWorkspace } from './managed-sync.test-helpers'

import { customer } from './sync-customer.test-helpers'

// Each file owns its profile and database lifetime; the shared sign-in helper retains no state
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

it('publishesQueuedBulkIntentsAndPostTargetEditsThroughExactOwnLineageBridges', async ({ task, signal, onTestFinished }) => {
  const started = performance.now(), initialCpu = process.cpuUsage()
  const requests = { started: 0, completed: 0, pending: 0, totalMs: 0, maximumMs: 0 }
  const phases: { phase: string; elapsedMs: number; processCpuMs: number; requests: typeof requests }[] = []
  // Snapshot before cleanup so a timeout retains its active stage without recording paths or payloads
  // CPU covers this test process; overlapping request durations are not elapsed time or disk latency
  const mark = (phase: string) => {
    if (signal.aborted) return
    const cpu = process.cpuUsage(initialCpu)
    phases.push({ phase, elapsedMs: performance.now() - started, processCpuMs: (cpu.user + cpu.system) / 1000, requests: { ...requests } })
  }
  const retain = () => {
    const cpu = process.cpuUsage(initialCpu)
    Object.assign(task.meta, { queuedBulkTiming: { phases: [...phases], elapsedMs: performance.now() - started, processCpuMs: (cpu.user + cpu.system) / 1000, requests: { ...requests }, aborted: signal.aborted } })
  }
  signal.addEventListener('abort', retain, { once: true })
  onTestFinished(() => { if (!signal.aborted) retain(); signal.removeEventListener('abort', retain) })
  mark('fixture')
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
    const requestStarted = performance.now()
    requests.started++; requests.pending++
    try { return await service!.request(path, { ...init, headers }) }
    finally {
      const elapsed = performance.now() - requestStarted
      requests.completed++; requests.pending--; requests.totalMs += elapsed; requests.maximumMs = Math.max(requests.maximumMs, elapsed)
    }
  })
  const settle = async () => {
    await prepareManagedSync(database!, token)
    for (let turn = 0; turn < 400; turn++) {
      try { const outcome = await runSyncIteration(token, new AbortController().signal); if (outcome.state === 'synced') { repository = await openAccountRepository(token); return } if (!outcome.moreWork) throw new Error(`Unexpected ${outcome.state}`) }
      catch (error) { if (!(error instanceof SyncError && error.code === 'SERVICE_UNAVAILABLE')) throw error }
    }
    throw new Error('Queued operations did not settle')
  }
  mark('initial-publication')
  await settle()
  // Initial publication completes before the two authored replacements are counted
  const firstBulkFinal = finals.length
  mark('bulk-replacements')
  for (const label of ['First bulk', 'Second bulk']) {
    const before = await repository.load()
    const next = createPersonalDefinition(before.localData, { kind: 'item', name: label })
    const preview = await repository.previewImport(await repository.exportPlannerBackup(next), 'replacement.zip')
    await repository.commitImport(preview, { mode: 'replace', expectedRevision: before.revision })
  }
  mark('post-target-edit')
  const beforeLast = await repository.load()
  await repository.save({ ...beforeLast.localData, modSetup: { version: 1, state: 'skipped' } }, beforeLast.revision)
  mark('mapping')
  await prepareManagedSync(database, token)
  const originals = await Promise.all((await database.outbox.toArray()).map(async row => ({ row, value: await openAccountJson(database!, token, row.ref, MappedWorkspaceIntentSchema) })))
  expect(originals).toHaveLength(3)
  const currentBefore = await repository.load()
  mark('queued-publication')
  await settle()
  mark('exact-lineage-assertions')
  expect(await database.outbox.count()).toBe(0)
  expect((await repository.load()).localData).toEqual(currentBefore.localData)
  for (const original of originals) expect(await openAccountJson(database, token, original.row.ref, MappedWorkspaceIntentSchema)).toEqual(original.value)
  const unique = [...new Map(finals.slice(firstBulkFinal).map(value => [value.mutationId, value])).values()]
  expect(unique.filter(value => value.expectedPublicationEpoch !== undefined)).toHaveLength(2)
  expect(unique.at(-1)).not.toHaveProperty('expectedPublicationEpoch')
  expect(Object.keys((await repository.load()).localData.personalDefinitions)).toHaveLength(2)
  mark('complete')
})

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
