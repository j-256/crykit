import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { prepareGuestRestorePlanner, requirePreparedGuestPlanner } from '../workspace/guest-planner'
import type { WorkspacePlannerState } from '../workspace/documents'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersonalDefinition, requirePlaythrough, resolveDefinition, setAcquisitionProgress } from '../domain'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { createSampleLocalData } from '../domain/sample-data'
import { NativeCatalogSnapshotSchema } from '../interchange/native-schema'
import { decodeSharePayload } from '../interchange/share'
import { TEAM_SIZE } from '../domain/scenarios'
import type { CatalogRef } from '../domain/types'
import starterBuildReferenceNames from './starter-build-reference-names.json' with { type: 'json' }
import starterBuildShares from './starter-build-shares.json' with { type: 'json' }
import { CryKitDatabase, setDatabaseForTests } from './database'
import {
  commitImport,
  commitModSetup,
  subscribeLocalData,
  undoLocalData,
  exportBackup,
  loadLocalData,
  previewImport,
  prepareModCatalogs,
  saveLocalData,
  saveLocalDataWithStatus,
  undoLocalDataWithStatus,
  validateLocalDataForStorage,
} from './local-data'

// Source availability is a fixture; package additions must not change saved-reference coverage
vi.mock('../catalog/mod-library-metadata', () => ({ BUNDLED_MOD_LIBRARY: [], STARTER_MOD_PROJECT_IDS: [] }))

