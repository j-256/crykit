import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { compactCatalogEvidenceFixture } from './catalog-evidence.test-helpers'
import { ownWorkspaceSnapshot, snapshotMetadata, disposeWorkspaceSnapshot } from './snapshot'
import { captureCompactCatalogSnapshot } from './catalog-capture'
import { capturedBackupEvidence, equalMetadataStreams, inheritWorkspaceSnapshot, historicalEvidenceId } from '../interchange/workspace-backup-evidence'
import { exportWorkspaceBackup, readWorkspaceBackup } from '../interchange/workspace-backup'

async function fixture() {
  const f = await compactCatalogEvidenceFixture()
  return ownWorkspaceSnapshot({ ...f.legacy.raw, state: { ...f.legacy.raw.state, blobs: [] } }, { async check() {}, async dispose() {} })
}
it('leaves production captures unchanged while the writer capability is disabled', async () => {
  const source = await fixture()
  expect(await captureCompactCatalogSnapshot(source)).toBe(source)
})
it('captures exact bundled references and shares one fallback across new inherited captures', async () => {
  vi.stubGlobal('__CRYKIT_COMPACT_CATALOG_QUALIFICATION__', true)
  try {
    const source = await fixture(), compact = await captureCompactCatalogSnapshot(source)
    expect(compact.version).toBe(3)
    expect(compact.state).toEqual(source.state)
    const metadata = snapshotMetadata(compact)
    expect(metadata.state.planner.catalogs[0]).toMatchObject({ kind: 'retained-catalog-reference' })
    expect(JSON.stringify(metadata)).not.toContain('compressed-catalog-snapshot')
    const next = await captureCompactCatalogSnapshot(ownWorkspaceSnapshot({ ...source, snapshotId: 'second-capture' }, { async check() {}, async dispose() {} }))
    const inherited = await inheritWorkspaceSnapshot(next, [source, compact, next])
    expect(inherited.version).toBe(3)
    const evidence = capturedBackupEvidence(inherited)
    expect(evidence.catalogBodies).toHaveLength(1)
    expect(inherited.historicalEvidence.snapshots).toHaveLength(3)
    expect(await equalMetadataStreams(evidence.historical.get(await historicalEvidenceId(capturedBackupEvidence(source).current))!, capturedBackupEvidence(source).current)).toBe(true)
    const restored = await readWorkspaceBackup(exportWorkspaceBackup(inherited))
    expect(restored.state).toEqual(inherited.state)
    expect(capturedBackupEvidence(restored).catalogBodies).toHaveLength(1)
    await expect((async () => { for await (const _bytes of exportWorkspaceBackup(inherited, { version: '2.1.0' })) {} })()).rejects.toThrow(/exact compact.*provenance.*2.2.0/i)
    await disposeWorkspaceSnapshot(restored); await disposeWorkspaceSnapshot(inherited)
  } finally { vi.unstubAllGlobals() }
})

