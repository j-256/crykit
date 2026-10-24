import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, expect, it, vi } from 'vitest'
import { createBlankLocalData } from '../domain/local-data'
import { changedLocalData, saveLocalDataWithStatus } from './local-data'
import { CryKitDatabase } from './database'
import { GUEST_PLANNER_LAYOUT_KEY } from './guest-planner-record'
import { writePreparedGuestPlanner } from './guest-planner-store'
import { prepareGuestRestorePlanner } from '../workspace/guest-planner'
import { GuestFilesDatabase } from '../workspace/guest-files'
import { InspectorStorage } from '../mod-inspector/storage'
import { captureLegacyBranch, LegacyCaptureDatabase, type LegacyCapture } from '../workspace/legacy-capture'
import { openRequiredGuestPlanner } from '../workspace/open-required-guest-planner'
import { readUnselectedGuestCapture } from '../workspace/guest-snapshot'
import type { WorkspacePlannerState } from '../workspace/documents'
import { splitWorkspace } from '../workspace/documents'
import { ownWorkspaceSnapshot, validateWorkspaceSnapshot, disposeWorkspaceSnapshot, openHistoricalSnapshot, type WorkspaceSnapshotV1 } from '../workspace/snapshot'
import { joinWorkspaceSnapshotEvidence } from '../interchange/workspace-backup-evidence'
import { inheritWorkspaceSnapshot } from '../interchange/workspace-backup-evidence'
import { exportWorkspaceBackup, readWorkspaceBackup } from '../interchange/workspace-backup'
import { editorClosureFixture } from '../workspace/test-helpers'
import { emptyPlannerEvidence, guestEvidenceFromSnapshot, writeGuestEvidence } from '../workspace/guest-evidence'
import { BLOB_CHUNK_BYTES, readBlob } from '../workspace/blobs'
import { previewImport } from '../interchange/import'
import { BUNDLED_CATALOGS } from '../catalog/bundled'

const names: string[] = []
afterEach(async () => { for (const name of names.splice(0)) await Dexie.delete(name) })

async function fixture() {
  const prefix = `guest-v2-capture-${crypto.randomUUID()}`
  const id = crypto.randomUUID()
  const target = { version: 2 as const, id, revision: 1, planner: `crykit-restored-v2-${id}-planner`, inspector: `crykit-restored-v2-${id}-inspector`, files: `crykit-restored-v2-${id}-files` }
  const frozen = new LegacyCaptureDatabase(`${prefix}-frozen`)
  names.push(target.planner, target.inspector, target.files, frozen.name)
  const staged = new CryKitDatabase(target.planner)
  const localData = createBlankLocalData()
  const planner: WorkspacePlannerState = { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [], sources: [], evidence: [], history: [] }
  const preparation = prepareGuestRestorePlanner(planner, planner, 'replace')
  await writePreparedGuestPlanner(staged, preparation, { expectedStaged: { localDatas: [], catalogs: [], evidence: [], sources: [], history: [], imports: [], meta: [] }, assertOwned: () => {} })
  staged.close()
  const owner = { signal: new AbortController().signal, assertCurrent: () => undefined }
  const required = await openRequiredGuestPlanner(target.planner, owner)
  const inspector = new InspectorStorage(target.inspector)
  const files = new GuestFilesDatabase(target.files)
  const inspectorDatabase = await inspector.openDatabase()
  await files.open()
  const capture = () => captureLegacyBranch(frozen, [{ kind: 'planner' as const, database: required }, { kind: 'inspector' as const, database: inspectorDatabase }, { kind: 'files' as const, database: files }])
  const read = (captured: LegacyCapture, assertOwned: () => void = () => {}) => readUnselectedGuestCapture(frozen, captured, target, assertOwned)
  const close = () => { required.close(); inspector.close(); files.close(); frozen.close() }
  return { target, localData, required, inspector, files, frozen, capture, read, close }
}

async function nativeVector(setup: Awaited<ReturnType<typeof fixture>>) {
  const inspector = await setup.inspector.openDatabase()
  return {
    planner: await setup.required.transaction('r', setup.required.tables, async () => Promise.all(setup.required.tables.map(table => table.toArray()))),
    inspector: await inspector.transaction('r', inspector.tables, async () => Promise.all(inspector.tables.map(table => table.toArray()))),
    files: await setup.files.transaction('r', setup.files.tables, async () => Promise.all(setup.files.tables.map(table => table.toArray()))),
  }
}

