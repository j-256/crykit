import type { WorkspacePlannerState } from '../workspace/documents'
import { publicContextContainers, publicUnavailableCatalogKeys } from '../domain/public-source-context'
import { GUEST_PLANNER_LAYOUT_KEY, guestPlannerValuesEqual, validateGuestPlannerRecord, type ValidatedGuestPlanner } from './guest-planner-record'
import { CRYSTAL_EDIT_CATALOG_SCHEMA } from '../domain/mod-layers'
import { referenceLibraryWithMod } from '../domain/reference-library'
import { WITHDRAWN_CATALOGS, withdrawnCatalogKey } from '../domain/withdrawn-catalogs'
import { BUNDLED_CATALOGS, CURRENT_CATALOG } from '../catalog/bundled'
import { NATIVE_BACKUP_FORMAT_VERSION } from '../interchange/native-schema'
import { decodeSharePayload, saveSharedCopy } from '../interchange/share'
import { createSampleLocalData } from '../domain/sample-data'
import { SWITCH_MOD_PACKS } from '../catalog/mods'
import { normalizeModName } from '../domain/mods'
import { BUNDLED_MOD_LIBRARY } from '../catalog/mod-library-metadata'
import { configureModSetup } from '../domain/mod-setup'
import { zipSync, type Zippable } from 'fflate'
import type {
  CatalogSnapshot,
  ChangeEntry,
  LocalData,
  LocalDataId,
  Timestamp,
} from '../domain/types'
import { AppDataError, asAppDataError } from '../interchange/errors'
import { previewImport as buildImportPreview } from '../interchange/import'
import { unavailableModCatalogKeys, validateNativeLocalDataGraph, immutableCatalogSnapshot, isImmutableCatalogSnapshot, immutableExpandedModCatalogs } from '../interchange/native'
import { composeModCatalog, compactModCatalog, expandModCatalogs, hasWithdrawnModDependencies, modCatalogForPin, modCatalogRevision } from '../domain/mod-layers'
import { NATIVE_BACKUP_JSON_LIMITS, parseBoundedJson } from '../interchange/json'
import { catalogSnapshotKey } from '../interchange/identity'
import type {
  CommitImportOptions,
  ImportCandidate,
  ImportPreview,
  NativeBackupManifest,
  PersistedHistoryEntry,
  LoadedLocalData,
  LocalDataNotification,
  LocalDataLineage,
  EvidenceRecord,
  SourceArchiveRecord,
} from '../interchange/types'
import {
  asChangeId,
  cloneJson,
  nowTimestamp,
  randomId,
  sha256,
} from '../interchange/util'
import {
  type CatalogRecord,
  CryKitDatabase,
  getDatabase,
  captureRequiredPlannerOpeningError,
  type LocalDataRecord,
  type MetaRecord,
} from './database'
import { NATIVE_BACKUP_ARCHIVE_LIMITS, inspectZip } from '../interchange/zip'
import starterBuildShares from './starter-build-shares.json' with { type: 'json' }
import starterBuildReferenceNames from './starter-build-reference-names.json' with { type: 'json' }
import type { BuildReferenceName, ModSourceReceipt } from '../domain/types'

const LOCAL_DATA_RECORD_KEY = 'local-data-record'
const STARTER_BUILD_TITLE_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({ 'Brawler build': 'Prudence' })
const CHANNEL_NAME = 'crykit-local-data'
const MAX_LOCAL_DATA_CHANGES = 500
const MAX_HISTORY_ENTRIES = 500
const MAX_HISTORY_BYTES = 8 * 1024 * 1024
const BACKUP_PAYLOAD_HEADROOM_BYTES = 1024 * 1024
const MAX_BACKUP_PAYLOAD_BYTES = NATIVE_BACKUP_ARCHIVE_LIMITS.maxEntryUncompressedBytes - BACKUP_PAYLOAD_HEADROOM_BYTES

let channel: BroadcastChannel | undefined
const localListeners = new Set<(notification: LocalDataNotification) => void>()

function broadcastChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined
  channel ??= new BroadcastChannel(CHANNEL_NAME)
  return channel
}

function notify(notification: LocalDataNotification): void {
  for (const listener of localListeners) listener(notification)
  broadcastChannel()?.postMessage(notification)
}

export function subscribeLocalData(listener: (notification: LocalDataNotification) => void): () => void {
  localListeners.add(listener)
  const remote = (event: MessageEvent<LocalDataNotification>): void => listener(event.data)
  broadcastChannel()?.addEventListener('message', remote)
  return () => {
    localListeners.delete(listener)
    broadcastChannel()?.removeEventListener('message', remote)
  }
}

export interface LocalDataWriteResult {
  readonly localData: LocalData
  readonly canUndo: boolean
}

export function validateLocalDataForStorage(
  localData: LocalData,
  catalogs: readonly CatalogSnapshot[],
): void {
  validateNativeLocalDataGraph(localData, catalogs)
}

function catalogKey(snapshot: Pick<CatalogSnapshot, 'id' | 'revisionId'>): string {
  return catalogSnapshotKey(snapshot.id, snapshot.revisionId)
}

const BUNDLED_CATALOG_KEYS = new Set(BUNDLED_CATALOGS.map(catalogKey))

function isBundledCatalog(snapshot: CatalogSnapshot): boolean {
  return BUNDLED_CATALOG_KEYS.has(catalogKey(snapshot))
}

