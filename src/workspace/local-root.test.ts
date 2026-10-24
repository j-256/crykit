import { expect, it, vi } from 'vitest'
import * as timestamps from '../interchange/util'
import { asTimestamp } from '../domain/core'
import { createSampleLocalData } from '../domain/sample-data'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import type { WorkspaceState, BlobSource } from './documents'
import { admitLocalRoot, prepareLocalWorkspace, localJournalCoveredByHistory, type LocalStoreAdapter } from './local-root'
import { memoryBlob, readBlob, blobIdentity, hashBlob } from './blobs'
import { createBlankLocalData, addGameSetupRevision } from '../domain/local-data'
import { STARTER_CATALOG } from '../catalog/starter'
import { previewImport } from '../interchange/import'
import { prepareModCatalogs } from '../persistence/local-data'
import { prepareManagedPlannerSave } from './managed-planner'
import { decodeWorkspaceDocument, workspaceDocumentSource } from './document-codec'
import { isImmutableCatalogSnapshot } from '../interchange/native'
import { prepareLocalIndex } from './local-index'
import { changedLocalDataWithSharedUnits, historyEntry } from '../persistence/local-data'
import { managedGuestPlannerTuple } from './managed-guest-planner'
import { prepareGuestRestorePlanner, requirePreparedGuestPlanner } from './guest-planner'
import { maxDocumentBytes } from '../account/protocol'
import { splitWorkspace } from './documents'
import { projectPlanner } from './planner-journal'

const MAX_PACKAGED_CATALOG_FRAME_BYTES = 1024

function setup() {
  const rows = new Map<string, Uint8Array>()
  let writes = 0, alive = true
  const adapter: LocalStoreAdapter = {
    read: async ref => { const bytes = rows.get(blobIdentity(ref)); if (!bytes) throw new Error('Missing record'); return memoryBlob(bytes) },
    stage: async (_operation, source: BlobSource, _dependencies, previous) => {
      const ref = { documentId: previous?.documentId ?? crypto.randomUUID(), revisionId: crypto.randomUUID() }
      rows.set(blobIdentity(ref), await readBlob(source, maxDocumentBytes)); writes++
      return ref
    },
  }
  const check = () => { if (!alive) throw new Error('Profile changed') }
  const lifetime = { check, assertCurrent: async () => check() }
  const localData = createSampleLocalData(BUNDLED_CATALOGS[0])
  const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: BUNDLED_CATALOGS, sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], blobs: [], libraryDefaults: { version: 1, layers: [] } }
  return { adapter, rows, lifetime, state, writes: () => writes, revoke: () => { alive = false } }
}

it('reopens exact native state and reuses untouched unit bodies after one planner change', async () => {
  const s = setup()
  const first = await prepareLocalWorkspace(s.adapter, 'first', s.state, s.lifetime)
  const reopened = await admitLocalRoot(s.adapter, first.head, s.lifetime)
  expect(reopened.state).toEqual(s.state)
  const selected = Object.values(reopened.state.planner.localData.builds)[0]!
  const changed = { ...reopened.state, planner: { ...reopened.state.planner, localData: { ...reopened.state.planner.localData, builds: { ...reopened.state.planner.localData.builds, [selected.id]: { ...selected, title: 'Changed title' } } } } }
  const beforeWrites = s.writes()
  const next = await prepareLocalWorkspace(s.adapter, 'second', changed, s.lifetime, reopened)
  expect(s.writes() - beforeWrites).toBeLessThan(12)
  const previous = new Map(reopened.entries.map(entry => [entry.key, entry]))
  for (const entry of next.snapshot.entries) if (entry.kind !== 'build') expect(entry.ref).toEqual(previous.get(entry.key)!.ref)
  expect((await admitLocalRoot(s.adapter, next.head, s.lifetime)).state).toEqual(changed)
}, 15_000)

