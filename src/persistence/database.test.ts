import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { addGameSetupRevision, createPersonalDefinition } from '../domain'
import { createTestLocalData, TEST_NOW } from '../domain/test-helpers'
import { syntheticModLayers } from '../domain/mod-layers.test-helpers'
import { compactModCatalog } from '../domain/mod-layers'
import type { LocalData } from '../domain/types'
import { CrystalCompanionDatabase, setDatabaseForTests } from './database'
import { exportBackup, loadLocalData, prepareModCatalogs, previewImport, undoLocalDataWithStatus } from './local-data'

const TABLES = { localDatas: 'id, revision, updatedAt', catalogs: 'key, id, revisionId, checksum', evidence: 'id, sourceDigest, group', sources: 'id, digest, format', history: 'id, localDataId, [localDataId+nextRevision]', imports: 'id, sourceDigest, localDataId', meta: 'key' }
const names: string[] = []
const legacy = (data: LocalData) => ({ ...data, schemaVersion: '2.0.0' })

async function oldDatabase(badHistory = false) {
  const name = `migration-${crypto.randomUUID()}`
  names.push(name)
  const database = new Dexie(name)
  database.version(1).stores(TABLES)
  const before = createTestLocalData()
  const after = createPersonalDefinition(before, { name: 'Synthetic migrated item', kind: 'item', now: TEST_NOW })
  await database.table('localDatas').put({ id: 'local-data-record', revision: after.revision, updatedAt: after.updatedAt, localData: legacy(after), lineage: { rootLocalDataId: before.id } })
  await database.table('history').put({ id: 'history', localDataId: before.id, command: 'save', previousRevision: before.revision, nextRevision: after.revision, before: legacy(before), after: badHistory ? { ...legacy(after), schemaVersion: 'unsupported' } : legacy(after), recordedAt: TEST_NOW })
  database.close()
  return { name, before, after }
}

afterEach(async () => {
  setDatabaseForTests(undefined)
  for (const name of names.splice(0)) await Dexie.delete(name)
})

describe('persisted behavior format migration', () => {
  it('upgrades legacy data and undo history transactionally without changing pinned records', async () => {
    const fixture = await oldDatabase()
    const database = new CrystalCompanionDatabase(fixture.name)
    setDatabaseForTests(database)
    const loaded = await loadLocalData()
    expect(database.verno).toBe(2)
    expect(loaded.localData).toEqual(fixture.after)
    expect(loaded.canUndo).toBe(true)
    const history = await database.history.get('history')
    expect(history?.before).toEqual(fixture.before)
    expect(history?.after).toEqual(fixture.after)
    const preview = await previewImport(await exportBackup(), 'migrated.zip')
    expect(preview.proposed.localData.gameSetups).toEqual(fixture.after.gameSetups)
    expect(preview.proposed.localData.playthroughs).toEqual(fixture.after.playthroughs)
    const undone = await undoLocalDataWithStatus(loaded.revision)
    expect(undone.localData.personalDefinitions).toEqual(fixture.before.personalDefinitions)
    expect(undone.localData.gameSetups).toEqual(fixture.before.gameSetups)
    database.close()
  })

  it('preserves compact imported mod catalogs and their exact composition pins during upgrade', async () => {
    const fixture = await oldDatabase()
    const { catalogs, composition } = await syntheticModLayers()
    const data = addGameSetupRevision(fixture.after, { label: 'Synthetic layered behavior', modComposition: composition, catalogLock: { [composition.baseline.catalogId]: composition.baseline.catalogRevisionId }, slots: [], activate: false, now: TEST_NOW })
    const prepared = await prepareModCatalogs(data, catalogs)
    const original = new Dexie(fixture.name)
    original.version(1).stores(TABLES)
    await original.table('localDatas').put({ id: 'local-data-record', revision: data.revision, updatedAt: data.updatedAt, localData: legacy(data), lineage: { rootLocalDataId: data.id } })
    await original.table('history').clear()
    for (const catalog of prepared) await original.table('catalogs').put({ key: JSON.stringify([catalog.id, catalog.revisionId]), id: catalog.id, revisionId: catalog.revisionId, checksum: catalog.checksum, snapshot: compactModCatalog(catalog) })
    original.close()
    const database = new CrystalCompanionDatabase(fixture.name)
    setDatabaseForTests(database)
    const loaded = await loadLocalData()
    expect(loaded.localData).toEqual(data)
    expect(loaded.catalogs.find(catalog => catalog.revisionId.startsWith('mod-setup:'))?.entities).toEqual(prepared.find(catalog => catalog.revisionId.startsWith('mod-setup:'))?.entities)
    database.close()
  })

  it('rolls back data writes and the database version when history migration fails', async () => {
    const fixture = await oldDatabase(true)
    const database = new CrystalCompanionDatabase(fixture.name)
    await expect(database.open()).rejects.toThrow()
    database.close()
    const original = new Dexie(fixture.name)
    original.version(1).stores(TABLES)
    const stored = await original.table('localDatas').get('local-data-record')
    expect(original.verno).toBe(1)
    expect(stored.localData).toEqual(legacy(fixture.after))
    expect((await original.table('history').get('history')).before).toEqual(legacy(fixture.before))
    original.close()
  })
})
