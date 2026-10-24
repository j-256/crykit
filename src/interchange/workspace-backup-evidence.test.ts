import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { editorClosureFixture, multiPageMetadataText } from '../workspace/test-helpers'
import * as backup from './workspace-backup'
import { exportWorkspaceBackup, readWorkspaceBackup } from './workspace-backup'
import * as snapshots from '../workspace/snapshot'
import { disposeWorkspaceSnapshot, snapshotMetadata, validateWorkspaceSnapshot, type WorkspaceSnapshot, type WorkspaceSnapshotV1 } from '../workspace/snapshot'
import { memoryBlob, readBlob } from '../workspace/blobs'

async function collect(stream: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = []
  for await (const bytes of stream) parts.push(bytes.slice())
  return Buffer.concat(parts)
}
async function original(order = false): Promise<WorkspaceSnapshotV1> {
  const fixture = await editorClosureFixture()
  const file = { ...fixture.file, unfinished: { ...fixture.file.unfinished, fieldState: order ? { alpha: 'a', zeta: '\ud800' } : { zeta: '\ud800', alpha: 'a' } } }
  return { version: 1, snapshotId: 'synthetic-original', capturedAt: '2026-10-12', revisionVector: { committed: 'original' }, state: { ...fixture.state, editorDocuments: [file] } }
}
const fixturePath = new URL('./workspace-backup-v1.fixtures.json', import.meta.url)
it('batches encrypted writes while staging complete inherited sources', async () => {
  const a = await original(), chunkBytes = 2048
  const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 + 37 }, (_, index) => index % 251)
  const chunkCount = Math.ceil(bytes.length / chunkBytes)
  const { hashBlob } = await import('../workspace/blobs')
  const ref = { documentId: 'borrowed-chunks', revisionId: 'original', byteLength: bytes.length, encoding: 'bytes' as const, sha256: await hashBlob(memoryBlob(bytes)) }
  const content = { byteLength: bytes.length, async *open() {
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      const borrowed = bytes.slice(offset, offset + chunkBytes)
      try { yield borrowed } finally { borrowed.fill(0) }
    }
  } }
  const current = { ...a, state: { ...a.state, blobs: [...a.state.blobs, { ref, content }] } }
  const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction')
  let inherited: WorkspaceSnapshot | undefined
  try {
    inherited = await backup.inheritWorkspaceSnapshot(current, [current])
    const writes = transactions.mock.calls.filter((call, index) => {
      const database = transactions.mock.contexts[index]
      return call[1] === 'readwrite' && database instanceof IDBDatabase && database.name.startsWith('crykit-backup-staging-')
    })
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.length).toBeLessThan(chunkCount / 16)
    const staged = inherited.state.blobs.find(blob => blob.ref.documentId === ref.documentId)!
    expect(Buffer.from(await readBlob(staged.content, bytes.length)).equals(Buffer.from(bytes))).toBe(true)
    const historical = await snapshots.openHistoricalSnapshot(inherited, inherited.version === 2 ? inherited.historicalEvidence.snapshots[0].id : '')
    try { expect(snapshotMetadata(historical)).toEqual(snapshotMetadata(current)) }
    finally { await disposeWorkspaceSnapshot(historical) }
  } finally { if (inherited) await disposeWorkspaceSnapshot(inherited); vi.restoreAllMocks() }
})

it('captures and preserves the accepted guest and account v1 metadata boundary', async () => {
  const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'))
  for (const fixture of fixtures) {
    const restored = await readWorkspaceBackup(memoryBlob(Buffer.from(fixture.archive, 'base64')).open())
    try {
      expect(JSON.stringify(snapshotMetadata(restored))).toBe(JSON.stringify(fixture.metadata))
      expect((await collect(exportWorkspaceBackup(restored))).toString('base64')).toBe(fixture.archive)
      if (Object.hasOwn(Object(restored.state.editorDocuments[0]?.unfinished.fieldState), 'zeta')) expect(Object.keys(restored.state.editorDocuments[0].unfinished.fieldState!)).toEqual(['zeta', 'alpha'])
      if (restored.state.blobs.length) expect(await readBlob(restored.state.blobs[0].content, restored.state.blobs[0].ref.byteLength)).toBeDefined()
      await validateWorkspaceSnapshot(restored)
    } finally { await disposeWorkspaceSnapshot(restored) }
  }
})

