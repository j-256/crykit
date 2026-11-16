import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { readGuestEvidence, prepareEmptyGuestEvidence, GUEST_FILES_V1_STORES, GUEST_EVIDENCE_STORES, guestEvidenceSources } from '../workspace/guest-evidence'
import { catalogEvidenceSetDigest } from '../interchange/workspace-backup-catalog'

it('reads explicitly versioned guest catalog evidence roots without changing legacy streams', async () => {
  const rows = (await prepareEmptyGuestEvidence()).map(row => structuredClone(row))
  const root = rows.find(row => row.table === 'evidenceRoots' && (row.row as { value?: { kind?: string } }).value?.kind === 'inherited-snapshot-evidence')!.row as { key: string; value: Record<string, unknown> }
  const members = rows.find(row => row.table === 'evidencePages' && (row.row as { key: string }).key === (root.value.members as { key: string }).key)!.row as { value: Record<string, unknown> }
  members.value.kind = 'evidence-catalog-member-page'
  root.value.version = 2; root.value.setDigest = await catalogEvidenceSetDigest([]); root.value.catalogBodies = { version: 1, key: 'catalogs' }
  rows.push({ table: 'evidencePages', row: { key: 'catalogs', value: { version: 1, kind: 'evidence-catalog-body-page', entries: [], children: [] } } })
  const source = { tables: [...Object.keys(GUEST_FILES_V1_STORES), ...Object.keys(GUEST_EVIDENCE_STORES)], async keys(table: string) { return rows.filter(row => row.table === table).map(row => (row.row as { key: string }).key) }, async get(table: string, key: IDBValidKey) { return rows.find(row => row.table === table && (row.row as { key: string }).key === key)?.row } }
  const opened = await readGuestEvidence(source, async () => {})
  expect(guestEvidenceSources(opened)).toMatchObject({ version: 2, members: [], catalogBodies: [] })
})

it('authenticates a V2 account evidence root and refuses a legacy writer downgrade', async () => {
  const { AccountDatabase } = await import('./account-database')
  const { installProfile, invalidateProfile } = await import('../account/profile')
  const { accountLocalId, stageAccountBytes, cipherRef } = await import('../workspace/account-cache')
  const { openAccountInheritedEvidence, accountInheritedSources, createAccountInheritedEvidencePreparation } = await import('../workspace/account-evidence-snapshots')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    const put = async (value: unknown, dependencies: readonly import('./account-database').CipherRef[] = []) => {
      const record = await stageAccountBytes(database, token, new TextEncoder().encode(JSON.stringify(value)), dependencies)
      await database.encryptedRevisions.put(record)
      return cipherRef(record)
    }
    const page = (kind: string) => put({ version: 1, kind, entries: [], children: [] })
    const members = await page('evidence-catalog-member-page'), blobs = await page('evidence-blob-page'), catalogBodies = await page('evidence-catalog-body-page')
    const root = await put({ version: 2, kind: 'inherited-snapshot-evidence', setDigest: await catalogEvidenceSetDigest([]), members, blobs, catalogBodies }, [members, blobs, catalogBodies])
    const opened = await openAccountInheritedEvidence(database, token, root)
    try {
      expect(opened.origin).toBe('evidence-v2')
      expect(await accountInheritedSources(opened)).toMatchObject({ version: 2, members: [], catalogBodies: [] })
      const preparation = createAccountInheritedEvidencePreparation(database, token)
      try { await expect(preparation.prepare({ base: opened })).rejects.toThrow(/not enabled/) }
      finally { await preparation.abandon() }
    } finally { await opened.dispose() }
  } finally { invalidateProfile(); await database.delete() }
})

