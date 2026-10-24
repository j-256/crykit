import 'fake-indexeddb/auto'
import '../workspace/guest-managed-monitor.test-helpers'
import { openManagedNativeWorkspace } from './managed-sync.test-helpers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { invalidateProfile, installProfile, type ProfileToken } from '../account/profile'
import { createPersonalDefinition } from '../domain'
import { AccountDatabase } from './account-database'
import { openAccountRepository } from '../workspace/account-repository'
import { CryKitDatabase, setDatabaseForTests } from './database'
import { createGuestRepository } from '../workspace/guest-repository'
import { completeInactiveCandidate } from './account-inactive-test-helpers'
import { openInactiveAccountWorkspace } from '../workspace/account-inactive-graph'

let token: ProfileToken
let database: AccountDatabase
let guest: CryKitDatabase
const privateTitle = 'Synthetic private account sword'
beforeEach(() => {
  invalidateProfile()
  token = installProfile(btoa(crypto.randomUUID().slice(0, 16)).replace(/=/g, ''), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  guest = new CryKitDatabase(`guest-${crypto.randomUUID()}`)
  setDatabaseForTests(guest)
})
afterEach(async () => {
  vi.restoreAllMocks()
  invalidateProfile()
  setDatabaseForTests(undefined)
  await database.delete()
  await guest.delete()
})
async function activeDump() {
  return { head: await database.profileMeta.toArray(), heads: await database.documentHeads.toArray(), outbox: await database.outbox.toArray(), revisions: await database.encryptedRevisions.toArray(), journal: await database.migrationJournal.toArray() }
}
async function dump(db: CryKitDatabase | AccountDatabase) {
  return Promise.all(db.tables.map(async table => [table.name, await table.toArray()]))
}
async function installSources(repository: import('../workspace/repository').WorkspaceRepository, sources: readonly import('../interchange/types').SourceArchiveRecord[]) {
  const { memoryBlob } = await import('../workspace/blobs')
  const { createAccountLocalStore } = await import('../workspace/account-local-store')
  const { admitLocalRoot, prepareLocalWorkspace } = await import('../workspace/local-root')
  const { activateLocalAccountCommit } = await import('./account-database')
  const { accountLocalId } = await import('../workspace/account-cache')
  const fence = (await database.profileMeta.get('active'))!
  const blobs = sources.map(source => ({ ref: { documentId: accountLocalId(), revisionId: accountLocalId(), byteLength: source.bytes.length, sha256: source.digest, encoding: 'bytes' as const }, content: memoryBlob(source.bytes) }))
  const state = await repository.readWorkspace()
  const store = createAccountLocalStore(database, token), operationId = accountLocalId()
  try {
    const previous = await admitLocalRoot(store.adapter, fence.head, store.lifetime)
    const target = await prepareLocalWorkspace(store.adapter, operationId, { ...state, blobs, planner: { ...state.planner, sources: sources.map(({ bytes: _bytes, ...metadata }, index) => ({ ...metadata, original: blobs[index]!.ref })) } }, store.lifetime, previous)
    await activateLocalAccountCommit(database, token, await store.prepareActivation(operationId, target, fence, previous))
    store.committed(operationId)
  } finally { await store.dispose() }
}
it('commitsEncryptedDataAndOutboxTogether', async () => {
  const repository = await openAccountRepository(token)
  const original = await repository.load()
  const before = await activeDump()
  const draft = createPersonalDefinition(original.localData, { name: privateTitle, kind: 'item' })
  const saved = await repository.save(draft, original.revision)
  const after = await activeDump()
  expect(after.head[0]!.headRevision).toBe(before.head[0]!.headRevision + 1)
  expect(after.outbox).toHaveLength(before.outbox.length + 1)
  const { openAccountJson } = await import('../workspace/account-cache')
  const { IncrementalWorkspaceIntentSchema } = await import('../workspace/account-mapping-origin')
  const intent = await openAccountJson(database, token, after.outbox[0]!.ref, IncrementalWorkspaceIntentSchema)
  expect(intent).toMatchObject({ kind: 'incremental-workspace-intent', mode: 'additive', operation: 'save', before: before.head[0]!.head, after: after.head[0]!.head, sequence: after.head[0]!.headRevision })
  expect((await openManagedNativeWorkspace(database, token)).state.planner.localData).toEqual(saved.localData)
  const reopened = await openAccountRepository(token)
  expect((await reopened.load()).localData).toEqual(saved.localData)
  expect(await reopened.readHistory()).toHaveLength(1)
  expect(JSON.stringify(await dump(database))).not.toContain(privateTitle)
})
it('nativeV2SuccessorRetainsExactInheritedHistoryThroughPlannerSave', async () => {
  const { prepareAccountWorkspace } = await import('../workspace/account-graph')
  const { activateLocalAccountCommit } = await import('./account-database')
  const { accountLocalId } = await import('../workspace/account-cache')
  const { createBlankLocalData } = await import('../domain/local-data')
  const { BUNDLED_CATALOGS } = await import('../catalog/bundled')
  const data = createBlankLocalData()
  const prepared = await prepareAccountWorkspace(database, token, { planner: { localData: data, catalogs: BUNDLED_CATALOGS, evidence: [], sources: [], history: [], lineage: { rootLocalDataId: data.id } }, saveDocuments: [], editorDocuments: [], assets: [], libraryDefaults: { version: 1, layers: [] }, conflicts: [], retainedContent: [], blobs: [] })
  const before = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records })
  const source = await openInactiveAccountWorkspace(database, token, before.head)
  const candidate = await completeInactiveCandidate(database, token, source, true)
  try {
    const { activateLocalAccountCommit } = await import('./account-database')
    const { accountLocalId } = await import('../workspace/account-cache')
    const { openAccountWorkspace } = await import('../workspace/account-graph')
    await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: before, head: candidate.head, records: candidate.records, validatedEvidence: candidate.inherited })
    const selected = await openAccountWorkspace(database, token, candidate.head)
    expect(selected.formatVersion).toBe(2)
    expect(selected.inheritedEvidence).toEqual(candidate.inherited.root)
    // This native-format case owns exact inherited-root identity; managed migration adds its own retained source graph
    const { localDataForSave, historyEntry } = await import('./local-data')
    const { afterLocalCommand } = await import('../workspace/planner-journal')
    const previous = selected.state.planner.localData, timestamp = new Date().toISOString() as typeof previous.updatedAt
    const saved = localDataForSave(previous, createPersonalDefinition(previous, { name: 'Synthetic successor', kind: 'item' }), previous.revision, timestamp)
    const entry = historyEntry(previous, saved.localData, saved.command, timestamp)
    const next = { ...selected.state, planner: afterLocalCommand(selected.state.planner, { ...selected.state.planner, localData: saved.localData, history: [...selected.state.planner.history, entry] }, entry) }
    const successorPrepared = await prepareAccountWorkspace(database, token, next, selected)
    const expected = (await database.profileMeta.get('active'))!
    const fence = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected, head: successorPrepared.head, records: successorPrepared.records })
    expect(fence.headRevision).toBe(expected.headRevision + 1)
    const successor = await openAccountWorkspace(database, token, fence.head)
    expect(successor.state.planner.localData).toEqual(saved.localData)
    expect(successor.state.planner.history).toEqual(next.planner.history)
    expect(successor.formatVersion).toBe(2)
    expect(successor.inheritedEvidence).toEqual(candidate.inherited.root)
  } finally { await candidate.dispose(); await source.dispose() }
})
it('failedEncryptionOrStaleTabPreservesPreviousCommit', async () => {
  const repository = await openAccountRepository(token)
  const original = await repository.load()
  await repository.save(createPersonalDefinition(original.localData, { name: privateTitle, kind: 'item' }), original.revision)
  const before = await activeDump()
  await expect(repository.save(original.localData, original.revision)).rejects.toMatchObject({ code: 'LOCAL_REVISION_CONFLICT' })
  expect(await activeDump()).toEqual(before)
  const current = await repository.load()
  // Inject at the native object-store boundary, including adapters with independently opened handles
  const add = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
    if (this.name === 'stagedCipherChunks') throw new DOMException('Synthetic quota', 'QuotaExceededError')
    return originalAdd.apply(this, args)
  })
  await expect(repository.save(createPersonalDefinition(current.localData, { name: 'Another private definition', kind: 'item' }), current.revision)).rejects.toBeDefined()
  add.mockRestore()
  expect(await activeDump()).toEqual(before)
  expect((await repository.load()).localData).toEqual(current.localData)
})
const originalAdd = IDBObjectStore.prototype.add
const originalPut = IDBObjectStore.prototype.put
it('restartIgnoresUnactivatedStaging', async () => {
  const repository = await openAccountRepository(token)
  const before = await repository.load()
  await database.stagedCipherChunks.put({ payloadId: 'unactivated', index: 0, bytes: new Uint8Array([1, 2, 3]) })
  const reopened = await openAccountRepository(token)
  expect(await reopened.load()).toEqual(before)
})
it('accountWritesNeverEnterGuestTables', async () => {
  await createGuestRepository().load()
  const guestBefore = await dump(guest)
  const repository = await openAccountRepository(token)
  const original = await repository.load()
  expect(Object.keys(original.localData.builds)).toHaveLength(0)
  expect(Object.keys(original.localData.playthroughs)).toHaveLength(0)
  await repository.save(createPersonalDefinition(original.localData, { name: privateTitle, kind: 'item' }), original.revision)
  await repository.undo((await repository.load()).revision)
  expect(await dump(guest)).toEqual(guestBefore)
  expect(JSON.stringify(await dump(database))).not.toContain(privateTitle)
})
it('rejects completion after account switch and preserves the committed ciphertext', async () => {
  const repository = await openAccountRepository(token)
  const original = await repository.load()
  const before = await activeDump()
  const pending = repository.save(createPersonalDefinition(original.localData, { name: privateTitle, kind: 'item' }), original.revision)
  invalidateProfile()
  installProfile('YmJiYmJiYmJiYmJiYmJiYg', crypto.getRandomValues(new Uint8Array(32)))
  await expect(pending).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
  expect(await activeDump()).toEqual(before)
  await expect(repository.load()).rejects.toMatchObject({ code: 'PROFILE_CHANGED' })
})
it('undo failure preserves the active history and retryable saved state', async () => {
  const repository = await openAccountRepository(token)
  const original = await repository.load()
  await repository.save(createPersonalDefinition(original.localData, { name: privateTitle, kind: 'item' }), original.revision)
  const current = await repository.load()
  const before = await activeDump()
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    if (this.name === 'profileMeta') throw new DOMException('Synthetic quota', 'QuotaExceededError')
    return originalPut.apply(this, args)
  })
  await expect(repository.undo(current.revision)).rejects.toBeDefined()
  put.mockRestore()
  expect(await activeDump()).toEqual(before)
  expect((await repository.load()).localData).toEqual(current.localData)
  expect(await repository.readHistory()).toHaveLength(1)
  await repository.undo(current.revision)
  expect(Object.keys((await repository.load()).localData.personalDefinitions)).toHaveLength(0)
})

