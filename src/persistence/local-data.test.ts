import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPersonalDefinition, requirePlaythrough } from '../domain'
import { TEAM_SIZE } from '../domain/scenarios'
import { CrystalCompanionDatabase, setDatabaseForTests } from './database'
import {
  commitImport,
  exportBackup,
  loadLocalData,
  previewImport,
  saveLocalData,
  saveLocalDataWithStatus,
  undoLocalDataWithStatus,
  validateLocalDataForStorage,
} from './local-data'

describe('local planner persistence', () => {
  let database: CrystalCompanionDatabase

  beforeEach(() => {
    database = new CrystalCompanionDatabase(`test-${crypto.randomUUID()}`)
    setDatabaseForTests(database)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    setDatabaseForTests(undefined)
    await database.delete()
  })

  it('initializes one planner root with a selected sample Playthrough', async () => {
    const loaded = await loadLocalData()
    const playthrough = requirePlaythrough(loaded.localData)

    expect(Object.keys(playthrough.characters)).toHaveLength(TEAM_SIZE)
    expect(Object.keys(playthrough.inventory).length).toBeGreaterThan(0)
    expect(loaded.canUndo).toBe(false)
    expect(await database.localDatas.count()).toBe(1)
  })

  it('uses the same planner root for concurrent first loads', async () => {
    const loaded = await Promise.all(Array.from({ length: 4 }, () => loadLocalData()))

    expect(new Set(loaded.map(entry => entry.localData.id))).toHaveLength(1)
    expect(loaded.every(entry => JSON.stringify(entry.localData) === JSON.stringify(loaded[0]?.localData))).toBe(true)
    expect(await database.localDatas.count()).toBe(1)
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

    expect(preview.detectedFormat).toBe('native-backup-2.0.0')
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
