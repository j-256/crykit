import 'fake-indexeddb/auto'
import '../workspace/guest-managed-monitor.test-helpers'
import Dexie from 'dexie'
import { afterEach, expect, test } from 'vitest'
import { createBlankLocalData } from '../domain/local-data'
import { GuestCoordinatorDatabase } from '../workspace/guest-coordinator'
import { createGuestLocalStore } from '../workspace/guest-local-store'
import { admitLocalRoot, prepareLocalWorkspace } from '../workspace/local-root'
import type { WorkspaceState } from '../workspace/documents'
import { exactStarterValue, initializeMatchedStarter, requirePreeditStarter, type StarterApi } from '../../e2e/accounts/signin-matched-starter-core'
const names: string[] = []
afterEach(async () => { for (const name of names.splice(0)) await Dexie.delete(name) })
function fixture() {
  const name = `matched-starter-${crypto.randomUUID()}`; names.push(name)
  const database = new GuestCoordinatorDatabase(name), localData = createBlankLocalData()
  const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], history: [], sources: [], evidence: [] }, blobs: [], editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] } }
  let current = true
  const api: StarterApi = { createGuestLocalStore, prepareLocalWorkspace, admitLocalRoot, captureGuestWorkspaceEpoch: () => ({ signal: new AbortController().signal, assertCurrent() { if (!current) throw new Error('Profile changed') } }) }
  return { database, state, api, revoke() { current = false } }
}
test('uses independent durable admission and one real absent-head receipt', async () => {
  const f = fixture()
  try {
    const result = await initializeMatchedStarter(f.api, f.database, f.state, [])
    expect((await f.database.active.get('active'))?.manifest).toEqual(result.manifest)
    const operations = await f.database.table('managedOperations').toArray()
    expect(operations).toEqual([{ version: 1, id: result.manifest.id, kind: 'managed-local-commit', target: result.manifest }])
    expect((await f.database.table('managedRecords').toArray()).every(row => row.ready && row.operationId === result.manifest.id)).toBe(true)
    await expect(initializeMatchedStarter(f.api, f.database, f.state, [])).rejects.toThrow('occupied')
    expect(await f.database.table('managedOperations').count()).toBe(1)
  } finally { f.database.close() }
})
test('rejects unavailable exports, omitted bookkeeping and existing history before staging', async () => {
  const f = fixture()
  try {
    await expect(initializeMatchedStarter({ ...f.api, admitLocalRoot: undefined } as unknown as StarterApi, f.database, f.state, [])).rejects.toThrow('export unavailable')
    expect(() => requirePreeditStarter(f.state, undefined as never)).toThrow('pre-edit')
    expect(() => requirePreeditStarter({ ...f.state, planner: { ...f.state.planner, history: [{} as never] } }, [])).toThrow('pre-edit')
    expect(() => requirePreeditStarter({ ...f.state, planner: { ...f.state.planner, journal: undefined } }, [])).toThrow('pre-edit')
    expect(await f.database.active.get('active')).toBeUndefined()
    expect(await f.database.table('managedRecords').count()).toBe(0)
  } finally { f.database.close() }
})
for (const loss of ['cancel', 'profile'] as const) test(`rejects late ${loss} after durable staging without selecting a successor`, async () => {
  const f = fixture(), abort = new AbortController()
  const api = { ...f.api, async admitLocalRoot(...args: Parameters<typeof admitLocalRoot>) {
    const result = await admitLocalRoot(...args)
    if (loss === 'cancel') abort.abort(); else f.revoke()
    return result
  } }
  try {
    await expect(initializeMatchedStarter(api, f.database, f.state, [], abort.signal)).rejects.toThrow(loss === 'cancel' ? 'cancelled' : 'Profile changed')
    expect(await f.database.active.get('active')).toBeUndefined()
    expect(await f.database.table('managedOperations').count()).toBe(0)
    expect((await f.database.table('managedRecords').toArray()).every(row => !row.ready)).toBe(true)
  } finally { f.database.close() }
})
test('exact identity rejects same-length mutation, omitted fields and changed body associations', () => {
  expect(exactStarterValue({ note: 'abc', changes: [], body: { documentId: 'a', revisionId: 'b' } }, { note: 'abd', changes: [], body: { documentId: 'a', revisionId: 'b' } })).toBe(false)
  expect(exactStarterValue({ changes: [] }, {})).toBe(false)
  expect(exactStarterValue({ body: { documentId: 'a', revisionId: 'b' } }, { body: { documentId: 'b', revisionId: 'a' } })).toBe(false)
})