it('unavailable crypto preserves the previous commit and the supplied draft', async () => {
  const repository = await openAccountRepository(token)
  const original = await repository.load()
  const draft = createPersonalDefinition(original.localData, { name: privateTitle, kind: 'item' })
  const before = await activeDump()
  const random = vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => { throw new Error('Crypto unavailable') })
  await expect(repository.save(draft, original.revision)).rejects.toThrow('Crypto unavailable')
  random.mockRestore()
  expect(await activeDump()).toEqual(before)
  expect(Object.values(draft.personalDefinitions)[0]!.name).toBe(privateTitle)
  await repository.save(draft, original.revision)
  expect(Object.values((await repository.load()).localData.personalDefinitions)[0]!.name).toBe(privateTitle)
})
it('forged broadcasts do not publish an unpersisted fence', async () => {
  const repository = await openAccountRepository(token)
  const events: unknown[] = []
  const stop = repository.subscribe(event => events.push(event))
  const channel = new BroadcastChannel(`crykit-account-${token.accountId}`)
  channel.postMessage({ headRevision: 999, localDataId: 'forged', revision: 999 })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(events).toEqual([])
  const other = await openAccountRepository(token)
  other.subscribe(() => {})
  const original = await other.load()
  await other.save(createPersonalDefinition(original.localData, { name: privateTitle, kind: 'item' }), original.revision)
  await vi.waitFor(() => expect(events).toHaveLength(1))
  expect(events[0]).toMatchObject({ localDataId: original.localData.id, revision: 1 })
  stop(); channel.close()
})
it('replays a source-only remote update with an unchanged planner revision', async () => {
  const reader = await openAccountRepository(token)
  const original = await reader.load()
  const early: unknown[] = []
  const stop = reader.subscribe(event => early.push(event))
  const { sha256, stableSourceId, nowTimestamp } = await import('../interchange/util')
  const bytes = new TextEncoder().encode('{"ID":"synthetic-source","Items":[]}')
  const digest = await sha256(bytes)
  await installSources(reader, [{ id: stableSourceId(digest), digest, filename: 'source.json', format: 'crystal-edit-json-1', mediaType: 'application/json', importedAt: nowTimestamp(), bytes }])
  const channel = new BroadcastChannel(`crykit-account-${token.accountId}`)
  channel.postMessage({ headRevision: 1 })
  await vi.waitFor(() => expect(early).toHaveLength(1))
  expect(early[0]).toMatchObject({ localDataId: original.localData.id, revision: original.revision, reason: 'sync' })
  stop()
  const late: unknown[] = []
  reader.subscribe(event => late.push(event))
  expect(late).toEqual(early)
  channel.close()
})
it('independent writers race on the persisted fence and leave one durable intent', async () => {
  const first = await openAccountRepository(token)
  const second = await openAccountRepository(token)
  const original = await first.load()
  const outcomes = await Promise.allSettled([
    first.save(createPersonalDefinition(original.localData, { name: 'First', kind: 'item' }), original.revision),
    second.save(createPersonalDefinition(original.localData, { name: 'Second', kind: 'item' }), original.revision),
  ])
  expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1)
  expect(outcomes.find(value => value.status === 'rejected')).toMatchObject({ reason: { code: 'LOCAL_REVISION_CONFLICT' } })
  expect(await database.outbox.count()).toBe(1)
  expect(await (await openAccountRepository(token)).readHistory()).toHaveLength(1)
})
it('planner recovery exports the captured account data and a failed draft without touching guest data', async () => {
  const repository = await openAccountRepository(token)
  const original = await repository.load()
  const draft = createPersonalDefinition(original.localData, { name: privateTitle, kind: 'item' })
  const bytes = await repository.exportPlannerBackup(draft)
  const preview = await repository.previewImport(bytes, 'recovery.zip')
  expect(Object.values(preview.proposed.localData.personalDefinitions)[0]!.name).toBe(privateTitle)
  expect((await repository.load()).localData).toEqual(original.localData)
  expect(await guest.localDatas.count()).toBe(0)
})