describe('local planner persistence', () => {
  let database: CryKitDatabase

  beforeEach(() => {
    database = new CryKitDatabase(`test-${crypto.randomUUID()}`)
    setDatabaseForTests(database)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    setDatabaseForTests(undefined)
    await database.delete()
  })

  it('preserves marker-free latest fallback physical keys and canonical precedence', async () => {
    const first = createSampleLocalData(DEFAULT_CATALOG), later = { ...first, updatedAt: '2030-01-01T00:00:00.000Z' as typeof first.updatedAt }
    const root = (id: string, localData: typeof first) => ({ id, localData, revision: localData.revision, updatedAt: localData.updatedAt, lineage: { rootLocalDataId: localData.id } })
    await database.localDatas.bulkAdd([root('older', first), root('latest', later)])
    expect((await loadLocalData(database)).localData).toEqual(later)
    expect(await database.localDatas.get('local-data-record')).toBeUndefined()
    await database.localDatas.add(root('local-data-record', first))
    expect((await loadLocalData(database)).localData).toEqual(first)
  })

  it('round-trips travel acquisitions through local persistence and native backups', async () => {
    const loaded = await loadLocalData()
    const entity = DEFAULT_CATALOG.entities['base:item:49']!
    const subject = { kind: 'catalog' as const, catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: entity.id }
    const changed = setAcquisitionProgress(loaded.localData, { subject, displayName: entity.name, acquired: true, expectedRevision: loaded.revision })
    await saveLocalData(changed, loaded.revision)
    const reloaded = await loadLocalData()
    const record = Object.values(requirePlaythrough(reloaded.localData).progress).find(record => record.displayName === entity.name)!
    expect(record.collection).toEqual({ state: 'known', value: true })
    const preview = await previewImport(await exportBackup(), 'travel.zip')
    expect(preview.proposed.localData.playthroughs).toEqual(reloaded.localData.playthroughs)
    expect(preview.proposed.catalogs.some(catalog => catalog.revisionId === DEFAULT_CATALOG.revisionId && catalog.entities[entity.id]?.name === entity.name)).toBe(true)
  })

  it('initializes one planner root with a selected sample Playthrough', async () => {
    const loaded = await loadLocalData()
    const playthrough = requirePlaythrough(loaded.localData)

    expect(Object.keys(playthrough.characters)).toHaveLength(TEAM_SIZE)
    expect(Object.keys(playthrough.inventory).length).toBeGreaterThan(0)
    expect(loaded.canUndo).toBe(false)
    expect(await database.localDatas.count()).toBe(1)
  })

  it('adds the supplied shared Builds alongside the original sample team', async () => {
    const { localData, catalogs, canUndo } = await loadLocalData()
    const titles = ['Judite', 'Marco', 'Prudence', 'Marcy']
    expect(Object.values(localData.builds).map(build => build.title)).toEqual(expect.arrayContaining(titles))
    expect(Object.values(localData.builds)).toHaveLength(TEAM_SIZE + starterBuildShares.length)
    expect(Object.values(requirePlaythrough(localData).scenarios)).toHaveLength(1)
    expect(localData.revision).toBe(0)
    expect(canUndo).toBe(false)

    for (const encoded of starterBuildShares) {
      const source = decodeSharePayload(encoded)
      const sourceRevision = Object.values(source.records.buildRevisions)[0]!
      const title = source.title === 'Brawler build' ? 'Prudence' : source.title
      const build = Object.values(localData.builds).find(build => build.title === title)!
      const revision = localData.buildRevisions[build.latestRevisionId!]!
      const setup = localData.gameSetups[revision.gameSetupRevisionId]!
      const sourceSetup = source.records.gameSetups[sourceRevision.gameSetupRevisionId]!
      expect(build.tags).toContain('sample')
      // Shared-copy IDs change the effective revision; selected display receipts supplement the exact checkpoint
      const copiedContent = JSON.parse(JSON.stringify({ ...sourceRevision.content, referenceNames: (starterBuildReferenceNames as Record<string, { referenceNames: readonly unknown[] }>)[source.title]!.referenceNames }, (_key, entry) => entry && typeof entry === 'object' && entry.kind === 'catalog' ? { ...entry, catalogRevisionId: setup.catalogLock[entry.catalogId] } : entry))
      expect(revision.content).toEqual(copiedContent)
      expect(setup.modComposition).toEqual(sourceSetup.modComposition)
      if (setup.modComposition?.layers.length) {
        expect(revision.content.primaryClass?.kind).toBe('catalog')
        const primaryClass = revision.content.primaryClass as CatalogRef
        const definition = resolveDefinition(localData, catalogs, primaryClass)
        // Exact native receipts recover unchanged facts even when the modded learning tree is unavailable
        if (primaryClass.entityId.startsWith('base:')) {
          const display = revision.content.referenceNames!.find(value => value.ref.entityId === primaryClass.entityId)!
          expect(definition).toMatchObject({ id: primaryClass.entityId, kind: 'class', name: display.name })
          if (title === 'Marco') expect(definition!.fields['Class learn tree']).toMatchObject({ state: 'unknown' })
        } else expect(definition).toBeUndefined()
      }
    }

    const reloaded = await loadLocalData()
    expect(reloaded.localData.builds).toEqual(localData.builds)
    const backup = await previewImport(await exportBackup(), 'starter-builds.zip')
    expect(backup.proposed.localData.builds).toEqual(localData.builds)
    expect(backup.proposed.localData.buildRevisions).toEqual(localData.buildRevisions)
    expect(backup.proposed.localData.gameSetups).toEqual(localData.gameSetups)
  })

  it('keeps catalog contents stable across planner changes without new mod compositions', async () => {
    const loaded = await loadLocalData()
    const changed = createPersonalDefinition(loaded.localData, { kind: 'item', name: 'Synthetic stable catalog fixture', expectedRevision: loaded.revision })

    expect(await prepareModCatalogs(changed, loaded.catalogs)).toEqual(loaded.catalogs)
    const saved = await saveLocalData(changed, loaded.revision)
    expect(await prepareModCatalogs(saved, loaded.catalogs)).toEqual(loaded.catalogs)
  })

  it('reuses only frozen catalog shapes and checks new snapshots and references on every save', async () => {
    const loaded = await loadLocalData()
    const catalog = loaded.catalogs[0]!
    const entity = Object.values(catalog.entities)[0]!
    const parse = vi.spyOn(NativeCatalogSnapshotSchema, 'safeParse')

    expect(Object.isFrozen(catalog)).toBe(true)
    expect(Object.isFrozen(entity.fields)).toBe(true)
    expect(Reflect.set(entity, 'name', 'Synthetic mutation')).toBe(false)
    validateLocalDataForStorage(loaded.localData, loaded.catalogs)
    validateLocalDataForStorage(loaded.localData, loaded.catalogs)
    expect(parse).not.toHaveBeenCalled()

    const invalidCatalog = { ...catalog, entities: { ...catalog.entities, [entity.id]: { ...entity, name: 0 as unknown as string } } }
    expect(() => validateLocalDataForStorage(loaded.localData, [invalidCatalog, ...loaded.catalogs.slice(1)])).toThrow('unsupported shape')
    expect(parse).toHaveBeenCalledWith(invalidCatalog)

    const invalidData = { ...loaded.localData, planningGameSetupRevisionId: 'gameSetup:missing' as typeof loaded.localData.planningGameSetupRevisionId }
    expect(() => validateLocalDataForStorage(invalidData, loaded.catalogs)).toThrow()
  })

  it('uses the same planner root for concurrent first loads', async () => {
    const loaded = await Promise.all(Array.from({ length: 4 }, () => loadLocalData()))

    expect(new Set(loaded.map(entry => entry.localData.id))).toHaveLength(1)
    expect(loaded.every(entry => JSON.stringify(entry.localData) === JSON.stringify(loaded[0]?.localData))).toBe(true)
    expect(await database.localDatas.count()).toBe(1)
  })

  it('restores the bundled baseline through save, rollback, and exact backup pins', async () => {
    const catalog = DEFAULT_CATALOG
    const previous = createSampleLocalData(catalog)
    await database.localDatas.add({ id: 'local-data-record', revision: previous.revision, updatedAt: previous.updatedAt, localData: previous, lineage: { rootLocalDataId: previous.id } })
    expect(await database.catalogs.count()).toBe(0)
    const loaded = await loadLocalData()
    expect(loaded.localData).toEqual(previous)
    expect(loaded.catalogs).toContainEqual(catalog)
    expect(() => validateLocalDataForStorage(loaded.localData, loaded.catalogs)).not.toThrow()
    const changed = createPersonalDefinition(loaded.localData, { kind: 'item', name: 'Synthetic upgrade fixture', expectedRevision: loaded.revision })
    vi.spyOn(database.history, 'add').mockRejectedValueOnce(new DOMException('Synthetic full storage', 'QuotaExceededError'))
    await expect(saveLocalData(changed, loaded.revision)).rejects.toMatchObject({ code: 'storage-failure' })
    expect((await loadLocalData()).localData).toEqual(previous)
    const saved = await saveLocalData(changed, loaded.revision)
    expect(saved.gameSetups).toEqual(previous.gameSetups)
    expect(saved.playthroughs).toEqual(previous.playthroughs)
    expect(saved.builds).toEqual(previous.builds)
    const preview = await previewImport(await exportBackup(), 'synthetic-upgrade-backup.zip')
    expect(preview.proposed.catalogs).toContainEqual(catalog)
    const restored = await commitImport(preview, { mode: 'replace', targetLocalDataId: saved.id, expectedRevision: saved.revision })
    expect(restored.localData.gameSetups).toEqual(previous.gameSetups)
    expect(restored.localData.playthroughs).toEqual(previous.playthroughs)
    expect(restored.localData.builds).toEqual(previous.builds)
    expect(restored.catalogs).toContainEqual(catalog)
  })

  it('saves domain revisions with optimistic locking', async () => {
    const loaded = await loadLocalData()
    const changed = createPersonalDefinition(loaded.localData, { kind: 'item', name: 'Synthetic Buckler', expectedRevision: loaded.revision })
    const saved = await saveLocalData(changed, loaded.revision)

    expect(saved.personalDefinitions).toEqual(expect.objectContaining(changed.personalDefinitions))
    expect(saved.revision).toBe(changed.revision)
    await expect(saveLocalData(saved, loaded.revision)).rejects.toMatchObject({ code: 'revision-conflict', recoverable: true })
  })

  it('reports and restores retained undo checkpoints', async () => {
    const loaded = await loadLocalData()
    const changed = createPersonalDefinition(loaded.localData, { kind: 'item', name: 'Undo fixture', expectedRevision: loaded.revision })
    const saved = await saveLocalDataWithStatus(changed, loaded.revision)

    expect(saved.canUndo).toBe(true)
    const undone = await undoLocalDataWithStatus(saved.localData.revision)
    expect(undone.localData.personalDefinitions).toEqual(loaded.localData.personalDefinitions)
    expect(undone.localData.revision).toBe(saved.localData.revision + 1)
  })

  it('round-trips the complete planner root through a native backup', async () => {
    const loaded = await loadLocalData()
    const preview = await previewImport(await exportBackup(), 'planner.zip')

    expect(preview.detectedFormat).toBe('native-backup-2.1.0')
    expect(preview.proposed.localData.playthroughs).toEqual(loaded.localData.playthroughs)
    expect(preview.proposed.localData.gameSetups).toEqual(loaded.localData.gameSetups)
    expect(preview.proposed.localData.builds).toEqual(loaded.localData.builds)
  })

  it('replaces the planner root transactionally from a native backup', async () => {
    const loaded = await loadLocalData()
    const changed = createPersonalDefinition(loaded.localData, { kind: 'item', name: 'Replacement fixture', expectedRevision: loaded.revision })
    const saved = await saveLocalData(changed, loaded.revision)
    const preview = await previewImport(await exportBackup(), 'replacement.zip')
    const committed = await commitImport(preview, { mode: 'replace', targetLocalDataId: saved.id, expectedRevision: saved.revision })

    expect(Object.values(committed.localData.personalDefinitions).some(definition => definition.name === 'Replacement fixture')).toBe(true)
    expect(await database.localDatas.count()).toBe(1)
  })

  it('exports a recovery draft without mutating persisted data', async () => {
    const loaded = await loadLocalData()
    const draft = createPersonalDefinition(loaded.localData, { kind: 'item', name: 'Recovery fixture', expectedRevision: loaded.revision })
    const preview = await previewImport(await exportBackup(draft), 'recovery.zip')

    expect(Object.values(preview.proposed.localData.personalDefinitions).some(definition => definition.name === 'Recovery fixture')).toBe(true)
    expect((await loadLocalData()).localData.personalDefinitions).toEqual(loaded.localData.personalDefinitions)
  })

  it('keeps highly compressible guest backups readable without changing saved data', async () => {
    const loaded = await loadLocalData()
    let draft = loaded.localData
    for (const marker of ['A', 'B', 'C', 'D']) draft = createPersonalDefinition(draft, { kind: 'item', name: marker.repeat(64_000) })
    const saved = await saveLocalData(draft, loaded.revision)
    const preview = await previewImport(await exportBackup(), 'compressible-guest.zip')
    expect(preview.proposed.localData.personalDefinitions).toEqual(saved.personalDefinitions)
    expect((await loadLocalData()).localData).toEqual(saved)
  })

  it('rejects invalid graphs before storage', async () => {
    const loaded = await loadLocalData()
    const playthrough = requirePlaythrough(loaded.localData)
    const invalid = {
      ...loaded.localData,
      playthroughs: {
        ...loaded.localData.playthroughs,
        [playthrough.id]: { ...playthrough, activeScenarioId: 'missing' },
      },
    } as typeof loaded.localData

    expect(() => validateLocalDataForStorage(invalid, loaded.catalogs)).toThrow()
    await expect(saveLocalDataWithStatus(invalid, loaded.revision)).rejects.toMatchObject({ code: 'schema-mismatch', recoverable: true })
  })
})


