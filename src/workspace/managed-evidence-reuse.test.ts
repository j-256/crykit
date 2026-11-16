import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountDatabase, activateLocalAccountCommit } from '../persistence/account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { accountLocalId } from './account-cache'
import { createAccountLocalStore } from './account-local-store'
import { admitLocalRoot, prepareLocalWorkspace } from './local-root'
import { prepareLocalEvidence, readLocalEvidence } from './local-evidence'
import { guestEvidenceFromFrozenCurrent, mergeGuestEvidence, writeCapturedGuestEvidence } from './guest-evidence'
import { ownWorkspaceSnapshot } from './snapshot'
import { editorClosureFixture } from './test-helpers'

const stores: ReturnType<typeof createAccountLocalStore>[] = []
const databases: AccountDatabase[] = []
afterEach(async () => { for (const store of stores.splice(0)) await store.dispose(); for (const database of databases.splice(0)) await database.delete(); invalidateProfile(); vi.unstubAllGlobals() })
async function installedEvidence(alternativeLayout: boolean | 'unsorted' | 'equal-pages' = false) {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId); databases.push(database)
  const fixture = await editorClosureFixture()
  const original = ownWorkspaceSnapshot({ version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: 'installed-evidence', capturedAt: '2026-11-16T00:00:00.000Z', revisionVector: {}, state: fixture.state }, { async check() {}, async dispose() {} })
  let evidence = await guestEvidenceFromFrozenCurrent(original)
  if (alternativeLayout) {
    const second = ownWorkspaceSnapshot({ ...original, snapshotId: 'second-stored-original' }, { async check() {}, async dispose() {} })
    evidence = await mergeGuestEvidence(evidence, await guestEvidenceFromFrozenCurrent(second), evidence.planner)
  }
  const seed = createAccountLocalStore(database, token); stores.push(seed)
  const operation = accountLocalId()
  const inherited = alternativeLayout ? await prepareAlternativeRows(seed, operation, evidence, alternativeLayout === 'unsorted', alternativeLayout === 'equal-pages') : await prepareLocalEvidence(seed.adapter, operation, evidence)
  const prepared = await prepareLocalWorkspace(seed.adapter, operation, fixture.state, seed.lifetime, undefined, inherited)
  const expected = await activateLocalAccountCommit(database, token, await seed.prepareActivation(operation, prepared, undefined))
  seed.committed(operation)
  const store = createAccountLocalStore(database, token); stores.push(store)
  const before = await admitLocalRoot(store.adapter, expected.head, store.lifetime)
  const previous = (await readLocalEvidence(store.adapter, inherited, async () => store.lifetime.check()))!
  return { token, database, store, before, expected, previous, inherited }
}

it.each([false, true])('retains an equal installed archive root without allocations with alternative layout=%s', async alternativeLayout => {
  const { store, before, expected, previous, inherited } = await installedEvidence(alternativeLayout)
  const merged = await mergeGuestEvidence(previous, previous, previous.planner)
  const operation = accountLocalId()
  const root = await store.prepareInheritedEvidence(operation, merged, previous, before, expected)
  expect(root).toEqual(inherited)
  expect(store.stagedRecords(operation)).toEqual([])
  expect(store.observedRecords().some(record => record.revisionId === inherited.revisionId)).toBe(true)
})

async function evidenceRows(store: ReturnType<typeof createAccountLocalStore>, root: import('./local-root').LocalRecordRef) {
  const { readBlob } = await import('./blobs')
  const { INDEX_PAGE_BYTES } = await import('./directory')
  const { readLocalIndex } = await import('./local-index')
  const json = async (ref: import('./local-root').LocalRecordRef) => JSON.parse(new TextDecoder().decode(await readBlob(await store.adapter.read(ref), INDEX_PAGE_BYTES)))
  const descriptor = await json(root)
  type Row = { table: string; key: string | [string, number]; ref: import('./local-root').LocalRecordRef }
  return (await readLocalIndex<Row>(descriptor.roots[0].index, json)).entries
}