function toCatalogRecord(snapshot: CatalogSnapshot): CatalogRecord {
  return {
    key: catalogKey(snapshot),
    id: snapshot.id,
    revisionId: snapshot.revisionId,
    checksum: snapshot.checksum,
    snapshot,
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
}

async function assertCatalogsImmutable(
  database: CryKitDatabase,
  catalogs: readonly CatalogSnapshot[],
): Promise<void> {
  for (const catalog of catalogs) {
    const existing = await database.catalogs.get(catalogKey(catalog))
    if (existing && !jsonEqual(existing.snapshot, catalog)) {
      throw new AppDataError('import-conflict', 'A catalog revision conflicts with immutable local data', {
        recoverable: true,
        details: { catalogId: catalog.id, revisionId: catalog.revisionId },
      })
    }
  }
}

function assertStarterCatalogIdentity(catalogs: readonly CatalogSnapshot[]): void {
  for (const catalog of catalogs) {
    const bundled = BUNDLED_CATALOGS.find(entry => catalogKey(entry) === catalogKey(catalog))
    if (!bundled) continue
    if (jsonEqual(catalog, bundled)) continue
    throw new AppDataError('import-conflict', 'A catalog revision conflicts with the built-in starter catalog', {
      recoverable: true,
      details: { catalogId: catalog.id, revisionId: catalog.revisionId },
    })
  }
}

const INVALID_JOURNALED_PLANNER = 'The journaled planner data is missing or invalid. Keep your draft and reopen the workspace'
const DIRECT_JOURNALED_IMPORT = 'Direct imports are not supported for this journaled planner'
const DIRECT_JOURNALED_MOD_SETUP = 'Direct mod setup is not supported for this journaled planner'

type PlannerAdmission =
  | { readonly format: 'legacy'; readonly record: LocalDataRecord | undefined }
  | { readonly format: 'journaled'; readonly record: LocalDataRecord; readonly declaration: MetaRecord; readonly history: readonly PersistedHistoryEntry[]; readonly catalogs: readonly CatalogRecord[]; readonly validated: Extract<ValidatedGuestPlanner, { format: 'journaled' }> }

function journaledPlannerError(message = INVALID_JOURNALED_PLANNER, cause?: unknown): AppDataError {
  return new AppDataError('schema-mismatch', message, { recoverable: true, cause })
}

// Every caller holds localDatas/meta/history/catalogs in its own transaction on this handle
// Admission covers an already-open native layout-6 database; Dexie initial opening can still migrate or patch stores
async function readPlannerAdmissionInTransaction(database: CryKitDatabase): Promise<PlannerAdmission> {
  const roots = await database.localDatas.toArray()
  const record = roots.find(row => row.id === LOCAL_DATA_RECORD_KEY)
  const declaration = await database.meta.get(GUEST_PLANNER_LAYOUT_KEY)
  const marked = roots.some(row => Object.hasOwn(row, 'operativePlanner'))
  if (!marked && !declaration && database.plannerFormatRequirement === 'legacy-or-journaled') {
    // Marker-free legacy fallback retains its original physical key and permissive historical shape
    return { format: 'legacy', record }
  }
  if (!record || roots.some(row => row.id !== LOCAL_DATA_RECORD_KEY && Object.hasOwn(row, 'operativePlanner'))) throw journaledPlannerError()
  // Storage failures stay outside the parser catch so they retain the existing storage-failure classification
  const history = await database.history.toArray()
  const catalogRecords = await database.catalogs.toArray()
  try {
    const validated = validateGuestPlannerRecord(record, declaration, history, database.plannerFormatRequirement)
    if (validated.format !== 'journaled' || !declaration) throw new Error('Missing journaled planner declaration')
    for (const row of catalogRecords) {
      if (row.key !== catalogKey(row.snapshot) || row.id !== row.snapshot.id || row.revisionId !== row.snapshot.revisionId || row.checksum !== row.snapshot.checksum) throw new Error('Catalog wrapper differs from its snapshot')
      const bundled = BUNDLED_CATALOGS.find(catalog => catalogKey(catalog) === row.key)
      if (bundled && !guestPlannerValuesEqual(bundled, row.snapshot)) throw new Error('Stored packaged catalog differs from its exact pin')
    }
    // Reuse immutable membership across endpoints; raw stored snapshots still require their normal validation
    const additionalCatalogs = catalogRecords.filter(row => !BUNDLED_CATALOG_KEYS.has(row.key)).map(row => row.snapshot)
    const catalogs = additionalCatalogs.length ? Object.freeze([...BUNDLED_CATALOGS, ...additionalCatalogs]) : BUNDLED_CATALOGS
    // Only declared endpoints constrain the destination graph; imported history and source bodies remain inert here
    // Native backup history validation imposes export retention and undo rules that do not govern this journal
    for (const localData of [record.localData, ...validated.journal.checkpoints.flatMap(entry => [entry.before, entry.after])]) validateNativeLocalDataGraph(localData, catalogs)
    return { format: 'journaled', record, declaration, history, catalogs: catalogRecords, validated }
  } catch (error) { throw journaledPlannerError(INVALID_JOURNALED_PLANNER, error) }
}

async function readSaveTarget(database: CryKitDatabase, expectedRevision: number): Promise<PlannerAdmission> {
  const admission = await readPlannerAdmissionInTransaction(database), record = admission.record
  if (!record) throw new AppDataError('not-found', 'The planner data no longer exists', { recoverable: true })
  if (record.revision !== expectedRevision) throw new AppDataError('revision-conflict', 'This planner data changed in another tab. Reload before saving', {
    recoverable: true, details: { expectedRevision, actualRevision: record.revision },
  })
  return admission
}

async function readModSetupTarget(database: CryKitDatabase, expectedRevision: number): Promise<LocalDataRecord> {
  const admission = await readPlannerAdmissionInTransaction(database), record = admission.record
  if (!record || record.revision !== expectedRevision) throw new AppDataError('revision-conflict', 'The planner changed in another tab. Reopen mod selection and try again', { recoverable: true })
  if (admission.format === 'journaled') throw journaledPlannerError(DIRECT_JOURNALED_MOD_SETUP)
  return record
}

async function removePersistedBundledCatalogs(database: CryKitDatabase): Promise<void> {
  await database.catalogs.bulkDelete([...BUNDLED_CATALOG_KEYS])
}

// Fresh managed profiles and the legacy initializer share the exact supplied sample baseline
// Constructing it performs no database writes and grants no authority over existing user records
export function createStarterLocalData(): LocalData {
  let localData = createSampleLocalData(CURRENT_CATALOG)
  for (const encoded of starterBuildShares) {
    const original = decodeSharePayload(encoded)
    const display = (starterBuildReferenceNames as unknown as Readonly<Record<string, { referenceNames: readonly BuildReferenceName[]; modSourceReceipts: readonly ModSourceReceipt[] }>>)[original.title]
    if (!display) throw new Error('A starter Build display receipt is missing')
    // These selected names supplement the unchanged supplied checkpoint, without supplying definitions
    const payload = { ...original, version: 4 as const, records: { ...original.records, gameSetups: Object.fromEntries(Object.entries(original.records.gameSetups).map(([id, setup]) => [id, { ...setup, modSourceReceipts: display.modSourceReceipts }])), buildRevisions: Object.fromEntries(Object.entries(original.records.buildRevisions).map(([id, revision]) => [id, { ...revision, content: { ...revision.content, referenceNames: display.referenceNames } }])) } }
    if (payload.kind !== 'build') throw new Error('A starter Build snapshot is not a Build')
    const copied = saveSharedCopy(localData, payload)
    const build = copied.localData.builds[copied.buildId!]!
    // The shared Brawler snapshot predates its corrected starter title; keep its checkpoint and source intact
    localData = {
      ...copied.localData,
      builds: { ...copied.localData.builds, [build.id]: { ...build, title: STARTER_BUILD_TITLE_OVERRIDES[payload.title] ?? build.title, tags: [...new Set([...build.tags, 'sample'])] } },
    }
  }
  // The first-run records form one baseline; unavailable definitions retain their exact pins
  // Reinterpreting a source with another parser would silently change the supplied checkpoints
  localData = { ...localData, revision: 0, changes: [], updatedAt: localData.createdAt }
  localData = { ...localData, modSetup: { version: 1, state: BUNDLED_MOD_LIBRARY.length ? 'pending' : 'skipped' }, referenceLibrary: { version: 1, excludedMods: [...new Set([...BUNDLED_MOD_LIBRARY.map(mod => mod.id), ...SWITCH_MOD_PACKS.flatMap(pack => pack.mods).map(name => `name:${normalizeModName(name)}`)])] } }
  validateLocalDataForStorage(localData, BUNDLED_CATALOGS)
  return localData
}

async function initializeStarterRecord(database: CryKitDatabase): Promise<LocalDataRecord> {
  return database.transaction('rw', database.localDatas, async () => {
    const active = await database.localDatas.get(LOCAL_DATA_RECORD_KEY)
    if (active) return active
    const existing = await database.localDatas.orderBy('updatedAt').last()
    if (existing) return existing
    const localData = createStarterLocalData()
    const record: LocalDataRecord = {
      id: LOCAL_DATA_RECORD_KEY,
      revision: localData.revision,
      updatedAt: localData.updatedAt,
      localData,
      lineage: { rootLocalDataId: localData.id },
    }
    await database.localDatas.add(record)
    return record
  })
}

async function resolveLocalDataRecord(
  database: CryKitDatabase,
): Promise<LocalDataRecord> {
  const requested = await database.localDatas.get(LOCAL_DATA_RECORD_KEY)
  if (requested) return requested
  const first = await database.localDatas.orderBy('updatedAt').last()
  return first ?? initializeStarterRecord(database)
}

// Addition checks may skip unchanged shared branches; complete retention checks omit the previous view
// Setup locks remain explicit, and inert public context never grants catalog authority
export function catalogReferences(localData: LocalData, previous?: LocalData): Set<string> {
  const inert = publicContextContainers(localData)
  const keys = new Set<string>()
  const visit = (value: unknown, before?: unknown): void => {
    if (value === before) return
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) visit(value[index], Array.isArray(before) ? before[index] : undefined)
      return
    }
    const record = value as Readonly<Record<string, unknown>>
    if (
      record.kind === 'catalog' &&
      typeof record.catalogId === 'string' &&
      typeof record.catalogRevisionId === 'string'
    ) {
      keys.add(catalogSnapshotKey(record.catalogId, record.catalogRevisionId))
    }
    const prior = before && typeof before === 'object' ? before as Readonly<Record<string, unknown>> : undefined
    for (const [key, nested] of Object.entries(record)) if (key !== 'publicSourceContext' || !inert.has(record)) visit(nested, prior?.[key])
  }
  visit(localData, previous)
  for (const gameSetup of Object.values(localData.gameSetups)) {
    if (gameSetup.modComposition) for (const pin of [gameSetup.modComposition.baseline, ...gameSetup.modComposition.layers]) keys.add(catalogSnapshotKey(pin.catalogId, pin.catalogRevisionId))
    for (const [catalogId, revisionId] of Object.entries(gameSetup.catalogLock)) {
      keys.add(catalogSnapshotKey(catalogId, revisionId))
    }
  }
  return keys
}