it('retains flat A-to-B-to-C history and deduplicates exact re-imports', async () => {
  expect(typeof backup.inheritWorkspaceSnapshot).toBe('function')
  const a = await original()
  const b = { ...a, snapshotId: 'B' }
  const ab = await backup.inheritWorkspaceSnapshot(b, [a])
  const reopened = await readWorkspaceBackup(exportWorkspaceBackup(ab))
  const abc = await backup.inheritWorkspaceSnapshot({ ...a, snapshotId: 'C' }, [reopened, a])
  const repeated = await backup.inheritWorkspaceSnapshot(abc, [a])
  try {
    expect(ab.version).toBe(2)
    expect(abc.historicalEvidence.snapshots).toHaveLength(2)
    expect(repeated.historicalEvidence).toEqual(abc.historicalEvidence)
    for (const entry of abc.historicalEvidence.snapshots) {
      const historical = await snapshots.openHistoricalSnapshot(abc, entry.id)
      try {
        expect(historical.version).toBe(1)
        expect(historical).not.toHaveProperty('historicalEvidence')
        await validateWorkspaceSnapshot(historical)
      } finally { await disposeWorkspaceSnapshot(historical) }
    }
    const encoded = await collect(exportWorkspaceBackup(abc))
    expect(encoded.includes(Buffer.from('"version":"1.1.0"'))).toBe(true)
    expect(encoded.includes(Buffer.from('CRYKIT-WORKSPACE/1\n'), 1)).toBe(false)
  } finally { for (const snapshot of [ab, reopened, abc, repeated]) await disposeWorkspaceSnapshot(snapshot) }
})
it('retains both insertion orders and revokes open historical and blob readers', async () => {
  expect(typeof backup.inheritWorkspaceSnapshot).toBe('function')
  const a = await original()
  const other = { ...a, state: { ...a.state, editorDocuments: [{ ...a.state.editorDocuments[0], unfinished: { ...a.state.editorDocuments[0].unfinished, fieldState: { alpha: 'a', zeta: '\ud800' } } }] } }
  const inherited = await backup.inheritWorkspaceSnapshot(a, [a, other, a])
  const restored = await readWorkspaceBackup(exportWorkspaceBackup(inherited))
  try {
    expect(restored.version).toBe(2)
    if (restored.version !== 2) throw new Error('Missing inherited evidence')
    expect(restored.historicalEvidence.snapshots).toHaveLength(2)
    const orders = []
    for (const { id } of restored.historicalEvidence.snapshots) {
      const historical = await snapshots.openHistoricalSnapshot(restored, id)
      orders.push(Object.keys(historical.state.editorDocuments[0].unfinished.fieldState!))
      await disposeWorkspaceSnapshot(historical)
    }
    expect(orders).toContainEqual(['zeta', 'alpha'])
    expect(orders).toContainEqual(['alpha', 'zeta'])
    const historical = await snapshots.openHistoricalSnapshot(restored, restored.historicalEvidence.snapshots[0].id)
    const iterator = historical.state.blobs[0].content.open()[Symbol.asyncIterator]()
    await iterator.next()
    await disposeWorkspaceSnapshot(restored)
    await expect(iterator.next()).rejects.toThrow()
    await expect(collect(exportWorkspaceBackup(historical))).rejects.toThrow()
    await expect(snapshots.openHistoricalSnapshot(restored, restored.historicalEvidence.snapshots[0].id)).rejects.toThrow()
  } finally { await disposeWorkspaceSnapshot(inherited); await disposeWorkspaceSnapshot(restored) }
})
it('preserves original account source annex through historical storage', async () => {
  expect(typeof backup.inheritWorkspaceSnapshot).toBe('function')
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))[1]
  const account = await readWorkspaceBackup(memoryBlob(Buffer.from(fixture.archive, 'base64')).open())
  const inherited = await backup.inheritWorkspaceSnapshot(await original(), [account])
  const restored = await readWorkspaceBackup(exportWorkspaceBackup(inherited))
  try {
    if (restored.version !== 2) throw new Error('Missing inherited evidence')
    const historical = await snapshots.openHistoricalSnapshot(restored, restored.historicalEvidence.snapshots[0].id)
    try {
      expect(historical.sourceEvidence).toEqual(fixture.metadata.sourceEvidence)
      expect(snapshotMetadata(historical)).toEqual(fixture.metadata)
      expect(Object.keys(historical.state.editorDocuments[0].unfinished.fieldState!)).toEqual(['zeta', 'alpha'])
      await validateWorkspaceSnapshot(historical)
    } finally { await disposeWorkspaceSnapshot(historical) }
  } finally { for (const snapshot of [account, inherited, restored]) await disposeWorkspaceSnapshot(snapshot) }
})

