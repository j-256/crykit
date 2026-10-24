import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { unzipSync } from 'fflate'
import * as nativeZip from '../interchange/zip'
import { syntheticModLayers } from '../domain/mod-layers.test-helpers'
import { compactModCatalog } from '../domain/mod-layers'
import { afterEach, expect, it, vi } from 'vitest'
import { updateGameSetupRevision, addGameSetupRevision, createBlankLocalData, createPersonalDefinition, createPlaythrough } from '../domain/local-data'
import { observeInventory } from '../domain/inventory'
import { WITHDRAWN_CATALOGS } from '../domain/withdrawn-catalogs'
import { CryKitDatabase, setDatabaseForTests } from './database'
import { selectBackupHistory, prepareModCatalogs, exportBackup, changedLocalData, historyEntry, subscribeLocalData, loadLocalData, saveLocalData, saveLocalDataWithStatus, undoLocalData, undoLocalDataWithStatus, commitImport, commitModSetup } from './local-data'
import type { LocalDataRecord, MetaRecord } from './database'
import type { WorkspacePlannerState } from '../workspace/documents'
import { validateGuestPlannerRecord, GUEST_PLANNER_LAYOUT_KEY } from './guest-planner-record'
import { prepareGuestRestorePlanner, requirePreparedGuestPlanner } from '../workspace/guest-planner'
import { nowTimestamp } from '../interchange/util'
import { writePreparedGuestPlanner, type GuestPlannerInstallStagedRows } from './guest-planner-store'
import { previewImport } from '../interchange/import'
import { createSampleLocalData } from '../domain/sample-data'
import { BUNDLED_CATALOGS, CURRENT_CATALOG } from '../catalog/bundled'

const names: string[] = []
afterEach(async () => { for (const name of names.splice(0)) await Dexie.delete(name) })
it('denies restored undo despite exact imported endpoint and another same-number branch', async () => {
  const before = createBlankLocalData(), time = nowTimestamp()
  const after = changedLocalData(before, before, 'imported', time)
  const exact = historyEntry(before, after, 'imported', time)
  const branchAfter = changedLocalData(before, before, 'other branch', time)
  const branch = historyEntry(before, branchAfter, 'other branch', time)
  const name = `guest-planner-${crypto.randomUUID()}`; names.push(name)
  const database = new CryKitDatabase(name)
  const current: WorkspacePlannerState = { localData: after, lineage: { rootLocalDataId: before.id }, catalogs: [], sources: [], evidence: [], history: [exact, branch] }
  const source: WorkspacePlannerState = { ...current, journal: { version: 1, changes: after.changes, checkpoints: [exact], undoable: true } }
  const original = structuredClone(source)
  const prepared = requirePreparedGuestPlanner(prepareGuestRestorePlanner(current, source, 'replace'))
  await database.localDatas.add(prepared.record)
  await database.meta.add(prepared.declaration)
  const coincident = { ...prepared.planner.history.at(-1)!, id: 'imported-coincident', command: 'imported endpoint' }
  const coincidentBranch = { ...coincident, id: 'imported-coincident-branch', after: { ...coincident.after, updatedAt: before.updatedAt } }
  await database.history.bulkAdd([...prepared.planner.history, coincident, coincidentBranch])
  database.close()
  const reopened = new CryKitDatabase(name)
  try {
    const admitted = validateGuestPlannerRecord((await reopened.localDatas.get('local-data-record'))!, await reopened.meta.get(GUEST_PLANNER_LAYOUT_KEY), await reopened.history.toArray(), 'journaled')
    expect(admitted.format).toBe('journaled')
    if (admitted.format !== 'journaled') throw new Error('Expected journaled planner')
    expect(admitted.journal.undoable).toBe(false)
    expect(admitted.journal.checkpoints).toEqual([])
    expect(await reopened.history.get(exact.id)).toEqual(exact)
    expect(await reopened.history.get(branch.id)).toEqual(branch)
    expect(await reopened.history.get(coincident.id)).toEqual(coincident)
    expect(coincident.after).toEqual(prepared.record.localData)
    expect(await reopened.history.get(coincidentBranch.id)).toEqual(coincidentBranch)
    expect(source).toEqual(original)
    expect(prepared.resolved).toEqual(original)
    expect(reopened.verno).toBe(7)
  } finally { reopened.close() }
})

function tuple() {
  const before = createBlankLocalData(), time = nowTimestamp()
  const middle = changedLocalData(before, before, 'first', time), after = changedLocalData(middle, middle, 'second', time)
  const history = [historyEntry(before, middle, 'first', time), historyEntry(middle, after, 'second', time)]
  const descriptor = { version: 1 as const, kind: 'guest-operative-planner' as const, epoch: 'destination-epoch', localDataId: after.id, revision: after.revision, checkpointIds: history.map(row => row.id), savedDestinationChanges: [...after.changes], undoable: true }
  const record: LocalDataRecord = { id: 'local-data-record', revision: after.revision, updatedAt: after.updatedAt, localData: after, lineage: { rootLocalDataId: before.id }, operativePlanner: descriptor }
  const declaration: MetaRecord = { key: GUEST_PLANNER_LAYOUT_KEY, value: JSON.stringify({ version: 1, kind: 'guest-journaled-planner', epoch: descriptor.epoch }) }
  return { record, declaration, history }
}
it('resolves only declared ordered membership while keeping an exact matching unlisted branch inert', () => {
  const { record, declaration, history } = tuple()
  const unlisted = { ...history[1], id: 'unlisted' }
  const admitted = validateGuestPlannerRecord(record, declaration, [unlisted, ...history].reverse(), 'journaled')
  expect(record.id).not.toBe(record.localData.id)
  expect(admitted.format).toBe('journaled')
  if (admitted.format !== 'journaled') throw new Error('Expected journaled planner')
  expect(admitted.journal.checkpoints).toEqual(history)
  expect(admitted.journal.undoable).toBe(true)
})
it('admits only an explicitly allowed legacy pair and never downgrades a stripped required pair', () => {
  const { record } = tuple(), { operativePlanner: _descriptor, ...legacy } = record
  expect(validateGuestPlannerRecord(legacy, undefined, [], 'legacy-or-journaled')).toEqual({ format: 'legacy' })
  expect(() => validateGuestPlannerRecord(legacy, undefined, [], 'journaled')).toThrow()
})
const malformed: readonly [string, (value: ReturnType<typeof tuple>) => void][] = [
  ['physical key', value => { Object.assign(value.record, { id: value.record.localData.id }) }],
  ['domain binding', value => { Object.assign(value.record.operativePlanner!, { localDataId: 'local-data-record' }) }],
  ['missing descriptor', value => { delete (value.record as { operativePlanner?: unknown }).operativePlanner }],
  ['missing declaration', value => { Object.assign(value, { declaration: undefined }) }],
  ['explicit undefined descriptor', value => { Object.assign(value.record, { operativePlanner: undefined }) }],
  ['root extra', value => { Object.assign(value.record, { extra: true }) }],
  ['declaration version', value => { Object.assign(value.declaration, { value: JSON.stringify({ version: 2, kind: 'guest-journaled-planner', epoch: 'destination-epoch' }) }) }],
  ['declaration malformed JSON', value => { Object.assign(value.declaration, { value: '{' }) }],
  ['descriptor version', value => { Object.assign(value.record.operativePlanner!, { version: 2 }) }],
  ['descriptor extra', value => { Object.assign(value.record.operativePlanner!, { extra: true }) }],
  ['descriptor undefined extra', value => { Object.assign(value.record.operativePlanner!, { extra: undefined }) }],
  ['declaration extra', value => { Object.assign(value.declaration, { value: JSON.stringify({ version: 1, kind: 'guest-journaled-planner', epoch: 'destination-epoch', extra: true }) }) }],
  ['declaration key', value => { Object.assign(value.declaration, { key: 'wrong' }) }],
  ['epoch', value => { Object.assign(value.record.operativePlanner!, { epoch: 'wrong' }) }],
  ['empty epoch', value => { Object.assign(value.record.operativePlanner!, { epoch: '' }) }],
  ['wrapper revision', value => { Object.assign(value.record, { revision: 8 }) }],
  ['descriptor revision', value => { Object.assign(value.record.operativePlanner!, { revision: 8 }) }],
  ['unsafe revision', value => { Object.assign(value.record.operativePlanner!, { revision: Number.MAX_SAFE_INTEGER + 1 }) }],
  ['duplicate member', value => { Object.assign(value.record.operativePlanner!, { checkpointIds: [value.history[1].id, value.history[1].id] }) }],
  ['missing member', value => { value.history.shift() }],
  ['reordered member', value => { Object.assign(value.record.operativePlanner!, { checkpointIds: [...value.record.operativePlanner!.checkpointIds].reverse() }) }],
  ['disconnected middle', value => { Object.assign(value.history[1], { before: { ...value.history[1].before, updatedAt: '2026-01-01T00:00:00.000Z' } }) }],
  ['changed same-id row', value => { value.history.push({ ...value.history[1], command: 'changed' }) }],
  ['duplicate physical row', value => { value.history.push(value.history[1]) }],
  ['wrong history domain', value => { Object.assign(value.history[0], { localDataId: 'local-data-record' }) }],
  ['wrong before domain', value => { Object.assign(value.history[0], { before: { ...value.history[0].before, id: 'local-data-record' } }) }],
  ['wrong after domain', value => { Object.assign(value.history[0], { after: { ...value.history[0].after, id: 'local-data-record' } }) }],
  ['checkpoint revision', value => { Object.assign(value.history[0], { previousRevision: 1 }) }],
  ['nonadvancing revision', value => { Object.assign(value.history[0], { nextRevision: 0 }) }],
  ['endpoint', value => { Object.assign(value.record, { localData: { ...value.record.localData, updatedAt: '2026-01-01T00:00:00.000Z' } }) }],
  ['empty undo', value => { Object.assign(value.record.operativePlanner!, { checkpointIds: [] }) }],
  ['conflicting saved change', value => { Object.assign(value.record.operativePlanner!, { savedDestinationChanges: [...value.record.localData.changes, { ...value.record.localData.changes[0], command: 'changed' }] }) }],
  ['saved versus live change', value => { Object.assign(value.record.operativePlanner!, { savedDestinationChanges: [{ ...value.record.localData.changes[0], command: 'changed' }] }) }],
]
it.each(malformed)('rejects %s without mutating the supplied tuple', (_name, mutate) => {
  const value = tuple(); mutate(value)
  const original = structuredClone(value)
  expect(() => validateGuestPlannerRecord(value.record, value.declaration, value.history, 'journaled')).toThrow()
  expect(value).toEqual(original)
})
it('validates complete membership even with undo disabled', () => {
  const value = tuple()
  Object.assign(value.record.operativePlanner!, { undoable: false })
  value.history.shift()
  expect(() => validateGuestPlannerRecord(value.record, value.declaration, value.history, 'journaled')).toThrow()
})
it('does not normalize a historical operative snapshot into the current schema', () => {
  const value = tuple()
  Object.assign(value.history[0].before, { schemaVersion: '2.3.0' })
  expect(() => validateGuestPlannerRecord(value.record, value.declaration, value.history, 'journaled')).toThrow()
})
it('rejects destination evidence from a future revision', () => {
  const value = tuple()
  Object.assign(value.record.operativePlanner!, { savedDestinationChanges: [{ ...value.record.localData.changes[0], id: 'future-change', previousRevision: 50, nextRevision: 51 }] })
  expect(() => validateGuestPlannerRecord(value.record, value.declaration, value.history, 'journaled')).toThrow()
})
it('does not admit a malformed descriptor-free root as genuine legacy', () => {
  const { record } = tuple(), { operativePlanner: _descriptor, ...legacy } = record
  expect(() => validateGuestPlannerRecord({ ...legacy, id: 'wrong-root' }, undefined, [], 'legacy-or-journaled')).toThrow()
})