// These cold-call fixtures use native requests, independent of CryKit's opening and migration implementation
const openingTables = { localDatas: 'id, revision, updatedAt', catalogs: 'key, id, revisionId, checksum', evidence: 'id, sourceDigest, group', sources: 'id, digest, format', history: 'id, localDataId, [localDataId+nextRevision]', imports: 'id, sourceDigest, localDataId', meta: 'key' }
function nativeResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
}
async function coldSnapshot(name: string) {
  let absent = false
  const request = indexedDB.open(name)
  request.onupgradeneeded = () => { absent = true; request.transaction!.abort() }
  const db = await nativeResult(request).catch(error => { if (absent) return undefined; throw error })
  if (!db) return { exists: false }
  try {
    return { exists: true, version: db.version, stores: await Promise.all(Array.from(db.objectStoreNames).sort().map(async name => {
      const store = db.transaction(name, 'readonly').objectStore(name)
      const keys = nativeResult(store.getAllKeys()), rows = nativeResult(store.getAll())
      return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: Array.from(store.indexNames).sort().map(name => { const index = store.index(name); return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry } }), keys: await keys, rows: await rows }
    })) }
  } finally { db.close() }
}
const CURRENT_COLD_NATIVE_VERSION = 70
const FUTURE_COLD_NATIVE_VERSION = 80
async function coldFixture(kind: string) {
  const name = `cold-required-${crypto.randomUUID()}`, localData = createSampleLocalData(DEFAULT_CATALOG)
  const source: WorkspacePlannerState = { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [DEFAULT_CATALOG], history: [], sources: [], evidence: [] }
  const prepared = requirePreparedGuestPlanner(prepareGuestRestorePlanner(source, source, 'replace'))
  if (kind !== 'absent') {
    const request = indexedDB.open(name, kind === 'future' ? FUTURE_COLD_NATIVE_VERSION : CURRENT_COLD_NATIVE_VERSION)
    request.onupgradeneeded = () => {
      for (const [name, definition] of Object.entries(openingTables)) {
        if (kind === 'missing store' && name === 'imports') continue
        const [keyPath, ...indexes] = definition.split(',').map(value => value.trim())
        const store = request.result.createObjectStore(name, { keyPath })
        for (const index of indexes) store.createIndex(index, index.startsWith('[') ? index.slice(1, -1).split('+') : index)
      }
      const tx = request.transaction!
      if (kind === 'extra index') tx.objectStore('meta').createIndex('extra', 'value')
      tx.objectStore('localDatas').put(prepared.record)
      tx.objectStore('meta').put(prepared.declaration)
      tx.objectStore('meta').put({ key: 'unrelated', value: '<script>inert</script>' })
      for (const row of prepared.planner.history) tx.objectStore('history').put(row)
      tx.objectStore('catalogs').put({ key: JSON.stringify([DEFAULT_CATALOG.id, DEFAULT_CATALOG.revisionId]), id: DEFAULT_CATALOG.id, revisionId: DEFAULT_CATALOG.revisionId, checksum: DEFAULT_CATALOG.checksum, snapshot: DEFAULT_CATALOG })
      tx.objectStore('sources').put({ id: 'unrelated-bytes', bytes: new Uint8Array([0, 128, 255]), buffer: new Uint8Array([255, 0]).buffer })
      if (kind === 'bad tuple') tx.objectStore('meta').delete(prepared.declaration.key)
      if (kind === 'bad graph') tx.objectStore('localDatas').put({ ...prepared.record, localData: { ...prepared.record.localData, selectedPlaythroughId: 'missing' } })
      if (kind === 'bad history') {
        const history = prepared.planner.history[0]!
        tx.objectStore('localDatas').put({ ...prepared.record, operativePlanner: { ...prepared.record.operativePlanner, checkpointIds: [history.id], undoable: true } })
        tx.objectStore('history').put({ ...history, before: { ...history.before, schemaVersion: 'unknown' } })
      }
      if (kind === 'bad catalog') tx.objectStore('catalogs').put({ key: 'broken', id: DEFAULT_CATALOG.id, revisionId: DEFAULT_CATALOG.revisionId, checksum: 'wrong', snapshot: DEFAULT_CATALOG })
    }
    const db = await nativeResult(request); db.close()
  }
  const preview = await previewImport(new TextEncoder().encode(JSON.stringify({ ID: 'cold-guard', Title: 'Cold guard', EditorVersion: 34, Items: [{ ID: 51, Name: 'Guard item' }] })), 'guard.json')
  expect(preview.errors).toEqual([])
  return { name, prepared, preview }
}
const coldOperations = ['load', 'save', 'mod setup', 'import', 'undo', 'export', 'save delegate', 'undo delegate'] as const
async function coldOperation(operation: typeof coldOperations[number], db: CryKitDatabase, fixture: Awaited<ReturnType<typeof coldFixture>>) {
  const { record } = fixture.prepared
  switch (operation) {
    case 'load': return loadLocalData(db)
    case 'save': return saveLocalDataWithStatus(record.localData, record.revision, db)
    case 'mod setup': return commitModSetup([fixture.preview], record.revision, false, db)
    case 'import': return commitImport(fixture.preview, { mode: 'add-reference', expectedRevision: record.revision }, db)
    case 'undo': return undoLocalDataWithStatus(record.revision, db)
    case 'export': return exportBackup(undefined, db)
    case 'save delegate': setDatabaseForTests(db); return saveLocalData(record.localData, record.revision)
    case 'undo delegate': setDatabaseForTests(db); return undoLocalData(record.revision)
  }
}

