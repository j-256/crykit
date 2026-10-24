import 'fake-indexeddb/auto'
import { createHash } from 'node:crypto'
import { BackupJsonReader, encodeBackupJson } from './workspace-backup-json'
import { decodeBackupPage, encodeBackupPage } from './workspace-backup-compression'
import type { SnapshotMetadataV1, SnapshotMetadataV2 } from './workspace-backup-evidence'
import type { WorkspaceBlobRef } from '../workspace/documents'

import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { inspectWorkspaceClosure } from '../workspace/closure'
import { hashBlob, memoryBlob } from '../workspace/blobs'
import { disposeWorkspaceSnapshot, openHistoricalSnapshot, snapshotMetadata, validateWorkspaceSnapshot } from '../workspace/snapshot'
import { exportWorkspaceBackup, inheritWorkspaceSnapshot, readWorkspaceBackup } from './workspace-backup'

const required = ['mapping-control-baseline', 'personal-lineage', 'conflict-successor', 'build-copy', 'unavailable-source', 'historical-pins']
const fixtures = JSON.parse(readFileSync(new URL('./workspace-backup-v1.fixtures.json', import.meta.url), 'utf8')) as { name?: string; archive: string; metadata: unknown }[]
it('captures the accepted recursive v1 compatibility matrix', () => {
  expect(fixtures.map(fixture => fixture.name).filter(Boolean)).toEqual(expect.arrayContaining(required))
})
it.each(fixtures.filter(fixture => fixture.name))('preserves accepted $name metadata and every body through v1 and inherited reopening', async fixture => {
  const original = await readWorkspaceBackup(memoryBlob(Buffer.from(fixture.archive, 'base64')).open())
  const inherited = await inheritWorkspaceSnapshot(original, [original])
  const restored = await readWorkspaceBackup(exportWorkspaceBackup(inherited))
  try {
    expect(JSON.stringify(snapshotMetadata(original))).toBe(JSON.stringify(fixture.metadata))
    if (restored.version !== 2) throw new Error('Missing inherited evidence')
    const historical = await openHistoricalSnapshot(restored, restored.historicalEvidence.snapshots[0].id)
    try {
      expect(JSON.stringify(snapshotMetadata(historical))).toBe(JSON.stringify(fixture.metadata))
      await validateWorkspaceSnapshot(historical)
      if (fixture.name === 'historical-pins') {
        const alternatives = []
        for (const branch of historical.state.conflicts[0].branches) {
          const inspected = await inspectWorkspaceClosure(historical.state, branch.closure)
          const checkpoint = inspected.documents.get('["build-checkpoint","same-checkpoint"]')!.value as unknown as { content: { rotationNotes: string } }
          alternatives.push(checkpoint.content.rotationNotes)
        }
        expect(alternatives).toEqual(['Pending notes', 'Accepted notes'])
        expect(historical.state.planner.localData.buildRevisions['same-checkpoint'].content.rotationNotes).toBe('Accepted notes')
      }
      for (const blob of historical.state.blobs) expect(await hashBlob(blob.content)).toBe(blob.ref.sha256)
    } finally { await disposeWorkspaceSnapshot(historical) }
  } finally { await disposeWorkspaceSnapshot(restored); await disposeWorkspaceSnapshot(inherited); await disposeWorkspaceSnapshot(original) }
})