it('rejects missing saved coverage for a known live destination change', () => {
  const value = tuple()
  Object.assign(value.record.operativePlanner!, { savedDestinationChanges: [] })
  const original = structuredClone(value)
  expect(() => validateGuestPlannerRecord(value.record, value.declaration, value.history, 'journaled')).toThrow()
  expect(value).toEqual(original)
})
it.each([false, true])('rejects changed immutable operative values when the older change left the live window: %s', olderChangeLeftWindow => {
  const value = tuple(), checkpoint = structuredClone(value.history[1])
  const older = checkpoint.before.changes[0]
  Object.assign(checkpoint, { before: { ...checkpoint.before, changes: [{ ...older, command: 'changed immutable value' }] } })
  Object.assign(value.record.operativePlanner!, { checkpointIds: [checkpoint.id] })
  if (olderChangeLeftWindow) {
    const localData = { ...value.record.localData, changes: value.record.localData.changes.slice(1) }
    Object.assign(value.record, { localData })
    Object.assign(checkpoint, { after: localData })
  }
  expect(value.record.operativePlanner!.savedDestinationChanges[0]).toEqual(older)
  expect(checkpoint.before.changes[0].id).toBe(older.id)
  expect(value.record.localData.changes.some(change => change.id === older.id)).toBe(!olderChangeLeftWindow)
  const original = structuredClone({ record: value.record, checkpoint })
  expect(() => validateGuestPlannerRecord(value.record, value.declaration, [checkpoint], 'journaled')).toThrow()
  expect({ record: value.record, checkpoint }).toEqual(original)
})
it('keeps contradictory change values in an unlisted imported branch inert', () => {
  const value = tuple(), unlisted = structuredClone(value.history[1])
  Object.assign(unlisted, { id: 'unlisted-imported-branch', before: { ...unlisted.before, changes: [{ ...unlisted.before.changes[0], command: 'different imported value' }] } })
  const original = structuredClone(unlisted)
  const admitted = validateGuestPlannerRecord(value.record, value.declaration, [...value.history, unlisted], 'journaled')
  expect(admitted.format).toBe('journaled')
  if (admitted.format !== 'journaled') throw new Error('Expected journaled planner')
  expect(admitted.journal.checkpoints).toEqual(value.history)
  expect(admitted.journal.undoable).toBe(true)
  expect(unlisted).toEqual(original)
})

async function installedRows(database: CryKitDatabase): Promise<GuestPlannerInstallStagedRows> {
  return database.transaction('r', database.tables, async () => ({
    localDatas: await database.localDatas.toArray(), catalogs: await database.catalogs.toArray(),
    evidence: await database.evidence.toArray(), sources: await database.sources.toArray(),
    history: await database.history.toArray(), imports: await database.imports.toArray(), meta: await database.meta.toArray(),
  }))
}

async function installerFixture(includePackaged = false) {
  const imported = await previewImport(new TextEncoder().encode(JSON.stringify({ ID: 'journal-fixture', Title: 'Synthetic journal fixture', EditorVersion: 34, Items: [{ ID: 50, Name: 'Synthetic item' }] })), 'synthetic.json')
  const source = imported.proposed.sources[0]!
  const { bytes, ...metadata } = source
  const localData = createBlankLocalData()
  const after = changedLocalData(localData, localData, 'original import', nowTimestamp())
  const history = historyEntry(localData, after, 'original import', after.updatedAt)
  const planner: WorkspacePlannerState = {
    localData: after, lineage: { rootLocalDataId: localData.id }, catalogs: [...imported.proposed.catalogs, ...(includePackaged ? [BUNDLED_CATALOGS[0]!] : [])],
    sources: [{ ...metadata, original: { documentId: `source:${source.id}`, revisionId: source.digest, byteLength: bytes.byteLength, sha256: source.digest, encoding: 'bytes' } }],
    evidence: [{ id: 'inert-source-evidence', sourceDigest: source.digest, group: 'ignored', kind: 'synthetic', locator: '/synthetic', sources: [], payload: { quantity: null, formula: '<script>inert</script>', nested: [false, 'unchanged'] }, private: true }], history: [history],
  }
  const preparation = prepareGuestRestorePlanner(planner, planner, 'replace')
  const projection = requirePreparedGuestPlanner(preparation)
  const name = `installer-${crypto.randomUUID()}`
  names.push(name)
  const database = new CryKitDatabase(name)
  const foreign = createBlankLocalData()
  await database.localDatas.add({ id: 'retained-other-root', localData: foreign, revision: foreign.revision, updatedAt: foreign.updatedAt, lineage: { rootLocalDataId: foreign.id } })
  await database.sources.add(source)
  await database.evidence.bulkAdd([...planner.evidence])
  await database.history.bulkAdd([
    history,
    { ...projection.planner.history.at(-1)!, id: 'inert-coincident-endpoint', command: 'Imported matching endpoint' },
    { ...historyEntry(foreign, { ...foreign, revision: 1 }, 'Imported other root', foreign.updatedAt), id: 'inert-other-root' },
  ])
  await database.imports.add({ id: 'inert-import', sourceDigest: source.digest, localDataId: localData.id, importedAt: localData.updatedAt })
  await database.meta.add({ key: 'unrelated-meta', value: '{"unknown":null,"literal":"<script>inert</script>"}' })
  return { database, preparation, projection, planner, source, before: await installedRows(database) }
}

it('rolls back the complete staged table vector when ownership is lost after installer writes', async () => {
  const { database, preparation, before } = await installerFixture()
  let calls = 0
  let reachedWrites = false
  const completion = vi.fn()
  const notification = vi.fn()
  const unsubscribe = subscribeLocalData(notification)
  try {
    await expect(writePreparedGuestPlanner(database, preparation, { expectedStaged: before, assertOwned: () => {
      calls++
      if (calls === 3) { reachedWrites = true; throw new Error('ownership lost after writes') }
    } }).then(completion)).rejects.toThrow('ownership lost after writes')
    expect(reachedWrites).toBe(true)
    database.close()
    const reopened = new CryKitDatabase(database.name)
    try { expect(await installedRows(reopened)).toEqual(before) } finally { reopened.close() }
    expect(completion).not.toHaveBeenCalled()
    expect(notification).not.toHaveBeenCalled()
  } finally { unsubscribe(); database.close() }
})

it.each([false, true])('independently reopens an unselected install with exact inert evidence and reset membership, catalog staged: %s', async catalogStaged => {
  const { database, preparation, projection, planner, before } = await installerFixture()
  const originalPlanner = structuredClone(planner)
  const catalog = projection.planner.catalogs[0]!
  const storedCatalog = { key: JSON.stringify([catalog.id, catalog.revisionId]), id: catalog.id, revisionId: catalog.revisionId, checksum: catalog.checksum, snapshot: catalog }
  if (catalogStaged) await database.catalogs.add(storedCatalog)
  const staged = await installedRows(database)
  // Keyed vectors admit caller ordering, without permitting duplicate or changed rows
  const expectedStaged = { ...staged, localDatas: [...staged.localDatas].reverse(), history: [...staged.history].reverse() }
  try {
    expect(() => Object.assign(projection.record.operativePlanner, { localDataId: 'wrong-domain' })).toThrow()
    Object.assign(planner.localData, { revision: 900 })
    await writePreparedGuestPlanner(database, preparation, { expectedStaged, assertOwned: () => {} })
  } finally { database.close() }
  const reopened = new CryKitDatabase(database.name)
  try {
    const rows = await installedRows(reopened)
    const root = (await reopened.localDatas.get('local-data-record'))!
    const declaration = (await reopened.meta.get(GUEST_PLANNER_LAYOUT_KEY))!
    const admitted = validateGuestPlannerRecord(root, declaration, rows.history, 'journaled')
    expect(root).toEqual(projection.record)
    expect(declaration).toEqual(projection.declaration)
    expect(root.localData.revision).toBe(2)
    expect(root.id).not.toBe(root.localData.id)
    expect(admitted).toMatchObject({ format: 'journaled', journal: { undoable: false, checkpoints: [] } })
    expect(rows.history).toEqual(expect.arrayContaining([...projection.planner.history]))
    expect(rows.history).toEqual(expect.arrayContaining([...before.history]))
    expect(rows.history).toHaveLength(projection.planner.history.length + 2)
    expect(rows.localDatas).toEqual(expect.arrayContaining([...before.localDatas]))
    expect(rows.catalogs).toEqual([storedCatalog])
    expect(rows.sources).toEqual(before.sources)
    expect(rows.evidence).toEqual(before.evidence)
    expect(rows.imports).toEqual(before.imports)
    expect(rows.meta).toEqual(expect.arrayContaining([...before.meta]))
    expect(projection.resolved).toEqual(originalPlanner)
    expect(reopened.verno).toBe(7)
  } finally { reopened.close() }
})

it.each(['spread', 'clone', 'json'] as const)('rejects a %s preparation copy without target writes', async kind => {
  const { database, preparation, before } = await installerFixture()
  const copy = kind === 'spread' ? { ...preparation } : kind === 'clone' ? structuredClone(preparation) : JSON.parse(JSON.stringify(preparation))
  try {
    await expect(writePreparedGuestPlanner(database, copy, { expectedStaged: before, assertOwned: () => {} })).rejects.toThrow('Unregistered')
    expect(await installedRows(database)).toEqual(before)
  } finally { database.close() }
})

it.each(['root', 'declaration'] as const)('rejects an existing foreign %s even when expected by the caller', async kind => {
  const { database, preparation } = await installerFixture()
  if (kind === 'root') {
    const foreign = createBlankLocalData()
    await database.localDatas.add({ id: 'local-data-record', localData: foreign, revision: foreign.revision, updatedAt: foreign.updatedAt, lineage: { rootLocalDataId: foreign.id } })
  } else await database.meta.add({ key: GUEST_PLANNER_LAYOUT_KEY, value: '{"foreign":true}' })
  const before = await installedRows(database)
  try {
    await expect(writePreparedGuestPlanner(database, preparation, { expectedStaged: before, assertOwned: () => {} })).rejects.toThrow()
    expect(await installedRows(database)).toEqual(before)
  } finally { database.close() }
})

it.each(['localDatas', 'catalogs', 'evidence', 'sources', 'history', 'imports', 'meta'] as const)('rejects a changed %s staging vector before any installer write', async table => {
  const { database, preparation, before, projection } = await installerFixture()
  if (table === 'catalogs') {
    const snapshot = projection.planner.catalogs[0]!
    await database.catalogs.add({ key: JSON.stringify([snapshot.id, snapshot.revisionId]), id: snapshot.id, revisionId: snapshot.revisionId, checksum: snapshot.checksum, snapshot })
  } else if (table === 'sources') {
    const source = before.sources[0]!
    const bytes = source.bytes.slice(); bytes[0] ^= 1
    await database.sources.put({ ...source, bytes })
  } else await database.table(table).delete((before[table][0] as { id?: string; key?: string }).id ?? (before[table][0] as { key: string }).key)
  const changed = await installedRows(database)
  try {
    await expect(writePreparedGuestPlanner(database, preparation, { expectedStaged: before, assertOwned: () => {} })).rejects.toThrow('staged')
    expect(await installedRows(database)).toEqual(changed)
  } finally { database.close() }
})

it.each(['history-domain', 'catalog', 'evidence', 'source-metadata', 'missing-source', 'missing-evidence'] as const)('rejects %s that contradicts the registered projection despite matching staged expectations', async kind => {
  const { database, preparation, projection, before } = await installerFixture()
  if (kind === 'history-domain') await database.history.put({ ...before.history[0]!, localDataId: before.localDatas[0]!.localData.id })
  if (kind === 'catalog') {
    const snapshot = projection.planner.catalogs[0]!
    await database.catalogs.add({ key: JSON.stringify([snapshot.id, snapshot.revisionId]), id: snapshot.id, revisionId: snapshot.revisionId, checksum: 'changed', snapshot })
  }
  if (kind === 'evidence') await database.evidence.put({ ...before.evidence[0]!, payload: { changed: true } })
  if (kind === 'source-metadata') await database.sources.put({ ...before.sources[0]!, filename: 'changed.json' })
  if (kind === 'missing-source') await database.sources.clear()
  if (kind === 'missing-evidence') await database.evidence.clear()
  const staged = await installedRows(database)
  try {
    await expect(writePreparedGuestPlanner(database, preparation, { expectedStaged: staged, assertOwned: () => {} })).rejects.toThrow()
    expect(await installedRows(database)).toEqual(staged)
  } finally { database.close() }
})

it.each([1, 2])('honors cancellation at ownership check %s without losing earlier staging', async stopAt => {
  const { database, preparation, before } = await installerFixture()
  let calls = 0
  try {
    await expect(writePreparedGuestPlanner(database, preparation, { expectedStaged: before, assertOwned: () => {
      if (++calls === stopAt) throw new Error('cancelled')
    } })).rejects.toThrow('cancelled')
    expect(await installedRows(database)).toEqual(before)
  } finally { database.close() }
})