it('keeps a newer child locked after an older child is disposed twice', async () => {
  const inherited = await backup.inheritWorkspaceSnapshot(await original(), [await original()])
  try {
    const id = inherited.historicalEvidence.snapshots[0].id
    const first = await snapshots.openHistoricalSnapshot(inherited, id)
    await disposeWorkspaceSnapshot(first)
    const second = await snapshots.openHistoricalSnapshot(inherited, id)
    await disposeWorkspaceSnapshot(first)
    await expect(snapshots.openHistoricalSnapshot(inherited, id)).rejects.toThrow(/Release/)
    await disposeWorkspaceSnapshot(second)
  } finally { await disposeWorkspaceSnapshot(inherited) }
})
it('rechecks every source at the final inherited capture boundary', async () => {
  const a = await original()
  let changed = false
  const current = snapshots.ownWorkspaceSnapshot(a, { async check() { if (changed) throw new Error('Capture changed') }, async dispose() {} })
  const b = { ...a, snapshotId: 'other', state: { ...a.state, blobs: a.state.blobs.map(blob => ({ ref: blob.ref, content: { byteLength: blob.content.byteLength, async *open() { changed = true; yield* blob.content.open() } } })) } }
  await expect(backup.inheritWorkspaceSnapshot(current, [b])).rejects.toThrow('Capture changed')
})

