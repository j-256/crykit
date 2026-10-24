import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBObjectStore } from 'fake-indexeddb'
import { afterEach, expect, it, vi } from 'vitest'
import { installProfile, invalidateProfile } from '../account/profile'
import { plainChunkBytes } from '../account/protocol'
import { accountLocalId, cipherRef, stageAccountBytes } from '../workspace/account-cache'
import { createAccountPreparationOwner } from '../workspace/account-prepared-records'
import { stageAccountSource, openAccountSource } from '../workspace/account-streams'
import { memoryBlob } from '../workspace/blobs'
import { accountCleanupOnlyFailure, accountPreparationFailure, assertAccountCleanupJoinable, createAccountCleanupCoordinator, hasNewAccountCleanupFailure, readAccountCleanupOnlyFailure, readAccountPreparationFailure, type AccountCleanupJoin } from '../workspace/account-cleanup-attempt'
import { AccountDatabase } from './account-database'

let database: AccountDatabase | undefined
afterEach(async () => { vi.restoreAllMocks(); invalidateProfile(); await database?.delete(); database = undefined })

function fixture() {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  return { database, token }
}

function failNativeDeletes(payloadIds: readonly string[], failures = 1) {
  const attempts = new Map<string, number>()
  const original = IDBObjectStore.prototype.delete
  vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
    const request = original.call(this, key)
    const payloadId = Array.isArray(key) ? key[0] : undefined
    if (this.name === 'stagedCipherChunks' && typeof payloadId === 'string' && payloadIds.includes(payloadId)) {
      const count = (attempts.get(payloadId) ?? 0) + 1
      attempts.set(payloadId, count)
      // Forward the actual native deletion, then abort its transaction so ciphertext survives
      if (count <= failures) this.transaction.abort()
    }
    return request
  })
  return attempts
}

