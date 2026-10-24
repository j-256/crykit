import { migrateLocalData250 } from '../domain/team-checkpoints'
import Dexie, { type EntityTable, type PromiseExtended } from 'dexie'
import { AppDataError } from '../interchange/errors'
import type { OperativePlannerDescriptorV1 } from './guest-planner-record'
import { installGuestWriteBarrier } from '../workspace/guest-barrier'
import { prepareFreshGuestTargetOpening } from '../workspace/fresh-guest-target'
import { NativeHistorySchema, StoredNativeLocalDataSchema } from '../interchange/native-schema'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { BUNDLED_CATALOGS, BUNDLED_SOURCE_ENTITY_IDS } from '../catalog/bundled'
import { HISTORICAL_BUNDLED_CATALOG } from '../domain/withdrawn-catalogs'
import { upgradeBundledReferences } from '../domain/bundled-reference-upgrade'
import type { CatalogSnapshot, LocalData, LocalDataId, Timestamp } from '../domain/types'
import type {
  EvidenceRecord,
  PersistedHistoryEntry,
  LocalDataLineage,
  SourceArchiveRecord,
} from '../interchange/types'

export interface LocalDataRecord {
  readonly id: string
  readonly revision: number
  readonly updatedAt: Timestamp
  readonly localData: LocalData
  readonly lineage: LocalDataLineage
  readonly operativePlanner?: OperativePlannerDescriptorV1
}

export interface CatalogRecord {
  readonly key: string
  readonly id: string
  readonly revisionId: string
  readonly checksum: string
  readonly snapshot: CatalogSnapshot
}

export interface ImportRecord {
  readonly id: string
  readonly sourceDigest: string
  readonly localDataId: LocalDataId
  readonly importedAt: Timestamp
}

export interface MetaRecord {
  readonly key: string
  readonly value: string
}

export type PlannerFormatRequirement = 'legacy-or-journaled' | 'journaled'
export interface CryKitDatabaseOptions {
  readonly plannerFormatRequirement?: PlannerFormatRequirement
  readonly freshGuestTarget?: true
  readonly frozenSource240?: true
}

const REQUIRED_NATIVE_VERSION = 70
const FROZEN_NATIVE_VERSION = 60
const REQUIRED_DELETE_MESSAGE = 'Required planner handles cannot delete databases'
const REQUIRED_OPEN_MESSAGE = 'The journaled planner database cannot be opened safely. Keep your draft and reopen the workspace'

interface RequiredPlannerOpeningState {
  terminal: boolean
  denialIssued: boolean
  admittedConnection: IDBDatabase | undefined
  readonly denials: WeakSet<object>
  readonly abortedRequests: WeakMap<object, Error>
  readonly nativeVersion: number
  readonly nativeVersionErrors: WeakSet<object>
  nativeVersionFailure?: DOMException
}
interface RequiredOpeningAdapter {
  open(name: string, version?: number): IDBOpenDBRequest
  deleteDatabase(name: string): IDBOpenDBRequest
  cmp?: IDBFactory['cmp']
  databases?: IDBFactory['databases']
}
const requiredOpenings = new WeakMap<object, RequiredPlannerOpeningState>()

// Dexie adjusts its own index names before ready; admission must compare an independent immutable layout
const REQUIRED_SCHEMA = Object.freeze(Object.entries({
  localDatas: { keyPath: 'id', indexes: { revision: 'revision', updatedAt: 'updatedAt' } },
  catalogs: { keyPath: 'key', indexes: { id: 'id', revisionId: 'revisionId', checksum: 'checksum' } },
  evidence: { keyPath: 'id', indexes: { sourceDigest: 'sourceDigest', group: 'group' } },
  sources: { keyPath: 'id', indexes: { digest: 'digest', format: 'format' } },
  history: { keyPath: 'id', indexes: { localDataId: 'localDataId', '[localDataId+nextRevision]': Object.freeze(['localDataId', 'nextRevision']) } },
  imports: { keyPath: 'id', indexes: { sourceDigest: 'sourceDigest', localDataId: 'localDataId' } },
  meta: { keyPath: 'key', indexes: {} },
}).map(([name, schema]) => Object.freeze({ name, keyPath: schema.keyPath, indexes: Object.freeze(Object.entries(schema.indexes).map(([name, keyPath]) => Object.freeze({ name, keyPath }))) })))