it.each(['catalogs', 'history', 'meta', 'localDatas'] as const)('rolls back every table after the %s native write fails', async tableName => {
  const { database, preparation, before } = await installerFixture()
  database.close()
  let reachedWrite = false
  database.use({ stack: 'dbcore', name: 'installer-write-fault', create: core => ({ ...core, table: name => {
    const table = core.table(name)
    return name === tableName ? { ...table, mutate: async request => {
      const result = await table.mutate(request)
      reachedWrite = true
      throw new Error(`fault after ${tableName} write: ${result.numFailures}`)
    } } : table
  } }) })
  await database.open()
  try {
    await expect(writePreparedGuestPlanner(database, preparation, { expectedStaged: before, assertOwned: () => {} })).rejects.toThrow(`fault after ${tableName}`)
    expect(reachedWrite).toBe(true)
    expect(await installedRows(database)).toEqual(before)
  } finally { database.close() }
})

it('propagates native transaction abort at the final ownership boundary', async () => {
  const { database, preparation, before } = await installerFixture()
  let calls = 0
  try {
    await expect(writePreparedGuestPlanner(database, preparation, { expectedStaged: before, assertOwned: () => {
      if (++calls === 3) Dexie.currentTransaction!.abort()
    } })).rejects.toThrow()
    expect(await installedRows(database)).toEqual(before)
  } finally { database.close() }
})

it('does not let the ownership callback replace captured staging expectations', async () => {
  const { database, preparation, before } = await installerFixture()
  await database.meta.put({ ...before.meta[0]!, value: 'changed after snapshot' })
  const changed = await installedRows(database)
  try {
    await expect(writePreparedGuestPlanner(database, preparation, { expectedStaged: before, assertOwned: () => {
      Object.assign(before, { meta: changed.meta })
    } })).rejects.toThrow('staged')
    expect(await installedRows(database)).toEqual(changed)
  } finally { database.close() }
})

it('rejects duplicate staged keys instead of collapsing caller expectations', async () => {
  const { database, preparation, before } = await installerFixture()
  try {
    await expect(writePreparedGuestPlanner(database, preparation, { expectedStaged: { ...before, meta: [...before.meta, before.meta[0]!] }, assertOwned: () => {} })).rejects.toThrow('Duplicate')
    expect(await installedRows(database)).toEqual(before)
  } finally { database.close() }
})

it('preserves an existing participant barrier and does not bypass its write denial', async () => {
  const { database, preparation } = await installerFixture()
  const { acquireParticipantBarrier, GUEST_BARRIER_KEY } = await import('../workspace/guest-barrier')
  await acquireParticipantBarrier(database, 'synthetic-prior-owner')
  const before = await installedRows(database)
  try {
    await expect(writePreparedGuestPlanner(database, preparation, { expectedStaged: before, assertOwned: () => {} })).rejects.toThrow('retired')
    expect(await installedRows(database)).toEqual(before)
    expect(await database.meta.get(GUEST_BARRIER_KEY)).toEqual({ key: GUEST_BARRIER_KEY, value: 'synthetic-prior-owner' })
  } finally { database.close() }
})

const asynchronousOwnershipCases = [1, 2, 3].flatMap(boundary => ['async resolve', 'async reject', 'thenable resolve', 'thenable reject'].map(kind => ({ boundary, kind })))
it.each(asynchronousOwnershipCases)('rejects $kind ownership at boundary $boundary with independent rollback and no notification', async ({ boundary, kind }) => {
  const { database, preparation, before } = await installerFixture()
  const notification = vi.fn()
  const completion = vi.fn()
  const unsubscribe = subscribeLocalData(notification)
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  let calls = 0
  try {
    const outcome = await writePreparedGuestPlanner(database, preparation, { expectedStaged: before, assertOwned: () => {
      if (++calls !== boundary) return
      if (kind.startsWith('async')) return (async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
        if (kind.endsWith('reject')) throw new Error('late ownership failure')
      })()
      return { then(resolve: () => void, reject: (reason: unknown) => void) {
        queueMicrotask(() => kind.endsWith('reject') ? reject(new Error('late thenable ownership failure')) : resolve())
      } }
    } }).then(() => { completion(); return undefined }, error => error as Error)
    // Let late callback rejection reach the host's unhandled-rejection boundary
    await new Promise(resolve => setTimeout(resolve, 0))
    database.close()
    const reopened = new CryKitDatabase(database.name)
    try { expect(await installedRows(reopened)).toEqual(before) } finally { reopened.close() }
    expect(outcome).toBeInstanceOf(Error)
    expect(outcome?.message).toContain('synchronous')
    expect(calls).toBe(boundary)
    expect(completion).not.toHaveBeenCalled()
    expect(notification).not.toHaveBeenCalled()
    expect(unhandled).toEqual([])
  } finally {
    process.off('unhandledRejection', onUnhandled)
    unsubscribe(); database.close()
  }
})

it.each(['wrapper checksum', 'wrapper identity', 'wrapper key', 'snapshot checksum', 'snapshot content'])('rejects a staged packaged catalog with changed %s without modifying any rows', async conflict => {
  const { database, preparation } = await installerFixture(true)
  const snapshot = BUNDLED_CATALOGS[0]!
  const row = { key: JSON.stringify([snapshot.id, snapshot.revisionId]), id: snapshot.id, revisionId: snapshot.revisionId, checksum: snapshot.checksum, snapshot }
  if (conflict === 'wrapper checksum') Object.assign(row, { checksum: 'changed' })
  if (conflict === 'wrapper identity') Object.assign(row, { id: 'foreign-catalog' })
  if (conflict === 'wrapper key') Object.assign(row, { key: 'foreign-key' })
  if (conflict === 'snapshot checksum') Object.assign(row, { snapshot: { ...snapshot, checksum: 'changed' } })
  if (conflict === 'snapshot content') Object.assign(row, { snapshot: { ...snapshot, legacy: { changed: true } } })
  await database.catalogs.add(row)
  const before = await installedRows(database)
  const notification = vi.fn()
  const unsubscribe = subscribeLocalData(notification)
  try {
    await expect(writePreparedGuestPlanner(database, preparation, { expectedStaged: before, assertOwned: () => {} })).rejects.toThrow('Immutable')
    database.close()
    const reopened = new CryKitDatabase(database.name)
    try { expect(await installedRows(reopened)).toEqual(before) } finally { reopened.close() }
    expect(notification).not.toHaveBeenCalled()
  } finally { unsubscribe(); database.close() }
})

it.each([false, true])('installs with an exact packaged catalog staged: %s while preserving an unrelated catalog', async staged => {
  const { database, preparation } = await installerFixture(true)
  const snapshot = BUNDLED_CATALOGS[0]!, unrelated = BUNDLED_CATALOGS[1]!
  const row = { key: JSON.stringify([snapshot.id, snapshot.revisionId]), id: snapshot.id, revisionId: snapshot.revisionId, checksum: snapshot.checksum, snapshot }
  const unrelatedRow = { key: JSON.stringify([unrelated.id, unrelated.revisionId]), id: unrelated.id, revisionId: unrelated.revisionId, checksum: unrelated.checksum, snapshot: unrelated }
  await database.catalogs.add(unrelatedRow)
  if (staged) await database.catalogs.add(row)
  const before = await installedRows(database)
  try {
    await writePreparedGuestPlanner(database, preparation, { expectedStaged: before, assertOwned: () => {} })
  } finally { database.close() }
  const reopened = new CryKitDatabase(database.name)
  try {
    expect(await reopened.catalogs.get(row.key)).toEqual(staged ? row : undefined)
    expect(await reopened.catalogs.get(unrelatedRow.key)).toEqual(unrelatedRow)
    const rows = await installedRows(reopened)
    const root = (await reopened.localDatas.get('local-data-record'))!
    const declaration = await reopened.meta.get(GUEST_PLANNER_LAYOUT_KEY)
    expect(validateGuestPlannerRecord(root, declaration, rows.history, 'journaled')).toMatchObject({ format: 'journaled', journal: { undoable: false, checkpoints: [] } })
  } finally { reopened.close() }
})


const INVALID_JOURNAL = 'The journaled planner data is missing or invalid. Keep your draft and reopen the workspace'
const journalError = (message = INVALID_JOURNAL) => ({ code: 'schema-mismatch', userMessage: message, recoverable: true })

async function journalFixture(undoable = false) {
  const fixture = await installerFixture(true)
  await writePreparedGuestPlanner(fixture.database, fixture.preparation, { expectedStaged: fixture.before, assertOwned: () => {} })
  const preview = await previewImport(new TextEncoder().encode(JSON.stringify({ ID: 'direct-guard', Title: 'Direct guard', EditorVersion: 34, Items: [{ ID: 51, Name: 'Guard item' }] })), 'guard.json')
  let record = (await fixture.database.localDatas.get('local-data-record'))!
  if (undoable) {
    const after = changedLocalData(record.localData, record.localData, 'destination edit', nowTimestamp())
    const entry = historyEntry(record.localData, after, 'destination edit', after.updatedAt)
    record = { ...record, localData: after, revision: after.revision, updatedAt: after.updatedAt, operativePlanner: { ...record.operativePlanner!, revision: after.revision, checkpointIds: [entry.id], savedDestinationChanges: after.changes, undoable: true } }
    await fixture.database.transaction('rw', fixture.database.localDatas, fixture.database.history, async () => {
      await fixture.database.history.add(entry)
      await fixture.database.localDatas.put(record)
    })
  }
  const catalog = BUNDLED_CATALOGS[0]!
  await fixture.database.catalogs.put({ key: JSON.stringify([catalog.id, catalog.revisionId]), id: catalog.id, revisionId: catalog.revisionId, checksum: catalog.checksum, snapshot: catalog })
  fixture.database.close()
  const database = new CryKitDatabase(fixture.database.name, { plannerFormatRequirement: 'journaled' })
  // Admission assertions begin only after the synthetic native layout-6 database has opened
  await database.open()
  return { ...fixture, database, record, preview }
}

async function unchangedJournal(database: CryKitDatabase, operation: () => Promise<unknown>, error: object) {
  const before = await installedRows(database), notifications: unknown[] = []
  const unsubscribe = subscribeLocalData(value => notifications.push(value))
  let actual: unknown
  try { await operation() } catch (failure) { actual = failure }
  finally { unsubscribe() }
  const reopened = new CryKitDatabase(database.name)
  await reopened.open()
  try {
    expect.soft(notifications).toEqual([])
    expect.soft(actual).toMatchObject(error)
    expect(await installedRows(reopened)).toEqual(before)
  } finally { reopened.close(); database.close(); setDatabaseForTests(undefined) }
}

it('loads an already-open installed journal readonly without promoting inert undo or deleting packaged rows', async () => {
  const { database: original, record } = await journalFixture()
  const before = await installedRows(original), notifications: unknown[] = []
  const unsubscribe = subscribeLocalData(value => notifications.push(value))
  const modes: IDBTransactionMode[] = []
  // Required handles are terminal after close; install observation on a fresh handle before its first open
  original.close()
  const database = new CryKitDatabase(original.name, { plannerFormatRequirement: 'journaled' })
  database.use({ stack: 'dbcore', name: 'journal-read-modes', create: core => ({ ...core, transaction: (...args) => { modes.push(args[1]); return core.transaction(...args) } }) })
  await database.open()
  modes.length = 0
  const loaded = await loadLocalData(database)
  expect.soft(modes).toEqual(['readonly'])
  unsubscribe()
  const reopened = new CryKitDatabase(database.name)
  await reopened.open()
  try {
    expect(await installedRows(reopened)).toEqual(before)
    expect(loaded.canUndo).toBe(false)
    expect(loaded.localData).toEqual(record.localData)
    expect(loaded.lineage).toEqual(record.lineage)
    expect(notifications).toEqual([])
    Object.assign(loaded.localData, { revision: 999 })
    expect(await installedRows(reopened)).toEqual(before)
  } finally { database.close(); reopened.close() }
})