function localDataImportDigests(localData: LocalData): Set<string> {
  return new Set(
    Object.values(localData.importReceipts)
      .map((receipt) => /^sha256:([0-9a-f]{64})$/.exec(receipt.sourceIdentity)?.[1])
      .filter((digest): digest is string => Boolean(digest)),
  )
}

async function loadedDataForRecord(database: CryKitDatabase, record: LocalDataRecord, admission: PlannerAdmission): Promise<LoadedLocalData> {
  const keys = catalogReferences(record.localData)
  const digests = localDataImportDigests(record.localData)
  const availableCatalogRecords = admission.format === 'journaled' ? admission.catalogs : await database.catalogs.toArray()
  const catalogRecords = availableCatalogRecords.filter(
    (candidate) => !BUNDLED_CATALOG_KEYS.has(candidate.key) && (keys.has(candidate.key) || digests.has(/^sha256:([0-9a-f]{64})$/.exec(candidate.checksum)?.[1] ?? '')),
  )
  for (const catalog of [...BUNDLED_CATALOGS, ...catalogRecords.map(record => record.snapshot)]) {
    const digest = /^sha256:(.+)$/.exec(catalog.checksum)?.[1]
    if (digest) digests.add(digest)
  }
  const evidence = digests.size > 0
    ? (await database.evidence.toArray()).filter((record) => digests.has(record.sourceDigest))
    : []
  const canUndo = admission.format === 'journaled' ? admission.validated.journal.undoable : Boolean(await database.history
    .where('[localDataId+nextRevision]')
    .equals([record.localData.id, record.revision])
    .first())
  return {
    localData: cloneJson(record.localData),
    lineage: cloneJson(record.lineage),
    catalogs: expandModCatalogs([...BUNDLED_CATALOGS.filter(catalog => catalog === CURRENT_CATALOG || keys.has(catalogKey(catalog))), ...catalogRecords.map((catalog) => cloneJson(catalog.snapshot))]),
    evidence: evidence.map(cloneJson),
    revision: record.revision,
    canUndo,
  }
}

export async function loadLocalData(database = getDatabase()): Promise<LoadedLocalData> {
  let openingError: ReturnType<typeof captureRequiredPlannerOpeningError> | undefined
  try {
    openingError = captureRequiredPlannerOpeningError(database)
    const tables = [database.localDatas, database.meta, database.history, database.catalogs, database.evidence]
    const journaled = await database.transaction('r', tables, async () => {
      const admission = await readPlannerAdmissionInTransaction(database)
      return admission.format === 'journaled' ? loadedDataForRecord(database, admission.record, admission) : undefined
    })
    if (journaled) return journaled
    // The first read grants no mutation permission: a competing handle may install a tuple before this transaction starts
    return await database.transaction('rw', tables, async () => {
      const admission = await readPlannerAdmissionInTransaction(database)
      if (admission.format === 'journaled') return loadedDataForRecord(database, admission.record, admission)
      await removePersistedBundledCatalogs(database)
      const record = await resolveLocalDataRecord(database)
      return loadedDataForRecord(database, record, admission)
    })
  } catch (error) {
    throw asAppDataError(openingError?.(error) ?? error, {
      code: 'storage-failure',
      userMessage: 'The local planner data could not be loaded',
      recoverable: true,
    })
  }
}

export function changedLocalData(before: LocalData, proposed: LocalData, command: string, timestamp: Timestamp): LocalData {
  return changedLocalDataWithSharedUnits(before, cloneJson(proposed), command, timestamp)
}

// Managed callers own immutable typed units; history is captured separately at the exact endpoints
// This preserves the same clock/change semantics without cloning every unchanged current unit
export function changedLocalDataWithSharedUnits(before: LocalData, proposed: LocalData, command: string, timestamp: Timestamp): LocalData {
  const nextRevision = before.revision + 1
  const change: ChangeEntry = {
    id: asChangeId(randomId('change')),
    command,
    previousRevision: before.revision,
    nextRevision,
    changedPaths: ['$'],
    recordedAt: timestamp,
  }
  return {
    ...proposed,
    id: before.id,
    revision: nextRevision,
    createdAt: before.createdAt,
    updatedAt: timestamp,
    changes: [...before.changes, change].slice(-MAX_LOCAL_DATA_CHANGES),
  }
}

export function localDataForSave(before: LocalData, proposed: LocalData, expectedRevision: number, timestamp: Timestamp): {
  readonly localData: LocalData
  readonly command: string
} {
  if (proposed.id !== before.id || proposed.revision < expectedRevision) {
    throw new AppDataError('revision-conflict', 'The draft does not descend from the loaded planner-data revision', {
      recoverable: true,
    })
  }
  if (proposed.revision === expectedRevision) {
    return { localData: changedLocalData(before, proposed, 'save-localData', timestamp), command: 'save-localData' }
  }
  const retainedIds = new Set(before.changes.map((change) => change.id))
  const newChanges = proposed.changes.filter((change) => !retainedIds.has(change.id))
  const lastChange = newChanges.at(-1)
  if (newChanges.length === 0 || lastChange?.nextRevision !== proposed.revision) {
    throw new AppDataError('schema-mismatch', 'The draft revision is missing its domain change history', {
      recoverable: true,
    })
  }
  const command = newChanges.map((change) => change.command).join('+')
  return {
    localData: {
      ...cloneJson(proposed),
      id: before.id,
      createdAt: before.createdAt,
      updatedAt: timestamp,
      changes: proposed.changes.slice(-MAX_LOCAL_DATA_CHANGES),
    },
    command,
  }
}

export function journaledLocalDataForSave(before: LocalData, proposed: LocalData, savedChanges: readonly ChangeEntry[], timestamp: Timestamp) {
  return journaledLocalDataForSaveWithSharedUnits(before, cloneJson(proposed), savedChanges, timestamp)
}