it('writes mixed guest and encrypted account evidence with one retained fallback and exact legacy streams', async () => {
  vi.stubGlobal('__CRYKIT_COMPACT_CATALOG_QUALIFICATION__', true)
  const { guestEvidenceFromSnapshot, writeCapturedGuestEvidence, readGuestEvidence, GUEST_FILES_V1_STORES, GUEST_EVIDENCE_STORES, emptyPlannerEvidence, compareGuestEvidence } = await import('./guest-evidence')
  const { AccountDatabase } = await import('../persistence/account-database')
  const { installProfile, invalidateProfile } = await import('../account/profile')
  const { createAccountInheritedEvidencePreparation, openAccountInheritedEvidence, accountInheritedSources } = await import('./account-evidence-snapshots')
  const token = installProfile((await import('./account-cache')).accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    const source = await fixture(), compact = await captureCompactCatalogSnapshot(source), inherited = await inheritWorkspaceSnapshot(compact, [source, compact])
    const evidence = await guestEvidenceFromSnapshot(inherited, emptyPlannerEvidence())
    const tables = new Map<string, Map<string, unknown>>(Object.keys({ ...GUEST_FILES_V1_STORES, ...GUEST_EVIDENCE_STORES }).map(name => [name, new Map()]))
    const key = (row: { key: string; index?: number }) => row.index === undefined ? row.key : JSON.stringify([row.key, row.index])
    await writeCapturedGuestEvidence(evidence, { async put(table, value) { const row = structuredClone(value) as { key: string; index?: number }; tables.get(table)!.set(key(row), row) } })
    const reopened = await readGuestEvidence({ tables: [...tables.keys()], async get(table, key) { return structuredClone(tables.get(table)!.get(typeof key === 'string' ? key : JSON.stringify(key))) }, async keys(table) { return [...tables.get(table)!.keys()].map(key => table === 'evidenceChunks' ? JSON.parse(key) : key) } }, async () => {})
    await compareGuestEvidence(evidence, reopened)
    const prepared = await createAccountInheritedEvidencePreparation(database, token).prepare({ additions: [inherited] })
    expect(prepared.handle.origin).toBe('evidence-v2')
    await database.encryptedRevisions.bulkAdd([...prepared.records])
    const handle = await openAccountInheritedEvidence(database, token, prepared.root)
    expect((await accountInheritedSources(handle)).catalogBodies).toHaveLength(1)
    const next = await createAccountInheritedEvidencePreparation(database, token).prepare({ base: handle })
    expect(next.root).toEqual(prepared.root)
    expect(next.records).toEqual([])
    const another = await captureCompactCatalogSnapshot(ownWorkspaceSnapshot({ ...source, snapshotId: 'another-current-capture' }, { async check() {}, async dispose() {} }))
    const extension = await inheritWorkspaceSnapshot(another, [another])
    const expanded = await createAccountInheritedEvidencePreparation(database, token).prepare({ base: handle, additions: [extension] })
    const fallbackLength = capturedBackupEvidence(inherited).catalogBodies![0].ref.byteLength
    expect(expanded.records.filter(record => record.descriptor.plainBytes === fallbackLength)).toEqual([])
    expect((await accountInheritedSources(expanded.handle)).members).toHaveLength(3)
    if (process.env.CRYKIT_CATALOG_WRITER_MEASUREMENTS) {
      const { writeFileSync } = await import('node:fs')
      const rows = [...tables.get('evidenceChunks')!.values()] as { key: string; bytes: Uint8Array }[]
      writeFileSync(process.env.CRYKIT_CATALOG_WRITER_MEASUREMENTS, JSON.stringify({ legacyCurrentMetadataBytes: capturedBackupEvidence(source).current.byteLength, compactCurrentMetadataBytes: capturedBackupEvidence(compact).current.byteLength, retainedFallbackFrameBytes: fallbackLength, guestFallbackChunkBytes: rows.filter(row => row.key.startsWith('catalog-body:')).reduce((sum, row) => sum + row.bytes.length, 0), accountInitialEvidenceCipherBytes: prepared.records.reduce((sum, row) => sum + row.descriptor.chunks.reduce((total, chunk) => total + chunk.cipherBytes, 0), 0), accountAddedCaptureCipherBytes: expanded.records.reduce((sum, row) => sum + row.descriptor.chunks.reduce((total, chunk) => total + chunk.cipherBytes, 0), 0), accountAddedFallbackRecords: expanded.records.filter(row => row.descriptor.plainBytes === fallbackLength).length }, null, 2))
    }
    await expanded.dispose(); await disposeWorkspaceSnapshot(extension)
    await next.dispose(); await handle.dispose(); await prepared.dispose(); await disposeWorkspaceSnapshot(inherited)
  } finally { invalidateProfile(); await database.delete(); vi.unstubAllGlobals() }
})