describe('cold required planner application boundaries', () => {
  it.each(['absent', 'missing store', 'extra index', 'future'])('normalizes all owning operations for %s while preserving native data and notifications', async kind => {
    const fixture = await coldFixture(kind), before = await coldSnapshot(fixture.name), notifications: unknown[] = []
    const unsubscribe = subscribeLocalData(value => notifications.push(value))
    try {
      for (const operation of coldOperations) {
        const db = new CryKitDatabase(fixture.name, { plannerFormatRequirement: 'journaled' })
        try {
          await expect(coldOperation(operation, db, fixture)).rejects.toMatchObject({ code: 'schema-mismatch', recoverable: true, userMessage: 'The journaled planner database cannot be opened safely. Keep your draft and reopen the workspace' })
        } finally { db.close(); setDatabaseForTests(undefined) }
        expect(await coldSnapshot(fixture.name)).toEqual(before)
      }
      expect(notifications).toEqual([])
    } finally { unsubscribe(); await nativeResult(indexedDB.deleteDatabase(fixture.name)) }
  })

  it('loads a genuine journal tuple on a cold admitted connection without mutating packaged records', async () => {
    const fixture = await coldFixture('valid'), before = await coldSnapshot(fixture.name)
    const db = new CryKitDatabase(fixture.name, { plannerFormatRequirement: 'journaled' })
    try {
      const loaded = await loadLocalData(db)
      expect(loaded.localData).toEqual(fixture.prepared.record.localData)
      expect(loaded.canUndo).toBe(false)
      expect(loaded.catalogs).toContainEqual(DEFAULT_CATALOG)
    } finally { db.close() }
    expect(await coldSnapshot(fixture.name)).toEqual(before)
    await nativeResult(indexedDB.deleteDatabase(fixture.name))
  })

  it.each(['bad tuple', 'bad graph', 'bad history', 'bad catalog'])('keeps %s in the existing transaction admission boundary after structural success', async kind => {
    const fixture = await coldFixture(kind), before = await coldSnapshot(fixture.name)
    const db = new CryKitDatabase(fixture.name, { plannerFormatRequirement: 'journaled' })
    try {
      await db.open()
      await expect(loadLocalData(db)).rejects.toMatchObject({ code: 'schema-mismatch' })
    } finally { db.close() }
    expect(await coldSnapshot(fixture.name)).toEqual(before)
    await nativeResult(indexedDB.deleteDatabase(fixture.name))
  })

  it('keeps missing native capability as a cold storage failure for all owning operations', async () => {
    const fixture = await coldFixture('valid'), before = await coldSnapshot(fixture.name), saved = Dexie.dependencies.indexedDB
    try {
      Dexie.dependencies.indexedDB = undefined as unknown as IDBFactory
      for (const operation of coldOperations) {
        const db = new CryKitDatabase(fixture.name, { plannerFormatRequirement: 'journaled' })
        try { await expect(coldOperation(operation, db, fixture)).rejects.toMatchObject({ code: 'storage-failure' }) }
        finally { db.close(); setDatabaseForTests(undefined) }
      }
    } finally { Dexie.dependencies.indexedDB = saved }
    expect(await coldSnapshot(fixture.name)).toEqual(before)
    await nativeResult(indexedDB.deleteDatabase(fixture.name))
  })
})