it.each([false, true])('adds a member preserving original metadata and chunk refs with alternative layout=%s', async alternativeLayout => {
  const { store, before, expected, previous, inherited } = await installedEvidence(alternativeLayout)
  const oldRows = await evidenceRows(store, inherited)
  const added = ownWorkspaceSnapshot({ version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: 'additional-original', capturedAt: '2026-11-16T00:00:00.000Z', revisionVector: {}, state: before.state }, { async check() {}, async dispose() {} })
  const merged = await mergeGuestEvidence(previous, await guestEvidenceFromFrozenCurrent(added), previous.planner)
  const operation = accountLocalId()
  const root = await store.prepareInheritedEvidence(operation, merged, previous, before, expected)
  const nextRows = await evidenceRows(store, root)
  const { readBlob } = await import('./blobs')
  const { INDEX_PAGE_BYTES } = await import('./directory')
  const json = async (table: string, key: string) => JSON.parse(new TextDecoder().decode(await readBlob(await store.adapter.read(oldRows.find(row => row.table === table && row.key === key)!.ref), INDEX_PAGE_BYTES)))
  const extension = (await json('documents', 'workspaceExtensions')).value
  const oldRoot = (await json('evidenceRoots', extension.inheritedEvidence.key)).value
  const changedPages = new Set<string>(), pendingPages: string[] = [oldRoot.members.key]
  while (pendingPages.length) {
    const key = pendingPages.pop()!; changedPages.add(key)
    pendingPages.push(...(await json('evidencePages', key)).value.children.map((ref: { key: string }) => ref.key))
  }
  // Only membership and its selected root/sentinel change when this member shares the original bodies
  const retained = oldRows.filter(row => row.table !== 'documents' && !(row.table === 'evidenceRoots' && row.key === extension.inheritedEvidence.key) && !(row.table === 'evidencePages' && changedPages.has(String(row.key))))
  for (const row of retained) expect(nextRows.find(next => next.table === row.table && JSON.stringify(next.key) === JSON.stringify(row.key))?.ref).toEqual(row.ref)
  const { compareGuestEvidence } = await import('./guest-evidence')
  await compareGuestEvidence(merged, (await readLocalEvidence(store.adapter, root, async () => store.lifetime.check()))!)
  const records = store.stagedRecords(operation)
  expect(records.length).toBeGreaterThan(0)
  console.info('Managed evidence small addition', JSON.stringify({ alternativeLayout, newRecords: records.length, plainBytes: records.reduce((sum, record) => sum + record.descriptor.plainBytes, 0), cipherBytes: records.reduce((sum, record) => sum + record.descriptor.chunks.reduce((bytes, chunk) => bytes + chunk.cipherBytes, 0), 0), retainedOriginalRows: retained.length }))
})

// Author a valid persisted graph with non-default physical row order/member page grouping and body chunks
// The ordinary strict reader must admit it before the installed-store reuse path is exercised
async function prepareAlternativeRows(store: ReturnType<typeof createAccountLocalStore>, operation: string, evidence: import('./guest-evidence').CapturedGuestEvidence, unsorted = false, equalPages = false) {
  const { memoryBlob, hashBlob } = await import('./blobs')
  const { prepareLocalIndex } = await import('./local-index')
  type RawRow = { key: string; index?: number; bytes?: Uint8Array; value?: { version: number; kind: string; entries: unknown[]; children: { version: number; key: string }[] } }
  const values: { table: string; row: RawRow }[] = []
  await writeCapturedGuestEvidence(evidence, { async put(table, input) { values.push({ table, row: structuredClone(input) as RawRow }) } })
  const members = values.find(value => value.table === 'evidencePages' && value.row.value?.kind === 'evidence-member-page')!.row.value!
  expect(members.entries).toHaveLength(2)
  const first = crypto.randomUUID(), second = crypto.randomUUID(), entries = unsorted ? [...members.entries].reverse() : [...members.entries]
  members.entries = []; members.children = [{ version: 1, key: first }, { version: 1, key: second }]
  values.push(...[first, second].map((key, index) => ({ table: 'evidencePages', row: { key, value: { version: 1, kind: 'evidence-member-page', entries: [entries[index]], children: [] } } })))
  const native = values.find(value => value.table === 'evidenceChunks' && value.row.bytes?.length === 2 && value.row.bytes[0] === 0 && value.row.bytes[1] === 216)!
  native.row.bytes = new Uint8Array([0])
  values.push({ table: 'evidenceChunks', row: { key: native.row.key, index: 1, bytes: new Uint8Array([216]) } })
  values.reverse()
  const encode = (value: unknown) => memoryBlob(new TextEncoder().encode(JSON.stringify(value)))
  const rows = []
  for (const { table, row } of values) {
    const binary = table === 'evidenceSegments' || table === 'evidenceChunks'
    const content = binary ? memoryBlob(row.bytes!) : encode(row)
    rows.push({ table, key: table === 'evidenceChunks' ? [row.key, row.index!] : row.key, ref: await store.adapter.stage(operation, content, []), digest: await hashBlob(content), encoding: binary ? 'bytes' : 'json' })
  }
  const index = await prepareLocalIndex(rows, page => store.adapter.stage(operation, encode(page), [...page.children, ...page.entries.map(row => row.ref)]))
  let root = index.root
  if (equalPages) {
    const empty = () => store.adapter.stage(operation, encode({ version: 1, entries: [], children: [] }), [])
    const children = [root, await empty(), await empty()]
    root = await store.adapter.stage(operation, encode({ version: 1, entries: [], children }), children)
  }
  return store.adapter.stage(operation, encode({ version: 1, kind: 'local-inherited-evidence', roots: [{ kind: 'guest-evidence-rows', index: root }] }), [root])
}

