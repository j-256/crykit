import 'fake-indexeddb/auto'
import { forceCloseDatabase } from 'fake-indexeddb'
import Dexie from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestLocalData } from '../domain/test-helpers'
import { AppDataError } from '../interchange/errors'
import { loadLocalData } from './local-data'
import { assertRequiredPlannerDatabaseOpen, CryKitDatabase, captureRequiredPlannerOpeningError } from './database'

// Native fixtures and snapshots never use the class under test, so inspection cannot repair the target
const native = indexedDB
// Fixture versions are independent of the admission class so it cannot certify its own expectations
const CURRENT_NATIVE_VERSION = 70
const RETAINED_NATIVE_VERSION = 60
const FUTURE_NATIVE_VERSION = 80
const names: string[] = []
const handles: CryKitDatabase[] = []
const layout: Record<string, { keyPath: string; indexes: Record<string, string | string[]> }> = {
  localDatas: { keyPath: 'id', indexes: { revision: 'revision', updatedAt: 'updatedAt' } },
  catalogs: { keyPath: 'key', indexes: { id: 'id', revisionId: 'revisionId', checksum: 'checksum' } },
  evidence: { keyPath: 'id', indexes: { sourceDigest: 'sourceDigest', group: 'group' } },
  sources: { keyPath: 'id', indexes: { digest: 'digest', format: 'format' } },
  history: { keyPath: 'id', indexes: { localDataId: 'localDataId', '[localDataId+nextRevision]': ['localDataId', 'nextRevision'] } },
  imports: { keyPath: 'id', indexes: { sourceDigest: 'sourceDigest', localDataId: 'localDataId' } },
  meta: { keyPath: 'key', indexes: {} },
}
function freshName() { const name = `required-opening-${crypto.randomUUID()}`; names.push(name); return name }
function required(name: string) { const db = new CryKitDatabase(name, { plannerFormatRequirement: 'journaled' }); handles.push(db); return db }
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.addEventListener('success', () => resolve(request.result)); request.addEventListener('error', () => reject(request.error)) })
}
async function seed(name: string, version = CURRENT_NATIVE_VERSION, change?: (db: IDBDatabase, tx: IDBTransaction) => void) {
  const request = native.open(name, version)
  request.addEventListener('upgradeneeded', () => {
    for (const [name, schema] of Object.entries(layout)) {
      const store = request.result.createObjectStore(name, { keyPath: schema.keyPath })
      for (const [index, keyPath] of Object.entries(schema.indexes)) store.createIndex(index, keyPath)
    }
    request.transaction!.objectStore('meta').put({ key: 'sentinel', value: 'unrelated' })
    request.transaction!.objectStore('sources').put({ id: 'sentinel-source', bytes: new Uint8Array([0, 255, 17]), buffer: new Uint8Array([31, 0]).buffer })
    change?.(request.result, request.transaction!)
  })
  const db = await result(request); db.close()
}
async function snapshot(name: string) {
  let absent = false
  const request = native.open(name)
  request.addEventListener('upgradeneeded', () => { absent = true; request.transaction!.abort() })
  const db = await result(request).catch(error => { if (absent) return undefined; throw error })
  if (!db) return { exists: false }
  try {
    const storeNames = Array.from(db.objectStoreNames).sort()
    const stores = storeNames.length ? await Promise.all(storeNames.map(async name => {
      const store = db.transaction(name, 'readonly').objectStore(name)
      const indexes = Array.from(store.indexNames).sort().map(name => {
        const index = store.index(name)
        return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry }
      })
      const keys = result(store.getAllKeys()), values = result(store.getAll())
      return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes, keys: await keys, values: await values }
    })) : []
    return { exists: true, version: db.version, stores }
  } finally { db.close() }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const db of handles.splice(0)) db.close()
  for (const name of names.splice(0)) await result(native.deleteDatabase(name))
})

describe('required initial opening leaves native storage unchanged', () => {
  it('rejects absence without committing an empty database', async () => {
    const name = freshName(), before = await snapshot(name)
    const outcome = await Promise.allSettled([required(name).open()])
    for (const db of handles) db.close()
    expect(await snapshot(name)).toEqual(before)
    expect(outcome[0]!.status).toBe('rejected')
  })
  it.each(['missing store', 'missing index', 'future complete', 'renamed index'])('rejects %s without repair or fallback', async kind => {
    const name = freshName()
    await seed(name, kind === 'future complete' ? FUTURE_NATIVE_VERSION : CURRENT_NATIVE_VERSION, (db, tx) => {
      if (kind === 'missing store') db.deleteObjectStore('imports')
      if (kind === 'missing index' || kind === 'renamed index') tx.objectStore('sources').deleteIndex('digest')
      if (kind === 'renamed index') tx.objectStore('sources').createIndex('otherDigest', 'digest')
    })
    const before = await snapshot(name)
    const outcome = await Promise.allSettled([required(name).open()])
    for (const db of handles) db.close()
    expect(await snapshot(name)).toEqual(before)
    expect(outcome[0]!.status).toBe('rejected')
  })
})