it('reads one exact historical frame once for semantic history and the operative journal', async () => {
  const s = setup(), before = createBlankLocalData(), after = { ...before, revision: 1 }
  const history = [{ id: 'shared-history', localDataId: before.id, command: 'synthetic-change', previousRevision: 0, nextRevision: 1, before, after, recordedAt: before.updatedAt }]
  const state: WorkspaceState = { ...s.state, planner: { localData: after, lineage: { rootLocalDataId: before.id }, catalogs: [], evidence: [], sources: [], history, journal: { version: 1, changes: after.changes, checkpoints: history, undoable: true } } }
  const prepared = await prepareLocalWorkspace(s.adapter, 'shared-history', state, s.lifetime)
  const index = JSON.parse(new TextDecoder().decode(s.rows.get(blobIdentity(prepared.snapshot.root.historyIndex))!))
  const ref = index.entries[0].ref, key = blobIdentity(ref), read = s.adapter.read
  let reads = 0
  const observed: LocalStoreAdapter = { ...s.adapter, read: async candidate => { if (blobIdentity(candidate) === key) reads++; return read(candidate) } }
  const opened = await admitLocalRoot(observed, prepared.head, s.lifetime)
  expect(opened.state.planner.history).toEqual(history)
  expect(opened.state.planner.journal?.checkpoints).toEqual(history)
  expect(reads).toBe(1)

  // A repeated physical claim must still name the same semantic history entry
  const stage = (value: unknown, dependencies: readonly import('./local-root').LocalRecordRef[]) => s.adapter.stage('foreign-claim', memoryBlob(new TextEncoder().encode(JSON.stringify(value))), dependencies)
  const journal = await prepareLocalIndex([{ id: 'foreign-history', ref }], page => stage(page, [...page.children, ...page.entries.map(value => value.ref)]))
  const contradictory = await stage({ ...prepared.snapshot.root, journal: { ...prepared.snapshot.root.journal, checkpoints: journal.root } }, [journal.root])
  await expect(admitLocalRoot(observed, contradictory, s.lifetime)).rejects.toThrow(/history|checkpoint/i)

  // Reuse is invocation-local, so another admission must consume the actual stored bytes
  const corrupt = s.rows.get(key)!.slice(); corrupt[corrupt.length - 1] ^= 1
  s.rows.set(key, corrupt)
  await expect(admitLocalRoot(observed, prepared.head, s.lifetime)).rejects.toThrow()
})

it('uses exact packaged catalog pins locally while keeping portable and older expanded catalogs complete', async () => {
  const s = setup()
  const first = await prepareLocalWorkspace(s.adapter, 'packaged', s.state, s.lifetime)
  const catalog = BUNDLED_CATALOGS[0]!
  const entry = first.snapshot.entries.find(value => value.kind === 'catalog' && value.key === JSON.stringify(['catalog', catalog.id, catalog.revisionId]))!
  const source = await s.adapter.read(entry.ref)
  if (process.env.R16_BULK_TRACE) console.log(JSON.stringify({ phase: 'packaged-local-frame', bytes: source.byteLength }))
  expect(source.byteLength).toBeLessThan(MAX_PACKAGED_CATALOG_FRAME_BYTES)
  const document = await decodeWorkspaceDocument(source)
  expect(document.value).toEqual({ version: 1, kind: 'packaged-catalog-pin', id: catalog.id, revisionId: catalog.revisionId, checksum: catalog.checksum })
  const reopened = await admitLocalRoot(s.adapter, first.head, s.lifetime)
  expect(reopened.state.planner.catalogs).toEqual(s.state.planner.catalogs)
  expect(splitWorkspace(reopened.state).find(value => value.key === entry.key)!.value).toEqual(catalog)

  // Seed durable framing independently so the new producer cannot hide a backward-reading defect
  const replace = async (value: unknown) => {
    const body = workspaceDocumentSource({ ...document, value: value as typeof document.value })
    const ref = await s.adapter.stage('independent-catalog', body, [], entry.ref)
    const rewritten = { ...entry, ref, digest: await hashBlob(body) }
    const stage = (value: unknown, dependencies: readonly import('./local-root').LocalRecordRef[]) => s.adapter.stage('independent-catalog', memoryBlob(new TextEncoder().encode(JSON.stringify(value))), dependencies)
    const index = await prepareLocalIndex(first.snapshot.entries.map(value => value.key === entry.key ? rewritten : value), page => stage(page, [...page.children, ...page.entries.map(value => value.ref)]))
    return stage({ ...first.snapshot.root, contentIndex: index.root }, [index.root])
  }
  const legacy = await replace(catalog)
  expect((await admitLocalRoot(s.adapter, legacy, s.lifetime)).state).toEqual(reopened.state)
  const unavailable = await replace({ ...document.value as object, checksum: 'sha256:unavailable-synthetic' })
  await expect(admitLocalRoot(s.adapter, unavailable, s.lifetime)).rejects.toThrow('The exact packaged catalog is unavailable')
  const conflicting = { ...s.state, planner: { ...s.state.planner, catalogs: s.state.planner.catalogs.map(value => value === catalog ? { ...value, importedAt: '2000-01-01T00:00:00.000Z' as typeof value.importedAt } : value) } }
  await expect(prepareLocalWorkspace(s.adapter, 'conflicting-catalog', conflicting, s.lifetime)).rejects.toThrow('Packaged catalog identity has conflicting contents')
}, 15_000)