it('removal reports real pending intent and rejects an obsolete profile without clearing its ciphertext', async () => {
  const { accountPendingWork, removeEncryptedAccountData } = await import('../workspace/account-repository')
  const repository = await openAccountRepository(token)
  expect(await accountPendingWork(token)).toBe(false)
  const original = await repository.load()
  await repository.save(createPersonalDefinition(original.localData, { name: privateTitle, kind: 'item' }), original.revision)
  expect(await accountPendingWork(token)).toBe(true)
  const before = await dump(database)
  const pending = removeEncryptedAccountData(token)
  invalidateProfile()
  installProfile('YmJiYmJiYmJiYmJiYmJiYg', crypto.getRandomValues(new Uint8Array(32)))
  await expect(pending).rejects.toBeDefined()
  expect(await dump(database)).toEqual(before)
})
it('removal clears only the captured account ciphertext and leaves guest records intact', async () => {
  const { accountPendingWork, removeEncryptedAccountData } = await import('../workspace/account-repository')
  await createGuestRepository().load()
  const guestBefore = await dump(guest)
  await openAccountRepository(token)
  await removeEncryptedAccountData(token)
  expect(await accountPendingWork(token)).toBe(false)
  for (const table of database.tables) expect(await table.count()).toBe(0)
  expect(await dump(guest)).toEqual(guestBefore)
})