function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function rejected(operation: PromiseLike<unknown>): Promise<unknown> {
  const outcome = await Promise.allSettled([operation])
  expect(outcome[0]!.status).toBe('rejected')
  return (outcome[0] as PromiseRejectedResult).reason as unknown
}
const closeOptions = [undefined, { disableAutoOpen: true }, { disableAutoOpen: false }, {} as { disableAutoOpen: boolean }]
const entryPaths = ['open', 'table', 'transaction'] as const
function enter(db: CryKitDatabase, path: typeof entryPaths[number]) {
  if (path === 'open') return db.open()
  if (path === 'table') return db.meta.toArray()
  return db.transaction('r', db.meta, () => db.meta.get('sentinel'))
}
function observeNativeOpen() {
  const original = native.open.bind(native), calls: [string, number | undefined][] = []
  const requested = deferred<IDBOpenDBRequest>()
  const spy = vi.spyOn(native, 'open').mockImplementation((name, version) => {
    calls.push([name, version])
    const request = original(name, version)
    requested.resolve(request)
    return request
  })
  return { calls, requested: requested.promise, spy, original }
}

it.each([10, 30, 50, RETAINED_NATIVE_VERSION, CURRENT_NATIVE_VERSION - 1, CURRENT_NATIVE_VERSION + 1, FUTURE_NATIVE_VERSION])('refuses native version %s across cold public paths without changing any rows', async version => {
  const name = freshName(); await seed(name, version)
  const before = await snapshot(name)
  for (const path of entryPaths) {
    const observation = observeNativeOpen(), db = required(name), normalize = captureRequiredPlannerOpeningError(db)
    const error = await rejected(enter(db, path))
    expect(normalize(error)).toMatchObject({ code: 'schema-mismatch', recoverable: true, cause: error })
    expect(observation.calls).toEqual([[name, CURRENT_NATIVE_VERSION]])
    observation.spy.mockRestore()
    expect(await snapshot(name)).toEqual(before)
    expect(await rejected(db.open())).toBeInstanceOf(Dexie.DatabaseClosedError)
  }
})

const schemaChanges: [string, (db: IDBDatabase, tx: IDBTransaction) => void][] = [
  ['empty schema', db => { for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name) }],
  ['extra store', db => { db.createObjectStore('extra') }],
  ['scalar primary key', db => { db.deleteObjectStore('meta'); db.createObjectStore('meta', { keyPath: 'other' }) }],
  ['compound primary key', db => { db.deleteObjectStore('meta'); db.createObjectStore('meta', { keyPath: ['key'] }) }],
  ['out-of-line primary key', db => { db.deleteObjectStore('meta'); db.createObjectStore('meta') }],
  ['auto increment', db => { db.deleteObjectStore('meta'); db.createObjectStore('meta', { keyPath: 'key', autoIncrement: true }) }],
]
for (const [store, schema] of Object.entries(layout)) {
  schemaChanges.push([`missing store ${store}`, db => { db.deleteObjectStore(store) }])
  schemaChanges.push([`extra index ${store}`, (_db, tx) => { tx.objectStore(store).createIndex('extra', 'extra') }])
  for (const [name, keyPath] of Object.entries(schema.indexes)) {
    schemaChanges.push([`missing index ${store}/${name}`, (_db, tx) => { tx.objectStore(store).deleteIndex(name) }])
    for (const kind of ['renamed', 'keyPath', 'wrong field', 'unique', 'multiEntry'] as const) {
      if (kind === 'multiEntry' && Array.isArray(keyPath)) continue
      schemaChanges.push([`${kind} index ${store}/${name}`, (_db, tx) => {
        const target = tx.objectStore(store); target.deleteIndex(name)
        const replacement = kind === 'wrong field' ? 'otherField' : kind === 'keyPath' ? (Array.isArray(keyPath) ? [...keyPath].reverse() : [keyPath]) : keyPath
        target.createIndex(kind === 'renamed' ? `renamed-${name}` : name, replacement, { unique: kind === 'unique', multiEntry: kind === 'multiEntry' })
      }])
    }
  }
}
it.each(schemaChanges)('rejects %s using immutable schema descriptors', async (_label, change) => {
  const name = freshName(); await seed(name, CURRENT_NATIVE_VERSION, change)
  const before = await snapshot(name)
  const observation = observeNativeOpen()
  // Construct after instrumentation so the captured adapter is the one whose native requests are observed
  const guarded = required(name), normalize = captureRequiredPlannerOpeningError(guarded)
  const error = await rejected(guarded.open())
  expect(normalize(error)?.code).toBe('schema-mismatch')
  expect(observation.calls).toEqual([[name, CURRENT_NATIVE_VERSION]])
  observation.spy.mockRestore()
  expect(await snapshot(name)).toEqual(before)
})

