import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountDatabase, activateLocalAccountCommit } from './account-database'
import { installProfile, invalidateProfile, type ProfileToken } from '../account/profile'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { createBlankLocalData } from '../domain/local-data'
import type { WorkspaceState } from '../workspace/documents'
import { accountLocalId } from '../workspace/account-cache'
import { openAccountRepository } from '../workspace/account-repository'
import { openAccountWorkspace, prepareAccountWorkspace } from '../workspace/account-graph'
import { activatePulledState, stagePull, assertPullHighWater } from '../account/sync/pull'
import { transferBudget } from '../account/sync/outbox'
import type { SyncClient } from '../account/sync/client'
import { SyncError } from '../account/sync/client'

let database: AccountDatabase | undefined
afterEach(async () => { invalidateProfile(); await database?.delete() })

async function initializeNativeWorkspace(token: ProfileToken) {
  const db = database = new AccountDatabase(token.accountId)
  const localData = createBlankLocalData()
  const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: BUNDLED_CATALOGS, evidence: [], sources: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], libraryDefaults: { version: 1, layers: [] }, conflicts: [], retainedContent: [], blobs: [] }
  // These native publication and admission cases retain the pre-managed persisted root format
  // The public opener migrates that format, so it cannot initialize these exact reader fixtures
  const prepared = await prepareAccountWorkspace(db, token, state)
  await activateLocalAccountCommit(db, token, { version: 1, id: accountLocalId(), expected: undefined, head: prepared.head, records: prepared.records, intentStatus: 'mapped-local' })
  return { database: db, readWorkspace: async () => (await openAccountWorkspace(db, token, (await db.profileMeta.get('active'))!.head)).state }
}