it('reads compact guest members with exact catalog subsets through the unchanged local row adapter', async () => {
  const { compactCatalogEvidenceFixture } = await import('../workspace/catalog-evidence.test-helpers')
  const { hashBlob, readBlob, memoryBlob, blobIdentity } = await import('../workspace/blobs')
  const { readBackupMetadata } = await import('../interchange/workspace-backup-evidence')
  const { readLocalEvidence } = await import('../workspace/local-evidence')
  const { prepareLocalIndex } = await import('../workspace/local-index')
  const f = await compactCatalogEvidenceFixture(true), rows = (await prepareEmptyGuestEvidence()).map(row => structuredClone(row))
  const root = rows.find(row => row.table === 'evidenceRoots' && (row.row as { value?: { kind?: string } }).value?.kind === 'inherited-snapshot-evidence')!.row as { key: string; value: Record<string, unknown> }
  const put = (table: string, key: string, value: unknown) => { rows.push({ table, row: { key, value } }); return { version: 1 as const, key } }
  const page = (key: string, kind: string, entries: readonly unknown[]) => put('evidencePages', key, { version: 1, kind, entries, children: [] })
  const catalogKey = `catalog-body:${blobIdentity(f.ref)}`
  rows.push({ table: 'evidenceBlobs', row: { key: catalogKey, ref: f.ref } })
  const nativeKey = blobIdentity(f.ref), nativeBody = { source: f.ref, content: { version: 1, key: nativeKey } }
  rows.push({ table: 'evidenceBlobs', row: { key: nativeKey, ref: f.ref } })
  const nativePage = rows.find(row => row.table === 'evidencePages' && (row.row as { key: string }).key === (root.value.blobs as { key: string }).key)!.row as { value: Record<string, unknown> }
  nativePage.value.entries = [nativeBody]
  const frameBytes = await readBlob(f.content, f.ref.byteLength)
  const variableChunkBytes = 137
  for (const key of [nativeKey, catalogKey]) for (let offset = 0, index = 0; offset < frameBytes.length; offset += variableChunkBytes, index++) rows.push({ table: 'evidenceChunks', row: { key, index, bytes: frameBytes.slice(offset, offset + variableChunkBytes) } })
  const segments: unknown[] = []
  for await (const bytes of f.metadata.open()) {
    const key = `segment-${segments.length}`
    rows.push({ table: 'evidenceSegments', row: { key, bytes } })
    segments.push({ ordinal: segments.length, byteLength: bytes.length, sha256: await hashBlob(memoryBlob(bytes)), content: { version: 1, key } })
  }
  const stream = put('evidenceRoots', 'compact-stream', { version: 2, kind: 'evidence-metadata-stream', codec: 'backup-json-tokens-v2', digest: await hashBlob(f.metadata), byteLength: f.metadata.byteLength, pages: page('compact-segments', 'evidence-metadata-page', segments) })
  const body = { source: f.ref, content: { version: 1, key: catalogKey } }
  const member = { format: 'compact-v2' as const, id: f.id, metadata: stream, blobSubset: page('native-subset', 'evidence-subset-page', [nativeBody]), catalogSubset: page('catalog-subset', 'evidence-catalog-subset-page', [body]) }
  const legacySegments: unknown[] = []
  for await (const bytes of f.legacy.metadata.open()) {
    const key = `legacy-segment-${legacySegments.length}`
    rows.push({ table: 'evidenceSegments', row: { key, bytes } })
    legacySegments.push({ ordinal: legacySegments.length, byteLength: bytes.length, sha256: await hashBlob(memoryBlob(bytes)), content: { version: 1, key } })
  }
  const legacyStream = put('evidenceRoots', 'legacy-stream', { version: 1, kind: 'evidence-metadata-stream', codec: 'backup-json-tokens-v1', digest: await hashBlob(f.legacy.metadata), byteLength: f.legacy.metadata.byteLength, pages: page('legacy-segments', 'evidence-metadata-page', legacySegments) })
  const legacyMember = { format: 'legacy-v1' as const, id: f.legacy.id, metadata: legacyStream, blobSubset: page('legacy-native-subset', 'evidence-subset-page', [nativeBody]), catalogSubset: page('legacy-catalog-subset', 'evidence-catalog-subset-page', []) }
  const membersRow = rows.find(row => row.table === 'evidencePages' && (row.row as { key: string }).key === (root.value.members as { key: string }).key)!.row as { value: Record<string, unknown> }
  membersRow.value.kind = 'evidence-catalog-member-page'; membersRow.value.entries = [member, legacyMember]
  root.value.version = 2; root.value.setDigest = await catalogEvidenceSetDigest([member, legacyMember]); root.value.catalogBodies = page('catalogs', 'evidence-catalog-body-page', [body])
  const stored = new Map<string, import('../workspace/file-types').BlobSource>()
  const adapter = { async stage(_operation: string, source: import('../workspace/file-types').BlobSource) { const ref = { documentId: crypto.randomUUID(), revisionId: crypto.randomUUID() }; stored.set(JSON.stringify(ref), memoryBlob(await readBlob(source, source.byteLength))); return ref }, async read(ref: { documentId: string; revisionId: string }) { return stored.get(JSON.stringify(ref))! } }
  const descriptors = []
  for (const item of rows) {
    const row = item.row as { key: string; index?: number; bytes?: Uint8Array }, binary = item.table === 'evidenceSegments' || item.table === 'evidenceChunks'
    const content = memoryBlob(binary ? row.bytes! : new TextEncoder().encode(JSON.stringify(row)))
    descriptors.push({ table: item.table, key: item.table === 'evidenceChunks' ? [row.key, row.index] : row.key, ref: await adapter.stage('fixture', content), digest: await hashBlob(content), encoding: binary ? 'bytes' : 'json' })
  }
  const index = await prepareLocalIndex(descriptors, value => adapter.stage('fixture', memoryBlob(new TextEncoder().encode(JSON.stringify(value)))))
  const localRoot = await adapter.stage('fixture', memoryBlob(new TextEncoder().encode(JSON.stringify({ version: 1, kind: 'local-inherited-evidence', roots: [{ kind: 'guest-evidence-rows', index: index.root }] }))))
  let live = true
  const opened = await readLocalEvidence(adapter as never, localRoot, async () => { if (!live) throw new Error('revoked') })
  const sources = guestEvidenceSources(opened!)
  expect(await readBackupMetadata(sources.members[0].metadata)).toEqual(f.raw)
  expect(sources.members[1].id).toBe(f.legacy.id)
  expect(await readBlob(sources.members[1].metadata, f.legacy.metadata.byteLength)).toEqual(await readBlob(f.legacy.metadata, f.legacy.metadata.byteLength))
  expect(await hashBlob(sources.catalogBodies![0].content)).toBe(f.ref.sha256)
  expect(await readBlob(sources.bodies[0].content, f.ref.byteLength)).toEqual(frameBytes)
  live = false
  await expect(readBlob(sources.catalogBodies![0].content, f.ref.byteLength)).rejects.toThrow('revoked')
})

