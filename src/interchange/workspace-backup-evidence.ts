import { BackupJsonReader, encodeBackupJson } from './workspace-backup-json'
import { SnapshotHeaderV2Schema, WORKSPACE_BACKUP_LIMITS } from './workspace-backup-schema'
import { createBackupStaging } from '../workspace/backup-staging'
import { getSodium } from '../account/crypto/sodium'
import { withImmutableWorkspaceBodyValidation, type WorkspaceBodyValidation } from '../workspace/closure'
import { blobIdentity, hashBlob } from '../workspace/blobs'
import type { BlobSource, WorkspaceBlobRef, WorkspaceState } from '../workspace/documents'
import { assertOwnedWorkspaceSnapshot, assertWorkspaceSnapshotCurrent, disposeWorkspaceSnapshot, ownWorkspaceSnapshot, projectWorkspaceSnapshotV1, registerHistoricalSnapshotReader, snapshotMetadata, validateWorkspaceSnapshotV1, vectorDigest, type WorkspaceSnapshot, type WorkspaceSnapshotV1, type WorkspaceSnapshotV2, type SnapshotOwner } from '../workspace/snapshot'

type MetadataState = Omit<WorkspaceState, 'blobs'> & { blobs: WorkspaceBlobRef[] }
export type SnapshotMetadataV1 = Omit<WorkspaceSnapshotV1, 'state'> & { state: MetadataState }
export type SnapshotMetadataV2 = Omit<WorkspaceSnapshotV2, 'state'> & { state: MetadataState }
export interface BackupDocument { readonly key: string; readonly encoding: 'bytes' | 'deflate-json-tokens-v1'; readonly content: BlobSource }
type Staging = Awaited<ReturnType<typeof createBackupStaging>>
type BlobEntry = WorkspaceState['blobs'][number]
interface CapturedEvidence { readonly current: BlobSource; readonly historical: ReadonlyMap<string, BlobSource>; readonly blobs: readonly BlobEntry[] }
const captured = new WeakMap<WorkspaceSnapshot, CapturedEvidence>()
const ID_DOMAIN = new TextEncoder().encode('crykit/historical-snapshot/v1\0')
const CAPTURE_METADATA_PAGE_BYTES = WORKSPACE_BACKUP_LIMITS.payload
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
export const compareBackupRefs = (a: WorkspaceBlobRef, b: WorkspaceBlobRef) => compare(a.documentId, b.documentId) || compare(a.revisionId, b.revisionId)
const sameRef = (a: WorkspaceBlobRef, b: WorkspaceBlobRef) => a.documentId === b.documentId && a.revisionId === b.revisionId && a.byteLength === b.byteLength && a.sha256 === b.sha256 && a.encoding === b.encoding