// Managed preparation captures mutable changed branches before awaiting and reuses admitted immutable units
// The journal checks remain identical; this variant only avoids a second whole-planner clone
export function journaledLocalDataForSaveWithSharedUnits(before: LocalData, proposed: LocalData, savedChanges: readonly ChangeEntry[], timestamp: Timestamp): {
  readonly localData: LocalData
  readonly command: string
  readonly newChanges: readonly ChangeEntry[]
} {
  const invalid = (): never => { throw new AppDataError('schema-mismatch', 'The journaled draft is missing complete destination change history. Keep your draft and reopen the workspace', { recoverable: true }) }
  if (proposed.id !== before.id || !Number.isSafeInteger(before.revision) || !Number.isSafeInteger(proposed.revision) || proposed.revision < before.revision) invalid()
  const prior = new Map(savedChanges.map(change => [change.id, change]))
  const seen = new Set<string>()
  const newChanges: ChangeEntry[] = []
  for (const change of proposed.changes) {
    if (seen.has(change.id)) invalid()
    seen.add(change.id)
    const original = prior.get(change.id)
    if (original) {
      // A caller may retain older destination entries beyond the live window, but cannot rewrite their provenance
      if (!guestPlannerValuesEqual(change, original)) invalid()
    } else {
      if (!Number.isSafeInteger(change.previousRevision) || !Number.isSafeInteger(change.nextRevision) || change.previousRevision < before.revision || change.nextRevision !== change.previousRevision + 1) invalid()
      newChanges.push(change)
    }
  }
  if (proposed.revision === before.revision) {
    if (before.revision === Number.MAX_SAFE_INTEGER || newChanges.length || before.changes.some(change => !seen.has(change.id))) invalid()
    const localData = changedLocalDataWithSharedUnits(before, proposed, 'save-localData', timestamp)
    return { localData, command: 'save-localData', newChanges: [localData.changes.at(-1)!] }
  }
  // Bounded drafts may omit old entries, but every newly claimed revision must be supplied in order
  let revision = before.revision
  for (const change of newChanges) {
    if (change.previousRevision !== revision) invalid()
    revision = change.nextRevision
  }
  if (revision !== proposed.revision) invalid()
  return {
    localData: { ...proposed, createdAt: before.createdAt, updatedAt: timestamp, changes: proposed.changes.slice(-MAX_LOCAL_DATA_CHANGES) },
    command: newChanges.map(change => change.command).join('+'),
    newChanges,
  }
}

export function historyEntry(before: LocalData, after: LocalData, command: string, timestamp: Timestamp): PersistedHistoryEntry {
  return {
    id: randomId('history'),
    localDataId: before.id,
    command,
    previousRevision: before.revision,
    nextRevision: after.revision,
    before: cloneJson(before),
    after: cloneJson(after),
    recordedAt: timestamp,
  }
}

async function trimHistory(database: CryKitDatabase, localDataId: LocalDataId): Promise<boolean> {
  const entries = await database.history.where('localDataId').equals(localDataId).sortBy('nextRevision')
  let removeCount = Math.max(0, entries.length - MAX_HISTORY_ENTRIES)
  let retainedBytes = entries.slice(removeCount).reduce((total, entry) => total + textBytes(entry).byteLength, 0)
  while (removeCount < entries.length && retainedBytes > MAX_HISTORY_BYTES) {
    retainedBytes -= textBytes(entries[removeCount]).byteLength
    removeCount += 1
  }
  if (removeCount > 0) await database.history.bulkDelete(entries.slice(0, removeCount).map((entry) => entry.id))
  return removeCount < entries.length
}

async function storedCatalogsForLocalData(
  database: CryKitDatabase,
  localData: LocalData,
): Promise<readonly CatalogSnapshot[]> {
  const keys = catalogReferences(localData)
  const stored = (await database.catalogs.toArray())
    .filter((record) => !BUNDLED_CATALOG_KEYS.has(record.key) && keys.has(record.key))
    .map((record) => record.snapshot)
  return [...BUNDLED_CATALOGS.filter((catalog) => keys.has(catalogKey(catalog))), ...stored]
}

const preparedCompositionBySources = new WeakMap<readonly CatalogSnapshot[], { readonly origin: string; readonly catalog: CatalogSnapshot }>()

export async function prepareModCatalogs(localData: LocalData, availableCatalogs: readonly CatalogSnapshot[]): Promise<readonly CatalogSnapshot[]> {
  const composed: CatalogSnapshot[] = []
  const immutableSources = availableCatalogs.every(isImmutableCatalogSnapshot)
  const reusableSources = immutableSources && Object.isFrozen(availableCatalogs)
  for (const gameSetup of Object.values(localData.gameSetups)) {
    if (!gameSetup.modComposition || modCatalogForPin(availableCatalogs, { catalogId: gameSetup.modComposition.baseline.catalogId, catalogRevisionId: gameSetup.catalogLock[gameSetup.modComposition.baseline.catalogId]! })) continue
    const origin = Object.values(localData.gameSetups).find(value => modCatalogRevision(value.id) === gameSetup.catalogLock[gameSetup.modComposition!.baseline.catalogId])
    if (!origin?.modComposition) throw new AppDataError('schema-mismatch', 'The effective mod catalog has no originating Game Setup')
    if (composed.some(value => value.revisionId === modCatalogRevision(origin.id))) continue
    if (hasWithdrawnModDependencies(origin.modComposition, availableCatalogs, origin.modSourceReceipts)) continue
    // The App and captured repository prepare the same candidate independently
    // Reuse one result only for an exact frozen source array and the complete captured origin value
    // A weak source-array key keeps private context within its owning snapshot lifetime
    const originValue = reusableSources ? canonicalJson(origin) : undefined
    const previous = reusableSources ? preparedCompositionBySources.get(availableCatalogs) : undefined
    if (previous && previous.origin === originValue) { composed.push(previous.catalog); continue }
    const catalog = composeModCatalog(origin, availableCatalogs)!
    const prepared = { ...catalog, checksum: `composition:sha256:${await sha256(new TextEncoder().encode(canonicalJson(catalog)))}` }
    const admitted = immutableSources ? immutableCatalogSnapshot(prepared) : prepared
    if (originValue !== undefined) preparedCompositionBySources.set(availableCatalogs, { origin: originValue, catalog: admitted })
    composed.push(admitted)
  }
  const sources = composed.length ? [...availableCatalogs, ...composed] : availableCatalogs
  // Owned immutable sources permit reusable readonly views even before the UI's optimistic render
  // Mutable callers retain normal recomputation and are never frozen through borrowed source children
  return immutableSources ? immutableExpandedModCatalogs(sources) : expandModCatalogs(sources)
}