it.each(['none', 'cross-role', 'native-alias'] as const)('retains mixed encrypted catalog observations and rejects forbidden physical aliases: %s', async alias => {
  const { compactCatalogEvidenceFixture } = await import('../workspace/catalog-evidence.test-helpers')
  const { AccountDatabase } = await import('./account-database')
  const { installProfile, invalidateProfile } = await import('../account/profile')
  const { accountLocalId, stageAccountBytes, cipherRef } = await import('../workspace/account-cache')
  const { stageAccountSource } = await import('../workspace/account-streams')
  const { hashBlob, memoryBlob, readBlob } = await import('../workspace/blobs')
  const { openAccountInheritedEvidence, accountInheritedSources, accountInheritedEvidenceCheck } = await import('../workspace/account-evidence-snapshots')
  const { readBackupMetadata } = await import('../interchange/workspace-backup-evidence')
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32))), database = new AccountDatabase(token.accountId)
  try {
    const f = await compactCatalogEvidenceFixture(true)
    const put = async (value: unknown, dependencies: readonly import('./account-database').CipherRef[] = []) => {
      const record = await stageAccountBytes(database, token, new TextEncoder().encode(JSON.stringify(value)), dependencies)
      await database.encryptedRevisions.put(record); return cipherRef(record)
    }
    const page = (kind: string, entries: readonly unknown[] = [], dependencies: readonly import('./account-database').CipherRef[] = []) => put({ version: 1, kind, entries, children: [] }, dependencies)
    const bodyRecord = await stageAccountSource(database, token, f.content, [])
    await database.encryptedRevisions.put(bodyRecord)
    const nativeRecord = alias === 'cross-role' ? bodyRecord : await stageAccountSource(database, token, f.content, [])
    if (nativeRecord !== bodyRecord) await database.encryptedRevisions.put(nativeRecord)
    const nativeBody = { source: f.ref, content: cipherRef(nativeRecord) }
    const nativeBodies = alias === 'native-alias' ? [nativeBody, { ...nativeBody, source: { ...f.ref, documentId: 'z-native-alias' } }] : [nativeBody]
    const body = { source: f.ref, content: cipherRef(bodyRecord) }, segments = []
    for await (const bytes of f.metadata.open()) {
      const record = await stageAccountBytes(database, token, bytes, [])
      await database.encryptedRevisions.put(record)
      segments.push({ ordinal: segments.length, byteLength: bytes.length, sha256: await hashBlob(memoryBlob(bytes)), content: cipherRef(record) })
    }
    const pages = await page('evidence-metadata-page', segments, segments.map(segment => segment.content))
    const metadata = await put({ version: 2, kind: 'evidence-metadata-stream', codec: 'backup-json-tokens-v2', digest: await hashBlob(f.metadata), byteLength: f.metadata.byteLength, pages }, [pages])
    const blobSubset = await page('evidence-subset-page', [nativeBody], [nativeBody.content]), catalogSubset = await page('evidence-catalog-subset-page', [body], [body.content])
    const member = { format: 'compact-v2' as const, id: f.id, metadata, blobSubset, catalogSubset }
    const legacySegments = []
    for await (const bytes of f.legacy.metadata.open()) {
      const record = await stageAccountBytes(database, token, bytes, [])
      await database.encryptedRevisions.put(record)
      legacySegments.push({ ordinal: legacySegments.length, byteLength: bytes.length, sha256: await hashBlob(memoryBlob(bytes)), content: cipherRef(record) })
    }
    const legacyPages = await page('evidence-metadata-page', legacySegments, legacySegments.map(segment => segment.content))
    const legacyMetadata = await put({ version: 1, kind: 'evidence-metadata-stream', codec: 'backup-json-tokens-v1', digest: await hashBlob(f.legacy.metadata), byteLength: f.legacy.metadata.byteLength, pages: legacyPages }, [legacyPages])
    const legacyBlobSubset = await page('evidence-subset-page', [nativeBody], [nativeBody.content]), legacyCatalogSubset = await page('evidence-catalog-subset-page')
    const legacyMember = { format: 'legacy-v1' as const, id: f.legacy.id, metadata: legacyMetadata, blobSubset: legacyBlobSubset, catalogSubset: legacyCatalogSubset }
    const members = await page('evidence-catalog-member-page', [member, legacyMember], [metadata, blobSubset, catalogSubset, legacyMetadata, legacyBlobSubset, legacyCatalogSubset]), blobs = await page('evidence-blob-page', nativeBodies, [nativeBody.content]), catalogBodies = await page('evidence-catalog-body-page', [body], [body.content])
    const root = await put({ version: 2, kind: 'inherited-snapshot-evidence', setDigest: await catalogEvidenceSetDigest([member, legacyMember]), members, blobs, catalogBodies }, [members, blobs, catalogBodies])
    if (alias !== 'none') { await expect(openAccountInheritedEvidence(database, token, root)).rejects.toThrow(/aliased/); return }
    const opened = await openAccountInheritedEvidence(database, token, root)
    try {
      const sources = await accountInheritedSources(opened)
      expect(await readBackupMetadata(sources.members[0].metadata)).toEqual(f.raw)
      expect(sources.members[1].id).toBe(f.legacy.id)
      expect(await readBlob(sources.members[1].metadata, f.legacy.metadata.byteLength)).toEqual(await readBlob(f.legacy.metadata, f.legacy.metadata.byteLength))
      expect(await readBlob(sources.bodies[0].content, f.ref.byteLength)).toEqual(await readBlob(f.content, f.ref.byteLength))
      const check = accountInheritedEvidenceCheck(opened, database, token)
      await database.transaction('rw', database.tables, () => check.recheckInTransaction())
      const chunk = await database.stagedCipherChunks.where('payloadId').equals(bodyRecord.payloadId).last()
      expect(chunk).toBeDefined()
      chunk!.bytes[chunk!.bytes.length - 1] ^= 1
      await database.stagedCipherChunks.put(chunk!)
      await expect(database.transaction('rw', database.tables, () => check.recheckInTransaction())).rejects.toThrow(/ciphertext changed/)
      await expect(readBlob(sources.catalogBodies![0].content, f.ref.byteLength)).rejects.toThrow()
    } finally { await opened.dispose() }
  } finally { invalidateProfile(); await database.delete() }
})

