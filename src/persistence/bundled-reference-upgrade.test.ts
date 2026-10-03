import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it } from 'vitest'
import { DEFAULT_CATALOG, compileBundledSourceId } from '../catalog/bundled'
import { createSampleLocalData } from '../domain/sample-data'
import { createPersonalDefinition } from '../domain'
import { setModInReference } from '../domain/reference-library'
import type { LocalData } from '../domain/types'
import { CryKitDatabase, setDatabaseForTests } from './database'
import { exportBackup, loadLocalData, previewImport, saveLocalDataWithStatus, undoLocalDataWithStatus } from './local-data'

const TABLES = { localDatas: 'id, revision, updatedAt', catalogs: 'key, id, revisionId, checksum', evidence: 'id, sourceDigest, group', sources: 'id, digest, format', history: 'id, localDataId, [localDataId+nextRevision]', imports: 'id, sourceDigest, localDataId', meta: 'key' }
const LEGACY_IDS = ['base:class:warrior', 'base:class:cleric', 'base:class:rogue', 'base:class:wizard', 'base:item:short-sword', 'base:item:buckler', 'base:item:breastplate', 'base:item:short-staff', 'base:item:hemp-robe', 'base:item:dirk', 'base:item:leather-outfit', 'base:item:oak-wand']
const names: string[] = []

function historical(data: LocalData): LocalData {
  let text = JSON.stringify(data)
  for (const source of LEGACY_IDS) text = text.replaceAll(compileBundledSourceId(source), source)
  return JSON.parse(text) as LocalData
}

async function fixture(badHistory = false) {
  const name = `bundled-reference-upgrade-${crypto.randomUUID()}`
  names.push(name)
  const database = new Dexie(name)
  database.version(4).stores(TABLES)
  const before = createSampleLocalData(DEFAULT_CATALOG)
  const after = createPersonalDefinition(before, { name: 'Synthetic retained definition', kind: 'item' })
  const oldBefore = historical(before)
  const oldAfter = historical(after)
  const historyAfter = badHistory ? { ...oldAfter, buildRevisions: { ...oldAfter.buildRevisions, [Object.keys(oldAfter.buildRevisions)[0]!]: { ...Object.values(oldAfter.buildRevisions)[0]!, content: { ...Object.values(oldAfter.buildRevisions)[0]!.content, primaryClass: { kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: 'synthetic:missing' } } } } } : oldAfter
  await database.table('localDatas').put({ id: 'local-data-record', revision: after.revision, updatedAt: after.updatedAt, localData: oldAfter, lineage: { rootLocalDataId: before.id } })
  await database.table('history').put({ id: 'history', localDataId: before.id, command: 'save', previousRevision: before.revision, nextRevision: after.revision, before: oldBefore, after: historyAfter, recordedAt: after.updatedAt })
  database.close()
  return { name, before, after, oldBefore, oldAfter, historyAfter }
}

afterEach(async () => {
  setDatabaseForTests(undefined)
  for (const name of names.splice(0)) await Dexie.delete(name)
})

it('upgrades historical bundled references and undo history before saving Reference membership', async () => {
  const original = await fixture()
  const database = new CryKitDatabase(original.name)
  setDatabaseForTests(database)
  const loaded = await loadLocalData()
  expect(database.verno).toBe(5)
  expect(loaded.localData).toEqual(original.after)
  expect((await database.history.get('history'))?.before).toEqual(original.before)
  expect((await database.history.get('history'))?.after).toEqual(original.after)
  const undoneHistory = await undoLocalDataWithStatus(loaded.revision)
  expect(undoneHistory.localData.personalDefinitions).toEqual(original.before.personalDefinitions)
  expect(undoneHistory.localData.buildRevisions).toEqual(original.before.buildRevisions)
  const redoHistory = await undoLocalDataWithStatus(undoneHistory.localData.revision)
  expect(redoHistory.localData.personalDefinitions).toEqual(original.after.personalDefinitions)
  const removed = await saveLocalDataWithStatus(setModInReference(redoHistory.localData, 'name:doge shield', false), redoHistory.localData.revision)
  expect(removed.localData.referenceLibrary?.excludedMods).toEqual(['name:doge shield'])
  expect(removed.localData.playthroughs).toEqual(original.after.playthroughs)
  expect(removed.localData.buildRevisions).toEqual(original.after.buildRevisions)
  const restored = await saveLocalDataWithStatus(setModInReference(removed.localData, 'name:doge shield', true), removed.localData.revision)
  expect(restored.localData.referenceLibrary?.excludedMods).toEqual([])
  const preview = await previewImport(await exportBackup(), 'synthetic-upgraded.zip')
  expect(preview.proposed.localData.buildRevisions).toEqual(original.after.buildRevisions)
  const undone = await undoLocalDataWithStatus(restored.localData.revision)
  await undoLocalDataWithStatus(undone.localData.revision)
  const current = await loadLocalData()
  expect(current.localData.personalDefinitions).toEqual(original.after.personalDefinitions)
  database.close()
})

it('rolls back all roots, undo history, and the database version when an upgrade cannot resolve a reference', async () => {
  const fixtureData = await fixture(true)
  const database = new CryKitDatabase(fixtureData.name)
  await expect(database.open()).rejects.toThrow()
  database.close()
  const original = new Dexie(fixtureData.name)
  original.version(4).stores(TABLES)
  expect((await original.table('localDatas').get('local-data-record')).localData).toEqual(fixtureData.oldAfter)
  expect((await original.table('history').get('history')).before).toEqual(fixtureData.oldBefore)
  expect((await original.table('history').get('history')).after).toEqual(fixtureData.historyAfter)
  expect(original.verno).toBe(4)
  original.close()
})
