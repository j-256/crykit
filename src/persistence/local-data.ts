import { mergeCorrections } from '../domain/corrections'
import { loadCorrections, saveCorrections } from './corrections'
import { BUNDLED_CATALOGS, DEFAULT_CATALOG } from '../catalog/bundled'
import { NATIVE_BACKUP_FORMAT_VERSION } from '../interchange/native-schema'
import { createSampleLocalData } from '../domain/sample-data'
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
import { validateNativeLocalDataGraph } from '../interchange/native'
import { composeModCatalog, compactModCatalog, expandModCatalogs, modCatalogForPin, modCatalogRevision } from '../domain/mod-layers'
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
  type LocalDataRecord,
} from './database'
import { NATIVE_BACKUP_ARCHIVE_LIMITS, inspectZip } from '../interchange/zip'

const LOCAL_DATA_RECORD_KEY = 'local-data-record'
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

function catalogKey(snapshot: CatalogSnapshot): string {
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

function jsonEqual(left: unknown, right: unknown): boolean {
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

async function removePersistedBundledCatalogs(database: CryKitDatabase): Promise<void> {
  await database.catalogs.bulkDelete([...BUNDLED_CATALOG_KEYS])
}

async function initializeStarterRecord(database: CryKitDatabase): Promise<LocalDataRecord> {
  return database.transaction('rw', database.localDatas, async () => {
    const active = await database.localDatas.get(LOCAL_DATA_RECORD_KEY)
    if (active) return active
    const existing = await database.localDatas.orderBy('updatedAt').last()
    if (existing) return existing
    const localData = createSampleLocalData(DEFAULT_CATALOG)
    validateLocalDataForStorage(localData, BUNDLED_CATALOGS)
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

function catalogReferences(localData: LocalData): Set<string> {
  const keys = new Set<string>()
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
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
    for (const nested of Object.values(record)) visit(nested)
  }
  visit(localData)
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

async function loadedDataForRecord(database: CryKitDatabase, record: LocalDataRecord): Promise<LoadedLocalData> {
  const keys = catalogReferences(record.localData)
  const digests = localDataImportDigests(record.localData)
  const catalogRecords = (await database.catalogs.toArray()).filter(
    (candidate) => !BUNDLED_CATALOG_KEYS.has(candidate.key) && (keys.has(candidate.key) || digests.has(/^sha256:([0-9a-f]{64})$/.exec(candidate.checksum)?.[1] ?? '')),
  )
  for (const catalog of [...BUNDLED_CATALOGS, ...catalogRecords.map(record => record.snapshot)]) {
    const digest = /^sha256:(.+)$/.exec(catalog.checksum)?.[1]
    if (digest) digests.add(digest)
  }
  const evidence = digests.size > 0
    ? (await database.evidence.toArray()).filter((record) => digests.has(record.sourceDigest))
    : []
  const canUndo = Boolean(await database.history
    .where('[localDataId+nextRevision]')
    .equals([record.localData.id, record.revision])
    .first())
  return {
    localData: cloneJson(record.localData),
    lineage: cloneJson(record.lineage),
    catalogs: expandModCatalogs([...BUNDLED_CATALOGS, ...catalogRecords.map((catalog) => cloneJson(catalog.snapshot))]),
    evidence: evidence.map(cloneJson),
    revision: record.revision,
    canUndo,
  }
}

export async function loadLocalData(): Promise<LoadedLocalData> {
  const database = getDatabase()
  try {
    await removePersistedBundledCatalogs(database)
    const record = await resolveLocalDataRecord(database)
    return await loadedDataForRecord(database, record)
  } catch (error) {
    throw asAppDataError(error, {
      code: 'storage-failure',
      userMessage: 'The local planner data could not be loaded',
      recoverable: true,
    })
  }
}

function changedLocalData(before: LocalData, proposed: LocalData, command: string, timestamp: Timestamp): LocalData {
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
    ...cloneJson(proposed),
    id: before.id,
    revision: nextRevision,
    createdAt: before.createdAt,
    updatedAt: timestamp,
    changes: [...before.changes, change].slice(-MAX_LOCAL_DATA_CHANGES),
  }
}

function localDataForSave(before: LocalData, proposed: LocalData, expectedRevision: number, timestamp: Timestamp): {
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

function historyEntry(before: LocalData, after: LocalData, command: string, timestamp: Timestamp): PersistedHistoryEntry {
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

export async function prepareModCatalogs(localData: LocalData, availableCatalogs: readonly CatalogSnapshot[]): Promise<readonly CatalogSnapshot[]> {
  const composed: CatalogSnapshot[] = []
  for (const gameSetup of Object.values(localData.gameSetups)) {
    if (!gameSetup.modComposition || modCatalogForPin(availableCatalogs, { catalogId: gameSetup.modComposition.baseline.catalogId, catalogRevisionId: gameSetup.catalogLock[gameSetup.modComposition.baseline.catalogId]! })) continue
    const origin = Object.values(localData.gameSetups).find(value => modCatalogRevision(value.id) === gameSetup.catalogLock[gameSetup.modComposition!.baseline.catalogId])
    if (!origin?.modComposition) throw new AppDataError('schema-mismatch', 'The effective mod catalog has no originating Game Setup')
    if (composed.some(value => value.revisionId === modCatalogRevision(origin.id))) continue
    const catalog = composeModCatalog(origin, availableCatalogs)!
    composed.push({ ...catalog, checksum: `composition:sha256:${await sha256(new TextEncoder().encode(canonicalJson(catalog)))}` })
  }
  return expandModCatalogs(composed.length ? [...availableCatalogs, ...composed] : availableCatalogs)
}

export async function saveLocalDataWithStatus(localData: LocalData, expectedRevision: number): Promise<LocalDataWriteResult> {
  const database = getDatabase()
  let result: LocalDataWriteResult | undefined
  try {
    const availableCatalogs = [...BUNDLED_CATALOGS, ...(await database.catalogs.toArray()).map(record => record.snapshot)]
    const preparedCatalogs = await prepareModCatalogs(localData, availableCatalogs)
    const originalKeys = new Set(availableCatalogs.map(catalogKey))
    const composed = preparedCatalogs.filter(catalog => !originalKeys.has(catalogKey(catalog))).map(compactModCatalog)
    await database.transaction('rw', database.localDatas, database.history, database.catalogs, async () => {
      const record = await database.localDatas.get(LOCAL_DATA_RECORD_KEY)
      if (!record) throw new AppDataError('not-found', 'The planner data no longer exists', { recoverable: true })
      if (record.revision !== expectedRevision) {
        throw new AppDataError('revision-conflict', 'This planner data changed in another tab. Reload before saving', {
          recoverable: true,
          details: { expectedRevision, actualRevision: record.revision },
        })
      }
      const timestamp = nowTimestamp()
      const prepared = localDataForSave(record.localData, localData, expectedRevision, timestamp)
      const saved = prepared.localData
      await assertCatalogsImmutable(database, composed)
      if (composed.length) await database.catalogs.bulkPut(composed.map(toCatalogRecord))
      validateLocalDataForStorage(saved, await storedCatalogsForLocalData(database, saved))
      await database.localDatas.put({
        ...record,
        revision: saved.revision,
        updatedAt: saved.updatedAt,
        localData: saved,
      })
      await database.history.add(historyEntry(record.localData, saved, prepared.command, timestamp))
      result = { localData: saved, canUndo: await trimHistory(database, saved.id) }
    })
  } catch (error) {
    throw asAppDataError(error, {
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
): Promise<LoadedLocalData> {
  if (preview.errors.length > 0) {
    throw new AppDataError('schema-mismatch', 'The import preview contains errors and cannot be applied', {
      recoverable: true,
    })
  }
  const database = getDatabase()
  const mode = options.mode ?? 'replace'
  let committed = false
  try {
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
        assertStarterCatalogIdentity(preview.proposed.catalogs)
        const target = await database.localDatas.get(LOCAL_DATA_RECORD_KEY)
        if (!target) throw new AppDataError('not-found', 'The local planner data no longer exists', { recoverable: true })
        if (options.targetLocalDataId !== undefined && options.targetLocalDataId !== target.localData.id) {
          throw new AppDataError('revision-conflict', 'The import target changed. Reload before importing', { recoverable: true })
        }
        if (options.expectedRevision !== undefined && options.expectedRevision !== target.revision) {
          throw new AppDataError('revision-conflict', 'The local planner data changed. Reload before importing', { recoverable: true })
        }
        if (mode === 'add-reference') {
          if (preview.detectedFormat !== 'crystal-edit-json-1' || preview.counts.personal || preview.counts.mixed) {
            throw new AppDataError('import-conflict', 'Only a reference-only Crystal Edit preview can be added to existing planner data', { recoverable: true })
          }
          const receiptsAlreadyImported = Object.values(preview.proposed.localData.importReceipts)
          if (receiptsAlreadyImported.length > 0 && receiptsAlreadyImported.every(candidate => target.localData.importReceipts[candidate.id]?.sourceIdentity === candidate.sourceIdentity)) {
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
          await putCandidateData(database, { ...preview.proposed, catalogs, sources })
          const timestamp = nowTimestamp()
          const receipts = Object.fromEntries(Object.entries(preview.proposed.localData.importReceipts).map(([id, receipt]) => [id, { ...receipt, importedAt: timestamp, localDataRevision: target.revision + 1 }]))
          const updated = changedLocalData(target.localData, { ...target.localData, importReceipts: { ...target.localData.importReceipts, ...receipts } }, 'add-reference-catalog', timestamp)
          const storedCatalogs = [
            ...BUNDLED_CATALOGS,
            ...(await database.catalogs.toArray())
              .filter(record => !BUNDLED_CATALOG_KEYS.has(record.key))
              .map(record => record.snapshot),
          ]
          validateNativeLocalDataGraph(updated, storedCatalogs)
          await database.localDatas.put({ ...target, revision: updated.revision, updatedAt: timestamp, localData: updated })
          await database.history.add(historyEntry(target.localData, updated, 'add-reference-catalog', timestamp))
          await database.imports.put({ id: preview.id, sourceDigest: preview.sourceDigest, localDataId: target.localData.id, importedAt: timestamp })
          committed = true
          return
        }
        if (options.restoreCorrections && preview.proposed.corrections) {
          const local = await loadCorrections()
          await saveCorrections(mergeCorrections(local.entries, preview.proposed.corrections.entries), local.revision)
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
    throw asAppDataError(error, {
      code: 'storage-failure',
      userMessage: 'The import could not be applied. Existing local data is unchanged',
      recoverable: true,
    })
  }
  if (!committed) throw new AppDataError('storage-failure', 'The import did not complete', { recoverable: true })
  const loaded = await loadLocalData()
  notify({ localDataId: loaded.localData.id, revision: loaded.revision, reason: 'import' })
  return loaded
}

export async function undoLocalDataWithStatus(expectedRevision: number): Promise<LocalDataWriteResult> {
  const database = getDatabase()
  let result: LocalDataWriteResult | undefined
  try {
    await database.transaction('rw', database.localDatas, database.history, database.catalogs, async () => {
      const record = await database.localDatas.get(LOCAL_DATA_RECORD_KEY)
      if (!record) throw new AppDataError('not-found', 'The planner data no longer exists', { recoverable: true })
      if (record.revision !== expectedRevision) {
        throw new AppDataError('revision-conflict', 'This planner data changed in another tab. Reload before undoing', {
          recoverable: true,
        })
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
      result = { localData: restored, canUndo: await trimHistory(database, restored.id) }
    })
  } catch (error) {
    throw asAppDataError(error, {
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

function zipReadableByImporter(entries: Readonly<Record<string, Uint8Array>>): Uint8Array {
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

function referencedSourceDigests(...values: readonly unknown[]): ReadonlySet<string> {
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
    for (const entry of Object.values(value as Readonly<Record<string, unknown>>)) visit(entry)
  }
  for (const value of values) visit(value)
  return digests
}

export async function exportBackup(localDataOverride?: LocalData): Promise<Uint8Array> {
  const database = getDatabase()
  try {
    const captured = await database.transaction(
      'r',
      [database.localDatas, database.catalogs, database.evidence, database.sources, database.history, database.meta],
      async () => {
        const record = await database.localDatas.get(LOCAL_DATA_RECORD_KEY)
        if (!record) throw new AppDataError('not-found', 'The planner data no longer exists', { recoverable: true })
        if (localDataOverride && localDataOverride.id !== record.localData.id) {
          throw new AppDataError('schema-mismatch', 'The recovery draft belongs to different planner data', {
            recoverable: true,
          })
        }
        let localData = cloneJson(record.localData)
        const history = (await database.history.where('localDataId').equals(record.localData.id).sortBy('nextRevision')).map(cloneJson)
        if (localDataOverride && !jsonEqual(localDataOverride, record.localData)) {
          const timestamp = nowTimestamp()
          const recoveryDraft = { ...cloneJson(localDataOverride), id: record.localData.id }
          localData = changedLocalData(record.localData, recoveryDraft, 'recovery-draft-export', timestamp)
          history.push(historyEntry(record.localData, localData, 'recovery-draft-export', timestamp))
        }
        return {
          localData,
          corrections: await loadCorrections(),
          lineage: cloneJson(record.lineage),
          history,
          catalogRecords: await database.catalogs.toArray(),
          evidenceRecords: await database.evidence.toArray(),
          sourceRecords: await database.sources.toArray(),
        }
      },
    )
    const availableCatalogRecords = (await prepareModCatalogs(captured.localData, [
      ...BUNDLED_CATALOGS,
      ...captured.catalogRecords.filter(record => !BUNDLED_CATALOG_KEYS.has(record.key)).map(record => record.snapshot),
    ])).map(compactModCatalog).map(toCatalogRecord)
    const payloadFor = (history: readonly PersistedHistoryEntry[]) => {
      const localData = history.length === 0 && captured.localData.changes.length > 0
        ? { ...captured.localData, changes: [] }
        : captured.localData
      const catalogKeys = catalogReferences(localData)
      for (const entry of captured.corrections.entries) {
        const key = catalogSnapshotKey(entry.target.catalogId, entry.target.catalogRevisionId)
        if (availableCatalogRecords.some(record => record.key === key)) catalogKeys.add(key)
      }
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
      if (Array.from(catalogKeys).some((key) => !availableCatalogKeys.has(key))) {
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
          ...(captured.corrections.entries.length ? { corrections: captured.corrections } : {}),
          localData,
          lineage: captured.lineage,
          catalogs: catalogs.filter(catalog => !isBundledCatalog(catalog)),
          bundledCatalogs: catalogs.filter(isBundledCatalog).map(catalog => ({ id: catalog.id, revisionId: catalog.revisionId, checksum: catalog.checksum })),
          evidence,
          history,
        },
        sources,
      }
    }
    let retainedHistory = [...captured.history]
    let backupContent = payloadFor(retainedHistory)
    let payloadBytes = textBytes(backupContent.payload)
    while (payloadBytes.byteLength > MAX_BACKUP_PAYLOAD_BYTES && retainedHistory.length > 0) {
      retainedHistory = retainedHistory.slice(1)
      backupContent = payloadFor(retainedHistory)
      payloadBytes = textBytes(backupContent.payload)
    }
    if (payloadBytes.byteLength > MAX_BACKUP_PAYLOAD_BYTES) {
      throw new AppDataError('storage-failure', 'The current planner data exceeds the safe backup size limit', {
        recoverable: true,
        details: { limit: MAX_BACKUP_PAYLOAD_BYTES },
      })
    }
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
  } catch (error) {
    throw asAppDataError(error, {
      code: 'storage-failure',
      userMessage: 'The local backup could not be created',
      recoverable: true,
    })
  }
}

export async function previewImport(bytes: Uint8Array, filename: string): Promise<ImportPreview> {
  return buildImportPreview(bytes, filename)
}

export async function sourceDigest(bytes: Uint8Array): Promise<string> {
  return sha256(bytes)
}
