import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersonalDefinition, requirePlaythrough, setAcquisitionProgress } from '../domain'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { createSampleLocalData } from '../domain/sample-data'
import { NativeCatalogSnapshotSchema } from '../interchange/native-schema'
import { TEAM_SIZE } from '../domain/scenarios'
import { CryKitDatabase, setDatabaseForTests } from './database'
import {
  commitImport,
  exportBackup,
  loadLocalData,
  previewImport,
  prepareModCatalogs,
  saveLocalData,
  saveLocalDataWithStatus,
  undoLocalDataWithStatus,
  validateLocalDataForStorage,
} from './local-data'

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

  it('keeps catalog inputs stable across planner changes without new mod compositions', async () => {
    const loaded = await loadLocalData()
    const changed = createPersonalDefinition(loaded.localData, { kind: 'item', name: 'Synthetic stable catalog fixture', expectedRevision: loaded.revision })

    expect(await prepareModCatalogs(changed, loaded.catalogs)).toBe(loaded.catalogs)
    const saved = await saveLocalData(changed, loaded.revision)
    expect(await prepareModCatalogs(saved, loaded.catalogs)).toBe(loaded.catalogs)
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