it('rejectsCursorRollbackAgainstHighWaterMark', () => {
  const page = { version: 1 as const, mode: 'initial' as const, watermark: 8, publicationEpoch: 2, groups: [], hasMore: false, cursor: 'opaque-cursor' }
  expect(() => assertPullHighWater(page, { watermark: 9, publicationEpoch: 2 })).toThrow('STALE_CURSOR')
  expect(() => assertPullHighWater(page, { watermark: 7, publicationEpoch: 3 })).toThrow('STALE_CURSOR')
})
it('pullDoesNotReplaceDirtyOrValidLocalState', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const { database, readWorkspace } = await initializeNativeWorkspace(token)
  const fence = (await database.profileMeta.get('active'))!, before = await readWorkspace()
  const client = { changes: async () => ({ version: 1, mode: 'initial', watermark: 0, publicationEpoch: 0, groups: [], hasMore: false, cursor: 'opaque-cursor' }) } as unknown as SyncClient
  await expect(stagePull(database, token, client, async () => { throw new SyncError('INTEGRITY_FAILED') }, transferBudget())).rejects.toThrow('INTEGRITY_FAILED')
  expect(await database.syncState.get('remote')).toBeUndefined()
  expect(await readWorkspace()).toEqual(before)
  const candidate = (await stagePull(database, token, client, async () => {}, transferBudget()))!
  const local = await openAccountWorkspace(database, token, fence.head)
  const prepared = await prepareAccountWorkspace(database, token, local.state, local)
  let draft = false
  // The draft appears after cryptographic preparation, just before the actual pointer transaction
  draft = true
  await expect(activatePulledState(database, token, candidate, fence, prepared, undefined, undefined, () => { if (draft) throw new SyncError('LOCAL_REVISION_CONFLICT') })).rejects.toThrow('LOCAL_REVISION_CONFLICT')
  expect(await database.profileMeta.get('active')).toEqual(fence)
  expect(await database.syncState.get('remote')).toBeUndefined()
  expect(await readWorkspace()).toEqual(before)
  expect(await database.syncState.get('scan')).toBeDefined()
})
it('keepsInitialPagesInactiveUntilTheFixedSnapshotAndRejectsChangedWatermarks', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const repository = await openAccountRepository(token)
  database = new AccountDatabase(token.accountId)
  const fence = (await database.profileMeta.get('active'))!
  let calls = 0, validations = 0
  const first = { version: 1, mode: 'initial', watermark: 4, publicationEpoch: 2, groups: [], hasMore: true, cursor: 'initial-page-2' }
  const client = { changes: async () => ++calls === 1 ? first : { ...first, watermark: 5, hasMore: false, cursor: 'end' } } as unknown as SyncClient
  expect(await stagePull(database, token, client, async () => { validations++ }, transferBudget())).toBeNull()
  expect(validations).toBe(0)
  expect(await database.syncState.get('remote')).toBeUndefined()
  await expect(stagePull(database, token, client, async () => { validations++ }, transferBudget())).rejects.toThrow('INTEGRITY_FAILED')
  expect(validations).toBe(0)
  expect(await database.profileMeta.get('active')).toEqual(fence)
  const finalClient = { changes: async () => ({ ...first, hasMore: false, cursor: 'end' }) } as unknown as SyncClient
  const candidate = (await stagePull(database, token, finalClient, async () => { validations++ }, transferBudget()))!
  expect(candidate.state).toMatchObject({ watermark: 4, publicationEpoch: 2, initialComplete: true })
  expect(await database.syncState.get('remote')).toBeUndefined()
  await activatePulledState(database, token, candidate, fence)
  expect(await database.syncState.get('remote')).toBeDefined()
  expect((await repository.load()).revision).toBe(0)
})
it('rejectsAnIncrementalGroupAsAWholeBeforePublishingAnyHeadOrHighWater', async () => {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  await openAccountRepository(token)
  database = new AccountDatabase(token.accountId)
  const fence = (await database.profileMeta.get('active'))!
  const firstClient = { changes: async () => ({ version: 1, mode: 'initial', watermark: 1, publicationEpoch: 1, groups: [], hasMore: false, cursor: 'incremental-start' }) } as unknown as SyncClient
  const initial = (await stagePull(database, token, firstClient, async () => {}, transferBudget()))!
  await activatePulledState(database, token, initial, fence)
  const before = await database.syncState.get('remote')
  const heads = [{ documentId: accountLocalId(), revisionId: accountLocalId() }, { documentId: accountLocalId(), revisionId: accountLocalId() }]
  const incremental = { changes: async () => ({ version: 1, mode: 'incremental', watermark: 2, publicationEpoch: 2, groups: [{ sequence: 2, publicationEpoch: 2, mutationId: accountLocalId(), heads, revisions: [] }], hasMore: false, cursor: 'incremental-end' }) } as unknown as SyncClient
  let observed: ReadonlyMap<string, string> | undefined
  await expect(stagePull(database, token, incremental, async values => { observed = values; throw new SyncError('INTEGRITY_FAILED') }, transferBudget())).rejects.toThrow('INTEGRITY_FAILED')
  expect(observed?.size).toBe(2)
  expect(await database.syncState.get('remote')).toEqual(before)
  expect(await database.profileMeta.get('active')).toEqual(fence)
})
it.each(['replay', 'descendant'] as const)('resumedIncrementalPagesValidateTheirExactPredecessor%s', async schedule => {
  const { vi } = await import('vitest')
  const { preparePublicationAttempt, stagePublicationRecord } = await import('../account/sync/publication')
  const { openRemoteProjection } = await import('../account/sync/projection')
  const { registerSyncProjectionGuard, runSyncIteration } = await import('../account/sync/outbox')
  const { readRemoteState } = await import('../account/sync/pull')
  const accountId = accountLocalId()
  const token = installProfile(accountId, crypto.getRandomValues(new Uint8Array(32)), { accountId, username: 'synthetic', sessionId: accountLocalId(), deviceId: accountLocalId(), csrf: 'synthetic', authenticatedAt: 1 })
  const { database, readWorkspace } = await initializeNativeWorkspace(token)
  const local = await openAccountWorkspace(database, token, (await database.profileMeta.get('active'))!.head)
  const initial = await preparePublicationAttempt(database, token, local, null, new Map(), 0)
  const heads = new Map(initial.final.heads.map(ref => [ref.documentId, ref.revisionId]))
  const projection = (await openRemoteProjection(database, token, heads, local.head, 0))!
  const unit = [...projection.units.values()].find(unit => unit.body.kind !== 'workspace-identity')!
  const b = await stagePublicationRecord(database, token, unit.body, projection.lineageId, unit.ref)
  const c = await stagePublicationRecord(database, token, unit.body, projection.lineageId, { documentId: b.descriptor.documentId, revisionId: b.revisionId })
  const group = (sequence: number, heads: readonly import('./account-database').CipherRef[]) => ({ sequence, mutationId: accountLocalId(), heads, revisions: [] })
  const pages = [
    { version: 1, mode: 'initial', watermark: 1, publicationEpoch: 1, groups: [group(1, initial.final.heads)], hasMore: false, cursor: 'start' },
    { version: 1, mode: 'incremental', watermark: 3, publicationEpoch: 1, groups: [group(2, [{ documentId: b.descriptor.documentId, revisionId: b.revisionId }])], hasMore: true, cursor: 'next-page' },
    { version: 1, mode: 'incremental', watermark: 3, publicationEpoch: 1, groups: [group(3, [schedule === 'replay' ? unit.ref : { documentId: c.descriptor.documentId, revisionId: c.revisionId }])], hasMore: false, cursor: 'end' },
  ]
  const stop = registerSyncProjectionGuard(token, () => true)
  vi.stubGlobal('fetch', async (path: string) => { expect(path).toContain('/changes'); const page = pages.shift(); if (!page) throw new Error('Unexpected request'); return Response.json(page) })
  try {
    expect((await runSyncIteration(token, new AbortController().signal)).state).toBe('synced')
    const durable = await database.syncState.get('remote'), fence = await database.profileMeta.get('active'), state = await readWorkspace()
    expect((await runSyncIteration(token, new AbortController().signal)).moreWork).toBe(true)
    expect(await database.syncState.get('remote')).toEqual(durable)
    // A new iteration reconstructs its validator, as after foreground suspension or process restart
    if (schedule === 'replay') {
      await expect(runSyncIteration(token, new AbortController().signal)).rejects.toThrow('INTEGRITY_FAILED')
      expect(await database.syncState.get('remote')).toEqual(durable)
      expect(await database.profileMeta.get('active')).toEqual(fence)
      expect(await readWorkspace()).toEqual(state)
      expect((await readRemoteState(database, token))!.value.watermark).toBe(1)
    } else {
      expect((await runSyncIteration(token, new AbortController().signal)).state).toBe('synced')
      expect((await readRemoteState(database, token))!.value.watermark).toBe(3)
    }
  } finally { stop(); vi.unstubAllGlobals() }
})

