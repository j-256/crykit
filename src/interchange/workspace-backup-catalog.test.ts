import 'fake-indexeddb/auto'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { CURRENT_CATALOG, GUIDE_CATALOG } from '../catalog/bundled'
import { createBlankLocalData } from '../domain/local-data'
import { privateRecordKey } from '../workspace/documents'
import { workspaceDocumentSource } from '../workspace/document-codec'
import { hashBlob, readBlob } from '../workspace/blobs'
import { disposeWorkspaceSnapshot, snapshotMetadata } from '../workspace/snapshot'
import { readWorkspaceBackup, exportWorkspaceBackup } from './workspace-backup'
import { encodeBackupJson } from './workspace-backup-json'
import { encodeBackupPage } from './workspace-backup-compression'

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const word = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes }
async function fixture() {
  const catalog = CURRENT_CATALOG, localData = createBlankLocalData()
  const frame = workspaceDocumentSource({ version: 1, kind: 'catalog', key: privateRecordKey('catalog', catalog.id, catalog.revisionId), value: catalog as never })
  const body = { documentId: 'catalog-body', revisionId: 'retained', byteLength: frame.byteLength, sha256: await hashBlob(frame), encoding: 'bytes' as const }
  const reference = { version: 1, kind: 'retained-catalog-reference', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, schemaVersion: catalog.schemaVersion, checksum: catalog.checksum, codec: 'catalog-document-v1', body }
  const raw = { version: 3, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: 'compact', capturedAt: '2026-11-16', revisionVector: {}, catalogBodies: [body], state: { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [reference], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1, layers: [] }, blobs: [] } }
  return { raw, body, frame }
}
type Document = { key: string; encoding: 'bytes' | 'deflate-json-tokens-v1'; pages: Uint8Array[] }
const metadata = (key: string, value: unknown): Document => ({ key, encoding: 'deflate-json-tokens-v1', pages: [...encodeBackupJson(value)].map(encodeBackupPage) })
async function* archive(raw: unknown, documents: Document[]) {
  const all = [metadata('workspace', raw), ...documents], magic = Buffer.from('CRYKIT-WORKSPACE/2\n')
  let chain = '0'.repeat(64), count = 0, size = magic.length
  yield magic
  for (const [document, value] of all.entries()) for (const [chunk, payload] of value.pages.entries()) {
    const header = Buffer.from(JSON.stringify({ kind: 'content', document, key: value.key, encoding: value.encoding, schema: 1, chunk, final: chunk === value.pages.length - 1, length: payload.length, digest: hash(payload) }))
    const framed = Buffer.concat([word(header.length), header, word(payload.length), payload])
    chain = hash(Buffer.concat([Buffer.from(chain), framed])); count++; size += framed.length
    yield framed
  }
  const terminal = Buffer.from(JSON.stringify({ kind: 'manifest', dataGeneration: LAUNCH_DATA_GENERATION, format: 'crykit-workspace-backup', version: '2.2.0', frames: count, bytes: size, documents: all.length, chain, vector: hash(Buffer.from(JSON.stringify(Object.entries((raw as { revisionVector: Record<string, string> }).revisionVector).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))) }))
  yield Buffer.concat([word(terminal.length), terminal, word(0)])
}
const bodyDocument = async (f: Awaited<ReturnType<typeof fixture>>): Promise<Document> => ({ key: `catalog-body:${JSON.stringify([f.body.documentId, f.body.revisionId])}`, encoding: 'bytes', pages: [await readBlob(f.frame, f.frame.byteLength)] })
afterEach(() => { vi.doUnmock('../catalog/bundled'); vi.resetModules() })
it('restores compact catalogs from self-contained retained frames and keeps metadata compact', async () => {
  const f = await fixture(), opened = await readWorkspaceBackup(archive(f.raw, [await bodyDocument(f)]))
  try {
    expect(opened.version).toBe(3)
    expect(opened.state.planner.catalogs[0]).toEqual(CURRENT_CATALOG)
    expect(snapshotMetadata(opened)).toEqual(f.raw)
    const roundTrip = await readWorkspaceBackup(exportWorkspaceBackup(opened))
    try { expect(snapshotMetadata(roundTrip)).toEqual(f.raw) } finally { await disposeWorkspaceSnapshot(roundTrip) }
  } finally { await disposeWorkspaceSnapshot(opened) }
})
it('rejects missing, orphan, and contradictory compact catalog registries', async () => {
  const f = await fixture(), doc = await bodyDocument(f)
  await expect(readWorkspaceBackup(archive(f.raw, []))).rejects.toThrow()
  await expect(readWorkspaceBackup(archive({ ...f.raw, catalogBodies: [] }, [doc]))).rejects.toThrow()
  await expect(readWorkspaceBackup(archive({ ...f.raw, catalogBodies: [f.body, f.body] }, [doc, doc]))).rejects.toThrow()
  await expect(readWorkspaceBackup(archive({ ...f.raw, state: { ...f.raw.state, planner: { ...f.raw.state.planner, catalogs: [] } } }, [doc]))).rejects.toThrow()
})
it('keeps legacy and compact historical metadata flat with distinct exact identities offline', async () => {
  const f = await fixture(), legacy = { ...f.raw, version: 1, state: { ...f.raw.state, planner: { ...f.raw.state.planner, catalogs: [GUIDE_CATALOG] } } } as Record<string, unknown>
  delete legacy.catalogBodies
  const id = (value: unknown, version: number) => { const digest = createHash('sha256').update(`crykit/historical-snapshot/v${version}\0`); for (const page of encodeBackupJson(value)) digest.update(page); return digest.digest('hex') }
  const members = [{ format: 'legacy-v1', id: id(legacy, 1), raw: legacy }, { format: 'compact-v2', id: id(f.raw, 2), raw: f.raw }].sort((a, b) => `${a.format}:${a.id}`.localeCompare(`${b.format}:${b.id}`))
  const raw = { ...f.raw, historicalEvidence: { version: 2, snapshots: members.map(({ format, id }) => ({ format, id })), blobs: [], catalogBodies: [f.body] } }
  const documents = [...members.map(member => metadata(`historical:${member.format}:${member.id}`, member.raw)), await bodyDocument(f)]
  vi.doMock('../catalog/bundled', async () => ({ ...await vi.importActual<typeof import('../catalog/bundled')>('../catalog/bundled'), BUNDLED_CATALOGS: [] }))
  vi.resetModules()
  const reader = await import('./workspace-backup'), snapshots = await import('../workspace/snapshot')
  const opened = await reader.readWorkspaceBackup(archive(raw, documents))
  try {
    expect(opened.state.planner.catalogs[0]).toEqual(CURRENT_CATALOG)
    for (const member of members) {
      const child = await snapshots.openHistoricalSnapshot(opened, member.id)
      try { expect(snapshots.snapshotMetadata(child)).toEqual(member.raw) }
      finally { await snapshots.disposeWorkspaceSnapshot(child) }
    }
  } finally { await snapshots.disposeWorkspaceSnapshot(opened) }
})
it('rejects nested compact historical evidence', async () => {
  const f = await fixture()
  const id = (value: unknown, version: number) => { const digest = createHash('sha256').update(`crykit/historical-snapshot/v${version}\0`); for (const page of encodeBackupJson(value)) digest.update(page); return digest.digest('hex') }
  const raw = { ...f.raw, historicalEvidence: { version: 2, snapshots: [], blobs: [], catalogBodies: [f.body] } }
  const nested = { ...f.raw, historicalEvidence: raw.historicalEvidence }
  const nestedId = id(nested, 2)
  const bad = { ...raw, historicalEvidence: { ...raw.historicalEvidence, snapshots: [{ format: 'compact-v2', id: nestedId }] } }
  await expect(readWorkspaceBackup(archive(bad, [metadata(`historical:compact-v2:${nestedId}`, nested), await bodyDocument(f)]))).rejects.toThrow()
})

