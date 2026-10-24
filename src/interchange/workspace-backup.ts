import { encodeBackupPage, decodeBackupPage } from './workspace-backup-compression'
import { BackupFrameSchema, WORKSPACE_BACKUP_MAGIC as MAGIC, WORKSPACE_BACKUP_LIMITS as LIMITS, WORKSPACE_BACKUP_VERSION, WORKSPACE_BACKUP_EVIDENCE_VERSION, BackupManifestV2Schema, WorkspaceBackupError, type BackupFrame, type BackupManifestV2 } from './workspace-backup-schema'
import { BackupJsonReader, encodeBackupJson } from './workspace-backup-json'
import { snapshotMetadata, validateWorkspaceSnapshot, assertWorkspaceSnapshotCurrent, ownWorkspaceSnapshot, disposeWorkspaceSnapshot, projectWorkspaceSnapshotV1, vectorDigest, type WorkspaceSnapshot, type WorkspaceSnapshotV1 } from '../workspace/snapshot'
import { createBackupStaging } from '../workspace/backup-staging'
import { hashBlob, memoryBlob, blobIdentity } from '../workspace/blobs'
import type { WorkspaceState, WorkspaceBlobRef, BlobSource } from '../workspace/documents'
import { capturedBackupEvidence, inheritWorkspaceSnapshot, finishEvidenceSnapshot, readBackupMetadata, registerBackupMetadata, type BackupDocument } from './workspace-backup-evidence'
export { inheritWorkspaceSnapshot } from './workspace-backup-evidence'
import { parseBoundedJson } from './json'