it('ordinaryRequestsDoNotRetryFirstNativeDeletionFailure', async () => {
  const { database, token } = fixture()
  const owner = createAccountPreparationOwner(database, token)
  const owned = await stageAccountBytes(database, token, new Uint8Array([31, 32]), [], undefined, owner)
  const installed = await stageAccountBytes(database, token, new Uint8Array([41]), [], undefined, owner)
  await database.encryptedRevisions.add(installed)
  const foreignId = accountLocalId()
  await database.stagedCipherChunks.add({ payloadId: foreignId, index: 0, bytes: new Uint8Array([51]) })
  const attempts = failNativeDeletes([owned.payloadId])
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  const join = coordinator.cleanup.owner(owner)
  const first = await join.request()
  expect(first.status).toBe('failed')
  expect(attempts.get(owned.payloadId)).toBe(1)
  expect(await database.stagedCipherChunks.get([owned.payloadId, 0])).toBeDefined()
  expect(coordinator.cleanup.owner(owner)).toBe(join)
  expect(await join.request()).toBe(first)
  expect(await join.wait()).toBe(first)
  expect(join.observe()).toBe(first)
  expect(Object.isFrozen(first)).toBe(true)
  if (first.status === 'failed') expect(Object.isFrozen(first.errors)).toBe(true)
  expect(attempts.get(owned.payloadId)).toBe(1)
  expect(await database.stagedCipherChunks.get([owned.payloadId, 0])).toBeDefined()
  invalidateProfile()
  expect(coordinator.cleanup.owner(owner)).toBe(join)
  await coordinator.retryFailed([join])
  expect(attempts.get(owned.payloadId)).toBe(2)
  expect(await database.stagedCipherChunks.get([owned.payloadId, 0])).toBeUndefined()
  expect(join.observe()).toEqual({ attempt: 2, status: 'succeeded' })
  expect(first.status).toBe('failed')
  expect(coordinator.cleanup.owner(owner)).toBe(join)
  expect(await join.request()).toBe(join.observe())
  expect(await database.stagedCipherChunks.get([installed.payloadId, 0])).toBeDefined()
  expect(await database.encryptedRevisions.get(installed.revisionId)).toEqual(installed)
  expect((await database.stagedCipherChunks.get([foreignId, 0]))?.bytes).toEqual(new Uint8Array([51]))
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}

it('ownerRequestRevokesBeforeCleanupSettles', async () => {
  const { database, token } = fixture()
  const owner = createAccountPreparationOwner(database, token)
  const record = await stageAccountSource(database, token, memoryBlob(new Uint8Array(plainChunkBytes + 1).fill(63)), [], undefined, undefined, owner)
  const iterator = (await openAccountSource(database, token, cipherRef(record), owner)).open()[Symbol.asyncIterator]()
  const held = (await iterator.next()).value as Uint8Array
  const paused = deferred(), resume = deferred()
  const stage = stageAccountSource(database, token, {
    byteLength: plainChunkBytes + 1,
    async *open() { yield new Uint8Array(plainChunkBytes).fill(17); paused.resolve(); await resume.promise; yield new Uint8Array([18]) },
  }, [], undefined, undefined, owner)
  const stageOutcome = stage.then(() => undefined, error => error)
  await paused.promise
  const join = createAccountCleanupCoordinator(database, token, async () => {}).cleanup.owner(owner)
  const cleanup = Dexie.ignoreTransaction(() => join.request())
  expect(join.observe()).toEqual({ attempt: 1, status: 'pending' })
  expect(held.every(byte => byte === 0)).toBe(true)
  expect(() => owner.check()).toThrow('closed')
  expect(() => stageAccountBytes(database, token, new Uint8Array([1]), [], undefined, owner)).toThrow('closed')
  resume.resolve()
  expect(await stageOutcome).toBeInstanceOf(Error)
  expect(await cleanup).toEqual({ attempt: 1, status: 'succeeded' })
  expect(await database.stagedCipherChunks.count()).toBe(0)
})

it('groupsKeepFailuresAndImmediatelyDisposeLateReaders', async () => {
  const { database, token } = fixture()
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  const left = createAccountPreparationOwner(database, token), right = createAccountPreparationOwner(database, token)
  const leftRecord = await stageAccountBytes(database, token, new Uint8Array([1]), [], undefined, left)
  const rightRecord = await stageAccountBytes(database, token, new Uint8Array([2]), [], undefined, right)
  const deletes = failNativeDeletes([leftRecord.payloadId])
  const failure = new Error('same message'), otherFailure = new Error('same message')
  let successfulCalls = 0, failedCalls = 0, lateCalls = 0
  const goodReader = { async dispose() { successfulCalls++ } }
  const good = coordinator.cleanup.reader(goodReader)
  const bad = coordinator.cleanup.reader({ async dispose() { failedCalls++; throw failure } })
  const otherBad = coordinator.cleanup.reader({ async dispose() { throw otherFailure } })
  const leftJoin = coordinator.cleanup.owner(left), rightJoin = coordinator.cleanup.owner(right)
  const child = coordinator.cleanup.group([leftJoin, good, bad])
  const root = coordinator.cleanup.group([child, leftJoin, rightJoin, otherBad, child])
  expect(await root.wait()).toEqual({ attempt: 0, status: 'not-started' })
  expect(successfulCalls).toBe(0)
  const first = await root.request()
  expect(first).toMatchObject({ attempt: 1, status: 'failed' })
  if (first.status !== 'failed') throw new Error('Expected cleanup failure')
  expect(first.errors).toHaveLength(3)
  expect(first.errors[1]).toBe(failure)
  expect(first.errors[2]).toBe(otherFailure)
  const late = coordinator.cleanup.reader({ async dispose() { lateCalls++ } })
  child.include(late)
  expect(lateCalls).toBe(1)
  expect(root.observe()).toMatchObject({ attempt: 1, status: 'failed' })
  await root.request()
  child.include(late)
  expect(lateCalls).toBe(1)
  expect(successfulCalls).toBe(1)
  expect(failedCalls).toBe(1)
  expect(coordinator.cleanup.reader(goodReader)).toBe(good)
  expect(deletes.get(leftRecord.payloadId)).toBe(1)
  expect(await database.stagedCipherChunks.get([rightRecord.payloadId, 0])).toBeUndefined()
  await coordinator.retryFailed([leftJoin])
  expect(root.observe()).toMatchObject({ attempt: 2, status: 'failed', errors: [failure, otherFailure] })
})

it('observesMixedAndEmptyGroupsWithoutStartingDormantMembers', async () => {
  const { database, token } = fixture()
  const { cleanup } = createAccountCleanupCoordinator(database, token, async () => {})
  let calls = 0
  const done = cleanup.reader({ async dispose() { calls++ } })
  const dormant = cleanup.reader({ async dispose() { calls++ } })
  const mixed = cleanup.group([done, dormant])
  await done.request()
  expect(mixed.observe()).toEqual({ attempt: 1, status: 'pending' })
  expect(await mixed.wait()).toEqual({ attempt: 1, status: 'pending' })
  expect(calls).toBe(1)
  const emptyChild = cleanup.group([]), emptyRoot = cleanup.group([emptyChild])
  expect(emptyRoot.observe()).toEqual({ attempt: 0, status: 'not-started' })
  expect(await emptyRoot.request()).toEqual({ attempt: 0, status: 'succeeded' })
  expect(await emptyRoot.wait()).toEqual({ attempt: 0, status: 'succeeded' })
  const gate = deferred()
  const late = cleanup.reader({ dispose: () => { calls++; return gate.promise } })
  emptyChild.include(late)
  expect(calls).toBe(2)
  expect(emptyRoot.observe()).toEqual({ attempt: 1, status: 'pending' })
  const failure = new Error('failed sibling')
  const bad = cleanup.reader({ async dispose() { throw failure } })
  emptyRoot.include(bad)
  await bad.wait()
  expect(emptyRoot.observe()).toEqual({ attempt: 1, status: 'failed', errors: [failure] })
  let waited = false
  const waiting = emptyRoot.wait().then(value => { waited = true; return value })
  await Promise.resolve()
  expect(waited).toBe(false)
  gate.resolve()
  expect(await waiting).toEqual({ attempt: 1, status: 'failed', errors: [failure] })
  expect(dormant.observe()).toEqual({ attempt: 0, status: 'not-started' })
})

it('validatesCanonicalIdentityAndCyclesBeforeChangingMembership', async () => {
  const { database, token } = fixture()
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  const other = createAccountCleanupCoordinator(database, token, async () => {})
  let calls = 0
  const reader = { async dispose() { calls++ } }
  const node = coordinator.cleanup.reader(reader)
  const foreign = other.cleanup.reader({ async dispose() { calls++ } })
  const child = coordinator.cleanup.group([node]), root = coordinator.cleanup.group([child])
  expect(() => root.include(root)).toThrow()
  expect(() => child.include(root)).toThrow()
  expect(() => root.include(foreign)).toThrow()
  expect(() => root.include({ ...node })).toThrow()
  expect(() => coordinator.cleanup.group([node, foreign])).toThrow()
  expect(() => other.cleanup.reader(reader)).toThrow()
  const owner = createAccountPreparationOwner(database, token)
  coordinator.cleanup.owner(owner)
  expect(() => other.cleanup.owner(owner)).toThrow()
  const secondConnection = new AccountDatabase(token.accountId)
  try {
    expect(() => createAccountCleanupCoordinator(secondConnection, token, async () => {}).cleanup.owner(owner)).toThrow()
    expect(() => createAccountCleanupCoordinator(database, { ...token, generation: token.generation + 1 }, async () => {}).cleanup.owner(owner)).toThrow()
    expect(() => createAccountCleanupCoordinator(database, { ...token, accountId: accountLocalId() }, async () => {})).toThrow()
  } finally { secondConnection.close() }
  await expect(coordinator.retryFailed([foreign])).rejects.toThrow()
  expect(calls).toBe(0)
  await root.request()
  expect(calls).toBe(1)
})

it('installsPendingBeforeSynchronousReentrancyAndObservesRejectedDisposers', async () => {
  const { database, token } = fixture()
  const { cleanup } = createAccountCleanupCoordinator(database, token, async () => {})
  for (const synchronous of [true, false]) {
    const error = new Error('dispose failure')
    let join!: AccountCleanupJoin, nested: Promise<unknown> | undefined, calls = 0
    const reader = { dispose(): Promise<void> {
      calls++
      expect(join.observe()).toEqual({ attempt: 1, status: 'pending' })
      nested = join.request()
      if (synchronous) throw error
      return Promise.reject(error)
    } }
    join = cleanup.reader(reader)
    const first = join.request()
    expect(nested).toBe(first)
    expect(join.request()).toBe(first)
    expect(await first).toEqual({ attempt: 1, status: 'failed', errors: [error] })
    expect(calls).toBe(1)
  }
  const child = cleanup.group([])
  let lateCalls = 0
  const late = cleanup.reader({ async dispose() { lateCalls++ } })
  const trigger = cleanup.reader({ async dispose() { child.include(late) } })
  const root = cleanup.group([trigger, child])
  await root.request()
  expect(lateCalls).toBe(1)
  expect(await root.wait()).toEqual({ attempt: 1, status: 'succeeded' })
})

it('explicitRetryWaitsPreparationsAndSerializesOnlyFailedResources', async () => {
  const { database, token } = fixture()
  const gate = deferred(), entered = deferred()
  const targets: AccountCleanupJoin[][] = []
  const coordinator = createAccountCleanupCoordinator(database, token, async parts => {
    targets.push([...parts]); entered.resolve(); await gate.promise
  })
  const owner = createAccountPreparationOwner(database, token), unrelatedOwner = createAccountPreparationOwner(database, token)
  const owned = await stageAccountBytes(database, token, new Uint8Array([3]), [], undefined, owner)
  const unrelated = await stageAccountBytes(database, token, new Uint8Array([4]), [], undefined, unrelatedOwner)
  const attempts = failNativeDeletes([owned.payloadId, unrelated.payloadId], 2)
  let successfulCalls = 0, lateCalls = 0
  const success = coordinator.cleanup.reader({ async dispose() { successfulCalls++ } })
  const join = coordinator.cleanup.owner(owner), unrelatedJoin = coordinator.cleanup.owner(unrelatedOwner)
  const left = coordinator.cleanup.group([join, success]), right = coordinator.cleanup.group([join])
  await left.request(); await unrelatedJoin.request()
  const retry1 = coordinator.retryFailed([left]).then(() => undefined, error => error)
  await entered.promise
  const retry2 = coordinator.retryFailed([right]).then(() => undefined, error => error)
  left.include(coordinator.cleanup.reader({ async dispose() { lateCalls++ } }))
  expect(lateCalls).toBe(1)
  expect((await join.request()).attempt).toBe(1)
  expect(attempts.get(owned.payloadId)).toBe(1)
  invalidateProfile()
  gate.resolve()
  const errors = await Promise.all([retry1, retry2])
  expect(errors.every(error => error instanceof AggregateError)).toBe(true)
  expect(attempts.get(owned.payloadId)).toBe(2)
  expect(attempts.get(unrelated.payloadId)).toBe(1)
  expect(join.observe()).toMatchObject({ attempt: 2, status: 'failed' })
  expect(targets).toEqual([[left], [right]])
  expect(successfulCalls).toBe(1)
  await coordinator.retryFailed([left])
  expect(attempts.get(owned.payloadId)).toBe(3)
  expect(attempts.get(unrelated.payloadId)).toBe(1)
  expect(await database.stagedCipherChunks.get([owned.payloadId, 0])).toBeUndefined()
  expect(await database.stagedCipherChunks.get([unrelated.payloadId, 0])).toBeDefined()
  expect(successfulCalls).toBe(1)
})

it('joinsAnActiveRetryAndKeepsDisjointRetryAuthoritySeparate', async () => {
  const { database, token } = fixture()
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  const gate = deferred(), entered = deferred()
  const leftError = new Error('left'), rightError = new Error('right')
  let leftCalls = 0, rightCalls = 0
  const left = coordinator.cleanup.reader({ async dispose() {
    if (++leftCalls === 2) { entered.resolve(); await gate.promise }
    throw leftError
  } })
  const right = coordinator.cleanup.reader({ async dispose() { rightCalls++; throw rightError } })
  await left.request(); await right.request()
  const first = coordinator.retryFailed([left]).catch(error => error)
  await entered.promise
  const second = coordinator.retryFailed([left]).catch(error => error)
  const disjoint = coordinator.retryFailed([right]).catch(error => error)
  const requested = left.request()
  expect(left.observe()).toEqual({ attempt: 2, status: 'pending' })
  expect(left.request()).toBe(requested)
  expect(rightCalls).toBe(1)
  gate.resolve()
  const outcomes = await Promise.all([first, second, disjoint])
  expect(outcomes[0].errors).toEqual([leftError])
  expect(outcomes[1].errors).toEqual([leftError])
  expect(outcomes[2].errors).toEqual([rightError])
  expect(await requested).toEqual({ attempt: 2, status: 'failed', errors: [leftError] })
  expect(leftCalls).toBe(2)
  expect(rightCalls).toBe(2)
})

it('waitsInnerProducerSettlementForEmptyTargetsWithoutWaitingItsOuterCleanup', async () => {
  const { database, token } = fixture()
  const producerGate = deferred()
  const primary = new Error('producer failure')
  let inner!: Promise<void>, calls = 0
  let expected!: AccountCleanupJoin
  const coordinator = createAccountCleanupCoordinator(database, token, async parts => {
    expect(parts).toEqual([expected])
    await Promise.allSettled([inner])
  })
  const group = coordinator.cleanup.group([])
  expected = group
  inner = (async () => {
    await producerGate.promise
    const late = coordinator.cleanup.reader({ async dispose() { if (++calls === 1) throw new Error('first cleanup') } })
    group.include(late)
    // An inner producer joins only its finite resource snapshot, never the outer retry
    await group.request()
    throw primary
  })()
  const innerOutcome = inner.catch(error => error)
  await group.request()
  const retry = coordinator.retryFailed([group])
  producerGate.resolve()
  await retry
  expect(await innerOutcome).toBe(primary)
  expect(calls).toBe(2)
  expect(group.observe()).toEqual({ attempt: 2, status: 'succeeded' })
})

it('surfacesSettlementContractFailureWithoutAdvancingCleanup', async () => {
  const { database, token } = fixture()
  const infrastructure = new Error('broken barrier')
  const coordinator = createAccountCleanupCoordinator(database, token, async () => { throw infrastructure })
  let calls = 0
  const join = coordinator.cleanup.reader({ async dispose() { calls++; throw new Error('delete') } })
  const first = await join.request()
  await expect(coordinator.retryFailed([join])).rejects.toBe(infrastructure)
  expect(await join.wait()).toBe(first)
  expect(calls).toBe(1)
})

it('primaryOnlyFailureIsNotCleanupFailure', async () => {
  const { database, token } = fixture()
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  const primary = new AggregateError([new Error('source')], 'operation only')
  for (const failDeletion of [false, true]) {
    const owner = createAccountPreparationOwner(database, token)
    await expect(stageAccountSource(database, token, {
      byteLength: plainChunkBytes + 1,
      async *open() { yield new Uint8Array(plainChunkBytes).fill(29); throw primary },
    }, [], undefined, undefined, owner)).rejects.toBe(primary)
    const payloadIds = (await database.stagedCipherChunks.toArray()).map(row => row.payloadId)
    if (failDeletion) failNativeDeletes(payloadIds)
    const join = coordinator.cleanup.owner(owner)
    const result = await join.request()
    const error = accountPreparationFailure(primary, join)
    expect(error.cause).toBe(primary)
    expect(readAccountPreparationFailure(error)).toEqual({ primary, cleanup: join })
    expect(readAccountPreparationFailure({ ...error })).toBeUndefined()
    expect(readAccountPreparationFailure(new AggregateError([primary], error.message, { cause: primary }))).toBeUndefined()
    expect(result.status).toBe(failDeletion ? 'failed' : 'succeeded')
    if (result.status === 'failed') {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).not.toBe(primary)
    }
  }
  const empty = coordinator.cleanup.group([])
  const value = { synthetic: 'non-error primary' }
  const carrier = accountPreparationFailure(value, empty)
  expect(carrier.cause).toBe(value)
  expect(readAccountPreparationFailure(carrier)?.primary).toBe(value)
  expect(empty.observe()).toEqual({ attempt: 0, status: 'not-started' })
  expect(() => accountPreparationFailure(primary, { ...empty })).toThrow()
})