export async function saveLocalDataWithStatus(localData: LocalData, expectedRevision: number, database = getDatabase(), retainHistory = false): Promise<LocalDataWriteResult> {
  let result: LocalDataWriteResult | undefined
  let openingError: ReturnType<typeof captureRequiredPlannerOpeningError> | undefined
  try {
    openingError = captureRequiredPlannerOpeningError(database)
    // Reject required-format failure before composition can mask it; the write transaction independently rechecks admission
    await database.transaction('r', [database.localDatas, database.meta, database.history, database.catalogs], () => readSaveTarget(database, expectedRevision))
    const availableCatalogs = [...BUNDLED_CATALOGS, ...(await database.catalogs.toArray()).map(record => record.snapshot)]
    const preparedCatalogs = await prepareModCatalogs(localData, availableCatalogs)
    const originalKeys = new Set(availableCatalogs.map(catalogKey))
    const composed = preparedCatalogs.filter(catalog => !originalKeys.has(catalogKey(catalog))).map(compactModCatalog)
    // Check the persisted revision inside the write transaction so another tab cannot win between check and save
    // Catalogs, planner state, and undo history must commit together or all roll back
    await database.transaction('rw', [database.localDatas, database.history, database.catalogs, database.meta], async () => {
      const admission = await readSaveTarget(database, expectedRevision)
      const record = admission.record!
      const timestamp = nowTimestamp()
      let journaledChanges: readonly ChangeEntry[] = []
      let prepared: ReturnType<typeof localDataForSave>
      if (admission.format === 'journaled') {
        const journaled = journaledLocalDataForSave(record.localData, localData, admission.validated.descriptor.savedDestinationChanges, timestamp)
        prepared = journaled
        journaledChanges = journaled.newChanges
      } else prepared = localDataForSave(record.localData, localData, expectedRevision, timestamp)
      const saved = prepared.localData
      await assertCatalogsImmutable(database, composed)
      if (composed.length) await database.catalogs.bulkPut(composed.map(toCatalogRecord))
      validateLocalDataForStorage(saved, await storedCatalogsForLocalData(database, saved))
      const updatedRecord: LocalDataRecord = {
        ...record,
        revision: saved.revision,
        updatedAt: saved.updatedAt,
        localData: saved,
      }
      const checkpoint = historyEntry(record.localData, saved, prepared.command, timestamp)
      if (admission.format === 'journaled') {
        // Only the admitted descriptor grants operative membership; imported rows with matching endpoints remain inert
        const descriptor = admission.validated.descriptor
        const nextRecord = { ...updatedRecord, operativePlanner: {
          ...descriptor,
          revision: saved.revision,
          checkpointIds: [...descriptor.checkpointIds, checkpoint.id],
          savedDestinationChanges: [...descriptor.savedDestinationChanges, ...journaledChanges],
          undoable: true,
        } }
        const validated = validateGuestPlannerRecord(nextRecord, admission.declaration, [...admission.history, checkpoint], 'journaled')
        if (validated.format !== 'journaled') throw journaledPlannerError()
        await database.history.add(checkpoint)
        await database.localDatas.put(nextRecord)
        result = { localData: saved, canUndo: validated.journal.undoable }
      } else {
        await database.localDatas.put(updatedRecord)
        await database.history.add(checkpoint)
        // Complete workspaces retain every checkpoint; the legacy planner facade keeps its existing trim policy
        result = { localData: saved, canUndo: retainHistory || await trimHistory(database, saved.id) }
      }
    })
  } catch (error) {
    throw asAppDataError(openingError?.(error) ?? error, {
      code: 'storage-failure',
      userMessage: 'The planner data could not be saved. Your previous local revision is unchanged',
      recoverable: true,
    })
  }
  if (!result) throw new AppDataError('storage-failure', 'The planner-data save did not complete', { recoverable: true })
  notify({ localDataId: result.localData.id, revision: result.localData.revision, reason: 'save' })
  return cloneJson(result)
}

export async function saveLocalData(localData: LocalData, expectedRevision: number): Promise<LocalData> {
  return (await saveLocalDataWithStatus(localData, expectedRevision)).localData
}

export async function commitModSetup(previews: readonly ImportPreview[], expectedRevision: number, skip = false, database = getDatabase()): Promise<LoadedLocalData> {
  if (skip && previews.length) throw new AppDataError('schema-mismatch', 'Skipping mod selection cannot import sources', { recoverable: true })
  let openingError: ReturnType<typeof captureRequiredPlannerOpeningError> | undefined
  try {
    openingError = captureRequiredPlannerOpeningError(database)
    const before = await database.transaction('r', [database.localDatas, database.meta, database.history, database.catalogs], () => readModSetupTarget(database, expectedRevision))
    const stored = (await database.catalogs.toArray()).map(record => record.snapshot)
    const candidates = previews.map(preview => {
      if (preview.detectedFormat !== CRYSTAL_EDIT_CATALOG_SCHEMA || preview.errors.length || preview.proposed.catalogs.length !== 1) throw new AppDataError('schema-mismatch', 'Mod selection requires a verified Crystal Edit source', { recoverable: true })
      const incoming = preview.proposed.catalogs[0]!
      const existing = stored.find(catalog => catalogKey(catalog) === catalogKey(incoming))
      return { ...incoming, ...(existing ? { importedAt: existing.importedAt } : {}) }
    })
    const available = [...BUNDLED_CATALOGS, ...stored, ...candidates.filter(candidate => !stored.some(catalog => catalogKey(catalog) === catalogKey(candidate)))]
    const configured = configureModSetup(before.localData, candidates, available, expectedRevision, skip)
    const prepared = await prepareModCatalogs(configured, available)
    await database.transaction('rw', [database.localDatas, database.catalogs, database.sources, database.evidence, database.imports, database.history, database.meta], async () => {
      const target = await readModSetupTarget(database, expectedRevision)
      for (const [index, preview] of previews.entries()) {
        const sources = await Promise.all(preview.proposed.sources.map(async source => {
          const existing = await database.sources.get(source.id)
          return existing ? { ...source, importedAt: existing.importedAt, filename: existing.filename } : source
        }))
        await putCandidateData(database, { ...preview.proposed, catalogs: [candidates[index]!], sources })
      }
      const existingKeys = new Set(available.map(catalogKey))
      const composed = prepared.filter(catalog => !existingKeys.has(catalogKey(catalog))).map(compactModCatalog)
      await assertCatalogsImmutable(database, composed)
      if (composed.length) await database.catalogs.bulkPut(composed.map(toCatalogRecord))
      const timestamp = nowTimestamp()
      const receipts = Object.fromEntries(previews.flatMap(preview => Object.entries(preview.proposed.localData.importReceipts)).map(([id, receipt]) => [id, target.localData.importReceipts[id] ?? { ...receipt, importedAt: timestamp, localDataRevision: configured.revision }]))
      const updated = { ...configured, importReceipts: { ...configured.importReceipts, ...receipts } }
      validateLocalDataForStorage(updated, prepared)
      await database.localDatas.put({ ...target, revision: updated.revision, updatedAt: updated.updatedAt, localData: updated })
      for (const preview of previews) {
        if (!await database.imports.get(preview.id)) await database.imports.put({ id: preview.id, sourceDigest: preview.sourceDigest, localDataId: target.localData.id, importedAt: timestamp })
      }
      await database.history.add(historyEntry(target.localData, updated, skip ? 'mods.setup-skip' : 'mods.setup-configure', timestamp))
      await trimHistory(database, updated.id)
    })
    const loaded = await loadLocalData(database)
    notify({ localDataId: loaded.localData.id, revision: loaded.revision, reason: 'save' })
    return loaded
  } catch (error) {
    throw asAppDataError(openingError?.(error) ?? error, { code: 'storage-failure', userMessage: 'Mod selection could not be saved. Your previous configuration is unchanged', recoverable: true })
  }
}

async function putCandidateData(database: CryKitDatabase, candidate: ImportCandidate): Promise<void> {
  assertStarterCatalogIdentity(candidate.catalogs)
  const storedCatalogs = candidate.catalogs.filter((catalog) => !isBundledCatalog(catalog)).map(compactModCatalog)
  await assertCatalogsImmutable(database, storedCatalogs)
  if (storedCatalogs.length > 0) await database.catalogs.bulkPut(storedCatalogs.map(toCatalogRecord))
  for (const evidence of candidate.evidence) {
    const existingEvidence = await database.evidence.get(evidence.id)
    if (existingEvidence && !jsonEqual(existingEvidence, evidence)) {
      throw new AppDataError('import-conflict', 'An evidence record conflicts with existing local data', {
        recoverable: true,
        details: { evidenceId: evidence.id },
      })
    }
    if (!existingEvidence) await database.evidence.add(cloneJson(evidence))
  }
  for (const source of candidate.sources) {
    const existingSource = await database.sources.get(source.id)
    const sourceMetadata = ({ bytes: _bytes, ...metadata }: typeof source): Omit<typeof source, 'bytes'> => metadata
    if (existingSource && (
      !jsonEqual(sourceMetadata(existingSource), sourceMetadata(source)) ||
      !bytesEqual(existingSource.bytes, source.bytes)
    )) {
      throw new AppDataError('import-conflict', 'A source archive conflicts with existing local data', {
        recoverable: true,
        details: { sourceId: source.id },
      })
    }
    if (!existingSource) await database.sources.add(cloneJson(source))
  }
}

