import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountDatabase } from './account-database'
import { createServiceFixture, type ServiceFixture } from '../../worker/testing/service-fixture'
import { customer } from './sync-customer.test-helpers'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId } from '../workspace/account-cache'
import * as recovery from '../workspace/account-recovery'
import { editorClosureFixture } from '../workspace/test-helpers'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { exportWorkspaceBackup, readWorkspaceBackup } from '../interchange/workspace-backup'
import { disposeWorkspaceSnapshot, snapshotMetadata, type WorkspaceSnapshot } from '../workspace/snapshot'
import { readBlob } from '../workspace/blobs'

let service: ServiceFixture | undefined
let database: AccountDatabase | undefined
const snapshots: WorkspaceSnapshot[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const snapshot of snapshots.splice(0)) await disposeWorkspaceSnapshot(snapshot); invalidateProfile(); await database?.delete(); database = undefined; await service?.dispose(); service = undefined })
async function setup() {
  service = await createServiceFixture({ now: 1_800_000_000_000 })
  const session = await customer(service, 'recovery_client')
  const key = crypto.getRandomValues(new Uint8Array(32))
  const token = installProfile(session.accountId, key.slice(), session)
  database = new AccountDatabase(token.accountId)
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers); headers.set('cookie', session.headers.cookie); headers.set('origin', 'http://127.0.0.1')
    return service!.request(path, { ...init, headers })
  }
  vi.stubGlobal('fetch', request)
  return { token, session, key, request }
}
async function source(name = 'private recovery source') {
  const fixture = await editorClosureFixture()
  const raw: WorkspaceSnapshot = { version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: name, capturedAt: '2026-11-14T00:00:00.000Z', revisionVector: {}, state: { ...fixture.state, editorDocuments: [fixture.file] } }
  const snapshot = await readWorkspaceBackup(exportWorkspaceBackup(raw)); snapshots.push(snapshot); return snapshot
}
it('exports a complete encrypted recovery that another device can authenticate after local archive cleanup', async () => {
  expect(recovery.createAccountRecoveryService).toBeTypeOf('function')
  const { token, session, key } = await setup(), original = await source()
  const api = recovery.createAccountRecoveryService(token), operationId = accountLocalId()
  const point = await api.prepare(operationId, original)
  expect(point.sealed).toBe(true)
  expect(point.revisions[0].dependencies).toEqual([])
  expect(point.revisions[0].parents).toEqual([])
  expect(await database!.documentHeads.count()).toBe(0)
  expect(await database!.outbox.count()).toBe(0)
  expect(await database!.encryptedRevisions.get(point.revisions[0].revisionId)).toBeUndefined()
  expect(JSON.stringify(await database!.syncState.toArray())).not.toContain('private recovery source')
  expect((await service!.db.prepare('SELECT COUNT(*) AS n FROM sync_revisions').first<{ n: number }>())!.n).toBe(0)
  const expected = snapshotMetadata(original)
  await database!.delete(); database = undefined
  invalidateProfile()
  const second = recovery.createAccountRecoveryService(installProfile(session.accountId, key.slice(), session))
  const restored = await second.capture(operationId); snapshots.push(restored)
  expect(snapshotMetadata(restored)).toEqual(expected)
  expect(await readBlob(restored.state.blobs[0].content, 2)).toEqual(new Uint8Array([0, 216]))
  database = new AccountDatabase(session.accountId)
})
it('retains exact ciphertext through interruption and concurrent resume, including a lost seal acknowledgment', async () => {
  expect(recovery.createAccountRecoveryService).toBeTypeOf('function')
  const { token, request } = await setup(), original = await source(), operationId = accountLocalId()
  let fail = true
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (fail && path.includes('/chunks/') && init.method === 'PUT') throw new Error('offline upload')
    return request(path, init)
  })
  const api = recovery.createAccountRecoveryService(token)
  await expect(api.prepare(operationId, original)).rejects.toThrow('offline upload')
  const pending = (await api.list())[0], record = await database!.encryptedRevisions.get(pending.revisions[0].revisionId)
  expect(record).toBeDefined()
  const chunks = await database!.stagedCipherChunks.where('payloadId').equals(record!.payloadId).toArray()
  expect(chunks.length).toBeGreaterThan(0)
  expect(new TextDecoder().decode(chunks[0].bytes)).not.toContain('private recovery source')
  fail = false
  let lost = true
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const response = await request(path, init)
    if (lost && path.endsWith('/seal')) { lost = false; throw new Error('lost seal response') }
    return response
  })
  await expect(api.resume(operationId)).rejects.toThrow('lost seal response')
  const results = await Promise.all([api.resume(operationId), recovery.createAccountRecoveryService(token).resume(operationId)])
  expect(results.every(result => result.sealed)).toBe(true)
  expect(results[0].revisions).toEqual(pending.revisions)
  expect(await database!.stagedCipherChunks.where('payloadId').equals(record!.payloadId).count()).toBe(0)
  expect((await api.prepare(operationId, original)).revisions).toEqual(pending.revisions)
})

