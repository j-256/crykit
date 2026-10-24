import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile } from '../account/profile'
import { AccountDatabase, activateLocalAccountCommit } from '../persistence/account-database'
import { accountLocalId, openAccountJson } from './account-cache'
import { openAccountRepository } from './account-repository'
import { LocalWorkspaceRootV3Schema } from './local-root'
import { createPersonalDefinition } from '../domain'
import { editorClosureFixture } from './test-helpers'
import { prepareAccountWorkspace } from './account-graph'
import { captureWorkspaceSnapshot, disposeWorkspaceSnapshot, openHistoricalSnapshot, ownWorkspaceSnapshot } from './snapshot'
import { createGuestCopyService } from './guest-copy'
import { blobIdentity, readBlob } from './blobs'

// This startup contract fixture is closed without bundled definitions; native catalogs have separate browser coverage
vi.mock('../catalog/bundled', async importOriginal => ({ ...await importOriginal<typeof import('../catalog/bundled')>(), BUNDLED_CATALOGS: [] }))

it('opens a fresh account directly as managed storage and reopens exact offline ordinary history', async () => {
  const id = accountLocalId(), key = crypto.getRandomValues(new Uint8Array(32))
  let token = installProfile(id, key.slice()), database = new AccountDatabase(id)
  try {
    const repository = await openAccountRepository(token), initial = await repository.load()
    expect(Object.keys(initial.localData.playthroughs)).toEqual([])
    const fence = (await database.profileMeta.get('active'))!
    expect((await openAccountJson(database, token, fence.head, LocalWorkspaceRootV3Schema)).kind).toBe('incremental-local-workspace')
    expect(await database.outbox.count()).toBe(0)
    expect(await database.migrationJournal.count()).toBe(1)
    const saved = await repository.save(createPersonalDefinition(initial.localData, { kind: 'item', name: 'Fresh local durable account' }), initial.revision)
    const exact = await repository.readWorkspace()
    expect((await database.outbox.toArray())[0]!.status).toBe('unmapped-local')
    invalidateProfile(); database.close(); token = installProfile(id, key.slice()); database = new AccountDatabase(id)
    const reopened = await openAccountRepository(token)
    expect((await reopened.readWorkspace()).planner).toEqual(exact.planner)
    expect((await reopened.load()).canUndo).toBe(true)
    expect((await reopened.undo(saved.localData.revision)).localData.personalDefinitions).toEqual(initial.localData.personalDefinitions)
  } finally { database.close(); invalidateProfile(); key.fill(0) }
}, 30_000)

it('opens a completed first guest copy without another storage conversion or encrypted rewrite', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId), fixture = await editorClosureFixture()
  const state = { ...fixture.state, editorDocuments: [fixture.file] }
  const original = ownWorkspaceSnapshot({ version: 1, snapshotId: 'first-account-copy', capturedAt: fixture.file.updatedAt, revisionVector: {}, state }, { check: async () => {}, dispose: async () => {} })
  const service = createGuestCopyService(async () => original)
  try {
    const preview = await service.previewGuestCopy(token, ['["editor","editor-1"]'])
    const initial = (await database.profileMeta.get('active'))!
    const baselineRecords = await database.encryptedRevisions.toArray()
    await openAccountRepository(token)
    expect(await database.profileMeta.get('active')).toEqual(initial)
    expect(await database.encryptedRevisions.toArray()).toEqual(baselineRecords)
    expect(await database.outbox.count()).toBe(0)
    const receipt = await service.commitGuestCopy(token, preview)
    expect((await database.outbox.toArray()).map(row => row.status)).toEqual(['unmapped-local'])
    const selected = await database.profileMeta.get('active')
    const records = await database.encryptedRevisions.toArray(), chunks = await database.stagedCipherChunks.toArray()
    const repository = await openAccountRepository(token)
    expect(await database.profileMeta.get('active')).toEqual(selected)
    expect(await database.encryptedRevisions.toArray()).toEqual(records)
    expect(await database.stagedCipherChunks.toArray()).toEqual(chunks)
    const reopened = await repository.readWorkspace()
    expect(reopened.editorDocuments).toEqual([fixture.file])
    for (const body of state.blobs) expect(await readBlob(reopened.blobs.find(value => blobIdentity(value.ref) === blobIdentity(body.ref))!.content, body.ref.byteLength)).toEqual(await readBlob(body.content, body.ref.byteLength))
    expect(await service.commitGuestCopy(token, preview)).toEqual(receipt)
    expect(await database.profileMeta.get('active')).toEqual(selected)
  } finally { await service.dispose(); database.close(); invalidateProfile() }
}, 30_000)