it('migrates a managed account encoding without a personal edit and rejects a stale activation', async () => {
  vi.stubGlobal('__CRYKIT_COMPACT_CATALOG_QUALIFICATION__', true)
  const { AccountDatabase, activateLocalAccountCommit } = await import('../persistence/account-database')
  const { installProfile, invalidateProfile } = await import('../account/profile')
  const { accountLocalId } = await import('./account-cache')
  const { seedManagedWorkspace } = await import('../persistence/managed-sync.test-helpers')
  const { prepareAccountCatalogMigration } = await import('./catalog-migration')
  const { captureManagedAccountSnapshot } = await import('./account-managed-snapshot')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    const original = await fixture()
    const { editorClosureFixture } = await import('./test-helpers')
    const native = await editorClosureFixture()
    await seedManagedWorkspace(database, token, { ...original.state, blobs: native.state.blobs, retainedContent: native.state.retainedContent })
    const expected = (await database.profileMeta.get('active'))!
    const migration = await prepareAccountCatalogMigration(database, token, expected)
    expect(await database.profileMeta.get('active')).toEqual(expected)
    await database.profileMeta.put({ ...expected, headRevision: expected.headRevision + 1 })
    await expect(activateLocalAccountCommit(database, token, migration.prepared)).rejects.toThrow()
    await database.profileMeta.put(expected)
    const target = await activateLocalAccountCommit(database, token, migration.prepared)
    const snapshot = await captureManagedAccountSnapshot(database, token, target)
    expect(snapshot.state.planner.localData).toEqual(original.state.planner.localData)
    expect(snapshot.state.planner.history).toEqual(original.state.planner.history)
    expect(snapshot.version).toBe(3)
    expect(capturedBackupEvidence(snapshot).catalogBodies).toHaveLength(1)
    await disposeWorkspaceSnapshot(snapshot); await migration.dispose()
  } finally { invalidateProfile(); await database.delete(); vi.unstubAllGlobals() }
})

it.each(['quota', 'interrupted', 'stale', 'lost-response'] as const)('keeps guest migration atomic through %s', async fault => {
  vi.stubGlobal('__CRYKIT_COMPACT_CATALOG_QUALIFICATION__', true)
  const { GuestCoordinatorDatabase } = await import('./guest-coordinator')
  const stores = await import('./guest-local-store')
  const { prepareLocalWorkspace, admitLocalRoot } = await import('./local-root')
  const { migrateGuestCatalogs } = await import('./catalog-migration')
  const { invalidateProfile } = await import('../account/profile')
  invalidateProfile()
  const database = new GuestCoordinatorDatabase(`synthetic-catalog-migration-${crypto.randomUUID()}`)
  try {
    const original = await fixture(), store = stores.createGuestLocalStore(database, () => {}), operationId = crypto.randomUUID(), lifetime = { check() {}, async assertCurrent() {} }
    const prepared = await prepareLocalWorkspace(store.adapter, operationId, original.state, lifetime)
    const before = (await store.activate(operationId, prepared.head, undefined, () => {})).target
    const create = stores.createGuestLocalStore
    let activated = 0
    vi.spyOn(stores, 'createGuestLocalStore').mockImplementation((database, check) => {
      const store = create(database, check)
      return { ...store, async flush(id) {
        if (fault === 'quota') throw new DOMException('synthetic quota', 'QuotaExceededError')
        await store.flush(id)
        if (fault === 'interrupted') throw new Error('synthetic interrupted staging')
        if (fault === 'stale') await database.active.put({ key: 'active', manifest: { ...before, revision: before.revision + 1 } } as never)
      }, async activate(...args) {
        const result = await store.activate(...args); activated++
        if (fault === 'lost-response') throw new Error('synthetic lost activation response')
        return result
      } }
    })
    if (fault === 'lost-response') {
      const target = await migrateGuestCatalogs(database, before, () => {})
      expect(activated).toBe(1)
      expect((await database.active.get('active'))!.manifest).toEqual(target)
      const result = await admitLocalRoot(create(database, () => {}).adapter, target.root, lifetime)
      expect(result.state.planner).toEqual(original.state.planner)
    } else {
      await expect(migrateGuestCatalogs(database, before, () => {})).rejects.toThrow()
      expect(activated).toBe(0)
      expect((await database.active.get('active'))!.manifest).toEqual(fault === 'stale' ? { ...before, revision: before.revision + 1 } : before)
      expect((await admitLocalRoot(create(database, () => {}).adapter, before.root, lifetime)).state.planner).toEqual(original.state.planner)
    }
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); await database.delete() }
})