it('chunkBudgetRetriesDoNotReplayCompletedGroupsBeforeTheNextClosureIsReady', async () => {
  const { preparePublicationAttempt, stagePublicationRecord } = await import('../account/sync/publication')
  const { openRemoteProjection } = await import('../account/sync/projection')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const { database } = await initializeNativeWorkspace(token)
  const fence = (await database.profileMeta.get('active'))!
  const local = await openAccountWorkspace(database, token, fence.head)
  const initial = await preparePublicationAttempt(database, token, local, null, new Map(), 0)
  const projection = (await openRemoteProjection(database, token, new Map(initial.final.heads.map(ref => [ref.documentId, ref.revisionId])), local.head, 0))!
  const unit = [...projection.units.values()].find(value => value.body.kind !== 'workspace-identity')!
  const b = await stagePublicationRecord(database, token, unit.body, projection.lineageId, unit.ref)
  const bRef = { documentId: b.descriptor.documentId, revisionId: b.revisionId }
  const c = await stagePublicationRecord(database, token, unit.body, projection.lineageId, bRef)
  const cRef = { documentId: c.descriptor.documentId, revisionId: c.revisionId }
  const chunks = await database.stagedCipherChunks.where('payloadId').equals(c.payloadId).toArray()
  await database.stagedCipherChunks.where('payloadId').equals(c.payloadId).delete()
  const group = (sequence: number, heads: readonly import('./account-database').CipherRef[]) => ({ sequence, mutationId: accountLocalId(), heads, revisions: [] })
  const first = { changes: async () => ({ version: 1, mode: 'initial', watermark: 1, publicationEpoch: 1, groups: [group(1, initial.final.heads)], hasMore: false, cursor: 'initial' }) } as unknown as SyncClient
  await activatePulledState(database, token, (await stagePull(database, token, first, async () => {}, transferBudget()))!, fence)
  const next = { changes: async () => ({ version: 1, mode: 'incremental', watermark: 3, publicationEpoch: 1, groups: [group(2, [bRef]), group(3, [cRef])], hasMore: false, cursor: 'final' }) } as unknown as SyncClient
  const validated: string[] = []
  const validate = async (heads: ReadonlyMap<string, string>) => { validated.push(heads.get(unit.ref.documentId)!) }
  expect(await stagePull(database, token, next, validate, { ...transferBudget(), remaining: 0 })).toBeNull()
  expect(validated).toEqual([bRef.revisionId])
  expect(await stagePull(database, token, next, validate, { ...transferBudget(), remaining: 0 })).toBeNull()
  expect(validated).toEqual([bRef.revisionId])
  await database.stagedCipherChunks.bulkAdd(chunks)
  expect(await stagePull(database, token, next, validate, transferBudget())).not.toBeNull()
  expect(validated).toEqual([bRef.revisionId, bRef.revisionId, cRef.revisionId])
})