export function metadataSource(value: unknown): BlobSource {
  // New captures amortize encrypted-record and upload overhead within the existing frame bound
  // Stored historical pages remain exact; v1 archive export retains the encoder's legacy default
  let byteLength = 0
  for (const page of encodeBackupJson(value, CAPTURE_METADATA_PAGE_BYTES, { packByBytes: true })) byteLength += page.length
  return { byteLength, async *open() { yield* encodeBackupJson(value, CAPTURE_METADATA_PAGE_BYTES, { packByBytes: true }) } }
}
export async function readBackupMetadata(content: BlobSource): Promise<unknown> {
  const json = new BackupJsonReader()
  for await (const page of content.open()) json.consume(page)
  return json.finish()
}
export async function historicalEvidenceId(content: BlobSource): Promise<string> {
  return hashBlob({ byteLength: ID_DOMAIN.length + content.byteLength, async *open() { yield ID_DOMAIN; yield* content.open() } })
}
// Both identities describe one traversal of the exact stored bytes, even for a mutable input source
export async function historicalMetadataIdentity(content: BlobSource): Promise<{ id: string; metadataStreamDigest: string }> {
  const sodium = await getSodium()
  const identity = sodium.crypto_hash_sha256_init(), stream = sodium.crypto_hash_sha256_init()
  const live = new Set([identity, stream])
  try {
    sodium.crypto_hash_sha256_update(identity, ID_DOMAIN)
    let length = 0
    for await (const chunk of content.open()) {
      length += chunk.length
      if (length > content.byteLength) throw new Error('Historical metadata length mismatch')
      sodium.crypto_hash_sha256_update(identity, chunk); sodium.crypto_hash_sha256_update(stream, chunk)
    }
    if (length !== content.byteLength) throw new Error('Historical metadata length mismatch')
    const id = sodium.crypto_hash_sha256_final(identity, 'hex'); live.delete(identity)
    const metadataStreamDigest = sodium.crypto_hash_sha256_final(stream, 'hex'); live.delete(stream)
    return { id, metadataStreamDigest }
  } finally {
    // libsodium frees a finalized state; an interrupted traversal still owns the remaining allocations
    const raw = (sodium as unknown as { libsodium: { HEAPU8: Uint8Array; _crypto_hash_sha256_statebytes(): number; _free(address: number): void } }).libsodium
    for (const state of live) { const address = state as unknown as number; raw.HEAPU8.fill(0, address, address + raw._crypto_hash_sha256_statebytes()); raw._free(address) }
  }
}
// Readers may clear each yielded chunk on advance, so compare before advancing either stream
export async function equalMetadataStreams(a: BlobSource, b: BlobSource): Promise<boolean> {
  if (a.byteLength !== b.byteLength) return false
  const left = a.open()[Symbol.asyncIterator](), right = b.open()[Symbol.asyncIterator]()
  const next = async (iterator: AsyncIterator<Uint8Array>) => {
    let value = await iterator.next()
    while (!value.done && !value.value.length) value = await iterator.next()
    return value
  }
  try {
    let l = await next(left), r = await next(right), li = 0, ri = 0, compared = 0
    while (!l.done && !r.done) {
      const count = Math.min(l.value.length - li, r.value.length - ri)
      for (let index = 0; index < count; index++) if (l.value[li + index] !== r.value[ri + index]) return false
      li += count; ri += count; compared += count
      if (li === l.value.length) { l = await next(left); li = 0 }
      if (ri === r.value.length) { r = await next(right); ri = 0 }
    }
    return !!l.done && !!r.done && compared === a.byteLength
  } finally { try { await left.return?.() } finally { await right.return?.() } }
}
export function attachBackupBodies(raw: SnapshotMetadataV1, registry: ReadonlyMap<string, BlobEntry>): WorkspaceSnapshotV1
export function attachBackupBodies(raw: SnapshotMetadataV2, registry: ReadonlyMap<string, BlobEntry>): WorkspaceSnapshotV2
export function attachBackupBodies(raw: SnapshotMetadataV1 | SnapshotMetadataV2, registry: ReadonlyMap<string, BlobEntry>): WorkspaceSnapshot {
  const snapshot = { ...raw, state: { ...raw.state, blobs: raw.state.blobs.map(ref => {
    const body = registry.get(blobIdentity(ref))
    if (!body || !sameRef(body.ref, ref)) throw new Error('Backup body association mismatch')
    return { ref, content: body.content }
  }) } }
  return snapshot
}
export function registerBackupMetadata(snapshot: WorkspaceSnapshotV1, current: BlobSource): void {
  captured.set(snapshot, { current, historical: new Map(), blobs: snapshot.state.blobs })
}
export function capturedBackupEvidence(snapshot: WorkspaceSnapshot): CapturedEvidence {
  const value = captured.get(snapshot)
  if (!value) {
    if (snapshot.version === 2) throw new Error('Historical evidence requires an owned captured reader')
    return { current: metadataSource(snapshotMetadata(snapshot)), historical: new Map(), blobs: snapshot.state.blobs }
  }
  return value
}

