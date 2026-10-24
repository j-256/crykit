import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { GuestFilesDatabase } from '../workspace/guest-files'

// Exercise native v1/v2 compatibility directly before public startup migrates these stores to managed storage
vi.mock('../workspace/guest-managed-startup', async importOriginal => {
  const actual = await importOriginal<typeof import('../workspace/guest-managed-startup')>()
  const { openGuestBindings } = await import('../workspace/guest-workspace')
  return { ...actual, prepareGuestStartup: async (original: import('./database').CryKitDatabase) => ({ kind: 'legacy-recovery', binding: await openGuestBindings(original) }) }
})

it('creates and transactionally upgrades the named files layout with mandatory empty evidence', async () => {
  for (const legacy of [false, true]) {
    const name = `guest-evidence-${crypto.randomUUID()}`
    if (legacy) {
      const old = new Dexie(name)
      old.version(1).stores({ documents: 'key', blobs: 'key', chunks: '[key+index], key', meta: 'key' })
      await old.table('documents').put({ key: 'libraryDefaults', value: { version: 1, layers: [] } }); old.close()
    }
    const db = new GuestFilesDatabase(name)
    try {
      await db.open()
      expect(db.verno).toBe(2)
      expect(await db.documents.get('workspaceExtensions')).toMatchObject({ value: { version: 1, kind: 'guest-workspace-extensions' } })
      expect(await db.table('evidenceRoots').count()).toBeGreaterThan(0)
      expect(await db.table('plannerEvidence').count()).toBe(1)
    } finally { await db.delete() }
  }
})
it('rolls back schema and rows when legacy extension declarations are invalid', async () => {
  const name = `guest-evidence-invalid-${crypto.randomUUID()}`, old = new Dexie(name)
  old.version(1).stores({ documents: 'key', blobs: 'key', chunks: '[key+index], key', meta: 'key' })
  await old.table('documents').put({ key: 'workspaceExtensions', value: {} }); old.close()
  const db = new GuestFilesDatabase(name)
  try {
    await expect(db.open()).rejects.toThrow()
    const original = new Dexie(name)
    await original.open()
    expect(original.verno).toBe(1)
    expect(await original.table('documents').toArray()).toEqual([{ key: 'workspaceExtensions', value: {} }])
    original.close()
  } finally { await db.delete() }
})

it('reopens the strict empty graph and rejects missing and unreachable extension rows', async () => {
  const { readGuestEvidence, databaseEvidenceRows } = await import('../workspace/guest-evidence')
  const db = new GuestFilesDatabase(`guest-evidence-graph-${crypto.randomUUID()}`)
  try {
    await db.open()
    const read = () => readGuestEvidence(databaseEvidenceRows(db), async () => {})
    expect((await read()).setDigest).toBe('b31b613c1f568466840704190d9a418278ba187123148b5c31c8d0d979840297')
    await db.table('evidenceSegments').add({ key: 'orphan', bytes: new Uint8Array([1]) })
    await expect(read()).rejects.toThrow(/orphan/i)
    await db.table('evidenceSegments').delete('orphan')
    await db.documents.delete('workspaceExtensions')
    await expect(read()).rejects.toThrow()
  } finally { await db.delete() }
})
it('carries empty v2 evidence through ordinary complete commands and frozen export', async () => {
  const { CryKitDatabase } = await import('./database')
  const { createGuestRepository, guestRepositoryBindings } = await import('../workspace/guest-repository')
  const { captureGuestSnapshot } = await import('../workspace/guest-snapshot')
  const { disposeWorkspaceSnapshot } = await import('../workspace/snapshot')
  const db = new CryKitDatabase(`guest-evidence-command-${crypto.randomUUID()}`)
  const repository = createGuestRepository(db)
  try {
    const initial = await repository.readWorkspace()
    await repository.commitWorkspace(initial, initial.planner.localData.revision)
    const successor = createGuestRepository(db), binding = await guestRepositoryBindings(successor)
    const snapshot = await captureGuestSnapshot(binding)
    try { expect(snapshot.version).toBe(2); expect(snapshot).toHaveProperty('historicalEvidence.snapshots', []) } finally { await disposeWorkspaceSnapshot(snapshot) }
  } finally { await db.delete() }
})