type WireDocument = { key: string; encoding: 'deflate-json-tokens-v1' | 'bytes'; pages: Uint8Array[] }
async function unpack(snapshot: WorkspaceSnapshot): Promise<WireDocument[]> {
  const bytes = await collect(exportWorkspaceBackup(snapshot))
  const documents: WireDocument[] = []
  let offset = Buffer.byteLength('CRYKIT-WORKSPACE/1\n')
  while (offset < bytes.length) {
    const length = bytes.readUInt32LE(offset)
    const frame = JSON.parse(bytes.subarray(offset + 4, offset + 4 + length).toString())
    const payloadLength = bytes.readUInt32LE(offset + 4 + length)
    const payload = bytes.subarray(offset + 8 + length, offset + 8 + length + payloadLength)
    if (frame.kind === 'content') {
      documents[frame.document] ??= { key: frame.key, encoding: frame.encoding, pages: [] }
      documents[frame.document].pages.push(payload)
    }
    offset += 8 + length + payloadLength
  }
  return documents
}
async function decoded(document: WireDocument) {
  const { BackupJsonReader } = await import('./workspace-backup-json')
  const { decodeBackupPage } = await import('./workspace-backup-compression')
  const reader = new BackupJsonReader()
  for (const page of document.pages) reader.consume(decodeBackupPage(page))
  return reader.finish()
}
async function replaceMetadata(document: WireDocument, value: unknown) {
  const { encodeBackupJson } = await import('./workspace-backup-json')
  const { encodeBackupPage } = await import('./workspace-backup-compression')
  document.pages = [...encodeBackupJson(value)].map(encodeBackupPage)
}
async function reidentifyHistorical(documents: WireDocument[], value: unknown) {
  const { createHash } = await import('node:crypto')
  const { encodeBackupJson } = await import('./workspace-backup-json')
  const digest = createHash('sha256').update('crykit/historical-snapshot/v1\0')
  for (const page of encodeBackupJson(value)) digest.update(page)
  const id = digest.digest('hex')
  documents[1].key = `historical:${id}`
  await replaceMetadata(documents[1], value)
  const current = await decoded(documents[0]) as unknown as import('./workspace-backup-evidence').SnapshotMetadataV2
  current.historicalEvidence.snapshots[0].id = id
  await replaceMetadata(documents[0], current)
}
async function* reframe(documents: WireDocument[], version = '1.1.0', reachedEnd?: () => void) {
  const { createHash } = await import('node:crypto')
  const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
  const word = (value: number) => { const output = Buffer.alloc(4); output.writeUInt32LE(value); return output }
  const magic = Buffer.from('CRYKIT-WORKSPACE/1\n')
  let chain = '0'.repeat(64), count = 0, size = magic.length
  yield magic
  for (const [document, value] of documents.entries()) for (const [index, payload] of value.pages.entries()) {
    const metadata = Buffer.from(JSON.stringify({ kind: 'content', document, key: value.key, encoding: value.encoding, schema: 1, chunk: index, final: index === value.pages.length - 1, length: payload.length, digest: hash(payload) }))
    const framed = Buffer.concat([word(metadata.length), metadata, word(payload.length), payload])
    chain = hash(Buffer.concat([Buffer.from(chain), framed])); count++; size += framed.length
    yield framed
  }
  const current = await decoded(documents[0]) as unknown as { revisionVector: Readonly<Record<string, string>> }
  const vector = hash(Buffer.from(JSON.stringify(Object.entries(current.revisionVector).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))))
  const metadata = Buffer.from(JSON.stringify({ kind: 'manifest', format: 'crykit-workspace-backup', version, frames: count, bytes: size, documents: documents.length, chain, vector }))
  yield Buffer.concat([word(metadata.length), metadata, word(0)])
  reachedEnd?.()
}
it('rejects historical body and annex failures only after complete terminal framing and cleans staging', async () => {
  const { default: Dexie } = await import('dexie')
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))[1]
  const account = await readWorkspaceBackup(memoryBlob(Buffer.from(fixture.archive, 'base64')).open())
  const a = await original()
  const empty = { ...a, state: { ...a.state, editorDocuments: [], retainedContent: [], blobs: [] } }
  const inherited = await backup.inheritWorkspaceSnapshot(empty, [account])
  const before = (await Dexie.getDatabaseNames()).sort()
  try {
    for (const fault of ['body', 'annex', 'closure']) {
      const documents = await unpack(inherited)
      if (fault === 'body') documents[2].pages[0][0] ^= 1
      else {
        const historical = await decoded(documents[1]) as unknown as import('./workspace-backup-evidence').SnapshotMetadataV1
        if (fault === 'annex') historical.sourceEvidence!.units[0].projectedDigest = '0'.repeat(64)
        else {
          const retained = historical.state.retainedContent[0]
          if (retained.kind !== 'pending-content') throw new Error('Wrong fixture')
          const changed = { ...retained, unit: { kind: 'record' as const, privateKey: '["editor","foreign"]' } }
          Object.assign(historical.state, { retainedContent: [changed] })
        }
        await reidentifyHistorical(documents, historical)
      }
      let ended = false
      await expect(readWorkspaceBackup(reframe(documents, '1.1.0', () => { ended = true }))).rejects.toThrow()
      expect(ended).toBe(true)
      expect((await Dexie.getDatabaseNames()).sort()).toEqual(before)
    }
  } finally { await disposeWorkspaceSnapshot(account); await disposeWorkspaceSnapshot(inherited) }
})
it('rejects wrong historical identities and missing duplicate orphaned or reordered documents', async () => {
  const a = await original()
  const inherited = await backup.inheritWorkspaceSnapshot(a, [a])
  try {
    for (const fault of ['id', 'missing', 'duplicate', 'orphan', 'order', 'v1', 'future', 'metadata']) {
      const documents = await unpack(inherited)
      if (fault === 'id') {
        const value = await decoded(documents[1]) as unknown as Record<string, unknown>
        value.snapshotId = 'changed-but-same-claimed-id'
        await replaceMetadata(documents[1], value)
      } else if (fault === 'missing') documents.pop()
      else if (fault === 'duplicate') documents.push(documents.at(-1)!)
      else if (fault === 'order') [documents[1], documents[2]] = [documents[2], documents[1]]
      else if (fault === 'orphan') {
        const current = await decoded(documents[0]) as unknown as import('./workspace-backup-evidence').SnapshotMetadataV2
        current.historicalEvidence.blobs.push({ ...current.historicalEvidence.blobs.at(-1)!, documentId: 'zzz-orphan' })
        documents.push({ ...documents.at(-1)!, key: JSON.stringify(['zzz-orphan', current.historicalEvidence.blobs.at(-1)!.revisionId]) })
        await replaceMetadata(documents[0], current)
      } else if (fault === 'metadata') {
        const current = await decoded(documents[0]) as unknown as Record<string, unknown>
        current.version = 1
        await replaceMetadata(documents[0], current)
      }
      const result = readWorkspaceBackup(reframe(documents, fault === 'v1' ? '1.0.0' : fault === 'future' ? '2.0.0' : '1.1.0'))
      if (fault === 'future') await expect(result).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' })
      else await expect(result).rejects.toThrow()
    }
  } finally { await disposeWorkspaceSnapshot(inherited) }
})
it('keeps strict v1 negatives identical when embedded as historical entries', async () => {
  const a = await original()
  const inherited = await backup.inheritWorkspaceSnapshot(a, [a])
  try {
    for (const fault of ['header', 'container', 'relation', 'native', 'full-ref']) {
      const legacy = await unpack(a)
      const raw = await decoded(legacy[0]) as unknown as import('./workspace-backup-evidence').SnapshotMetadataV1
      if (fault === 'header') Object.assign(raw, { accountKey: 'excluded' })
      else if (fault === 'container') Object.assign(raw.state, { outbox: [] })
      else if (fault === 'relation') Object.assign(raw.state.retainedContent[0], { version: 3 })
      else if (fault === 'native') Object.assign(raw.state.planner.localData, { schemaVersion: '99.0.0' })
      else raw.state.blobs[0] = { ...raw.state.blobs[0], sha256: '0'.repeat(64) }
      await replaceMetadata(legacy[0], raw)
      await expect(readWorkspaceBackup(reframe(legacy, '1.0.0'))).rejects.toThrow()
      const history = await unpack(inherited)
      await reidentifyHistorical(history, raw)
      await expect(readWorkspaceBackup(reframe(history))).rejects.toThrow()
    }
  } finally { await disposeWorkspaceSnapshot(inherited) }
})