it('projectionClosureVisitsSharedExactDependenciesOncePerCallWithoutReusingIndependentReads', async () => {
  const { preparePublicationAttempt, stagePublicationRecord } = await import('../account/sync/publication')
  const { openRemoteProjection } = await import('../account/sync/projection')
  const { ensureProjectionClosure, ensureRemoteClosure } = await import('../account/sync/pull')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const { database } = await initializeNativeWorkspace(token)
  const local = await openAccountWorkspace(database, token, (await database.profileMeta.get('active'))!.head)
  const initial = await preparePublicationAttempt(database, token, local, null, new Map(), 0)
  const heads = new Map(initial.final.heads.map(ref => [ref.documentId, ref.revisionId]))
  const projection = (await openRemoteProjection(database, token, heads, local.head, 0))!
  const unit = [...projection.units.values()].find(value => value.body.kind === 'library-defaults')!
  const record = await stagePublicationRecord(database, token, unit.body, projection.lineageId, unit.ref)
  heads.set(record.descriptor.documentId, record.revisionId)
  const { IDBObjectStore } = await import('fake-indexeddb')
  const metadata = vi.spyOn(IDBObjectStore.prototype, 'get'), chunks = vi.spyOn(IDBObjectStore.prototype, 'getKey')
  const client = { revision: vi.fn(), chunk: vi.fn() } as unknown as SyncClient
  try {
    const readings = []
    for (let pass = 0; pass < 2; pass++) {
      metadata.mockClear(); chunks.mockClear()
      const started = Date.now()
      expect(await ensureProjectionClosure(database, token, client, heads, transferBudget())).toBe(true)
      readings.push({ pass, elapsedMs: Date.now() - started, descriptorGets: metadata.mock.contexts.filter(store => (store as IDBObjectStore).name === 'encryptedRevisions').length, chunkValueGets: metadata.mock.contexts.filter(store => (store as IDBObjectStore).name === 'stagedCipherChunks').length, chunkKeyGets: chunks.mock.calls.length, readTransactions: new Set([...metadata.mock.contexts, ...chunks.mock.contexts].map(store => (store as IDBObjectStore).transaction)).size, sharedBody: metadata.mock.calls.filter(([ref]) => (ref as unknown) === unit.body.ref.revisionId).length })
    }
    const proof = JSON.stringify({ phase: 'exact-projection-closure-reads', readings })
    console.info(proof)
    if (process.env.CRYKIT_SYNC_PROOF_TIMINGS) (await import('node:fs')).appendFileSync(process.env.CRYKIT_SYNC_PROOF_TIMINGS, `${proof}\n`)
    expect(readings.map(value => value.sharedBody)).toEqual([1, 1])
    expect(client.revision).not.toHaveBeenCalled(); expect(client.chunk).not.toHaveBeenCalled()
    // The second role cannot borrow success from a matching revision under a foreign document
    await expect(ensureRemoteClosure(database, token, client, [{ ...unit.body.ref, documentId: accountLocalId() }, unit.body.ref], transferBudget())).rejects.toThrow('INTEGRITY_FAILED')
    // A descriptor-only parent visit cannot establish payload completeness for the same exact ref
    const { stagePublicationJson } = await import('../account/sync/publication')
    const child = await stagePublicationJson(database, token, { parentOnly: true }, [], unit.body.ref.documentId, unit.body.ref)
    const body = (await database.encryptedRevisions.get(unit.body.ref.revisionId))!
    const bodyChunks = await database.stagedCipherChunks.where('payloadId').equals(body.payloadId).toArray()
    await database.stagedCipherChunks.where('payloadId').equals(body.payloadId).delete()
    const roots = [unit.body.ref, { documentId: child.descriptor.documentId, revisionId: child.revisionId }]
    expect(await ensureRemoteClosure(database, token, client, roots, { ...transferBudget(), remaining: 0 })).toBe(false)
    expect(await ensureRemoteClosure(database, token, client, roots, { ...transferBudget(), remaining: 0 })).toBe(false)
    await database.stagedCipherChunks.bulkAdd(bodyChunks)
    expect(await ensureRemoteClosure(database, token, client, roots, transferBudget())).toBe(true)
    await database.encryptedRevisions.put({ ...body, descriptor: { ...body.descriptor, accountId: accountLocalId() } })
    await expect(ensureRemoteClosure(database, token, client, [unit.body.ref, unit.body.ref], transferBudget())).rejects.toThrow('INTEGRITY_FAILED')
    await database.encryptedRevisions.put(body)
    expect(await ensureRemoteClosure(database, token, client, [unit.body.ref, unit.body.ref], transferBudget())).toBe(true)
    // Invalidate after a successful leaf read, before the duplicate visit could reuse it
    chunks.mockRestore()
    const readChunk = IDBObjectStore.prototype.getKey
    const profileRead = vi.spyOn(IDBObjectStore.prototype, 'getKey').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<typeof readChunk>) {
      const request = readChunk.apply(this, args)
      request.addEventListener('success', () => invalidateProfile())
      return request
    })
    try { await expect(ensureRemoteClosure(database, token, client, [unit.body.ref, unit.body.ref], transferBudget())).rejects.toThrow() }
    finally { profileRead.mockRestore() }
  } finally { metadata.mockRestore(); chunks.mockRestore() }
})