describe('inert originals across exact persisted successor and archive reread', () => {
  let captured: import('../workspace/snapshot').WorkspaceSnapshot | undefined
  let originalMetadata: string
  let cleanup: (() => Promise<void>) | undefined
  const prepareOriginal = async () => {
    const { CryKitDatabase } = await import('./database')
    const { createGuestRepository, guestRepositoryBindings } = await import('../workspace/guest-repository')
    const { captureGuestSnapshot } = await import('../workspace/guest-snapshot')
    const { disposeWorkspaceSnapshot, snapshotMetadata } = await import('../workspace/snapshot')
    const { exportWorkspaceBackup, readWorkspaceBackup } = await import('../interchange/workspace-backup')
    const { editorClosureFixture } = await import('../workspace/test-helpers')
    const { createPersonalDefinition } = await import('../domain/local-data')
    const imports = await import('../workspace/guest-evidence-import')
    expect(imports).toHaveProperty('importGuestInheritedEvidence')
    const db = new CryKitDatabase(`guest-evidence-import-${crypto.randomUUID()}`), repository = createGuestRepository(db)
    const { state } = await editorClosureFixture()
    const source = await readWorkspaceBackup(exportWorkspaceBackup({ version: 1, snapshotId: 'inert-import', capturedAt: '2026-10-12', revisionVector: { original: 'source' }, state }))
    const expected = JSON.stringify(snapshotMetadata(source))
    cleanup = async () => { if (captured) await disposeWorkspaceSnapshot(captured); await disposeWorkspaceSnapshot(source); await db.delete() }
    originalMetadata = expected
    {
      const before = await repository.readWorkspace(), binding = await guestRepositoryBindings(repository)
      await imports.importGuestInheritedEvidence(binding, source)
      await disposeWorkspaceSnapshot(source)
      const selected = createGuestRepository(db), after = await selected.readWorkspace()
      expect(after.planner.localData).toEqual(before.planner.localData)
      expect(after.planner.history).toEqual(before.planner.history)
      expect(after.editorDocuments).toEqual([])
      expect(after.blobs).toEqual([])
      const saved = await selected.save(createPersonalDefinition(after.planner.localData, { name: 'Destination edit', kind: 'item' }), after.planner.localData.revision)
      await selected.undo(saved.localData.revision)
      const edited = await selected.readWorkspace()
      await selected.commitWorkspace(edited, edited.planner.localData.revision)
      const successor = createGuestRepository(db)
      captured = await captureGuestSnapshot(await guestRepositoryBindings(successor))
    }
  }
  afterAll(async () => { await cleanup?.() })
  it('retains exact historical metadata after source disposal, planner undo and a full command', async () => {
    // Full native capture is part of this bulk journey, separate from ordinary command latency
    await prepareOriginal()
    const { openHistoricalSnapshot, disposeWorkspaceSnapshot, snapshotMetadata } = await import('../workspace/snapshot')
    if (captured?.version !== 2) throw new Error('Missing evidence')
    expect(captured.historicalEvidence.snapshots).toHaveLength(1)
    const child = await openHistoricalSnapshot(captured, captured.historicalEvidence.snapshots[0].id)
    try { expect(JSON.stringify(snapshotMetadata(child))).toBe(originalMetadata) } finally { await disposeWorkspaceSnapshot(child) }
  })
  it('independently reimports the exact persisted successor capture as a 1.1 archive', async () => {
    const { readWorkspaceBackup, exportWorkspaceBackup } = await import('../interchange/workspace-backup')
    const { disposeWorkspaceSnapshot, openHistoricalSnapshot, snapshotMetadata } = await import('../workspace/snapshot')
    if (captured?.version !== 2) throw new Error('Missing evidence')
    const reopened = await readWorkspaceBackup(exportWorkspaceBackup(captured))
    try {
      expect(reopened.version).toBe(2)
      if (reopened.version !== 2) throw new Error('Missing evidence')
      expect(reopened.historicalEvidence).toEqual(captured.historicalEvidence)
      const child = await openHistoricalSnapshot(reopened, reopened.historicalEvidence.snapshots[0].id)
      try { expect(JSON.stringify(snapshotMetadata(child))).toBe(originalMetadata) } finally { await disposeWorkspaceSnapshot(child) }
    } finally { await disposeWorkspaceSnapshot(reopened) }
  })
})