async function graph(database: GuestCoordinatorDatabase) {
  const { manifest } = (await database.active.get('active'))!
  return { manifest: manifest as unknown as import('../../e2e/accounts/signin-matched-starter-graph').StarterGraph['manifest'], records: await database.table('managedRecords').toArray(), chunks: (await database.table('managedChunks').toArray()).map(row => ({ ...row, bytes: Array.from(row.bytes as Uint8Array) })), operations: await database.table('managedOperations').toArray(), extraCounts: { captures: await database.captures.count(), records: await database.records.count(), journal: await database.journal.count(), migrations: await database.table('managedMigrations').count() } }
}
test('independent graph oracle rejects changed bytes, missing refs and extra physical roles', async () => {
  const { proveStarterInitialization } = await import('../../e2e/accounts/signin-matched-starter-graph')
  const f = fixture()
  try {
    const installed = await initializeMatchedStarter(f.api, f.database, f.state, []), captured = await graph(f.database)
    const reference = { ...installed, state: f.state, bodyRefs: [], rows: { managedRecords: { rows: captured.records } } }
    expect((await proveStarterInitialization(captured, reference)).recordCount).toBe(captured.records.length)
    const changed = structuredClone(captured); changed.chunks[0].bytes[0] ^= 1
    await expect(proveStarterInitialization(changed, reference)).rejects.toThrow('bytes changed')
    const missing = structuredClone(captured); missing.records[0].dependencies.push({ documentId: 'missing', revisionId: 'missing' })
    await expect(proveStarterInitialization(missing, reference)).rejects.toThrow('Missing starter reference')
    const omitted = structuredClone(captured); omitted.chunks.pop()
    await expect(proveStarterInitialization(omitted, reference)).rejects.toThrow('Missing starter chunk')
    const orphan = structuredClone(captured), extra = { ...orphan.records[0], documentId: 'orphan', revisionId: 'orphan' }
    orphan.chunks.push(...orphan.chunks.filter(chunk => chunk.revisionId === orphan.records[0].revisionId).map(chunk => ({ ...chunk, revisionId: 'orphan' })))
    orphan.records.push(extra)
    await expect(proveStarterInitialization(orphan, reference)).rejects.toThrow('Unreachable initial records')
    const source = { ...reference, state: { ...reference.state, planner: { ...reference.state.planner, localData: { ...reference.state.planner.localData, updatedAt: '2000-01-01T00:00:00.000Z' as never } } } }
    await expect(proveStarterInitialization(captured, source)).rejects.toThrow('Complete pre-edit source changed')
  } finally { f.database.close() }
})
test('the graph oracle proves a real repository save uses physical history endpoints', async () => {
  const { proveOrdinaryStarterEdit } = await import('../../e2e/accounts/signin-matched-starter-graph')
  const { openGuestManagedRepository } = await import('../workspace/guest-managed-repository')
  const { createPlaythrough } = await import('../domain/local-data')
  const f = fixture()
  let repository: Awaited<ReturnType<typeof openGuestManagedRepository>> | undefined
  try {
    const installed = await initializeMatchedStarter(f.api, f.database, f.state, []), before = await graph(f.database)
    const reference = { ...installed, state: f.state, bodyRefs: [], rows: { managedRecords: { rows: before.records } } }
    repository = await openGuestManagedRepository(f.database, installed.manifest)
    const loaded = await repository.load()
    await repository.save(createPlaythrough(loaded.localData, { label: 'Synthetic matched starter edit' }), loaded.revision)
    const after = await graph(f.database), result = await proveOrdinaryStarterEdit(before, after, reference)
    expect(result.transitionCount).toBe(1)
    const altered = structuredClone(after); altered.manifest.root = before.manifest.root
    await expect(proveOrdinaryStarterEdit(before, altered, reference)).rejects.toThrow('Expected exactly one')
  } finally { f.database.close() }
})

test('archive pin rejects a same-length source mutation before any initialization', async () => {
  const { requirePinnedBytes } = await import('../../e2e/accounts/signin-matched-starter')
  const { digest } = await import('../../e2e/accounts/signin-matched-starter-graph')
  const original = new Uint8Array([1, 2, 3]), changed = new Uint8Array([1, 2, 4])
  expect(requirePinnedBytes(original, digest(original))).toBe(original)
  expect(() => requirePinnedBytes(changed, digest(original))).toThrow('Frozen starter bytes changed')
})
