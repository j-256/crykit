import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPersonalDefinition } from '../domain'
import { CryKitDatabase } from './database'
import { createGuestRepository, guestRepositoryBindings } from '../workspace/guest-repository'
import { openAccountRepository } from '../workspace/account-repository'
import { AccountDatabase } from './account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId } from '../workspace/account-cache'
import { captureWorkspaceSnapshot, disposeWorkspaceSnapshot, snapshotMetadata } from '../workspace/snapshot'
import { exportWorkspaceBackup, readWorkspaceBackup } from '../interchange/workspace-backup'
import { writeDownloadStream } from '../ui/download-stream'
import { readBlob } from '../workspace/blobs'
import { readEditorContent } from '../workspace/editor-document'
import { editorClosureFixture } from '../workspace/test-helpers'

// Same-manifest mutation and legacy Inspector layout checks retain their real native storage subject
vi.mock('../workspace/guest-managed-startup', async importOriginal => {
  const actual = await importOriginal<typeof import('../workspace/guest-managed-startup')>()
  const { openGuestBindings } = await import('../workspace/guest-workspace')
  return { ...actual, prepareGuestStartup: async (original: CryKitDatabase) => ({ kind: 'legacy-recovery', binding: await openGuestBindings(original) }) }
})

async function drain(stream: AsyncIterable<Uint8Array>) { for await (const _ of stream) { /* Consume the final manifest check */ } }
it('sameGuestManifestPlannerChangeRejectsFinalSnapshot', async () => {
  const database = new CryKitDatabase(`backup-guest-${crypto.randomUUID()}`)
  const repository = createGuestRepository(database)
  const loaded = await repository.load()
  const snapshot = await captureWorkspaceSnapshot(repository)
  try {
    const stream = exportWorkspaceBackup(snapshot)[Symbol.asyncIterator]()
    expect((await stream.next()).done).toBe(false)
    await repository.save(createPersonalDefinition(loaded.localData, { kind: 'item', name: 'Concurrent saved change' }), loaded.revision)
    await expect(drain({ [Symbol.asyncIterator]: () => stream })).rejects.toMatchObject({ code: 'SNAPSHOT_CHANGED' })
  } finally { await disposeWorkspaceSnapshot(snapshot); await database.delete() }
})
it('untouchedLegacyEditorRoundTripsWithoutCacheOrUpgradeWrites', async () => {
  const database = new CryKitDatabase(`backup-legacy-${crypto.randomUUID()}`)
  const repository = createGuestRepository(database)
  await repository.load()
  const binding = await guestRepositoryBindings(repository)
  const legacy = new Dexie(binding.manifest.inspector)
  legacy.version(1).stores({ drafts: 'id, updatedAt' })
  const row = { schemaVersion: 1, id: 'legacy', revision: 1, filename: 'untouched.json', referenceId: 'reference', createdAt: '2026-10-12', updatedAt: '2026-10-12', originalText: '{"a":1}', draftText: '\ud800invalid draft' }
  await legacy.table('drafts').add(row)
  const snapshot = await captureWorkspaceSnapshot(repository)
  let restored: Awaited<ReturnType<typeof readWorkspaceBackup>> | undefined
  try {
    restored = await readWorkspaceBackup(exportWorkspaceBackup(snapshot))
    expect(await legacy.table('drafts').get('legacy')).toEqual(row)
    expect(legacy.verno).toBe(1)
    const file = restored.state.editorDocuments[0]
    expect(file).toMatchObject({ id: 'legacy', originalByteIdentity: 'text-only' })
    const blob = restored.state.blobs.find(value => value.ref.documentId === file.unfinished.text.documentId)!
    const bytes = await readBlob(blob.content, file.unfinished.text.byteLength)
    expect(Array.from({ length: bytes.length / 2 }, (_, i) => String.fromCharCode(bytes[i * 2] | bytes[i * 2 + 1] << 8)).join('')).toBe(row.draftText)
  } finally { if (restored) await disposeWorkspaceSnapshot(restored); await disposeWorkspaceSnapshot(snapshot); await legacy.delete(); await database.delete() }
})
describe('captured account backup', () => {
  let token: ReturnType<typeof installProfile>
  let database: AccountDatabase
  let repository: Awaited<ReturnType<typeof openAccountRepository>>
  let snapshot: Awaited<ReturnType<typeof captureWorkspaceSnapshot>>
  let imported: Awaited<ReturnType<typeof readWorkspaceBackup>>
  beforeAll(async () => {
    invalidateProfile()
    token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
    database = new AccountDatabase(token.accountId)
    repository = await openAccountRepository(token)
  })
  afterAll(async () => {
    if (imported) await disposeWorkspaceSnapshot(imported)
    if (snapshot) await disposeWorkspaceSnapshot(snapshot)
    invalidateProfile()
    if (database) await database.delete()
  })
  // These sequential cases share one captured source; cleanup remains unconditional if a phase fails
  it('capturesImmutableCurrentWorkspaceAndExactOriginalContent', async () => {
    const source = await editorClosureFixture()
    const before = await repository.readWorkspace()
    await repository.commitWorkspace({ ...source.state, planner: before.planner, editorDocuments: [source.file] }, before.planner.localData.revision)
    repository = await openAccountRepository(token)
    const current = await repository.readWorkspace()
    snapshot = await captureWorkspaceSnapshot(repository)
    expect(snapshotMetadata(snapshot).state).toEqual({ ...current, blobs: current.blobs.map(({ ref }) => ref) })
    expect(snapshot.state.editorDocuments).toEqual([source.file])
    expect(await readEditorContent(snapshot.state, source.file)).toMatchObject({ originalText: '\ud800', lastAppliedText: '\ud800', unfinishedText: '\ud800' })
    expect(() => { (snapshot.revisionVector as Record<string, string>).committed = 'changed' }).toThrow()
    expect(() => { (snapshot.state.planner.catalogs as unknown[]).pop() }).toThrow()
  })
  it('roundTripsCurrentWorkspaceAndEveryOriginalBodyExactly', async () => {
    expect(snapshot).toBeDefined()
    imported = await readWorkspaceBackup(exportWorkspaceBackup(snapshot))
    // Managed captures preserve the complete portable state and exact bodies rather than native-only source-unit wrappers
    expect(snapshotMetadata(imported)).toEqual(snapshotMetadata(snapshot))
    for (const body of snapshot.state.blobs) {
      const copy = imported.state.blobs.find(value => value.ref.documentId === body.ref.documentId && value.ref.revisionId === body.ref.revisionId)!
      expect(copy.ref).toEqual(body.ref)
      expect(await readBlob(copy.content, copy.ref.byteLength)).toEqual(await readBlob(body.content, body.ref.byteLength))
    }
  })
  it('rejectsNewFenceBeforeExport', async () => {
    expect(snapshot).toBeDefined()
    const loaded = await repository.load()
    await repository.save(createPersonalDefinition(loaded.localData, { kind: 'item', name: 'Changed fence' }), loaded.revision)
    await expect(drain(exportWorkspaceBackup(snapshot))).rejects.toThrow('The captured account workspace changed')
  })
  it('reexportsImportedSnapshotWithoutSourceProfileKeys', async () => {
    expect(imported).toBeDefined()
    invalidateProfile()
    let bytes = 0, closed = false, aborted = false
    await writeDownloadStream(exportWorkspaceBackup(imported), {
      async write(chunk) { bytes += chunk.length },
      async close() { closed = true },
      async abort() { aborted = true },
    }, () => {})
    expect(bytes).toBeGreaterThan(0)
    expect(closed).toBe(true)
    expect(aborted).toBe(false)
  })
})