it('binds cleanup-only failures to exact failed resource and group request results', async () => {
  const { database, token } = fixture()
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  const other = createAccountCleanupCoordinator(database, token, async () => {})
  const original = new Error('same message'), distinct = new Error('same message')
  let calls = 0
  const resource = coordinator.cleanup.reader({ async dispose() { if (++calls === 1) throw original } })
  const sibling = coordinator.cleanup.reader({ async dispose() { throw distinct } })
  const foreign = other.cleanup.reader({ async dispose() { throw new Error('foreign') } })
  const first = await resource.request(), siblingResult = await sibling.request(), foreignResult = await foreign.request()
  if (first.status !== 'failed' || siblingResult.status !== 'failed' || foreignResult.status !== 'failed') throw new Error('Expected first-attempt cleanup failures')
  expect(resource.observe()).toBe(first)
  const resourceFailure = accountCleanupOnlyFailure(resource, resource.observe() as typeof first)
  expect(resourceFailure).toBeInstanceOf(AggregateError)
  expect((resourceFailure as AggregateError).errors).toEqual([original])
  expect((resourceFailure as AggregateError).errors[0]).toBe(original)
  expect(readAccountCleanupOnlyFailure(resourceFailure)).toEqual({ cleanup: resource, result: first })
  expect(readAccountPreparationFailure(resourceFailure)).toBeUndefined()
  expect(readAccountCleanupOnlyFailure({ ...resourceFailure })).toBeUndefined()
  expect(readAccountCleanupOnlyFailure(new AggregateError([original], resourceFailure.message))).toBeUndefined()
  expect(() => accountCleanupOnlyFailure(resource, { ...first })).toThrow()
  expect(() => accountCleanupOnlyFailure(resource, siblingResult)).toThrow()
  expect(() => accountCleanupOnlyFailure(resource, foreignResult)).toThrow()
  expect(() => accountCleanupOnlyFailure(foreign, first)).toThrow()

  const group = coordinator.cleanup.group([resource, sibling])
  const grouped = await group.request()
  if (grouped.status !== 'failed') throw new Error('Expected group cleanup failure')
  expect(grouped.errors).toEqual([original, distinct])
  expect(grouped.errors[0]).toBe(original)
  expect(grouped.errors[1]).toBe(distinct)
  const groupFailure = accountCleanupOnlyFailure(group, grouped)
  expect(readAccountCleanupOnlyFailure(groupFailure)).toEqual({ cleanup: group, result: grouped })
  expect(() => accountCleanupOnlyFailure(group, group.observe() as typeof grouped)).toThrow()
  const waited = await group.wait()
  expect(() => accountCleanupOnlyFailure(group, waited as typeof grouped)).toThrow()
  expect(() => accountCleanupOnlyFailure(resource, grouped)).toThrow()
  await coordinator.retryFailed([resource])
  expect(resource.observe()).toEqual({ attempt: 2, status: 'succeeded' })
  expect(readAccountCleanupOnlyFailure(resourceFailure)).toEqual({ cleanup: resource, result: first })
  expect(readAccountCleanupOnlyFailure(groupFailure)).toEqual({ cleanup: group, result: grouped })
  expect((groupFailure as AggregateError).errors).toEqual([original, distinct])
  expect(() => accountCleanupOnlyFailure(resource, resource.observe() as typeof first)).toThrow()
  expect(calls).toBe(2)
})

