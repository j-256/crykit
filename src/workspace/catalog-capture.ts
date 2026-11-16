import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { sourcePayloadValid } from '../domain/source-fulfillment'
import { equalMetadataStreams, metadataSource, registerCatalogBackupEvidence } from '../interchange/workspace-backup-evidence'
import { hashBlob } from './blobs'
import { workspaceDocumentSource } from './document-codec'
import { privateRecordKey, type WorkspaceState } from './documents'
import { assertOwnedWorkspaceSnapshot, disposeWorkspaceSnapshot, readCompactSnapshot, snapshotMetadata, validateWorkspaceSnapshot, type SnapshotMetadataV3, type WorkspaceSnapshotV3, type WorkspaceSnapshotV1 } from './snapshot'
import type { StoredCatalog } from './catalog-reference-schema'

import { compactCatalogWritersEnabled } from './catalog-writer-capability'
export { compactCatalogWritersEnabled } from './catalog-writer-capability'

export async function captureCompactCatalogSnapshot(source: WorkspaceSnapshotV1): Promise<WorkspaceSnapshotV1 | WorkspaceSnapshotV3> {
  if (!compactCatalogWritersEnabled()) return source
  await assertOwnedWorkspaceSnapshot(source)
  await validateWorkspaceSnapshot(source)
  const catalogs: StoredCatalog[] = [], bodies: WorkspaceState['blobs'][number][] = []
  for (const catalog of source.state.planner.catalogs) {
    const bundled = BUNDLED_CATALOGS.find(value => value.id === catalog.id && value.revisionId === catalog.revisionId && value.checksum === catalog.checksum && value.schemaVersion === catalog.schemaVersion)
    if (!bundled) { catalogs.push({ kind: 'inline-catalog', snapshot: catalog as never }); continue }
    if (!sourcePayloadValid(catalog)) throw new Error('Invalid compact capture source')
    const frame = (value: typeof catalog) => workspaceDocumentSource({ version: 1, kind: 'catalog', key: privateRecordKey('catalog', value.id, value.revisionId), value: value as never })
    const content = frame(catalog)
    // A matching pin/checksum is insufficient: metadata and complete encoded representation also bind identity
    if (!await equalMetadataStreams(content, frame(bundled))) throw new Error('Packaged catalog frame differs from the exact bundled body')
    const sha256 = await hashBlob(content)
    const body = { documentId: `retained-catalog:${sha256}`, revisionId: sha256, sha256, byteLength: content.byteLength, encoding: 'bytes' as const }
    bodies.push({ ref: body, content })
    catalogs.push({ version: 1, kind: 'retained-catalog-reference', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, checksum: catalog.checksum, schemaVersion: catalog.schemaVersion, body, codec: 'catalog-document-v1' })
    await assertOwnedWorkspaceSnapshot(source)
  }
  const previous = snapshotMetadata(source)
  const raw: SnapshotMetadataV3 = { ...previous, version: 3, catalogBodies: bodies.map(body => body.ref), state: { ...previous.state, planner: { ...previous.state.planner, catalogs } } }
  const snapshot = await readCompactSnapshot(raw, source.state.blobs, bodies, { check: () => assertOwnedWorkspaceSnapshot(source), dispose: () => disposeWorkspaceSnapshot(source) })
  const guard = (content: import('./documents').BlobSource) => ({ byteLength: content.byteLength, async *open() { await assertOwnedWorkspaceSnapshot(source); for await (const bytes of content.open()) { await assertOwnedWorkspaceSnapshot(source); yield bytes; await assertOwnedWorkspaceSnapshot(source) } await assertOwnedWorkspaceSnapshot(source) } })
  // V1 owns exactly state.blobs; asking for backup evidence would encode an unused expanded current stream
  registerCatalogBackupEvidence(snapshot, { current: guard(metadataSource(snapshotMetadata(snapshot))), historical: new Map(), blobs: source.state.blobs, catalogBodies: bodies.map(body => ({ ref: body.ref, content: guard(body.content) })) })
  return snapshot
}