it('seals a self-contained successor that retains the original before exact binding and supersession', async () => {
  const { token } = await setup()
  const api = recovery.createAccountRecoveryService(token)
  expect(api.prepareSuccessor).toBeTypeOf('function')
  const { SyncClient } = await import('../account/sync/client')
  const { openHistoricalSnapshot } = await import('../workspace/snapshot')
  const client = new SyncClient(token, new AbortController().signal)
  const before = await source('before replacement'), after = await source('newly displaced')
  const old = await api.prepare(accountLocalId(), before)
  const target = await prepared(token)
  const publication = { ...command([target.descriptor]), expectedPublicationEpoch: 0, recoveryOperationId: old.operationId }
  await api.bind(old.operationId, publication)
  const next = await api.prepareSuccessor(accountLocalId(), after, old.operationId)
  const restored = await api.capture(next.operationId); snapshots.push(restored)
  expect(restored.state.planner).toEqual(after.state.planner)
  expect(restored.version).toBe(2)
  if (restored.version !== 2) throw new Error('Missing original evidence')
  expect(restored.historicalEvidence.snapshots).toHaveLength(1)
  const original = await openHistoricalSnapshot(restored, restored.historicalEvidence.snapshots[0].id)
  try { expect(snapshotMetadata(original)).toEqual(snapshotMetadata(before)); expect(await readBlob(original.state.blobs[0].content, 2)).toEqual(new Uint8Array([0, 216])) } finally { await disposeWorkspaceSnapshot(original) }
  await expect(api.supersede(next.operationId)).rejects.toThrow()
  const advance = await prepared(token)
  await client.commit(command([advance.descriptor]))
  const replacement = { ...command([target.descriptor]), expectedPublicationEpoch: 1, recoveryOperationId: next.operationId }
  await api.bind(next.operationId, replacement)
  const receipt = await api.supersede(next.operationId)
  expect(receipt).toMatchObject({ operationId: old.operationId, successorOperationId: next.operationId, successorMutationId: replacement.mutationId })
  expect(await api.supersede(next.operationId)).toEqual(receipt)
  expect((await api.list()).map(point => point.operationId)).toEqual([next.operationId])
  await client.commit(replacement)
  await expect(api.complete(next.operationId, accountLocalId())).rejects.toThrow()
  expect((await api.complete(next.operationId, replacement.mutationId)).state).toBe('completed')
  const roundtrip = await readWorkspaceBackup(exportWorkspaceBackup(restored)); snapshots.push(roundtrip)
  expect(snapshotMetadata(roundtrip)).toEqual(snapshotMetadata(restored))
})

it('cancels after an uncertain reserve only through a durable terminal server identity', async () => {
  const { token, request } = await setup(), original = await source(), operationId = accountLocalId()
  const api = recovery.createAccountRecoveryService(token)
  expect(api.cancelPreparation).toBeTypeOf('function')
  let interrupted = true
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (interrupted && path.endsWith('/recoveries') && init.method === 'POST') { interrupted = false; throw new Error('reserve did not arrive') }
    return request(path, init)
  })
  await expect(api.prepare(operationId, original)).rejects.toThrow('reserve did not arrive')
  const records = await database!.encryptedRevisions.toArray()
  expect(records).toHaveLength(2)
  expect((await api.cancelPreparation(operationId)).state).toBe('complete')
  expect(await database!.stagedCipherChunks.count()).toBeGreaterThan(0)
  expect((await api.list())).toEqual([])
  await expect(api.resume(operationId)).rejects.toThrow()
  const terminal = await service!.db.prepare('SELECT operation_id FROM cancelled_recoveries WHERE account_id=?').bind(token.accountId).all()
  expect(terminal.results.map(row => row.operation_id)).toEqual([operationId])
  expect(await database!.encryptedRevisions.count()).toBe(1)
})

async function prepared(token: ReturnType<typeof installProfile>) {
  const { stageAccountBytes } = await import('../workspace/account-cache')
  const { SyncClient } = await import('../account/sync/client')
  const client = new SyncClient(token, new AbortController().signal)
  const record = await stageAccountBytes(database!, token, new TextEncoder().encode('replacement document'), [])
  const descriptor = record.descriptor
  await client.startUpload({ version: 1, uploadId: descriptor.uploadId, documentId: descriptor.documentId, revisionId: descriptor.revisionId, metadataBytes: new TextEncoder().encode(JSON.stringify(descriptor)).length, chunks: descriptor.chunks })
  for (const chunk of descriptor.chunks) await client.putChunk(descriptor.uploadId, chunk.index, (await database!.stagedCipherChunks.get([record.payloadId, chunk.index]))!.bytes)
  await client.finishUpload(descriptor.uploadId)
  return { descriptor }
}
function command(revisions: readonly import('../account/protocol').RevisionDescriptor[]): import('../account/protocol').CommitRequest {
  return { version: 1, mutationId: accountLocalId(), revisions, heads: revisions.map(({ documentId, revisionId }) => ({ documentId, revisionId })), expected: revisions.map(({ documentId }) => ({ documentId, revisionId: null })) }
}