it('owned file receipts reject an independently valid but changed successor sidecar', async () => {
  const { CryKitDatabase } = await import('./database')
  const { createGuestRepository, guestRepositoryBindings } = await import('../workspace/guest-repository')
  const { commitOwnedFile, newOwnedFileCommand, resolveOwnedFileReceipt } = await import('../workspace/owned-file-command')
  const { prepareEmptyGuestEvidence, GUEST_EVIDENCE_STORES } = await import('../workspace/guest-evidence')
  const db = new CryKitDatabase(`guest-evidence-receipt-${crypto.randomUUID()}`), repository = createGuestRepository(db)
  try {
    const { readWorkspaceBackup, exportWorkspaceBackup } = await import('../interchange/workspace-backup')
    const { editorClosureFixture } = await import('../workspace/test-helpers')
    const { importGuestInheritedEvidence } = await import('../workspace/guest-evidence-import')
    const { disposeWorkspaceSnapshot } = await import('../workspace/snapshot')
    const source = await readWorkspaceBackup(exportWorkspaceBackup({ version: 1, snapshotId: 'receipt-source', capturedAt: '2026-10-12', revisionVector: {}, state: (await editorClosureFixture()).state }))
    await repository.readWorkspace()
    try { await importGuestInheritedEvidence(await guestRepositoryBindings(repository), source) } finally { await disposeWorkspaceSnapshot(source) }
    const current = createGuestRepository(db)
    const before = await current.readWorkspace()
    const outcome = await commitOwnedFile(current, before, before, newOwnedFileCommand('apply'))
    expect(outcome.status).toBe('saved')
    const selected = createGuestRepository(db), binding = await guestRepositoryBindings(selected)
    await binding.files.open()
    // A valid empty graph must not replace the receipt's inherited original set
    for (const table of Object.keys(GUEST_EVIDENCE_STORES)) await binding.files.table(table).clear()
    for (const { table, row } of await prepareEmptyGuestEvidence()) await binding.files.table(table).put(row)
    await expect(resolveOwnedFileReceipt(outcome.receipt!)).rejects.toThrow()
  } finally { await db.delete() }
})

it('preserves source saved changes and journal as inert evidence while genuine destination commands remain undoable', async () => {
  const { readFileSync } = await import('node:fs')
  const { readWorkspaceBackup } = await import('../interchange/workspace-backup')
  const { memoryBlob } = await import('../workspace/blobs')
  const { disposeWorkspaceSnapshot } = await import('../workspace/snapshot')
  const { CryKitDatabase } = await import('./database')
  const { createGuestRepository, guestRepositoryBindings } = await import('../workspace/guest-repository')
  const { importGuestInheritedEvidence } = await import('../workspace/guest-evidence-import')
  const { readGuestEvidence, databaseEvidenceRows } = await import('../workspace/guest-evidence')
  const { createPersonalDefinition } = await import('../domain/local-data')
  const fixture = JSON.parse(readFileSync(new URL('../interchange/workspace-backup-v1.fixtures.json', import.meta.url), 'utf8'))[2]
  const source = await readWorkspaceBackup(memoryBlob(Buffer.from(fixture.archive, 'base64')).open())
  const db = new CryKitDatabase(`guest-evidence-journal-${crypto.randomUUID()}`), repository = createGuestRepository(db)
  try {
    const before = await repository.readWorkspace()
    await importGuestInheritedEvidence(await guestRepositoryBindings(repository), source)
    await disposeWorkspaceSnapshot(source)
    const selected = createGuestRepository(db), binding = await guestRepositoryBindings(selected), state = await selected.readWorkspace()
    const sidecar = await readGuestEvidence(databaseEvidenceRows(binding.files), async () => {})
    expect(sidecar.planner.importedJournal).toEqual(fixture.metadata.state.planner.journal)
    expect(sidecar.planner.savedChanges).toEqual(fixture.metadata.state.planner.savedChanges ?? fixture.metadata.state.planner.localData.changes)
    expect(state.planner).not.toHaveProperty('journal')
    expect(state.planner.history).toEqual(before.planner.history)
    expect(state.planner.sources).toEqual([])
    const saved = await selected.save(createPersonalDefinition(state.planner.localData, { name: 'Real local command', kind: 'item' }), state.planner.localData.revision)
    await selected.undo(saved.localData.revision)
    const next = await selected.readWorkspace()
    await selected.commitWorkspace(next, next.planner.localData.revision)
    expect((await createGuestRepository(db).readWorkspace()).planner).not.toHaveProperty('journal')
  } finally { await disposeWorkspaceSnapshot(source); await db.delete() }
})