function createRequiredOpeningState(nativeVersion: number): RequiredPlannerOpeningState {
  return { nativeVersion, nativeVersionErrors: new WeakSet(), terminal: false, denialIssued: false, admittedConnection: undefined, denials: new WeakSet(), abortedRequests: new WeakMap() }
}
function revokeRequiredPlannerOpening(state: RequiredPlannerOpeningState): void {
  state.terminal = true
  state.admittedConnection = undefined
}
function openingDenial(state: RequiredPlannerOpeningState): Error {
  state.denialIssued = true
  const error = new Error(REQUIRED_OPEN_MESSAGE)
  state.denials.add(error)
  return error
}
function createRequiredOpeningAdapter(name: string, nativeFactory: IDBFactory | undefined, state: RequiredPlannerOpeningState): RequiredOpeningAdapter {
  const nativeOpen = nativeFactory?.open.bind(nativeFactory)
  const adapter: RequiredOpeningAdapter = {
    open(requestedName, version) {
      if (state.terminal) throw new Dexie.DatabaseClosedError()
      // Dexie retries VersionError without a version; preserve native provenance without issuing that broader request
      if (state.nativeVersion === FROZEN_NATIVE_VERSION && requestedName === name && version === undefined && state.nativeVersionFailure) throw state.nativeVersionFailure
      if (requestedName !== name || version !== state.nativeVersion) throw openingDenial(state)
      if (!nativeOpen) throw new Dexie.MissingAPIError()
      const request = nativeOpen(name, state.nativeVersion)
      let upgradeDenial: Error | undefined
      // These listeners precede Dexie's assigned handlers and retain the real native request/error identities
      request.addEventListener('success', event => {
        if (state.terminal) {
          request.result.close()
          event.stopImmediatePropagation()
        }
      })
      request.addEventListener('upgradeneeded', event => {
        event.stopImmediatePropagation()
        upgradeDenial = openingDenial(state)
        // A queued request can outlive close; even then an upgrade must abort before any Dexie migration runs
        request.transaction!.abort()
      })
      request.addEventListener('error', () => {
        if (request.error?.name === 'VersionError') {
          state.nativeVersionErrors.add(request.error)
          state.nativeVersionFailure = request.error
        }
        if (upgradeDenial && request.error) state.abortedRequests.set(request.error, upgradeDenial)
      })
      return request
    },
    deleteDatabase() { throw new TypeError(REQUIRED_DELETE_MESSAGE) },
  }
  if (typeof nativeFactory?.cmp === 'function') adapter.cmp = nativeFactory.cmp.bind(nativeFactory)
  if (typeof nativeFactory?.databases === 'function') adapter.databases = nativeFactory.databases.bind(nativeFactory)
  return adapter
}
function sameNames(actual: DOMStringList, expected: readonly string[]): boolean {
  const names = Array.from(actual).sort(), wanted = [...expected].sort()
  return names.length === wanted.length && names.every((name, index) => name === wanted[index])
}
function sameKeyPath(actual: string | string[] | null, expected: string | readonly string[]): boolean {
  return typeof expected === 'string' ? actual === expected : Array.isArray(actual) && actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
function admitRequiredPlannerSchema(connection: IDBDatabase, state: RequiredPlannerOpeningState): void {
  if (state.terminal) throw new Dexie.DatabaseClosedError()
  if (connection.version !== state.nativeVersion || !sameNames(connection.objectStoreNames, REQUIRED_SCHEMA.map(store => store.name))) throw openingDenial(state)
  // Metadata comparison is synchronous; ready owns no row requests, thenables or external initialization
  // Storage exceptions propagate unbranded, since inability to inspect metadata is not proof of schema mismatch
  const transaction = connection.transaction(REQUIRED_SCHEMA.map(store => store.name), 'readonly')
  for (const expected of REQUIRED_SCHEMA) {
    const store = transaction.objectStore(expected.name)
    if (!sameKeyPath(store.keyPath, expected.keyPath) || store.autoIncrement || !sameNames(store.indexNames, expected.indexes.map(index => index.name))) throw openingDenial(state)
    for (const descriptor of expected.indexes) {
      const index = store.index(descriptor.name)
      if (!sameKeyPath(index.keyPath, descriptor.keyPath) || index.unique || index.multiEntry) throw openingDenial(state)
    }
  }
  state.admittedConnection = connection
}

// Dexie can wrap the same denial for both pending and later cold calls after failed opening
// Capture before the first database access: pending work keeps its diagnosis after retirement, later work does not
export function captureRequiredPlannerOpeningError(database: CryKitDatabase): (error: unknown) => AppDataError | undefined {
  const state = requiredOpenings.get(database)
  const eligible = !!state && !state.terminal && !state.denialIssued
  return error => {
    if (!eligible || !state) return undefined
    const visited = new Set<object>()
    let current = error
    while (current !== null && typeof current === 'object' && !visited.has(current)) {
      visited.add(current)
      if (state.denials.has(current) || state.abortedRequests.has(current)) return new AppDataError('schema-mismatch', REQUIRED_OPEN_MESSAGE, { cause: error })
      if (!(current instanceof Dexie.AbortError || current instanceof Dexie.OpenFailedError || current instanceof Dexie.DatabaseClosedError)) return undefined
      current = current.inner
    }
    return undefined
  }
}

export function isRequiredPlannerNativeVersionError(database: CryKitDatabase, error: unknown): boolean {
  const state = requiredOpenings.get(database)
  const seen = new Set<object>()
  while (state && error !== null && typeof error === 'object' && !seen.has(error)) {
    seen.add(error)
    if (state.nativeVersionErrors.has(error)) return true
    if (!(error instanceof Dexie.VersionError || error instanceof Dexie.OpenFailedError)) return false
    error = error.inner
  }
  return false
}

// This is a final synchronous exposure check for a separately owned opener, not a factory or tuple admission
export function assertRequiredPlannerDatabaseOpen(database: CryKitDatabase): void {
  const state = requiredOpenings.get(database)
  if (!state) throw new TypeError('A required planner handle is needed')
  if (state.terminal || !state.admittedConnection || !database.isOpen() || database.backendDB() !== state.admittedConnection) throw new Dexie.DatabaseClosedError()
}

export class CryKitDatabase extends Dexie {
  readonly plannerFormatRequirement!: PlannerFormatRequirement
  readonly frozenSource240!: boolean
  localDatas!: EntityTable<LocalDataRecord, 'id'>
  catalogs!: EntityTable<CatalogRecord, 'key'>
  evidence!: EntityTable<EvidenceRecord, 'id'>
  sources!: EntityTable<SourceArchiveRecord, 'id'>
  history!: EntityTable<PersistedHistoryEntry, 'id'>
  imports!: EntityTable<ImportRecord, 'id'>
  meta!: EntityTable<MetaRecord, 'key'>

  constructor(name = 'crykit', options: CryKitDatabaseOptions = {}) {
    const suppliedRequirement = options.plannerFormatRequirement
    const requirement = suppliedRequirement === undefined ? 'legacy-or-journaled' : suppliedRequirement
    if (requirement !== 'legacy-or-journaled' && requirement !== 'journaled') throw new TypeError('Invalid planner format requirement')
    if (options.freshGuestTarget && requirement !== 'journaled') throw new TypeError('Fresh restore planners require the journaled format')
    if (options.frozenSource240 && (requirement !== 'journaled' || options.freshGuestTarget)) throw new TypeError('A frozen source requires a noncreating journaled handle')
    const nativeVersion = options.frozenSource240 ? FROZEN_NATIVE_VERSION : REQUIRED_NATIVE_VERSION
    const fresh = options.freshGuestTarget ? prepareFreshGuestTargetOpening(name, REQUIRED_NATIVE_VERSION) : undefined
    const state = requirement === 'journaled' && !fresh ? createRequiredOpeningState(nativeVersion) : undefined
    super(name, fresh?.dependencies ?? (state ? { indexedDB: createRequiredOpeningAdapter(name, Dexie.dependencies.indexedDB, state), IDBKeyRange: Dexie.dependencies.IDBKeyRange, addons: [] } : undefined))
    fresh?.attach(this)
    if (state) {
      // VIP methods receive a public proxy, so both identities share one terminal lifetime without private Dexie fields
      requiredOpenings.set(this, state)
      requiredOpenings.set(this.vip, state)
      this.on('close', () => revokeRequiredPlannerOpening(state))
      // Required construction owns exactly this synchronous ready callback; async subscribers need a new lifecycle design
      this.on('ready', () => admitRequiredPlannerSchema(this.backendDB(), state), true)
    }
    // The immutable requirement also governs transaction admission; opening alone grants no row or workspace authority
    Object.defineProperty(this, 'frozenSource240', { value: options.frozenSource240 === true, enumerable: true, writable: false, configurable: false })
    if (options.frozenSource240) this.use({ stack: 'dbcore', name: 'frozen-domain-source', level: 1, create: core => ({ ...core, transaction: (stores, mode, options) => { if (mode !== 'readonly') throw new TypeError('Frozen planner sources are read-only'); return core.transaction(stores, mode, options) } }) })
    Object.defineProperty(this, 'plannerFormatRequirement', { value: requirement, enumerable: true, writable: false, configurable: false })
    this.version(1).stores({
      localDatas: 'id, revision, updatedAt',
      catalogs: 'key, id, revisionId, checksum',
      evidence: 'id, sourceDigest, group',
      sources: 'id, digest, format',
      history: 'id, localDataId, [localDataId+nextRevision]',
      imports: 'id, sourceDigest, localDataId',
      meta: 'key',
    })
    // Roots and undo snapshots must migrate in the same upgrade transaction
    // A bad history entry must roll back roots and the database version rather than leave undo incompatible
    const migrate = async (transaction: import('dexie').Transaction) => {
      const storedCatalogs = (await transaction.table<CatalogRecord>('catalogs').toArray()).map(record => record.snapshot)
      const catalogs = [...new Map([...storedCatalogs, ...BUNDLED_CATALOGS].map(catalog => [JSON.stringify([catalog.id, catalog.revisionId]), catalog])).values()]
      const localDatas = transaction.table<LocalDataRecord>('localDatas')
      for (const record of await localDatas.toArray()) {
        const localData = upgradeBundledReferences(StoredNativeLocalDataSchema.parse(record.localData) as unknown as LocalData, HISTORICAL_BUNDLED_CATALOG, BUNDLED_SOURCE_ENTITY_IDS)
        validateNativeLocalDataGraph(localData, catalogs)
        await localDatas.put({ ...record, localData })
      }
      const history = transaction.table<PersistedHistoryEntry>('history')
      for (const entry of await history.toArray()) {
        const parsed = NativeHistorySchema.parse(entry) as unknown as PersistedHistoryEntry
        const migrated = { ...parsed, before: upgradeBundledReferences(parsed.before, HISTORICAL_BUNDLED_CATALOG, BUNDLED_SOURCE_ENTITY_IDS), after: upgradeBundledReferences(parsed.after, HISTORICAL_BUNDLED_CATALOG, BUNDLED_SOURCE_ENTITY_IDS) }
        validateNativeLocalDataGraph(migrated.before, catalogs)
        validateNativeLocalDataGraph(migrated.after, catalogs)
        await history.put(migrated)
      }
    }
    this.version(2).stores({}).upgrade(migrate)
    this.version(3).stores({}).upgrade(migrate)
    this.version(4).stores({}).upgrade(migrate)
    this.version(5).stores({}).upgrade(migrate)
    this.version(6).stores({}).upgrade(migrate)
    if (!options.frozenSource240) this.version(7).stores({}).upgrade(async transaction => {
      const catalogs = [...new Map([...BUNDLED_CATALOGS, ...(await transaction.table<CatalogRecord>('catalogs').toArray()).map(row => row.snapshot)].map(catalog => [JSON.stringify([catalog.id, catalog.revisionId]), catalog])).values()]
      const roots = await transaction.table<LocalDataRecord>('localDatas').toArray()
      const history = await transaction.table<PersistedHistoryEntry>('history').toArray()
      const operative = new Set(roots.flatMap(root => root.operativePlanner ? root.operativePlanner.checkpointIds : history.filter(entry => entry.localDataId === root.localData.id).map(entry => entry.id)))
      const meta = transaction.table<MetaRecord>('meta')
      // The recovery copy and every operative endpoint share the versionchange rollback boundary
      if (await meta.get('domain-2.5.0-rollback')) throw new Error('The domain migration recovery key is already occupied')
      await meta.add({ key: 'domain-2.5.0-rollback', value: JSON.stringify({ version: 1, roots, history }) })
      for (const root of roots) await transaction.table('localDatas').put({ ...root, localData: migrateLocalData250(root.localData, catalogs) })
      for (const entry of history) {
        NativeHistorySchema.parse(entry)
        if (!operative.has(entry.id)) continue
        await transaction.table('history').put({ ...entry, before: migrateLocalData250(entry.before, catalogs), after: migrateLocalData250(entry.after, catalogs) })
      }
    })
    // Selected frozen sources never run versionchange; successors stage current endpoints in a fresh target
    installGuestWriteBarrier(this)
  }

  override open(): PromiseExtended<Dexie> {
    if (requiredOpenings.get(this)?.terminal) return Dexie.Promise.reject(new Dexie.DatabaseClosedError())
    return super.open()
  }

  override close(options?: Parameters<Dexie['close']>[0]): void {
    const state = requiredOpenings.get(this)
    if (state) {
      revokeRequiredPlannerOpening(state)
      super.close({ disableAutoOpen: true })
    } else super.close(options)
  }

  override delete(options?: Parameters<Dexie['delete']>[0]): PromiseExtended<void> {
    // Selected cleanup has separate authority; refusing deletion must not cancel an otherwise usable opening
    if (requiredOpenings.has(this)) return Dexie.Promise.reject(new TypeError(REQUIRED_DELETE_MESSAGE))
    // Dexie rejects an explicitly supplied undefined argument while accepting omitted options
    return arguments.length === 0 ? super.delete() : super.delete(options)
  }
}

let defaultDatabase: CryKitDatabase | undefined

export function getDatabase(): CryKitDatabase {
  defaultDatabase ??= new CryKitDatabase()
  return defaultDatabase
}

export function setDatabaseForTests(database: CryKitDatabase | undefined): void {
  defaultDatabase = database
}