it('retains inline imports and original source bytes in compact archives and planner ZIP exports', async () => {
  vi.stubGlobal('__CRYKIT_COMPACT_CATALOG_QUALIFICATION__', true)
  const { previewCrystalEdit } = await import('../interchange/crystal-edit')
  const { previewImport } = await import('../interchange/import')
  const { exportAccountPlannerSnapshot } = await import('./account-planner-export')
  const { memoryBlob, readBlob } = await import('./blobs')
  try {
    const source = await fixture(), bytes = new TextEncoder().encode('{ "ID": "Synthetic compact original", "EditorVersion": 34, "Items": [{ "ID": 9000, "Name": "Unknown stock" }] }')
    const imported = await previewCrystalEdit(bytes, 'synthetic-original.json'), original = imported.proposed.sources[0]!
    const { bytes: originalBytes, ...metadata } = original
    const ref = { documentId: 'source-original', revisionId: 'source-original-1', byteLength: originalBytes.length, sha256: metadata.digest, encoding: 'bytes' as const }
    const state = { ...source.state, planner: { ...source.state.planner, catalogs: [...imported.proposed.catalogs, ...source.state.planner.catalogs], sources: [{ ...metadata, original: ref }] }, blobs: [{ ref, content: memoryBlob(originalBytes) }] }
    const compact = await captureCompactCatalogSnapshot(ownWorkspaceSnapshot({ ...source, state }, { async check() {}, async dispose() {} }))
    expect(snapshotMetadata(compact).state.planner.catalogs[0]).toMatchObject({ kind: 'inline-catalog' })
    const restored = await readWorkspaceBackup(exportWorkspaceBackup(compact))
    expect(restored.state.planner).toEqual(state.planner)
    expect(await readBlob(restored.state.blobs[0].content, bytes.length)).toEqual(bytes)
    const zip = await exportAccountPlannerSnapshot(restored.state.planner, [{ ...original, bytes: originalBytes.slice() }])
    const preview = await previewImport(zip, 'compact-planner.zip')
    expect(preview.proposed.catalogs).toEqual(state.planner.catalogs)
    expect(preview.proposed.sources[0].bytes).toEqual(bytes)
    expect(preview.proposed.sources[0].catalogs).toEqual(original.catalogs)
    await disposeWorkspaceSnapshot(restored); await disposeWorkspaceSnapshot(compact)
  } finally { vi.unstubAllGlobals() }
})

it.each(['quota', 'interrupted', 'corrupt-readback'] as const)('leaves account selection and originals intact after %s', async fault => {
  vi.stubGlobal('__CRYKIT_COMPACT_CATALOG_QUALIFICATION__', true)
  const { AccountDatabase } = await import('../persistence/account-database')
  const { installProfile, invalidateProfile } = await import('../account/profile')
  const { accountLocalId } = await import('./account-cache')
  const { seedManagedWorkspace } = await import('../persistence/managed-sync.test-helpers')
  const { prepareAccountCatalogMigration } = await import('./catalog-migration')
  const stores = await import('./account-local-store')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    const original = await fixture()
    await seedManagedWorkspace(database, token, original.state)
    const expected = (await database.profileMeta.get('active'))!, previous = new Set(await database.encryptedRevisions.toCollection().primaryKeys())
    const create = stores.createAccountLocalStore
    vi.spyOn(stores, 'createAccountLocalStore').mockImplementation((...args) => {
      const store = create(...args)
      return { ...store, async persistOperation(...args) {
        if (fault === 'quota') throw new DOMException('synthetic quota', 'QuotaExceededError')
        await store.persistOperation(...args)
        if (fault === 'interrupted') throw new Error('synthetic interruption')
        const changed = (await database.encryptedRevisions.toArray()).find(record => !previous.has(record.revisionId))!
        const chunk = (await database.stagedCipherChunks.where('payloadId').equals(changed.payloadId).first())!
        const bytes = chunk.bytes.slice(); bytes[0] ^= 1
        await database.stagedCipherChunks.put({ ...chunk, bytes })
      } }
    })
    await expect(prepareAccountCatalogMigration(database, token, expected)).rejects.toThrow()
    expect(await database.profileMeta.get('active')).toEqual(expected)
    expect(await database.outbox.count()).toBe(0)
    const store = create(database, token), { admitLocalRoot } = await import('./local-root')
    expect((await admitLocalRoot(store.adapter, expected.head, store.lifetime)).state.planner).toEqual(original.state.planner)
    await store.dispose()
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); invalidateProfile(); await database.delete() }
})