it('projects one complete unselected journaled target from its frozen native participants', async () => {
  const setup = await fixture()
  try {
    const capture = await setup.capture()
    const { state, inherited } = await setup.read(capture)
    expect(state.planner.localData.id).toBe(setup.localData.id)
    expect(state.planner.journal).toMatchObject({ version: 1, undoable: false, checkpoints: [] })
    expect(state.planner.savedChanges).toEqual(state.planner.localData.changes)
    expect(state.editorDocuments).toEqual([])
    expect(inherited).toEqual({ members: [], bodies: [] })
  } finally { setup.close() }
})

it('rejects a v1 profile namespace even if the recorded frozen capture matches', async () => {
  const setup = await fixture()
  try {
    const capture = await setup.capture()
    const oldPrefix = { ...setup.target, planner: `crykit-profile-${setup.target.id}-planner`, inspector: `crykit-profile-${setup.target.id}-inspector`, files: `crykit-profile-${setup.target.id}-files` }
    await expect(readUnselectedGuestCapture(setup.frozen, capture, oldPrefix, () => {})).rejects.toThrow('identity')
  } finally { setup.close() }
})

it.each(['descriptor', 'declaration', 'extra-root'] as const)('denies a %s defect from the captured native target without repairing it', async defect => {
  const setup = await fixture()
  try {
    if (defect === 'descriptor') {
      const root = (await setup.required.localDatas.get('local-data-record'))!
      const { operativePlanner: _removed, ...stripped } = root
      await setup.required.localDatas.put(stripped)
    } else if (defect === 'declaration') await setup.required.meta.delete(GUEST_PLANNER_LAYOUT_KEY)
    else {
      const foreign = createBlankLocalData()
      await setup.required.localDatas.add({ id: 'foreign-root', localData: foreign, revision: foreign.revision, updatedAt: foreign.updatedAt, lineage: { rootLocalDataId: foreign.id } })
    }
    const capture = await setup.capture(), before = await nativeVector(setup)
    await expect(setup.read(capture)).rejects.toThrow()
    expect(await nativeVector(setup)).toEqual(before)
    expect(await setup.frozen.captures.get(capture.id)).toEqual(capture)
  } finally { setup.close() }
})

it('denies a mismatched target or changed frozen capture record without opening another target', async () => {
  const setup = await fixture()
  try {
    const capture = await setup.capture(), before = await nativeVector(setup)
    await expect(readUnselectedGuestCapture(setup.frozen, capture, { ...setup.target, planner: 'another-target' }, () => {})).rejects.toThrow()
    const first = (await setup.frozen.records.get([capture.id, 0]))!
    await setup.frozen.records.put({ ...first, table: 'foreign-table' })
    await expect(setup.read(capture)).rejects.toThrow()
    expect(await nativeVector(setup)).toEqual(before)
    expect(await Dexie.exists('another-target')).toBe(false)
  } finally { setup.close() }
})

it('denies a v2 manifest ID that does not own its captured deterministic participant names', async () => {
  const setup = await fixture()
  try {
    const capture = await setup.capture()
    await expect(readUnselectedGuestCapture(setup.frozen, capture, { ...setup.target, id: crypto.randomUUID() }, () => {})).rejects.toThrow()
  } finally { setup.close() }
})

it('denies an asynchronous owner callback without awaiting its rejection or reading target rows', async () => {
  const setup = await fixture()
  try {
    const capture = await setup.capture()
    await expect(setup.read(capture, async () => { throw new Error('retired') })).rejects.toThrow('synchronous')
  } finally { setup.close() }
})