it('retains property-order originals and account annex streams exactly after independent guest reopening', async () => {
  const { readFileSync } = await import('node:fs')
  const { readWorkspaceBackup, exportWorkspaceBackup } = await import('../interchange/workspace-backup')
  const { memoryBlob } = await import('../workspace/blobs')
  const { disposeWorkspaceSnapshot, snapshotMetadata } = await import('../workspace/snapshot')
  const { metadataSource, historicalEvidenceId, equalMetadataStreams } = await import('../interchange/workspace-backup-evidence')
  const { CryKitDatabase } = await import('./database')
  const { createGuestRepository, guestRepositoryBindings } = await import('../workspace/guest-repository')
  const { importGuestInheritedEvidence } = await import('../workspace/guest-evidence-import')
  const { readGuestEvidence, databaseEvidenceRows, guestEvidenceSources } = await import('../workspace/guest-evidence')
  const fixtures = JSON.parse(readFileSync(new URL('../interchange/workspace-backup-v1.fixtures.json', import.meta.url), 'utf8'))
  const db = new CryKitDatabase(`guest-evidence-streams-${crypto.randomUUID()}`), expected = new Map<string, ReturnType<typeof metadataSource>>()
  try {
    for (const index of [0, 1, 0]) {
      const source = await readWorkspaceBackup(memoryBlob(Buffer.from(fixtures[index].archive, 'base64')).open())
      try {
        const metadata = metadataSource(structuredClone(snapshotMetadata(source)))
        expected.set(await historicalEvidenceId(metadata), metadata)
        const repository = createGuestRepository(db)
        await repository.readWorkspace()
        await importGuestInheritedEvidence(await guestRepositoryBindings(repository), source)
      } finally { await disposeWorkspaceSnapshot(source) }
    }
    const first = await readWorkspaceBackup(memoryBlob(Buffer.from(fixtures[0].archive, 'base64')).open())
    const raw = snapshotMetadata(first)
    await disposeWorkspaceSnapshot(first)
    const { editorClosureFixture } = await import('../workspace/test-helpers')
    const { state, file } = await editorClosureFixture()
    for (const fields of [{ zeta: 'z', alpha: 'a' }, { alpha: 'a', zeta: 'z' }]) {
      const source = await readWorkspaceBackup(exportWorkspaceBackup({ version: 1, snapshotId: raw.snapshotId, capturedAt: raw.capturedAt, revisionVector: raw.revisionVector, state: { ...state, editorDocuments: [{ ...file, unfinished: { ...file.unfinished, fieldState: fields } }] } }))
      try {
        const metadata = metadataSource(structuredClone(snapshotMetadata(source)))
        expected.set(await historicalEvidenceId(metadata), metadata)
        const repository = createGuestRepository(db)
        await importGuestInheritedEvidence(await guestRepositoryBindings(repository), source)
      } finally { await disposeWorkspaceSnapshot(source) }
    }
    const binding = await guestRepositoryBindings(createGuestRepository(db))
    const reopened = new GuestFilesDatabase(binding.manifest.files)
    try {
      await reopened.open()
      const evidence = await readGuestEvidence(databaseEvidenceRows(reopened), async () => {})
      const members = guestEvidenceSources(evidence).members
      expect(members.map(member => member.id)).toEqual([...expected.keys()].sort())
      for (const member of members) expect(await equalMetadataStreams(member.metadata, expected.get(member.id)!)).toBe(true)
    } finally { reopened.close() }
  } finally { await db.delete() }
})