it('incompleteEncryptedClosureRetriesBoundNativeReadTransactionsWithoutRememberingCompleteness', async () => {
  const { IDBObjectStore } = await import('fake-indexeddb')
  const { ensureRemoteClosure } = await import('../account/sync/pull')
  const { stagePublicationJson } = await import('../account/sync/publication')
  const { cipherRef, readAccountBytes } = await import('../workspace/account-cache')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const leaves = []
  for (let index = 0; index < 256; index++) leaves.push(await stagePublicationJson(database, token, { leaf: index }, []))
  const root = await stagePublicationJson(database, token, { root: true }, leaves.map(cipherRef))
  const absent = leaves.slice(0, 16), saved = new Map<string, Uint8Array>()
  for (const leaf of absent) {
    const chunk = (await database.stagedCipherChunks.get([leaf.payloadId, 0]))!
    saved.set(leaf.revisionId, chunk.bytes)
    await database.stagedCipherChunks.delete([leaf.payloadId, 0])
  }
  const client = { revision: vi.fn(), chunk: vi.fn(async (revisionId: string, index: number) => {
    expect(index).toBe(0)
    const bytes = saved.get(revisionId)
    if (!bytes) throw new Error('Unexpected transfer')
    return bytes.slice()
  }) } as unknown as SyncClient
  const readings: { pass: number; elapsedMs: number; transactions: number; requests: number; chunkValueReads: number; descriptorBytes: number; maxTransactionRequests: number; transferred: number; complete: boolean }[] = []
  for (let pass = 0; pass < 2; pass++) {
    let transactions = 0, requests = 0, chunkValueReads = 0, descriptorBytes = 0, maxTransactionRequests = 0
    const requestCounts = new Map<IDBTransaction, number>()
    const countRequest = (store: IDBObjectStore) => {
      requests++
      const count = (requestCounts.get(store.transaction) ?? 0) + 1
      requestCounts.set(store.transaction, count); transactions = requestCounts.size; maxTransactionRequests = Math.max(maxTransactionRequests, count)
    }
    const originalGetKey = IDBObjectStore.prototype.getKey
    const getKeySpy = vi.spyOn(IDBObjectStore.prototype, 'getKey').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<typeof originalGetKey>) {
      countRequest(this)
      return originalGetKey.apply(this, args)
    })
    const originalGet = IDBObjectStore.prototype.get
    const getSpy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function(this: IDBObjectStore, ...args: Parameters<typeof originalGet>) {
      countRequest(this)
      if (this.name === 'stagedCipherChunks') chunkValueReads++
      const request = originalGet.apply(this, args)
      if (this.name === 'encryptedRevisions') request.addEventListener('success', () => { if (request.result) descriptorBytes += new TextEncoder().encode(JSON.stringify(request.result)).length })
      return request
    })
    const budget = { ...transferBudget(), remaining: 8 }, started = Date.now()
    try {
      const complete = await ensureRemoteClosure(database, token, client, [cipherRef(root)], budget)
      readings.push({ pass, elapsedMs: Date.now() - started, transactions, requests, chunkValueReads, descriptorBytes, maxTransactionRequests, transferred: 8 - budget.remaining, complete })
    } finally { getSpy.mockRestore(); getKeySpy.mockRestore() }
  }
  const proof = JSON.stringify({ phase: 'encrypted-incomplete-budget-read-cost', nodes: leaves.length + 1, missingChunks: absent.length, readings })
  console.info(proof)
  if (process.env.CRYKIT_SYNC_PROOF_TIMINGS) (await import('node:fs')).appendFileSync(process.env.CRYKIT_SYNC_PROOF_TIMINGS, `${proof}\n`)
  expect(readings.map(value => value.complete)).toEqual([false, true])
  expect(readings.map(value => value.transferred)).toEqual([8, 8])
  expect(client.revision).not.toHaveBeenCalled()
  expect(vi.mocked(client.chunk).mock.calls.map(([revisionId]) => revisionId)).toEqual([...absent].reverse().map(value => value.revisionId))
  expect(JSON.parse(new TextDecoder().decode(await readAccountBytes(database, token, cipherRef(leaves[0]))))).toEqual({ leaf: 0 })
  // A fresh operation must notice a missing chunk even after the prior full traversal succeeded
  await database.stagedCipherChunks.delete([leaves[255].payloadId, 0])
  expect(await ensureRemoteClosure(database, token, client, [cipherRef(root)], { ...transferBudget(), remaining: 0 })).toBe(false)
  expect(readings.every(value => value.transactions <= 40)).toBe(true)
  expect(readings.every(value => value.chunkValueReads === 0)).toBe(true)
  expect(readings.every(value => value.maxTransactionRequests <= 160)).toBe(true)
})