it('admits the complete current layout but leaves missing journal tuple to transaction admission', async () => {
  const name = freshName(); await seed(name)
  const before = await snapshot(name), observation = observeNativeOpen(), db = required(name), normalize = captureRequiredPlannerOpeningError(db)
  const [first, second, table, transaction] = await Promise.all([db.open(), db.open(), db.meta.get('sentinel'), db.transaction('r', db.meta, () => db.meta.get('sentinel'))])
  expect(first).toBe(db); expect(second).toBe(db)
  expect(table).toEqual({ key: 'sentinel', value: 'unrelated' }); expect(transaction).toEqual(table)
  assertRequiredPlannerDatabaseOpen(db)
  await db.open(); await db.vip.open(); await db.open.bind(db)()
  assertRequiredPlannerDatabaseOpen(db.vip as CryKitDatabase)
  expect(observation.calls).toEqual([[name, CURRENT_NATIVE_VERSION]])
  const failure = await rejected(loadLocalData(db))
  expect(failure).toMatchObject({ code: 'schema-mismatch', userMessage: 'The journaled planner data is missing or invalid. Keep your draft and reopen the workspace' })
  expect(normalize(failure)).toBeUndefined()
  observation.spy.mockRestore(); db.close()
  expect(await snapshot(name)).toEqual(before)
})

it.each(closeOptions)('permanently retires required original and VIP after close %j', async options => {
  const name = freshName(); await seed(name)
  const observation = observeNativeOpen(), db = required(name)
  expect(() => assertRequiredPlannerDatabaseOpen(db)).toThrow(Dexie.DatabaseClosedError)
  await db.vip.open(); db.vip.close(options)
  expect(() => assertRequiredPlannerDatabaseOpen(db)).toThrow(Dexie.DatabaseClosedError)
  for (const path of entryPaths) expect(await rejected(enter(db, path))).toBeInstanceOf(Dexie.DatabaseClosedError)
  expect(await rejected(db.vip.open.bind(db.vip)())).toBeInstanceOf(Dexie.DatabaseClosedError)
  expect(observation.calls).toEqual([[name, CURRENT_NATIVE_VERSION]])
})
it('close before opening prevents all native requests and rejects a legacy admission claim', async () => {
  const name = freshName(), observation = observeNativeOpen(), db = required(name)
  db.close.bind(db)()
  for (const path of entryPaths) expect(await rejected(enter(db, path))).toBeInstanceOf(Dexie.DatabaseClosedError)
  expect(observation.calls).toEqual([])
  const legacy = new CryKitDatabase(name); handles.push(legacy)
  expect(() => assertRequiredPlannerDatabaseOpen(legacy)).toThrow(TypeError)
})

it.each(['absent', 'renamed', 'future', 'old'] as const)('requires a fresh handle after %s denial and independent replacement', async kind => {
  const name = freshName()
  if (kind !== 'absent') await seed(name, kind === 'old' ? 50 : kind === 'future' ? FUTURE_NATIVE_VERSION : CURRENT_NATIVE_VERSION, (_db, tx) => {
    if (kind === 'renamed') { tx.objectStore('sources').deleteIndex('digest'); tx.objectStore('sources').createIndex('renamed', 'digest') }
  })
  const db = required(name), normalize = captureRequiredPlannerOpeningError(db), failure = await rejected(db.open())
  expect(normalize(failure)?.code).toBe('schema-mismatch')
  await result(native.deleteDatabase(name)); await seed(name)
  const before = await snapshot(name), observation = observeNativeOpen()
  const later = await rejected(db.open())
  expect(later).toBeInstanceOf(Dexie.DatabaseClosedError)
  expect(normalize(later)).toBeUndefined()
  expect(observation.calls).toEqual([])
  const fresh = required(name); await fresh.open(); assertRequiredPlannerDatabaseOpen(fresh)
  observation.spy.mockRestore(); fresh.close()
  expect(await snapshot(name)).toEqual(before)
})

it.each(closeOptions)('refuses delete %j without changing unopened, admitted or terminal lifecycle', async options => {
  const name = freshName(); await seed(name)
  const before = await snapshot(name), observation = observeNativeOpen(), db = required(name), normalize = captureRequiredPlannerOpeningError(db)
  const deletion = vi.spyOn(native, 'deleteDatabase'), close = vi.spyOn(db, 'close')
  for (const phase of ['unopened', 'admitted', 'terminal']) {
    if (phase === 'admitted') await db.open()
    if (phase === 'terminal') db.close()
    const closeCount = close.mock.calls.length
    const promise = db.vip.delete(options)
    expect(promise).toBeInstanceOf(Dexie.Promise)
    const error = await rejected(promise)
    expect(error).toBeInstanceOf(TypeError)
    expect(error).toMatchObject({ message: 'Required planner handles cannot delete databases' })
    expect(normalize(error)).toBeUndefined()
    expect(close).toHaveBeenCalledTimes(closeCount)
    if (phase === 'admitted') { assertRequiredPlannerDatabaseOpen(db); await db.open(); expect(await db.meta.get('sentinel')).toBeDefined() }
  }
  expect(deletion).not.toHaveBeenCalled()
  expect(observation.calls).toEqual([[name, CURRENT_NATIVE_VERSION]])
  observation.spy.mockRestore(); deletion.mockRestore()
  expect(await snapshot(name)).toEqual(before)
})