type WireDocument = { key: string; encoding: 'bytes' | 'deflate-json-tokens-v1'; pages: Uint8Array[] }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const identity = (ref: Pick<WorkspaceBlobRef, 'documentId' | 'revisionId'>) => JSON.stringify([ref.documentId, ref.revisionId])
async function collect(stream: AsyncIterable<Uint8Array>) { const chunks = []; for await (const bytes of stream) chunks.push(bytes.slice()); return Buffer.concat(chunks) }
function unpack(bytes: Buffer): WireDocument[] {
  const documents: WireDocument[] = []
  let offset = Buffer.byteLength('CRYKIT-WORKSPACE/1\n')
  while (offset < bytes.length) {
    const length = bytes.readUInt32LE(offset), frame = JSON.parse(bytes.subarray(offset + 4, offset + 4 + length).toString())
    const payloadLength = bytes.readUInt32LE(offset + 4 + length)
    if (frame.kind === 'content') {
      documents[frame.document] ??= { key: frame.key, encoding: frame.encoding, pages: [] }
      documents[frame.document].pages.push(new Uint8Array(bytes.subarray(offset + 8 + length, offset + 8 + length + payloadLength)))
    }
    offset += 8 + length + payloadLength
  }
  return documents
}
function metadata(document: WireDocument): unknown { const reader = new BackupJsonReader(); for (const page of document.pages) reader.consume(decodeBackupPage(page)); return reader.finish() }
function replaceMetadata(document: WireDocument, value: unknown) { document.pages = [...encodeBackupJson(value)].map(encodeBackupPage) }
async function* reframe(documents: WireDocument[], version: string, reachedEnd: () => void) {
  const word = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes }
  const magic = Buffer.from('CRYKIT-WORKSPACE/1\n')
  let chain = '0'.repeat(64), frames = 0, size = magic.length
  yield magic
  for (const [document, value] of documents.entries()) for (const [chunk, payload] of value.pages.entries()) {
    const header = Buffer.from(JSON.stringify({ kind: 'content', document, key: value.key, encoding: value.encoding, schema: 1, chunk, final: chunk === value.pages.length - 1, length: payload.length, digest: digest(payload) }))
    const frame = Buffer.concat([word(header.length), header, word(payload.length), payload])
    chain = digest(Buffer.concat([Buffer.from(chain), frame])); frames++; size += frame.length
    yield frame
  }
  const current = metadata(documents[0]) as SnapshotMetadataV1
  const vector = digest(Buffer.from(JSON.stringify(Object.entries(current.revisionVector).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))))
  const header = Buffer.from(JSON.stringify({ kind: 'manifest', format: 'crykit-workspace-backup', version, frames, bytes: size, documents: documents.length, chain, vector }))
  yield Buffer.concat([word(header.length), header, word(0)])
  reachedEnd()
}