it('rejects a blocked native upgrade visibly without changing source schema or rows', async () => {
  const name = `guest-evidence-blocked-${crypto.randomUUID()}`
  const old = new Dexie(name)
  old.version(1).stores({ documents: 'key', blobs: 'key', chunks: '[key+index], key', meta: 'key' })
  await old.table('documents').add({ key: 'libraryDefaults', value: { version: 1, layers: [] } }); old.close()
  const native = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
  native.onversionchange = () => {}
  const target = new GuestFilesDatabase(name)
  let blocked!: () => void
  const observed = new Promise<void>(resolve => { blocked = resolve })
  target.on('blocked', () => { blocked() })
  const opened = target.open().then(() => 'opened', error => String(error))
  await observed
  native.close()
  const outcome = await opened
  expect(outcome).toMatch(/blocked/i)
  const read = new Dexie(name)
  try { await read.open(); expect(read.verno).toBe(1); expect(await read.table('documents').toArray()).toEqual([{ key: 'libraryDefaults', value: { version: 1, layers: [] } }]) } finally { read.close(); await target.delete() }
})

it('preserves accepted large token pages without splitting their JSON token boundary', async () => {
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const { exportWorkspaceBackup, readWorkspaceBackup } = await import('../interchange/workspace-backup')
  const { disposeWorkspaceSnapshot } = await import('../workspace/snapshot')
  const { createGuestRepository, guestRepositoryBindings } = await import('../workspace/guest-repository')
  const { CryKitDatabase } = await import('./database')
  const { importGuestInheritedEvidence } = await import('../workspace/guest-evidence-import')
  const { state, file } = await editorClosureFixture()
  const largeKey = 'x'.repeat(90_000)
  const source = await readWorkspaceBackup(exportWorkspaceBackup({ version: 1, snapshotId: 'large-key', capturedAt: '2026-10-12', revisionVector: {}, state: { ...state, editorDocuments: [{ ...file, unfinished: { ...file.unfinished, fieldState: { [largeKey]: 'inert' } } }] } }))
  const db = new CryKitDatabase(`guest-evidence-token-${crypto.randomUUID()}`), repository = createGuestRepository(db)
  try { await repository.readWorkspace(); await importGuestInheritedEvidence(await guestRepositoryBindings(repository), source) } finally { await disposeWorkspaceSnapshot(source); await db.delete() }
})