it('concurrent preparations install one durable identity and reject another source for that operation', async () => {
  const { token } = await setup(), original = await source(), operationId = accountLocalId()
  const left = recovery.createAccountRecoveryService(token), right = recovery.createAccountRecoveryService(token)
  const results = await Promise.all([left.prepare(operationId, original), right.prepare(operationId, original)])
  expect(results[0].revisions).toEqual(results[1].revisions)
  expect(await database!.encryptedRevisions.count()).toBe(1)
  expect(await database!.stagedCipherChunks.count()).toBe(1)
  await expect(right.prepare(operationId, await source('another original'))).rejects.toThrow('IDEMPOTENCY_MISMATCH')
})

it('independent successor validation rejects an otherwise valid archive that omits the original', async () => {
  const { token } = await setup(), original = await source('original'), displaced = await source('displaced')
  const api = recovery.createAccountRecoveryService(token), old = await api.prepare(accountLocalId(), original)
  const target = await prepared(token)
  await api.bind(old.operationId, { ...command([target.descriptor]), expectedPublicationEpoch: 0, recoveryOperationId: old.operationId })
  const evidence = await import('../interchange/workspace-backup-evidence'), inherit = evidence.inheritWorkspaceSnapshot
  vi.spyOn(evidence, 'inheritWorkspaceSnapshot').mockImplementation((current, _sources, options) => inherit(current, [], options))
  const existing = await database!.encryptedRevisions.count()
  await expect(api.prepareSuccessor(accountLocalId(), displaced, old.operationId)).rejects.toThrow('LOCAL_INTEGRITY_FAILED')
  expect((await api.list()).map(point => point.operationId)).toEqual([old.operationId])
  expect(await database!.encryptedRevisions.count()).toBe(existing)
})

it('keeps oversized originals and blocks before reading or copying an impossible raw-body budget', async () => {
  const { token } = await setup(), original = await source()
  const { ownWorkspaceSnapshot } = await import('../workspace/snapshot')
  let reads = 0
  const large = 129 * 1024 * 1024
  const oversized = ownWorkspaceSnapshot({ ...original, state: { ...original.state, blobs: original.state.blobs.map((blob, index) => index ? blob : { ref: { ...blob.ref, byteLength: large }, content: { byteLength: large, async *open() { reads++; throw new Error('oversized input read'); yield new Uint8Array() } } }) } }, { async check() {}, async dispose() {} })
  await expect(recovery.createAccountRecoveryService(token).prepare(accountLocalId(), oversized)).rejects.toThrow('QUOTA_EXCEEDED')
  expect(reads).toBe(0)
  expect(await database!.encryptedRevisions.count()).toBe(0)
  expect(await database!.stagedCipherChunks.count()).toBe(0)
  expect(await readBlob(original.state.blobs[0].content, 2)).toEqual(new Uint8Array([0, 216]))
})

it('replays cancellation after losing its response without retaining the archive', async () => {
  const { token, request } = await setup(), original = await source(), operationId = accountLocalId()
  const api = recovery.createAccountRecoveryService(token)
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => { if (path.includes('/chunks/') && init.method === 'PUT') throw new Error('offline'); return request(path, init) })
  await expect(api.prepare(operationId, original)).rejects.toThrow('offline')
  let lost = true
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => { const result = await request(path, init); if (lost && path.endsWith('/cancel')) { lost = false; throw new Error('lost cancel response') } return result })
  await expect(api.cancelPreparation(operationId)).rejects.toThrow('lost cancel response')
  expect((await api.cancelPreparation(operationId)).state).toBe('complete')
  expect(await database!.encryptedRevisions.count()).toBe(1)
  expect(await database!.stagedCipherChunks.count()).toBe(1)
})

it('requires successful exact binding acknowledgment before supersession after an uncertain response', async () => {
  const { token, request } = await setup(), api = recovery.createAccountRecoveryService(token)
  const { SyncClient } = await import('../account/sync/client')
  const client = new SyncClient(token, new AbortController().signal)
  const original = await api.prepare(accountLocalId(), await source('first'))
  const target = await prepared(token)
  await api.bind(original.operationId, { ...command([target.descriptor]), expectedPublicationEpoch: 0, recoveryOperationId: original.operationId })
  const successor = await api.prepareSuccessor(accountLocalId(), await source('second'), original.operationId)
  const advance = await prepared(token); await client.commit(command([advance.descriptor]))
  const publication = { ...command([target.descriptor]), expectedPublicationEpoch: 1, recoveryOperationId: successor.operationId }
  let lose = true
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const response = await request(path, init)
    if (lose && path.endsWith('/bind')) { lose = false; throw new Error('lost binding response') }
    return response
  })
  await expect(api.bind(successor.operationId, publication)).rejects.toThrow('lost binding response')
  await expect(api.supersede(successor.operationId)).rejects.toThrow()
  expect((await api.list())).toHaveLength(2)
  await api.bind(successor.operationId, publication)
  expect((await api.supersede(successor.operationId)).operationId).toBe(original.operationId)
})