it('defaults to exact v1 output without inherited evidence and supports an explicit empty v2 archive', async () => {
  const original = await readWorkspaceBackup(memoryBlob(Buffer.from(JSON.parse(readFileSync(fixturePath, 'utf8'))[0].archive, 'base64')).open())
  const inherited = await backup.inheritWorkspaceSnapshot(original, [])
  try {
    const legacy = await collect(exportWorkspaceBackup(original))
    expect(legacy.toString('base64')).toBe(JSON.parse(readFileSync(fixturePath, 'utf8'))[0].archive)
    expect(await collect(exportWorkspaceBackup(inherited))).toEqual(legacy)
    const explicit = await readWorkspaceBackup(exportWorkspaceBackup(inherited, { version: '1.1.0' }))
    try {
      expect(explicit.version).toBe(2)
      if (explicit.version !== 2) throw new Error('Wrong version')
      expect(explicit.historicalEvidence.snapshots).toEqual([])
    } finally { await disposeWorkspaceSnapshot(explicit) }
  } finally { await disposeWorkspaceSnapshot(original); await disposeWorkspaceSnapshot(inherited) }
})
it('preserves exact historical token streams and binary UTF-16 after releasing all inputs', async () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))[1]
  const original = await readWorkspaceBackup(memoryBlob(Buffer.from(fixture.archive, 'base64')).open())
  const originalDocuments = await unpack(original)
  const inherited = await backup.inheritWorkspaceSnapshot(original, [original])
  await disposeWorkspaceSnapshot(original)
  try {
    const documents = await unpack(inherited)
    expect(documents[1].pages).toEqual(originalDocuments[0].pages)
    const historical = await snapshots.openHistoricalSnapshot(inherited, inherited.historicalEvidence.snapshots[0].id)
    try {
      const file = historical.state.editorDocuments[0]
      expect(file.unfinished.fieldState).toMatchObject({ zeta: '\ud800' })
      const body = historical.state.blobs.find(blob => blob.ref.documentId === file.unfinished.text.documentId)!
      expect(await readBlob(body.content, body.ref.byteLength)).toEqual(new Uint8Array([0, 0xd8]))
    } finally { await disposeWorkspaceSnapshot(historical) }
  } finally { await disposeWorkspaceSnapshot(inherited) }
})
it('measures linear distinct-capture metadata growth with a shared exact binary registry', async () => {
  const { decodeBackupPage } = await import('./workspace-backup-compression')
  const a = await original()
  const measurements = []
  for (const count of [1, 8, 16]) {
    const start = performance.now()
    const sources = Array.from({ length: count }, (_, index) => ({ ...a, snapshotId: `capture-${index.toString().padStart(2, '0')}` }))
    const inherited = await backup.inheritWorkspaceSnapshot(a, sources)
    try {
      const documents = await unpack(inherited)
      const histories = documents.filter(document => document.key.startsWith('historical:'))
      const lengths = histories.map(document => document.pages.reduce((sum, page) => sum + decodeBackupPage(page).length, 0))
      expect(histories).toHaveLength(count)
      expect(documents.filter(document => document.encoding === 'bytes')).toHaveLength(a.state.blobs.length)
      expect(new Set(lengths).size).toBe(1)
      measurements.push({ count, metadataBytes: lengths.reduce((sum, length) => sum + length, 0), largestMetadataPage: Math.max(...histories.flatMap(document => document.pages.map(page => decodeBackupPage(page).length))), physicalBodies: a.state.blobs.length, elapsedMs: Math.round(performance.now() - start) })
    } finally { await disposeWorkspaceSnapshot(inherited) }
  }
  expect(measurements[2].metadataBytes).toBe(measurements[0].metadataBytes * 16)
  if (process.env.CRYKIT_BACKUP_MEASUREMENTS) (await import('node:fs')).writeFileSync(process.env.CRYKIT_BACKUP_MEASUREMENTS, JSON.stringify(measurements, null, 2) + '\n')
})
it('cleans v2 staging after cancellation truncation trailing bytes and iterator cleanup failure', async () => {
  const { default: Dexie } = await import('dexie')
  const a = await original()
  const inherited = await backup.inheritWorkspaceSnapshot(a, [a])
  const before = (await Dexie.getDatabaseNames()).sort()
  try {
    const bytes = await collect(exportWorkspaceBackup(inherited))
    for (const malformed of [bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from([0])])]) {
      await expect(readWorkspaceBackup(memoryBlob(malformed).open())).rejects.toThrow()
      expect((await Dexie.getDatabaseNames()).sort()).toEqual(before)
    }
    const abort = new AbortController()
    async function* cancelled() { yield bytes.subarray(0, 100); abort.abort(); yield bytes.subarray(100) }
    await expect(readWorkspaceBackup(cancelled(), { signal: abort.signal })).rejects.toThrow()
    const iterator = memoryBlob(bytes).open()[Symbol.asyncIterator]()
    const broken = { [Symbol.asyncIterator]() { return { next: () => iterator.next(), async return(): Promise<IteratorResult<Uint8Array>> { await iterator.return?.(); throw new Error('Input cleanup failed') } } } }
    await expect(readWorkspaceBackup(broken)).rejects.toThrow('Input cleanup failed')
    expect((await Dexie.getDatabaseNames()).sort()).toEqual(before)
  } finally { await disposeWorkspaceSnapshot(inherited) }
})

