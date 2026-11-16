import { assertActiveProfile, currentProfileToken, type ProfileToken } from '../account/profile'
import type { WorkspaceRetentionEdges } from './closure'
import { hashBlob } from './blobs'
import type { WorkspaceBlobRef } from './documents'
import { assertOwnedWorkspaceSnapshot, backupMetadataDigest, snapshotMetadata, validateWorkspaceSnapshot, type WorkspaceSnapshot } from './snapshot'

declare const scopeBrand: unique symbol
declare const admissionBrand: unique symbol
export interface MergeOperationScope { readonly [scopeBrand]: true; dispose(): void }
export interface WorkspaceMetadataAdmission { readonly [admissionBrand]: true }
interface ScopeOwner { readonly token: ProfileToken; readonly generation: number; readonly signal: AbortSignal; readonly checkCurrent: () => Promise<void>; readonly admissions: WeakMap<WorkspaceSnapshot, WorkspaceMetadataAdmission>; disposed: boolean }
export interface WorkspaceMetadataFacts {
  readonly identity: { readonly revisionVector: Readonly<Record<string, string>>; readonly metadataDigest: string }
  readonly retentionEdges: readonly (readonly [string, readonly WorkspaceBlobRef[]])[]
}
interface AdmissionOwner { readonly snapshot: WorkspaceSnapshot; readonly scope: MergeOperationScope; readonly facts: WorkspaceMetadataFacts; readonly bodies: readonly { readonly content: WorkspaceSnapshot['state']['blobs'][number]['content']; readonly open: WorkspaceSnapshot['state']['blobs'][number]['content']['open']; readonly byteLength: number }[] }
const scopes = new WeakMap<MergeOperationScope, ScopeOwner>()
const admissions = new WeakMap<WorkspaceMetadataAdmission, AdmissionOwner>()

export function createMergeOperationScope(token: ProfileToken, signal: AbortSignal, checkCurrent: () => Promise<void>): MergeOperationScope {
  assertActiveProfile(token); signal.throwIfAborted()
  if (currentProfileToken() !== token) throw new Error('Foreign merge profile token')
  const owner: ScopeOwner = { token, generation: token.generation, signal, checkCurrent, admissions: new WeakMap(), disposed: false }
  const scope = Object.freeze({ dispose() { owner.disposed = true } }) as MergeOperationScope
  scopes.set(scope, owner)
  return scope
}
async function checkScope(scope: MergeOperationScope): Promise<ScopeOwner> {
  const owner = scopes.get(scope)
  const check = () => {
    if (!owner || owner.disposed || owner.token.generation !== owner.generation) throw new Error('Merge operation was released')
    owner.signal.throwIfAborted(); assertActiveProfile(owner.token)
    if (currentProfileToken() !== owner.token) throw new Error('Foreign merge profile token')
  }
  check(); await owner!.checkCurrent(); check()
  return owner!
}
export async function assertMetadataAdmission(admission: WorkspaceMetadataAdmission, snapshot: WorkspaceSnapshot, scope: MergeOperationScope): Promise<void> {
  const owner = admissions.get(admission)
  if (!owner || owner.snapshot !== snapshot || owner.scope !== scope) throw new Error('Foreign workspace metadata admission')
  await checkScope(scope); await assertOwnedWorkspaceSnapshot(snapshot); await checkScope(scope)
  for (const [index, body] of owner.bodies.entries()) {
    const current = snapshot.state.blobs[index]
    if (current.content !== body.content || current.content.open !== body.open || current.content.byteLength !== body.byteLength || body.byteLength !== current.ref.byteLength) throw new Error('Workspace body reader changed')
  }
}
// Admission owns immutable conclusions, never a reusable successful storage read
// Every contributing body is hashed again before those conclusions can authorize work
export async function validateSnapshotBodies(admission: WorkspaceMetadataAdmission): Promise<void> {
  const owner = admissions.get(admission)
  if (!owner) throw new Error('Foreign workspace metadata admission')
  await assertMetadataAdmission(admission, owner.snapshot, owner.scope)
  for (const blob of owner.snapshot.state.blobs) {
    if (await hashBlob(blob.content) !== blob.ref.sha256) throw new Error('Workspace blob digest mismatch')
    await checkScope(owner.scope)
  }
  await assertMetadataAdmission(admission, owner.snapshot, owner.scope)
}
export async function admitWorkspaceMetadata(snapshot: WorkspaceSnapshot, scope: MergeOperationScope): Promise<WorkspaceMetadataAdmission> {
  const owner = await checkScope(scope)
  await assertOwnedWorkspaceSnapshot(snapshot)
  const previous = owner.admissions.get(snapshot)
  if (previous) { await assertMetadataAdmission(previous, snapshot, scope); return previous }
  const bodies = snapshot.state.blobs.map(({ content }) => ({ content, open: content.open, byteLength: content.byteLength }))
  let edges: WorkspaceRetentionEdges | undefined
  await validateWorkspaceSnapshot(snapshot, validated => { edges = validated })
  if (!edges) throw new Error('Workspace graph admission did not complete')
  const metadata: Record<string, unknown> = { ...snapshotMetadata(snapshot) }
  // Only the capture envelope is transient; nested originals, ordering and provenance remain identity
  delete metadata.snapshotId; delete metadata.capturedAt
  const facts: WorkspaceMetadataFacts = Object.freeze({
    identity: Object.freeze({ revisionVector: Object.freeze(Object.fromEntries(Object.entries(snapshot.revisionVector).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))), metadataDigest: await backupMetadataDigest(metadata) }),
    retentionEdges: Object.freeze([...edges].map(([key, refs]) => Object.freeze([key, Object.freeze(refs.map(ref => Object.freeze({ ...ref })))] as const))),
  })
  const admission = Object.freeze({}) as WorkspaceMetadataAdmission
  admissions.set(admission, { snapshot, scope, facts, bodies })
  await assertMetadataAdmission(admission, snapshot, scope)
  owner.admissions.set(snapshot, admission)
  return admission
}
// Frozen tuple collections prevent callers from mutating a cached Map through a readonly cast
export async function metadataAdmissionFacts(admission: WorkspaceMetadataAdmission, snapshot: WorkspaceSnapshot, scope: MergeOperationScope): Promise<WorkspaceMetadataFacts> {
  await assertMetadataAdmission(admission, snapshot, scope)
  return admissions.get(admission)!.facts
}