it('corroborates packaged catalog contents independently of JSON property order', async () => {
  const s = setup()
  const catalog = BUNDLED_CATALOGS[0]!
  const reordered = Object.fromEntries(Object.entries(catalog).reverse()) as unknown as typeof catalog
  const state = { ...s.state, planner: { ...s.state.planner, catalogs: s.state.planner.catalogs.map(value => value === catalog ? reordered : value) } }
  const prepared = await prepareLocalWorkspace(s.adapter, 'reordered-package', state, s.lifetime)
  const entry = prepared.snapshot.entries.find(value => value.key === JSON.stringify(['catalog', catalog.id, catalog.revisionId]))!
  expect((await decodeWorkspaceDocument(await s.adapter.read(entry.ref))).value).toEqual({ version: 1, kind: 'packaged-catalog-pin', id: catalog.id, revisionId: catalog.revisionId, checksum: catalog.checksum })
  expect((await admitLocalRoot(s.adapter, prepared.head, s.lifetime)).state).toEqual(state)
}, 15_000)

it('rejects missing dependencies and revoked lifetimes without granting a prepared root authority', async () => {
  const s = setup()
  const first = await prepareLocalWorkspace(s.adapter, 'first', s.state, s.lifetime)
  const invalid = { ...s.state, planner: { ...s.state.planner, localData: { ...s.state.planner.localData, gameSetups: {} } } }
  await expect(prepareLocalWorkspace(s.adapter, 'bad', invalid, s.lifetime, first.snapshot)).rejects.toThrow()
  s.revoke()
  await expect(admitLocalRoot(s.adapter, first.head, s.lifetime)).rejects.toThrow('Profile changed')
})

it('full reopen detects changed durable bytes instead of trusting a prepared plaintext view', async () => {
  const s = setup()
  const first = await prepareLocalWorkspace(s.adapter, 'first', s.state, s.lifetime)
  const entry = first.snapshot.entries.find(value => value.kind === 'build')!
  const bytes = s.rows.get(blobIdentity(entry.ref))!.slice()
  bytes[bytes.length - 2] ^= 1
  s.rows.set(blobIdentity(entry.ref), bytes)
  await expect(admitLocalRoot(s.adapter, first.head, s.lifetime)).rejects.toThrow()
})