it.each(['absent', 'extra index'])('keeps later owning calls on a denied %s handle as storage failures', async kind => {
  const fixture = await coldFixture(kind), before = await coldSnapshot(fixture.name), notifications: unknown[] = []
  const unsubscribe = subscribeLocalData(value => notifications.push(value))
  try {
    for (const operation of coldOperations) {
      const nativeOpen = indexedDB.open.bind(indexedDB), requests: [string, number | undefined][] = []
      const observation = vi.spyOn(indexedDB, 'open').mockImplementation((name, version) => { requests.push([name, version]); return nativeOpen(name, version) })
      const db = new CryKitDatabase(fixture.name, { plannerFormatRequirement: 'journaled' })
      try {
        await expect(coldOperation(operation, db, fixture)).rejects.toMatchObject({ code: 'schema-mismatch', recoverable: true, userMessage: 'The journaled planner database cannot be opened safely. Keep your draft and reopen the workspace' })
        const later = await coldOperation(operation, db, fixture).catch(error => error)
        expect.soft(later, operation).toMatchObject({ code: 'storage-failure', recoverable: true })
        db.close()
        await expect(coldOperation(operation, db, fixture)).rejects.toMatchObject({ code: 'storage-failure', recoverable: true })
        expect(requests).toEqual([[fixture.name, CURRENT_COLD_NATIVE_VERSION]])
      } finally { observation.mockRestore(); db.close(); setDatabaseForTests(undefined) }
      expect(await coldSnapshot(fixture.name)).toEqual(before)
    }
    expect(notifications).toEqual([])
  } finally { unsubscribe(); await nativeResult(indexedDB.deleteDatabase(fixture.name)) }
})