describe('strict inherited storage graph and frozen identity', () => {
  let db: import('./database').CryKitDatabase
  let binding: import('../workspace/guest-workspace').GuestBindings
  let snapshot: import('../workspace/snapshot').WorkspaceSnapshot | undefined
  const prepareOriginal = async () => {
    const { CryKitDatabase } = await import('./database')
    const { createGuestRepository, guestRepositoryBindings } = await import('../workspace/guest-repository')
    const { editorClosureFixture } = await import('../workspace/test-helpers')
    const { exportWorkspaceBackup, readWorkspaceBackup } = await import('../interchange/workspace-backup')
    const { disposeWorkspaceSnapshot } = await import('../workspace/snapshot')
    const { importGuestInheritedEvidence } = await import('../workspace/guest-evidence-import')
    db = new CryKitDatabase(`guest-evidence-corruption-${crypto.randomUUID()}`)
    const repository = createGuestRepository(db)
    await repository.readWorkspace()
    const source = await readWorkspaceBackup(exportWorkspaceBackup({ version: 1, snapshotId: 'graph-original', capturedAt: '2026-10-12', revisionVector: {}, state: (await editorClosureFixture()).state }))
    try { await importGuestInheritedEvidence(await guestRepositoryBindings(repository), source) } finally { await disposeWorkspaceSnapshot(source) }
    binding = await guestRepositoryBindings(createGuestRepository(db))
    const { captureGuestSnapshot } = await import('../workspace/guest-snapshot')
    snapshot = await captureGuestSnapshot(binding)
  }
  afterAll(async () => { if (snapshot) await (await import('../workspace/snapshot')).disposeWorkspaceSnapshot(snapshot); await db?.delete() })
  it('rejects every missing declared graph component without a legacy-empty downgrade', async () => {
    await prepareOriginal()
    const { readGuestEvidence, databaseEvidenceRows } = await import('../workspace/guest-evidence')
    const read = () => readGuestEvidence(databaseEvidenceRows(binding.files), async () => {})
    for (const tableName of ['evidenceRoots', 'evidencePages', 'evidenceSegments', 'plannerEvidence', 'evidenceBlobs', 'evidenceChunks']) {
      const table = binding.files.table(tableName), key = (await table.toCollection().primaryKeys())[0], row = await table.get(key)
      expect(row).toBeDefined()
      await table.delete(key)
      try { await expect(read()).rejects.toThrow() } finally { await table.put(row) }
    }
    const row = await binding.files.documents.get('workspaceExtensions')
    await binding.files.documents.delete('workspaceExtensions')
    try { await expect(read()).rejects.toThrow() } finally { await binding.files.documents.put(row!) }
  })
  it('invalidates the frozen owner after same-pointer sentinel, page, segment, body and planner-evidence mutation', async () => {
    const { assertWorkspaceSnapshotCurrent } = await import('../workspace/snapshot')
    for (const tableName of ['documents', 'evidenceRoots', 'evidencePages', 'evidenceSegments', 'plannerEvidence', 'evidenceBlobs', 'evidenceChunks']) {
      const table = binding.files.table(tableName), key = tableName === 'documents' ? 'workspaceExtensions' : (await table.toCollection().primaryKeys())[0], row = await table.get(key)
      await table.put({ ...row, unexpectedMutation: true })
      try { await expect(assertWorkspaceSnapshotCurrent(snapshot!)).rejects.toMatchObject({ code: 'SNAPSHOT_CHANGED' }) } finally { await table.put(row) }
    }
    await (await import('../workspace/snapshot')).assertWorkspaceSnapshotCurrent(snapshot!)
  })
  it('rejects trailing and orphan native chunks and declared member identity changes', async () => {
    const { readGuestEvidence, databaseEvidenceRows } = await import('../workspace/guest-evidence')
    const read = () => readGuestEvidence(databaseEvidenceRows(binding.files), async () => {})
    const row = (await binding.files.table('evidenceBlobs').toArray())[0]
    for (const chunk of [{ key: row.key, index: 999, bytes: new Uint8Array([1]) }, { key: 'orphan', index: 0, bytes: new Uint8Array([1]) }]) {
      await binding.files.table('evidenceChunks').add(chunk)
      try { await expect(read()).rejects.toThrow(/orphan|missing/i) } finally { await binding.files.table('evidenceChunks').delete([chunk.key, chunk.index]) }
    }
    const segment = (await binding.files.table('evidenceSegments').toArray())[0]
    const bytes = segment.bytes.slice(); bytes[0] ^= 1
    await binding.files.table('evidenceSegments').put({ ...segment, bytes })
    try { await expect(read()).rejects.toThrow(/segment/i) } finally { await binding.files.table('evidenceSegments').put(segment) }
  })
})