it.each(closeOptions)('cancels queued I1 opening with close %j and releases its late native success', async options => {
  const name = freshName(); await seed(name, CURRENT_NATIVE_VERSION, (_db, tx) => tx.objectStore('sources').deleteIndex('digest'))
  const before = await snapshot(name), holder = await result(native.open(name, CURRENT_NATIVE_VERSION))
  const blocked = deferred(), competitor = native.open(name, FUTURE_NATIVE_VERSION)
  competitor.addEventListener('blocked', () => blocked.resolve())
  competitor.addEventListener('upgradeneeded', () => competitor.transaction!.abort())
  const competitorDone = result(competitor).catch(error => error)
  await blocked.promise
  const observation = observeNativeOpen(), db = required(name), ready = vi.spyOn(db.on.ready, 'fire')
  const all = Promise.allSettled([db.open(), db.open(), db.meta.toArray(), db.transaction('r', db.meta, () => db.meta.toArray())])
  await observation.requested
  db.close(options)
  const outcomes = await all
  expect(outcomes.every(outcome => outcome.status === 'rejected' && outcome.reason instanceof Dexie.DatabaseClosedError)).toBe(true)
  holder.close(); await competitorDone
  observation.spy.mockRestore()
  const release = native.open(name, CURRENT_NATIVE_VERSION + 1), releaseBlocked: Event[] = []
  release.addEventListener('blocked', event => releaseBlocked.push(event))
  release.addEventListener('upgradeneeded', () => release.transaction!.abort())
  await rejected(result(release))
  expect(releaseBlocked).toEqual([])
  expect(db.isOpen()).toBe(false); expect(ready).not.toHaveBeenCalled()
  expect(await rejected(db.open())).toBeInstanceOf(Dexie.DatabaseClosedError)
  expect(await snapshot(name)).toEqual(before)
})

it.each(closeOptions)('refuses delete %j during blocked valid opening without cancellation', async options => {
  const name = freshName(); await seed(name)
  const holder = await result(native.open(name, CURRENT_NATIVE_VERSION)), blocked = deferred()
  const competitor = native.open(name, FUTURE_NATIVE_VERSION)
  competitor.addEventListener('blocked', () => blocked.resolve())
  competitor.addEventListener('upgradeneeded', () => competitor.transaction!.abort())
  const competitorDone = result(competitor).catch(error => error)
  await blocked.promise
  const observation = observeNativeOpen(), db = required(name), opening = db.open()
  await observation.requested
  const refusal = await rejected(db.delete(options))
  expect(refusal).toBeInstanceOf(TypeError)
  holder.close(); await competitorDone; await opening
  assertRequiredPlannerDatabaseOpen(db)
  expect(observation.calls).toEqual([[name, CURRENT_NATIVE_VERSION]])
})

it.each(['old', 'absent'] as const)('still aborts a queued %s upgrade after terminal cancellation', async kind => {
  const name = freshName()
  if (kind === 'old') await seed(name, 50)
  const before = await snapshot(name), observation = observeNativeOpen(), db = required(name)
  const opening = Promise.allSettled([db.open()])
  await observation.requested
  db.close()
  expect((await opening)[0]).toMatchObject({ status: 'rejected', reason: { name: 'DatabaseClosedError' } })
  observation.spy.mockRestore()
  // A native snapshot request queued behind the revoked request observes the eventual upgrade abort
  expect(await snapshot(name)).toEqual(before)
})

it('does not delete another actor\'s same-name creation after required absence denial', async () => {
  const name = freshName(), observation = observeNativeOpen(), db = required(name), normalize = captureRequiredPlannerOpeningError(db)
  const opening = rejected(db.open())
  await observation.requested
  observation.spy.mockRestore()
  const creation = seed(name)
  expect(normalize(await opening)?.code).toBe('schema-mismatch')
  await creation
  const before = await snapshot(name), fresh = required(name)
  await fresh.open(); assertRequiredPlannerDatabaseOpen(fresh); fresh.close()
  expect(await snapshot(name)).toEqual(before)
})

