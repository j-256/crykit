import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import type { CatalogSnapshot } from '../domain/types'
import type { WorkspaceRepository } from './repository'
import { splitWorkspace, type WorkspaceDocument, type WorkspaceState } from './documents'
import { validateWorkspaceClosure, inspectWorkspaceClosures, ARCHIVAL_DOCUMENT_KINDS, type WorkspaceBodyValidation, type WorkspaceRetentionEdges } from './closure'
import { blobIdentity, hashBlob, memoryBlob } from './blobs'
import { SnapshotHeaderSchema, SnapshotHeaderV2Schema, SnapshotHeaderV3Schema, type HistoricalCatalogEvidenceSchema, WorkspaceBackupError, type HistoricalEvidenceSchema, type SourceEvidenceSchema } from '../interchange/workspace-backup-schema'
import { encodeBackupJson } from '../interchange/workspace-backup-json'
import type { z } from 'zod'
import { jsonEqual } from '../persistence/local-data'
import { getSodium } from '../account/crypto/sodium'
import { hydrateStoredCatalogs, catalogExpansionBudget, resolveRetainedCatalog, sameCatalogBodyRef, type StoredCatalog, type OwnedCatalogRegistry } from './catalog-reference'
import { isImmutableCatalogSnapshot } from '../interchange/native'

