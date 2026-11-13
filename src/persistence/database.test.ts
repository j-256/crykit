import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import { addGameSetupRevision, createPersonalDefinition, updateBuild } from '../domain'
import { addTestBuild, createTestLocalData, TEST_NOW } from '../domain/test-helpers'
import { syntheticModLayers } from '../domain/mod-layers.test-helpers'
import { compactModCatalog } from '../domain/mod-layers'
import type { LocalData } from '../domain/types'
import { CryKitDatabase, setDatabaseForTests } from './database'
import { loadLocalData, prepareModCatalogs } from './local-data'

const TABLES = { localDatas: 'id, revision, updatedAt', catalogs: 'key, id, revisionId, checksum', evidence: 'id, sourceDigest, group', sources: 'id, digest, format', history: 'id, localDataId, [localDataId+nextRevision]', imports: 'id, sourceDigest, localDataId', meta: 'key' }
const names: string[] = []
const legacy = (data: LocalData) => { const { teams, teamRevisions: _teamRevisions, ...rest } = data; return { ...rest, schemaVersion: '2.0.0' } }
const classified = (data: LocalData) => ({ ...Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'teamRevisions')), schemaVersion: '2.2.0', builds: Object.fromEntries(Object.entries(data.builds).map(([id, { archived, ...build }]) => [id, { ...build, kind: 'template', state: archived ? 'archived' : 'hypothetical' }])) })

async function classifiedDatabase(badHistory = false) {
  const name = `classification-migration-${crypto.randomUUID()}`
  names.push(name)
  const database = new Dexie(name)
  database.version(3).stores(TABLES)
  let before = addTestBuild(addTestBuild(createTestLocalData(), 'visible', '', {}), 'archived', '', {})
  before = updateBuild(before, { buildId: before.builds.visible!.id, tags: ['template', 'sample'], now: TEST_NOW })
  const after = updateBuild(before, { buildId: before.builds.archived!.id, archived: true, now: TEST_NOW })
  await database.table('localDatas').put({ id: 'local-data-record', revision: after.revision, updatedAt: after.updatedAt, localData: classified(after), lineage: { rootLocalDataId: before.id } })
  await database.table('history').put({ id: 'history', localDataId: before.id, command: 'save', previousRevision: before.revision, nextRevision: after.revision, before: classified(before), after: badHistory ? { ...classified(after), schemaVersion: 'unsupported' } : classified(after), recordedAt: TEST_NOW })
  database.close()
  return { name, before, after }
}

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