it('loads declared undoable membership and does not validate inert imported branches as authority', async () => {
  const { database } = await journalFixture(true)
  await database.history.put({ ...(await database.history.get('inert-coincident-endpoint'))!, after: { invalid: true } } as never)
  const loaded = await loadLocalData(database)
  expect(loaded.canUndo).toBe(true)
  database.close()
})

it('saves the first genuine destination edit after restore without adopting imported checkpoints', async () => {
  const { database, record } = await journalFixture()
  const before = await installedRows(database)
  const draft = createPersonalDefinition(record.localData, { kind: 'item', name: 'Synthetic destination item', expectedRevision: record.revision })
  const saved = await saveLocalDataWithStatus(draft, record.revision, database)
  expect(saved.localData.revision).toBe(record.revision + 1)
  expect(saved.canUndo).toBe(true)
  database.close()
  const reopened = new CryKitDatabase(database.name, { plannerFormatRequirement: 'journaled' })
  try {
    const rows = await installedRows(reopened)
    const root = (await reopened.localDatas.get('local-data-record'))!
    const journal = validateGuestPlannerRecord(root, await reopened.meta.get(GUEST_PLANNER_LAYOUT_KEY), rows.history, 'journaled')
    expect(journal.format).toBe('journaled')
    if (journal.format !== 'journaled') throw new Error('Expected journaled planner')
    expect(journal.journal.checkpoints).toHaveLength(1)
    expect(journal.journal.checkpoints[0]!.before).toEqual(record.localData)
    expect(journal.journal.checkpoints[0]!.after).toEqual(saved.localData)
    expect(journal.descriptor.checkpointIds).toEqual([journal.journal.checkpoints[0]!.id])
    for (const row of before.history) expect(rows.history).toContainEqual(row)
  } finally { reopened.close() }
})

it('reopens a journaled save with an unknown inventory quantity and exact operative endpoints', async () => {
  const { database, record } = await journalFixture()
  const beforeCatalogs = await database.catalogs.toArray()
  const playthrough = createPlaythrough(record.localData, { label: 'Unknown stock', expectedRevision: record.revision })
  const defined = createPersonalDefinition(playthrough, { kind: 'item', name: 'Uncounted item', expectedRevision: playthrough.revision })
  const definitionId = Object.values(defined.personalDefinitions)[0]!.id
  const draft = observeInventory(defined, {
    ref: { kind: 'personal', definitionId },
    possession: 'unknown', quantity: { kind: 'unknown' }, expectedRevision: defined.revision,
  })
  const saved = await saveLocalDataWithStatus(draft, record.revision, database)
  database.close()
  const reopened = new CryKitDatabase(database.name, { plannerFormatRequirement: 'journaled' })
  try {
    const rows = await installedRows(reopened)
    const root = (await reopened.localDatas.get('local-data-record'))!
    const admitted = validateGuestPlannerRecord(root, await reopened.meta.get(GUEST_PLANNER_LAYOUT_KEY), rows.history, 'journaled')
    expect(admitted.format).toBe('journaled')
    if (admitted.format !== 'journaled') throw new Error('Expected journaled planner')
    expect(root.localData).toEqual(saved.localData)
    expect(admitted.journal.checkpoints).toHaveLength(1)
    const checkpoint = admitted.journal.checkpoints[0]!
    expect(root.operativePlanner!.checkpointIds).toEqual([checkpoint.id])
    expect(checkpoint.before).toEqual(record.localData)
    expect(checkpoint.after).toEqual(saved.localData)
    expect(rows.catalogs).toEqual(beforeCatalogs)
    expect(Object.values(root.localData.playthroughs)[0]!.inventory).toEqual(Object.values(draft.playthroughs)[0]!.inventory)
    expect(Object.values(Object.values(root.localData.playthroughs)[0]!.inventory)[0]!.quantity).toEqual({ kind: 'unknown' })
    expect((await loadLocalData(reopened)).localData).toEqual(saved.localData)
  } finally { reopened.close() }
})

it('reopens a journaled save with a recognized withdrawn pin without substituting a catalog', async () => {
  const { database, record } = await journalFixture()
  const beforeCatalogs = await database.catalogs.toArray()
  const receipt = WITHDRAWN_CATALOGS[0]!
  const draft = addGameSetupRevision(record.localData, {
    label: 'Unavailable historical catalog', catalogLock: { [receipt.id]: receipt.revisionId }, expectedRevision: record.revision,
  })
  const saved = await saveLocalDataWithStatus(draft, record.revision, database)
  database.close()
  const reopened = new CryKitDatabase(database.name, { plannerFormatRequirement: 'journaled' })
  try {
    const rows = await installedRows(reopened)
    const root = (await reopened.localDatas.get('local-data-record'))!
    const admitted = validateGuestPlannerRecord(root, await reopened.meta.get(GUEST_PLANNER_LAYOUT_KEY), rows.history, 'journaled')
    expect(admitted.format).toBe('journaled')
    if (admitted.format !== 'journaled') throw new Error('Expected journaled planner')
    expect(root.localData).toEqual(saved.localData)
    expect(admitted.journal.checkpoints).toHaveLength(1)
    const checkpoint = admitted.journal.checkpoints[0]!
    expect(root.operativePlanner!.checkpointIds).toEqual([checkpoint.id])
    expect(checkpoint.before).toEqual(record.localData)
    expect(checkpoint.after).toEqual(saved.localData)
    expect(root.localData.gameSetups[draft.planningGameSetupRevisionId!]!.catalogLock[receipt.id]).toBe(receipt.revisionId)
    expect(rows.catalogs).toEqual(beforeCatalogs)
    expect(rows.catalogs.some(row => row.id === receipt.id && row.revisionId === receipt.revisionId)).toBe(false)
    const loaded = await loadLocalData(reopened)
    expect(loaded.localData).toEqual(saved.localData)
    expect(loaded.catalogs.some(catalog => catalog.id === receipt.id && catalog.revisionId === receipt.revisionId)).toBe(false)
  } finally { reopened.close() }
})

it('records every supplied transition and its exact paths in one journaled save', async () => {
  const { database, record } = await journalFixture()
  const first = createPersonalDefinition(record.localData, { kind: 'item', name: 'Synthetic first item', expectedRevision: record.revision })
  const second = createPersonalDefinition(first, { kind: 'item', name: 'Synthetic second item', expectedRevision: first.revision })
  const appended = second.changes.slice(-2)
  try {
    const saved = await saveLocalDataWithStatus(second, record.revision, database)
    expect(saved.localData.revision).toBe(record.revision + 2)
    const root = (await database.localDatas.get('local-data-record'))!
    expect(root.operativePlanner!.savedDestinationChanges.slice(-2)).toEqual(appended)
    const member = (await database.history.get(root.operativePlanner!.checkpointIds.at(-1)!))!
    expect(member.before).toEqual(record.localData)
    expect(member.after.changes.slice(-2)).toEqual(appended)
  } finally { database.close() }
})

it('accepts a supplied transition ending at the largest safe revision', async () => {
  const { database, record } = await journalFixture()
  const nearLimit = { ...record.localData, revision: Number.MAX_SAFE_INTEGER - 1, changes: [] }
  await database.localDatas.put({ ...record, localData: nearLimit, revision: nearLimit.revision, operativePlanner: { ...record.operativePlanner!, revision: nearLimit.revision } })
  const draft = changedLocalData(nearLimit, nearLimit, 'last safe edit', nowTimestamp())
  try {
    const saved = await saveLocalDataWithStatus(draft, nearLimit.revision, database)
    expect(saved.localData.revision).toBe(Number.MAX_SAFE_INTEGER)
    expect(saved.canUndo).toBe(true)
  } finally { database.close() }
})

it('preserves admitted destination evidence older than the live change window', async () => {
  const { database, record } = await journalFixture()
  const older = record.localData.changes[0]!
  const shortened = { ...record.localData, changes: record.localData.changes.slice(1) }
  await database.localDatas.put({ ...record, localData: shortened })
  const draft = changedLocalData(shortened, shortened, 'later destination edit', nowTimestamp())
  try {
    await saveLocalDataWithStatus(draft, record.revision, database)
    const root = (await database.localDatas.get('local-data-record'))!
    expect(root.operativePlanner!.savedDestinationChanges[0]).toEqual(older)
    expect(root.operativePlanner!.savedDestinationChanges.at(-1)).toEqual(draft.changes.at(-1))
  } finally { database.close() }
})

it.each(['missing transition', 'duplicate identity', 'changed shared entry', 'unsafe revision'] as const)('rejects a journaled draft with %s without touching saved rows', async kind => {
  const { database, record } = await journalFixture()
  const first = changedLocalData(record.localData, record.localData, 'first edit', nowTimestamp())
  const second = changedLocalData(first, first, 'second edit', nowTimestamp())
  let draft = second
  if (kind === 'missing transition') draft = { ...second, changes: second.changes.filter(change => change.id !== first.changes.at(-1)!.id) }
  if (kind === 'duplicate identity') draft = { ...second, changes: [...second.changes, second.changes.at(-1)!] }
  if (kind === 'changed shared entry') draft = { ...second, changes: second.changes.map(change => change.id === record.localData.changes[0]!.id ? { ...change, changedPaths: ['other-path'] } : change) }
  if (kind === 'unsafe revision') draft = { ...second, revision: Number.MAX_SAFE_INTEGER + 1 }
  const original = structuredClone(draft)
  await unchangedJournal(database, () => saveLocalDataWithStatus(draft, record.revision, database), journalError('The journaled draft is missing complete destination change history. Keep your draft and reopen the workspace'))
  expect(draft).toEqual(original)
})

it('rolls back a journaled checkpoint and root when the root write fails after storing it', async () => {
  const { database, record } = await journalFixture()
  const before = await installedRows(database)
  const draft = changedLocalData(record.localData, record.localData, 'atomic edit', nowTimestamp())
  const put = database.localDatas.put.bind(database.localDatas)
  const fault = vi.spyOn(database.localDatas, 'put').mockImplementation((...args) => put(...args).then(() => { throw new Error('injected after root write') }))
  const notifications: unknown[] = [], unsubscribe = subscribeLocalData(value => notifications.push(value))
  try { await expect(saveLocalDataWithStatus(draft, record.revision, database)).rejects.toMatchObject({ code: 'storage-failure' }) }
  finally { fault.mockRestore(); unsubscribe(); database.close() }
  const reopened = new CryKitDatabase(database.name, { plannerFormatRequirement: 'journaled' })
  try {
    expect(await installedRows(reopened)).toEqual(before)
    expect(notifications).toEqual([])
  } finally { reopened.close() }
})

it('rolls back a composed catalog write with the journaled root and checkpoint', async () => {
  const { database, record } = await journalFixture()
  const before = await installedRows(database)
  const baseline = BUNDLED_CATALOGS[0]!
  const draft = addGameSetupRevision(record.localData, {
    label: 'Synthetic composed setup', expectedRevision: record.revision,
    modComposition: { baseline: { catalogId: baseline.id, catalogRevisionId: baseline.revisionId }, layers: [], links: [] },
  })
  const bulkPut = database.catalogs.bulkPut.bind(database.catalogs)
  let reachedCatalogWrite = false
  const fault = vi.spyOn(database.catalogs, 'bulkPut').mockImplementation((...args) => bulkPut(...args).then(() => {
    reachedCatalogWrite = true
    throw new Error('injected after composed catalog write')
  }))
  const notifications: unknown[] = [], unsubscribe = subscribeLocalData(value => notifications.push(value))
  try { await expect(saveLocalDataWithStatus(draft, record.revision, database)).rejects.toMatchObject({ code: 'storage-failure' }) }
  finally { fault.mockRestore(); unsubscribe(); database.close() }
  const reopened = new CryKitDatabase(database.name, { plannerFormatRequirement: 'journaled' })
  try {
    expect(reachedCatalogWrite).toBe(true)
    expect(await installedRows(reopened)).toEqual(before)
    expect(notifications).toEqual([])
  } finally { reopened.close() }
})

it('saves a composed catalog and its journaled Game Setup together', async () => {
  const { database, record } = await journalFixture()
  const baseline = BUNDLED_CATALOGS[0]!
  const draft = addGameSetupRevision(record.localData, {
    label: 'Synthetic composed setup', expectedRevision: record.revision,
    modComposition: { baseline: { catalogId: baseline.id, catalogRevisionId: baseline.revisionId }, layers: [], links: [] },
  })
  try {
    const saved = await saveLocalDataWithStatus(draft, record.revision, database)
    const loaded = await loadLocalData(database)
    expect(loaded.localData).toEqual(saved.localData)
    expect(loaded.catalogs.some(catalog => catalog.revisionId === draft.gameSetups[draft.planningGameSetupRevisionId!]!.catalogLock[baseline.id])).toBe(true)
    expect(loaded.canUndo).toBe(true)
  } finally { database.close() }
})