it('preserves all saved categories, unknown Progress, conflicts, and history without publishing recovery history', async () => {
  const { token } = await setup()
  const fixture = await editorClosureFixture()
  const { createTestLocalData } = await import('../domain/test-helpers')
  const { createPersonalDefinition, asId, upsertProgress } = await import('../domain')
  const { historyEntry } = await import('./local-data')
  const { retainEditorRevision } = await import('../workspace/editor-document')
  const { retainFileRevision } = await import('../workspace/file-history')
  const before = createTestLocalData()
  let localData = createPersonalDefinition(before, { kind: 'class', name: 'Uncertain class' })
  const definition = Object.values(localData.personalDefinitions)[0]
  localData = upsertProgress(localData, { subject: { kind: 'personal', definitionId: asId(definition.id) }, displayName: 'Uncertain class', unlocked: { state: 'known', value: true }, collection: { state: 'unknown' }, partyMastery: { state: 'unknown' } })
  const checkpoint = historyEntry(before, localData, 'synthetic-progress', localData.updatedAt)
  const body = await fixture.add(new Uint8Array([7, 8, 9]), 'save-and-art', 'bytes')
  const other = { ...fixture.file, filename: 'other.json', revision: 1 }
  const root = await fixture.add(other, 'other-root')
  const index = await fixture.add({ version: 1, kind: 'conflict-closure-page', entries: [{ ...fixture.entries[0], ref: root }, fixture.entries[1]], children: [] }, 'other-index')
  const save = { version: 1 as const, id: 'unsupported-save', revision: 1, filename: 'private.dat', original: body, working: body, pendingForm: { invalid: 'unfinished' }, requirements: [], coverage: { status: 'unsupported' as const, diagnostics: ['Unknown codec'] }, createdAt: '2026-11-14', updatedAt: '2026-11-14', exportedRevision: null }
  const state: import('../workspace/documents').WorkspaceState = { ...fixture.state, planner: { ...fixture.state.planner, localData, lineage: { rootLocalDataId: localData.id }, history: [checkpoint], savedChanges: localData.changes, journal: { version: 1 as const, changes: localData.changes, checkpoints: [checkpoint], undoable: true } }, editorDocuments: [fixture.file], saveDocuments: [save], assets: [{ version: 1 as const, id: 'art', sourceKey: 'synthetic', relativePath: 'art.png', original: body, mediaType: 'image/png' as const, width: 1, height: 1 }], conflicts: [{ version: 1 as const, id: 'conflict', unit: { kind: 'record' as const, privateKey: fixture.entries[0].key }, commonAncestor: { kind: 'present' as const, closure: fixture.closure }, branches: [{ role: 'local-pending' as const, closure: fixture.closure }, { role: 'accepted-cloud' as const, closure: { version: 1 as const, root, index } }], disposition: { kind: 'unresolved' as const } }] }
  const history = await retainFileRevision(await retainEditorRevision(state, fixture.file, 'protected'), save, 'autosave-recovery')
  const original = await readWorkspaceBackup(exportWorkspaceBackup({ version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: 'all categories', capturedAt: '2026-11-14', revisionVector: {}, state: history })); snapshots.push(original)
  const api = recovery.createAccountRecoveryService(token), point = await api.prepare(accountLocalId(), original)
  const restored = await api.capture(point.operationId); snapshots.push(restored)
  expect(snapshotMetadata(restored)).toEqual(snapshotMetadata(original))
  expect(restored.state.editorDocuments[0].unfinished.validation).toBe('invalid')
  expect(restored.state.saveDocuments[0].pendingForm).toEqual({ invalid: 'unfinished' })
  expect(restored.state.conflicts[0].disposition.kind).toBe('unresolved')
  expect(restored.state.retainedContent.map(value => value.kind)).toEqual(['pending-content', 'file-history', 'file-history'])
  for (const blob of original.state.blobs) {
    const restoredBlob = restored.state.blobs.find(item => item.ref.documentId === blob.ref.documentId)!
    expect(await readBlob(restoredBlob.content, blob.ref.byteLength)).toEqual(await readBlob(blob.content, blob.ref.byteLength))
  }
  expect(await database!.documentHeads.count()).toBe(0)
})