it('rejects noncanonical logical membership instead of treating it as a layout variation', async () => {
  await expect(installedEvidence('unsorted')).rejects.toThrow('Invalid inherited snapshot membership')
})

it.each(['forged-evidence', 'forged-root', 'foreign-store', 'cleared', 'disposed'] as const)('does not grant installed reuse authority to %s', async mode => {
  const fixture = await installedEvidence(), { store, before, expected, previous, token, database } = fixture
  const merged = await mergeGuestEvidence(previous, previous, previous.planner), operation = accountLocalId()
  let target = store, selected = before, original = previous
  if (mode === 'forged-evidence') original = { ...previous }
  if (mode === 'forged-root') selected = { ...before }
  if (mode === 'foreign-store') { target = createAccountLocalStore(database, token); stores.push(target); selected = await admitLocalRoot(target.adapter, expected.head, target.lifetime) }
  if (mode === 'cleared') store.finishAdmission()
  if (mode === 'disposed') await store.dispose()
  await expect(target.prepareInheritedEvidence(operation, merged, original, selected, expected)).rejects.toThrow()
  expect(await database.profileMeta.get('active')).toEqual(expected)
  if (mode !== 'disposed') expect(target.stagedRecords(operation)).toEqual([])
})

it('rejects genuine same-adapter prepared evidence that has not been installed', async () => {
  const { store, before, expected, previous, database } = await installedEvidence()
  const id = accountLocalId(), merged = await mergeGuestEvidence(previous, previous, previous.planner)
  const inherited = await prepareLocalEvidence(store.adapter, id, merged)
  const prepared = await prepareLocalWorkspace(store.adapter, id, before.state, store.lifetime, undefined, inherited)
  const uninstalled = (await readLocalEvidence(store.adapter, inherited, async () => store.lifetime.check()))!
  // Even a forged active pointer cannot turn this owner's pending inline allocations into installed rows
  const claimed = { ...expected, head: prepared.head }
  await database.profileMeta.put(claimed)
  try { await expect(store.prepareInheritedEvidence(accountLocalId(), merged, uninstalled, prepared.snapshot, claimed)).rejects.toThrow(/installed source records/) }
  finally { await database.profileMeta.put(expected) }
})