it('commits one complete journal when independent handles save the same revision', async () => {
  const { database, record } = await journalFixture()
  const other = new CryKitDatabase(database.name, { plannerFormatRequirement: 'journaled' })
  await other.open()
  const first = changedLocalData(record.localData, record.localData, 'first contender', nowTimestamp())
  const second = changedLocalData(record.localData, record.localData, 'second contender', nowTimestamp())
  const outcomes = await Promise.allSettled([
    saveLocalDataWithStatus(first, record.revision, database),
    saveLocalDataWithStatus(second, record.revision, other),
  ])
  database.close(); other.close()
  const reopened = new CryKitDatabase(database.name, { plannerFormatRequirement: 'journaled' })
  try {
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toMatchObject([{ reason: { code: 'revision-conflict', recoverable: true } }])
    const root = (await reopened.localDatas.get('local-data-record'))!
    const journal = validateGuestPlannerRecord(root, await reopened.meta.get(GUEST_PLANNER_LAYOUT_KEY), await reopened.history.toArray(), 'journaled')
    expect(journal.format).toBe('journaled')
    if (journal.format !== 'journaled') throw new Error('Expected journaled planner')
    expect(journal.journal.checkpoints).toHaveLength(1)
    expect(journal.journal.checkpoints[0]!.before).toEqual(record.localData)
    expect(journal.journal.checkpoints[0]!.after).toEqual(root.localData)
  } finally { reopened.close() }
})

it('shows a reader one complete old or new tuple while a journaled save is between history add and root put', async () => {
  const { database, record } = await journalFixture()
  const reader = new CryKitDatabase(database.name, { plannerFormatRequirement: 'journaled' })
  await reader.open()
  const draft = createPersonalDefinition(record.localData, { kind: 'item', name: 'Interleaved item', expectedRevision: record.revision })
  const add = database.history.add.bind(database.history)
  let read: Promise<Awaited<ReturnType<typeof loadLocalData>>> | undefined
  const hooked = vi.spyOn(database.history, 'add').mockImplementation((...args) => add(...args).then(id => {
    // Start the independent native read after history.add but before the save can put its root
    read = Dexie.ignoreTransaction(() => loadLocalData(reader))
    return id
  }))
  try {
    const saved = await saveLocalDataWithStatus(draft, record.revision, database)
    expect(read).toBeDefined()
    const observed = await read!
    if (observed.localData.revision === record.revision) {
      expect(observed.localData).toEqual(record.localData)
      expect(observed.canUndo).toBe(false)
    } else {
      expect(observed.localData).toEqual(saved.localData)
      expect(observed.canUndo).toBe(true)
    }
    const root = (await reader.localDatas.get('local-data-record'))!
    const admitted = validateGuestPlannerRecord(root, await reader.meta.get(GUEST_PLANNER_LAYOUT_KEY), await reader.history.toArray(), 'journaled')
    expect(admitted.format).toBe('journaled')
    if (admitted.format !== 'journaled') throw new Error('Expected journaled planner')
    expect(admitted.journal.checkpoints).toHaveLength(1)
    expect(admitted.journal.checkpoints[0]!.before).toEqual(record.localData)
    expect(admitted.journal.checkpoints[0]!.after).toEqual(saved.localData)
  } finally { hooked.mockRestore(); database.close(); reader.close() }
})

const persistedMalformed: readonly [string, (value: ReturnType<typeof tuple>) => void][] = malformed.filter(([name]) => !['changed same-id row', 'duplicate physical row'].includes(name))
it.each(persistedMalformed)('denies persisted journal %s without cleanup or fallback', async (_name, mutate) => {
  const { database } = await journalFixture()
  const value = tuple(); mutate(value)
  await database.localDatas.clear()
  await database.localDatas.put(value.record)
  await database.meta.delete(GUEST_PLANNER_LAYOUT_KEY)
  if (value.declaration) await database.meta.put(value.declaration)
  await database.history.clear()
  await database.history.bulkPut(value.history)
  await unchangedJournal(database, () => loadLocalData(database), journalError())
})

it.each(['root', 'descriptor', 'declaration', 'both', 'undefined descriptor', 'disabled missing member'] as const)('rejects required %s absence before legacy fallback', async kind => {
  const { database, record } = await journalFixture(kind === 'disabled missing member')
  if (kind === 'root') await database.localDatas.delete('local-data-record')
  if (kind === 'descriptor' || kind === 'both') {
    const { operativePlanner: _descriptor, ...legacy } = record
    await database.localDatas.put(legacy)
  }
  if (kind === 'undefined descriptor') await database.localDatas.put({ ...record, operativePlanner: undefined })
  if (kind === 'declaration' || kind === 'both') await database.meta.delete(GUEST_PLANNER_LAYOUT_KEY)
  if (kind === 'disabled missing member') {
    await database.localDatas.put({ ...record, operativePlanner: { ...record.operativePlanner!, undoable: false } })
    await database.history.delete(record.operativePlanner!.checkpointIds[0]!)
  }
  await unchangedJournal(database, () => loadLocalData(database), journalError())
})

it.each(['missing canonical', 'marked fallback', 'undefined fallback'] as const)('default mode refuses %s journal markers', async kind => {
  const { database, record } = await journalFixture()
  const name = database.name; database.close()
  const ordinary = new CryKitDatabase(name); await ordinary.open()
  await ordinary.localDatas.delete('local-data-record')
  if (kind !== 'missing canonical') {
    await ordinary.meta.delete(GUEST_PLANNER_LAYOUT_KEY)
    await ordinary.localDatas.put({ ...record, id: 'marked-fallback', ...(kind === 'undefined fallback' ? { operativePlanner: undefined } : {}) })
  }
  await unchangedJournal(ordinary, () => loadLocalData(ordinary), journalError())
})

it.each([false, true])('saves an equal-revision journaled draft with retainHistory=%s', async retain => {
  const { database, record } = await journalFixture()
  const draft = structuredClone(record.localData), before = structuredClone(draft)
  const saved = await saveLocalDataWithStatus(draft, record.revision, database, retain)
  try {
    expect(saved.localData.revision).toBe(record.revision + 1)
    expect(saved.canUndo).toBe(true)
    expect(draft).toEqual(before)
  } finally { database.close() }
})
it.each([false, true])('undoes only declared destination members and preserves the journal with retainHistory=%s', async retain => {
  const { database, record } = await journalFixture()
  const draft = createPersonalDefinition(record.localData, { kind: 'item', name: 'Destination item', expectedRevision: record.revision })
  const saved = await saveLocalDataWithStatus(draft, record.revision, database)
  const member = (await database.history.get((await database.localDatas.get('local-data-record'))!.operativePlanner!.checkpointIds.at(-1)!))!
  // An exact imported endpoint with a conflicting before must never become Undo authority
  await database.history.add({ ...member, id: 'zz-inert-undo-collision', before: { ...member.before, personalDefinitions: saved.localData.personalDefinitions } })
  const before = await installedRows(database)
  const undone = await undoLocalDataWithStatus(saved.localData.revision, database, retain)
  expect(undone.localData.personalDefinitions).toEqual(record.localData.personalDefinitions)
  expect(undone.localData.id).toBe(record.localData.id)
  expect(undone.localData.revision).toBe(saved.localData.revision + 1)
  expect(undone.canUndo).toBe(true)
  database.close()
  const reopened = new CryKitDatabase(database.name, { plannerFormatRequirement: 'journaled' })
  try {
    const rows = await installedRows(reopened)
    const root = (await reopened.localDatas.get('local-data-record'))!
    const admitted = validateGuestPlannerRecord(root, await reopened.meta.get(GUEST_PLANNER_LAYOUT_KEY), rows.history, 'journaled')
    expect(admitted.format).toBe('journaled')
    expect(root.operativePlanner!.checkpointIds).toEqual([...before.localDatas.find(row => row.id === root.id)!.operativePlanner!.checkpointIds, rows.history.find(row => row.command === `undo:${member.command}`)!.id])
    expect(root.operativePlanner!.savedDestinationChanges).toEqual([...before.localDatas.find(row => row.id === root.id)!.operativePlanner!.savedDestinationChanges, undone.localData.changes.at(-1)!])
    for (const row of before.history) expect(rows.history).toContainEqual(row)
    expect((await loadLocalData(reopened)).canUndo).toBe(undone.canUndo)
  } finally { reopened.close() }
})
it('saves through the singleton facade', async () => {
  const { database, record } = await journalFixture(true)
  setDatabaseForTests(database)
  try { expect((await saveLocalData(record.localData, record.revision)).revision).toBe(record.revision + 1) }
  finally { database.close(); setDatabaseForTests(undefined) }
})
it('undoes through the singleton facade', async () => {
  const { database, record } = await journalFixture(true)
  setDatabaseForTests(database)
  try { expect((await undoLocalData(record.revision)).revision).toBe(record.revision + 1) }
  finally { database.close(); setDatabaseForTests(undefined) }
})
it.each([false, true])('returns no undo for restored membership even with an exact inert endpoint: %s', async retain => {
  const { database, record } = await journalFixture()
  await unchangedJournal(database, () => undoLocalDataWithStatus(record.revision, database, retain), { code: 'not-found', userMessage: 'There is no saved change to undo', recoverable: true })
})

it.each(['default', 'replace', 'add-reference', 'no-op', 'inclusion'] as const)('denies direct import %s including advertised no-op success', async mode => {
  const { database, record, preview } = await journalFixture()
  if (mode === 'no-op' || mode === 'inclusion') await database.localDatas.put({ ...record, localData: { ...record.localData, importReceipts: preview.proposed.localData.importReceipts, referenceLibrary: { version: 1, excludedMods: mode === 'inclusion' ? [preview.proposed.catalogs[0]!.id] : [] } } })
  const original = structuredClone(preview)
  const options = { ...(mode === 'default' ? {} : { mode: mode === 'replace' ? 'replace' as const : 'add-reference' as const }), expectedRevision: record.revision, ...(mode === 'inclusion' ? { includeModInReference: preview.proposed.catalogs[0]!.id } : {}) }
  await unchangedJournal(database, () => commitImport(preview, options, database), journalError('Direct imports are not supported for this journaled planner'))
  expect(preview).toEqual(original)
})
it.each([false, true])('denies direct mod setup including skip=%s', async skip => {
  const { database, record, preview } = await journalFixture()
  await database.catalogs.delete(JSON.stringify([BUNDLED_CATALOGS[0]!.id, BUNDLED_CATALOGS[0]!.revisionId]))
  const sample = createSampleLocalData(CURRENT_CATALOG)
  await database.localDatas.put({ ...record, localData: { ...record.localData, gameSetups: sample.gameSetups, planningGameSetupRevisionId: sample.planningGameSetupRevisionId } })
  const original = structuredClone(preview)
  await unchangedJournal(database, () => commitModSetup(skip ? [] : [preview], record.revision, skip, database), journalError('Direct mod setup is not supported for this journaled planner'))
  expect(preview).toEqual(original)
})

it.each(['save', 'undo', 'import', 'mod'] as const)('admits format before stale revision for %s', async operation => {
  for (const invalid of [false, true]) {
    const { database, record, preview } = await journalFixture(true)
    if (invalid) await database.meta.delete(GUEST_PLANNER_LAYOUT_KEY)
    const run = () => operation === 'save' ? saveLocalDataWithStatus(record.localData, record.revision - 1, database)
      : operation === 'undo' ? undoLocalDataWithStatus(record.revision - 1, database)
      : operation === 'import' ? commitImport(preview, { expectedRevision: record.revision - 1 }, database)
      : commitModSetup([], record.revision - 1, true, database)
    await unchangedJournal(database, run, invalid ? journalError() : { code: 'revision-conflict', recoverable: true })
  }
})
it('retains the import target guard after valid admission', async () => {
  const { database, preview } = await journalFixture()
  await unchangedJournal(database, () => commitImport(preview, { targetLocalDataId: 'different-target' as never }, database), { code: 'revision-conflict', userMessage: 'The import target changed. Reload before importing', recoverable: true })
})