it('rejectsMissingForeignAndOrphanedOriginalUnitEvidence', async () => {
  const { editorClosureFixture } = await import('../workspace/test-helpers')
  const { prepareAccountWorkspace } = await import('../workspace/account-graph')
  const { captureAccountSnapshot } = await import('../workspace/account-snapshot')
  const { validateWorkspaceSnapshot } = await import('../workspace/snapshot')
  const source = await editorClosureFixture()
  const token = installProfile(accountLocalId(), crypto.getRandomValues(new Uint8Array(32)))
  const database = new AccountDatabase(token.accountId)
  let snapshot: Awaited<ReturnType<typeof captureWorkspaceSnapshot>> | undefined
  try {
    const prepared = await prepareAccountWorkspace(database, token, { ...source.state, editorDocuments: [source.file] })
    await database.encryptedRevisions.bulkAdd(prepared.records)
    snapshot = await captureAccountSnapshot(prepared.opened, { key: 'active', headRevision: 1, head: prepared.head }, async () => {})
    const annex = snapshot.sourceEvidence!
    for (const changed of [
      { ...annex, units: annex.units.slice(1) },
      { ...annex, units: [annex.units[0], ...annex.units] },
      { ...annex, units: annex.units.map((unit, index) => index ? unit : { ...unit, source: { ...unit.source, documentId: 'foreign-original' } }) },
      { ...annex, units: annex.units.map((unit, index) => index ? unit : { ...unit, projectedDigest: '0'.repeat(64) }) },
      { ...annex, blobs: annex.blobs.slice(1) },
      { ...annex, blobs: [annex.blobs[0], ...annex.blobs] },
    ]) await expect(validateWorkspaceSnapshot({ ...snapshot, sourceEvidence: changed })).rejects.toThrow()
    await expect(validateWorkspaceSnapshot({ ...snapshot, state: { ...snapshot.state, blobs: snapshot.state.blobs.slice(1) } })).rejects.toThrow()
  } finally { if (snapshot) await disposeWorkspaceSnapshot(snapshot); invalidateProfile(); await database.delete() }
})