it('rejects stale profile callbacks and authenticates second-device recovery with the account key', async () => {
  const { token, request, session, key } = await setup(), original = await source(), operationId = accountLocalId()
  const api = recovery.createAccountRecoveryService(token)
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => { const result = await request(path, init); if (path.endsWith('/seal')) invalidateProfile(); return result })
  await expect(api.prepare(operationId, original)).rejects.toThrow()
  await expect(api.resume(operationId)).rejects.toThrow()
  expect(await database!.encryptedRevisions.count()).toBe(2)
  vi.stubGlobal('fetch', request)
  const wrong = recovery.createAccountRecoveryService(installProfile(session.accountId, crypto.getRandomValues(new Uint8Array(32)), session))
  await expect(wrong.capture(operationId)).rejects.toThrow()
  invalidateProfile()
  const correct = recovery.createAccountRecoveryService(installProfile(session.accountId, key.slice(), session))
  expect((await correct.resume(operationId)).sealed).toBe(true)
  expect(await database!.encryptedRevisions.count()).toBe(1)
})

it('keeps exact staged ciphertext when account quota blocks reservation and retries it unchanged', async () => {
  const { token } = await setup(), original = await source(), operationId = accountLocalId(), api = recovery.createAccountRecoveryService(token)
  await service!.db.prepare('UPDATE accounts SET capacity_bytes=1 WHERE id=?').bind(token.accountId).run()
  await expect(api.prepare(operationId, original)).rejects.toThrow('QUOTA_EXCEEDED')
  const records = await database!.encryptedRevisions.toArray(), journalRefs = (await database!.syncState.toArray()).filter(row => row.id.startsWith('recovery:')).map(row => row.ref.revisionId), archive = records.find(record => !journalRefs.includes(record.revisionId))!
  expect(archive).toBeDefined()
  expect(await database!.documentHeads.count()).toBe(0)
  await service!.db.prepare('UPDATE accounts SET capacity_bytes=2147483648 WHERE id=?').bind(token.accountId).run()
  const point = await api.resume(operationId)
  expect(point.revisions[0].revisionId).toBe(archive.revisionId)
  expect(point.revisions[0].uploadId).toBe(archive.descriptor.uploadId)
})

it('does not drop the source or install retry authority when its capture changes between archive passes', async () => {
  const { token } = await setup(), original = await source()
  const { ownWorkspaceSnapshot } = await import('../workspace/snapshot')
  const streams = await import('../workspace/account-streams'), stage = streams.stageAccountSource
  let changed = false
  const captured = ownWorkspaceSnapshot(original, { async check() { if (changed) throw new Error('source capture changed') }, async dispose() {} })
  vi.spyOn(streams, 'stageAccountSource').mockImplementation((...args) => { changed = true; return stage(...args) })
  await expect(recovery.createAccountRecoveryService(token).prepare(accountLocalId(), captured)).rejects.toThrow('source capture changed')
  expect(await database!.encryptedRevisions.count()).toBe(0)
  expect(await database!.stagedCipherChunks.count()).toBe(0)
  expect(await readBlob(original.state.blobs[0].content, 2)).toEqual(new Uint8Array([0, 216]))
})

it('terminal cancellation fences a reserve request that arrives after cancellation returned', async () => {
  const { token, request } = await setup(), original = await source(), operationId = accountLocalId()
  const api = recovery.createAccountRecoveryService(token)
  let release!: () => void, entered!: () => void
  const arrived = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  let hold = true, reserveRequests = 0
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => { if (path.endsWith('/recoveries') && init.method === 'POST') reserveRequests++; if (hold && path.endsWith('/recoveries') && init.method === 'POST') { hold = false; entered(); await gate } return request(path, init) })
  const preparing = api.prepare(operationId, original)
  const outcome = preparing.then(() => undefined, error => error as Error)
  await arrived
  try { expect((await recovery.createAccountRecoveryService(token).cancelPreparation(operationId)).state).toBe('complete') } finally { release() }
  expect((await outcome)?.message).toBe('NOT_FOUND')
  expect(reserveRequests).toBe(1)
  expect(await api.list()).toEqual([])
  expect(await database!.encryptedRevisions.count()).toBe(1)
})

it('retains the pending original when the publication is uncertain and refuses a changed predecessor binding', async () => {
  const { token } = await setup(), api = recovery.createAccountRecoveryService(token)
  const { SyncClient } = await import('../account/sync/client')
  const client = new SyncClient(token, new AbortController().signal)
  const old = await api.prepare(accountLocalId(), await source('before')), target = await prepared(token)
  const first = { ...command([target.descriptor]), expectedPublicationEpoch: 0, recoveryOperationId: old.operationId }
  await api.bind(old.operationId, first)
  const next = await api.prepareSuccessor(accountLocalId(), await source('after'), old.operationId)
  await api.bind(next.operationId, { ...command([target.descriptor]), expectedPublicationEpoch: 0, recoveryOperationId: next.operationId })
  await expect(api.supersede(next.operationId)).rejects.toThrow('HEAD_CONFLICT')
  expect(await api.list()).toHaveLength(2)
  const advance = await prepared(token); await client.commit(command([advance.descriptor]))
  await client.bindRecoveryPublication({ version: 1, operationId: old.operationId, supersedesMutationId: first.mutationId, publication: { ...first, mutationId: accountLocalId(), expectedPublicationEpoch: 1 } })
  await expect(api.supersede(next.operationId)).rejects.toThrow('LOCAL_INTEGRITY_FAILED')
  expect(await api.list()).toHaveLength(2)
})