it('chunk staging failure preserves the active commit and restart retains exact sources and history', async () => {
  const { stageAccountBytes } = await import('../workspace/account-cache')
  const { plainChunkBytes } = await import('../account/protocol')
  const { sha256, stableSourceId, nowTimestamp } = await import('../interchange/util')
  const repository = await openAccountRepository(token)
  const before = await activeDump()
  const bytes = new Uint8Array(plainChunkBytes + 20).fill(65)
  const add = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
    if (this.name === 'stagedCipherChunks' && (args[0] as { index: number }).index === 1) throw new DOMException('Synthetic quota', 'QuotaExceededError')
    return originalAdd.apply(this, args)
  })
  await expect(stageAccountBytes(database, token, bytes, [])).rejects.toBeDefined()
  add.mockRestore()
  expect(await activeDump()).toEqual(before)
  expect(await database.stagedCipherChunks.count()).toBeGreaterThan(1)
  expect(await (await openAccountRepository(token)).load()).toEqual(await repository.load())
  const original = new TextEncoder().encode('Synthetic private source original\r\n')
  const digest = await sha256(original)
  await installSources(repository, [{ id: stableSourceId(digest), digest, filename: 'synthetic-private-source.json', format: 'crystal-edit-json-1', mediaType: 'application/json', importedAt: nowTimestamp(), bytes: original }])
  const selected = await openAccountRepository(token), loaded = await selected.load()
  await selected.save(createPersonalDefinition(loaded.localData, { name: privateTitle, kind: 'item' }), loaded.revision)
  await selected.undo((await selected.load()).revision)
  const reopened = await openAccountRepository(token)
  expect(await reopened.readHistory()).toHaveLength(2)
  expect((await reopened.readSources())[0]!.bytes).toEqual(original)
  const stored = JSON.stringify(await dump(database))
  expect(stored).not.toContain('Synthetic private source original')
  expect(stored).not.toContain('synthetic-private-source.json')
})

