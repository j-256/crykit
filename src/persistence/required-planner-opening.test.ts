import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { captureProfileEpoch, invalidateProfile, ProfileChangedError } from '../account/profile'
import { openRequiredGuestPlanner } from '../workspace/open-required-guest-planner'
import { assertRequiredPlannerDatabaseOpen, CryKitDatabase } from './database'

const native = indexedDB
const names: string[] = []
const handles: CryKitDatabase[] = []
const schema: Record<string, { keyPath: string; indexes: Record<string, string | string[]> }> = {
  localDatas: { keyPath: 'id', indexes: { revision: 'revision', updatedAt: 'updatedAt' } },
  catalogs: { keyPath: 'key', indexes: { id: 'id', revisionId: 'revisionId', checksum: 'checksum' } },
  evidence: { keyPath: 'id', indexes: { sourceDigest: 'sourceDigest', group: 'group' } },
  sources: { keyPath: 'id', indexes: { digest: 'digest', format: 'format' } },
  history: { keyPath: 'id', indexes: { localDataId: 'localDataId', '[localDataId+nextRevision]': ['localDataId', 'nextRevision'] } },
  imports: { keyPath: 'id', indexes: { sourceDigest: 'sourceDigest', localDataId: 'localDataId' } },
  meta: { keyPath: 'key', indexes: {} },
}
function name() { const value = `owned-required-${crypto.randomUUID()}`; names.push(value); return value }
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () => reject(request.error))
  })
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function owner(controller = new AbortController()) { return { signal: controller.signal, assertCurrent: (): undefined => undefined } }
async function rejected(operation: PromiseLike<unknown>): Promise<unknown> {
  const outcome = await Promise.allSettled([operation])
  expect(outcome[0]!.status).toBe('rejected')
  return (outcome[0] as PromiseRejectedResult).reason as unknown
}
async function seed(target: string, version = 70, mutate?: (db: IDBDatabase, tx: IDBTransaction) => void) {
  const request = native.open(target, version)
  request.addEventListener('upgradeneeded', () => {
    for (const [storeName, shape] of Object.entries(schema)) {
      const store = request.result.createObjectStore(storeName, { keyPath: shape.keyPath })
      for (const [index, keyPath] of Object.entries(shape.indexes)) store.createIndex(index, keyPath)
    }
    request.transaction!.objectStore('meta').put({ key: 'sentinel', value: '{"old":true,"unknown":null}' })
    request.transaction!.objectStore('sources').put({ id: 'historical-source', bytes: new Uint8Array([0, 255, 5]) })
    mutate?.(request.result, request.transaction!)
  })
  const database = await requestResult(request); database.close()
}
async function snapshot(target: string) {
  let missing = false
  const request = native.open(target)
  request.addEventListener('upgradeneeded', () => { missing = true; request.transaction!.abort() })
  const database = await requestResult(request).catch(error => { if (missing) return undefined; throw error })
  if (!database) return { exists: false }
  try {
    const stores = await Promise.all(Array.from(database.objectStoreNames).sort().map(async storeName => {
      const store = database.transaction(storeName, 'readonly').objectStore(storeName)
      const indexes = Array.from(store.indexNames).sort().map(indexName => {
        const index = store.index(indexName)
        return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry }
      })
      const keys = requestResult(store.getAllKeys()), values = requestResult(store.getAll())
      return { name: storeName, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes, keys: await keys, values: await values }
    }))
    return { exists: true, version: database.version, stores }
  } finally { database.close() }
}
async function independentUpgrade(target: string, version: number) {
  const request = native.open(target, version)
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () => reject(request.error))
    request.addEventListener('blocked', () => reject(new Error('Required opener retained a native connection')))
  })
  database.close()
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const handle of handles.splice(0)) handle.close()
  for (const target of names.splice(0)) await requestResult(native.deleteDatabase(target))
})