it('does not supersede an accepted original and lets a fresh instance complete its retained point', async () => {
  const { token } = await setup(), api = recovery.createAccountRecoveryService(token)
  const { SyncClient } = await import('../account/sync/client'), client = new SyncClient(token, new AbortController().signal)
  const old = await api.prepare(accountLocalId(), await source()), target = await prepared(token)
  const publication = { ...command([target.descriptor]), expectedPublicationEpoch: 0, recoveryOperationId: old.operationId }
  await api.bind(old.operationId, publication)
  await client.commit(publication)
  await expect(api.prepareSuccessor(accountLocalId(), await source('new'), old.operationId)).rejects.toThrow()
  expect((await recovery.createAccountRecoveryService(token).complete(old.operationId, publication.mutationId)).state).toBe('completed')
  expect((await api.cancelPreparation(old.operationId)).state).toBe('blocked')
  expect(await api.list()).toHaveLength(1)
})

it('independently rejects a successor producer that retains the original but replaces newly displaced current data', async () => {
  const { token } = await setup(), api = recovery.createAccountRecoveryService(token), before = await source('original'), after = await source('displaced')
  const old = await api.prepare(accountLocalId(), before), target = await prepared(token)
  await api.bind(old.operationId, { ...command([target.descriptor]), expectedPublicationEpoch: 0, recoveryOperationId: old.operationId })
  const evidence = await import('../interchange/workspace-backup-evidence'), inherit = evidence.inheritWorkspaceSnapshot
  vi.spyOn(evidence, 'inheritWorkspaceSnapshot').mockImplementation((current, sources, options) => sources.length ? inherit(sources[0], sources, options) : inherit(current, sources, options))
  await expect(api.prepareSuccessor(accountLocalId(), after, old.operationId)).rejects.toThrow('LOCAL_INTEGRITY_FAILED')
  expect(await api.list()).toHaveLength(1)
})

it('reconciles local retry ciphertext when a listed point was sealed by another caller', async () => {
  const { token, request } = await setup(), api = recovery.createAccountRecoveryService(token), operationId = accountLocalId()
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => { const response = await request(path, init); if (path.endsWith('/seal')) throw new Error('lost seal'); return response })
  await expect(api.prepare(operationId, await source())).rejects.toThrow('lost seal')
  expect(await database!.encryptedRevisions.count()).toBe(2)
  vi.stubGlobal('fetch', request)
  expect((await api.list())[0].sealed).toBe(true)
  expect(await database!.encryptedRevisions.count()).toBe(1)
})

it('releases retry ciphertext after exact remote terminal replay and never regenerates an expired archive', async () => {
  const { token, request } = await setup(), api = recovery.createAccountRecoveryService(token), operationId = accountLocalId(), original = await source()
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => { const response = await request(path, init); if (path.endsWith('/seal')) throw new Error('lost seal'); return response })
  await expect(api.prepare(operationId, original)).rejects.toThrow('lost seal')
  vi.stubGlobal('fetch', request)
  const { SyncClient } = await import('../account/sync/client'), client = new SyncClient(token, new AbortController().signal), target = await prepared(token)
  const publication = { ...command([target.descriptor]), expectedPublicationEpoch: 0, recoveryOperationId: operationId }
  await client.bindRecoveryPublication({ version: 1, operationId, publication }); await client.commit(publication); await client.completeRecovery(operationId)
  const point = (await client.listRecoveries()).points[0]
  const record = await database!.encryptedRevisions.get(point.revisions[0].revisionId)
  expect(record).toBeDefined()
  await client.removeRecovery(operationId)
  await expect(api.resume(operationId)).rejects.toThrow('NOT_FOUND')
  expect(await database!.encryptedRevisions.get(record!.revisionId)).toBeUndefined()
  expect(await database!.stagedCipherChunks.where('payloadId').equals(record!.payloadId).count()).toBe(0)
  await expect(api.prepare(operationId, original)).rejects.toThrow('NOT_FOUND')
  expect(await database!.encryptedRevisions.get(record!.revisionId)).toBeUndefined()
})