it('awaits quota and cancellation cleanup while retaining the selected empty migration and source owner', async () => {
  const { vi } = await import('vitest')
  const { CryKitDatabase } = await import('./database')
  const { createGuestRepository, guestRepositoryBindings } = await import('../workspace/guest-repository')
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const { readWorkspaceBackup, exportWorkspaceBackup } = await import('../interchange/workspace-backup')
  const { assertWorkspaceSnapshotCurrent, disposeWorkspaceSnapshot } = await import('../workspace/snapshot')
  const { importGuestInheritedEvidence } = await import('../workspace/guest-evidence-import')
  const db = new CryKitDatabase(`guest-evidence-failure-${crypto.randomUUID()}`), repository = createGuestRepository(db)
  const source = await readWorkspaceBackup(exportWorkspaceBackup({ version: 1, snapshotId: 'quota-source', capturedAt: '2026-10-12', revisionVector: {}, state: (await editorClosureFixture()).state }))
  try {
    await repository.readWorkspace()
    const binding = await guestRepositoryBindings(repository)
    await (await import('../workspace/guest-workspace')).guestParticipants(binding)
    const before = (await Dexie.getDatabaseNames()).sort(), manifest = await binding.coordinator.active.get('active')
    const abort = new AbortController(); abort.abort()
    await expect(importGuestInheritedEvidence(binding, source, { signal: abort.signal })).rejects.toThrow()
    const original = IDBObjectStore.prototype.add
    const fault = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'evidenceSegments' && this.transaction.db.name.startsWith('crykit-profile-')) throw new DOMException('Synthetic quota failure', 'QuotaExceededError')
      return original.apply(this, args)
    })
    try { await expect(importGuestInheritedEvidence(binding, source)).rejects.toThrow(/quota/i) } finally { fault.mockRestore() }
    expect((await Dexie.getDatabaseNames()).sort()).toEqual(before)
    expect(await binding.coordinator.active.get('active')).toEqual(manifest)
    expect(await binding.files.documents.get('workspaceExtensions')).toBeDefined()
    await assertWorkspaceSnapshotCurrent(source)
  } finally { await disposeWorkspaceSnapshot(source); await db.delete() }
})

it.each([1, 2])('recovery copies the captured v%s evidence without changing selected or source rows', async version => {
  const { CryKitDatabase } = await import('./database')
  const { createGuestRepository, guestRepositoryBindings } = await import('../workspace/guest-repository')
  const { readWorkspaceBackup, exportWorkspaceBackup } = await import('../interchange/workspace-backup')
  const { disposeWorkspaceSnapshot } = await import('../workspace/snapshot')
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const { importGuestInheritedEvidence } = await import('../workspace/guest-evidence-import')
  const { readGuestEvidence, databaseEvidenceRows, compareGuestEvidence, guestEvidenceSources } = await import('../workspace/guest-evidence')
  const { guestParticipants } = await import('../workspace/guest-workspace')
  const { captureLegacyBranch, readLegacyCapture } = await import('../workspace/legacy-capture')
  const { copyGuestRecovery } = await import('../workspace/guest-recovery')
  const db = new CryKitDatabase(`guest-recovery-evidence-${crypto.randomUUID()}`), oldFiles = new Dexie(`guest-recovery-v1-${crypto.randomUUID()}`)
  oldFiles.version(1).stores({ documents: 'key', blobs: 'key', chunks: '[key+index], key', meta: 'key' })
  const source = await readWorkspaceBackup(exportWorkspaceBackup({ version: 1, snapshotId: 'recovery-original', capturedAt: '2026-10-12', revisionVector: {}, state: (await editorClosureFixture()).state }))
  try {
    let repository = createGuestRepository(db)
    await repository.readWorkspace()
    if (version === 2) {
      await importGuestInheritedEvidence(await guestRepositoryBindings(repository), source)
      repository = createGuestRepository(db)
    }
    const sourceBinding = await guestRepositoryBindings(repository), sourceParticipants = await guestParticipants(sourceBinding)
    await oldFiles.open()
    const recovery = await captureLegacyBranch(sourceBinding.coordinator, version === 1 ? sourceParticipants.map(participant => participant.kind === 'files' ? { kind: 'files', database: oldFiles } : participant) : sourceParticipants)
    const frozenRows = []
    for await (const row of readLegacyCapture(sourceBinding.coordinator, recovery)) frozenRows.push(row)
    const expectedEvidence = version === 2 ? await (await import('../workspace/guest-evidence-capture')).readCapturedGuestEvidence(sourceBinding.coordinator, recovery, async () => {}) : undefined
    // Change the selected sidecar independently so using it instead of recovery evidence is observable
    if (version === 1) await importGuestInheritedEvidence(sourceBinding, source)
    else {
      const empty = new GuestFilesDatabase(`guest-recovery-empty-${crypto.randomUUID()}`)
      try { await empty.open(); await (await import('../workspace/guest-evidence')).writeGuestEvidence(sourceBinding.files, await readGuestEvidence(databaseEvidenceRows(empty), async () => {})) } finally { await empty.delete() }
    }
    const selected = createGuestRepository(db), binding = await guestRepositoryBindings(selected)
    const selectedRows = await binding.files.documents.toArray()
    await copyGuestRecovery(binding, recovery, () => true)
    const reopened = createGuestRepository(db), reopenedState = await reopened.readWorkspace(), recovered = await guestRepositoryBindings(reopened)
    const actualEvidence = await readGuestEvidence(databaseEvidenceRows(recovered.files), async () => {})
    expect(guestEvidenceSources(actualEvidence).members).toHaveLength(version === 1 ? 0 : 1)
    if (version === 1) expect(actualEvidence.planner.savedChanges).toEqual([])
    else await compareGuestEvidence(expectedEvidence!, actualEvidence)
    expect(reopenedState.editorDocuments).toEqual([])
    expect(await binding.files.documents.toArray()).toEqual(selectedRows)
    const afterRows = []
    for await (const row of readLegacyCapture(sourceBinding.coordinator, recovery)) afterRows.push(row)
    expect(afterRows).toEqual(frozenRows)
    expect(oldFiles.verno).toBe(1)
  } finally { await disposeWorkspaceSnapshot(source); await db.delete(); await oldFiles.delete() }
})