it('keeps destination changes separate from inherited evidence through owned append and reopen', async () => {
  const s = setup(), original = s.state.planner.localData
  const local = changedLocalDataWithSharedUnits(original, original, 'owned-first', original.updatedAt)
  const imported = { ...local.changes[0]!, id: 'imported-high-revision' as typeof local.changes[0]['id'], previousRevision: 99, nextRevision: 100 }
  const state = { ...s.state, planner: { ...s.state.planner, localData: local, savedChanges: [...local.changes, imported], journal: { version: 1 as const, changes: local.changes, checkpoints: [], undoable: false } } }
  const first = await prepareLocalWorkspace(s.adapter, 'destination-first', state, s.lifetime)
  expect(first.snapshot.destinationChanges).toEqual(local.changes)
  await expect(prepareLocalWorkspace(s.adapter, 'foreign-destination', state, s.lifetime, undefined, undefined, state.planner.savedChanges)).rejects.toThrow('Invalid destination')
  await expect(prepareLocalWorkspace(s.adapter, 'broken-destination', state, s.lifetime, undefined, undefined, [{ ...local.changes[0]!, previousRevision: 1 }])).rejects.toThrow('Invalid destination')
  const reopened = await admitLocalRoot(s.adapter, first.head, s.lifetime)
  expect(reopened.destinationChanges).toEqual(local.changes)
  expect(reopened.state.planner.savedChanges).toEqual(state.planner.savedChanges)
  const nextLocal = changedLocalDataWithSharedUnits(reopened.state.planner.localData, reopened.state.planner.localData, 'owned-next', local.updatedAt)
  const nextState = { ...reopened.state, planner: { ...reopened.state.planner, localData: nextLocal, savedChanges: [...nextLocal.changes, imported], journal: { version: 1 as const, changes: nextLocal.changes, checkpoints: [], undoable: false } } }
  const next = await prepareLocalWorkspace(s.adapter, 'destination-next', nextState, s.lifetime, reopened)
  const result = await admitLocalRoot(s.adapter, next.head, s.lifetime)
  expect(result.destinationChanges).toEqual(nextLocal.changes)
  expect(result.state.planner.savedChanges).toEqual(nextState.planner.savedChanges)
  const tuple = managedGuestPlannerTuple(result)
  expect(tuple.record.operativePlanner!.savedDestinationChanges).toEqual(nextLocal.changes)
  expect(() => managedGuestPlannerTuple({ ...result, destinationChanges: nextState.planner.savedChanges })).toThrow('Foreign')
  const restored = requirePreparedGuestPlanner(prepareGuestRestorePlanner(result.state.planner, result.state.planner, 'replace', tuple))
  expect(restored.planner.savedChanges!.find(value => value.id === imported.id)).toEqual(imported)
  expect(restored.record.operativePlanner.savedDestinationChanges).toEqual([...nextLocal.changes, restored.planner.localData.changes.at(-1)!])
  expect(restored.planner.history.at(-1)!.before).toEqual(result.state.planner.localData)
  expect(restored.planner.history.at(-1)!.after).toEqual(restored.planner.localData)
}, 15_000)

it('retains exact local historical array order independently of revision chronology', async () => {
  const s = setup(), base = createBlankLocalData()
  const first = changedLocalDataWithSharedUnits(base, base, 'first', base.updatedAt)
  const second = changedLocalDataWithSharedUnits(first, first, 'second', base.updatedAt)
  const history = [historyEntry(first, second, 'second', base.updatedAt), historyEntry(base, first, 'first', base.updatedAt)]
  const savedChanges = [...second.changes].reverse()
  const state = { ...s.state, planner: { localData: second, lineage: { rootLocalDataId: base.id }, catalogs: [], sources: [], evidence: [], history, savedChanges } }
  const prepared = await prepareLocalWorkspace(s.adapter, 'ordered-originals', state, s.lifetime)
  const reopened = await admitLocalRoot(s.adapter, prepared.head, s.lifetime)
  expect(reopened.state.planner.history).toEqual(history)
  expect(reopened.state.planner.savedChanges).toEqual(savedChanges)
  expect(reopened.state.planner.localData.changes).toEqual(second.changes)
})