it('keeps literal undefined as an operation primary instead of cleanup-only failure', async () => {
  const { database, token } = fixture()
  const { cleanup } = createAccountCleanupCoordinator(database, token, async () => {})
  const join = cleanup.reader({ async dispose() { throw new Error('cleanup') } })
  const failed = await join.request()
  if (failed.status !== 'failed') throw new Error('Expected cleanup failure')
  const primary = accountPreparationFailure(undefined, join)
  const only = accountCleanupOnlyFailure(join, failed)
  expect(readAccountPreparationFailure(primary)).toEqual({ primary: undefined, cleanup: join })
  expect(readAccountCleanupOnlyFailure(primary)).toBeUndefined()
  expect(readAccountPreparationFailure(only)).toBeUndefined()
  expect(readAccountCleanupOnlyFailure(only)).toEqual({ cleanup: join, result: failed })
})

it('retains exact cleanup-only history after a retry without changing the latest result', async () => {
  const { database, token } = fixture()
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  const foreign = createAccountCleanupCoordinator(database, token, async () => {})
  const original = new Error('same message'), distinct = new Error('same message')
  let nestedAttempts = 0, localAttempts = 0
  const nested = coordinator.cleanup.reader({ async dispose() { if (++nestedAttempts === 1) throw original } })
  const local = coordinator.cleanup.reader({ async dispose() { localAttempts++; throw distinct } })
  const first = await nested.request()
  if (first.status !== 'failed') throw new Error('Expected failed first attempt')
  const incoming = accountCleanupOnlyFailure(nested, first)
  await coordinator.retryFailed([nested])
  const group = coordinator.cleanup.group([local, nested])
  const latest = await group.request()
  if (latest.status !== 'failed') throw new Error('Expected local failure')
  const composed = accountCleanupOnlyFailure(group, latest, incoming)
  const read = readAccountCleanupOnlyFailure(composed)
  expect(read?.cleanup).toBe(group)
  expect(read?.result).toBe(latest)
  expect(read?.history).toEqual([incoming])
  expect(Object.isFrozen(read?.history)).toBe(true)
  expect((composed as Error & { cause?: unknown }).cause).toBe(incoming)
  expect(latest.errors).toEqual([distinct])
  expect((composed as AggregateError).errors).toEqual([distinct, original])
  expect((composed as AggregateError).errors[0]).toBe(distinct)
  expect((composed as AggregateError).errors[1]).toBe(original)
  expect(readAccountCleanupOnlyFailure(incoming)).toEqual({ cleanup: nested, result: first })
  expect(nestedAttempts).toBe(2)
  expect(localAttempts).toBe(1)
  const incomingDiagnostic = incoming as AggregateError
  incomingDiagnostic.errors[0] = distinct
  const sameJoin = accountCleanupOnlyFailure(nested, first, incoming)
  expect((sameJoin as AggregateError).errors).toEqual([original])
  expect(readAccountCleanupOnlyFailure(sameJoin)?.history).toEqual([incoming])
  const third = new Error('third cleanup failure')
  const next = coordinator.cleanup.reader({ async dispose() { throw third } })
  const nextResult = await next.request()
  if (nextResult.status !== 'failed') throw new Error('Expected third cleanup failure')
  const composedDiagnostic = composed as AggregateError
  composedDiagnostic.errors[1] = third
  const continued = accountCleanupOnlyFailure(next, nextResult, composed)
  expect((continued as AggregateError).errors).toEqual([third, distinct, original])
  expect(readAccountCleanupOnlyFailure(continued)?.history).toEqual([composed, incoming])
  expect((continued as Error & { cause?: unknown }).cause).toBe(composed)
  expect(() => accountCleanupOnlyFailure(group, latest, new AggregateError([original], 'forged'))).toThrow()
  expect(() => accountCleanupOnlyFailure(group, latest, accountPreparationFailure(original, nested))).toThrow()
  const foreignJoin = foreign.cleanup.reader({ async dispose() { throw original } })
  const foreignResult = await foreignJoin.request()
  if (foreignResult.status !== 'failed') throw new Error('Expected foreign cleanup failure')
  expect(() => accountCleanupOnlyFailure(group, latest, accountCleanupOnlyFailure(foreignJoin, foreignResult))).toThrow()
  expect(nestedAttempts).toBe(2)
  expect(localAttempts).toBe(1)
})

