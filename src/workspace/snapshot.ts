import type { WorkspaceRepository } from './repository'
import { splitWorkspace, type WorkspaceState } from './documents'
import { validateWorkspaceClosure, inspectWorkspaceClosure, ARCHIVAL_DOCUMENT_KINDS, type WorkspaceBodyValidation } from './closure'
import { blobIdentity, hashBlob, memoryBlob } from './blobs'
import { SnapshotHeaderSchema, SnapshotHeaderV2Schema, WorkspaceBackupError, type HistoricalEvidenceSchema, type SourceEvidenceSchema } from '../interchange/workspace-backup-schema'
import { encodeBackupJson } from '../interchange/workspace-backup-json'
import type { z } from 'zod'
import { jsonEqual } from '../persistence/local-data'
import { getSodium } from '../account/crypto/sodium'
import { isImmutableCatalogSnapshot } from '../interchange/native'

export interface WorkspaceSnapshotV1 {
  readonly version: 1
  readonly snapshotId: string
  readonly capturedAt: string
  readonly revisionVector: Readonly<Record<string, string>>
  readonly state: WorkspaceState
  readonly sourceEvidence?: z.infer<typeof SourceEvidenceSchema>
}
export interface WorkspaceSnapshotV2 extends Omit<WorkspaceSnapshotV1, 'version'> {
  readonly version: 2
  readonly historicalEvidence: z.infer<typeof HistoricalEvidenceSchema>
}
export type WorkspaceSnapshot = WorkspaceSnapshotV1 | WorkspaceSnapshotV2
const historicalReaders = new WeakMap<WorkspaceSnapshotV2, (id: string) => Promise<WorkspaceSnapshotV1>>()
export function registerHistoricalSnapshotReader(snapshot: WorkspaceSnapshotV2, open: (id: string) => Promise<WorkspaceSnapshotV1>): void { historicalReaders.set(snapshot, open) }
export async function openHistoricalSnapshot(snapshot: WorkspaceSnapshot, id: string): Promise<WorkspaceSnapshotV1> {
  await assertWorkspaceSnapshotCurrent(snapshot)
  const open = snapshot.version === 2 && historicalReaders.get(snapshot)
  if (!open) throw new Error('Historical evidence requires an owned snapshot reader')
  return open(id)
}
export function projectWorkspaceSnapshotV1(snapshot: WorkspaceSnapshot): WorkspaceSnapshotV1 {
  if (snapshot.version === 1) return snapshot
  const { historicalEvidence: _historicalEvidence, ...current } = snapshot
  return { ...current, version: 1 }
}
export interface SnapshotOwner { check(): Promise<void>; dispose(): Promise<void> }
const owners = new WeakMap<WorkspaceSnapshot, SnapshotOwner>()
const captures = new WeakMap<WorkspaceRepository, () => Promise<WorkspaceSnapshot>>()
export function registerWorkspaceCapture(repository: WorkspaceRepository, capture: () => Promise<WorkspaceSnapshot>): void { captures.set(repository, capture) }
export function ownWorkspaceSnapshot<T extends WorkspaceSnapshot>(snapshot: T, owner: SnapshotOwner): T
export function ownWorkspaceSnapshot(snapshot: WorkspaceSnapshot, owner: SnapshotOwner): WorkspaceSnapshot {
  // Clone only portable metadata: repository-owned objects and lazy capability internals stay untouched
  const { state, ...header } = snapshot
  // Reuse only catalogs deeply frozen by the format owner, preserving its structural admission
  // Caller-frozen catalogs still need copying; a shallow freeze cannot protect their descendants
  // Source identity and closure checks still run at their existing boundaries
  const catalogs = state.planner.catalogs.map(catalog => isImmutableCatalogSnapshot(catalog) ? catalog : structuredClone(catalog))
  const metadata = structuredClone({ ...header, state: { ...state, planner: { ...state.planner, catalogs: [] as typeof state.planner.catalogs }, blobs: state.blobs.map(({ ref }) => ref) } })
  metadata.state.planner.catalogs = catalogs
  const freeze = (value: unknown): void => { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return; for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  freeze(metadata)
  const owned: WorkspaceSnapshot = Object.freeze({ ...metadata, state: Object.freeze({ ...metadata.state, blobs: Object.freeze(state.blobs.map((blob, index) => Object.freeze({ ref: metadata.state.blobs[index], content: blob.content }))) }) })
  owners.set(owned, owner); return owned
}
export async function assertOwnedWorkspaceSnapshot(snapshot: WorkspaceSnapshot): Promise<void> {
  const owner = owners.get(snapshot)
  if (!owner) throw new Error('A registered owned workspace snapshot is required')
  await owner.check()
}
export async function assertWorkspaceSnapshotCurrent(snapshot: WorkspaceSnapshot): Promise<void> { await owners.get(snapshot)?.check() }
export async function disposeWorkspaceSnapshot(snapshot: WorkspaceSnapshot): Promise<void> { await owners.get(snapshot)?.dispose() }
export async function captureWorkspaceSnapshot(repository: WorkspaceRepository): Promise<WorkspaceSnapshot> {
  const capture = captures.get(repository)
  if (!capture) throw new WorkspaceBackupError('BACKUP_INVALID', 'A complete captured workspace is unavailable. Keep this workspace open and retry.')
  return capture()
}
export function snapshotMetadata(snapshot: WorkspaceSnapshot) {
  const { state, ...header } = snapshot
  const schema = snapshot.version === 2 ? SnapshotHeaderV2Schema : SnapshotHeaderSchema
  schema.parse(header)
  return { ...header, state: { ...state, blobs: state.blobs.map(({ ref }) => ref) } }
}
export async function backupMetadataDigest(value: unknown): Promise<string> {
  const sodium = await getSodium(), state = sodium.crypto_hash_sha256_init()
  try {
    for (const chunk of encodeBackupJson(value)) sodium.crypto_hash_sha256_update(state, chunk)
    return sodium.crypto_hash_sha256_final(state, 'hex')
  } catch (error) {
    // The pinned wrapper frees SHA state on final; failed token encoding still owns the allocation
    const raw = (sodium as unknown as { libsodium: { HEAPU8: Uint8Array; _crypto_hash_sha256_statebytes(): number; _free(address: number): void } }).libsodium
    const address = state as unknown as number
    raw.HEAPU8.fill(0, address, address + raw._crypto_hash_sha256_statebytes()); raw._free(address)
    throw error
  }
}
export async function validateWorkspaceSnapshot(snapshot: WorkspaceSnapshot): Promise<void> {
  snapshotMetadata(snapshot)
  if (snapshot.version === 2 && !historicalReaders.has(snapshot)) throw new Error('Historical evidence requires an owned snapshot reader')
  await validateWorkspaceSnapshotV1(projectWorkspaceSnapshotV1(snapshot))
}
// Frozen complete-backup v1 admission includes recursive native/domain validation, not only the header
// Preserve this route and its dependencies when evolving current formats: closure.ts, validation.ts,
// file-schemas.ts, planner-journal.ts, documents.ts, document-codec.ts, domain-closure.ts,
// interchange/native.ts and native-schema.ts, and persistence/local-data.ts
// Parsers validate without replacing decoded values: key order binds sourceEvidence.projectedDigest
export async function validateWorkspaceSnapshotV1(snapshot: WorkspaceSnapshotV1, bodyValidation?: WorkspaceBodyValidation): Promise<void> {
  const { state: _state, ...header } = snapshot
  SnapshotHeaderSchema.parse(header)
  await validateWorkspaceClosure(snapshot.state, bodyValidation)
  if (!snapshot.sourceEvidence) return
  const declared = new Map(snapshot.state.blobs.map(blob => [blobIdentity(blob.ref), blob]))
  const annex = snapshot.sourceEvidence
  const keys = new Set<string>(), used = new Set<string>()
  const current = new Map(splitWorkspace(snapshot.state).map(document => [document.key, document]))
  for (const unit of annex.units) {
    if (keys.has(unit.key)) throw new Error('Duplicate current-unit evidence')
    keys.add(unit.key)
    const projected = current.get(unit.key)
    if (!projected || await backupMetadataDigest(projected) !== unit.projectedDigest) throw new Error('Current-unit evidence has a foreign projected association')
    const inspected = await inspectWorkspaceClosure(snapshot.state, unit.closure)
    if (inspected.root.key !== unit.key) throw new Error('Current-unit evidence key mismatch')
    const semantic = (value: unknown) => {
      if (projected.kind !== 'playthrough') return value
      const original = value as { metadata: Record<string, unknown> }
      const { revision: _revision, updatedAt: _updatedAt, ...metadata } = original.metadata
      return { ...original, metadata }
    }
    if (!jsonEqual(semantic(inspected.value), semantic(projected.value))) throw new Error('Current-unit evidence differs from its projected logical record')
    const root = inspected.root.ref
    if (root.revisionId !== unit.source.revisionId || root.documentId !== unit.source.documentId && root.documentId !== `materialized-catalog:${unit.source.documentId}`) throw new Error('Current-unit evidence body mismatch')
    // Original packaged frames keep a separate identity; ordinary structural values retain exact decoded evidence
    const original = declared.get(blobIdentity(unit.source))
    if (original && inspected.refs.has(blobIdentity(original.ref)) && original.ref.encoding === 'bytes') {
      if (original.ref.sha256 !== unit.source.digest) throw new Error('Current-unit original frame mismatch')
    } else {
      const { workspaceDocumentSource } = await import('./document-codec')
      const framed = workspaceDocumentSource({ version: 1, kind: inspected.root.kind, key: unit.key, value: inspected.value as import('../domain/types').JsonValue })
      if (await hashBlob(framed) !== unit.source.digest) throw new Error('Current-unit original digest mismatch')
    }
    for (const id of inspected.refs) used.add(id)
  }
  for (const document of current.values()) if ((ARCHIVAL_DOCUMENT_KINDS as readonly string[]).includes(document.kind) && !['blob', 'tombstone', 'unit-index', 'directory', 'directory-page'].includes(document.kind) && !keys.has(document.key)) throw new Error('Missing current-unit source evidence')
  const listed = new Set<string>()
  for (const ref of annex.blobs) {
    const id = blobIdentity(ref)
    if (listed.has(id) || !used.has(id) || JSON.stringify(declared.get(id)?.ref) !== JSON.stringify(ref)) throw new Error('Orphaned or inconsistent source evidence')
    listed.add(id)
  }
  if (used.size !== listed.size) throw new Error('Incomplete source-evidence registry')
}
export async function vectorDigest(vector: Readonly<Record<string, string>>): Promise<string> {
  return hashBlob(memoryBlob(new TextEncoder().encode(JSON.stringify(Object.entries(vector).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))))
}