it('keeps older genuine destination changes beyond the live window through a complete backup', async () => {
  const setup = await fixture()
  let imported: Awaited<ReturnType<typeof readWorkspaceBackup>> | undefined
  let joined: Awaited<ReturnType<typeof joinWorkspaceSnapshotEvidence>> | undefined
  try {
    const first = (await setup.required.localDatas.get('local-data-record'))!
    const oldest = first.operativePlanner!.savedDestinationChanges[0]!
    let proposed = first.localData
    for (let index = 0; index < 500; index++) proposed = changedLocalData(proposed, proposed, 'native-batch-change', proposed.updatedAt)
    const saved = await saveLocalDataWithStatus(proposed, first.revision, setup.required)
    await saveLocalDataWithStatus(saved.localData, saved.localData.revision, setup.required)
    const root = (await setup.required.localDatas.get('local-data-record'))!
    expect(root.localData.changes.some(change => change.id === oldest.id)).toBe(false)
    expect(root.operativePlanner!.savedDestinationChanges[0]).toEqual(oldest)
    const capture = await setup.capture(), before = await nativeVector(setup)
    const { state, inherited } = await setup.read(capture)
    expect(state.planner.savedChanges?.[0]).toEqual(oldest)
    expect(splitWorkspace(state).find(document => document.kind === 'change' && document.key === JSON.stringify(['change', oldest.id]))?.value).toEqual(oldest)
    const current: WorkspaceSnapshotV1 = { version: 1, snapshotId: crypto.randomUUID(), capturedAt: new Date().toISOString(), revisionVector: { guest: setup.target.id, capture: capture.id }, state }
    await validateWorkspaceSnapshot(current)
    joined = await joinWorkspaceSnapshotEvidence(ownWorkspaceSnapshot(current, { check: async () => {}, dispose: async () => {} }), inherited)
    imported = await readWorkspaceBackup(exportWorkspaceBackup(joined))
    expect(imported.state.planner.savedChanges?.[0]).toEqual(oldest)
    expect(await nativeVector(setup)).toEqual(before)
    setup.frozen.close()
    await setup.frozen.delete()
    // The archive reader already validates the full graph; source deletion must leave the exact saved change readable
    expect(imported.state.planner.savedChanges?.find(change => change.id === oldest.id)).toEqual(oldest)
  } finally { if (imported) await disposeWorkspaceSnapshot(imported); if (joined) await disposeWorkspaceSnapshot(joined); setup.close() }
})

it('keeps historical bytes in the same freeze and retires lazy historical readers between chunks', async () => {
  const setup = await fixture()
  let source: Awaited<ReturnType<typeof readWorkspaceBackup>> | undefined
  let inheritedSource: Awaited<ReturnType<typeof inheritWorkspaceSnapshot>> | undefined
  let joined: Awaited<ReturnType<typeof joinWorkspaceSnapshotEvidence>> | undefined
  let imported: Awaited<ReturnType<typeof readWorkspaceBackup>> | undefined
  try {
    const original = await editorClosureFixture()
    const bytes = new Uint8Array(BLOB_CHUNK_BYTES * 2 + 9).map((_, index) => index % 251)
    const ref = await original.add(bytes, 'large-historical-body', 'bytes')
    const state = { ...original.state, assets: [{ version: 1 as const, id: 'historical-asset', sourceKey: 'synthetic-source', relativePath: 'art.png', original: ref, mediaType: 'image/png' as const, width: 1, height: 1 }] }
    source = await readWorkspaceBackup(exportWorkspaceBackup({ version: 1, snapshotId: 'historical-source', capturedAt: '2026-10-13', revisionVector: { source: 'synthetic' }, state }))
    inheritedSource = await inheritWorkspaceSnapshot(source, [source])
    await writeGuestEvidence(setup.files, await guestEvidenceFromSnapshot(inheritedSource, emptyPlannerEvidence()))
    const capture = await setup.capture(), before = await nativeVector(setup)
    await disposeWorkspaceSnapshot(inheritedSource); inheritedSource = undefined
    await disposeWorkspaceSnapshot(source); source = undefined
    let current = true
    const projected = await setup.read(capture, () => { if (!current) throw new Error('retired captured owner') })
    expect(projected.inherited.members).toHaveLength(1)
    const historical = projected.inherited.bodies.find(body => body.ref.documentId === ref.documentId)!
    expect(await readBlob(historical.content, ref.byteLength)).toEqual(bytes)
    const currentSnapshot: WorkspaceSnapshotV1 = { version: 1, snapshotId: crypto.randomUUID(), capturedAt: new Date().toISOString(), revisionVector: { guest: setup.target.id, capture: capture.id }, state: projected.state }
    joined = await joinWorkspaceSnapshotEvidence(ownWorkspaceSnapshot(currentSnapshot, { check: async () => { if (!current) throw new Error('retired captured owner') }, dispose: async () => {} }), projected.inherited)
    imported = await readWorkspaceBackup(exportWorkspaceBackup(joined))
    if (imported.version !== 2) throw new Error('Historical backup did not retain its evidence')
    const iterator = historical.content.open()[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value?.length).toBe(BLOB_CHUNK_BYTES)
    current = false
    await expect(iterator.next()).rejects.toThrow('retired captured owner')
    await expect(readBlob(projected.inherited.members[0]!.metadata, projected.inherited.members[0]!.metadata.byteLength)).rejects.toThrow('retired captured owner')
    expect(await nativeVector(setup)).toEqual(before)
    setup.frozen.close()
    await setup.frozen.delete()
    const restored = await openHistoricalSnapshot(imported, imported.historicalEvidence.snapshots[0]!.id)
    const restoredBody = restored.state.blobs.find(blob => blob.ref.documentId === ref.documentId)!
    expect(await readBlob(restoredBody.content, ref.byteLength)).toEqual(bytes)
  } finally { if (imported) await disposeWorkspaceSnapshot(imported); if (joined) await disposeWorkspaceSnapshot(joined); if (inheritedSource) await disposeWorkspaceSnapshot(inheritedSource); if (source) await disposeWorkspaceSnapshot(source); setup.close() }
})