it('checks coordinator and ancestor membership without changing cleanup state', async () => {
  const { database, token } = fixture()
  const { cleanup } = createAccountCleanupCoordinator(database, token, async () => {})
  const foreign = createAccountCleanupCoordinator(database, token, async () => {}).cleanup.reader({ async dispose() {} })
  let calls = 0
  const resource = cleanup.reader({ async dispose() { calls++ } })
  const child = cleanup.group([resource]), parent = cleanup.group([child])
  expect(() => assertAccountCleanupJoinable(resource, child)).not.toThrow()
  expect(() => assertAccountCleanupJoinable(parent, resource)).not.toThrow()
  expect(() => assertAccountCleanupJoinable(parent, child)).not.toThrow()
  expect(() => assertAccountCleanupJoinable(parent, { ...resource })).toThrow()
  expect(() => assertAccountCleanupJoinable(parent, foreign)).toThrow()
  expect(() => assertAccountCleanupJoinable(resource, foreign)).toThrow()
  expect(() => assertAccountCleanupJoinable(parent, parent)).toThrow()
  expect(() => assertAccountCleanupJoinable(child, parent)).toThrow()
  expect(parent.observe()).toEqual({ attempt: 0, status: 'not-started' })
  expect(child.observe()).toEqual({ attempt: 0, status: 'not-started' })
  expect(calls).toBe(0)
  expect(await parent.request()).toEqual({ attempt: 1, status: 'succeeded' })
  expect(calls).toBe(1)
})