// The terminal manifest and EOF must already be checked before this serial full-validation pass
// Keep current metadata plus one historical value; the returned parent owns every staged view
export async function finishEvidenceSnapshot(current: BlobSource, documents: readonly BackupDocument[], staging: Staging, expectedVector: string, signal?: AbortSignal): Promise<WorkspaceSnapshotV2> {
  const raw = await readBackupMetadata(current) as SnapshotMetadataV2
  // Bind the terminal vector and admission to the same complete staged decode after iterator cleanup
  // Decoding it again wastes work and could check a different value if the backing source changes
  if (expectedVector !== await vectorDigest(raw.revisionVector)) throw new Error('Backup revision vector mismatch')
  return constructEvidenceSnapshot(raw, current, documents, staging, signal)
}

// The archive route parses framed stored bytes above; the join builds this exact value from its owned current
// Avoid encoding and parsing that immutable current twice while historical members always retain stored bytes
async function constructEvidenceSnapshot(raw: SnapshotMetadataV2, current: BlobSource, documents: readonly BackupDocument[], staging: Staging, signal?: AbortSignal, retainedOwner?: SnapshotOwner): Promise<WorkspaceSnapshotV2> {
  const { state: _state, ...header } = raw
  SnapshotHeaderV2Schema.parse(header)
  const { snapshots, blobs } = raw.historicalEvidence
  if (snapshots.some((entry, index) => index > 0 && compare(snapshots[index - 1].id, entry.id) >= 0)) throw new Error('Unsorted or duplicate historical evidence')
  if (blobs.some((ref, index) => index > 0 && compareBackupRefs(blobs[index - 1], ref) >= 0)) throw new Error('Unsorted or duplicate shared backup body')
  if (documents.length !== snapshots.length + blobs.length) throw new Error('Incomplete backup document registry')
  const historical = new Map<string, BlobSource>()
  for (const [index, entry] of snapshots.entries()) {
    const document = documents[index]
    if (document.key !== `historical:${entry.id}` || document.encoding !== 'deflate-json-tokens-v1') throw new Error('Historical document association mismatch')
    historical.set(entry.id, document.content)
  }
  const registry = new Map<string, BlobEntry>()
  for (const [index, ref] of blobs.entries()) {
    const document = documents[snapshots.length + index]
    if (document.key !== blobIdentity(ref) || document.encoding !== 'bytes' || document.content.byteLength !== ref.byteLength) throw new Error('Shared body association mismatch')
    registry.set(blobIdentity(ref), { ref, content: document.content })
  }
  const used = new Set<string>()
  const validate = async (value: SnapshotMetadataV1, bodyValidation?: WorkspaceBodyValidation): Promise<WorkspaceSnapshotV1> => {
    const snapshot = attachBackupBodies(value, registry)
    await validateWorkspaceSnapshotV1(snapshot, bodyValidation)
    for (const ref of value.state.blobs) used.add(blobIdentity(ref))
    return snapshot
  }
  const streamDigests = new Map<string, string>()
  // The registry is immutable encrypted staging owned by this archive invocation
  // Release digest reuse before exposing any reader; later opening validates afresh
  await withImmutableWorkspaceBodyValidation([...registry.values()], async bodyValidation => {
    const projected = projectWorkspaceSnapshotV1(attachBackupBodies(raw, registry))
    await validateWorkspaceSnapshotV1(projected, bodyValidation)
    for (const ref of raw.state.blobs) used.add(blobIdentity(ref))
    for (const [id, content] of historical) {
      const identity = await historicalMetadataIdentity(content)
      streamDigests.set(id, identity.metadataStreamDigest)
      if (identity.id !== id) throw new Error('Historical metadata identity mismatch')
      await validate(await readBackupMetadata(content) as SnapshotMetadataV1, bodyValidation)
    }
  })
  if (used.size !== registry.size) throw new Error('Orphaned shared backup body')
  let disposed = false, active = false
  const check = async () => { signal?.throwIfAborted(); if (disposed) throw new Error('Backup snapshot was released'); await retainedOwner?.check() }
  let disposal: Promise<void> | undefined
  const snapshot = ownWorkspaceSnapshot(attachBackupBodies(raw, registry), { check, dispose() { if (!disposal) { disposed = true; disposal = (async () => { try { await staging.dispose() } finally { await retainedOwner?.dispose() } })() } return disposal } })
  captured.set(snapshot, { current, historical, blobs: [...registry.values()] })
  registerHistoricalSnapshotReader(snapshot, async id => {
    await check()
    if (active) throw new Error('Release the open historical snapshot before opening another')
    const content = historical.get(id)
    if (!content) throw new Error('Unknown historical snapshot')
    active = true
    try {
      const identity = await historicalMetadataIdentity(content)
      if (identity.id !== id || identity.metadataStreamDigest !== streamDigests.get(id)) throw new Error('Historical metadata identity mismatch')
      const value = await validate(await readBackupMetadata(content) as SnapshotMetadataV1)
      let released = false
      const childCheck = async () => { await check(); if (released) throw new Error('Historical snapshot was released') }
      const state = { ...value.state, blobs: value.state.blobs.map(blob => ({ ref: blob.ref, content: { byteLength: blob.content.byteLength, async *open() { await childCheck(); for await (const bytes of blob.content.open()) { await childCheck(); yield bytes; await childCheck() } } } })) }
      const child = ownWorkspaceSnapshot({ ...value, state }, { check: childCheck, async dispose() { if (!released) { released = true; active = false } } })
      registerBackupMetadata(child, { byteLength: content.byteLength, async *open() { await childCheck(); for await (const bytes of content.open()) { await childCheck(); yield bytes; await childCheck() } } })
      await check()
      return child
    } catch (error) { active = false; throw error }
  })
  await check()
  return snapshot
}