it('projects exact current source bytes and invalid Inspector draft UTF-16 under one owner', async () => {
  const setup = await fixture()
  try {
    const raw = new TextEncoder().encode(JSON.stringify({ ID: 'captured-source', Title: 'Captured source', EditorVersion: 34, Items: [{ ID: 71, Name: 'Synthetic item' }] }) + ' '.repeat(BLOB_CHUNK_BYTES * 2))
    const imported = await previewImport(raw, 'captured.json')
    const source = imported.proposed.sources[0]!
    await setup.required.sources.add(source)
    const draft = { schemaVersion: 1, id: 'invalid-editor-draft', revision: 1, filename: 'draft.json', referenceId: 'synthetic-reference', createdAt: '2026-10-13', updatedAt: '2026-10-13', originalText: '{"ok":true}', draftText: '\ud800invalid draft' }
    await (await setup.inspector.openDatabase()).table('drafts').add(draft)
    const capture = await setup.capture(), before = await nativeVector(setup)
    let current = true
    const { state } = await setup.read(capture, () => { if (!current) throw new Error('retired captured owner') })
    const sourceBody = state.blobs.find(blob => blob.ref.documentId === `source:${source.id}`)!
    expect(await readBlob(sourceBody.content, source.bytes.byteLength)).toEqual(source.bytes)
    const file = state.editorDocuments.find(value => value.id === draft.id)!
    expect(file.unfinished.validation).toBe('unchecked')
    const textBody = state.blobs.find(blob => blob.ref.documentId === file.unfinished.text.documentId)!
    const text = await readBlob(textBody.content, file.unfinished.text.byteLength)
    expect(Array.from({ length: text.length / 2 }, (_, index) => String.fromCharCode(text[index * 2] | text[index * 2 + 1] << 8)).join('')).toBe(draft.draftText)
    const iterator = sourceBody.content.open()[Symbol.asyncIterator]()
    expect((await iterator.next()).value?.length).toBe(BLOB_CHUNK_BYTES)
    current = false
    await expect(iterator.next()).rejects.toThrow('retired captured owner')
    await expect(readBlob(textBody.content, file.unfinished.text.byteLength)).rejects.toThrow('retired captured owner')
    expect(await nativeVector(setup)).toEqual(before)
  } finally { setup.close() }
})

it('deduplicates exact inherited saved changes and rejects changed same-ID originals', async () => {
  const setup = await fixture()
  let source: Awaited<ReturnType<typeof readWorkspaceBackup>> | undefined
  let inheritedSource: Awaited<ReturnType<typeof inheritWorkspaceSnapshot>> | undefined
  try {
    const original = await editorClosureFixture()
    source = await readWorkspaceBackup(exportWorkspaceBackup({ version: 1, snapshotId: 'saved-change-sidecar', capturedAt: '2026-10-13', revisionVector: { source: 'synthetic' }, state: original.state }))
    inheritedSource = await inheritWorkspaceSnapshot(source, [])
    const root = (await setup.required.localDatas.get('local-data-record'))!
    const change = root.operativePlanner!.savedDestinationChanges[0]!
    await writeGuestEvidence(setup.files, await guestEvidenceFromSnapshot(inheritedSource, { ...emptyPlannerEvidence(), savedChanges: [change] }))
    const identical = await setup.capture()
    const first = await setup.read(identical)
    expect(first.state.planner.savedChanges).toEqual([change])
    await writeGuestEvidence(setup.files, await guestEvidenceFromSnapshot(inheritedSource, { ...emptyPlannerEvidence(), savedChanges: [{ ...change, command: 'forged-command' }] }))
    const conflicting = await setup.capture(), before = await nativeVector(setup)
    await expect(setup.read(conflicting)).rejects.toThrow('Immutable guest planner evidence changed')
    expect(await nativeVector(setup)).toEqual(before)
  } finally { if (inheritedSource) await disposeWorkspaceSnapshot(inheritedSource); if (source) await disposeWorkspaceSnapshot(source); setup.close() }
})