it('reports the two hashes of exactly the stored token bytes and compares arbitrary chunk boundaries', async () => {
  const evidence = await import('./workspace-backup-evidence')
  expect(typeof evidence.historicalMetadataIdentity).toBe('function')
  const { createHash } = await import('node:crypto')
  const bytes = Buffer.from('exact stored bytes\0\xff', 'latin1')
  const identity = await evidence.historicalMetadataIdentity(memoryBlob(bytes))
  expect(identity).toEqual({ id: createHash('sha256').update('crykit/historical-snapshot/v1\0').update(bytes).digest('hex'), metadataStreamDigest: createHash('sha256').update(bytes).digest('hex') })
  const split = { byteLength: bytes.length, async *open() { for (let index = 0; index < bytes.length; index += 3) { const owned = bytes.slice(index, index + 3); yield new Uint8Array(owned) } } }
  expect(await evidence.equalMetadataStreams(memoryBlob(bytes), split)).toBe(true)
  expect(await evidence.equalMetadataStreams(memoryBlob(bytes), memoryBlob(Buffer.from('changed bytes')))).toBe(false)
})
it('retains multi-page historical metadata without truncating long lone-surrogate strings', async () => {
  const a = await original()
  const text = multiPageMetadataText('inert\ud800')
  const source = { ...a, state: { ...a.state, editorDocuments: [{ ...a.state.editorDocuments[0], unfinished: { ...a.state.editorDocuments[0].unfinished, fieldState: { text } } }] } }
  const inherited = await backup.inheritWorkspaceSnapshot(a, [source])
  try {
    const documents = await unpack(inherited)
    expect(documents[1].pages.length).toBeGreaterThan(1)
    const restored = await readWorkspaceBackup(exportWorkspaceBackup(inherited))
    try {
      if (restored.version !== 2) throw new Error('Missing history')
      const child = await snapshots.openHistoricalSnapshot(restored, restored.historicalEvidence.snapshots[0].id)
      try { expect(child.state.editorDocuments[0].unfinished.fieldState).toEqual({ text }) } finally { await disposeWorkspaceSnapshot(child) }
    } finally { await disposeWorkspaceSnapshot(restored) }
  } finally { await disposeWorkspaceSnapshot(inherited) }
})