it('cancels a blocked compact metadata reader when account preparation is abandoned', async () => {
  vi.stubGlobal('__CRYKIT_COMPACT_CATALOG_QUALIFICATION__', true)
  const { AccountDatabase } = await import('../persistence/account-database')
  const { installProfile, invalidateProfile } = await import('../account/profile')
  const { accountLocalId } = await import('./account-cache')
  const { createAccountInheritedEvidencePreparation } = await import('./account-evidence-snapshots')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    const compact = await captureCompactCatalogSnapshot(await fixture()), inherited = await inheritWorkspaceSnapshot(compact, [compact])
    const evidence = capturedBackupEvidence(inherited), [id, metadata] = [...evidence.historical][0]
    let entered!: () => void, unblock!: (value: IteratorResult<Uint8Array>) => void, cancelled = false
    const opened = new Promise<void>(resolve => { entered = resolve })
    ;(evidence.historical as Map<string, typeof metadata>).set(id, { byteLength: metadata.byteLength, open() { const iterator: AsyncIterableIterator<Uint8Array> = { [Symbol.asyncIterator]() { return iterator }, next() { entered(); return new Promise<IteratorResult<Uint8Array>>(resolve => { unblock = resolve }) }, async return() { cancelled = true; unblock({ done: true, value: undefined }); return { done: true, value: undefined } } }; return iterator } })
    const operation = createAccountInheritedEvidencePreparation(database, token)
    const pending = operation.prepare({ additions: [inherited] })
    const rejected = expect(pending).rejects.toThrow()
    await opened
    await operation.abandon()
    await rejected
    expect(cancelled).toBe(true)
    expect(await database.profileMeta.count()).toBe(0)
    await disposeWorkspaceSnapshot(inherited)
  } finally { vi.unstubAllGlobals(); invalidateProfile(); await database.delete() }
})

it('restores a compact account archive through the public preview and activation callers without a V1 downgrade', async () => {
  vi.stubGlobal('__CRYKIT_COMPACT_CATALOG_QUALIFICATION__', true)
  const { AccountDatabase } = await import('../persistence/account-database')
  const { installProfile, invalidateProfile } = await import('../account/profile')
  const { accountLocalId } = await import('./account-cache')
  const { seedManagedWorkspace, prepareManagedSync } = await import('../persistence/managed-sync.test-helpers')
  const restore = await import('./account-restore')
  const { captureManagedAccountSnapshot } = await import('./account-managed-snapshot')
  const { editorClosureFixture } = await import('./test-helpers')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    const destination = await fixture(), native = await editorClosureFixture()
    await seedManagedWorkspace(database, token, destination.state)
    await prepareManagedSync(database, token)
    const source = await captureCompactCatalogSnapshot(ownWorkspaceSnapshot({ ...destination, snapshotId: 'explicit-compact-restore', state: { ...native.state, planner: { ...native.state.planner, catalogs: destination.state.planner.catalogs } } }, { async check() {}, async dispose() {} }))
    const original = capturedBackupEvidence(source), preview = await restore.previewAccountWorkspaceRestore(database, token, source)
    const stage = await restore.stageAccountWorkspaceRestore(preview)
    try {
      const target = await restore.activateAccountWorkspaceRestore(stage), captured = await captureManagedAccountSnapshot(database, token, target)
      try {
        expect(captured.version).toBe(3)
        const evidence = capturedBackupEvidence(captured)
        expect(evidence.catalogBodies).toHaveLength(1)
        const id = await (await import('../interchange/workspace-backup-catalog')).compactHistoricalIdentity(original.current)
        expect(await equalMetadataStreams(evidence.historical.get(id)!, original.current)).toBe(true)
        for (const body of original.blobs) expect(await equalMetadataStreams(evidence.blobs.find(value => value.ref.sha256 === body.ref.sha256)!.content, body.content)).toBe(true)
      } finally { await disposeWorkspaceSnapshot(captured) }
    } finally { await restore.releaseAccountWorkspaceRestoreStage(stage); restore.releaseAccountWorkspaceRestorePreview(preview); await disposeWorkspaceSnapshot(source) }
  } finally { vi.unstubAllGlobals(); invalidateProfile(); await database.delete() }
})