export async function commitImport(
  preview: ImportPreview,
  options: CommitImportOptions = {},
  database = getDatabase(),
): Promise<LoadedLocalData> {
  if (preview.errors.length > 0) {
    throw new AppDataError('schema-mismatch', 'The import preview contains errors and cannot be applied', {
      recoverable: true,
    })
  }
  const mode = options.mode ?? 'replace'
  let committed = false
  let openingError: ReturnType<typeof captureRequiredPlannerOpeningError> | undefined
  // Candidate bytes, evidence, catalogs, and the planner root share one rollback boundary
  // Notifying other tabs before this transaction resolves would advertise data that may never commit
  try {
    openingError = captureRequiredPlannerOpeningError(database)
    await database.transaction(
      'rw',
      [
        database.localDatas,
        database.catalogs,
        database.evidence,
        database.sources,
        database.history,
        database.imports,
        database.meta,
      ],
      async () => {
        const admission = await readPlannerAdmissionInTransaction(database)
        const target = admission.record
        if (!target) throw new AppDataError('not-found', 'The local planner data no longer exists', { recoverable: true })
        if (options.targetLocalDataId !== undefined && options.targetLocalDataId !== target.localData.id) {
          throw new AppDataError('revision-conflict', 'The import target changed. Reload before importing', { recoverable: true })
        }
        if (options.expectedRevision !== undefined && options.expectedRevision !== target.revision) {
          throw new AppDataError('revision-conflict', 'The local planner data changed. Reload before importing', { recoverable: true })
        }
        if (admission.format === 'journaled') throw journaledPlannerError(DIRECT_JOURNALED_IMPORT)
        assertStarterCatalogIdentity(preview.proposed.catalogs)
        if (mode === 'add-reference') {
          if (preview.detectedFormat !== CRYSTAL_EDIT_CATALOG_SCHEMA || preview.counts.personal || preview.counts.mixed) {
            throw new AppDataError('import-conflict', 'Only a reference-only Crystal Edit preview can be added to existing planner data', { recoverable: true })
          }
          if (options.includeModInReference && !preview.proposed.catalogs.some(catalog => catalog.id === options.includeModInReference)) throw new AppDataError('import-conflict', 'Reference membership must match the imported mod identity', { recoverable: true })
          const candidateReceipts = Object.values(preview.proposed.localData.importReceipts)
          const alreadyImported = candidateReceipts.length > 0 && candidateReceipts.every(candidate => target.localData.importReceipts[candidate.id]?.sourceIdentity === candidate.sourceIdentity)
          const inclusionChanged = Boolean(options.includeModInReference && target.localData.referenceLibrary?.excludedMods.includes(options.includeModInReference))
          if (alreadyImported && !inclusionChanged) {
            committed = true
            return
          }
          const catalogs = await Promise.all(preview.proposed.catalogs.map(async catalog => {
            const existing = await database.catalogs.get(catalogKey(catalog))
            return existing ? { ...catalog, importedAt: existing.snapshot.importedAt } : catalog
          }))
          const sources = await Promise.all(preview.proposed.sources.map(async source => {
            const existing = await database.sources.get(source.id)
            return existing ? { ...source, importedAt: existing.importedAt, filename: existing.filename } : source
          }))
          if (!alreadyImported) await putCandidateData(database, { ...preview.proposed, catalogs, sources })
          const timestamp = nowTimestamp()
          const receipts = alreadyImported ? {} : Object.fromEntries(Object.entries(preview.proposed.localData.importReceipts).map(([id, receipt]) => [id, { ...receipt, importedAt: timestamp, localDataRevision: target.revision + 1 }]))
          const command = alreadyImported ? 'reference.mod-membership' : 'add-reference-catalog'
          const membership = inclusionChanged ? { referenceLibrary: referenceLibraryWithMod(target.localData.referenceLibrary, options.includeModInReference!, true) } : {}
          const updated = changedLocalData(target.localData, { ...target.localData, importReceipts: { ...target.localData.importReceipts, ...receipts }, ...membership }, command, timestamp)
          const storedCatalogs = [
            ...BUNDLED_CATALOGS,
            ...(await database.catalogs.toArray())
              .filter(record => !BUNDLED_CATALOG_KEYS.has(record.key))
              .map(record => record.snapshot),
          ]
          validateNativeLocalDataGraph(updated, storedCatalogs)
          await database.localDatas.put({ ...target, revision: updated.revision, updatedAt: timestamp, localData: updated })
          await database.history.add(historyEntry(target.localData, updated, command, timestamp))
          if (!alreadyImported) await database.imports.put({ id: preview.id, sourceDigest: preview.sourceDigest, localDataId: target.localData.id, importedAt: timestamp })
          committed = true
          return
        }
        const timestamp = nowTimestamp()
        const proposed = { ...cloneJson(preview.proposed.localData), id: target.localData.id }
        const replacement = changedLocalData(
          target.localData,
          proposed,
          'replace-localData-from-import',
          timestamp,
        )
        const replacementCatalogs = new Map(
          [...BUNDLED_CATALOGS, ...preview.proposed.catalogs]
            .map(catalog => [catalogSnapshotKey(catalog.id, catalog.revisionId), catalog]),
        )
        validateNativeLocalDataGraph(replacement, [...replacementCatalogs.values()])
        await putCandidateData(database, preview.proposed)
        await database.localDatas.put({
          id: LOCAL_DATA_RECORD_KEY,
          revision: replacement.revision,
          updatedAt: replacement.updatedAt,
          localData: replacement,
          lineage: {
            rootLocalDataId: target.lineage.rootLocalDataId,
            parentLocalDataId: target.localData.id,
            sourceLocalDataId: preview.proposed.localData.id,
            sourceRevision: preview.proposed.localData.revision,
            forkedAt: timestamp,
          },
        })
        await database.history.add(historyEntry(target.localData, replacement, 'replace-localData-from-import', timestamp))
        await database.imports.put({
          id: preview.id,
          sourceDigest: preview.sourceDigest,
          localDataId: target.localData.id,
          importedAt: timestamp,
        })
        committed = true
      },
    )
  } catch (error) {
    throw asAppDataError(openingError?.(error) ?? error, {
      code: 'storage-failure',
      userMessage: 'The import could not be applied. Existing local data is unchanged',
      recoverable: true,
    })
  }
  if (!committed) throw new AppDataError('storage-failure', 'The import did not complete', { recoverable: true })
  const loaded = await loadLocalData(database)
  notify({ localDataId: loaded.localData.id, revision: loaded.revision, reason: 'import' })
  return loaded
}