it('refuses compact import and implicit projection before changing selected guest data', async () => {
  const { compactCatalogEvidenceFixture } = await import('../workspace/catalog-evidence.test-helpers')
  const { readCompactSnapshot, disposeWorkspaceSnapshot, projectWorkspaceSnapshotV1 } = await import('../workspace/snapshot')
  const { CryKitDatabase } = await import('./database')
  const { createDetachedGuestGraph, detachedGuestBindings } = await import('../workspace/detached-guest.test-helpers')
  const { importGuestInheritedEvidence } = await import('../workspace/guest-evidence-import')
  const { guestParticipants } = await import('../workspace/guest-workspace')
  const f = await compactCatalogEvidenceFixture(), source = await readCompactSnapshot(f.raw, [], [{ ref: f.ref, content: f.content }], { async check() {}, async dispose() {} })
  const database = new CryKitDatabase(`compact-reader-refusal-${crypto.randomUUID()}`), repository = createDetachedGuestGraph(database)
  try {
    const before = await repository.readWorkspace(), binding = await detachedGuestBindings(repository)
    const participants = await guestParticipants(binding)
    const rows = () => Promise.all(participants.map(async participant => ({ kind: participant.kind, tables: await Promise.all(participant.database.tables.map(async table => ({ name: table.name, rows: await table.toArray() }))) })))
    const originalRows = await rows(), pointer = await binding.coordinator.active.get('active'), journal = await binding.coordinator.journal.toArray()
    expect(() => projectWorkspaceSnapshotV1(source)).toThrow(/cannot preserve exact compact catalog provenance.*2.2.0/)
    await expect(importGuestInheritedEvidence(binding, source)).rejects.toThrow(/not enabled/)
    expect(await binding.coordinator.active.get('active')).toEqual(pointer)
    expect(await binding.coordinator.journal.toArray()).toEqual(journal)
    expect(await rows()).toEqual(originalRows)
    expect((await repository.readWorkspace()).planner).toEqual(before.planner)
  } finally { await disposeWorkspaceSnapshot(source); await database.delete() }
})
