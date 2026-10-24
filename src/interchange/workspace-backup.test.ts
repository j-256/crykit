import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { previewCrystalEdit } from './crystal-edit'
import { createPersonalDefinition } from '../domain/local-data'
import { historyEntry } from '../persistence/local-data'
import { editorClosureFixture } from '../workspace/test-helpers'
import { retainEditorRevision } from '../workspace/editor-document'
import { retainFileRevision } from '../workspace/file-history'
import { hashBlob, memoryBlob, readBlob } from '../workspace/blobs'
import { exportWorkspaceBackup, readWorkspaceBackup } from './workspace-backup'
import { disposeWorkspaceSnapshot, type WorkspaceSnapshot } from '../workspace/snapshot'

async function collect(stream: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = []
  for await (const bytes of stream) parts.push(bytes.slice())
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}
async function fixture(): Promise<WorkspaceSnapshot> {
  const fixture = await editorClosureFixture()
  const content = memoryBlob(new TextEncoder().encode('opaqueCredential password accountKey csrf inert file bytes'))
  const ref = { documentId: 'save-bytes', revisionId: 'save-1', byteLength: content.byteLength, sha256: await hashBlob(content), encoding: 'bytes' as const }
  const otherFile = { ...fixture.file, revision: 1, filename: 'other.json' }
  const otherRoot = await fixture.add(otherFile, 'other-root')
  const otherIndex = await fixture.add({ version: 1, kind: 'conflict-closure-page', entries: [{ ...fixture.entries[0], ref: otherRoot }, fixture.entries[1]], children: [] }, 'other-index')
  const other = { version: 1 as const, root: otherRoot, index: otherIndex }
  const snapshot: WorkspaceSnapshot = { version: 1, snapshotId: 'synthetic-snapshot', capturedAt: '2026-10-12T00:00:00.000Z', revisionVector: { committed: 'synthetic-vector' }, state: { ...fixture.state, editorDocuments: [fixture.file], saveDocuments: [{ version: 1, id: 'unsupported-save', revision: 1, filename: 'save.dat', original: ref, working: ref, pendingForm: { invalid: 'unfinished' }, requirements: [], coverage: { status: 'unsupported', diagnostics: ['Unknown codec'] }, createdAt: '2026-10-12', updatedAt: '2026-10-12', exportedRevision: null }], blobs: [...fixture.state.blobs, { ref, content }], assets: [{ version: 1, id: 'art', sourceKey: 'synthetic', relativePath: 'art.png', original: ref, mediaType: 'image/png', width: 1, height: 1 }], conflicts: [{ version: 1, id: 'file-conflict', unit: { kind: 'record', privateKey: fixture.entries[0].key }, commonAncestor: { kind: 'present', closure: fixture.closure }, branches: [{ role: 'local-pending', closure: fixture.closure }, { role: 'accepted-cloud', closure: other }], disposition: { kind: 'resolved', choice: 'other', result: other } }] } }
  const imported = await previewCrystalEdit(new TextEncoder().encode('{"ID":"synthetic-backup-mod","Title":"Synthetic backup mod","EditorVersion":34,"Items":[{"ID":999,"Name":"Synthetic unknown item","FutureField":{"value":"unknown"}}]}'), 'original-mod.json')
  const sources = []
  const sourceBodies = []
  for (const source of imported.proposed.sources) {
    const { bytes, ...metadata } = source
    const content = memoryBlob(bytes)
    const ref = { documentId: `source:${source.id}`, revisionId: source.digest, byteLength: content.byteLength, sha256: source.digest, encoding: 'bytes' as const }
    sources.push({ ...metadata, original: ref }); sourceBodies.push({ ref, content })
  }
  const before = snapshot.state.planner.localData
  const after = createPersonalDefinition(before, { kind: 'item', name: 'Unknown synthetic record' })
  const checkpoint = historyEntry(before, after, 'synthetic-personal-definition', after.updatedAt)
  const planner = { ...snapshot.state.planner, localData: after, catalogs: imported.proposed.catalogs, sources, evidence: imported.proposed.evidence, history: [checkpoint], savedChanges: after.changes, journal: { version: 1 as const, changes: after.changes, checkpoints: [checkpoint], undoable: true } }
  const complete = { ...snapshot, state: { ...snapshot.state, planner, blobs: [...snapshot.state.blobs, ...sourceBodies] } }
  const withEditorHistory = await retainEditorRevision(complete.state, fixture.file, 'protected')
  return { ...snapshot, state: await retainFileRevision(withEditorHistory, snapshot.state.saveDocuments[0], 'autosave-recovery') }
}
it('roundTripsEveryPrivateCategoryAndInvalidDraft', async () => {
  const source = await fixture()
  const restored = await readWorkspaceBackup(exportWorkspaceBackup(source))
  try {
    const metadata = (snapshot: WorkspaceSnapshot) => ({ ...snapshot, state: { ...snapshot.state, blobs: snapshot.state.blobs.map(({ ref }) => ref) } })
    expect(metadata(restored)).toEqual(metadata(source))
    expect(restored.state.editorDocuments[0].unfinished.validation).toBe('invalid')
    expect(restored.state.saveDocuments[0].coverage.status).toBe('unsupported')
    expect(restored.state.retainedContent.map(value => value.kind)).toEqual(['pending-content', 'file-history', 'file-history'])
    expect(restored.state.conflicts[0].branches).toHaveLength(2)
    for (let index = 0; index < source.state.blobs.length; index++) {
      const original = source.state.blobs[index], imported = restored.state.blobs[index]
      expect(await readBlob(imported.content, original.ref.byteLength)).toEqual(await readBlob(original.content, original.ref.byteLength))
      expect(await hashBlob(imported.content)).toBe(original.ref.sha256)
    }
  } finally { await disposeWorkspaceSnapshot(restored) }
  await expect(hashBlob(restored.state.blobs[0].content)).rejects.toThrow()
})
it('rejects a failed encrypted flush and removes its incomplete staging', async () => {
  const source = await fixture()
  const before = new Set((await indexedDB.databases()).map(database => database.name))
  const add = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(() => { throw new DOMException('Synthetic staging flush failure', 'QuotaExceededError') })
  try {
    await expect(readWorkspaceBackup(exportWorkspaceBackup(source))).rejects.toThrow('Synthetic staging flush failure')
    expect((await indexedDB.databases()).filter(database => database.name?.startsWith('crykit-backup-staging-') && !before.has(database.name))).toEqual([])
  } finally { add.mockRestore() }
})
it('rejectsInconsistentCaptureAndAuthMaterial', async () => {
  const source = await fixture()
  await expect(collect(exportWorkspaceBackup({ ...source, accountKey: 'secret' } as unknown as WorkspaceSnapshot))).rejects.toThrow()
  await expect(collect(exportWorkspaceBackup({ ...source, state: { ...source.state, csrf: 'secret' } } as unknown as WorkspaceSnapshot))).rejects.toThrow()
  await expect(collect(exportWorkspaceBackup({ ...source, state: { ...source.state, libraryDefaults: { version: 1, layers: [], csrf: 'secret' } } } as unknown as WorkspaceSnapshot))).rejects.toThrow()
})
it('detectsMissingDuplicateReorderedAndTruncatedFrames', async () => {
  const bytes = await collect(exportWorkspaceBackup(await fixture()))
  for (const length of [0, 5, bytes.length - 1]) await expect(readWorkspaceBackup(memoryBlob(bytes.subarray(0, length)).open())).rejects.toThrow()
  const trailing = new Uint8Array(bytes.length + 1); trailing.set(bytes)
  await expect(readWorkspaceBackup(memoryBlob(trailing).open())).rejects.toThrow()
  const changed = bytes.slice(); changed[Math.floor(changed.length / 2)] ^= 1
  await expect(readWorkspaceBackup(memoryBlob(changed).open())).rejects.toThrow()
})