it.each(['revision', 'account', 'chunks', 'payload'] as const)('closureReadWindowRejectsMalformedPrefetched%sWithoutReorderingBudget', async fault => {
  const { ensureRemoteClosure } = await import('../account/sync/pull')
  const { stagePublicationJson } = await import('../account/sync/publication')
  const { cipherRef } = await import('../workspace/account-cache')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const bad = await stagePublicationJson(database, token, { bad: true }, [])
  const first = await stagePublicationJson(database, token, { first: true }, [])
  const root = await stagePublicationJson(database, token, { root: true }, [cipherRef(bad), cipherRef(first)])
  const malformed = { ...structuredClone(bad) }
  if (fault === 'revision') malformed.descriptor = { ...malformed.descriptor, revisionId: accountLocalId() }
  if (fault === 'account') malformed.descriptor = { ...malformed.descriptor, accountId: accountLocalId() }
  if (fault === 'chunks') malformed.descriptor = { ...malformed.descriptor, chunks: [{ ...malformed.descriptor.chunks[0], cipherBytes: 1 }] }
  if (fault === 'payload') malformed.payloadId = 'not-canonical'
  await database.encryptedRevisions.put(malformed)
  const firstChunk = (await database.stagedCipherChunks.get([first.payloadId, 0]))!
  await database.stagedCipherChunks.delete([first.payloadId, 0])
  const client = { revision: vi.fn(), chunk: vi.fn() } as unknown as SyncClient
  // The invalid later sibling is discovered speculatively but cannot supersede this earlier budget exit
  expect(await ensureRemoteClosure(database, token, client, [cipherRef(root)], { ...transferBudget(), remaining: 0 })).toBe(false)
  await database.stagedCipherChunks.put(firstChunk)
  await expect(ensureRemoteClosure(database, token, client, [cipherRef(root)], transferBudget())).rejects.toThrow()
  await database.encryptedRevisions.put(bad)
  expect(await ensureRemoteClosure(database, token, client, [cipherRef(root)], transferBudget())).toBe(true)
  expect(client.revision).not.toHaveBeenCalled(); expect(client.chunk).not.toHaveBeenCalled()
})