it('reopens full v1 fixture categories as independently valid historical snapshots', async () => {
  for (const fixture of JSON.parse(readFileSync(fixturePath, 'utf8'))) {
    const original = await readWorkspaceBackup(memoryBlob(Buffer.from(fixture.archive, 'base64')).open())
    const inherited = await backup.inheritWorkspaceSnapshot(original, [original])
    await disposeWorkspaceSnapshot(original)
    try {
      const historical = await snapshots.openHistoricalSnapshot(inherited, inherited.historicalEvidence.snapshots[0].id)
      try {
        expect(JSON.stringify(snapshotMetadata(historical))).toBe(JSON.stringify(fixture.metadata))
        await snapshots.validateWorkspaceSnapshotV1(historical)
      } finally { await disposeWorkspaceSnapshot(historical) }
    } finally { await disposeWorkspaceSnapshot(inherited) }
  }
})
it('rejects contradictory full refs but retains distinct aliases and v1-admitted unreferenced declarations', async () => {
  const { hashBlob } = await import('../workspace/blobs')
  const a = await original()
  const withBody = async (byte: number, documentId = 'extra') => {
    const content = memoryBlob(new Uint8Array([byte]))
    const ref = { documentId, revisionId: 'same-revision', byteLength: 1, sha256: await hashBlob(content), encoding: 'bytes' as const }
    return { ...a, state: { ...a.state, blobs: [...a.state.blobs, { ref, content }] } }
  }
  const first = await withBody(1), second = await withBody(2)
  await validateWorkspaceSnapshot(first); await validateWorkspaceSnapshot(second)
  await expect(backup.inheritWorkspaceSnapshot(first, [second])).rejects.toThrow(/Contradictory shared/)
  const aliases = await backup.inheritWorkspaceSnapshot(first, [await withBody(1, 'other-alias')])
  try { expect(aliases.historicalEvidence.blobs.filter(ref => ref.revisionId === 'same-revision').map(ref => ref.documentId)).toEqual(['extra', 'other-alias']) } finally { await disposeWorkspaceSnapshot(aliases) }
  const forged = { ...a, version: 2, historicalEvidence: { version: 1, snapshots: [], blobs: a.state.blobs.map(blob => blob.ref) } } as WorkspaceSnapshot
  await expect(collect(exportWorkspaceBackup(forged))).rejects.toThrow(/owned/)
})

it('deduplicates empty bodies and ignores empty chunk boundaries during exact comparison', async () => {
  const { equalMetadataStreams } = await import('./workspace-backup-evidence')
  const emptyChunks = { byteLength: 0, async *open() { yield new Uint8Array(); yield new Uint8Array() } }
  const noChunks = { byteLength: 0, async *open() {} }
  expect(await equalMetadataStreams(emptyChunks, noChunks)).toBe(true)
  const a = await original()
  const { hashBlob } = await import('../workspace/blobs')
  const content = memoryBlob(new Uint8Array())
  const source = { ...a, state: { ...a.state, blobs: [...a.state.blobs, { ref: { documentId: 'empty', revisionId: 'empty', byteLength: 0, encoding: 'bytes' as const, sha256: await hashBlob(content) }, content }] } }
  const read = await readWorkspaceBackup(exportWorkspaceBackup(source))
  const inherited = await backup.inheritWorkspaceSnapshot(read, [source, read])
  try { expect(inherited.historicalEvidence.snapshots).toHaveLength(1) } finally { await disposeWorkspaceSnapshot(inherited); await disposeWorkspaceSnapshot(read) }
})
it('awaits input cleanup when cancellation precedes staging initialization', async () => {
  const abort = new AbortController(); abort.abort()
  let cleaned = false
  const source = { [Symbol.asyncIterator]() { return { async next() { return { done: true as const, value: undefined } }, async return() { await Promise.resolve(); cleaned = true; return { done: true as const, value: undefined } } } } }
  await expect(readWorkspaceBackup(source, { signal: abort.signal })).rejects.toThrow()
  expect(cleaned).toBe(true)
})

