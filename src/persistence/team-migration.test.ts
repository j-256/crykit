import { createPersonalDefinition } from '../domain/local-data'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { CryKitDatabase } from './database'
import { addTestBuild, createTestLocalData, TEST_NOW } from '../domain/test-helpers'

// This fixture has no catalog refs; migration ownership is independent of bundled game-data volume
vi.mock('../catalog/bundled', async importOriginal => ({ ...await importOriginal<typeof import('../catalog/bundled')>(), BUNDLED_CATALOGS: [] }))

const tables = { localDatas: 'id, revision, updatedAt', catalogs: 'key, id, revisionId, checksum', evidence: 'id, sourceDigest, group', sources: 'id, digest, format', history: 'id, localDataId, [localDataId+nextRevision]', imports: 'id, sourceDigest, localDataId', meta: 'key' }
const names: string[] = []
afterEach(async () => { for (const name of names.splice(0)) await Dexie.delete(name) })
async function fixture(badHistory: boolean) {
  const name = `team-migration-${crypto.randomUUID()}`
  names.push(name)
  const old = new Dexie(name)
  old.version(6).stores(tables)
  const seeded = addTestBuild(addTestBuild(createTestLocalData(), 'source-one', '', {}), 'source-two', '', {})
  const setupId = seeded.buildRevisions['source-two-revision']!.gameSetupRevisionId
  const { teamRevisions: _revisions, ...base } = seeded
  const data = { ...base, gameSetups: { ...base.gameSetups, different: { ...base.gameSetups[setupId]!, id: 'different' as never, ppLimit: { state: 'known', value: 99 } } }, buildRevisions: { ...base.buildRevisions, 'source-two-revision': { ...base.buildRevisions['source-two-revision']!, gameSetupRevisionId: 'different' as never } } } as typeof base
  const team = (id: string, slots: (string | null)[]) => ({ id, title: id, revision: 0, slots, createdAt: TEST_NOW, updatedAt: TEST_NOW })
  const before = { ...data, schemaVersion: '2.4.0', teams: { empty: team('empty', [null, null, null, null]), mixed: team('mixed', ['source-one-revision', null, 'source-two-revision', null]), equivalent: team('equivalent', ['source-one-revision', null, 'source-one-revision', null]) } }
  const { teamRevisions: _afterRevisions, ...changed } = createPersonalDefinition({ ...data, teamRevisions: {} }, { name: 'Synthetic', kind: 'item', now: TEST_NOW })
  const after = { ...changed, schemaVersion: '2.4.0', teams: before.teams }
  const root = { id: 'local-data-record', revision: after.revision, updatedAt: after.updatedAt, localData: after, lineage: { rootLocalDataId: before.id } }
  const history = { id: 'old-undo', localDataId: before.id, command: 'save', previousRevision: before.revision, nextRevision: after.revision, before: badHistory ? { ...before, schemaVersion: '2.99.0' } : before, after, recordedAt: TEST_NOW }
  await old.table('localDatas').put(root)
  await old.table('history').put(history)
  old.close()
  return { name, root, history }
}
it.each([false, true])('rejects prelaunch teams and keeps every root and undo endpoint exact: damaged=%s', async damaged => {
  const { name, root, history } = await fixture(damaged)
  const next = new CryKitDatabase(name)
  await expect(next.open()).rejects.toThrow(/prelaunch/i)
  next.close()
  const old = new Dexie(name)
  old.version(6).stores(tables)
  try {
    await old.open()
    expect(old.backendDB().version).toBe(60)
    expect(await old.table('localDatas').get(root.id)).toEqual(root)
    expect(await old.table('history').get(history.id)).toEqual(history)
  } finally { old.close() }
})

it('opens only the exact launch layout and never creates a missing selected source', async () => {
  const { openSelectedGuestPlanner } = await import('../workspace/open-required-guest-planner')
  const owner = { signal: new AbortController().signal, assertCurrent: () => undefined }
  const missing = `team-missing-${crypto.randomUUID()}`
  names.push(missing)
  await expect(openSelectedGuestPlanner(missing, owner)).rejects.toThrow()
  expect((await indexedDB.databases()).some(database => database.name === missing)).toBe(false)
  for (const version of [50, 60, 65, 80]) {
    const name = `team-unsupported-${crypto.randomUUID()}`
    names.push(name)
    const old = new Dexie(name); old.version(version / 10).stores(tables); await old.open(); old.close()
    await expect(openSelectedGuestPlanner(name, owner)).rejects.toThrow()
    expect((await indexedDB.databases()).find(database => database.name === name)?.version).toBe(version)
  }
  const name = `team-launch-${crypto.randomUUID()}`
  names.push(name)
  const current = new CryKitDatabase(name)
  await current.open(); current.close()
  const selected = await openSelectedGuestPlanner(name, owner)
  try { expect(selected.backendDB().version).toBe(70) } finally { selected.close() }
})