// This portable capture owns fresh encrypted staging and survives release of every input snapshot
// Ordinary edits never call this producer: only an explicit inheritance operation adds a capture
export async function inheritWorkspaceSnapshot(current: WorkspaceSnapshot, sources: readonly WorkspaceSnapshot[], options: { readonly signal?: AbortSignal } = {}): Promise<WorkspaceSnapshotV2> {
  const staging = await createBackupStaging(options.signal)
  let document = 1
  const stage = (source: BlobSource) => staging.stage(document++, source)
  try {
    const members = new Map<string, BlobSource>(), registry = new Map<string, BlobEntry>()
    const add = async (source: BlobSource, claimedId?: string) => {
      const id = await historicalEvidenceId(source)
      if (claimedId !== undefined && id !== claimedId) throw new Error('Historical metadata identity mismatch')
      const previous = members.get(id)
      if (previous) { if (!await equalMetadataStreams(previous, source)) throw new Error('Contradictory historical metadata'); return }
      members.set(id, await stage(source))
    }
    for (const input of [current, ...sources]) {
      await assertWorkspaceSnapshotCurrent(input)
      await validateWorkspaceSnapshotV1(projectWorkspaceSnapshotV1(input))
      const evidence = capturedBackupEvidence(input)
      for (const [id, metadata] of evidence.historical) await add(metadata, id)
      if (input !== current || sources.includes(input)) await add(input.version === 1 ? evidence.current : metadataSource(snapshotMetadata(projectWorkspaceSnapshotV1(input))))
      for (const blob of evidence.blobs) {
        const id = blobIdentity(blob.ref), previous = registry.get(id)
        if (previous && !sameRef(previous.ref, blob.ref)) throw new Error('Contradictory shared backup body')
        if (!previous) registry.set(id, { ref: blob.ref, content: await stage(blob.content) })
        else if (!await equalMetadataStreams(previous.content, blob.content)) throw new Error('Contradictory shared backup body bytes')
      }
      await assertWorkspaceSnapshotCurrent(input)
    }
    const historical = [...members].sort(([a], [b]) => compare(a, b))
    const blobs = [...registry.values()].sort((a, b) => compareBackupRefs(a.ref, b.ref))
    const metadata = { ...snapshotMetadata(projectWorkspaceSnapshotV1(current)), version: 2, historicalEvidence: { version: 1, snapshots: historical.map(([id]) => ({ id })), blobs: blobs.map(({ ref }) => ref) } }
    const stagedCurrent = await stage(metadataSource(metadata))
    const documents: BackupDocument[] = [...historical.map(([id, content]) => ({ key: `historical:${id}`, encoding: 'deflate-json-tokens-v1' as const, content })), ...blobs.map(blob => ({ key: blobIdentity(blob.ref), encoding: 'bytes' as const, content: blob.content }))]
    for (const input of [current, ...sources]) await assertWorkspaceSnapshotCurrent(input)
    return await finishEvidenceSnapshot(stagedCurrent, documents, staging, await vectorDigest(current.revisionVector), options.signal)
  } catch (error) { await staging.dispose(); throw error }
}