it('rejects a changed destination planner copy before publishing inert evidence', async () => {
  const { vi } = await import('vitest')
  const { CryKitDatabase } = await import('./database')
  const { createGuestRepository, guestRepositoryBindings } = await import('../workspace/guest-repository')
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const { readWorkspaceBackup, exportWorkspaceBackup } = await import('../interchange/workspace-backup')
  const { disposeWorkspaceSnapshot } = await import('../workspace/snapshot')
  const { importGuestInheritedEvidence } = await import('../workspace/guest-evidence-import')
  const db = new CryKitDatabase(`guest-evidence-copy-${crypto.randomUUID()}`), repository = createGuestRepository(db)
  const source = await readWorkspaceBackup(exportWorkspaceBackup({ version: 1, snapshotId: 'copy-source', capturedAt: '2026-10-12', revisionVector: {}, state: (await editorClosureFixture()).state }))
  try {
    await repository.readWorkspace()
    const binding = await guestRepositoryBindings(repository), manifest = await binding.coordinator.active.get('active')
    const original = IDBObjectStore.prototype.add
    const fault = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'localDatas' && this.transaction.db.name.startsWith('crykit-profile-')) args[0] = { ...args[0], revision: args[0].revision + 1 }
      return original.apply(this, args)
    })
    try { await expect(importGuestInheritedEvidence(binding, source)).rejects.toThrow(/copied guest/i) } finally { fault.mockRestore() }
    expect(await binding.coordinator.active.get('active')).toEqual(manifest)
  } finally { await disposeWorkspaceSnapshot(source); await db.delete() }
})

it('rolls back a quota fault after legacy validation without committing schema or partial empty rows', async () => {
  const { vi } = await import('vitest')
  const name = `guest-evidence-upgrade-quota-${crypto.randomUUID()}`, legacy = new Dexie(name)
  legacy.version(1).stores({ documents: 'key', blobs: 'key', chunks: '[key+index], key', meta: 'key' })
  const row = { key: 'libraryDefaults', value: { version: 1, layers: [] } }
  await legacy.table('documents').put(row); legacy.close()
  const target = new GuestFilesDatabase(name), original = IDBObjectStore.prototype.add
  const fault = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.transaction.db.name === name && this.name === 'plannerEvidence') throw new DOMException('Synthetic upgrade quota failure', 'QuotaExceededError')
    return original.apply(this, args)
  })
  try {
    try { await expect(target.open()).rejects.toThrow(/quota/i) } finally { fault.mockRestore() }
    const reopened = new Dexie(name)
    try {
      await reopened.open()
      expect(reopened.verno).toBe(1)
      expect(reopened.tables.map(table => table.name).sort()).toEqual(['blobs', 'chunks', 'documents', 'meta'])
      expect(await reopened.table('documents').toArray()).toEqual([row])
    } finally { reopened.close() }
  } finally { await target.delete() }
})