function frames(bytes: Uint8Array) {
  const result: Uint8Array[] = []
  let offset = new TextEncoder().encode('CRYKIT-WORKSPACE/1\n').length
  while (offset < bytes.length) {
    const metadata = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true)
    const payload = new DataView(bytes.buffer, bytes.byteOffset + offset + 4 + metadata, 4).getUint32(0, true)
    const end = offset + 8 + metadata + payload
    result.push(bytes.slice(offset, end)); offset = end
  }
  return result
}
async function futureBackup(version: string) {
  const bytes = await collect(exportWorkspaceBackup(await fixture()))
  const body = frames(bytes)
  const last = body.at(-1)!
  const metadataLength = new DataView(last.buffer, last.byteOffset, 4).getUint32(0, true)
  const metadata = new TextDecoder().decode(last.subarray(4, 4 + metadataLength))
  const future = new TextEncoder().encode(JSON.stringify({ ...JSON.parse(metadata), version }))
  const manifest = new Uint8Array(8 + future.length)
  new DataView(manifest.buffer).setUint32(0, future.length, true)
  manifest.set(future, 4)
  return { prefix: bytes.subarray(0, bytes.length - last.length), manifest }
}
async function* backupParts(prefix: Uint8Array, manifest: Uint8Array) { yield prefix; yield manifest }
it.each(['2.0.0', '2.0.0-rc.1', '2.0.0+build.7', '2.0.0-rc.1+build.7'])('rejectsNewerCompleteBackupVersionExplicitly: %s', async version => {
  const { prefix, manifest } = await futureBackup(version)
  await expect(readWorkspaceBackup(backupParts(prefix, manifest))).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' })
})
it('rejectsMalformedFutureManifestFramingBeforeVersionDiagnosis', async () => {
  const { prefix, manifest } = await futureBackup('2.0.0')
  const oversized = manifest.slice()
  new DataView(oversized.buffer).setUint32(oversized.length - 4, 4 * 1024 * 1024 + 1, true)
  const nonempty = new Uint8Array(manifest.length + 1)
  nonempty.set(manifest)
  new DataView(nonempty.buffer).setUint32(manifest.length - 4, 1, true)
  const trailing = new Uint8Array(manifest.length + 1)
  trailing.set(manifest)
  await expect(readWorkspaceBackup(backupParts(prefix, manifest.subarray(0, manifest.length - 1)))).rejects.toThrow(/Truncated/)
  await expect(readWorkspaceBackup(backupParts(prefix, oversized))).rejects.toThrow(/Oversized/)
  await expect(readWorkspaceBackup(backupParts(prefix, nonempty))).rejects.toThrow(/Inconsistent/)
  await expect(readWorkspaceBackup(backupParts(prefix, trailing))).rejects.toThrow(/Trailing/)
})
it.each(['02.0.0', '2.0.0-01', '2.0.0+', '2.0.0-', '2.0.0\n', '2.0.0-rc\n'])('keepsMalformedVersionInvalid: %s', async version => {
  const { prefix, manifest } = await futureBackup(version)
  await expect(readWorkspaceBackup(backupParts(prefix, manifest))).rejects.not.toMatchObject({ code: 'UNSUPPORTED_VERSION' })
})
it('rejectsMissingDuplicateReorderedFramesAndOversizedDeclarations', async () => {
  const bytes = await collect(exportWorkspaceBackup(await fixture())), body = frames(bytes)
  const magic = bytes.slice(0, new TextEncoder().encode('CRYKIT-WORKSPACE/1\n').length)
  async function* changed(parts: Uint8Array[]) { yield magic; yield* parts }
  for (const parts of [body.slice(1), [...body.slice(0, 1), body[0], ...body.slice(1)], [body[1], body[0], ...body.slice(2)], body.slice(0, -1)]) await expect(readWorkspaceBackup(changed(parts))).rejects.toThrow()
  const oversized = new Uint8Array(4); new DataView(oversized.buffer).setUint32(0, 65537, true)
  await expect(readWorkspaceBackup(changed([oversized]))).rejects.toThrow(/Oversized/)
})
it('rejectsPrototypeNonfiniteAndDeepMetadataWithoutReadingPrivateBytes', async () => {
  const source = await fixture()
  for (const pendingForm of [JSON.parse('{"__proto__":1}'), { number: Infinity }, Array.from({ length: 66 }).reduce(value => ({ child: value }), {} as object)]) {
    const state = { ...source.state, saveDocuments: [{ ...source.state.saveDocuments[0], pendingForm }] }
    await expect(collect(exportWorkspaceBackup({ ...source, state } as WorkspaceSnapshot))).rejects.toThrow()
  }
})
it('stagesOnlyEncryptedChunksAndDropsCancelledOrDisposedReaders', async () => {
  const { default: Dexie } = await import('dexie')
  const before = new Set(await Dexie.getDatabaseNames())
  const restored = await readWorkspaceBackup(exportWorkspaceBackup(await fixture()))
  const names = (await Dexie.getDatabaseNames()).filter(name => !before.has(name))
  expect(names).toHaveLength(1)
  const database = new Dexie(names[0]); await database.open()
  try {
    const rows = await database.table('chunks').toArray()
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['ciphertext', 'document', 'index', 'nonce'])
      expect(new TextDecoder().decode(row.ciphertext)).not.toContain('opaqueCredential password')
    }
  } finally { database.close(); await disposeWorkspaceSnapshot(restored) }
  expect(await Dexie.exists(names[0])).toBe(false)
  for (const afterChunks of [1, 13]) {
    const abort = new AbortController()
    async function* cancelled() { let chunks = 0; for await (const chunk of exportWorkspaceBackup(await fixture())) { yield chunk; if (++chunks === afterChunks) { abort.abort(); break } } }
    await expect(readWorkspaceBackup(cancelled(), { signal: abort.signal })).rejects.toThrow()
    expect((await Dexie.getDatabaseNames()).filter(name => !before.has(name))).toEqual([])
  }
  const encoded = await collect(exportWorkspaceBackup(await fixture()))
  const brokenCleanup = { [Symbol.asyncIterator]() { let read = false; return { async next() { if (read) return { done: true as const, value: undefined }; read = true; return { done: false as const, value: encoded } }, async return(): Promise<IteratorResult<Uint8Array>> { throw new Error('Synthetic input cleanup failure') } } } }
  await expect(readWorkspaceBackup(brokenCleanup)).rejects.toThrow('Synthetic input cleanup failure')
  expect((await Dexie.getDatabaseNames()).filter(name => !before.has(name))).toEqual([])
})
it('largeSyntheticBackupRoundTripsWithBoundedSourceReads', async () => {
  const source = await fixture(), chunkBytes = 1024 * 1024, size = 160 * chunkBytes
  let largestRead = 0, reads = 0
  const content = { byteLength: size, async *open() { for (let index = 0; index < size / chunkBytes; index++) { const bytes = new Uint8Array(chunkBytes).fill(index); largestRead = Math.max(largestRead, bytes.length); reads++; yield bytes } } }
  const ref = { documentId: 'large-art', revisionId: 'original', byteLength: size, sha256: await hashBlob(content), encoding: 'bytes' as const }
  const snapshot: WorkspaceSnapshot = { ...source, state: { ...source.state, assets: [{ version: 1, id: 'large-art', sourceKey: 'synthetic', relativePath: 'art.png', original: ref, mediaType: 'image/png', width: 1, height: 1 }], blobs: [...source.state.blobs, { ref, content }] } }
  const restored = await readWorkspaceBackup(exportWorkspaceBackup(snapshot))
  try {
    const copied = restored.state.blobs.at(-1)!
    expect(copied.ref).toEqual(ref)
    expect(await hashBlob(copied.content)).toBe(ref.sha256)
    expect(largestRead).toBe(chunkBytes)
    expect(reads).toBe(3 * size / chunkBytes)
  } finally { await disposeWorkspaceSnapshot(restored) }
}, 30_000)

it('rejectsTokenOrderDuplicateKeysAndIncompleteStrings', async () => {
  const { BackupJsonReader } = await import('./workspace-backup-json')
  for (const tokens of [ [['object'], ['key', 'x'], ['value', 1], ['key', 'x'], ['value', 2], ['end']], [['object'], ['key', '__proto__'], ['value', 1], ['end']], [['array'], ['string'], ['end']], [['value', 1], ['value', 2]], [['object'], ['key', 'x'], ['end']] ]) {
    const parser = new BackupJsonReader()
    expect(() => { parser.consume(new TextEncoder().encode(JSON.stringify(tokens))); parser.finish() }).toThrow()
  }
})