it('does not encode discarded legacy metadata while capturing compact native bodies', async () => {
  vi.stubGlobal('__CRYKIT_COMPACT_CATALOG_QUALIFICATION__', true)
  const { observeBackupJsonWork } = await import('../interchange/workspace-backup-json')
  const source = await fixture()
  let encodedBytes = 0
  const stop = observeBackupJsonWork((counter, bytes) => { if (counter === 'encodedOutputBytes') encodedBytes += bytes })
  try {
    const compact = await captureCompactCatalogSnapshot(source)
    stop()
    expect(encodedBytes).toBe(capturedBackupEvidence(compact).current.byteLength)
    expect(capturedBackupEvidence(compact).blobs).toEqual(source.state.blobs)
    await disposeWorkspaceSnapshot(compact)
  } finally { stop(); vi.unstubAllGlobals() }
})

it('keeps newly selected merge catalogs compact while preserving exact legacy originals', async () => {
  vi.stubGlobal('__CRYKIT_COMPACT_CATALOG_QUALIFICATION__', true)
  const { AccountDatabase } = await import('../persistence/account-database')
  const { installProfile, invalidateProfile } = await import('../account/profile')
  const { accountLocalId } = await import('./account-cache')
  const { seedManagedWorkspace } = await import('../persistence/managed-sync.test-helpers')
  const { createGuestCopyService } = await import('./guest-copy')
  const { captureManagedAccountSnapshot } = await import('./account-managed-snapshot')
  const { readBackupMetadata } = await import('../interchange/workspace-backup-evidence')
  const { workspace, now } = await import('./signin-merge.test-helpers')
  const { createBlankLocalData } = await import('../domain/local-data')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  const base = await fixture()
  const { createPlaythroughWithSetup } = await import('../domain/game-setups')
  const catalog = base.state.planner.catalogs[0]
  const localData = createPlaythroughWithSetup(base.state.planner.localData, { label: 'Synthetic pinned Progress', catalogLock: { [catalog.id]: catalog.revisionId }, now })
  const legacy = ownWorkspaceSnapshot({ ...base, state: { ...base.state, planner: { ...base.state.planner, localData } } }, { async check() {}, async dispose() {} })
  const exact = capturedBackupEvidence(legacy).current, legacyId = await historicalEvidenceId(exact)
  const source = await inheritWorkspaceSnapshot(await captureCompactCatalogSnapshot(legacy), [legacy])
  const service = createGuestCopyService(async () => source)
  try {
    await seedManagedWorkspace(database, token, workspace(createBlankLocalData({ now })))
    const preview = await service.previewSigninMerge(token)
    await service.commitGuestCopy(token, preview)
    const saved = await captureManagedAccountSnapshot(database, token, (await database.profileMeta.get('active'))!)
    try {
      const evidence = capturedBackupEvidence(saved)
      expect(await equalMetadataStreams(evidence.historical.get(legacyId)!, exact)).toBe(true)
      const members = await Promise.all([...evidence.historical.values()].map(readBackupMetadata)) as { version: number; snapshotId: string; state: { planner: { catalogs: unknown[] } } }[]
      const selection = members.find(member => member.snapshotId.endsWith(':selection'))!
      expect(selection).toBeDefined()
      expect(selection.version).toBe(3)
      expect(selection.state.planner.catalogs).toEqual([expect.objectContaining({ kind: 'retained-catalog-reference' })])
      expect(evidence.catalogBodies).toHaveLength(1)
    } finally { await disposeWorkspaceSnapshot(saved) }
  } finally { await service.dispose(); invalidateProfile(); await database.delete(); vi.unstubAllGlobals() }
})