// Recompute every containing body and full ref after mutation so framing or hash failure cannot mask semantic rejection
function corruptSemantic(documents: WireDocument[], position: number, name: string) {
  const value = metadata(documents[position]) as SnapshotMetadataV1
  const bodies = new Map(documents.filter(document => document.encoding === 'bytes').map(document => [document.key, document]))
  const refs = new Map(value.state.blobs.map(ref => [identity(ref), ref]))
  const json = new Map<string, Record<string, unknown>>()
  for (const [key, document] of bodies) if (refs.get(key)?.encoding === 'utf8') {
    try { json.set(key, JSON.parse(Buffer.concat(document.pages).toString())) } catch { /* Non-JSON native sources remain exact bytes */ }
  }
  if (name === 'unavailable-source') {
    for (const setup of Object.values(value.state.planner.localData.gameSetups)) delete (setup as { modSourceReceipts?: unknown }).modSourceReceipts
  } else if (name === 'annex') {
    if (!value.sourceEvidence) throw new Error('Missing fixture annex')
    value.sourceEvidence.units[0].projectedDigest = '0'.repeat(64)
  } else if (name === 'historical-pins') {
    const checkpoint = [...json.values()].find(body => body.id === 'same-checkpoint' && body.gameSetupRevisionId)
    if (!checkpoint) throw new Error('Missing historical checkpoint')
    checkpoint.gameSetupRevisionId = 'unavailable-exact-historical-pin'
  } else {
    const kind = name === 'mapping-control-baseline' ? 'directory-mapping' : name
    const body = [...json.values()].find(body => (body.relation as { kind?: string } | undefined)?.kind === kind)
    if (!body) throw new Error(`Missing ${kind} relation`)
    const relation = body.relation as Record<string, unknown>
    if (name === 'mapping-control-baseline') ((relation.publication as { mapping: { context: { control: { digest: string } } } }).mapping.context.control).digest = '0'.repeat(64)
    else if (name === 'personal-lineage') relation.privateKey = '["personal-lineage","foreign"]'
    else if (name === 'conflict-successor') (relation.prior as { digest: string }).digest = '0'.repeat(64)
    else [relation.kept, relation.source] = [relation.source, relation.kept]
  }
  const updated = new Map<string, WorkspaceBlobRef>(), pending = new Set<string>()
  function rewrite(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object') return raw
    if (Array.isArray(raw)) return raw.map(rewrite)
    const record = raw as Record<string, unknown>
    if (typeof record.documentId === 'string' && typeof record.revisionId === 'string' && typeof record.sha256 === 'string' && typeof record.byteLength === 'number' && typeof record.encoding === 'string') {
      const ref = record as unknown as WorkspaceBlobRef
      if (refs.has(identity(ref))) return { ...record, ...update(identity(ref)) }
    }
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, rewrite(child)]))
  }
  function update(key: string): WorkspaceBlobRef {
    const cached = updated.get(key); if (cached) return cached
    if (pending.has(key)) throw new Error('Fixture graph unexpectedly cyclic')
    pending.add(key)
    const ref = refs.get(key)!, document = bodies.get(key)!, parsed = json.get(key)
    if (parsed) document.pages = [new TextEncoder().encode(JSON.stringify(rewrite(parsed)))]
    const bytes = Buffer.concat(document.pages), result = { ...ref, byteLength: bytes.length, sha256: digest(bytes) }
    updated.set(key, result); pending.delete(key); return result
  }
  const rewritten = rewrite(value) as SnapshotMetadataV1
  replaceMetadata(documents[position], rewritten)
  if (position !== 0) {
    const hash = createHash('sha256').update('crykit/historical-snapshot/v1\0')
    for (const page of encodeBackupJson(rewritten)) hash.update(page)
    const id = hash.digest('hex')
    documents[position].key = `historical:${id}`
    const current = metadata(documents[0]) as SnapshotMetadataV2
    current.historicalEvidence.snapshots = [{ id }]
    current.historicalEvidence.blobs = current.historicalEvidence.blobs.map(ref => updated.get(identity(ref)) ?? ref)
    replaceMetadata(documents[0], current)
  }
}
// These messages were captured from the frozen reader for independently rehashed invalid fixtures
const rejected: Readonly<Record<string, string>> = {
  'mapping-control-baseline': 'Mapping control source mismatch',
  'personal-lineage': 'Personal lineage chain/root mismatch',
  'historical-pins': 'Missing or contradictory typed domain pin',
  'conflict-successor': 'Missing or contradictory conflict predecessor',
  'build-copy': 'Build copy differs from native configuration clone',
  'unavailable-source': 'A mod composition references an unavailable catalog revision',
  'annex': 'Current-unit evidence has a foreign projected association'
}
const negativeFixtures = [...fixtures.filter(fixture => fixture.name), { ...fixtures[1], name: 'annex' }]
it.each(negativeFixtures)('retains strict $name rejection after independently rehashing v1 and historical transport', async fixture => {
  let reachedEnd = false
  const old = unpack(Buffer.from(fixture.archive, 'base64'))
  corruptSemantic(old, 0, fixture.name!)
  await expect(readWorkspaceBackup(reframe(old, '1.0.0', () => { reachedEnd = true }))).rejects.toThrow(rejected[fixture.name!])
  expect(reachedEnd).toBe(true)
  const source = await readWorkspaceBackup(memoryBlob(Buffer.from(fixture.archive, 'base64')).open())
  const blank = await readWorkspaceBackup(memoryBlob(Buffer.from(fixtures[0].archive, 'base64')).open())
  const current = { ...blank, state: { ...blank.state, editorDocuments: [], retainedContent: [], blobs: [] } }
  const inherited = await inheritWorkspaceSnapshot(current, [source])
  try {
    const documents = unpack(await collect(exportWorkspaceBackup(inherited)))
    corruptSemantic(documents, 1, fixture.name!)
    reachedEnd = false
    await expect(readWorkspaceBackup(reframe(documents, '1.1.0', () => { reachedEnd = true }))).rejects.toThrow(rejected[fixture.name!])
    expect(reachedEnd).toBe(true)
  } finally { await disposeWorkspaceSnapshot(inherited); await disposeWorkspaceSnapshot(blank); await disposeWorkspaceSnapshot(source) }
})