it.each(['wrapper checksum', 'wrapper identity', 'wrapper key', 'snapshot checksum', 'snapshot content'] as const)('rejects contradictory packaged %s without deleting it', async kind => {
  const { database } = await journalFixture()
  const snapshot = BUNDLED_CATALOGS[0]!
  const row = { key: JSON.stringify([snapshot.id, snapshot.revisionId]), id: snapshot.id, revisionId: snapshot.revisionId, checksum: snapshot.checksum, snapshot }
  if (kind === 'wrapper checksum') row.checksum = 'changed'
  if (kind === 'wrapper identity') row.id = 'changed' as never
  if (kind === 'wrapper key') row.key = 'changed'
  if (kind === 'snapshot checksum') row.snapshot = { ...snapshot, checksum: 'changed' }
  if (kind === 'snapshot content') row.snapshot = { ...snapshot, legacy: { changed: true } }
  await database.catalogs.put(row)
  await unchangedJournal(database, () => loadLocalData(database), journalError())
})

it.each(['missing catalog', 'mismatched catalog', 'declared endpoint'] as const)('rejects a required %s graph after admitting a real tuple', async kind => {
  const { database, record, source, projection } = await journalFixture()
  const imported = await previewImport(source.bytes, source.filename)
  const catalog = projection.planner.catalogs.find(value => value.id !== BUNDLED_CATALOGS[0]!.id)!
  const sample = createSampleLocalData(CURRENT_CATALOG)
  const setupId = sample.planningGameSetupRevisionId!
  const setup = sample.gameSetups[setupId]!
  const data = { ...record.localData, gameSetups: { [setupId]: { ...setup, catalogLock: { ...setup.catalogLock, [catalog.id]: catalog.revisionId } } }, planningGameSetupRevisionId: setupId, importReceipts: imported.proposed.localData.importReceipts }
  await database.localDatas.put({ ...record, localData: data })
  const valid = await loadLocalData(database)
  expect(valid.evidence).toEqual(projection.planner.evidence)
  expect(valid.catalogs).toContainEqual(catalog)
  if (kind === 'missing catalog') await database.catalogs.delete(JSON.stringify([catalog.id, catalog.revisionId]))
  if (kind === 'mismatched catalog') await database.catalogs.update(JSON.stringify([catalog.id, catalog.revisionId]), { checksum: 'different-pin' })
  if (kind === 'declared endpoint') {
    const before = { ...data, gameSetups: { [setupId]: { ...data.gameSetups[setupId]!, catalogLock: { ...setup.catalogLock, [catalog.id]: 'missing-revision' as typeof catalog.revisionId } } } }
    const after = changedLocalData(before, data, 'destination edit', nowTimestamp())
    const checkpoint = historyEntry(before, after, 'destination edit', after.updatedAt)
    await database.history.add(checkpoint)
    await database.localDatas.put({ ...record, localData: after, revision: after.revision, updatedAt: after.updatedAt, operativePlanner: { ...record.operativePlanner!, revision: after.revision, checkpointIds: [checkpoint.id], savedDestinationChanges: after.changes, undoable: false } })
  }
  const current = (await database.localDatas.get('local-data-record'))!
  expect(validateGuestPlannerRecord(current, await database.meta.get(GUEST_PLANNER_LAYOUT_KEY), await database.history.toArray(), 'journaled').format).toBe('journaled')
  await unchangedJournal(database, () => loadLocalData(database), journalError())
})

// Pause before the real mutation transaction opens, after the public API's preliminary read has settled
// The competing handle commits through real IndexedDB transactions; no sleeping or mocked storage result supplies the outcome
function beforeNextWrite(database: CryKitDatabase, compete: () => Promise<void>): () => void {
  const transaction = database.transaction.bind(database)
  let armed = true
  const spy = vi.spyOn(database, 'transaction').mockImplementation((function (mode: string, ...args: unknown[]) {
    if (mode === 'rw' && armed) {
      armed = false
      return Dexie.Promise.resolve(compete()).then(() => Reflect.apply(transaction, database, [mode, ...args]))
    }
    return Reflect.apply(transaction, database, [mode, ...args])
  }) as typeof database.transaction)
  return () => spy.mockRestore()
}

it.each(['load fallback', 'load sample', 'save', 'mod configure', 'mod skip'] as const)('rechecks %s after a competing journal or partial tuple appears', async operation => {
  for (const partial of [false, true]) {
    const fixture = await journalFixture(), { record, preview } = fixture
    const name = fixture.database.name; fixture.database.close()
    const database = new CryKitDatabase(name), competitor = new CryKitDatabase(name)
    await database.open(); await competitor.open()
    const { operativePlanner: _descriptor, ...legacy } = record
    const sample = createSampleLocalData(CURRENT_CATALOG)
    const legacyRecord = { ...legacy, localData: { ...legacy.localData, gameSetups: sample.gameSetups, planningGameSetupRevisionId: sample.planningGameSetupRevisionId } }
    await database.localDatas.put(legacyRecord)
    await database.meta.delete(GUEST_PLANNER_LAYOUT_KEY)
    if (operation.startsWith('load')) await database.localDatas.delete('local-data-record')
    if (operation === 'load sample') await database.localDatas.clear()
    // Configure's legacy preparation must be valid before the second admission is reached
    if (operation.startsWith('mod')) await database.catalogs.delete(JSON.stringify([BUNDLED_CATALOGS[0]!.id, BUNDLED_CATALOGS[0]!.revisionId]))
    let committedRows: GuestPlannerInstallStagedRows | undefined
    const notifications: unknown[] = [], unsubscribe = subscribeLocalData(value => notifications.push(value))
    const restore = beforeNextWrite(database, async () => {
      await competitor.transaction('rw', competitor.localDatas, competitor.meta, async () => {
        await competitor.localDatas.put(record)
        if (!partial) await competitor.meta.put(fixture.projection.declaration)
      })
      committedRows = await installedRows(competitor)
    })
    let failure: unknown, loaded: Awaited<ReturnType<typeof loadLocalData>> | undefined
    try {
      if (operation.startsWith('load')) loaded = await loadLocalData(database)
      else if (operation === 'save') await saveLocalDataWithStatus(legacyRecord.localData, record.revision, database)
      else await commitModSetup(operation === 'mod skip' ? [] : [preview], record.revision, operation === 'mod skip', database)
    } catch (error) { failure = error }
    finally { restore(); unsubscribe() }
    const reopened = new CryKitDatabase(name); await reopened.open()
    try {
      expect(committedRows).toBeDefined()
      const finalRows = await installedRows(reopened)
      if (operation === 'save' && !partial) {
        expect(failure).toBeUndefined()
        expect(notifications).toHaveLength(1)
        const root = (await reopened.localDatas.get('local-data-record'))!
        const admitted = validateGuestPlannerRecord(root, await reopened.meta.get(GUEST_PLANNER_LAYOUT_KEY), finalRows.history, 'journaled')
        expect(admitted.format).toBe('journaled')
        if (admitted.format !== 'journaled') throw new Error('Expected journaled planner')
        expect(admitted.journal.checkpoints).toHaveLength(1)
        expect(admitted.journal.checkpoints[0]!.before).toEqual(record.localData)
        for (const row of committedRows!.history) expect(finalRows.history).toContainEqual(row)
      } else {
        expect(finalRows).toEqual(committedRows)
        expect(notifications).toEqual([])
      }
      if (partial) expect(failure).toMatchObject(journalError())
      else if (operation.startsWith('load')) { expect(failure).toBeUndefined(); expect(loaded?.localData).toEqual(record.localData); expect(loaded?.canUndo).toBe(false) }
      else if (operation !== 'save') expect(failure).toMatchObject(journalError('Direct mod setup is not supported for this journaled planner'))
    } finally { database.close(); competitor.close(); reopened.close() }
  }
})

it('captures an already-open journal root, catalogs and evidence before an atomic competing replacement', async () => {
  const { database, record, source, projection } = await journalFixture()
  const imported = await previewImport(source.bytes, source.filename)
  const oldRecord = { ...record, localData: { ...record.localData, importReceipts: imported.proposed.localData.importReceipts } }
  await database.localDatas.put(oldRecord)
  const original = await loadLocalData(database)
  expect(original.evidence).toEqual(projection.planner.evidence)
  const competitor = new CryKitDatabase(database.name); await competitor.open()
  let replacement: Promise<void> | undefined
  const toArray = database.localDatas.toArray.bind(database.localDatas)
  const spy = vi.spyOn(database.localDatas, 'toArray').mockImplementationOnce((() => toArray().then(rows => {
    // Queue on the independent handle without awaiting its blocked write inside the active readonly transaction
    replacement = Dexie.ignoreTransaction(() => competitor.transaction('rw', competitor.tables, async () => {
      const next = { ...oldRecord.localData, importReceipts: {} }
      await competitor.localDatas.put({ ...oldRecord, localData: next })
      await competitor.evidence.clear()
      await competitor.catalogs.clear()
    }))
    return rows
  })) as typeof database.localDatas.toArray)
  try {
    expect(await loadLocalData(database)).toEqual(original)
    await replacement
    const next = await loadLocalData(database)
    expect(next.localData.importReceipts).toEqual({})
    expect(next.evidence).toEqual([])
    expect(next.catalogs.some(value => value.id === imported.proposed.catalogs[0]!.id)).toBe(false)
  } finally { spy.mockRestore(); database.close(); competitor.close() }
})

it('classifies genuine storage failures during admission without cleanup', async () => {
  const { database } = await journalFixture()
  const failure = new DOMException('Synthetic readonly failure', 'UnknownError')
  await unchangedJournal(database, () => {
    vi.spyOn(database.history, 'toArray').mockRejectedValueOnce(failure)
    return loadLocalData(database)
  }, { code: 'storage-failure', userMessage: 'The local planner data could not be loaded', recoverable: true })
  vi.restoreAllMocks()
})

async function reopenedJournal(database: CryKitDatabase) {
  database.close()
  const reopened = new CryKitDatabase(database.name, { plannerFormatRequirement: 'journaled' })
  const rows = await installedRows(reopened)
  const root = rows.localDatas.find(row => row.id === 'local-data-record')!
  const admitted = validateGuestPlannerRecord(root, rows.meta.find(row => row.key === GUEST_PLANNER_LAYOUT_KEY), rows.history, 'journaled')
  expect(admitted.format).toBe('journaled')
  return { reopened, rows, root }
}

it.each([false, true])('retains exact journal evidence across save, Undo, Undo and save: %s', async retain => {
  const { database, record } = await journalFixture()
  const original = await installedRows(database)
  let previous = record
  let previousHistory = original.history
  let handle = database
  const notifications: unknown[] = [], unsubscribe = subscribeLocalData(value => notifications.push(value))
  try {
    for (const operation of ['save', 'undo', 'undo', 'save']) {
      const result = operation === 'undo'
        ? await undoLocalDataWithStatus(previous.revision, handle, retain)
        : await saveLocalDataWithStatus(createPersonalDefinition(previous.localData, { kind: 'item', name: 'Synthetic retained item', expectedRevision: previous.revision }), previous.revision, handle)
      const { reopened, rows, root } = await reopenedJournal(handle)
      handle = reopened
      const checkpoint = rows.history.find(row => row.id === root.operativePlanner!.checkpointIds.at(-1))!
      expect(root.revision).toBe(previous.revision + 1)
      expect(Number.isSafeInteger(root.revision)).toBe(true)
      expect(checkpoint.before).toEqual(previous.localData)
      expect(checkpoint.after).toEqual(result.localData)
      expect(checkpoint.localDataId).toBe(record.localData.id)
      expect(root.operativePlanner).toEqual({ ...previous.operativePlanner!, revision: root.revision, checkpointIds: [...previous.operativePlanner!.checkpointIds, checkpoint.id], savedDestinationChanges: [...previous.operativePlanner!.savedDestinationChanges, result.localData.changes.at(-1)!], undoable: true })
      for (const row of previousHistory) expect(rows.history).toContainEqual(row)
      previousHistory = rows.history
      for (const key of ['sources', 'evidence', 'catalogs', 'imports', 'meta'] as const) expect(rows[key]).toEqual(original[key])
      expect((await loadLocalData(handle)).canUndo).toBe(result.canUndo)
      if (operation === 'undo') expect(root.localData.personalDefinitions).toEqual(rows.history.find(row => row.id === previous.operativePlanner!.checkpointIds.at(-1))!.before.personalDefinitions)
      previous = root
    }
    expect(notifications).toHaveLength(4)
  } finally { unsubscribe(); handle.close() }
})

