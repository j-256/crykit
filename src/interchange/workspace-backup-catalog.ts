import { SnapshotHeaderV3Schema } from './workspace-backup-schema'
import { compareBackupRefs, historicalMetadataIdentity, readBackupMetadata, attachBackupBodies, registerBackupMetadata, registerCatalogBackupEvidence, type BackupDocument, type SnapshotMetadataV1 } from './workspace-backup-evidence'
import { readCompactSnapshot, registerHistoricalSnapshotReader, ownWorkspaceSnapshot, validateWorkspaceSnapshotV1, vectorDigest, type SnapshotMetadataV3, type WorkspaceSnapshotV3, type SnapshotOwner } from '../workspace/snapshot'
import { blobIdentity, hashBlob, memoryBlob } from '../workspace/blobs'
import { sameCatalogBodyRef } from '../workspace/catalog-reference'
import type { WorkspaceState } from '../workspace/documents'
import type { createBackupStaging } from '../workspace/backup-staging'

export type HistoricalMemberFormat = 'legacy-v1' | 'compact-v2'
export const historicalMemberKey = (member: { format: HistoricalMemberFormat; id: string }) => `${member.format}:${member.id}`
const COMPACT_ID_DOMAIN = new TextEncoder().encode('crykit/historical-snapshot/v2\0')
export async function compactHistoricalIdentity(content: import('../workspace/documents').BlobSource): Promise<string> {
  return hashBlob({ byteLength: COMPACT_ID_DOMAIN.length + content.byteLength, async *open() { yield COMPACT_ID_DOMAIN; yield* content.open() } })
}
export async function catalogEvidenceSetDigest(members: readonly { format: HistoricalMemberFormat; id: string }[]): Promise<string> {
  const keys = members.map(historicalMemberKey)
  if (keys.some((key, index) => index > 0 && keys[index - 1] >= key)) throw new Error('Unsorted or duplicate mixed historical members')
  return hashBlob(memoryBlob(new TextEncoder().encode(`crykit/inherited-snapshot-set/v2\0${JSON.stringify(keys)}`)))
}