it('closureReadWindowRetriesMissingMetadataAndFailedTransfersWithFreshAccountScopedReads', async () => {
  const { ensureRemoteClosure } = await import('../account/sync/pull')
  const { stagePublicationJson } = await import('../account/sync/publication')
  const { cipherRef, readAccountBytes } = await import('../workspace/account-cache')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const record = await stagePublicationJson(database, token, { exact: true }, [])
  const chunk = (await database.stagedCipherChunks.get([record.payloadId, 0]))!
  await database.encryptedRevisions.delete(record.revisionId)
  const client = { revision: vi.fn(async () => record.descriptor), chunk: vi.fn().mockRejectedValueOnce(new Error('interrupted transfer')).mockResolvedValue(chunk.bytes) } as unknown as SyncClient
  expect(await ensureRemoteClosure(database, token, client, [cipherRef(record)], { ...transferBudget(), metadataRemaining: 0 })).toBe(false)
  expect(client.revision).not.toHaveBeenCalled()
  await expect(ensureRemoteClosure(database, token, client, [cipherRef(record)], transferBudget())).rejects.toThrow('interrupted transfer')
  expect(await ensureRemoteClosure(database, token, client, [cipherRef(record)], transferBudget())).toBe(true)
  expect(client.revision).toHaveBeenCalledTimes(1); expect(client.chunk).toHaveBeenCalledTimes(2)
  expect(JSON.parse(new TextDecoder().decode(await readAccountBytes(database, token, cipherRef(record))))).toEqual({ exact: true })
  const other = new AccountDatabase(accountLocalId())
  try { await expect(ensureRemoteClosure(other, token, client, [cipherRef(record)], transferBudget())).rejects.toThrow('INTEGRITY_FAILED') }
  finally { await other.delete() }
  // Both roles were prefetched as missing, but the metadata-only visit must populate the later payload read
  const child = await stagePublicationJson(database, token, { child: true }, [], record.descriptor.documentId, cipherRef(record))
  await database.encryptedRevisions.delete(record.revisionId)
  expect(await ensureRemoteClosure(database, token, client, [cipherRef(record), cipherRef(child)], transferBudget())).toBe(true)
  expect(client.revision).toHaveBeenCalledTimes(2)
  // Descriptor presence and cycle visitation do not authenticate a changed graph against frozen ciphertext
  const restored = (await database.encryptedRevisions.get(record.revisionId))!
  await database.encryptedRevisions.put({ ...restored, descriptor: { ...restored.descriptor, dependencies: [cipherRef(record)] } })
  expect(await ensureRemoteClosure(database, token, client, [cipherRef(record)], transferBudget())).toBe(true)
  await expect(readAccountBytes(database, token, cipherRef(record))).rejects.toThrow()
})