it('returns only a live required handle for a complete existing native layout', async () => {
  const target = name(); await seed(target)
  const before = await snapshot(target), calls: [string, number | undefined][] = [], original = native.open.bind(native)
  const spy = vi.spyOn(native, 'open').mockImplementation((requestedName, version) => { calls.push([requestedName, version]); return original(requestedName, version) })
  const handle = await openRequiredGuestPlanner(target, owner()); handles.push(handle)
  assertRequiredPlannerDatabaseOpen(handle)
  expect(handle.plannerFormatRequirement).toBe('journaled')
  expect(await handle.meta.get('sentinel')).toEqual({ key: 'sentinel', value: '{"old":true,"unknown":null}' })
  await handle.open()
  expect(calls).toEqual([[target, 70]])
  spy.mockRestore(); handle.close()
  expect(await snapshot(target)).toEqual(before)
})

it.each(['absent', 'older', 'future', 'missing store', 'missing index'] as const)('rejects %s without creating, upgrading or repairing stored data', async kind => {
  const target = name()
  if (kind !== 'absent') await seed(target, kind === 'older' ? 50 : kind === 'future' ? 80 : 70, (database, transaction) => {
    if (kind === 'missing store') database.deleteObjectStore('imports')
    if (kind === 'missing index') transaction.objectStore('sources').deleteIndex('digest')
  })
  const before = await snapshot(target)
  const failure = await rejected(openRequiredGuestPlanner(target, owner()))
  expect(failure).toMatchObject({ code: 'schema-mismatch', recoverable: true })
  expect(await snapshot(target)).toEqual(before)
  if (kind !== 'future') await independentUpgrade(target, kind === 'absent' ? 1 : kind === 'older' ? 51 : 71)
})

it('rejects a preaborted owner without constructing or issuing a native request', async () => {
  const target = name(); await seed(target)
  const before = await snapshot(target), reason = new ProfileChangedError(), controller = new AbortController()
  controller.abort(reason)
  const nativeOpen = vi.spyOn(native, 'open')
  expect(await rejected(openRequiredGuestPlanner(target, owner(controller)))).toBe(reason)
  expect(nativeOpen).not.toHaveBeenCalled()
  nativeOpen.mockRestore()
  expect(await snapshot(target)).toEqual(before)
})

it('does not expose a candidate while its native request is blocked and rejects before release on profile invalidation', async () => {
  const target = name(); await seed(target, 50)
  const before = await snapshot(target), holder = await requestResult(native.open(target, 50))
  const entered = deferred(), blocked = deferred(), original = native.open.bind(native)
  const spy = vi.spyOn(native, 'open').mockImplementation((requestedName, version) => {
    const request = original(requestedName, version)
    if (requestedName === target && version === 70) {
      entered.resolve()
      request.addEventListener('blocked', () => blocked.resolve())
    }
    return request
  })
  const captured = captureProfileEpoch()
  const opening = openRequiredGuestPlanner(target, { signal: captured.signal, assertCurrent: (): undefined => { captured.assertCurrent(); return undefined } })
  let exposed = false
  void opening.then(() => { exposed = true }, () => {})
  const completion = rejected(opening)
  try {
    await entered.promise; await blocked.promise
    expect(exposed).toBe(false)
    invalidateProfile()
    expect(await completion).toBeInstanceOf(ProfileChangedError)
    expect(exposed).toBe(false)
  } finally { holder.close(); spy.mockRestore() }
  expect(await snapshot(target)).toEqual(before)
  await independentUpgrade(target, 51)
})

it('discards a fully opened candidate when currentness changes at the post-open gate', async () => {
  const target = name(); await seed(target)
  const before = await snapshot(target)
  let gates = 0
  const changed = new ProfileChangedError()
  const failure = await rejected(openRequiredGuestPlanner(target, {
    signal: new AbortController().signal,
    assertCurrent: (): undefined => { if (++gates === 3) throw changed; return undefined },
  }))
  expect(failure).toBe(changed)
  expect(gates).toBe(3)
  expect(await snapshot(target)).toEqual(before)
  await independentUpgrade(target, 71)
})