it('rejects a committed external upgrade queued ahead of required opening', async () => {
  const name = freshName(); await seed(name)
  const holder = await result(native.open(name, CURRENT_NATIVE_VERSION)), blocked = deferred(), upgrade = native.open(name, FUTURE_NATIVE_VERSION)
  upgrade.addEventListener('blocked', () => blocked.resolve())
  const upgraded = result(upgrade)
  await blocked.promise
  const observation = observeNativeOpen(), db = required(name), normalize = captureRequiredPlannerOpeningError(db), opening = rejected(db.open())
  await observation.requested; holder.close()
  const external = await upgraded; external.close()
  expect(normalize(await opening)?.code).toBe('schema-mismatch')
  expect(observation.calls).toEqual([[name, CURRENT_NATIVE_VERSION]])
  observation.spy.mockRestore()
  expect(await snapshot(name)).toMatchObject({ version: FUTURE_NATIVE_VERSION })
})

it('handles delete and recreate ahead of opening using native event barriers', async () => {
  const name = freshName(); await seed(name)
  const holder = await result(native.open(name, CURRENT_NATIVE_VERSION)), blocked = deferred(), deletion = native.deleteDatabase(name)
  deletion.addEventListener('blocked', () => blocked.resolve())
  const deleted = result(deletion)
  await blocked.promise
  const creation = seed(name, FUTURE_NATIVE_VERSION)
  const observation = observeNativeOpen(), db = required(name), normalize = captureRequiredPlannerOpeningError(db), opening = rejected(db.open())
  await observation.requested; holder.close(); await deleted; await creation
  expect(normalize(await opening)?.code).toBe('schema-mismatch')
  observation.spy.mockRestore()
  expect(await snapshot(name)).toMatchObject({ version: FUTURE_NATIVE_VERSION })
})

it('delivers versionchange to an old cooperating holder without migrating its data', async () => {
  const name = freshName(); await seed(name, 50)
  const before = await snapshot(name), holder = await result(native.open(name, 50)), changes: number[] = []
  holder.addEventListener('versionchange', event => { changes.push(event.newVersion!); holder.close() })
  await rejected(required(name).open())
  expect(changes).toEqual([CURRENT_NATIVE_VERSION]); expect(await snapshot(name)).toEqual(before)
})

it.each(['versionchange', 'forced native close'] as const)('retires after %s without allowing automatic reopen', async kind => {
  const name = freshName(); await seed(name)
  const db = required(name); await db.open()
  if (kind === 'versionchange') {
    const external = await result(native.open(name, FUTURE_NATIVE_VERSION)); external.close()
  } else {
    const closed = deferred(); db.on('close', () => closed.resolve())
    forceCloseDatabase(db.backendDB() as unknown as Parameters<typeof forceCloseDatabase>[0]); await closed.promise
  }
  const observation = observeNativeOpen()
  for (const path of entryPaths) expect(await rejected(enter(db, path))).toBeInstanceOf(Dexie.DatabaseClosedError)
  expect(() => assertRequiredPlannerDatabaseOpen(db)).toThrow(Dexie.DatabaseClosedError)
  expect(observation.calls).toEqual([])
})

it('captures the native factory receiver, methods and key range before dependency replacement', async () => {
  const name = freshName(); await seed(name)
  const saved = { ...Dexie.dependencies }, realOpen = native.open.bind(native), calls: [string, number | undefined][] = []
  const receiver = {
    open(this: unknown, name: string, version?: number) {
      expect(this).toBe(receiver); calls.push([name, version]); return realOpen(name, version)
    },
    cmp(this: unknown, a: IDBValidKey, b: IDBValidKey) { expect(this).toBe(receiver); return native.cmp(a, b) },
    databases(this: unknown) { expect(this).toBe(receiver); return native.databases() },
    deleteDatabase: native.deleteDatabase.bind(native),
  }
  try {
    Dexie.dependencies.indexedDB = receiver
    const db = required(name)
    receiver.open = () => { throw new Error('Replacement method must not run') }
    Dexie.dependencies.indexedDB = undefined as unknown as IDBFactory
    Dexie.dependencies.IDBKeyRange = undefined as unknown as typeof IDBKeyRange
    await db.open(); assertRequiredPlannerDatabaseOpen(db)
    expect(await db.meta.where('key').equals('sentinel').first()).toEqual({ key: 'sentinel', value: 'unrelated' })
    // Observe the injected boundary solely to test optional native capabilities without exporting a production hook
    const adapter = (db as unknown as { _deps: { indexedDB: IDBFactory } })._deps.indexedDB
    expect(adapter.cmp(1, 2)).toBe(-1)
    expect(await adapter.databases()).toEqual(await native.databases())
    expect(() => adapter.deleteDatabase(name)).toThrow('Required planner handles cannot delete databases')
    assertRequiredPlannerDatabaseOpen(db)
    expect(calls).toEqual([[name, CURRENT_NATIVE_VERSION]])
  } finally { Object.assign(Dexie.dependencies, saved) }
})

