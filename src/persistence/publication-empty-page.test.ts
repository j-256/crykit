import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import { AccountDatabase } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId, openAccountJson } from '../workspace/account-cache'
import { seedNativePublicationWorkspace } from './native-publication.test-helpers'
import { openAccountWorkspace } from '../workspace/account-graph'
import { preparePublicationAttempt, DirectorySchema, DirectoryPageSchema, stagePublicationDirectory, stagePublicationJson, stagePublicationControl } from '../account/sync/publication'
import { openRemoteProjection } from '../account/sync/projection'
import { DIRECTORY_SHARDS } from '../workspace/directory'
import { z } from 'zod'

let database: AccountDatabase | undefined
afterEach(async () => { vi.restoreAllMocks(); invalidateProfile(); await database?.delete() })
async function fixture() {
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  database = new AccountDatabase(token.accountId)
  await seedNativePublicationWorkspace(database, token)
  const fence = (await database.profileMeta.get('active'))!
  const local = await openAccountWorkspace(database, token, fence.head)
  return { token, local, fence, db: database }
}
it('bulkStagesOneFreshEmptyPageWithDistinctShardEnvelopesAndExactParentsPerPreparation', async () => {
  const { token, local, fence, db } = await fixture()
  const before = new Set((await db.encryptedRevisions.toArray()).map(row => row.revisionId))
  const timings = new Map<string, number>()
  const streams = await import('../workspace/account-streams'), stage = streams.stageAccountSource
  const { readBlob } = await import('../workspace/blobs')
  const measuredStage = vi.spyOn(streams, 'stageAccountSource').mockImplementation(async (...args) => {
    const value = JSON.parse(new TextDecoder().decode(await readBlob(args[2], 1_000_000))) as { kind: string }
    const started = performance.now()
    try { return await stage(...args) } finally { timings.set(value.kind, (timings.get(value.kind) ?? 0) + performance.now() - started) }
  })
  const attempt = await preparePublicationAttempt(db, token, local, null, new Map(), 0)
  measuredStage.mockRestore()
  const heads = new Map(attempt.final.heads.map(ref => [ref.documentId, ref.revisionId]))
  const projection = (await openRemoteProjection(db, token, heads, local.head, 0))!
  const kinds: Record<string, { revisions: number; chunks: number; plainBytes: number; cipherBytes: number; dependencyEdges: number }> = {}
  const rows = (await db.encryptedRevisions.toArray()).filter(row => !before.has(row.revisionId))
  for (const row of rows) {
    const value = await openAccountJson(db, token, { documentId: row.descriptor.documentId, revisionId: row.revisionId }, z.object({ kind: z.string() }).passthrough())
    const cost = kinds[value.kind] ??= { revisions: 0, chunks: 0, plainBytes: 0, cipherBytes: 0, dependencyEdges: 0 }
    cost.revisions++; cost.chunks += row.descriptor.chunks.length; cost.plainBytes += row.descriptor.plainBytes
    cost.cipherBytes += row.descriptor.chunks.reduce((sum, chunk) => sum + chunk.cipherBytes, 0); cost.dependencyEdges += row.descriptor.dependencies.length
  }
  const descriptors = new Map((await db.encryptedRevisions.toArray()).map(row => [row.revisionId, row.descriptor])), closure = new Set<string>()
  const visit = (id: string) => { if (closure.has(id)) return; closure.add(id); for (const ref of descriptors.get(id)!.dependencies) visit(ref.revisionId) }
  for (const head of attempt.final.heads) visit(head.revisionId)
  if (process.env.CRYKIT_SYNC_MEASUREMENTS) appendFileSync(process.env.CRYKIT_SYNC_MEASUREMENTS, `${JSON.stringify({ phase: 'bulk-empty-page-producer', kinds, stagingMs: Object.fromEntries(timings), stagedRevisions: rows.length, closureNodes: closure.size, registrations: attempt.registrations.length })}\n`)
  const indexes = []
  expect(projection.directories.size).toBe(DIRECTORY_SHARDS)
  for (const [shard, directory] of projection.directories) {
    const envelope = await openAccountJson(db, token, directory.ref, DirectorySchema)
    expect(envelope.shard).toBe(shard)
    expect((await db.encryptedRevisions.get(directory.ref.revisionId))!.descriptor.parents).toEqual([])
    indexes.push(envelope.index)
  }
  expect(new Set(indexes.map(ref => JSON.stringify(ref))).size).toBe(1)
  const page = indexes[0], descriptor = (await db.encryptedRevisions.get(page.revisionId))!.descriptor
  expect(await openAccountJson(db, token, page, DirectoryPageSchema)).toEqual({ version: 1, kind: 'publication-directory-page', entries: [], children: [] })
  expect(descriptor.dependencies).toEqual([]); expect(descriptor.parents).toEqual([])
  expect(kinds['publication-directory'].dependencyEdges).toBe(DIRECTORY_SHARDS)
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const { prepareAccountWorkspace } = await import('../workspace/account-graph')
  const { mappedChanges } = await import('../workspace/account-intents')
  const { maxChangedHeads } = await import('../account/protocol')
  const files = await editorClosureFixture()
  const target = await prepareAccountWorkspace(db, token, { ...local.state, blobs: files.blobs.filter(blob => blob.ref.documentId === 'text'), editorDocuments: Array.from({ length: maxChangedHeads + 1 }, (_, index) => ({ ...files.file, id: `new-${index}` as typeof files.file.id })) }, local)
  await db.encryptedRevisions.bulkAdd(target.records)
  const next = await preparePublicationAttempt(db, token, target.opened, projection, heads, 0, mappedChanges(local, target.opened))
  expect(next.bulk).toBe(true)
  const advanced = (await openRemoteProjection(db, token, new Map([...heads, ...next.final.heads.map(ref => [ref.documentId, ref.revisionId] as const)]), local.head, 0))!
  const nextIndexes = []
  for (const [shard, directory] of advanced.directories) {
    expect(directory.ref.documentId).toBe(projection.directories.get(shard)!.ref.documentId)
    expect((await db.encryptedRevisions.get(directory.ref.revisionId))!.descriptor.parents).toEqual([projection.directories.get(shard)!.ref.revisionId])
    nextIndexes.push((await openAccountJson(db, token, directory.ref, DirectorySchema)).index)
  }
  expect(new Set(nextIndexes.map(ref => JSON.stringify(ref))).size).toBe(1)
  expect(nextIndexes[0]).not.toEqual(page)
  expect(await db.profileMeta.get('active')).toEqual(fence)
})
it('keepsPublicNonemptyAndLegacySeparatePagesReadableAndRejectsInvalidSharedInputs', async () => {
  const { token, local, fence, db } = await fixture()
  const attempt = await preparePublicationAttempt(db, token, local, null, new Map(), 0)
  const heads = new Map(attempt.final.heads.map(ref => [ref.documentId, ref.revisionId]))
  const projection = (await openRemoteProjection(db, token, heads, local.head, 0))!
  const indexes = new Set<string>(), legacy = []
  for (const entry of projection.baseline) {
    if (entry.kind !== 'directory') { legacy.push(entry); continue }
    const seed = await stagePublicationDirectory(db, token, projection.lineageId, entry.shard, [], projection.directories.get(entry.shard)!.ref)
    indexes.add(JSON.stringify((await openAccountJson(db, token, seed, DirectorySchema)).index))
    legacy.push({ ...entry, seed })
  }
  expect(indexes.size).toBe(DIRECTORY_SHARDS)
  const legacyControl = await stagePublicationControl(db, token, projection.lineageId, legacy, projection.control)
  expect((await openRemoteProjection(db, token, new Map([...heads, [legacyControl.documentId, legacyControl.revisionId]]), local.head, 0))!.directories.size).toBe(DIRECTORY_SHARDS)
  const shard = projection.directories.get(0)!, allocation = { key: '["editor","separate"]', documentId: accountLocalId() }
  const nonempty = await stagePublicationDirectory(db, token, projection.lineageId, 0, [allocation], shard.ref)
  const independent = await stagePublicationDirectory(db, token, projection.lineageId, 0, [allocation], shard.ref)
  const nonemptyIndex = (await openAccountJson(db, token, nonempty, DirectorySchema)).index
  expect((await openAccountJson(db, token, nonemptyIndex, DirectoryPageSchema)).entries).toEqual([allocation])
  expect((await openAccountJson(db, token, independent, DirectorySchema)).index).not.toEqual(nonemptyIndex)
  const empty = { version: 1, kind: 'publication-directory-page', entries: [], children: [] }
  const absent = { documentId: accountLocalId(), revisionId: accountLocalId() }
  const badPages = [
    await stagePublicationJson(db, token, { ...empty, kind: 'publication-baseline-page' }, []),
    await stagePublicationJson(db, token, { ...empty, entries: [allocation] }, []),
    await stagePublicationJson(db, token, { ...empty, children: [absent] }, []),
    await stagePublicationJson(db, token, empty, [absent]),
  ]
  const canonical = (await openAccountJson(db, token, shard.ref, DirectorySchema)).index
  badPages.push(await stagePublicationJson(db, token, { ...empty, children: [canonical, canonical] }, [canonical]))
  const badRefs = [...badPages.map(row => ({ documentId: row.descriptor.documentId, revisionId: row.revisionId })), { ...canonical, documentId: accountLocalId() }]
  for (const index of badRefs) {
    const envelope = await stagePublicationJson(db, token, { version: 1, kind: 'publication-directory', lineageId: projection.lineageId, shard: 0, index }, [index], shard.ref.documentId, shard.ref)
    await expect(openRemoteProjection(db, token, new Map([...heads, [shard.ref.documentId, envelope.revisionId]]), local.head, 0)).rejects.toThrow()
  }
  const record = (await db.encryptedRevisions.get(canonical.revisionId))!, chunk = (await db.stagedCipherChunks.get([record.payloadId, 0]))!
  await db.stagedCipherChunks.delete([record.payloadId, 0])
  await expect(openRemoteProjection(db, token, heads, local.head, 0)).rejects.toThrow()
  const corrupt = chunk.bytes.slice(); corrupt[0] ^= 1
  await db.stagedCipherChunks.put({ ...chunk, bytes: corrupt })
  await expect(openRemoteProjection(db, token, heads, local.head, 0)).rejects.toThrow()
  await db.stagedCipherChunks.put(chunk)
  await db.encryptedRevisions.put({ ...record, descriptor: { ...record.descriptor, accountId: accountLocalId() } })
  await expect(openRemoteProjection(db, token, heads, local.head, 0)).rejects.toThrow()
  await db.encryptedRevisions.put(record)
  expect((await openRemoteProjection(db, token, heads, local.head, 0))!.directories.size).toBe(DIRECTORY_SHARDS)
  expect(await db.profileMeta.get('active')).toEqual(fence)
})
it.each(['staging', 'profile', 'envelope-profile'] as const)('failedSharedPagePreparationNeverReturnsAuthority %s', async failure => {
  const { token, local, fence, db } = await fixture()
  const streams = await import('../workspace/account-streams'), original = streams.stageAccountSource
  const { readBlob } = await import('../workspace/blobs')
  let pages = 0, envelopes = 0
  vi.spyOn(streams, 'stageAccountSource').mockImplementation(async (...args) => {
    const value = JSON.parse(new TextDecoder().decode(await readBlob(args[2], 1_000_000))) as { kind: string }
    if (value.kind === 'publication-directory-page') {
      pages++
      if (failure === 'staging') throw new Error('Injected empty-page staging failure')
      if (failure === 'profile') invalidateProfile()
    }
    if (value.kind === 'publication-directory') { envelopes++; if (failure === 'envelope-profile' && envelopes === 2) invalidateProfile() }
    return original(...args)
  })
  await expect(preparePublicationAttempt(db, token, local, null, new Map(), 0)).rejects.toThrow()
  expect(pages).toBe(1)
  expect(envelopes).toBe(failure === 'envelope-profile' ? 2 : 0)
  expect(await db.profileMeta.get('active')).toEqual(fence)
  expect(await db.outbox.count()).toBe(0)
})
it('actualWorkerTraversesSharedPageOnceAndChargesEveryRealDirectoryEdge', async () => {
  const { conflictService } = await import('./sync-conflict-fixture')
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const { readRemoteState, readRemoteHeads } = await import('../account/sync/pull')
  const service = await conflictService()
  try {
    const native = await editorClosureFixture()
    const device = await service.device(0, { ...native.state, editorDocuments: [], retainedContent: [], blobs: [] })
    expect((await device.settle()).state).toBe('synced')
    const remote = (await readRemoteState(device.db, device.token))!.value
    const local = await device.native()
    const projection = (await openRemoteProjection(device.db, device.token, await readRemoteHeads(device.db, device.token, remote.heads), local.head, (await (await device.open()).readWorkspace()).planner.localData.revision))!
    const index = (await openAccountJson(device.db, device.token, projection.directories.get(0)!.ref, DirectorySchema)).index
    const command = service.commits.find(value => value.heads.some(head => head.revisionId === projection.control.revisionId))!
    const expected = new Set<string>(), rows = new Map((await device.db.encryptedRevisions.toArray()).map(row => [row.revisionId, row.descriptor]))
    const visit = (id: string) => { if (expected.has(id)) return; expected.add(id); for (const child of rows.get(id)!.dependencies) visit(child.revisionId) }
    visit(projection.control.revisionId)
    const pins = (await service.fixture.db.prepare('SELECT revision_id,done,retained FROM publication_pins WHERE mutation_id = ?').bind(command.mutationId).all()).results
    expect(pins).toHaveLength(expected.size)
    for (const pin of pins) { expect(expected.has(pin.revision_id as string)).toBe(true); expect(pin.done).toBe(1); expect(pin.retained).toBe(1) }
    expect(await service.fixture.db.prepare('SELECT COUNT(*) AS count FROM publication_borrows WHERE mutation_id = ?').bind(command.mutationId).first('count')).toBe(0)
    expect(await service.fixture.db.prepare('SELECT COUNT(*) AS count FROM sync_dependencies WHERE dependency_id = ?').bind(index.revisionId).first('count')).toBe(DIRECTORY_SHARDS)
    expect(await service.fixture.db.prepare('SELECT COUNT(*) AS count FROM sync_revisions WHERE revision_id = ?').bind(index.revisionId).first('count')).toBe(1)
    const shared = await service.fixture.db.prepare('SELECT COUNT(*) AS chunks,SUM(chunks.cipher_bytes) AS cipherBytes FROM sync_revisions r JOIN upload_reservations u USING(account_id,upload_id) JOIN upload_chunks chunks ON chunks.generation = u.generation WHERE r.revision_id = ?').bind(index.revisionId).first()
    expect(shared).toEqual({ chunks: 1, cipherBytes: rows.get(index.revisionId)!.chunks[0].cipherBytes })
    const tables = ['account_sequences', 'upload_reservations', 'storage_generations', 'upload_chunks', 'sync_documents', 'sync_revisions', 'sync_dependencies', 'mutation_receipts', 'head_history', 'scan_leases', 'publication_work', 'publication_pins', 'publication_progress', 'publication_certificates', 'publication_borrows']
    let metadataBytes = 0, metadataRows = 0
    for (const table of tables) {
      const row = (await service.fixture.db.prepare(`SELECT COUNT(*) AS rows,COALESCE(SUM(metadata_bytes),0) AS bytes FROM ${table}`).first())!
      metadataBytes += row.bytes as number; metadataRows += row.rows as number
    }
    const edges = await service.fixture.db.prepare('SELECT (SELECT COUNT(*) FROM sync_dependencies)+(SELECT COUNT(*) FROM publication_borrows) AS total').first<number>('total')
    const charged = await service.fixture.db.prepare('SELECT metadata_bytes,metadata_rows,edges FROM quota_counters WHERE scope = ?').bind(device.token.accountId).first()
    expect(charged).toEqual({ metadata_bytes: metadataBytes, metadata_rows: metadataRows, edges })
    if (process.env.CRYKIT_SYNC_MEASUREMENTS) appendFileSync(process.env.CRYKIT_SYNC_MEASUREMENTS, `${JSON.stringify({ phase: 'actual-worker-shared-page', fullHeadPins: pins.length, shared, charged, commitCalls: service.commits.length })}\n`)
  } finally { await service.dispose() }
})