it.each(['evidenceChunks', 'evidenceSegments'])('rejects changed installed %s ciphertext before reuse and rechecks at activation', async table => {
  const { store, before, expected, previous, inherited, database, token } = await installedEvidence()
  const rows = await evidenceRows(store, inherited), row = rows.find(row => row.table === table)!
  const record = (await database.encryptedRevisions.get(row.ref.revisionId))!
  const chunk = (await database.stagedCipherChunks.get([record.payloadId, 0]))!
  const altered = chunk.bytes.slice(); altered[0] ^= 1
  const merged = await mergeGuestEvidence(previous, previous, previous.planner), id = accountLocalId()
  await database.stagedCipherChunks.put({ ...chunk, bytes: altered })
  await expect(store.prepareInheritedEvidence(id, merged, previous, before, expected)).rejects.toThrow(/bytes changed/)
  expect(store.stagedRecords(id)).toEqual([])
  await database.stagedCipherChunks.put(chunk)
  const inheritedAgain = await store.prepareInheritedEvidence(id, merged, previous, before, expected)
  const consumed = store.observedRecords().map(record => record.revisionId)
  const target = await prepareLocalWorkspace(store.adapter, id, before.state, store.lifetime, before, inheritedAgain)
  const activation = await store.prepareActivation(id, target, expected, before)
  expect(store.describePreparation(activation).consumed.map(record => record.revisionId)).toEqual(expect.arrayContaining(consumed))
  await database.stagedCipherChunks.put({ ...chunk, bytes: altered })
  await expect(activateLocalAccountCommit(database, token, activation)).rejects.toThrow(/bytes changed/)
  expect(await database.profileMeta.get('active')).toEqual(expected)
  expect(await database.outbox.count()).toBe(0)
  await database.stagedCipherChunks.put(chunk)
  const counts = await Promise.all(database.tables.map(async table => [table.name, await table.count()]))
  const fail = () => { throw new Error('synthetic evidence activation failure') }
  database.profileMeta.hook('updating', fail)
  try { await expect(activateLocalAccountCommit(database, token, activation)).rejects.toThrow('synthetic evidence activation failure') }
  finally { database.profileMeta.hook('updating').unsubscribe(fail) }
  expect(await Promise.all(database.tables.map(async table => [table.name, await table.count()]))).toEqual(counts)
  expect(await database.profileMeta.get('active')).toEqual(expected)
  await activateLocalAccountCommit(database, token, activation)
  store.committed(id)
})

it.each(['finish', 'committed', 'dispose', 'profile'] as const)('expires an issued reuse proof during %s', async action => {
  const { store, before, expected, previous, database } = await installedEvidence()
  let armed = false
  const snapshot = ownWorkspaceSnapshot({ version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: 'expiring-input', capturedAt: '2026-11-16T00:00:00.000Z', revisionVector: {}, state: before.state }, { async check() {
    if (!armed) return
    armed = false
    if (action === 'finish') store.finishAdmission()
    else if (action === 'committed') store.committed('unrelated-operation')
    else if (action === 'dispose') await store.dispose()
    else invalidateProfile()
  }, async dispose() {} })
  const incoming = await guestEvidenceFromFrozenCurrent(snapshot)
  const merged = await mergeGuestEvidence(previous, incoming, previous.planner)
  armed = true
  await expect(store.prepareInheritedEvidence(accountLocalId(), merged, previous, before, expected)).rejects.toThrow()
  expect(await database.profileMeta.get('active')).toEqual(expected)
})

it('does not let a later successful decrypt replace pinned installed ciphertext observations', async () => {
  const { store, before, expected, previous, inherited, database, token } = await installedEvidence()
  const { readBlob, memoryBlob } = await import('./blobs')
  const { openAccountSource } = await import('./account-streams')
  const { withAccountKey } = await import('../account/profile')
  const { encryptRevision } = await import('../account/crypto/revisions')
  const row = (await evidenceRows(store, inherited)).find(row => row.table === 'evidenceChunks')!
  const record = (await database.encryptedRevisions.get(row.ref.revisionId))!
  const bytes = await readBlob(await store.adapter.read(row.ref), record.descriptor.plainBytes)
  const originalChunks = await database.stagedCipherChunks.where('payloadId').equals(record.payloadId).sortBy('index')
  const merged = await mergeGuestEvidence(previous, previous, previous.planner)
  await store.prepareInheritedEvidence(accountLocalId(), merged, previous, before, expected)
  const chunks: import('../persistence/account-database').CipherChunk[] = []
  const descriptor = record.descriptor
  const encrypted = await withAccountKey(token, key => encryptRevision(key, { format: 1, accountId: token.accountId, documentId: descriptor.documentId, revisionId: descriptor.revisionId, parents: descriptor.parents, dependencies: descriptor.dependencies, protected: descriptor.protected, plainBytes: descriptor.plainBytes }, accountLocalId(), memoryBlob(bytes).open(), { id: record.payloadId, async write(index, bytes) { chunks.push({ payloadId: record.payloadId, index, bytes: bytes.slice() }) } }))
  await database.encryptedRevisions.put({ ...record, descriptor: encrypted.descriptor })
  await database.stagedCipherChunks.bulkPut(chunks)
  try {
    expect(await readBlob(await openAccountSource(database, token, row.ref), bytes.length)).toEqual(bytes)
    await expect(readBlob(await store.adapter.read(row.ref), bytes.length)).rejects.toThrow('Retained managed evidence observation changed')
  } finally { await database.encryptedRevisions.put(record); await database.stagedCipherChunks.bulkPut(originalChunks) }
  expect(await readBlob(await store.adapter.read(row.ref), bytes.length)).toEqual(bytes)
})