// Manifest, chain and EOF checks must precede this reader; every role is admitted independently
// Native originals never satisfy retained catalog registry edges, even when their refs happen to match
export async function finishCatalogSnapshot(current: import('../workspace/documents').BlobSource, documents: readonly BackupDocument[], staging: Awaited<ReturnType<typeof createBackupStaging>>, expectedVector: string, signal?: AbortSignal): Promise<WorkspaceSnapshotV3> {
  const raw = await readBackupMetadata(current) as SnapshotMetadataV3
  const { state: _state, ...header } = raw
  SnapshotHeaderV3Schema.parse(header)
  if (expectedVector !== await vectorDigest(raw.revisionVector)) throw new Error('Backup revision vector mismatch')
  const members = raw.historicalEvidence?.snapshots ?? []
  await catalogEvidenceSetDigest(members)
  const nativeRefs = raw.historicalEvidence?.blobs ?? raw.state.blobs
  const catalogRefs = raw.historicalEvidence?.catalogBodies ?? raw.catalogBodies
  if (documents.length !== members.length + nativeRefs.length + catalogRefs.length) throw new Error('Incomplete compact backup registry')
  const historical = new Map<string, BackupDocument>()
  for (const [index, member] of members.entries()) {
    const document = documents[index]
    if (document.key !== `historical:${historicalMemberKey(member)}` || document.encoding !== 'deflate-json-tokens-v1' || historical.has(member.id)) throw new Error('Historical catalog association mismatch')
    historical.set(member.id, document)
  }
  let offset = members.length
  const registry = (refs: readonly import('../workspace/documents').WorkspaceBlobRef[], prefix: string): WorkspaceState['blobs'] => {
    if (new Set(refs.map(blobIdentity)).size !== refs.length) throw new Error('Duplicate compact body registry entry')
    return refs.map((ref, index) => {
      const document = documents[offset++]
      if (raw.historicalEvidence && index > 0 && compareBackupRefs(refs[index - 1], ref) >= 0 || document.encoding !== 'bytes' || document.key !== `${prefix}${blobIdentity(ref)}` || document.content.byteLength !== ref.byteLength) throw new Error('Invalid compact body registry')
      return { ref, content: document.content }
    })
  }
  const native = registry(nativeRefs, ''), catalogs = registry(catalogRefs, 'catalog-body:')
  let disposed = false, active = false
  const owner: SnapshotOwner = { async check() { signal?.throwIfAborted(); if (disposed) throw new Error('Backup snapshot was released') }, async dispose() { disposed = true; await staging.dispose() } }
  const usedNative = new Set<string>(), usedCatalog = new Set<string>()
  const note = (value: { state: { blobs: readonly import('../workspace/documents').WorkspaceBlobRef[] }; catalogBodies?: readonly import('../workspace/documents').WorkspaceBlobRef[] }) => {
    for (const ref of value.state.blobs) usedNative.add(blobIdentity(ref))
    for (const ref of value.catalogBodies ?? []) usedCatalog.add(blobIdentity(ref))
  }
  const open = async (member: typeof members[number], childOwner: SnapshotOwner) => {
    const document = historical.get(member.id)!
    await childOwner.check()
    const id = member.format === 'legacy-v1' ? (await historicalMetadataIdentity(document.content)).id : await compactHistoricalIdentity(document.content)
    if (id !== member.id) throw new Error('Historical catalog identity mismatch')
    const value = await readBackupMetadata(document.content)
    if (member.format === 'compact-v2') {
      const child = await readCompactSnapshot(value, native, catalogs, childOwner, true)
      note(value as SnapshotMetadataV3)
      registerCatalogBackupEvidence(child, { current: guardSource(document.content, childOwner.check), historical: new Map(), blobs: child.state.blobs, catalogBodies: child.catalogBodies.map(ref => ({ ref, content: guardSource(catalogs.find(body => sameCatalogBodyRef(body.ref, ref))!.content, childOwner.check) })) })
      return child
    }
    const legacy = attachBackupBodies(value as SnapshotMetadataV1, new Map(native.map(body => [blobIdentity(body.ref), body])))
    await validateWorkspaceSnapshotV1(legacy)
    note(value as SnapshotMetadataV1)
    const guard = (source: import('../workspace/documents').BlobSource) => guardSource(source, childOwner.check)
    const child = ownWorkspaceSnapshot({ ...legacy, state: { ...legacy.state, blobs: legacy.state.blobs.map(body => ({ ref: body.ref, content: guard(body.content) })) } }, childOwner)
    registerBackupMetadata(child, guard(document.content))
    await childOwner.check()
    return child
  }
  const snapshot = await readCompactSnapshot(raw, native, catalogs, owner)
  note(raw)
  for (const member of members) await open(member, { check: owner.check, async dispose() {} })
  if (usedNative.size !== native.length || usedCatalog.size !== catalogs.length) throw new Error('Orphan compact backup body')
  // Current subset must resolve against the aggregate as exact refs, never by matching digest alone
  for (const ref of raw.catalogBodies) if (!catalogs.some(body => sameCatalogBodyRef(body.ref, ref))) throw new Error('Current catalog body is absent from aggregate')
  registerHistoricalSnapshotReader(snapshot, async id => {
    await owner.check()
    if (active) throw new Error('Release the open historical snapshot before opening another')
    const member = members.find(member => member.id === id)
    if (!member) throw new Error('Unknown historical snapshot')
    active = true
    let released = false
    const check = async () => { await owner.check(); if (released) throw new Error('Historical snapshot was released') }
    try { return await open(member, { check, async dispose() { if (!released) { released = true; active = false } } }) }
    catch (error) { active = false; throw error }
  })
  registerCatalogBackupEvidence(snapshot, { current: guardSource(current, owner.check), historical: new Map([...historical].map(([id, document]) => [id, guardSource(document.content, owner.check)])), blobs: native.map(body => ({ ref: body.ref, content: guardSource(body.content, owner.check) })), catalogBodies: catalogs.map(body => ({ ref: body.ref, content: guardSource(body.content, owner.check) })) })
  await owner.check()
  return snapshot
}

function guardSource(source: import('../workspace/documents').BlobSource, check: () => Promise<void>): import('../workspace/documents').BlobSource {
  return { byteLength: source.byteLength, async *open() { await check(); for await (const bytes of source.open()) { await check(); yield bytes; await check() } await check() } }
}