export interface InheritedSnapshotSources {
  readonly members: readonly { readonly id: string; readonly metadata: BlobSource; readonly subset: readonly WorkspaceBlobRef[] }[]
  readonly bodies: readonly WorkspaceState['blobs'][number][]
}

// Success adopts the current owner so frozen guest freshness survives terminal export
// Failure leaves that owner with the caller; only this operation's new staging is deleted
export async function joinWorkspaceSnapshotEvidence(current: WorkspaceSnapshotV1, inherited: InheritedSnapshotSources, options: { readonly signal?: AbortSignal } = {}): Promise<WorkspaceSnapshotV2> {
  await assertOwnedWorkspaceSnapshot(current)
  const staging = await createBackupStaging(options.signal)
  let ordinal = 0
  const stage = (source: BlobSource) => staging.stage(ordinal++, source)
  try {
    const registry = new Map<string, BlobEntry>(), historicalBodies = new Set<string>(), used = new Set<string>()
    for (const blob of inherited.bodies) {
      const key = blobIdentity(blob.ref)
      if (historicalBodies.has(key)) throw new Error('Duplicate historical body')
      historicalBodies.add(key)
      registry.set(key, { ref: blob.ref, content: await stage(blob.content) })
    }
    const historical = new Map<string, BlobSource>()
    for (const member of inherited.members) {
      const metadata = await stage(member.metadata)
      if (await historicalEvidenceId(metadata) !== member.id) throw new Error('Historical metadata identity mismatch')
      const raw = await readBackupMetadata(metadata) as SnapshotMetadataV1
      if (raw.version !== 1 || raw.state.blobs.length !== member.subset.length || raw.state.blobs.some((ref, index) => !sameRef(ref, member.subset[index]))) throw new Error('Historical subset mismatch')
      for (const ref of member.subset) {
        const key = blobIdentity(ref), body = registry.get(key)
        if (!body || !sameRef(ref, body.ref)) throw new Error('Historical subset body mismatch')
        used.add(key)
      }
      const previous = historical.get(member.id)
      if (previous && !await equalMetadataStreams(previous, metadata)) throw new Error('Contradictory historical metadata')
      if (!previous) historical.set(member.id, metadata)
    }
    if (used.size !== historicalBodies.size) throw new Error('Orphan historical body')
    for (const blob of current.state.blobs) {
      const key = blobIdentity(blob.ref), previous = registry.get(key)
      if (previous && (!sameRef(previous.ref, blob.ref) || !await equalMetadataStreams(previous.content, blob.content))) throw new Error('Contradictory shared backup body')
      if (!previous) registry.set(key, { ref: blob.ref, content: blob.content })
    }
    const members = [...historical].sort(([a], [b]) => compare(a, b)), blobs = [...registry.values()].sort((a, b) => compareBackupRefs(a.ref, b.ref))
    const raw: SnapshotMetadataV2 = structuredClone({ ...snapshotMetadata(current), version: 2, historicalEvidence: { version: 1, snapshots: members.map(([id]) => ({ id })), blobs: blobs.map(blob => blob.ref) } })
    const metadata = metadataSource(raw)
    const documents: BackupDocument[] = [...members.map(([id, content]) => ({ key: `historical:${id}`, encoding: 'deflate-json-tokens-v1' as const, content })), ...blobs.map(blob => ({ key: blobIdentity(blob.ref), encoding: 'bytes' as const, content: blob.content }))]
    await assertOwnedWorkspaceSnapshot(current)
    return await constructEvidenceSnapshot(raw, metadata, documents, staging, options.signal, { check: () => assertOwnedWorkspaceSnapshot(current), dispose: () => disposeWorkspaceSnapshot(current) })
  } catch (error) { await staging.dispose(); throw error }
}