it('read-only reconciliation removes a lost-seal archive after second-device completion and expiry', async () => {
  const { token, request, session, key } = await setup(), api = recovery.createAccountRecoveryService(token), operationId = accountLocalId()
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => { const response = await request(path, init); if (path.endsWith('/seal')) throw new Error('lost seal'); return response })
  await expect(api.prepare(operationId, await source())).rejects.toThrow('lost seal')
  vi.stubGlobal('fetch', request)
  const { SyncClient } = await import('../account/sync/client'), client = new SyncClient(token, new AbortController().signal), target = await prepared(token)
  const point = (await client.listRecoveries()).points[0], archive = (await database!.encryptedRevisions.get(point.revisions[0].revisionId))!
  const publication = { ...command([target.descriptor]), expectedPublicationEpoch: 0, recoveryOperationId: operationId }
  await client.bindRecoveryPublication({ version: 1, operationId, publication }); await client.commit(publication); await client.completeRecovery(operationId)
  service!.advance(30 * 24 * 60 * 60 * 1000)
  await service!.runJobs()
  const renewed = await renewSession()
  Object.assign(session, renewed)
  invalidateProfile()
  const reopened = recovery.createAccountRecoveryService(installProfile(session.accountId, key.slice(), renewed))
  await service!.db.prepare('UPDATE accounts SET capacity_bytes=1 WHERE id=?').bind(session.accountId).run()
  const methods: string[] = []
  vi.stubGlobal('fetch', (path: string, init: RequestInit) => { methods.push(init.method ?? 'GET'); return request(path, init) })
  expect(await reopened.list()).toEqual([])
  expect(methods.every(method => method === 'GET')).toBe(true)
  expect(await database!.encryptedRevisions.get(archive.revisionId)).toBeUndefined()
  expect(await database!.stagedCipherChunks.where('payloadId').equals(archive.payloadId).count()).toBe(0)
  expect(await service!.db.prepare('SELECT COUNT(*) FROM account_recoveries').first('COUNT(*)')).toBe(0)
})

it('bounds concurrent distinct failed preparations locally and keeps unreserved retry originals during read-only reconciliation', async () => {
  const { token, request } = await setup(), original = await source()
  const api = recovery.createAccountRecoveryService(token)
  vi.stubGlobal('fetch', (path: string, init: RequestInit) => {
    if (path.endsWith('/recoveries') && init.method === 'POST') throw new Error('reserve offline')
    return request(path, init)
  })
  const ids = Array.from({ length: 4 }, () => accountLocalId())
  const results = await Promise.allSettled(ids.map(id => recovery.createAccountRecoveryService(token).prepare(id, original)))
  expect(results.every(result => result.status === 'rejected')).toBe(true)
  expect(results.filter(result => result.status === 'rejected' && result.reason.message === 'QUOTA_EXCEEDED')).toHaveLength(1)
  const live = (await database!.syncState.toArray()).filter(row => row.id.startsWith('recovery-payload:'))
  expect(live).toHaveLength(3)
  expect(await database!.encryptedRevisions.count()).toBe(6)
  const requests: string[] = []
  vi.stubGlobal('fetch', (path: string, init: RequestInit) => { requests.push(init.method ?? 'GET'); return request(path, init) })
  expect(await api.list()).toEqual([])
  expect(requests.every(method => method === 'GET')).toBe(true)
  expect(await database!.encryptedRevisions.count()).toBe(6)
  await expect(api.prepare(accountLocalId(), original)).rejects.toThrow('QUOTA_EXCEEDED')
  expect(await database!.encryptedRevisions.count()).toBe(6)
  for (const row of live) expect(await database!.encryptedRevisions.get(row.ref.revisionId)).toBeDefined()
})

it('bounds retained local retry bytes across distinct quota-rejected operations before staging another large candidate', async () => {
  const { token, request } = await setup(), original = await source()
  const { ownWorkspaceSnapshot } = await import('../workspace/snapshot')
  const { hashBlob } = await import('../workspace/blobs')
  const byteLength = 65 * 1024 * 1024, pageBytes = 256 * 1024
  let traversals = 0
  const content = { byteLength, async *open() { traversals++; for (let offset = 0; offset < byteLength; offset += pageBytes) yield new Uint8Array(Math.min(pageBytes, byteLength - offset)) } }
  const ref = { documentId: 'large-save', revisionId: 'large-save:1', byteLength, sha256: await hashBlob(content), encoding: 'bytes' as const }
  const large = ownWorkspaceSnapshot({ ...original, state: { ...original.state, blobs: [...original.state.blobs, { ref, content }], saveDocuments: [{ version: 1, id: 'large-save', revision: 0, filename: 'synthetic.dat', original: ref, working: ref, pendingForm: {}, requirements: [], coverage: { status: 'unsupported', diagnostics: [] }, createdAt: '2026-11-14', updatedAt: '2026-11-14', exportedRevision: null }] } }, { async check() {}, async dispose() {} })
  vi.stubGlobal('fetch', (path: string, init: RequestInit) => { if (path.endsWith('/recoveries') && init.method === 'POST') throw new Error('quota unavailable'); return request(path, init) })
  const api = recovery.createAccountRecoveryService(token)
  await expect(api.prepare(accountLocalId(), large)).rejects.toThrow('quota unavailable')
  const priorReads = traversals, records = (await database!.encryptedRevisions.toArray()).map(record => record.revisionId)
  await expect(api.prepare(accountLocalId(), large)).rejects.toThrow('QUOTA_EXCEEDED')
  expect(traversals).toBe(priorReads)
  expect((await database!.encryptedRevisions.toArray()).map(record => record.revisionId)).toEqual(records)
})