it('orders operative checkpoints by the descriptor while retaining unlisted history as inert evidence', async () => {
  const setup = await fixture()
  try {
    const initial = (await setup.required.localDatas.get('local-data-record'))!
    const first = await saveLocalDataWithStatus(initial.localData, initial.revision, setup.required)
    await saveLocalDataWithStatus(first.localData, first.localData.revision, setup.required)
    const root = (await setup.required.localDatas.get('local-data-record'))!
    const original = root.operativePlanner!.checkpointIds
    const [firstRow, secondRow] = await Promise.all(original.map(id => setup.required.history.get(id)))
    const before = { ...firstRow!, id: 'z-first-operative' }, after = { ...secondRow!, id: 'a-second-operative' }
    await setup.required.transaction('rw', [setup.required.localDatas, setup.required.history], async () => {
      await setup.required.history.bulkDelete([...original])
      await setup.required.history.bulkAdd([after, before, { ...after, id: 'b-unlisted-match' }, { ...after, id: 'c-unlisted-conflict', command: 'unlisted contradictory branch' }])
      await setup.required.localDatas.put({ ...root, operativePlanner: { ...root.operativePlanner!, checkpointIds: [before.id, after.id] } })
    })
    const capture = await setup.capture(), vector = await nativeVector(setup)
    const { state } = await setup.read(capture)
    expect(state.planner.journal?.checkpoints.map(entry => entry.id)).toEqual(['z-first-operative', 'a-second-operative'])
    expect(state.planner.journal?.undoable).toBe(true)
    expect(state.planner.history.map(entry => entry.id)).toEqual(expect.arrayContaining(['b-unlisted-match', 'c-unlisted-conflict']))
    expect(state.planner.journal?.checkpoints.map(entry => entry.id)).not.toContain('b-unlisted-match')
    expect(await nativeVector(setup)).toEqual(vector)
  } finally { setup.close() }
})

it.each(['wrapper', 'packaged-pin'] as const)('denies a captured %s mismatch without changing native rows', async defect => {
  const setup = await fixture()
  try {
    const bundled = BUNDLED_CATALOGS[0]!
    const snapshot = defect === 'packaged-pin' ? { ...bundled, applicability: { ...bundled.applicability, value: 'forged applicability' } } : bundled
    await setup.required.catalogs.add({ key: JSON.stringify([bundled.id, bundled.revisionId]), id: bundled.id, revisionId: bundled.revisionId, checksum: defect === 'wrapper' ? 'forged-checksum' : bundled.checksum, snapshot })
    const capture = await setup.capture(), before = await nativeVector(setup)
    await expect(setup.read(capture)).rejects.toThrow(defect === 'wrapper' ? 'Catalog wrapper' : 'Stored packaged catalog')
    expect(await nativeVector(setup)).toEqual(before)
  } finally { setup.close() }
})

it('denies a missing frozen table terminator instead of projecting a truncated target', async () => {
  const setup = await fixture()
  try {
    const capture = await setup.capture(), before = await nativeVector(setup)
    const terminator = (await setup.frozen.records.where('captureId').equals(capture.id).toArray()).find(row => row.kind === 'table-end')!
    await setup.frozen.records.delete([capture.id, terminator.ordinal])
    await expect(setup.read(capture)).rejects.toThrow()
    expect(await nativeVector(setup)).toEqual(before)
  } finally { setup.close() }
})

it('denies a frozen record that returns after its caller owner retires', async () => {
  const setup = await fixture()
  try {
    const capture = await setup.capture(), before = await nativeVector(setup)
    const original = setup.frozen.records.get.bind(setup.frozen.records)
    let requests = 0
    let release!: () => void, entered!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const requested = new Promise<void>(resolve => { entered = resolve })
    vi.spyOn(setup.frozen.records, 'get').mockImplementation((key) => {
      requests++
      entered()
      return Dexie.Promise.resolve(pending).then(() => original(key))
    })
    let current = true
    const reading = setup.read(capture, () => { if (!current) throw new Error('retired captured owner') })
    await requested
    current = false
    release()
    await expect(reading).rejects.toThrow('retired captured owner')
    expect(requests).toBe(1)
    expect(await nativeVector(setup)).toEqual(before)
  } finally { vi.restoreAllMocks(); setup.close() }
})