it('registersClosedTransferredAndInvalidatedOwnersWithoutRestoringAdmission', async () => {
  const { database, token } = fixture()
  const parent = createAccountPreparationOwner(database, token), child = createAccountPreparationOwner(database, token)
  const closed = createAccountPreparationOwner(database, token)
  const record = await stageAccountBytes(database, token, new Uint8Array([81]), [], undefined, child)
  await parent.adopt(child)
  await closed.abandon()
  invalidateProfile()
  const { cleanup } = createAccountCleanupCoordinator(database, token, async () => {})
  expect(await cleanup.owner(child).request()).toEqual({ attempt: 1, status: 'succeeded' })
  expect(await database.stagedCipherChunks.get([record.payloadId, 0])).toBeDefined()
  expect(await cleanup.owner(closed).request()).toEqual({ attempt: 1, status: 'succeeded' })
  expect(await cleanup.owner(parent).request()).toEqual({ attempt: 1, status: 'succeeded' })
  expect(await database.stagedCipherChunks.get([record.payloadId, 0])).toBeUndefined()
  expect(() => parent.check()).toThrow('PROFILE_CHANGED')
})

it('waitsThePendingFirstAttemptBeforeAdvancingItsFailure', async () => {
  const { database, token } = fixture()
  const entered = deferred(), gate = deferred()
  const coordinator = createAccountCleanupCoordinator(database, token, async () => { entered.resolve() })
  let calls = 0
  const join = coordinator.cleanup.reader({ async dispose() {
    if (++calls === 1) { await gate.promise; throw new Error('first failure') }
  } })
  const first = join.request()
  const retry = coordinator.retryFailed([join])
  await entered.promise
  await Promise.resolve()
  expect(calls).toBe(1)
  expect(join.observe()).toEqual({ attempt: 1, status: 'pending' })
  gate.resolve()
  await retry
  expect(await first).toMatchObject({ attempt: 1, status: 'failed' })
  expect(join.observe()).toEqual({ attempt: 2, status: 'succeeded' })
  expect(calls).toBe(2)
})