it('reconstructs compact history with operative clocks after a remote projection', async () => {
  const s = setup(), local = createBlankLocalData()
  const planner = { localData: local, lineage: { rootLocalDataId: local.id }, catalogs: [], sources: [], evidence: [], history: [] }
  const remote = changedLocalDataWithSharedUnits(local, local, 'remote-save', local.updatedAt)
  const projected = projectPlanner(planner, { ...planner, localData: remote }, true)
  expect(projected.localData.changes).toEqual([])
  expect(projected.localData.revision).toBe(0)
  expect(projected.savedChanges).toEqual(remote.changes)
  const first = await prepareLocalWorkspace(s.adapter, 'remote-projection', { ...s.state, planner: projected }, s.lifetime)
  const before = await admitLocalRoot(s.adapter, first.head, s.lifetime)
  const saved = await prepareManagedPlannerSave(before.state.planner, { ...before.state.planner.localData, modSetup: { version: 1, state: 'skipped' } }, before.destinationChanges)
  const next = await prepareLocalWorkspace(s.adapter, 'after-projection', { ...before.state, planner: saved }, s.lifetime, before)
  const reopened = await admitLocalRoot(s.adapter, next.head, s.lifetime)
  expect(reopened.state.planner).toEqual(saved)
  expect(reopened.state.planner.history.at(-1)!.before).toEqual(projected.localData)
  expect(reopened.state.planner.history.at(-1)!.after).toEqual(saved.localData)
  expect(reopened.state.planner.journal?.checkpoints).toEqual(saved.journal?.checkpoints)
  expect(reopened.destinationChanges).toEqual(saved.localData.changes)

  // A valid inherited clock cannot replace the endpoint's actual operative clock
  const changesKey = blobIdentity(before.root.operativeChanges)
  const changes = JSON.parse(new TextDecoder().decode(s.rows.get(changesKey)!))
  s.rows.set(changesKey, new TextEncoder().encode(JSON.stringify({ ...changes, entries: remote.changes })))
  await expect(admitLocalRoot(s.adapter, next.head, s.lifetime)).rejects.toThrow('LocalData change history does not end at the localData revision')
})

it('stores only effective mod changes and preserves the complete view after durable reopen and a later save', async () => {
  const s = setup()
  const imported = await previewImport(new TextEncoder().encode(JSON.stringify({ ID: 'synthetic-local-innates', Title: 'Synthetic local innates', EditorVersion: 34, Passives: [{ ID: 9000, Name: 'Synthetic local passive', PP: 2, IsInnate: true, IsLearnable: true }] })), 'synthetic.json')
  const source = imported.proposed.catalogs[0]!
  const localData = createBlankLocalData()
  const state = { ...s.state, planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [STARTER_CATALOG, source], sources: [], evidence: [], history: [] } }
  const first = await prepareLocalWorkspace(s.adapter, 'before-mod', state, s.lifetime)
  const configured = addGameSetupRevision(first.snapshot.state.planner.localData, { label: 'Synthetic effective setup', modComposition: { baseline: { catalogId: STARTER_CATALOG.id, catalogRevisionId: STARTER_CATALOG.revisionId }, layers: [{ catalogId: source.id, catalogRevisionId: source.revisionId, enabled: true }], links: [] } })
  // A save captures its own clock, which can differ from the draft's timestamp
  const savedAt = asTimestamp(new Date(Date.parse(configured.updatedAt) + 1000).toISOString())
  const clock = vi.spyOn(timestamps, 'nowTimestamp').mockReturnValue(savedAt)
  const planner = await prepareManagedPlannerSave(first.snapshot.state.planner, configured).finally(() => clock.mockRestore())
  expect(planner.localData).toEqual({ ...configured, updatedAt: savedAt })
  expect(planner.catalogs.every(isImmutableCatalogSnapshot)).toBe(true)
  const effective = planner.catalogs.at(-1)!
  const inheritedId = Object.keys(STARTER_CATALOG.entities)[0]!
  const changedId = Object.keys(source.entities)[0]!
  expect(effective.entities[inheritedId]).toEqual(STARTER_CATALOG.entities[inheritedId])
  const next = await prepareLocalWorkspace(s.adapter, 'with-mod', { ...first.snapshot.state, planner }, s.lifetime, first.snapshot)
  const entry = next.snapshot.entries.find(entry => entry.kind === 'catalog' && entry.key.includes(effective.revisionId))!
  const stored = await decodeWorkspaceDocument(await s.adapter.read(entry.ref))
  const compact = stored.value as unknown as import('../domain/types').CatalogSnapshot
  expect(Object.keys(compact.entities)).toEqual([changedId])
  expect(compact.entities[changedId]).toEqual(effective.entities[changedId])
  expect(compact.entities[inheritedId]).toBeUndefined()

  const reopened = await admitLocalRoot(s.adapter, next.head, s.lifetime)
  expect(reopened.state.planner.catalogs).toEqual(next.snapshot.state.planner.catalogs)
  expect(reopened.state.planner.localData).toEqual(planner.localData)
  expect(reopened.state.planner.history).toEqual(planner.history)

  // Seed an older full catalog frame with valid indexes and digests, independent of the compact producer
  const legacyBody = workspaceDocumentSource({ ...stored, value: effective as unknown as import('../domain/types').JsonValue })
  const legacyRef = await s.adapter.stage('expanded-frame', legacyBody, [], entry.ref)
  const legacyEntry = { ...entry, ref: legacyRef, digest: await hashBlob(legacyBody) }
  const stageJson = (value: unknown, dependencies: readonly import('./local-root').LocalRecordRef[]) => s.adapter.stage('expanded-frame', memoryBlob(new TextEncoder().encode(JSON.stringify(value))), dependencies)
  const legacyIndex = await prepareLocalIndex(next.snapshot.entries.map(value => value.key === entry.key ? legacyEntry : value), page => stageJson(page, [...page.children, ...page.entries.map(value => value.ref)]))
  const legacyHead = await stageJson({ ...next.snapshot.root, contentIndex: legacyIndex.root }, [legacyIndex.root])
  expect((await admitLocalRoot(s.adapter, legacyHead, s.lifetime)).state).toEqual(next.snapshot.state)

  const preparedCatalogs = await prepareModCatalogs(reopened.state.planner.localData, reopened.state.planner.catalogs)
  for (const [at, catalog] of preparedCatalogs.entries()) expect(catalog).toBe(reopened.state.planner.catalogs[at])
  const laterPlanner = await prepareManagedPlannerSave(reopened.state.planner, reopened.state.planner.localData)
  const later = await prepareLocalWorkspace(s.adapter, 'later', { ...reopened.state, planner: laterPlanner }, s.lifetime, reopened)
  expect(later.snapshot.entries.find(value => value.key === entry.key)!.ref).toEqual(entry.ref)
  expect((await admitLocalRoot(s.adapter, later.head, s.lifetime)).state).toEqual(later.snapshot.state)
}, 15000)