it.each(['history', 'root'] as const)('rolls back journaled Undo after the %s write and permits retry', async target => {
  const { database, record } = await journalFixture(true)
  const before = await installedRows(database)
  const notifications: unknown[] = [], unsubscribe = subscribeLocalData(value => notifications.push(value))
  let reached = false
  const fail = () => { reached = true; throw new Error('Injected Undo write failure') }
  const add = database.history.add.bind(database.history)
  const put = database.localDatas.put.bind(database.localDatas)
  const fault = target === 'history'
    ? vi.spyOn(database.history, 'add').mockImplementation((...args) => add(...args).then(fail))
    : vi.spyOn(database.localDatas, 'put').mockImplementation((...args) => put(...args).then(fail))
  try { await expect(undoLocalDataWithStatus(record.revision, database)).rejects.toMatchObject({ code: 'storage-failure', recoverable: true }) }
  finally { fault.mockRestore(); unsubscribe() }
  const { reopened, rows } = await reopenedJournal(database)
  try {
    expect(reached).toBe(true)
    expect(rows).toEqual(before)
    expect(notifications).toEqual([])
    expect((await loadLocalData(reopened)).canUndo).toBe(true)
    const result = await undoLocalDataWithStatus(record.revision, reopened)
    expect(result.localData.revision).toBe(record.revision + 1)
  } finally { reopened.close() }
})

it.each(['missing member', 'before', 'after', 'declaration', 'stale'] as const)('rejects journaled Undo %s without changing any table or notifying', async corruption => {
  const { database, record } = await journalFixture(true)
  const member = (await database.history.get(record.operativePlanner!.checkpointIds.at(-1)!))!
  if (corruption === 'missing member') await database.history.delete(member.id)
  if (corruption === 'before') await database.history.put({ ...member, before: { ...member.before, changes: member.before.changes.map(change => ({ ...change, command: 'corrupted immutable change' })) } })
  if (corruption === 'after') await database.history.put({ ...member, after: { ...member.after, updatedAt: '2001-01-01T00:00:00.000Z' as typeof member.after.updatedAt } })
  if (corruption === 'declaration') await database.meta.put({ key: GUEST_PLANNER_LAYOUT_KEY, value: '{}' })
  const before = await installedRows(database)
  const notifications: unknown[] = [], unsubscribe = subscribeLocalData(value => notifications.push(value))
  try { await expect(undoLocalDataWithStatus(record.revision - 1, database)).rejects.toMatchObject({ code: corruption === 'stale' ? 'revision-conflict' : 'schema-mismatch', recoverable: true }) }
  finally { unsubscribe(); database.close() }
  const reopened = new CryKitDatabase(database.name, { plannerFormatRequirement: 'journaled' })
  try { expect(await installedRows(reopened)).toEqual(before); expect(notifications).toEqual([]) }
  finally { reopened.close() }
})

it('refuses a journaled Undo successor beyond the safe revision range', async () => {
  const { database, record } = await journalFixture()
  const before = { ...record.localData, revision: Number.MAX_SAFE_INTEGER - 1, changes: [] }
  const after = changedLocalData(before, before, 'last safe edit', nowTimestamp())
  const checkpoint = historyEntry(before, after, 'last safe edit', after.updatedAt)
  await database.history.add(checkpoint)
  await database.localDatas.put({ ...record, localData: after, revision: after.revision, updatedAt: after.updatedAt, operativePlanner: { ...record.operativePlanner!, revision: after.revision, checkpointIds: [checkpoint.id], savedDestinationChanges: after.changes, undoable: true } })
  const original = await installedRows(database)
  const notifications: unknown[] = [], unsubscribe = subscribeLocalData(value => notifications.push(value))
  expect((await loadLocalData(database)).canUndo).toBe(true)
  try { await expect(undoLocalDataWithStatus(after.revision, database)).rejects.toMatchObject(journalError('The journaled planner revision cannot advance safely. Keep your draft and reopen the workspace')) }
  finally { unsubscribe() }
  const { reopened, rows } = await reopenedJournal(database)
  try { expect(rows).toEqual(original); expect(notifications).toEqual([]); expect((await loadLocalData(reopened)).canUndo).toBe(true) }
  finally { reopened.close() }
})

it.each([false, true])('commits exactly one save or Undo across required handles with Undo first=%s', async undoFirst => {
  const { database, record } = await journalFixture(true)
  const before = await installedRows(database)
  const other = new CryKitDatabase(database.name, { plannerFormatRequirement: 'journaled' })
  await other.open()
  const draft = changedLocalData(record.localData, record.localData, 'competing save', nowTimestamp())
  const undo = () => undoLocalDataWithStatus(record.revision, database)
  const save = () => saveLocalDataWithStatus(draft, record.revision, other)
  const notifications: unknown[] = [], unsubscribe = subscribeLocalData(value => notifications.push(value))
  const outcomes = await Promise.allSettled((undoFirst ? [undo, save] : [save, undo]).map(operation => operation()))
  unsubscribe(); other.close()
  const { reopened, rows, root } = await reopenedJournal(database)
  try {
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toMatchObject([{ reason: { code: 'revision-conflict', recoverable: true } }])
    expect(notifications).toHaveLength(1)
    expect(rows.history).toHaveLength(before.history.length + 1)
    expect(root.operativePlanner!.checkpointIds).toHaveLength(record.operativePlanner!.checkpointIds.length + 1)
    expect(root.operativePlanner!.savedDestinationChanges).toHaveLength(record.operativePlanner!.savedDestinationChanges.length + 1)
    for (const row of before.history) expect(rows.history).toContainEqual(row)
    for (const key of ['sources', 'evidence', 'catalogs', 'imports', 'meta'] as const) expect(rows[key]).toEqual(before[key])
    expect((await loadLocalData(reopened)).canUndo).toBe(true)
  } finally { reopened.close() }
})

it('restores unknown inventory and withdrawn catalog pins while preserving older destination evidence', async () => {
  const { database, record } = await journalFixture()
  const older = record.operativePlanner!.savedDestinationChanges[0]!
  const shortened = { ...record.localData, changes: [] }
  await database.localDatas.put({ ...record, localData: shortened })
  const receipt = WITHDRAWN_CATALOGS[0]!
  const setup = addGameSetupRevision(shortened, { label: 'Unavailable historical catalog', catalogLock: { [receipt.id]: receipt.revisionId }, expectedRevision: shortened.revision })
  const playthrough = createPlaythrough(setup, { label: 'Unknown stock', expectedRevision: setup.revision })
  const defined = createPersonalDefinition(playthrough, { kind: 'item', name: 'Uncounted item', expectedRevision: playthrough.revision })
  const definitionId = Object.values(defined.personalDefinitions)[0]!.id
  const draft = observeInventory(defined, { ref: { kind: 'personal', definitionId }, possession: 'unknown', quantity: { kind: 'unknown' }, expectedRevision: defined.revision })
  const saved = await saveLocalDataWithStatus(draft, record.revision, database)
  const later = await saveLocalDataWithStatus(createPersonalDefinition(saved.localData, { kind: 'item', name: 'Later item', expectedRevision: saved.localData.revision }), saved.localData.revision, database)
  const original = await installedRows(database)
  const undone = await undoLocalDataWithStatus(later.localData.revision, database)
  const { reopened, rows, root } = await reopenedJournal(database)
  try {
    expect(undone.localData.personalDefinitions).toEqual(saved.localData.personalDefinitions)
    expect(undone.localData.playthroughs).toEqual(saved.localData.playthroughs)
    expect(undone.localData.gameSetups).toEqual(saved.localData.gameSetups)
    expect(Object.values(Object.values(undone.localData.playthroughs)[0]!.inventory)[0]!.quantity).toEqual({ kind: 'unknown' })
    expect(root.operativePlanner!.savedDestinationChanges[0]).toEqual(older)
    expect(root.localData.changes.some(change => change.id === older.id)).toBe(false)
    for (const row of original.history) expect(rows.history).toContainEqual(row)
    for (const key of ['sources', 'evidence', 'catalogs', 'imports', 'meta'] as const) expect(rows[key]).toEqual(original[key])
  } finally { reopened.close() }
})

it('exports only declared journal checkpoints despite inert native endpoint collisions', async () => {
  const { database, record } = await journalFixture()
  const draft = createPersonalDefinition(record.localData, { kind: 'item', name: 'Export item', expectedRevision: record.revision })
  const { localData: saved } = await saveLocalDataWithStatus(draft, record.revision, database)
  const root = (await database.localDatas.get('local-data-record'))!
  const member = (await database.history.get(root.operativePlanner!.checkpointIds[0]!))!
  await database.history.add({ ...member, id: 'aaa-inert-export-collision', before: { ...member.before, personalDefinitions: saved.personalDefinitions } })
  const before = await installedRows(database), notifications: unknown[] = []
  const unsubscribe = subscribeLocalData(value => notifications.push(value))
  try {
    const bytes = await exportBackup(undefined, database)
    const zip = unzipSync(bytes)
    const manifest = JSON.parse(new TextDecoder().decode(zip['manifest.json']))
    const payload = JSON.parse(new TextDecoder().decode(zip['bundle.json']))
    expect(manifest.history).toEqual({ stored: 1, exported: 1, truncated: false })
    expect(payload.history).toEqual([member])
    expect(payload.localData).toEqual(saved)
    const preview = await previewImport(bytes, 'journal.zip')
    expect(preview.proposed.history).toEqual([member])
    const { reopened, rows } = await reopenedJournal(database)
    try { expect(rows).toEqual(before) } finally { reopened.close() }
    expect(notifications).toEqual([])
  } finally { unsubscribe(); database.close() }
})

function decodedBackup(bytes: Uint8Array) {
  const zip = unzipSync(bytes)
  return { zip, manifest: JSON.parse(new TextDecoder().decode(zip['manifest.json'])), payload: JSON.parse(new TextDecoder().decode(zip['bundle.json'])) }
}

async function readonlyJournalExport(database: CryKitDatabase, operation: () => Promise<void>, admit = true) {
  const before = await installedRows(database), notifications: unknown[] = []
  const unsubscribe = subscribeLocalData(value => notifications.push(value))
  try { await operation() } finally {
    unsubscribe()
    database.close()
    const reopened = new CryKitDatabase(database.name, { plannerFormatRequirement: 'journaled' })
    try {
      expect(await installedRows(reopened)).toEqual(before)
      if (admit) await loadLocalData(reopened)
      expect(notifications).toEqual([])
    } finally { reopened.close() }
  }
}

it('exports zero journal members with clone-only changes clearing, then genuine save and Undo members', async () => {
  const { database: originalDatabase, record, planner } = await journalFixture()
  expect(record.localData.changes.length).toBeGreaterThan(0)
  await readonlyJournalExport(originalDatabase, async () => {
    const empty = decodedBackup(await exportBackup(undefined, originalDatabase))
    expect(empty.manifest.history).toEqual({ stored: 0, exported: 0, truncated: false })
    expect(empty.payload.localData).toEqual({ ...record.localData, changes: [] })
    expect(empty.payload.history).toEqual([])
  })
  const database = new CryKitDatabase(originalDatabase.name, { plannerFormatRequirement: 'journaled' })
  const saved = await saveLocalDataWithStatus(createPersonalDefinition(record.localData, { kind: 'item', name: 'Real item', expectedRevision: record.revision }), record.revision, database)
  await undoLocalDataWithStatus(saved.localData.revision, database)
  await readonlyJournalExport(database, async () => {
    const bytes = await exportBackup(undefined, database), decoded = decodedBackup(bytes)
    const root = (await database.localDatas.get('local-data-record'))!
    expect(decoded.manifest.history).toEqual({ stored: 2, exported: 2, truncated: false })
    expect(decoded.payload.history.map((row: { id: string }) => row.id)).toEqual(root.operativePlanner!.checkpointIds)
    const preview = await previewImport(bytes, 'restorable-journal.zip')
    const source = { ...planner, localData: preview.proposed.localData!, history: preview.proposed.history! }
    const prepared = requirePreparedGuestPlanner(prepareGuestRestorePlanner(planner, source, 'replace'))
    expect(prepared.record.operativePlanner!.checkpointIds).toEqual([])
    expect(prepared.record.operativePlanner!.undoable).toBe(false)
  })
})