it('hashes a staged shared large body once per archive pass and again when history reopens', async () => {
  const { createBackupStaging } = await import('../workspace/backup-staging')
  const { finishEvidenceSnapshot } = await import('./workspace-backup-evidence')
  const { decodeBackupPage } = await import('./workspace-backup-compression')
  const { hashBlob } = await import('../workspace/blobs')
  const a = await original(), bodyBytes = 16 * 1024 * 1024
  const content = memoryBlob(new Uint8Array(bodyBytes).fill(71))
  const ref = { documentId: 'large-shared-body', revisionId: 'original', byteLength: bodyBytes, encoding: 'bytes' as const, sha256: await hashBlob(content) }
  const current = { ...a, state: { ...a.state, blobs: [...a.state.blobs, { ref, content }] } }
  const inherited = await backup.inheritWorkspaceSnapshot(current, Array.from({ length: 8 }, (_, index) => ({ ...current, snapshotId: `history-${index}` })))
  const storage = await createBackupStaging()
  let result: WorkspaceSnapshot | undefined, reads = 0, readBytes = 0, largestRead = 0
  try {
    const wire = await unpack(inherited)
    const documents = []
    for (const [ordinal, document] of wire.entries()) {
      let length = 0
      for (const [index, raw] of document.pages.entries()) {
        const bytes = document.encoding === 'bytes' ? new Uint8Array(raw) : decodeBackupPage(raw)
        await storage.write(ordinal, index, bytes); length += bytes.length
      }
      const source = storage.source(ordinal, document.pages.length, length)
      const content = document.key === JSON.stringify(['large-shared-body', 'original']) ? { byteLength: source.byteLength, async *open() { reads++; for await (const bytes of source.open()) { readBytes += bytes.length; largestRead = Math.max(largestRead, bytes.length); yield bytes } } } : source
      documents.push({ key: document.key, encoding: document.encoding, content })
    }
    result = await finishEvidenceSnapshot(documents[0].content, documents.slice(1), storage)
    expect(reads).toBe(1)
    expect(readBytes).toBe(bodyBytes)
    expect(largestRead).toBeLessThanOrEqual(4 * 1024 * 1024)
    if (result.version !== 2) throw new Error('Missing history')
    const child = await snapshots.openHistoricalSnapshot(result, result.historicalEvidence.snapshots[0].id)
    await disposeWorkspaceSnapshot(child)
    expect(reads).toBe(2)
    if (process.env.CRYKIT_BACKUP_HASH_MEASUREMENTS) (await import('node:fs')).writeFileSync(process.env.CRYKIT_BACKUP_HASH_MEASUREMENTS, JSON.stringify({ historicalSnapshots: 8, bodyBytes, archivePassReads: reads - 1, archivePassReadBytes: readBytes - bodyBytes, largestRead, readsAfterIndependentHistoricalReopen: reads }, null, 2) + '\n')
  } finally { if (result) await disposeWorkspaceSnapshot(result); else await storage.dispose(); await disposeWorkspaceSnapshot(inherited) }
})
it('restricts verified-body reuse to exact full refs and sources within one awaited invocation', async () => {
  const closure = await import('../workspace/closure')
  expect(typeof closure.withImmutableWorkspaceBodyValidation).toBe('function')
  const a = await original()
  let escaped: import('../workspace/closure').WorkspaceBodyValidation | undefined
  await closure.withImmutableWorkspaceBodyValidation(a.state.blobs, async context => {
    escaped = context
    await snapshots.validateWorkspaceSnapshotV1(a, context)
    const blob = a.state.blobs[0]
    for (const change of [{ encoding: 'bytes' as const }, { byteLength: blob.ref.byteLength + 1 }, { sha256: '0'.repeat(64) }, { documentId: 'foreign' }, { revisionId: 'foreign' }]) await expect(context.validate({ ...blob, ref: { ...blob.ref, ...change } })).rejects.toThrow(/registry/i)
    const mutable = blob.content as { open: typeof blob.content.open }, originalOpen = mutable.open
    mutable.open = () => originalOpen()
    try { await expect(context.validate(blob)).rejects.toThrow(/source|registry/i) } finally { mutable.open = originalOpen }
    const changedRef = { ...a, state: { ...a.state, blobs: a.state.blobs.map((blob, index) => index ? blob : { ...blob, ref: { ...blob.ref, encoding: 'bytes' as const } }) } }
    await expect(snapshots.validateWorkspaceSnapshotV1(changedRef, context)).rejects.toThrow()
    const changedSource = { ...a, state: { ...a.state, blobs: a.state.blobs.map((blob, index) => index ? blob : { ...blob, content: { byteLength: blob.content.byteLength, open: () => blob.content.open() } }) } }
    await expect(snapshots.validateWorkspaceSnapshotV1(changedSource, context)).rejects.toThrow(/source|registry/i)
    const changedSemantic = { ...a, state: { ...a.state, retainedContent: a.state.retainedContent.map(value => value.kind === 'pending-content' ? { ...value, unit: { kind: 'record' as const, privateKey: '["editor","wrong"]' } } : value) } }
    await expect(snapshots.validateWorkspaceSnapshotV1(changedSemantic, context)).rejects.toThrow(/unit/i)
  })
  await expect(snapshots.validateWorkspaceSnapshotV1(a, escaped)).rejects.toThrow(/released|scope|invocation/i)
})