it('preserves source-evidence projected associations and original native byte order', async () => {
  const { launchBackupFixtures } = await import('./workspace-backup.test-helpers')
  const { memoryBlob, blobIdentity } = await import('../workspace/blobs')
  const legacy = await readWorkspaceBackup(memoryBlob(Buffer.from((await launchBackupFixtures())[1].archive, 'base64')).open())
  try {
    const original = snapshotMetadata(legacy)
    const raw = { ...original, version: 3, catalogBodies: [], state: { ...original.state, planner: { ...original.state.planner, catalogs: legacy.state.planner.catalogs.map(snapshot => ({ kind: 'inline-catalog', snapshot })) } } }
    const documents: Document[] = []
    for (const body of legacy.state.blobs) documents.push({ key: blobIdentity(body.ref), encoding: 'bytes', pages: [await readBlob(body.content, body.ref.byteLength)] })
    const opened = await readWorkspaceBackup(archive(raw, documents))
    try {
      expect(snapshotMetadata(opened).sourceEvidence).toEqual(original.sourceEvidence)
      expect(snapshotMetadata(opened).state.blobs).toEqual(original.state.blobs)
      for (let index = 0; index < opened.state.blobs.length; index++) expect(await readBlob(opened.state.blobs[index].content, opened.state.blobs[index].ref.byteLength)).toEqual(await readBlob(legacy.state.blobs[index].content, legacy.state.blobs[index].ref.byteLength))
    } finally { await disposeWorkspaceSnapshot(opened) }
  } finally { await disposeWorkspaceSnapshot(legacy) }
})

it('preserves ordered inline imports, explicit unknowns, and retained source catalogs together', async () => {
  const { GUIDE_CATALOG } = await import('../catalog/bundled')
  const { previewCrystalEdit } = await import('./crystal-edit')
  const imported = (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: 'synthetic-compact-inline', EditorVersion: 34, Items: [] })), 'synthetic.json')).proposed.catalogs[0]!
  const f = await fixture()
  const catalogs = [{ kind: 'inline-catalog', snapshot: GUIDE_CATALOG }, f.raw.state.planner.catalogs[0], { kind: 'inline-catalog', snapshot: imported }]
  const raw = { ...f.raw, state: { ...f.raw.state, planner: { ...f.raw.state.planner, catalogs } } }
  const opened = await readWorkspaceBackup(archive(raw, [await bodyDocument(f)]))
  try {
    expect(opened.state.planner.catalogs).toEqual([GUIDE_CATALOG, CURRENT_CATALOG, imported])
    expect(snapshotMetadata(opened).state.planner.catalogs).toEqual(catalogs)
  } finally { await disposeWorkspaceSnapshot(opened) }
})