it('canonicalMaximumDescriptorWindowBoundsRowsBytesAndKeyRequestsWithoutLoadingCiphertext', async () => {
  const { IDBObjectStore } = await import('fake-indexeddb')
  const { ensureRemoteClosure } = await import('../account/sync/pull')
  const { stagePublicationJson } = await import('../account/sync/publication')
  const { cipherRef } = await import('../workspace/account-cache')
  const { RevisionDescriptorSchema, maxChunks, maxDependencies, maxDocumentBytes, plainChunkBytes, streamOverheadBytes } = await import('../account/protocol')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  const seed = await stagePublicationJson(database, token, {}, [])
  const maximum = { ...seed, descriptor: {
    ...seed.descriptor, protected: false, parents: [accountLocalId(), accountLocalId()],
    dependencies: Array.from({ length: maxDependencies }, () => ({ documentId: accountLocalId(), revisionId: accountLocalId() })), plainBytes: maxDocumentBytes,
    chunks: Array.from({ length: maxChunks }, (_, index) => ({ index, cipherBytes: plainChunkBytes + streamOverheadBytes, cipherDigest: seed.descriptor.chunks[0].cipherDigest })),
  } }
  expect(RevisionDescriptorSchema.safeParse(maximum.descriptor).success).toBe(true)
  const rows = Array.from({ length: 32 }, () => {
    const revisionId = accountLocalId()
    return { ...maximum, revisionId, payloadId: accountLocalId(), descriptor: { ...maximum.descriptor, revisionId } }
  })
  // This shape verifies descriptor bounds only; absent payloads must prevent any closure success
  await database.encryptedRevisions.bulkAdd(rows)
  const rowBytes = new TextEncoder().encode(JSON.stringify(maximum)).length, batchBytes = new Blob([JSON.stringify(rows)]).size
  expect(rowBytes).toBe(32894); expect(batchBytes).toBe(1052641)
  expect(new Blob([JSON.stringify(maximum)]).size).toBe(rowBytes)
  expect(new TextEncoder().encode(JSON.stringify(rows)).length).toBe(batchBytes)
  const metadata = vi.spyOn(IDBObjectStore.prototype, 'get'), keys = vi.spyOn(IDBObjectStore.prototype, 'getKey')
  try {
    const client = { revision: vi.fn(), chunk: vi.fn() } as unknown as SyncClient
    expect(await ensureRemoteClosure(database, token, client, rows.map(cipherRef), { ...transferBudget(), remaining: 0 })).toBe(false)
    expect(metadata).toHaveBeenCalledTimes(32); expect(keys).toHaveBeenCalledTimes(128)
    expect(client.revision).not.toHaveBeenCalled(); expect(client.chunk).not.toHaveBeenCalled()
    const proof = JSON.stringify({ phase: 'canonical-descriptor-window-bound', rowBytes, batchBytes, rows: metadata.mock.calls.length, chunkKeyRequests: keys.mock.calls.length })
    console.info(proof)
    if (process.env.CRYKIT_SYNC_PROOF_TIMINGS) (await import('node:fs')).appendFileSync(process.env.CRYKIT_SYNC_PROOF_TIMINGS, `${proof}\n`)
  } finally { metadata.mockRestore(); keys.mockRestore() }
})

it.each([false, true])('real staged pull denies complete inactive v2 before remote ciphertext staging (nonempty=%s)', async nonempty => {
  const { completeInactiveCandidate, exactAccountTables } = await import('./account-inactive-test-helpers')
  const { openInactiveAccountWorkspace } = await import('../workspace/account-inactive-graph')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const { database } = await initializeNativeWorkspace(token)
  const fence = (await database.profileMeta.get('active'))!
  const origin = await openInactiveAccountWorkspace(database, token, fence.head)
  const prepared = await completeInactiveCandidate(database, token, origin, nonempty)
  try {
    const client = { changes: async () => ({ version: 1, mode: 'initial', watermark: 0, publicationEpoch: 0, groups: [], hasMore: false, cursor: 'complete-v2-denial' }) } as unknown as SyncClient
    const candidate = (await stagePull(database, token, client, async () => {}, transferBudget()))!
    await prepared.assertContents(prepared.opened)
    const before = await exactAccountTables(database)
    await expect(activatePulledState(database, token, candidate, fence, { head: prepared.head, records: prepared.records, opened: { version: 1 } } as unknown as Awaited<ReturnType<typeof prepareAccountWorkspace>>)).rejects.toThrow()
    expect(await exactAccountTables(database)).toEqual(before)
  } finally { await prepared.dispose(); await origin.dispose() }
})