export async function undoLocalDataWithStatus(expectedRevision: number, database = getDatabase(), retainHistory = false): Promise<LocalDataWriteResult> {
  let result: LocalDataWriteResult | undefined
  let openingError: ReturnType<typeof captureRequiredPlannerOpeningError> | undefined
  try {
    openingError = captureRequiredPlannerOpeningError(database)
    await database.transaction('rw', [database.localDatas, database.history, database.catalogs, database.meta], async () => {
      const admission = await readPlannerAdmissionInTransaction(database)
      const record = admission.record
      if (!record) throw new AppDataError('not-found', 'The planner data no longer exists', { recoverable: true })
      if (record.revision !== expectedRevision) {
        throw new AppDataError('revision-conflict', 'This planner data changed in another tab. Reload before undoing', {
          recoverable: true,
        })
      }
      if (admission.format === 'journaled') {
        if (!admission.validated.journal.undoable) throw new AppDataError('not-found', 'There is no saved change to undo', { recoverable: true })
        if (!Number.isSafeInteger(record.revision + 1)) throw journaledPlannerError('The journaled planner revision cannot advance safely. Keep your draft and reopen the workspace')
        // Only ordered declared membership grants Undo authority; matching imported endpoints remain inert
        const latest = admission.validated.journal.checkpoints.at(-1)!
        const timestamp = nowTimestamp()
        const command = `undo:${latest.command}`
        const restored = changedLocalData(record.localData, latest.before, command, timestamp)
        validateLocalDataForStorage(restored, await storedCatalogsForLocalData(database, restored))
        const checkpoint = historyEntry(record.localData, restored, command, timestamp)
        const descriptor = admission.validated.descriptor
        // Undo is a fresh destination transition, preserving all earlier evidence even outside the live change window
        const nextRecord: LocalDataRecord = {
          ...record, revision: restored.revision, updatedAt: restored.updatedAt, localData: restored,
          operativePlanner: {
            ...descriptor, revision: restored.revision,
            checkpointIds: [...descriptor.checkpointIds, checkpoint.id],
            savedDestinationChanges: [...descriptor.savedDestinationChanges, restored.changes.at(-1)!],
            undoable: true,
          },
        }
        validateGuestPlannerRecord(nextRecord, admission.declaration, [...admission.history, checkpoint], 'journaled')
        // Both writes share the admission transaction so failures cannot publish an orphan or a partial root
        await database.history.add(checkpoint)
        await database.localDatas.put(nextRecord)
        result = { localData: restored, canUndo: true }
        return
      }
      const latest = await database.history
        .where('[localDataId+nextRevision]')
        .equals([record.localData.id, expectedRevision])
        .last()
      if (!latest) throw new AppDataError('not-found', 'There is no saved change to undo', { recoverable: true })
      const timestamp = nowTimestamp()
      const restored = changedLocalData(record.localData, latest.before, `undo:${latest.command}`, timestamp)
      validateLocalDataForStorage(restored, await storedCatalogsForLocalData(database, restored))
      await database.localDatas.put({
        ...record,
        revision: restored.revision,
        updatedAt: restored.updatedAt,
        localData: restored,
      })
      await database.history.add(historyEntry(record.localData, restored, `undo:${latest.command}`, timestamp))
      // Undo creates a new checkpoint without discarding the closed workspace's retained history
      result = { localData: restored, canUndo: retainHistory || await trimHistory(database, restored.id) }
    })
  } catch (error) {
    throw asAppDataError(openingError?.(error) ?? error, {
      code: 'storage-failure',
      userMessage: 'The last change could not be undone. Existing local data is unchanged',
      recoverable: true,
    })
  }
  if (!result) throw new AppDataError('storage-failure', 'Undo did not complete', { recoverable: true })
  notify({ localDataId: result.localData.id, revision: result.localData.revision, reason: 'undo' })
  return cloneJson(result)
}

export async function undoLocalData(expectedRevision: number): Promise<LocalData> {
  return (await undoLocalDataWithStatus(expectedRevision)).localData
}

function textBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

export function zipReadableByImporter(entries: Readonly<Record<string, Uint8Array>>): Uint8Array {
  // Highly compressible valid data can exceed our importer's inflation limit
  // Store only those entries uncompressed so our own backups remain readable without weakening import limits
  const compressed = zipSync(entries)
  const directory = inspectZip(compressed, {
    ...NATIVE_BACKUP_ARCHIVE_LIMITS,
    maxCompressedBytes: NATIVE_BACKUP_ARCHIVE_LIMITS.maxTotalUncompressedBytes + BACKUP_PAYLOAD_HEADROOM_BYTES,
    maxInflationRatio: Number.POSITIVE_INFINITY,
  })
  const storedPaths = new Set(directory.entries
    .filter((entry) => entry.uncompressedSize > 0 && entry.uncompressedSize / entry.compressedSize > NATIVE_BACKUP_ARCHIVE_LIMITS.maxInflationRatio)
    .map((entry) => entry.name))
  if (storedPaths.size === 0) return compressed
  const adjusted = Object.fromEntries(Object.entries(entries).map(([path, bytes]) => [
    path,
    storedPaths.has(path) ? [bytes, { level: 0 }] : bytes,
  ])) as Zippable
  return zipSync(adjusted)
}

function referencedSourceDigests(localData: LocalData, history: readonly PersistedHistoryEntry[], catalogs: readonly CatalogSnapshot[]): ReadonlySet<string> {
  const inert = publicContextContainers(localData, ...history.flatMap(entry => [entry.before, entry.after]))
  const digests = new Set<string>()
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const digest = /^(?:source:)?sha256:([0-9a-f]{64})$/.exec(value)?.[1]
      if (digest) digests.add(digest)
      return
    }
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry)
      return
    }
    for (const [key, entry] of Object.entries(value as Readonly<Record<string, unknown>>)) {
      // A display receipt declares an external dependency, not source bytes retained by this browser
      // Available catalogs and their provenance still require their archived bytes independently
      const record = value as Readonly<Record<string, unknown>>
      if (key === 'publicSourceContext' && inert.has(record)) continue
      if (key !== 'modSourceReceipts' || typeof record.gameSetupId !== 'string' || !record.modComposition) visit(entry)
    }
  }
  for (const value of [localData, history, catalogs]) visit(value)
  return digests
}

// Native readers cap history at 500 even when the operative journal retains more checkpoints
// Drop only oldest members so every exported suffix still ends at the captured root
export function selectBackupHistory<T extends { readonly payload: unknown }>(
  history: readonly PersistedHistoryEntry[],
  contentFor: (history: readonly PersistedHistoryEntry[]) => T,
  maxPayloadBytes = MAX_BACKUP_PAYLOAD_BYTES,
): { readonly history: readonly PersistedHistoryEntry[]; readonly content: T; readonly payloadBytes: Uint8Array } {
  let retained = history.slice(-MAX_HISTORY_ENTRIES)
  let content = contentFor(retained)
  let payloadBytes = textBytes(content.payload)
  while (payloadBytes.byteLength > maxPayloadBytes && retained.length > 0) {
    retained = retained.slice(1)
    content = contentFor(retained)
    payloadBytes = textBytes(content.payload)
  }
  if (payloadBytes.byteLength > maxPayloadBytes) {
    throw new AppDataError('storage-failure', 'The current planner data exceeds the safe backup size limit', {
      recoverable: true,
      details: { limit: maxPayloadBytes },
    })
  }
  return { history: retained, content, payloadBytes }
}

export async function exportBackup(localDataOverride?: LocalData, database = getDatabase()): Promise<Uint8Array> {
  let openingError: ReturnType<typeof captureRequiredPlannerOpeningError> | undefined
  try {
    openingError = captureRequiredPlannerOpeningError(database)
    const captured = await database.transaction(
      'r',
      [database.localDatas, database.catalogs, database.evidence, database.sources, database.history, database.meta],
      async () => {
        const admission = await readPlannerAdmissionInTransaction(database)
        const record = admission.record
        if (!record) throw new AppDataError('not-found', 'The planner data no longer exists', { recoverable: true })
        if (localDataOverride && localDataOverride.id !== record.localData.id) {
          throw new AppDataError('schema-mismatch', 'The recovery draft belongs to different planner data', {
            recoverable: true,
          })
        }
        let localData = cloneJson(record.localData)
        // Only admitted descriptor members grant native Undo authority; imported endpoint collisions stay inert
        const history = admission.format === 'journaled'
          ? admission.validated.journal.checkpoints.map(cloneJson)
          : (await database.history.where('localDataId').equals(record.localData.id).sortBy('nextRevision')).map(cloneJson)
        if (localDataOverride && !jsonEqual(localDataOverride, record.localData)) {
          const timestamp = nowTimestamp()
          const recoveryDraft = { ...cloneJson(localDataOverride), id: record.localData.id }
          localData = changedLocalData(record.localData, recoveryDraft, 'recovery-draft-export', timestamp)
          history.push(historyEntry(record.localData, localData, 'recovery-draft-export', timestamp))
        }
        return {
          localData,
          lineage: cloneJson(record.lineage),
          history,
          catalogRecords: await database.catalogs.toArray(),
          evidenceRecords: await database.evidence.toArray(),
          sourceRecords: await database.sources.toArray(),
        }
      },
    )
    return await encodeCapturedPlannerBackup(captured)
  } catch (error) {
    throw asAppDataError(openingError?.(error) ?? error, {
      code: 'storage-failure',
      userMessage: 'The local backup could not be created',
      recoverable: true,
    })
  }
}