it('migrates an existing native account on opening and preserves the exact native original and operative planner', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  let backup: Awaited<ReturnType<typeof captureWorkspaceSnapshot>> | undefined
  try {
    const fixture = await editorClosureFixture(), native = await prepareAccountWorkspace(database, token, fixture.state)
    const old = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: native.head, records: native.records, intentStatus: 'mapped-local' })
    const rows = await database.encryptedRevisions.toArray(), chunks = await database.stagedCipherChunks.toArray()
    const repository = await openAccountRepository(token), selected = (await database.profileMeta.get('active'))!
    expect(selected.head).not.toEqual(old.head)
    expect((await openAccountJson(database, token, selected.head, LocalWorkspaceRootV3Schema)).kind).toBe('incremental-local-workspace')
    expect((await repository.readWorkspace()).planner).toEqual(fixture.state.planner)
    for (const row of rows) expect(await database.encryptedRevisions.get(row.revisionId)).toEqual(row)
    for (const chunk of chunks) expect(await database.stagedCipherChunks.get([chunk.payloadId, chunk.index])).toEqual(chunk)
    backup = await captureWorkspaceSnapshot(repository)
    if (backup.version !== 2) throw new Error('The native account original was not retained')
    const historical = await openHistoricalSnapshot(backup, backup.historicalEvidence.snapshots[0]!.id)
    try { expect(historical.state.planner).toEqual(fixture.state.planner); expect(historical.state.editorDocuments).toEqual(fixture.state.editorDocuments) }
    finally { await disposeWorkspaceSnapshot(historical) }
    const repeated = await openAccountRepository(token)
    expect((await repeated.readWorkspace()).planner).toEqual(fixture.state.planner)
    expect(await database.profileMeta.get('active')).toEqual(selected)
  } finally { if (backup) await disposeWorkspaceSnapshot(backup); database.close(); invalidateProfile() }
}, 30_000)

it('rolls back failed opening migration and preserves the native source for retry', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    const fixture = await editorClosureFixture(), native = await prepareAccountWorkspace(database, token, fixture.state)
    const old = await activateLocalAccountCommit(database, token, { version: 1, id: accountLocalId(), expected: undefined, head: native.head, records: native.records, intentStatus: 'mapped-local' })
    const rows = await database.encryptedRevisions.toArray(), chunks = await database.stagedCipherChunks.toArray(), journal = await database.migrationJournal.toArray()
    const put = IDBObjectStore.prototype.put
    const failed = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      if (this.name === 'profileMeta') throw new DOMException('Synthetic migration activation failure', 'QuotaExceededError')
      return put.apply(this, args)
    })
    await expect(openAccountRepository(token)).rejects.toThrow('Synthetic migration activation failure')
    expect(await database.profileMeta.get('active')).toEqual(old)
    expect(await database.migrationJournal.toArray()).toEqual(journal)
    for (const row of rows) expect(await database.encryptedRevisions.get(row.revisionId)).toEqual(row)
    for (const chunk of chunks) expect(await database.stagedCipherChunks.get([chunk.payloadId, chunk.index])).toEqual(chunk)
    failed.mockRestore()
    expect((await (await openAccountRepository(token)).readWorkspace()).planner).toEqual(fixture.state.planner)
  } finally { vi.restoreAllMocks(); database.close(); invalidateProfile() }
}, 30_000)

it('concurrent first openings use one selected managed root without reseeding', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    const [first, second] = await Promise.all([openAccountRepository(token), openAccountRepository(token)])
    expect(await first.load()).toEqual(await second.load())
    expect(await database.migrationJournal.count()).toBe(1)
    expect(await database.outbox.count()).toBe(0)
  } finally { database.close(); invalidateProfile() }
}, 30_000)