export interface WorkspaceSnapshotV1 {
  readonly version: 1
  readonly dataGeneration: typeof LAUNCH_DATA_GENERATION
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
export interface WorkspaceSnapshotV3 extends Omit<WorkspaceSnapshotV1, 'version'> {
  readonly version: 3
  readonly catalogBodies: readonly import('./file-types').WorkspaceBlobRef[]
  readonly historicalEvidence?: z.infer<typeof HistoricalCatalogEvidenceSchema>
}
export type InheritedWorkspaceSnapshot = WorkspaceSnapshotV2 | (WorkspaceSnapshotV3 & { readonly historicalEvidence: NonNullable<WorkspaceSnapshotV3['historicalEvidence']> })
export type WorkspaceSnapshot = WorkspaceSnapshotV1 | WorkspaceSnapshotV2 | WorkspaceSnapshotV3
export type SnapshotMetadataV3 = Omit<WorkspaceSnapshotV3, 'state'> & { readonly state: Omit<WorkspaceState, 'planner' | 'blobs'> & { readonly planner: Omit<WorkspaceState['planner'], 'catalogs'> & { readonly catalogs: readonly StoredCatalog[] }; readonly blobs: readonly import('./file-types').WorkspaceBlobRef[] } }
const compactMetadata = new WeakMap<WorkspaceSnapshotV3, { readonly metadata: SnapshotMetadataV3; readonly registry: OwnedCatalogRegistry }>()
const historicalReaders = new WeakMap<WorkspaceSnapshot, (id: string) => Promise<WorkspaceSnapshotV1 | WorkspaceSnapshotV3>>()
export function registerHistoricalSnapshotReader(snapshot: WorkspaceSnapshotV2 | WorkspaceSnapshotV3, open: (id: string) => Promise<WorkspaceSnapshotV1 | WorkspaceSnapshotV3>): void { historicalReaders.set(snapshot, open) }
export function openHistoricalSnapshot(snapshot: WorkspaceSnapshotV2, id: string): Promise<WorkspaceSnapshotV1>
export function openHistoricalSnapshot(snapshot: WorkspaceSnapshot, id: string): Promise<WorkspaceSnapshotV1 | WorkspaceSnapshotV3>
export async function openHistoricalSnapshot(snapshot: WorkspaceSnapshot, id: string): Promise<WorkspaceSnapshotV1 | WorkspaceSnapshotV3> {
  await assertWorkspaceSnapshotCurrent(snapshot)
  const open = snapshot.version !== 1 && historicalReaders.get(snapshot)
  if (!open) throw new Error('Historical evidence requires an owned snapshot reader')
  return open(id)
}
export function projectWorkspaceSnapshotV1(snapshot: WorkspaceSnapshot): WorkspaceSnapshotV1 {
  if (snapshot.version === 1) return snapshot
  const { historicalEvidence: _historicalEvidence, ...current } = snapshot
  if (snapshot.version === 3) throw new WorkspaceBackupError('UNSUPPORTED_VERSION', 'Legacy conversion cannot preserve exact compact catalog provenance. Choose complete backup 2.2.0')
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
export function snapshotMetadata(snapshot: WorkspaceSnapshotV1): import('../interchange/workspace-backup-evidence').SnapshotMetadataV1
export function snapshotMetadata(snapshot: WorkspaceSnapshotV2): import('../interchange/workspace-backup-evidence').SnapshotMetadataV2
export function snapshotMetadata(snapshot: WorkspaceSnapshotV3): SnapshotMetadataV3
export function snapshotMetadata(snapshot: WorkspaceSnapshot): import('../interchange/workspace-backup-evidence').SnapshotMetadataV1 | import('../interchange/workspace-backup-evidence').SnapshotMetadataV2 | SnapshotMetadataV3
export function snapshotMetadata(snapshot: WorkspaceSnapshot) {
  if (snapshot.version === 3) {
    const compact = compactMetadata.get(snapshot)
    if (!compact) throw new Error('Compact snapshots require owned reader admission')
    return compact.metadata
  }
  const { state, ...header } = snapshot
  const schema = snapshot.version === 2 ? SnapshotHeaderV2Schema : SnapshotHeaderSchema
  schema.parse(header)
  return { ...header, state: { ...state, blobs: state.blobs.map(({ ref }) => ref) } }
}
const CATALOG_DIGEST_SLICE_MS = 16
const CATALOG_DOCUMENT_FIELDS: ReadonlySet<PropertyKey> = new Set(['version', 'kind', 'key', 'value'])
const stableCatalogDigestInputs = new WeakSet<CatalogSnapshot>()
const completedCatalogDigests = new WeakMap<CatalogSnapshot, { readonly signature: string; readonly digest: string }>()
export function backupMetadataDigest(value: unknown): Promise<string> { return digestMetadata(value) }
export function backupWorkspaceDocumentDigest(document: WorkspaceDocument, checkpoint?: () => Promise<void>): Promise<string> {
  // Preserve the cooperative traversal for the format owner's catalog projections
  if (!checkpoint || document.kind !== 'catalog' || !isImmutableCatalogSnapshot(document.value as unknown as CatalogSnapshot)
    || !Object.keys(document).every(key => CATALOG_DOCUMENT_FIELDS.has(key))) return backupMetadataDigest(document)

  const detached = Object.freeze({ ...document })
  const catalog = detached.value as unknown as CatalogSnapshot
  // The wrapper can supply a different value during spread; check the actual value before using catalog scheduling
  if (!isImmutableCatalogSnapshot(catalog)) return backupMetadataDigest(detached)
  const signature = catalogDocumentDigestSignature(document, detached)
  return signature === undefined ? digestMetadata(detached, checkpoint) : digestCatalogDocument(detached, catalog, signature, checkpoint)
}
function catalogDocumentDigestSignature(source: WorkspaceDocument, detached: WorkspaceDocument): string | undefined {
  if (detached.version !== 1 || detached.kind !== 'catalog' || typeof detached.key !== 'string') return
  const fields = Reflect.ownKeys(detached)
  if (fields.length !== CATALOG_DOCUMENT_FIELDS.size || fields.some(field => !CATALOG_DOCUMENT_FIELDS.has(field))) return
  // Spread normalizes accessors and exotic wrappers, so only plain own data fields qualify for reuse
  try {
    if (Object.getPrototypeOf(source) !== Object.prototype || Reflect.ownKeys(source).length !== fields.length) return
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(source, field)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return
    }
  } catch {
    // A wrapper that rejects cache inspection keeps its existing detached digest path
    return
  }
  // Legacy token pages bind the exact order of the detached projection's fields
  return JSON.stringify([detached.version, detached.kind, detached.key, fields])
}
function hasStableCatalogDigestInput(catalog: CatalogSnapshot): boolean {
  if (stableCatalogDigestInputs.has(catalog)) return true
  const ancestors = new WeakSet<object>(), visited = new WeakSet<object>()
  function visit(value: unknown): boolean {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value !== 'object') return false
    if (visited.has(value)) return true
    if (ancestors.has(value) || !Object.isFrozen(value)) return false

    const array = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value)
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
      if (prototype !== Array.prototype || keys.at(-1) !== 'length' || length !== keys.length - 1) return false
      keys.pop()
    } else if (prototype !== Object.prototype && prototype !== null) return false

    ancestors.add(value)
    for (const [index, key] of keys.entries()) {
      if (typeof key !== 'string' || (array && key !== String(index))) return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || !visit(descriptor.value)) return false
    }
    ancestors.delete(value)
    visited.add(value)
    return true
  }
  try {
    // Freezing leaves getters callable, so inspect descriptors before giving a serializer the input
    if (!visit(catalog)) return false
    // Frozen proxies can reorder the encoder's keys; structured clone rejects them anywhere in the graph
    structuredClone(catalog)
  } catch { return false }
  return true
}
async function digestCatalogDocument(document: WorkspaceDocument, catalog: CatalogSnapshot, signature: string, checkpoint: () => Promise<void>): Promise<string> {
  const completed = completedCatalogDigests.get(catalog)
  if (completed?.signature === signature) {
    // The hash belongs to this immutable input; lifetime checks belong to each caller
    await checkpoint()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    await checkpoint()
    return completed.digest
  }
  // Each cold caller owns its hash state; only a successful traversal of stable data can publish a digest
  const digest = await digestMetadata(document, checkpoint)
  const eligible = hasStableCatalogDigestInput(catalog)
  // Reflection can invoke caller traps after SHA finalization; let their queued microtasks run before checking lifetime
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  await checkpoint()
  if (eligible) {
    stableCatalogDigestInputs.add(catalog)
    completedCatalogDigests.set(catalog, { signature, digest })
  }
  return digest
}
async function digestMetadata(value: unknown, checkpoint?: () => Promise<void>): Promise<string> {
  const sodium = await getSodium(), state = sodium.crypto_hash_sha256_init()
  try {
    if (checkpoint) await checkpoint()
    // Split after the first bounded page too, so preceding validation does not borrow a full slice
    let lastYield = -Infinity
    for (const chunk of encodeBackupJson(value)) {
      sodium.crypto_hash_sha256_update(state, chunk)
      if (checkpoint && performance.now() - lastYield >= CATALOG_DIGEST_SLICE_MS) {
        await checkpoint()
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        await checkpoint()
        lastYield = performance.now()
      }
    }
    if (checkpoint) await checkpoint()
    return sodium.crypto_hash_sha256_final(state, 'hex')
  } catch (error) {
    // The pinned wrapper frees SHA state on final; failed token encoding still owns the allocation
    const raw = (sodium as unknown as { libsodium: { HEAPU8: Uint8Array; _crypto_hash_sha256_statebytes(): number; _free(address: number): void } }).libsodium
    const address = state as unknown as number
    raw.HEAPU8.fill(0, address, address + raw._crypto_hash_sha256_statebytes()); raw._free(address)
    throw error
  }
}
export async function validateWorkspaceSnapshot(snapshot: WorkspaceSnapshot, retainEdges?: (edges: WorkspaceRetentionEdges) => void, checkpoint?: () => Promise<void>): Promise<void> {
  snapshotMetadata(snapshot)
  if (snapshot.version !== 1 && snapshot.historicalEvidence && !historicalReaders.has(snapshot)) throw new Error('Historical evidence requires an owned snapshot reader')
  if (snapshot.version === 3) {
    const compact = compactMetadata.get(snapshot)!
    const budget = catalogExpansionBudget()
    for (const catalog of compact.metadata.state.planner.catalogs) {
      if (catalog.kind === 'retained-catalog-reference') await resolveRetainedCatalog(catalog, compact.registry, budget.reserve)
      else budget.inline(catalog.snapshot)
    }
  }
  await validateWorkspaceSnapshotV1(snapshot.version === 3 ? compactDomainProjection(snapshot) : projectWorkspaceSnapshotV1(snapshot), undefined, retainEdges, checkpoint ?? (owners.has(snapshot) ? () => assertOwnedWorkspaceSnapshot(snapshot) : undefined))
}
// Frozen complete-backup v1 admission includes recursive native/domain validation, not only the header
// Preserve this route and its dependencies when evolving current formats: closure.ts, validation.ts,
// file-schemas.ts, planner-journal.ts, documents.ts, document-codec.ts, domain-closure.ts,
// interchange/native.ts and native-schema.ts, and persistence/local-data.ts
// Parsers validate without replacing decoded values: key order binds sourceEvidence.projectedDigest
export async function validateWorkspaceSnapshotV1(snapshot: WorkspaceSnapshotV1, bodyValidation?: WorkspaceBodyValidation, retainEdges?: (edges: WorkspaceRetentionEdges) => void, checkpoint?: () => Promise<void>): Promise<void> {
  const { state: _state, ...header } = snapshot
  SnapshotHeaderSchema.parse(header)
  await validateWorkspaceClosure(snapshot.state, bodyValidation, retainEdges)
  if (!snapshot.sourceEvidence) return
  const declared = new Map(snapshot.state.blobs.map(blob => [blobIdentity(blob.ref), blob]))
  const annex = snapshot.sourceEvidence
  const keys = new Set<string>(), used = new Set<string>()
  const current = new Map(splitWorkspace(snapshot.state).map(document => [document.key, document]))
  const inspectedUnits = await inspectWorkspaceClosures(snapshot.state, annex.units.map(unit => unit.closure))
  for (const [index, unit] of annex.units.entries()) {
    if (keys.has(unit.key)) throw new Error('Duplicate current-unit evidence')
    keys.add(unit.key)
    const projected = current.get(unit.key)
    if (!projected || await backupWorkspaceDocumentDigest(projected, checkpoint) !== unit.projectedDigest) throw new Error('Current-unit evidence has a foreign projected association')
    const inspected = inspectedUnits[index]!
    if (inspected.root.key !== unit.key) throw new Error('Current-unit evidence key mismatch')
    const semantic = (value: unknown) => {
      if (projected.kind !== 'playthrough') return value
      const original = value as { metadata: Record<string, unknown> }
      const { revision: _revision, updatedAt: _updatedAt, ...metadata } = original.metadata
      return { ...original, metadata }
    }
    // Only the format owner's deep-immutable identity proves equality without traversal
    // Distinct or merely caller-frozen values still require the complete semantic comparison
    const sameCatalog = projected.kind === 'catalog' && inspected.value === projected.value && isImmutableCatalogSnapshot(inspected.value as CatalogSnapshot)
    if (!sameCatalog && !jsonEqual(semantic(inspected.value), semantic(projected.value))) throw new Error('Current-unit evidence differs from its projected logical record')
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

// Only this validating reader can register compact metadata; a hydrated object or shallow freeze grants no authority
export async function readCompactSnapshot(input: unknown, bodies: WorkspaceState['blobs'], catalogBodies: WorkspaceState['blobs'], owner: SnapshotOwner, flat = false): Promise<WorkspaceSnapshotV3> {
  const raw = structuredClone(input) as SnapshotMetadataV3
  const { state, ...header } = raw
  SnapshotHeaderV3Schema.parse(header)
  if (flat && raw.historicalEvidence !== undefined) throw new Error('Nested compact historical evidence is unsupported')
  const { catalogs, registry } = await hydrateStoredCatalogs(state.planner.catalogs, raw.catalogBodies, catalogBodies, owner.check)
  const native = new Map(bodies.map(body => [blobIdentity(body.ref), body]))
  const hydrated: WorkspaceSnapshotV3 = { ...raw, state: { ...state, planner: { ...state.planner, catalogs }, blobs: state.blobs.map(ref => {
    const body = native.get(blobIdentity(ref))
    if (!body || !sameCatalogBodyRef(ref, body.ref)) throw new Error('Compact native body association mismatch')
    return { ref, content: { byteLength: body.content.byteLength, async *open() {
      await owner.check()
      for await (const bytes of body.content.open()) { await owner.check(); yield bytes; await owner.check() }
      await owner.check()
    } } }
  }) } }
  await owner.check()
  await validateWorkspaceSnapshotV1(compactDomainProjection(hydrated), undefined, undefined, owner.check)
  await owner.check()
  const snapshot = ownWorkspaceSnapshot(hydrated, owner)
  const freeze = (value: unknown): void => { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return; for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  freeze(raw)
  compactMetadata.set(snapshot, { metadata: raw, registry })
  return snapshot
}

// This projection exists only for domain admission, never for export or new historical identity
function compactDomainProjection(snapshot: WorkspaceSnapshotV3): WorkspaceSnapshotV1 {
  const { catalogBodies: _catalogBodies, historicalEvidence: _history, ...flat } = snapshot
  return { ...flat, version: 1 }
}