it('exports a journal recovery draft without changing its identities or stored tables', async () => {
  const { database, record } = await journalFixture(true)
  const draft = createPersonalDefinition(record.localData, { kind: 'item', name: 'Draft only', expectedRevision: record.revision })
  const original = structuredClone(draft)
  await readonlyJournalExport(database, async () => {
    const bytes = await exportBackup(draft, database), decoded = decodedBackup(bytes)
    expect(decoded.manifest.history).toEqual({ stored: 2, exported: 2, truncated: false })
    expect(decoded.payload.localData.personalDefinitions).toEqual(draft.personalDefinitions)
    expect(decoded.payload.localData.gameSetups).toEqual(draft.gameSetups)
    expect(decoded.payload.history[1].before).toEqual(record.localData)
    expect(decoded.payload.history[1].after).toEqual(decoded.payload.localData)
    expect(draft).toEqual(original)
    await previewImport(bytes, 'draft.zip')
  })
})

it.each(['wrong-domain', 'missing-member', 'reversed-descriptor', 'missing-declaration'] as const)('rejects journal export %s without writes or notifications', async kind => {
  const { database, record } = await journalFixture(true)
  const saved = await saveLocalDataWithStatus(record.localData, record.revision, database)
  const root = (await database.localDatas.get('local-data-record'))!
  if (kind === 'missing-member') await database.history.delete(root.operativePlanner!.checkpointIds[0]!)
  if (kind === 'reversed-descriptor') await database.localDatas.put({ ...root, operativePlanner: { ...root.operativePlanner!, checkpointIds: [...root.operativePlanner!.checkpointIds].reverse() } })
  if (kind === 'missing-declaration') await database.meta.delete(GUEST_PLANNER_LAYOUT_KEY)
  await readonlyJournalExport(database, async () => {
    await expect(exportBackup(kind === 'wrong-domain' ? createBlankLocalData() : saved.localData, database)).rejects.toMatchObject({ code: 'schema-mismatch' })
  }, kind === 'wrong-domain')
})

async function longExportJournal(count: number) {
  const value = tuple()
  let current = createBlankLocalData()
  const history: typeof value.history = [], savedChanges: typeof current.changes[number][] = []
  for (let index = 0; index < count; index++) {
    const changed = changedLocalData(current, current, 'small checkpoint', nowTimestamp())
    // A narrow live window keeps the real archive small while destination evidence remains complete
    const next = { ...changed, changes: changed.changes.slice(-1) }
    savedChanges.push(next.changes[0]!)
    history.push({ ...historyEntry(current, next, 'small checkpoint', next.updatedAt), id: `checkpoint-${String(count - index).padStart(4, '0')}` })
    current = next
  }
  const record: LocalDataRecord = { ...value.record, revision: current.revision, updatedAt: current.updatedAt, localData: current, lineage: { rootLocalDataId: current.id }, operativePlanner: { ...value.record.operativePlanner!, localDataId: current.id, revision: current.revision, checkpointIds: history.map(row => row.id), savedDestinationChanges: savedChanges } }
  const name = `export-limit-${crypto.randomUUID()}`; names.push(name)
  const seed = new CryKitDatabase(name)
  await seed.localDatas.add(record)
  await seed.meta.add(value.declaration)
  await seed.history.bulkAdd([...history].reverse())
  seed.close()
  const database = new CryKitDatabase(name, { plannerFormatRequirement: 'journaled' })
  // Export admits the real stored journal; a setup load would repeat that full-history scan
  // readonlyJournalExport still proves the unchanged journal reopens after the export
  return { database, record, history }
}

it.each([false, true])('exports a real 501-eligible journal as the newest 500 checkpoints with draft=%s', async draft => {
  const { database, record, history } = await longExportJournal(draft ? 500 : 501)
  const override = draft ? createPersonalDefinition(record.localData, { kind: 'item', name: 'Boundary draft', expectedRevision: record.revision }) : undefined
  const original = structuredClone(override)
  await readonlyJournalExport(database, async () => {
    const bytes = await exportBackup(override, database), decoded = decodedBackup(bytes)
    expect(decoded.manifest.history).toEqual({ stored: 501, exported: 500, truncated: true })
    expect(decoded.payload.history.map((row: { id: string }) => row.id).slice(0, draft ? -1 : undefined)).toEqual(history.slice(1).map(row => row.id))
    expect(decoded.payload.history.at(-1).after).toEqual(decoded.payload.localData)
    expect(new TextEncoder().encode(JSON.stringify(decoded.payload)).length).toBeLessThan(4 * 1024 * 1024)
    const preview = await previewImport(bytes, 'bounded-journal.zip')
    expect(preview.proposed.history).toHaveLength(500)
    expect(override).toEqual(original)
  })
})

it('bounds native history by payload bytes independently of count and rejects a root that cannot fit', () => {
  const { history } = tuple()
  const contentFor = (entries: readonly typeof history[number][]) => ({ payload: { ids: entries.map(row => row.id) } })
  const singleBytes = new TextEncoder().encode(JSON.stringify(contentFor(history.slice(1)).payload)).length
  const retained = selectBackupHistory(history, contentFor, singleBytes)
  expect(retained.history).toEqual([history[1]])
  expect(JSON.parse(new TextDecoder().decode(retained.payloadBytes))).toEqual({ ids: [history[1]!.id] })
  const none = selectBackupHistory(history, contentFor, 10)
  expect(none.history).toEqual([])
  expect(JSON.parse(new TextDecoder().decode(none.payloadBytes))).toEqual({ ids: [] })
  expect(() => selectBackupHistory(history, contentFor, 9)).toThrow('safe backup size limit')
  expect(() => selectBackupHistory([], contentFor, 9)).toThrow('safe backup size limit')
  expect(() => selectBackupHistory(history, () => { throw new Error('required source unavailable') }, singleBytes)).toThrow('required source unavailable')
})

async function modExportJournal(historical: boolean) {
  const fixture = await journalFixture()
  const { database, record } = fixture
  const mods = await syntheticModLayers()
  const catalogs = mods.catalogs.slice(1)
  await database.catalogs.bulkPut(catalogs.map(snapshot => ({ key: JSON.stringify([snapshot.id, snapshot.revisionId]), id: snapshot.id, revisionId: snapshot.revisionId, checksum: snapshot.checksum, snapshot })))
  await database.sources.bulkPut([...mods.first.proposed.sources, ...mods.second.proposed.sources])
  await database.evidence.bulkPut([...mods.first.proposed.evidence, ...mods.second.proposed.evidence])
  const baseline = addGameSetupRevision(record.localData, { label: 'Native baseline', catalogLock: { [CURRENT_CATALOG.id]: CURRENT_CATALOG.revisionId }, expectedRevision: record.revision })
  const draft = updateGameSetupRevision(baseline, { sourceRevisionId: baseline.planningGameSetupRevisionId!, modComposition: mods.composition })
  const effective = (await prepareModCatalogs(draft, mods.catalogs)).map(compactModCatalog).find(catalog => !mods.catalogs.some(original => original.id === catalog.id && original.revisionId === catalog.revisionId))!
  if (historical) {
    // Historical admission requires the exact stored effective; only a draft after-snapshot may derive one
    await database.catalogs.put({ key: JSON.stringify([effective.id, effective.revisionId]), id: effective.id, revisionId: effective.revisionId, checksum: effective.checksum, snapshot: effective })
    const before = { ...draft, revision: record.revision, changes: record.localData.changes }
    const after = changedLocalData(before, record.localData, 'remove historical setup', nowTimestamp())
    const checkpoint = historyEntry(before, after, 'remove historical setup', after.updatedAt)
    await database.history.add(checkpoint)
    await database.localDatas.put({ ...record, revision: after.revision, updatedAt: after.updatedAt, localData: after, operativePlanner: { ...record.operativePlanner!, revision: after.revision, checkpointIds: [checkpoint.id], savedDestinationChanges: after.changes, undoable: true } })
    await loadLocalData(database)
  }
  return { ...fixture, mods, draft, effective }
}

it('exports exact stored historical-only effective catalogs and source bodies', async () => {
  const { database, mods, effective } = await modExportJournal(true)
  await readonlyJournalExport(database, async () => {
    const bytes = await exportBackup(undefined, database), decoded = decodedBackup(bytes)
    expect(Object.values(decoded.payload.localData.gameSetups)).toEqual([])
    expect(decoded.payload.catalogs).toContainEqual(effective)
    expect(decoded.manifest.history).toEqual({ stored: 1, exported: 1, truncated: false })
    for (const source of [...mods.first.proposed.sources, ...mods.second.proposed.sources]) {
      const entry = decoded.manifest.sources.find((value: { id: string }) => value.id === source.id)
      expect(entry).toBeDefined()
      expect(decoded.zip[entry.path]).toEqual(source.bytes)
    }
    await previewImport(bytes, 'historical-composition.zip')
  })
})

it.each(['effective', 'source'] as const)('rejects missing historical %s without repairing stored evidence', async kind => {
  const { database, effective, mods } = await modExportJournal(true)
  if (kind === 'effective') await database.catalogs.delete(JSON.stringify([effective.id, effective.revisionId]))
  else await database.sources.delete(mods.first.proposed.sources[0]!.id)
  await readonlyJournalExport(database, async () => {
    await expect(exportBackup(undefined, database)).rejects.toMatchObject({ code: kind === 'effective' ? 'schema-mismatch' : 'storage-failure' })
  }, kind !== 'effective')
})

it('derives a new recovery-draft composition only for the exported candidate', async () => {
  const { database, draft, effective } = await modExportJournal(false)
  const original = structuredClone(draft)
  expect(await database.catalogs.get(JSON.stringify([effective.id, effective.revisionId]))).toBeUndefined()
  await readonlyJournalExport(database, async () => {
    const bytes = await exportBackup(draft, database), decoded = decodedBackup(bytes)
    expect(decoded.payload.catalogs).toContainEqual(effective)
    expect(decoded.payload.localData.gameSetups).toEqual(draft.gameSetups)
    expect(decoded.manifest.history).toEqual({ stored: 1, exported: 1, truncated: false })
    expect(draft).toEqual(original)
    await previewImport(bytes, 'new-draft-composition.zip')
  })
})

it('exports explicit withdrawn pins and unknown inventory quantities without invented source bodies', async () => {
  const { database, record } = await journalFixture()
  const receipt = WITHDRAWN_CATALOGS[0]!
  const setup = addGameSetupRevision(record.localData, { label: 'Withdrawn', catalogLock: { [receipt.id]: receipt.revisionId }, expectedRevision: record.revision })
  const playthrough = createPlaythrough(setup, { label: 'Unknown inventory', expectedRevision: setup.revision })
  const defined = createPersonalDefinition(playthrough, { kind: 'item', name: 'Unknown item', expectedRevision: playthrough.revision })
  const draft = observeInventory(defined, { ref: { kind: 'personal', definitionId: Object.values(defined.personalDefinitions)[0]!.id }, possession: 'unknown', quantity: { kind: 'unknown' }, expectedRevision: defined.revision })
  await readonlyJournalExport(database, async () => {
    const bytes = await exportBackup(draft, database), decoded = decodedBackup(bytes)
    expect(decoded.payload.bundledCatalogs).toContainEqual(receipt)
    expect(decoded.payload.localData.playthroughs).toEqual(draft.playthroughs)
    expect(decoded.payload.localData.personalDefinitions).toEqual(draft.personalDefinitions)
    expect(decoded.manifest.sources).toEqual([])
  })
})

it('rejects archive-total overflow instead of treating required source bytes as truncated history', async () => {
  const { database } = await modExportJournal(true)
  const inspect = nativeZip.inspectZip
  // Exercise the real archive inspector at a small total budget without allocating a huge source fixture
  const spy = vi.spyOn(nativeZip, 'inspectZip').mockImplementation((bytes, limits) => inspect(bytes, { ...limits!, maxTotalUncompressedBytes: 1 }))
  try {
    await readonlyJournalExport(database, async () => {
      await expect(exportBackup(undefined, database)).rejects.toMatchObject({ code: 'unsafe-archive' })
    })
  } finally { spy.mockRestore() }
})