describe('prelaunch planner format rejection', () => {
  it('rejects classified Builds without rewriting data or undo history', async () => {
    const fixture = await classifiedDatabase()
    const database = new CryKitDatabase(fixture.name)
    await expect(database.open()).rejects.toThrow('Unsupported prelaunch')
    database.close()
    const original = new Dexie(fixture.name)
    await original.open()
    expect(original.verno).toBe(3)
    expect((await original.table('localDatas').get('local-data-record')).localData).toEqual(classified(fixture.after))
    expect((await original.table('history').get('history')).before).toEqual(classified(fixture.before))
    original.close()
  })

  it('keeps version 3 data intact if classification cleanup fails', async () => {
    const fixture = await classifiedDatabase(true)
    const database = new CryKitDatabase(fixture.name)
    await expect(database.open()).rejects.toThrow()
    database.close()
    const original = new Dexie(fixture.name)
    original.version(3).stores(TABLES)
    expect((await original.table('localDatas').get('local-data-record')).localData).toEqual(classified(fixture.after))
    expect(original.verno).toBe(3)
    expect((await original.table('history').get('history')).before).toEqual(classified(fixture.before))
    original.close()
  })

  it('rejects legacy data without changing pinned records or undo history', async () => {
    const fixture = await oldDatabase()
    const database = new CryKitDatabase(fixture.name)
    await expect(database.open()).rejects.toThrow('Unsupported prelaunch')
    database.close()
    const original = new Dexie(fixture.name)
    await original.open()
    expect(original.verno).toBe(1)
    expect((await original.table('localDatas').get('local-data-record')).localData).toEqual(legacy(fixture.after))
    const history = await original.table('history').get('history')
    expect(history.before).toEqual(legacy(fixture.before))
    expect(history.after).toEqual(legacy(fixture.after))
    original.close()
  })

  it('rejects old storage while preserving compact imported sources and exact composition pins', async () => {
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
    const database = new CryKitDatabase(fixture.name)
    await expect(database.open()).rejects.toThrow('Unsupported prelaunch')
    await original.open()
    expect((await original.table('localDatas').get('local-data-record')).localData).toEqual(legacy(data))
    expect((await original.table('catalogs').toArray()).map(row => row.snapshot)).toEqual(expect.arrayContaining(prepared.map(compactModCatalog)))
    expect(original.verno).toBe(1)
    original.close()
    database.close()
  })

  it('rolls back data writes and the database version when history migration fails', async () => {
    const fixture = await oldDatabase(true)
    const database = new CryKitDatabase(fixture.name)
    await expect(database.open()).rejects.toThrow()
    database.close()
    // Reopen through the old schema so assertions cannot trigger another migration and hide partial writes
    const original = new Dexie(fixture.name)
    original.version(1).stores(TABLES)
    const stored = await original.table('localDatas').get('local-data-record')
    expect(original.verno).toBe(1)
    expect(stored.localData).toEqual(legacy(fixture.after))
    expect((await original.table('history').get('history')).before).toEqual(legacy(fixture.before))
    original.close()
  })

  it.each([false, true])('rejects schema 2.3 roots and preserves history, invalid history: %s', async badHistory => {
    const name = `display-receipt-migration-${crypto.randomUUID()}`
    names.push(name)
    const before = addTestBuild(createTestLocalData(), 'migration-build', '', {})
    const after = updateBuild(before, { buildId: before.builds['migration-build']!.id, title: 'Renamed Build', now: TEST_NOW })
    const old = (data: LocalData) => ({ ...Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'teamRevisions')), schemaVersion: '2.3.0' })
    const original = new Dexie(name)
    original.version(5).stores(TABLES)
    await original.table('localDatas').put({ id: 'local-data-record', revision: after.revision, updatedAt: after.updatedAt, localData: old(after), lineage: { rootLocalDataId: before.id } })
    await original.table('history').put({ id: 'history', localDataId: before.id, command: 'save', previousRevision: before.revision, nextRevision: after.revision, before: old(before), after: badHistory ? { ...old(after), builds: {} } : old(after), recordedAt: TEST_NOW })
    original.close()
    const database = new CryKitDatabase(name)
    await expect(database.open()).rejects.toThrow('Unsupported prelaunch')
    database.close()
    const previous = new Dexie(name)
    previous.version(5).stores(TABLES)
    expect((await previous.table('localDatas').get('local-data-record')).localData).toEqual(old(after))
    const history = await previous.table('history').get('history')
    expect(history.before).toEqual(old(before))
    expect(history.after).toEqual(badHistory ? { ...old(after), builds: {} } : old(after))
    expect(previous.verno).toBe(5)
    previous.close()
  })
})

it('keeps the per-handle journal requirement immutable across options edits and terminal close', async () => {
  const name = `format-requirement-${crypto.randomUUID()}`; names.push(name)
  const legacyHandle = new CryKitDatabase(name)
  await legacyHandle.open(); legacyHandle.close()
  const options = { plannerFormatRequirement: 'journaled' as const }
  const required = new CryKitDatabase(name, options)
  Object.assign(options, { plannerFormatRequirement: 'legacy-or-journaled' })
  expect(Reflect.set(required, 'plannerFormatRequirement', 'legacy-or-journaled')).toBe(false)
  expect(Reflect.deleteProperty(required, 'plannerFormatRequirement')).toBe(false)
  expect(() => Object.defineProperty(required, 'plannerFormatRequirement', { value: 'legacy-or-journaled' })).toThrow()
  await required.open()
  expect(required.plannerFormatRequirement).toBe('journaled')
  await expect(loadLocalData(required)).rejects.toMatchObject({ code: 'schema-mismatch', recoverable: true })
  required.close()
  await expect(required.open()).rejects.toBeInstanceOf(Dexie.DatabaseClosedError)
  const ordinary = new CryKitDatabase(name)
  await ordinary.open()
  expect(ordinary.plannerFormatRequirement).toBe('legacy-or-journaled')
  expect((await loadLocalData(ordinary)).revision).toBe(0)
  ordinary.close()
})
it.each(['guess', null, false])('rejects unknown runtime planner format requirement %s', value => {
  expect(() => new CryKitDatabase('invalid-format', { plannerFormatRequirement: value as never })).toThrow()
})

it('captures the supplied requirement once before any database open', async () => {
  let reads = 0
  const database = new CryKitDatabase('capture-format', { get plannerFormatRequirement() { return ++reads === 1 ? 'journaled' : 'legacy-or-journaled' } })
  expect(database.plannerFormatRequirement).toBe('journaled')
  expect(reads).toBe(1)
  database.close()
})