it.each([undefined, null, 42])('omits noncallable optional capabilities %s without inventing them', async capability => {
  const saved = Dexie.dependencies.indexedDB, name = freshName(); await seed(name)
  try {
    Dexie.dependencies.indexedDB = { open: native.open.bind(native), cmp: capability, databases: capability } as unknown as IDBFactory
    const db = required(name)
    const adapter = (db as unknown as { _deps: { indexedDB: IDBFactory } })._deps.indexedDB
    expect(Object.hasOwn(adapter, 'cmp')).toBe(false); expect(Object.hasOwn(adapter, 'databases')).toBe(false)
    await db.open(); assertRequiredPlannerDatabaseOpen(db)
  } finally { Dexie.dependencies.indexedDB = saved }
})
it('preserves errors thrown by captured optional capabilities and denies names and versions before native requests', async () => {
  const saved = Dexie.dependencies.indexedDB, name = freshName(); await seed(name)
  const error = new DOMException('Synthetic capability error', 'SecurityError'), observation = observeNativeOpen()
  try {
    Dexie.dependencies.indexedDB = { open: native.open.bind(native), cmp: () => { throw error }, databases: () => { throw error } } as unknown as IDBFactory
    const db = required(name), normalize = captureRequiredPlannerOpeningError(db), adapter = (db as unknown as { _deps: { indexedDB: IDBFactory } })._deps.indexedDB
    expect(() => adapter.cmp(1, 2)).toThrow(error); expect(() => adapter.databases()).toThrow(error)
    for (const [target, version] of [[name, undefined], [name, CURRENT_NATIVE_VERSION + 1], ['other', CURRENT_NATIVE_VERSION], [name, String(CURRENT_NATIVE_VERSION)]] as const) {
      let failure: unknown
      try { adapter.open(target, version as number) } catch (caught) { failure = caught }
      expect(normalize(failure)?.code).toBe('schema-mismatch')
    }
    expect(observation.calls).toEqual([])
  } finally { Dexie.dependencies.indexedDB = saved }
})

it.each(entryPaths)('missing IndexedDB allows construction and retires failed cold %s as storage failure', async path => {
  const saved = Dexie.dependencies.indexedDB, name = freshName(); await seed(name)
  const observation = observeNativeOpen()
  try {
    Dexie.dependencies.indexedDB = undefined as unknown as IDBFactory
    const db = required(name), normalize = captureRequiredPlannerOpeningError(db), error = await rejected(enter(db, path))
    expect(normalize(error)).toBeUndefined()
    expect(await rejected(db.open())).toBeInstanceOf(Dexie.DatabaseClosedError)
    const cold = required(name)
    expect(await rejected(loadLocalData(cold))).toMatchObject({ code: 'storage-failure' })
    expect(observation.calls).toEqual([])
    Dexie.dependencies.indexedDB = saved
    const fresh = required(name); await fresh.open(); assertRequiredPlannerDatabaseOpen(fresh)
  } finally { Dexie.dependencies.indexedDB = saved }
})

it('preserves native SecurityError and metadata access failures without schema normalization', async () => {
  const name = freshName(); await seed(name)
  const before = await snapshot(name), storageError = new DOMException('Synthetic storage denial', 'SecurityError')
  const opening = vi.spyOn(native, 'open').mockImplementation(() => { throw storageError })
  const db = required(name), normalize = captureRequiredPlannerOpeningError(db), error = await rejected(db.open())
  expect(normalize(error)).toBeUndefined()
  expect(await rejected(loadLocalData(required(name)))).toMatchObject({ code: 'storage-failure' })
  opening.mockRestore()
  const handle = await result(native.open(name)); const prototype = Object.getPrototypeOf(handle) as IDBDatabase; handle.close()
  const transaction = vi.spyOn(prototype, 'transaction').mockImplementation(() => { throw storageError })
  const metadata = required(name), normalizeMetadata = captureRequiredPlannerOpeningError(metadata), failure = await rejected(metadata.open())
  expect(normalizeMetadata(failure)).toBeUndefined()
  expect(await rejected(loadLocalData(required(name)))).toMatchObject({ code: 'storage-failure' })
  transaction.mockRestore()
  expect(await snapshot(name)).toEqual(before)
})