it.each(['absent', 'extra index'])('preserves every original concurrent owning diagnosis for %s', async kind => {
  const fixture = await coldFixture(kind), before = await coldSnapshot(fixture.name), notifications: unknown[] = []
  const unsubscribe = subscribeLocalData(value => notifications.push(value))
  const nativeOpen = indexedDB.open.bind(indexedDB), requests: [string, number | undefined][] = []
  const observation = vi.spyOn(indexedDB, 'open').mockImplementation((name, version) => { requests.push([name, version]); return nativeOpen(name, version) })
  const db = new CryKitDatabase(fixture.name, { plannerFormatRequirement: 'journaled' })
  try {
    const outcomes = await Promise.allSettled(coldOperations.map(operation => coldOperation(operation, db, fixture)))
    for (const outcome of outcomes) expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'schema-mismatch', recoverable: true, userMessage: 'The journaled planner database cannot be opened safely. Keep your draft and reopen the workspace' } })
    expect(requests).toEqual([[fixture.name, CURRENT_COLD_NATIVE_VERSION]])
    expect(notifications).toEqual([])
  } finally { observation.mockRestore(); unsubscribe(); db.close(); setDatabaseForTests(undefined) }
  expect(await coldSnapshot(fixture.name)).toEqual(before)
  await nativeResult(indexedDB.deleteDatabase(fixture.name))
})

it('preserves pure validation precedence before capturing a denied handle', async () => {
  const fixture = await coldFixture('extra index'), db = new CryKitDatabase(fixture.name, { plannerFormatRequirement: 'journaled' })
  try {
    await expect(db.open()).rejects.toThrow()
    const observation = vi.spyOn(indexedDB, 'open')
    await expect(commitModSetup([fixture.preview], fixture.prepared.record.revision, true, db)).rejects.toMatchObject({ code: 'schema-mismatch', userMessage: 'Skipping mod selection cannot import sources' })
    await expect(commitImport({ ...fixture.preview, errors: [{ severity: 'error', code: 'synthetic-invalid-preview', message: 'Invalid preview' }] }, {}, db)).rejects.toMatchObject({ code: 'schema-mismatch', userMessage: 'The import preview contains errors and cannot be applied' })
    expect(observation).not.toHaveBeenCalled()
    observation.mockRestore()
  } finally { db.close(); await nativeResult(indexedDB.deleteDatabase(fixture.name)) }
})