it('requires exact admitted history frames before omitting a publication-only journal', async () => {
  const s = setup(), base = createBlankLocalData()
  const local = changedLocalDataWithSharedUnits(base, base, 'covered', base.updatedAt)
  const entry = historyEntry(base, local, 'covered', base.updatedAt)
  const planner = { localData: local, lineage: { rootLocalDataId: base.id }, catalogs: [], sources: [], evidence: [], history: [entry], savedChanges: local.changes, journal: { version: 1 as const, changes: local.changes, checkpoints: [entry], undoable: true } }
  const first = await prepareLocalWorkspace(s.adapter, 'covered-journal', { ...s.state, planner }, s.lifetime)
  expect(localJournalCoveredByHistory(first.snapshot, s.adapter)).toBe(true)
  const reopened = await admitLocalRoot(s.adapter, first.head, s.lifetime)
  expect(localJournalCoveredByHistory(reopened, s.adapter)).toBe(true)
  expect(reopened.state.planner).toEqual(planner)
  expect(() => localJournalCoveredByHistory({ ...reopened }, s.adapter)).toThrow('Foreign local admission')
  expect(() => localJournalCoveredByHistory(reopened, { ...s.adapter })).toThrow('Foreign local admission')

  // Equal IDs and even equal native values do not prove the same immutable frame
  const copiedEntry = structuredClone(entry)
  const separate = await prepareLocalWorkspace(s.adapter, 'separate-journal', { ...s.state, planner: { ...planner, journal: { ...planner.journal, checkpoints: [copiedEntry] } } }, s.lifetime)
  expect(localJournalCoveredByHistory(separate.snapshot, s.adapter)).toBe(false)
  expect(localJournalCoveredByHistory(await admitLocalRoot(s.adapter, separate.head, s.lifetime), s.adapter)).toBe(false)
  const journalOnly = await prepareLocalWorkspace(s.adapter, 'journal-only', { ...s.state, planner: { ...planner, history: [] } }, s.lifetime)
  expect(localJournalCoveredByHistory(journalOnly.snapshot, s.adapter)).toBe(false)
  s.revoke()
  expect(() => localJournalCoveredByHistory(reopened, s.adapter)).toThrow('Profile changed')
})