it.each(['abort', 'structural'] as const)('recognizes only actual same-handle %s denials through installed wrappers', async kind => {
  const name = freshName()
  if (kind === 'structural') await seed(name, CURRENT_NATIVE_VERSION, (_db, tx) => tx.objectStore('meta').createIndex('extra', 'extra'))
  const db = required(name), normalize = captureRequiredPlannerOpeningError(db), normalizeVip = captureRequiredPlannerOpeningError(db.vip as CryKitDatabase), error = await rejected(db.open()), other = required(name)
  expect(normalize(error)).toMatchObject({ code: 'schema-mismatch', cause: error })
  expect(captureRequiredPlannerOpeningError(other)(error)).toBeUndefined()
  expect(normalizeVip(error)?.code).toBe('schema-mismatch')
  for (const Constructor of [Dexie.AbortError, Dexie.OpenFailedError, Dexie.DatabaseClosedError]) {
    const wrapper = new Constructor('Owned wrapper', error as Error)
    expect(normalize(wrapper)).toMatchObject({ code: 'schema-mismatch', cause: wrapper })
  }
  const app = new AppDataError('schema-mismatch', 'Unrelated application error')
  const cycle = new Dexie.DatabaseClosedError('Cyclic wrapper')
  Object.assign(cycle, { inner: cycle })
  for (const unowned of [
    new Dexie.AbortError('Unrelated'), new Dexie.DatabaseClosedError('Unrelated', app), cycle,
    { name: 'AbortError', inner: error }, { inner: error }, { cause: error }, new Error('Unknown wrapper', { cause: error }),
  ]) expect(normalize(unowned)).toBeUndefined()
  const later = await rejected(db.open())
  expect(normalize(later)).toBeUndefined()
})

it('excludes global addons from required readiness while retaining legacy addons and auto-reopen', async () => {
  const name = freshName(); await seed(name)
  const entered = deferred(), release = deferred(), calls: Dexie[] = []
  const addon = (db: Dexie) => { calls.push(db); db.on('ready', () => { entered.resolve(); return release.promise }) }
  Dexie.addons.push(addon)
  try {
    const db = required(name); await db.open(); assertRequiredPlannerDatabaseOpen(db)
    expect(calls).toEqual([])
    const legacy = new CryKitDatabase(name, { plannerFormatRequirement: 'legacy-or-journaled' }); handles.push(legacy)
    let exposed = false
    const opening = legacy.open().then(() => { exposed = true })
    await entered.promise; expect(exposed).toBe(false); expect(calls).toEqual([legacy])
    release.resolve(); await opening
    legacy.close({ disableAutoOpen: false })
    expect(await legacy.meta.get('sentinel')).toBeDefined()
  } finally { release.resolve(); Dexie.addons.splice(Dexie.addons.indexOf(addon), 1) }
})

it('characterizes unsupported held asynchronous ready without promising immediate cancellation', async () => {
  const name = freshName(); await seed(name)
  const db = required(name), entered = deferred(), release = deferred()
  db.on('ready', () => { entered.resolve(); return release.promise })
  const opening = db.open()
  await entered.promise; db.close(); release.resolve()
  await opening
  expect(() => assertRequiredPlannerDatabaseOpen(db)).toThrow(Dexie.DatabaseClosedError)
})

it('a private test owner checks admission after await before exposing the component', async () => {
  const name = freshName(); await seed(name)
  const db = required(name), validated = deferred(), release = deferred()
  let exposed = false
  const owner = (async () => {
    try {
      await db.open(); validated.resolve(); await release.promise
      assertRequiredPlannerDatabaseOpen(db)
      exposed = true; return db
    } catch (error) { db.close(); throw error }
  })()
  const outcome = rejected(owner)
  await validated.promise; expect(exposed).toBe(false); db.close(); release.resolve()
  expect(await outcome).toBeInstanceOf(Dexie.DatabaseClosedError)
  expect(exposed).toBe(false)
})


it.each(['omitted', 'undefined', 'true', 'false', 'empty'] as const)('preserves legacy delete argument arity and %s options', async option => {
  const name = freshName(); await seed(name)
  const db = new CryKitDatabase(name); handles.push(db)
  await db.open()
  const deletion = option === 'omitted' ? db.delete() : db.delete(option === 'undefined' ? undefined : option === 'empty' ? {} as { disableAutoOpen: boolean } : { disableAutoOpen: option === 'true' })
  if (option === 'undefined') {
    expect(await rejected(deletion)).toBeInstanceOf(Dexie.InvalidArgumentError)
    expect(db.isOpen()).toBe(true)
  } else {
    await deletion
    expect(await snapshot(name)).toEqual({ exists: false })
    if (option === 'false' || option === 'empty') {
      expect(await db.meta.toArray()).toEqual([])
      expect(db.isOpen()).toBe(true)
    } else expect(await rejected(db.meta.toArray())).toBeInstanceOf(Dexie.DatabaseClosedError)
  }
})