it('keepsGroupRequestAndWaitSnapshotsFiniteWhenMembershipGrows', async () => {
  const { database, token } = fixture()
  const { cleanup } = createAccountCleanupCoordinator(database, token, async () => {})
  const firstGate = deferred(), lateGate = deferred()
  const first = cleanup.reader({ dispose: () => firstGate.promise })
  const late = cleanup.reader({ dispose: () => lateGate.promise })
  const group = cleanup.group([first])
  const requested = group.request(), waiting = group.wait()
  group.include(late)
  firstGate.resolve()
  expect(await requested).toEqual({ attempt: 1, status: 'succeeded' })
  expect(await waiting).toEqual({ attempt: 1, status: 'succeeded' })
  expect(group.observe()).toEqual({ attempt: 1, status: 'pending' })
  lateGate.resolve()
  expect(await group.wait()).toEqual({ attempt: 1, status: 'succeeded' })
})

it('compares exact failed attempts across partial retry, aliases and equal group diagnostics', async () => {
  const { database, token } = fixture()
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  const shared = new Error('same physical diagnostic')
  let aCalls = 0
  const a = coordinator.cleanup.reader({ async dispose() { aCalls++; throw shared } })
  const b = coordinator.cleanup.reader({ async dispose() { throw shared } })
  await b.request()
  await coordinator.retryFailed([b]).catch(() => {})
  const incoming = coordinator.cleanup.group([a, b])
  const historical = await incoming.request()
  const alias = await coordinator.cleanup.group([incoming, a]).request()
  expect(hasNewAccountCleanupFailure(alias, historical)).toBe(false)
  await coordinator.retryFailed([a]).catch(() => {})
  const current = await incoming.request()
  expect(current).toEqual(historical)
  expect(current.attempt).toBe(historical.attempt)
  expect(aCalls).toBe(2)
  expect(hasNewAccountCleanupFailure(current, historical)).toBe(true)
  expect(hasNewAccountCleanupFailure(historical, current)).toBe(true)
  const after = await coordinator.cleanup.group([incoming]).request()
  expect(hasNewAccountCleanupFailure(after, current)).toBe(false)
  const oldCarrier = accountCleanupOnlyFailure(incoming, historical)
  expect(readAccountCleanupOnlyFailure(oldCarrier)?.result).toBe(historical)
})

it('pins finite group request provenance across late includes and rejects nonrequest results', async () => {
  const { database, token } = fixture()
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  const other = createAccountCleanupCoordinator(database, token, async () => {})
  const shared = new Error('same diagnostic value')
  const gate = deferred()
  const first = coordinator.cleanup.reader({ async dispose() { await gate.promise; throw shared } })
  const group = coordinator.cleanup.group([first])
  const captured = group.request()
  const late = coordinator.cleanup.reader({ async dispose() { throw shared } })
  group.include(late)
  gate.resolve()
  const historical = await captured
  const latest = await group.request()
  expect(historical).toMatchObject({ status: 'failed', errors: [shared] })
  expect(latest).toMatchObject({ status: 'failed', errors: [shared, shared] })
  expect(hasNewAccountCleanupFailure(latest, historical)).toBe(true)
  expect(hasNewAccountCleanupFailure(historical, latest)).toBe(false)
  expect(hasNewAccountCleanupFailure(await coordinator.cleanup.group([group, late]).request(), latest)).toBe(false)
  const after = coordinator.cleanup.reader({ async dispose() { throw shared } })
  group.include(after)
  expect(hasNewAccountCleanupFailure(await group.request(), latest)).toBe(true)
  expect(() => hasNewAccountCleanupFailure({ ...latest }, historical)).toThrow(/exact|registered/i)
  expect(() => hasNewAccountCleanupFailure(latest, { ...historical })).toThrow(/exact|registered/i)
  expect(() => hasNewAccountCleanupFailure(group.observe() as typeof latest, historical)).toThrow(/exact|registered/i)
  const waited = await group.wait()
  expect(() => hasNewAccountCleanupFailure(waited as typeof latest, historical)).toThrow(/exact|registered/i)
  const foreign = await other.cleanup.reader({ async dispose() { throw shared } }).request()
  expect(() => hasNewAccountCleanupFailure(latest, foreign)).toThrow(/same|foreign/i)
})