it('treats an asynchronous owner callback as invalid before any native request and observes its rejection', async () => {
  const target = name(); await seed(target)
  const before = await snapshot(target), callbackFailure = new Error('late callback rejection')
  const nativeOpen = vi.spyOn(native, 'open')
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const failure = await rejected(openRequiredGuestPlanner(target, {
      signal: new AbortController().signal,
      assertCurrent: (async () => { throw callbackFailure }) as unknown as () => undefined,
    }))
    expect(failure).toBeInstanceOf(TypeError)
    expect(nativeOpen).not.toHaveBeenCalled()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(unhandled).toEqual([])
  } finally { process.off('unhandledRejection', onUnhandled); nativeOpen.mockRestore() }
  expect(await snapshot(target)).toEqual(before)
})

it.each([2, 3])('rejects an asynchronous owner callback at currentness gate %s and releases the candidate', async invalidGate => {
  const target = name(); await seed(target)
  const before = await snapshot(target), callbackFailure = new Error('late callback rejection')
  const seen: unknown[] = []
  const onUnhandled = (reason: unknown) => { seen.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  let calls = 0
  try {
    const failure = await rejected(openRequiredGuestPlanner(target, {
      signal: new AbortController().signal,
      assertCurrent: (() => ++calls === invalidGate ? Promise.reject(callbackFailure) : undefined) as () => undefined,
    }))
    expect(failure).toBeInstanceOf(TypeError)
    expect(calls).toBe(invalidGate)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(seen).toEqual([])
    expect(await snapshot(target)).toEqual(before)
    await independentUpgrade(target, 71)
  } finally { process.off('unhandledRejection', onUnhandled) }
})

it('uses one captured signal even when the owner getter later returns a different aborted signal', async () => {
  const target = name(); await seed(target)
  const active = new AbortController(), stale = new AbortController()
  stale.abort(new Error('different signal'))
  let getters = 0
  const handle = await openRequiredGuestPlanner(target, {
    get signal() { return ++getters === 1 ? active.signal : stale.signal },
    assertCurrent: (): undefined => undefined,
  })
  handles.push(handle)
  expect(getters).toBe(1)
  assertRequiredPlannerDatabaseOpen(handle)
})

it.each([false, true])('preserves %s invalid-return precedence when the owner aborts itself before opening', async invalidReturn => {
  const target = name(); await seed(target)
  const before = await snapshot(target), controller = new AbortController(), reason = new ProfileChangedError()
  const observation = vi.spyOn(native, 'open')
  let calls = 0
  const result = await rejected(openRequiredGuestPlanner(target, {
    signal: controller.signal,
    assertCurrent: (() => {
      if (++calls !== 2) return undefined
      controller.abort(reason)
      return invalidReturn ? Promise.reject(new Error('late assertion failure')) : undefined
    }) as () => undefined,
  }))
  expect(result).toBeInstanceOf(invalidReturn ? TypeError : ProfileChangedError)
  if (!invalidReturn) expect(result).toBe(reason)
  expect(observation).not.toHaveBeenCalled()
  observation.mockRestore()
  expect(await snapshot(target)).toEqual(before)
})

it('preserves a non-schema native storage failure without relabeling it as a schema denial', async () => {
  const target = name(); await seed(target)
  const before = await snapshot(target), storageError = new DOMException('Storage access denied', 'SecurityError')
  const saved = Dexie.dependencies.indexedDB
  try {
    Dexie.dependencies.indexedDB = { open: () => { throw storageError } } as unknown as IDBFactory
    const failure = await rejected(openRequiredGuestPlanner(target, owner()))
    expect(failure).not.toMatchObject({ code: 'schema-mismatch' })
    expect(failure).toMatchObject({ name: 'SecurityError' })
  } finally { Dexie.dependencies.indexedDB = saved }
  expect(await snapshot(target)).toEqual(before)
})

it('does not turn missing native storage capability into a schema diagnosis', async () => {
  const target = name(); await seed(target)
  const before = await snapshot(target), saved = Dexie.dependencies.indexedDB
  try {
    Dexie.dependencies.indexedDB = undefined as unknown as IDBFactory
    const failure = await rejected(openRequiredGuestPlanner(target, owner()))
    expect(failure).not.toMatchObject({ code: 'schema-mismatch' })
    expect(failure).toBeInstanceOf(Dexie.MissingAPIError)
  } finally { Dexie.dependencies.indexedDB = saved }
  expect(await snapshot(target)).toEqual(before)
})

it('prefers a stale owner over an unrelated native storage failure observed during opening', async () => {
  const target = name(); await seed(target)
  const before = await snapshot(target), saved = Dexie.dependencies.indexedDB
  const storageError = new DOMException('Storage access denied', 'SecurityError')
  const ownerError = new ProfileChangedError()
  let stale = false
  try {
    Dexie.dependencies.indexedDB = { open: () => { stale = true; throw storageError } } as unknown as IDBFactory
    const failure = await rejected(openRequiredGuestPlanner(target, {
      signal: new AbortController().signal,
      assertCurrent: (): undefined => { if (stale) throw ownerError; return undefined },
    }))
    expect(failure).toBe(ownerError)
  } finally { Dexie.dependencies.indexedDB = saved }
  expect(await snapshot(target)).toEqual(before)
})

it('does not normalize a final admission failure after successful opening', async () => {
  const target = name(); await seed(target)
  const before = await snapshot(target), realOpen = CryKitDatabase.prototype.open
  let candidate: CryKitDatabase | undefined
  const spy = vi.spyOn(CryKitDatabase.prototype, 'open').mockImplementation(function (this: CryKitDatabase) {
    candidate = this
    return realOpen.call(this)
  })
  let gates = 0
  try {
    const failure = await rejected(openRequiredGuestPlanner(target, {
      signal: new AbortController().signal,
      assertCurrent: (): undefined => { if (++gates === 3) candidate!.close(); return undefined },
    }))
    expect(failure).toBeInstanceOf(Dexie.DatabaseClosedError)
    expect(failure).not.toMatchObject({ code: 'schema-mismatch' })
    expect(gates).toBe(3)
  } finally { spy.mockRestore() }
  expect(await snapshot(target)).toEqual(before)
  await independentUpgrade(target, 71)
})

it('retains a post-open owner failure ahead of a final close failure', async () => {
  const target = name(); await seed(target)
  const before = await snapshot(target), realClose = CryKitDatabase.prototype.close
  const ownerError = new ProfileChangedError(), closeError = new Error('final close failed after disposal')
  const spy = vi.spyOn(CryKitDatabase.prototype, 'close').mockImplementation(function (this: CryKitDatabase) {
    realClose.call(this)
    throw closeError
  })
  let gates = 0
  try {
    const failure = await rejected(openRequiredGuestPlanner(target, {
      signal: new AbortController().signal,
      assertCurrent: (): undefined => { if (++gates === 3) throw ownerError; return undefined },
    }))
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([ownerError, closeError])
    expect((failure as Error & { cause: unknown }).cause).toBe(ownerError)
  } finally { spy.mockRestore() }
  expect(await snapshot(target)).toEqual(before)
  await independentUpgrade(target, 71)
})

it('does not cache a required handle or share its terminal lifetime with another invocation', async () => {
  const target = name(); await seed(target)
  const [first, second] = await Promise.all([openRequiredGuestPlanner(target, owner()), openRequiredGuestPlanner(target, owner())])
  handles.push(first, second)
  expect(first).not.toBe(second)
  const firstNative = first.backendDB(), secondNative = second.backendDB()
  expect(firstNative).not.toBe(secondNative)
  first.close()
  expect(() => assertRequiredPlannerDatabaseOpen(first)).toThrow(Dexie.DatabaseClosedError)
  assertRequiredPlannerDatabaseOpen(second)
  expect(await second.meta.get('sentinel')).toBeDefined()
})

it('keeps the captured profile cancellation primary when a blocked native upgrade later denies the old layout', async () => {
  const target = name(); await seed(target, 50)
  const before = await snapshot(target), holder = await requestResult(native.open(target, 50))
  const entered = deferred(), blocked = deferred(), original = native.open.bind(native)
  const spy = vi.spyOn(native, 'open').mockImplementation((requestedName, version) => {
    const request = original(requestedName, version)
    if (requestedName === target && version === 70) {
      entered.resolve()
      request.addEventListener('blocked', () => blocked.resolve())
    }
    return request
  })
  const controller = new AbortController(), reason = new ProfileChangedError()
  const completion = rejected(openRequiredGuestPlanner(target, owner(controller)))
  try {
    await entered.promise; await blocked.promise
    controller.abort(reason)
    expect(await completion).toBe(reason)
  } finally { holder.close(); spy.mockRestore() }
  expect(await snapshot(target)).toEqual(before)
  await independentUpgrade(target, 51)
})

it('keeps an observed owned schema denial primary when cancellation arrives during failure cleanup', async () => {
  const target = name(); await seed(target, 50)
  const before = await snapshot(target), controller = new AbortController(), reason = new ProfileChangedError()
  const signal = {
    get aborted() { return controller.signal.aborted },
    get reason() { return controller.signal.reason },
    addEventListener: controller.signal.addEventListener.bind(controller.signal),
    removeEventListener: (...args: Parameters<AbortSignal['removeEventListener']>) => {
      controller.abort(reason)
      controller.signal.removeEventListener(...args)
    },
  } as AbortSignal
  const failure = await rejected(openRequiredGuestPlanner(target, { signal, assertCurrent: (): undefined => undefined }))
  expect(controller.signal.aborted).toBe(true)
  expect(failure).toMatchObject({ code: 'schema-mismatch', recoverable: true })
  expect(await snapshot(target)).toEqual(before)
  await independentUpgrade(target, 51)
})

it('closes a queued native success that arrives after the owner was cancelled', async () => {
  const target = name(); await seed(target)
  const before = await snapshot(target), holder = await requestResult(native.open(target, 70))
  const blocked = deferred(), competitor = native.open(target, 80)
  competitor.addEventListener('blocked', () => blocked.resolve())
  competitor.addEventListener('upgradeneeded', () => competitor.transaction!.abort())
  const competitorDone = requestResult(competitor).catch(error => error)
  await blocked.promise
  const entered = deferred(), original = native.open.bind(native)
  const spy = vi.spyOn(native, 'open').mockImplementation((requestedName, version) => {
    const request = original(requestedName, version)
    if (requestedName === target && version === 70) entered.resolve()
    return request
  })
  const controller = new AbortController(), reason = new ProfileChangedError()
  const completion = rejected(openRequiredGuestPlanner(target, owner(controller)))
  try {
    await entered.promise
    controller.abort(reason)
    expect(await completion).toBe(reason)
  } finally { holder.close(); spy.mockRestore() }
  await competitorDone
  expect(await snapshot(target)).toEqual(before)
  await independentUpgrade(target, 71)
})

it('keeps listener and final close errors after the exact cancellation primary', async () => {
  const target = name(); await seed(target, 50)
  const before = await snapshot(target), holder = await requestResult(native.open(target, 50))
  const entered = deferred(), blocked = deferred(), originalOpen = native.open.bind(native)
  const openSpy = vi.spyOn(native, 'open').mockImplementation((requestedName, version) => {
    const request = originalOpen(requestedName, version)
    if (requestedName === target && version === 70) {
      entered.resolve(); request.addEventListener('blocked', () => blocked.resolve())
    }
    return request
  })
  const realClose = CryKitDatabase.prototype.close, cleanupError = new Error('close failed after disposal')
  const closeSpy = vi.spyOn(CryKitDatabase.prototype, 'close').mockImplementation(function (this: CryKitDatabase) {
    realClose.call(this)
    throw cleanupError
  })
  const controller = new AbortController(), reason = new ProfileChangedError()
  const completion = rejected(openRequiredGuestPlanner(target, owner(controller)))
  try {
    await entered.promise; await blocked.promise
    controller.abort(reason)
    const failure = await completion
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([reason, cleanupError, cleanupError])
    expect((failure as Error & { cause: unknown }).cause).toBe(reason)
  } finally { holder.close(); closeSpy.mockRestore(); openSpy.mockRestore() }
  expect(await snapshot(target)).toEqual(before)
  await independentUpgrade(target, 51)
})