it.each([10, 30])('preserves valid historical root and undo bytes at native %s without invoking migration', async version => {
  const name = freshName(), current = createTestLocalData()
  const { teams: _teams, ...legacy } = current
  const before = version === 10 ? { ...legacy, schemaVersion: '2.0.0' } : { ...current, schemaVersion: '2.2.0' }
  const after = { ...before, revision: before.revision + 1 }
  await seed(name, version, (_db, tx) => {
    tx.objectStore('localDatas').put({ id: 'local-data-record', revision: after.revision, updatedAt: after.updatedAt, localData: after, lineage: { rootLocalDataId: before.id } })
    tx.objectStore('history').put({ id: 'historical-checkpoint', localDataId: before.id, command: 'save', previousRevision: before.revision, nextRevision: after.revision, before, after, recordedAt: after.updatedAt })
  })
  const original = await snapshot(name), db = required(name), normalize = captureRequiredPlannerOpeningError(db)
  const populate = vi.fn(); db.on('populate', populate)
  const error = await rejected(db.open())
  expect(normalize(error)?.code).toBe('schema-mismatch')
  expect(populate).not.toHaveBeenCalled()
  expect(await snapshot(name)).toEqual(original)
})

it('rejects a malformed future database without versionless inspection or repair', async () => {
  const name = freshName(); await seed(name, FUTURE_NATIVE_VERSION, db => db.deleteObjectStore('history'))
  const before = await snapshot(name), observation = observeNativeOpen(), db = required(name), normalize = captureRequiredPlannerOpeningError(db)
  expect(normalize(await rejected(db.open()))?.code).toBe('schema-mismatch')
  expect(observation.calls).toEqual([[name, CURRENT_NATIVE_VERSION]])
  observation.spy.mockRestore()
  expect(await snapshot(name)).toEqual(before)
})

it('cancels a blocked old-version request before its noncooperating holder releases', async () => {
  const name = freshName(); await seed(name, 50)
  const before = await snapshot(name), holder = await result(native.open(name, 50))
  const observation = observeNativeOpen(), db = required(name), opening = Promise.allSettled([db.open()])
  const request = await observation.requested, blocked = deferred()
  request.addEventListener('blocked', () => blocked.resolve())
  await blocked.promise; db.close()
  expect((await opening)[0]).toMatchObject({ status: 'rejected', reason: { name: 'DatabaseClosedError' } })
  holder.close(); observation.spy.mockRestore()
  expect(await snapshot(name)).toEqual(before)
})

it.each(['abort', 'structural'] as const)('keeps original pending %s diagnoses but excludes later cold table and transaction calls', async kind => {
  const name = freshName()
  if (kind === 'structural') await seed(name, CURRENT_NATIVE_VERSION, (_db, tx) => tx.objectStore('meta').createIndex('extra', 'value'))
  const before = await snapshot(name)
  for (const path of ['table', 'transaction'] as const) {
    const observation = observeNativeOpen(), db = required(name), normalize = captureRequiredPlannerOpeningError(db)
    const original = await rejected(enter(db, path))
    expect(normalize(original)).toMatchObject({ code: 'schema-mismatch', recoverable: true, cause: original })
    const normalizeLater = captureRequiredPlannerOpeningError(db)
    const later = await rejected(enter(db, path))
    expect(later).toBeInstanceOf(Dexie.DatabaseClosedError)
    expect(later).not.toBe(original)
    expect((later as { inner: unknown }).inner).toBe((original as { inner: unknown }).inner)
    expect.soft(normalizeLater(later), path).toBeUndefined()
    db.close()
    expect(normalize(original)?.code).toBe('schema-mismatch')
    const normalizeClosed = captureRequiredPlannerOpeningError(db)
    const closed = await rejected(enter(db, path))
    expect(normalizeClosed(closed)).toBeUndefined()
    expect(normalizeClosed(original)).toBeUndefined()
    const raw = await rejected(db.open())
    expect(raw).toBeInstanceOf(Dexie.DatabaseClosedError)
    expect(normalize(raw)).toBeUndefined()
    expect(observation.calls).toEqual([[name, CURRENT_NATIVE_VERSION]])
    observation.spy.mockRestore()
    expect(await snapshot(name)).toEqual(before)
  }
})

it('captures denial history before retirement without reading Dexie failure state', async () => {
  const name = freshName(); await seed(name)
  const before = await snapshot(name), observation = observeNativeOpen(), db = required(name)
  const eligible = captureRequiredPlannerOpeningError(db)
  const adapter = (db as unknown as { _deps: { indexedDB: IDBFactory } })._deps.indexedDB
  let denial: unknown
  try { adapter.open(name, CURRENT_NATIVE_VERSION + 1) } catch (error) { denial = error }
  const later = captureRequiredPlannerOpeningError(db)
  expect(eligible(denial)).toMatchObject({ code: 'schema-mismatch', cause: denial })
  expect(later(denial)).toBeUndefined()
  expect(observation.calls).toEqual([])
  // This direct adapter probe has not invoked Dexie's failure cleanup, so denial history must exclude the later capture
  await db.open(); assertRequiredPlannerDatabaseOpen(db)
  expect(later(denial)).toBeUndefined()
  observation.spy.mockRestore(); db.close()
  expect(await snapshot(name)).toEqual(before)
})