it('activation refuses foreign database handles and missing prepared heads', async () => {
  const { activateLocalAccountCommit } = await import('./account-database')
  await openAccountRepository(token)
  const before = await activeDump()
  const fence = (await database.profileMeta.get('active'))!
  const missing = { documentId: 'YmJiYmJiYmJiYmJiYmJiYg', revisionId: 'Y2NjY2NjY2NjY2NjY2NjYw' }
  await expect(activateLocalAccountCommit(database, token, { version: 1, id: missing.revisionId, expected: fence, head: missing, records: [] })).rejects.toMatchObject({ code: 'LOCAL_INTEGRITY_FAILED' })
  expect(await activeDump()).toEqual(before)
  const foreign = new AccountDatabase('ZGRkZGRkZGRkZGRkZGRkZA')
  try {
    await expect(activateLocalAccountCommit(foreign, token, { version: 1, id: missing.revisionId, expected: undefined, head: missing, records: [] })).rejects.toMatchObject({ code: 'LOCAL_INTEGRITY_FAILED' })
  } finally { await foreign.delete() }
})
it('encryption rejection never activates prepared data or a private intent', async () => {
  const cryptoModule = await import('../account/crypto/revisions')
  const repository = await openAccountRepository(token)
  const before = await activeDump()
  const original = await repository.load()
  const draft = createPersonalDefinition(original.localData, { name: privateTitle, kind: 'item' })
  const encrypt = vi.spyOn(cryptoModule, 'encryptRevision').mockRejectedValueOnce(new Error('Synthetic encryption failure'))
  await expect(repository.save(draft, original.revision)).rejects.toThrow('Synthetic encryption failure')
  encrypt.mockRestore()
  expect(await activeDump()).toEqual(before)
  expect((await repository.load()).localData).toEqual(original.localData)
  await repository.save(draft, original.revision)
})
it('guest adapters capture their original database handle', async () => {
  const repository = createGuestRepository()
  const original = await repository.load()
  const replacement = new CryKitDatabase(`replacement-${crypto.randomUUID()}`)
  setDatabaseForTests(replacement)
  try {
    await repository.save(createPersonalDefinition(original.localData, { name: 'Captured guest handle', kind: 'item' }), original.revision)
    expect(Object.values((await repository.load()).localData.personalDefinitions).some(value => value.name === 'Captured guest handle')).toBe(true)
    expect(await replacement.localDatas.count()).toBe(0)
  } finally { setDatabaseForTests(guest); await replacement.delete() }
})
it('generation invalidation aborts an activation already inside its native transaction', async () => {
  const repository = await openAccountRepository(token)
  const original = await repository.load()
  const before = await activeDump()
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    const request = originalPut.apply(this, args)
    if (this.name === 'profileMeta') invalidateProfile()
    return request
  })
  await expect(repository.save(createPersonalDefinition(original.localData, { name: privateTitle, kind: 'item' }), original.revision)).rejects.toBeDefined()
  put.mockRestore()
  expect(await activeDump()).toEqual(before)
})
it('source read completion cannot publish obsolete plaintext and clears all owned source buffers', async () => {
  const util = await import('../interchange/util')
  const repository = await openAccountRepository(token)
  const originals = ['First', 'Second', 'Last'].map(name => new TextEncoder().encode(`Synthetic private ${name} source`))
  const sources = await Promise.all(originals.map(async (bytes, index) => {
    const digest = await util.sha256(bytes)
    return { id: util.stableSourceId(digest), digest, filename: `synthetic-${index}.json`, format: 'crystal-edit-json-1' as const, mediaType: 'application/json', importedAt: util.nowTimestamp(), bytes }
  }))
  await installSources(repository, sources)
  const selected = await openAccountRepository(token)
  const blobs = await import('../workspace/blobs'), read = blobs.readBlob
  const owned: Uint8Array[] = []
  let finish!: () => void
  vi.spyOn(blobs, 'readBlob').mockImplementation(async (...args) => {
    const bytes = await read(...args)
    owned.push(bytes)
    if (owned.length === originals.length) await new Promise<void>(resolve => { finish = resolve })
    return bytes
  })
  const pending = selected.readSources().catch(error => error)
  await vi.waitFor(() => expect(finish).toBeDefined())
  expect(owned).toEqual(originals)
  invalidateProfile()
  installProfile('YmJiYmJiYmJiYmJiYmJiYg', crypto.getRandomValues(new Uint8Array(32)))
  finish()
  const result = await pending
  expect(result).toMatchObject({ code: 'PROFILE_CHANGED' })
  expect(owned.every(bytes => bytes.every(byte => byte === 0))).toBe(true)
  expect(originals.every(bytes => bytes.some(byte => byte !== 0))).toBe(true)
})

