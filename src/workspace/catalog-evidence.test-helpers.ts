import { SYNTHETIC_RETAINED_CATALOG } from '../domain/retained-catalog.test-helpers'
import type { CatalogSnapshot } from '../domain/types'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { createBlankLocalData } from '../domain/local-data'
import { metadataSource, historicalMetadataIdentity } from '../interchange/workspace-backup-evidence'
import { compactHistoricalIdentity } from '../interchange/workspace-backup-catalog'
import { hashBlob } from './blobs'
import { workspaceDocumentSource } from './document-codec'
import { privateRecordKey } from './documents'

export async function compactCatalogEvidenceFixture(nativeAlias = false, catalog: CatalogSnapshot = SYNTHETIC_RETAINED_CATALOG) {
  const localData = createBlankLocalData()
  const content = workspaceDocumentSource({ version: 1, kind: 'catalog', key: privateRecordKey('catalog', catalog.id, catalog.revisionId), value: catalog as never })
  const ref = { documentId: 'retained-source-frame', revisionId: 'exact-retained-revision', byteLength: content.byteLength, sha256: await hashBlob(content), encoding: 'bytes' as const }
  const reference = { version: 1 as const, kind: 'retained-catalog-reference' as const, catalogId: catalog.id, catalogRevisionId: catalog.revisionId, schemaVersion: catalog.schemaVersion, checksum: catalog.checksum, codec: 'catalog-document-v1' as const, body: ref }
  const raw = { version: 3 as const, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: 'compact-evidence', capturedAt: '2026-11-16', revisionVector: {}, catalogBodies: [ref], state: { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: [reference], sources: [], evidence: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], conflicts: [], retainedContent: [], libraryDefaults: { version: 1 as const, layers: [] }, blobs: nativeAlias ? [ref] : [] } }
  const metadata = metadataSource(raw)
  const { catalogBodies: _catalogBodies, ...legacyHeader } = raw
  const legacyRaw = { ...legacyHeader, version: 1 as const, state: { ...raw.state, planner: { ...raw.state.planner, catalogs: [catalog] } } }
  const legacyMetadata = metadataSource(legacyRaw)
  const legacy = { raw: legacyRaw, metadata: legacyMetadata, id: (await historicalMetadataIdentity(legacyMetadata)).id }
  return { raw, ref, content, metadata, id: await compactHistoricalIdentity(metadata), catalog, legacy }
}