const utf8 = new TextEncoder()
const emptyChain = '0'.repeat(64)
const uint32 = (value: number) => { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return bytes }
function isSemanticVersion(value: string): boolean {
  if (/[^0-9A-Za-z.+-]/.test(value)) return false
  const [release, build, ...extra] = value.split('+')
  const identifier = /^[0-9A-Za-z-]+$/
  if (extra.length || build !== undefined && !build.split('.').every(part => identifier.test(part))) return false
  const separator = release.indexOf('-')
  const core = separator < 0 ? release : release.slice(0, separator)
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(core)) return false
  // Numeric prerelease identifiers forbid leading zeroes; build identifiers do not
  return separator < 0 || release.slice(separator + 1).split('.').every(part => identifier.test(part) && (!/^[0-9]+$/.test(part) || /^(0|[1-9][0-9]*)$/.test(part)))
}
async function hash(bytes: Uint8Array) { return hashBlob(memoryBlob(bytes)) }
async function nextChain(previous: string, metadata: Uint8Array, payload: Uint8Array) {
  const prefix = utf8.encode(previous), metadataLength = uint32(metadata.length), payloadLength = uint32(payload.length)
  return hashBlob({ byteLength: prefix.length + 8 + metadata.length + payload.length, async *open() { yield prefix; yield metadataLength; yield metadata; yield payloadLength; yield payload } })
}
async function* bounded(stream: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
  for await (const bytes of stream) {
    if (!(bytes instanceof Uint8Array)) throw new Error('Invalid backup input chunk')
    for (let offset = 0; offset < bytes.length; offset += LIMITS.payload) yield bytes.subarray(offset, offset + LIMITS.payload)
  }
}
export async function* exportWorkspaceBackup(snapshot: WorkspaceSnapshot, options: { readonly version?: typeof WORKSPACE_BACKUP_EVIDENCE_VERSION } = {}): AsyncIterable<Uint8Array> {
  if (snapshot.version === 1 && options.version === WORKSPACE_BACKUP_EVIDENCE_VERSION) {
    const owned = await inheritWorkspaceSnapshot(snapshot, [])
    try { yield* exportWorkspaceBackup(owned, options) } finally { await disposeWorkspaceSnapshot(owned) }
    return
  }
  const withEvidence = snapshot.version === 2 && (snapshot.historicalEvidence.snapshots.length > 0 || options.version === WORKSPACE_BACKUP_EVIDENCE_VERSION)
  await assertWorkspaceSnapshotCurrent(snapshot)
  await validateWorkspaceSnapshot(snapshot)
  const metadata = snapshotMetadata(withEvidence ? snapshot : projectWorkspaceSnapshotV1(snapshot))
  let chain = emptyChain, frames = 0, bytes = MAGIC.length
  yield MAGIC.slice()
  async function* frame(value: BackupFrame | BackupManifestV2, payload: Uint8Array) {
    const encoded = utf8.encode(JSON.stringify((value.kind === 'manifest' && value.version === WORKSPACE_BACKUP_EVIDENCE_VERSION ? BackupManifestV2Schema : BackupFrameSchema).parse(value)))
    if (encoded.length > LIMITS.metadata || payload.length > LIMITS.payload || frames + 1 > LIMITS.frames || bytes + 8 + encoded.length + payload.length > LIMITS.bytes) throw new Error('Backup resource limit exceeded')
    if (value.kind !== 'manifest') chain = await nextChain(chain, encoded, payload)
    frames++; bytes += 8 + encoded.length + payload.length
    yield uint32(encoded.length); yield encoded; yield uint32(payload.length); yield payload
  }
  let document = 0
  async function* content(key: string, encoding: 'deflate-json-tokens-v1' | 'bytes', source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
    const iterator = bounded(source)[Symbol.asyncIterator]()
    let index = 0
    try {
      let pending = await iterator.next()
      if (pending.done) { yield* frame({ kind: 'content', document, key, encoding, schema: 1, chunk: 0, final: true, length: 0, digest: await hash(new Uint8Array()) }, new Uint8Array()) }
      else while (!pending.done) {
        // Readers may clear yielded plaintext on advance, so retain only this bounded owned copy
        const payload = pending.value.slice(), next = await iterator.next()
        yield* frame({ kind: 'content', document, key, encoding, schema: 1, chunk: index++, final: !!next.done, length: payload.length, digest: await hash(payload) }, payload)
        pending = next
      }
    } finally { await iterator.return?.() }
    document++
  }
  function* metadataPages() { for (const page of encodeBackupJson(metadata)) yield encodeBackupPage(page) }
  yield* content('workspace', 'deflate-json-tokens-v1', metadataPages())
  if (withEvidence && snapshot.version === 2) {
    const evidence = capturedBackupEvidence(snapshot)
    for (const { id } of snapshot.historicalEvidence.snapshots) {
      const source = evidence.historical.get(id)
      if (!source) throw new Error('Missing captured historical metadata')
      async function* pages() { for await (const page of source!.open()) yield encodeBackupPage(page) }
      yield* content(`historical:${id}`, 'deflate-json-tokens-v1', pages())
    }
    for (const blob of evidence.blobs) yield* content(blobIdentity(blob.ref), 'bytes', blob.content.open())
  } else for (const blob of snapshot.state.blobs) yield* content(blobIdentity(blob.ref), 'bytes', blob.content.open())
  // A failed final capture leaves no valid terminal manifest, even if the sink already received partial bytes
  await assertWorkspaceSnapshotCurrent(snapshot)
  yield* frame({ kind: 'manifest', format: 'crykit-workspace-backup', version: withEvidence ? WORKSPACE_BACKUP_EVIDENCE_VERSION : WORKSPACE_BACKUP_VERSION, frames, bytes, documents: document, chain, vector: await vectorDigest(snapshot.revisionVector) }, new Uint8Array())
}
export async function readWorkspaceBackup(stream: AsyncIterable<Uint8Array>, options: { readonly signal?: AbortSignal } = {}): Promise<WorkspaceSnapshot> {
  const iterator = stream[Symbol.asyncIterator]()
  const staging = await createBackupStaging(options.signal).catch(async error => { await iterator.return?.(); throw error })
  const writer = staging.bufferedWriter()
  let returned = false
  let chunk: Uint8Array = new Uint8Array(), offset = 0, received = 0, consumed = 0
  const next = async () => {
    options.signal?.throwIfAborted()
    const result = await iterator.next()
    if (result.done) return false
    if (!(result.value instanceof Uint8Array)) throw new Error('Invalid backup input')
    chunk = result.value; offset = 0; received += chunk.length
    if (received > LIMITS.bytes) throw new Error('Backup input exceeds resource limit')
    return true
  }
  const exact = async (length: number) => {
    const output = new Uint8Array(length)
    let at = 0
    while (at < length) {
      if (offset === chunk.length && !await next()) throw new Error('Truncated backup frame')
      const count = Math.min(length - at, chunk.length - offset)
      output.set(chunk.subarray(offset, offset + count), at); at += count; offset += count; consumed += count
    }
    return output
  }
  const length = async () => new DataView((await exact(4)).buffer).getUint32(0, true)
  const terminalEnd = async () => {
    if (offset !== chunk.length) throw new Error('Trailing backup bytes')
    while (await next()) if (chunk.length) throw new Error('Trailing backup bytes')
  }
  try {
    if ((await exact(MAGIC.length)).some((byte, index) => byte !== MAGIC[index])) throw new Error('Unsupported workspace backup')
    let json = new BackupJsonReader()
    const documents: BackupDocument[] = []
    let current: BlobSource | undefined, route: unknown, encoding: BackupDocument['encoding'] | undefined
    let chain = emptyChain, frames = 0, document = 0, index = 0, documentBytes = 0, documentKey: string | undefined, portable: unknown
    for (;;) {
      const before = consumed, metadataLength = await length()
      if (metadataLength > LIMITS.metadata) throw new Error('Oversized backup frame metadata')
      const metadata = await exact(metadataLength)
      const rawFrame = parseBoundedJson(metadata, 'backup frame')
      const payloadLength = await length()
      if (payloadLength > LIMITS.payload || ++frames > LIMITS.frames) throw new Error('Oversized backup frame')
      const payload = await exact(payloadLength)
      // Future metadata cannot bypass complete bounded framing or grant import authority
      if (rawFrame && typeof rawFrame === 'object' && 'kind' in rawFrame && rawFrame.kind === 'manifest'
        && 'format' in rawFrame && rawFrame.format === 'crykit-workspace-backup'
        && 'version' in rawFrame && typeof rawFrame.version === 'string'
        && isSemanticVersion(rawFrame.version) && rawFrame.version !== WORKSPACE_BACKUP_VERSION && rawFrame.version !== WORKSPACE_BACKUP_EVIDENCE_VERSION) {
        if (index || payloadLength || !current || route !== 2 && !portable) throw new Error('Inconsistent backup manifest')
        await terminalEnd()
        throw new WorkspaceBackupError('UNSUPPORTED_VERSION', 'This complete backup uses an unsupported version. Open it with a compatible CryKit version.')
      }
      const value = rawFrame && typeof rawFrame === 'object' && 'kind' in rawFrame && rawFrame.kind === 'manifest' && 'version' in rawFrame && rawFrame.version === WORKSPACE_BACKUP_EVIDENCE_VERSION ? BackupManifestV2Schema.parse(rawFrame) : BackupFrameSchema.parse(rawFrame)
      if (new TextDecoder('utf-8', { fatal: true }).decode(metadata) !== JSON.stringify(value)) throw new Error('Noncanonical or duplicate backup frame metadata')
      if (value.kind === 'manifest') {
        if (index || payloadLength || value.frames !== frames - 1 || value.bytes !== before || value.documents !== document || value.chain !== chain || !current) throw new Error('Inconsistent backup manifest')
        await terminalEnd()
        if (value.version === WORKSPACE_BACKUP_EVIDENCE_VERSION) {
          if (route !== 2) throw new Error('Backup metadata and manifest version mismatch')
          const stagedVector = async () => vectorDigest((await readBackupMetadata(current!) as { revisionVector: Readonly<Record<string, string>> }).revisionVector)
          if (value.vector !== await stagedVector()) throw new Error('Backup revision vector mismatch')
          // Complete framing and iterator cleanup precede all historical closure validation
          returned = true; await iterator.return?.()
          return await finishEvidenceSnapshot(current, documents, staging, options.signal)
        }
        if (route !== 1) throw new Error('Backup metadata and manifest version mismatch')
        const raw = portable as Omit<WorkspaceSnapshotV1, 'state'> & { state: Omit<WorkspaceState, 'blobs'> & { blobs: WorkspaceBlobRef[] } }
        if (value.vector !== await vectorDigest(raw.revisionVector)) throw new Error('Backup revision vector mismatch')
        if (documents.length !== raw.state.blobs.length) throw new Error('Incomplete backup blob registry')
        const snapshot: WorkspaceSnapshotV1 = { ...raw, state: { ...raw.state, blobs: raw.state.blobs.map((ref, i) => { if (documents[i].encoding !== 'bytes' || documents[i].key !== blobIdentity(ref) || documents[i].content.byteLength !== ref.byteLength) throw new Error('Backup body association mismatch'); return { ref, content: documents[i].content } }) } }
        await validateWorkspaceSnapshot(snapshot)
        options.signal?.throwIfAborted()
        // Iterator cleanup is part of validation ownership: a failing return must release staging
        returned = true; await iterator.return?.()
        let disposed = false
        const owned = ownWorkspaceSnapshot(snapshot, { async check() { if (disposed) throw new Error('Backup snapshot was released'); options.signal?.throwIfAborted() }, async dispose() { disposed = true; await staging.dispose() } })
        registerBackupMetadata(owned, current)
        return owned
      }
      if (value.document !== document || value.chunk !== index || value.length !== payload.length || value.digest !== await hash(payload) || document === 0 && value.encoding !== 'deflate-json-tokens-v1' || document > 0 && route !== 2 && value.encoding !== 'bytes' || encoding !== undefined && encoding !== value.encoding || document === 0 && value.key !== 'workspace' || documentKey !== undefined && documentKey !== value.key) throw new Error('Invalid backup document sequence or digest')
      documentKey = value.key; encoding = value.encoding
      chain = await nextChain(chain, metadata, payload)
      if (value.encoding === 'deflate-json-tokens-v1') {
        const page = decodeBackupPage(payload)
        json.consume(page)
        await writer.write(document, index, page); documentBytes += page.length
      } else { await writer.write(document, index, payload); documentBytes += payload.length }
      index++
      if (value.final) {
        // A document becomes readable only after its encrypted rows are durable
        await writer.flush()
        const content = staging.source(document, index, documentBytes)
        if (value.encoding === 'deflate-json-tokens-v1') {
          const decoded = json.finish()
          if (document === 0) {
            current = content
            route = decoded && typeof decoded === 'object' && 'version' in decoded ? decoded.version : undefined
            if (route !== 2) portable = decoded
          }
          json = new BackupJsonReader()
        }
        if (document > 0) documents.push({ key: documentKey, encoding: value.encoding, content })
        document++; index = 0; documentBytes = 0; documentKey = undefined; encoding = undefined
      }
    }
  } catch (error) { await staging.dispose(); throw error }
  finally { if (!returned) await iterator.return?.() }
}