it('upgrades a legacy archive without rewriting its original graph or collapsing native and catalog roles', async () => {
  vi.stubGlobal('__CRYKIT_COMPACT_CATALOG_QUALIFICATION__', true)
  const { store, before, expected, previous, inherited, database, token } = await installedEvidence(true)
  const { GUIDE_CATALOG } = await import('../catalog/bundled')
  const { captureCompactCatalogSnapshot } = await import('./catalog-capture')
  const { capturedBackupEvidence } = await import('../interchange/workspace-backup-evidence')
  const { guestEvidenceSources, compareGuestEvidence } = await import('./guest-evidence')
  const { memoryBlob, hashBlob, blobIdentity } = await import('./blobs')
  const timestamp = '2026-11-16T00:00:00.000Z'
  let state = { ...before.state, planner: { ...before.state.planner, catalogs: [GUIDE_CATALOG] } }
  const capture = () => captureCompactCatalogSnapshot(ownWorkspaceSnapshot({ version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: 'compact-addition', capturedAt: timestamp, revisionVector: {}, state }, { async check() { store.lifetime.check() }, async dispose() {} }))
  const catalog = capturedBackupEvidence(await capture()).catalogBodies![0].ref
  const content = memoryBlob(new Uint8Array([11, 12]))
  const native = { documentId: catalog.documentId, revisionId: catalog.revisionId, byteLength: content.byteLength, sha256: await hashBlob(content), encoding: 'bytes' as const }
  state = { ...state, saveDocuments: [...state.saveDocuments, { version: 1, id: 'native-catalog-collision', revision: 0, filename: 'original.dat', original: native, working: native, pendingForm: {}, requirements: [], coverage: { status: 'unsupported', diagnostics: [] }, createdAt: timestamp, updatedAt: timestamp, exportedRevision: null }], blobs: [...state.blobs, { ref: native, content }] }
  const incoming = await guestEvidenceFromFrozenCurrent(await capture())
  const merged = await mergeGuestEvidence(previous, incoming, previous.planner)
  const oldRows = await evidenceRows(store, inherited), operation = accountLocalId()
  const root = await store.prepareInheritedEvidence(operation, merged, previous, before, expected)
  const nextRows = await evidenceRows(store, root)
  for (const row of oldRows.filter(row => ['evidenceSegments', 'evidenceBlobs', 'evidenceChunks', 'plannerEvidence'].includes(row.table))) expect(nextRows.find(next => next.table === row.table && JSON.stringify(next.key) === JSON.stringify(row.key))?.ref).toEqual(row.ref)
  const reopened = (await readLocalEvidence(store.adapter, root, async () => store.lifetime.check()))!
  await compareGuestEvidence(merged, reopened)
  const sources = guestEvidenceSources(reopened)
  expect(sources.version).toBe(2)
  expect(sources.members.filter(member => member.format === 'legacy-v1').map(member => member.id)).toEqual(guestEvidenceSources(previous).members.map(member => member.id))
  const nativeBody = sources.bodies.find(body => blobIdentity(body.ref) === blobIdentity(native))!
  const catalogBody = sources.catalogBodies!.find(body => blobIdentity(body.ref) === blobIdentity(catalog))!
  expect(nativeBody.ref).toEqual(native); expect(catalogBody.ref).toEqual(catalog)
  expect(await hashBlob(nativeBody.content)).toBe(native.sha256)
  expect(await hashBlob(catalogBody.content)).toBe(catalog.sha256)
  expect(nextRows.find(row => row.table === 'evidenceBlobs' && row.key === blobIdentity(native))?.ref).not.toEqual(nextRows.find(row => row.table === 'evidenceBlobs' && row.key === `catalog-body:${blobIdentity(catalog)}`)?.ref)
  const target = await prepareLocalWorkspace(store.adapter, operation, before.state, store.lifetime, before, root)
  const selected = await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, target, expected, before))
  store.committed(operation)
  const nextStore = createAccountLocalStore(database, token); stores.push(nextStore)
  const installed = await admitLocalRoot(nextStore.adapter, selected.head, nextStore.lifetime)
  const archive = (await readLocalEvidence(nextStore.adapter, root, async () => nextStore.lifetime.check()))!
  const same = await mergeGuestEvidence(archive, archive, archive.planner), unchangedOperation = accountLocalId()
  expect(await nextStore.prepareInheritedEvidence(unchangedOperation, same, archive, installed, selected)).toEqual(root)
  expect(nextStore.stagedRecords(unchangedOperation)).toEqual([])
})