interface PlannerBackupCapture {
  readonly localData: LocalData
  readonly lineage: LocalDataLineage
  readonly history: readonly PersistedHistoryEntry[]
  readonly catalogRecords: readonly CatalogRecord[]
  readonly evidenceRecords: readonly EvidenceRecord[]
  readonly sourceRecords: readonly SourceArchiveRecord[]
}

// Managed roots supply the same admitted native values without rebuilding an old planner database
// This remains a trimmed planner ZIP, not the complete workspace or retained-source recovery archive
export async function exportPlannerSnapshot(planner: WorkspacePlannerState, sources: readonly SourceArchiveRecord[], override?: LocalData): Promise<Uint8Array> {
  if (override && override.id !== planner.localData.id) throw new AppDataError('schema-mismatch', 'The recovery draft belongs to different planner data', { recoverable: true })
  let localData = cloneJson(planner.localData)
  const history = (planner.journal?.checkpoints ?? planner.history).map(cloneJson)
  if (override && !jsonEqual(override, localData)) {
    const timestamp = nowTimestamp()
    localData = changedLocalData(planner.localData, cloneJson(override), 'recovery-draft-export', timestamp)
    history.push(historyEntry(planner.localData, localData, 'recovery-draft-export', timestamp))
  }
  return encodeCapturedPlannerBackup({ localData, lineage: planner.lineage, history, catalogRecords: planner.catalogs.map(toCatalogRecord), evidenceRecords: planner.evidence, sourceRecords: sources })
}

async function encodeCapturedPlannerBackup(captured: PlannerBackupCapture): Promise<Uint8Array> {
  // Journal admission requires exact historical effective catalogs; only a new journal draft may need composition
  const availableCatalogRecords = (await prepareModCatalogs(captured.localData, [
    ...BUNDLED_CATALOGS,
    ...captured.catalogRecords.filter(record => !BUNDLED_CATALOG_KEYS.has(record.key)).map(record => record.snapshot),
  ])).map(compactModCatalog).map(toCatalogRecord)
  const payloadFor = (history: readonly PersistedHistoryEntry[]) => {
    // A native root without Undo checkpoints cannot carry live changes; clear only this export copy
    const localData = history.length === 0 && captured.localData.changes.length > 0
      ? { ...captured.localData, changes: [] }
      : captured.localData
    const catalogKeys = catalogReferences(localData)
    const importDigests = localDataImportDigests(localData)
    for (const entry of history) {
      for (const key of catalogReferences(entry.before)) catalogKeys.add(key)
      for (const key of catalogReferences(entry.after)) catalogKeys.add(key)
      for (const digest of localDataImportDigests(entry.before)) importDigests.add(digest)
      for (const digest of localDataImportDigests(entry.after)) importDigests.add(digest)
    }
    const catalogs = availableCatalogRecords
      .filter((record) => (
        catalogKeys.has(record.key) ||
        importDigests.has(/^sha256:([0-9a-f]{64})$/.exec(record.checksum)?.[1] ?? '')
      ))
      .map((record) => isBundledCatalog(record.snapshot) ? record.snapshot : cloneJson(record.snapshot))
    const availableCatalogKeys = new Set(catalogs.map((catalog) => catalogKey(catalog)))
    const roots = [localData, ...history.flatMap(entry => [entry.before, entry.after])]
    const unavailableCompositions = new Set([...unavailableModCatalogKeys(roots, catalogs), ...roots.flatMap(root => [...publicUnavailableCatalogKeys(root)])])
    if (Array.from(catalogKeys).some((key) => !availableCatalogKeys.has(key) && !withdrawnCatalogKey(key) && !unavailableCompositions.has(key))) {
      throw new AppDataError('storage-failure', 'The planner data references catalog data that is missing locally', {
        recoverable: true,
      })
    }
    const digests = referencedSourceDigests(localData, history, catalogs)
    const evidence = captured.evidenceRecords.filter((record) => digests.has(record.sourceDigest)).map(cloneJson)
    const evidenceDigests = new Set(evidence.map((record) => record.sourceDigest))
    const sources = captured.sourceRecords.filter((source) => digests.has(source.digest) || evidenceDigests.has(source.digest))
    const sourceDigests = new Set(sources.map((source) => source.digest))
    const missingSourceDigest = Array.from(digests).find((digest) => !sourceDigests.has(digest))
    if (missingSourceDigest) {
      throw new AppDataError('storage-failure', 'The planner data references source bytes that are missing locally', {
        recoverable: true,
        details: { sourceDigest: missingSourceDigest },
      })
    }
    const missingEvidenceSource = evidence.find((record) => !sourceDigests.has(record.sourceDigest))
    if (missingEvidenceSource) {
      throw new AppDataError('storage-failure', 'Retained evidence references source bytes that are missing locally', {
        recoverable: true,
        details: { evidenceId: missingEvidenceSource.id },
      })
    }
    return {
      payload: {
        localData,
        lineage: captured.lineage,
        catalogs: catalogs.filter(catalog => !isBundledCatalog(catalog)),
        bundledCatalogs: [...catalogs.filter(isBundledCatalog).map(catalog => ({ id: catalog.id, revisionId: catalog.revisionId, checksum: catalog.checksum })), ...WITHDRAWN_CATALOGS.filter(receipt => catalogKeys.has(catalogKey(receipt)) && !availableCatalogKeys.has(catalogKey(receipt)))],
        evidence,
        history,
      },
      sources,
    }
  }
  const { history: retainedHistory, content: backupContent, payloadBytes } = selectBackupHistory(captured.history, payloadFor)
  const { sources } = backupContent
  const sourceEntries: Record<string, Uint8Array> = {}
  const sourceManifest = sources.map((source, index) => {
    const path = `sources/${index.toString().padStart(4, '0')}.bin`
    sourceEntries[path] = Uint8Array.from(source.bytes)
    return {
      id: source.id,
      digest: source.digest,
      filename: source.filename,
      mediaType: source.mediaType,
      format: source.format,
      importedAt: source.importedAt,
      path,
      size: source.bytes.byteLength,
    }
  })
  const exportedAt = nowTimestamp()
  const manifest: NativeBackupManifest = {
    format: 'crykit-backup',
    formatVersion: NATIVE_BACKUP_FORMAT_VERSION,
    exportedAt,
    payload: 'bundle.json',
    sources: sourceManifest,
    history: {
      stored: captured.history.length,
      exported: retainedHistory.length,
      truncated: retainedHistory.length !== captured.history.length,
    },
  }
  const manifestBytes = textBytes(manifest)
  parseBoundedJson(manifestBytes, 'generated backup manifest')
  parseBoundedJson(payloadBytes, 'generated backup payload', NATIVE_BACKUP_JSON_LIMITS)
  const backup = zipReadableByImporter({
    'manifest.json': manifestBytes,
    'bundle.json': payloadBytes,
    ...sourceEntries,
  })
  inspectZip(backup, NATIVE_BACKUP_ARCHIVE_LIMITS)
  await buildImportPreview(backup, 'generated-native-backup.zip')
  return backup
}

export async function previewImport(bytes: Uint8Array, filename: string): Promise<ImportPreview> {
  return buildImportPreview(bytes, filename)
}

export async function sourceDigest(bytes: Uint8Array): Promise<string> {
  return sha256(bytes)
}