it.each(['saved', 'failed-draft'] as const)('highly compressible %s account recovery stays readable without changing saved state', async mode => {
  const { unzipSync } = await import('fflate')
  const repository = await openAccountRepository(token)
  const original = await repository.load()
  let draft = original.localData
  for (const marker of ['A', 'B', 'C', 'D']) draft = createPersonalDefinition(draft, { name: marker.repeat(64_000), kind: 'item' })
  if (mode === 'saved') await repository.save(draft, original.revision)
  else {
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'profileMeta') throw new DOMException('Synthetic quota', 'QuotaExceededError')
      return originalPut.apply(this, args)
    })
    await expect(repository.save(draft, original.revision)).rejects.toBeDefined()
    put.mockRestore()
  }
  const before = await activeDump()
  const persisted = await repository.load()
  const bytes = await repository.exportPlannerBackup(mode === 'saved' ? undefined : draft)
  const preview = await repository.previewImport(bytes, 'compressible-recovery.zip')
  expect(preview.proposed.localData.personalDefinitions).toEqual(draft.personalDefinitions)
  const files = unzipSync(bytes)
  expect(JSON.parse(new TextDecoder().decode(files['bundle.json']!)).localData.personalDefinitions).toEqual(draft.personalDefinitions)
  expect(await activeDump()).toEqual(before)
  expect(await repository.load()).toEqual(persisted)
  if (mode === 'failed-draft') expect(persisted.localData).toEqual(original.localData)
})