async function renewSession() {
  const opaque = await import('../account/crypto/opaque')
  const password = 'synthetic sync acceptance password'
  const post = (path: string, body: unknown) => service!.request(`/api/v1/auth/${path}`, { method: 'POST', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const login = await opaque.startLogin(password)
  const challenge = await (await post('login/start', { email: 'recovery_client@example.org', role: 'password', startLoginRequest: login.request })).json() as { attemptId: string; credentialId: string; loginResponse: string }
  const finish = await opaque.finishLogin(login.state, challenge.loginResponse, password, challenge.credentialId)
  const response = await post('login/finish', { attemptId: challenge.attemptId, finishLoginRequest: finish.request, remember: true })
  expect(response.status).toBe(200)
  const session = await response.json() as Omit<import('../account/auth-client').UnlockResult, 'key'>
  return { ...session, headers: { cookie: response.headers.get('set-cookie')!.split(';')[0], 'x-csrf-token': session.csrf } }
}

it('reuses successor ciphertext and its encrypted coverage receipt after upload interruption', async () => {
  const { token, request } = await setup(), api = recovery.createAccountRecoveryService(token), original = await source('first'), displaced = await source('second')
  const old = await api.prepare(accountLocalId(), original), target = await prepared(token)
  await api.bind(old.operationId, { ...command([target.descriptor]), expectedPublicationEpoch: 0, recoveryOperationId: old.operationId })
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => { if (path.includes('/chunks/') && init.method === 'PUT') throw new Error('successor offline'); return request(path, init) })
  const operationId = accountLocalId()
  await expect(api.prepareSuccessor(operationId, displaced, old.operationId)).rejects.toThrow('successor offline')
  const pending = (await api.list()).find(point => point.operationId === operationId)!
  expect(pending.sealed).toBe(false)
  vi.stubGlobal('fetch', request)
  const fresh = recovery.createAccountRecoveryService(token)
  expect((await fresh.prepareSuccessor(operationId, displaced, old.operationId)).revisions).toEqual(pending.revisions)
  const { SyncClient } = await import('../account/sync/client'), client = new SyncClient(token, new AbortController().signal), advance = await prepared(token)
  await client.commit(command([advance.descriptor]))
  const publication = { ...command([target.descriptor]), expectedPublicationEpoch: 1, recoveryOperationId: operationId }
  await fresh.bind(operationId, publication)
  expect((await fresh.supersede(operationId)).operationId).toBe(old.operationId)
  const recovered = await fresh.capture(operationId); snapshots.push(recovered)
  expect(recovered.state.planner).toEqual(displaced.state.planner)
  expect(recovered.version === 2 && recovered.historicalEvidence.snapshots.length).toBe(1)
})

it('carries every previously inherited original into the next self-contained successor', async () => {
  const { token } = await setup(), api = recovery.createAccountRecoveryService(token)
  const evidence = await import('../interchange/workspace-backup-evidence'), { openHistoricalSnapshot } = await import('../workspace/snapshot')
  const earliest = await source('earliest original'), priorCurrent = await source('previous current'), current = await source('new displacement')
  const prior = await evidence.inheritWorkspaceSnapshot(priorCurrent, [earliest]); snapshots.push(prior)
  const old = await api.prepare(accountLocalId(), prior), target = await prepared(token)
  await api.bind(old.operationId, { ...command([target.descriptor]), expectedPublicationEpoch: 0, recoveryOperationId: old.operationId })
  const successor = await api.prepareSuccessor(accountLocalId(), current, old.operationId), restored = await api.capture(successor.operationId); snapshots.push(restored)
  expect(restored.state.planner).toEqual(current.state.planner)
  if (restored.version !== 2) throw new Error('Missing inherited originals')
  const names: string[] = []
  for (const entry of restored.historicalEvidence.snapshots) {
    const historical = await openHistoricalSnapshot(restored, entry.id)
    try { names.push(historical.snapshotId); expect(await readBlob(historical.state.blobs[0].content, 2)).toEqual(new Uint8Array([0, 216])) } finally { await disposeWorkspaceSnapshot(historical) }
  }
  expect(names.sort()).toEqual(['earliest original', 'previous current'])
})