it('does not take the unchanged-root shortcut when planner evidence changes', async () => {
  const { store, before, expected, previous, inherited } = await installedEvidence()
  const planner = { ...previous.planner, savedChanges: [...previous.planner.savedChanges, { id: 'evidence-change' as import('../domain/types').ChangeId, command: 'synthetic.change', previousRevision: 0, nextRevision: 1, changedPaths: ['teams'], recordedAt: '2026-11-16T00:00:00.000Z' as import('../domain/types').Timestamp }] }
  const merged = await mergeGuestEvidence(previous, previous, planner)
  const oldRows = await evidenceRows(store, inherited)
  const root = await store.prepareInheritedEvidence(accountLocalId(), merged, previous, before, expected)
  expect(root).not.toEqual(inherited)
  const nextRows = await evidenceRows(store, root)
  for (const row of oldRows.filter(row => ['evidenceBlobs', 'evidenceChunks'].includes(row.table))) expect(nextRows.find(next => next.table === row.table && JSON.stringify(next.key) === JSON.stringify(row.key))?.ref).toEqual(row.ref)
  const reopened = (await readLocalEvidence(store.adapter, root, async () => store.lifetime.check()))!
  expect(reopened.planner).toEqual(planner)
  expect(reopened.setDigest).toBe(previous.setDigest)
})

it('requires both installed physical pages when distinct index refs have identical content', async () => {
  const { store, before, expected, previous, inherited, database } = await installedEvidence('equal-pages')
  const { localEvidenceReadAdmission } = await import('./local-evidence')
  const { admittedLocalIndexPages } = await import('./local-index')
  const admission = localEvidenceReadAdmission(previous, store.adapter, inherited)
  const empty = admittedLocalIndexPages(admission.index).filter(page => { const value = JSON.parse(page.encoded); return !value.entries.length && !value.children.length })
  expect(empty).toHaveLength(2)
  expect(empty[0].ref).not.toEqual(empty[1].ref)
  const merged = await mergeGuestEvidence(previous, previous, previous.planner)
  const operation = accountLocalId()
  const second = (await database.encryptedRevisions.get(empty[1].ref.revisionId))!
  await database.encryptedRevisions.delete(second.revisionId)
  try { await expect(store.prepareInheritedEvidence(operation, merged, previous, before, expected)).rejects.toThrow('Evidence reuse source is not installed') }
  finally { await database.encryptedRevisions.put(second) }
  const chunk = (await database.stagedCipherChunks.get([second.payloadId, 0]))!
  const bytes = chunk.bytes.slice(); bytes[0] ^= 1
  await database.stagedCipherChunks.put({ ...chunk, bytes })
  try { await expect(store.prepareInheritedEvidence(operation, merged, previous, before, expected)).rejects.toThrow('Consumed encrypted bytes changed') }
  finally { await database.stagedCipherChunks.put(chunk) }
  expect(await store.prepareInheritedEvidence(operation, merged, previous, before, expected)).toEqual(inherited)
  expect(store.stagedRecords(operation)).toEqual([])
  for (const page of empty) expect(store.observedRecords().some(record => record.revisionId === page.ref.revisionId)).toBe(true)
})