it('retains foreign history as evidence without selecting it for active planner undo', async () => {
  const { createBlankLocalData } = await import('../domain/local-data')
  const { historyEntry } = await import('./local-data')
  const { createAccountLocalStore } = await import('../workspace/account-local-store')
  const { admitLocalRoot, prepareLocalWorkspace } = await import('../workspace/local-root')
  const { activateLocalAccountCommit } = await import('./account-database')
  const { accountLocalId } = await import('../workspace/account-cache')
  const repository = await openAccountRepository(token), state = await repository.readWorkspace()
  const foreign = createBlankLocalData()
  const entry = historyEntry(foreign, { ...foreign, revision: 999 }, 'foreign-import', foreign.updatedAt)
  const fence = (await database.profileMeta.get('active'))!, store = createAccountLocalStore(database, token), operationId = accountLocalId()
  try {
    const previous = await admitLocalRoot(store.adapter, fence.head, store.lifetime)
    const prepared = await prepareLocalWorkspace(store.adapter, operationId, { ...state, planner: { ...state.planner, history: [entry] } }, store.lifetime, previous)
    await activateLocalAccountCommit(database, token, await store.prepareActivation(operationId, prepared, fence, previous))
    store.committed(operationId)
  } finally { await store.dispose() }
  const selected = await openAccountRepository(token)
  expect((await selected.load()).canUndo).toBe(false)
  await expect(selected.undo(state.planner.localData.revision)).rejects.toThrow('no saved change')
  const saved = await selected.save(createPersonalDefinition(state.planner.localData, { name: 'Own change', kind: 'item' }), state.planner.localData.revision)
  await selected.undo(saved.localData.revision)
  const after = await selected.readWorkspace()
  expect(after.planner.localData.id).toBe(state.planner.localData.id)
  expect(after.planner.localData.personalDefinitions).toEqual(state.planner.localData.personalDefinitions)
  expect(after.planner.history).toContainEqual(entry)
})

it('nativePlannerBackupPreservesNonemptyOriginalSources', async () => {
  const { sha256, stableSourceId, nowTimestamp } = await import('../interchange/util')
  const repository = await openAccountRepository(token)
  const bytes = new TextEncoder().encode('\ufeff{\r\n"csrf":"inert original content"}\r\n')
  const digest = await sha256(bytes)
  const source = { id: stableSourceId(digest), digest, filename: 'original.json', format: 'crystal-edit-json-1' as const, mediaType: 'application/json', importedAt: nowTimestamp(), bytes }
  await installSources(repository, [source])
  const selected = await openAccountRepository(token)
  const preview = await selected.previewImport(await selected.exportPlannerBackup(), 'nonempty.zip')
  expect(preview.proposed.sources).toEqual([source])
})