it.each((['subtree', 'dispatch', 'projection', 'nested-subtree', 'nested-evidence'] as const).flatMap(route => [false, true].map(failing => ({ route, failing }))))('nestedOpeningFailureRetainsFirstReaderDisposalFailure (%j)', async ({ route, failing }) => {
  const { prepareAccountWorkspace, authenticateAccountWorkspaceSubtree } = await import('../workspace/account-graph')
  const { createBlankLocalData } = await import('../domain/local-data')
  const streams = await import('../workspace/account-streams')
  const { database, token } = fixture(), localData = createBlankLocalData()
  const prepared = await prepareAccountWorkspace(database, token, { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], evidence: [], sources: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } })
  await database.encryptedRevisions.bulkAdd(prepared.records)
  let head = prepared.head
  let evidenceRoot: string | undefined
  if (route === 'nested-evidence') {
    const { createAccountInheritedEvidencePreparation } = await import('../workspace/account-evidence-snapshots')
    const { stageAccountWorkspaceGraph } = await import('../workspace/account-graph')
    const inherited = await createAccountInheritedEvidencePreparation(database, token).prepare({})
    await database.encryptedRevisions.bulkAdd([...inherited.records])
    const owner = createAccountPreparationOwner(database, token)
    const graph = await stageAccountWorkspaceGraph(database, token, prepared.opened.state, { owner, rootFormat: { version: 2, inheritedEvidence: inherited.root } })
    await database.encryptedRevisions.bulkAdd([...graph.records])
    head = graph.head; evidenceRoot = inherited.root.revisionId
    await inherited.dispose(); await owner.abandon()
  }
  if (route === 'projection') {
    const { stageAccountJson } = await import('../workspace/account-cache')
    const record = await stageAccountJson(database, token, { version: 1, kind: 'local-planner-cache', localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], bundledCatalogs: [], evidence: [], sources: [] }, [])
    await database.encryptedRevisions.add(record); head = cipherRef(record)
  }
  const before = await Promise.all(database.tables.map(table => table.toArray()))
  const coordinator = createAccountCleanupCoordinator(database, token, async () => {})
  const reached = deferred(), resume = deferred(), cleanupError = new Error('physical return failure'), primary = new Error('physical return failure')
  let join!: AccountCleanupJoin, attempts = 0, returns = 0, decrypted = 0, opens = 0
  const attemptCounts: number[] = []
  const reader = coordinator.cleanup.reader
  const cleanup = { ...coordinator.cleanup, reader(raw: { dispose(): Promise<void> }) {
    const dispose = raw.dispose.bind(raw)
    const index = attemptCounts.push(0) - 1
    vi.spyOn(raw, 'dispose').mockImplementation(() => { attemptCounts[index]++; if (reader(raw) === join) attempts++; return dispose() })
    join = reader(raw)
    return join
  } }
  const open = streams.openAccountSource
  vi.spyOn(streams, 'openAccountSource').mockImplementation(async (...args) => {
    const source = await open(...args)
    opens++
    if (route === 'nested-subtree' && opens === 1 || route === 'nested-evidence' && args[2].revisionId !== evidenceRoot) return source
    return { ...source, open(): AsyncIterableIterator<Uint8Array> {
      const input = source.open()[Symbol.asyncIterator]()
      return { async next() {
        const next = await input.next()
        if (!next.done) { decrypted += next.value.length; reached.resolve(); await resume.promise; throw primary }
        return next
      }, async return() {
        await input.return?.(); returns++
        if (failing && returns === 1) throw cleanupError
        return { done: true as const, value: undefined }
      }, [Symbol.asyncIterator]() { return this } }
    } }
  })
  const { openInactiveAccountWorkspace } = await import('../workspace/account-inactive-graph')
  const opening = (route === 'subtree' ? authenticateAccountWorkspaceSubtree(database, token, head, { version: 1, cleanup }) : openInactiveAccountWorkspace(database, token, head, { cleanup, ...(route === 'projection' ? { inputFormat: 'legacy-projection' as const } : {}) })).then(value => value, error => error)
  await reached.promise
  expect(decrypted).toBeGreaterThan(0)
  const first = await join.request()
  resume.resolve()
  const rejected = await opening
  expect(first).toMatchObject({ attempt: 1, status: failing ? 'failed' : 'succeeded' })
  if (first.status === 'failed') {
    expect((first.errors[0] as AggregateError).errors).toEqual([cleanupError])
    const carried = readAccountPreparationFailure(rejected)
    expect(carried).toBeDefined()
    expect(await carried!.cleanup.request()).toMatchObject({ attempt: 1, status: 'failed', errors: first.errors })
    expect(carried!.primary).toBe(primary)
  } else expect(rejected).toBe(primary)
  expect(attempts).toBe(1)
  expect(attemptCounts.every(count => count === 1)).toBe(true)
  expect(await join.request()).toBe(first)
  // Graph readers also return from their explicit finally; C preserves for-await's
  // next-rejection behavior, which performs no additional natural iterator return
  expect(returns).toBe(route === 'nested-evidence' ? 1 : 2)
  expect(await Promise.all(database.tables.map(table => table.toArray()))).toEqual(before)
})
