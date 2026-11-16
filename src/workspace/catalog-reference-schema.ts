import { z } from 'zod'
import { maxDocumentBytes } from '../account/protocol'
import { NativeCatalogSnapshotSchema } from '../interchange/native-schema'
import { WorkspaceBlobRefSchema } from './file-schemas'
import { INDEX_PAGE_BYTES } from './directory'

export const WORKSPACE_SNAPSHOT_CATALOG_VERSION = 3
export const INHERITED_CATALOG_EVIDENCE_VERSION = 2
const CATALOG_FRAME_PREFIX_BYTES = new TextEncoder().encode('CRYKIT-DOC/1\n').byteLength + Uint32Array.BYTES_PER_ELEMENT
const MAX_CATALOG_FRAME_BYTES = maxDocumentBytes + INDEX_PAGE_BYTES + CATALOG_FRAME_PREFIX_BYTES
export const CatalogBodyRefSchema = WorkspaceBlobRefSchema.extend({ encoding: z.literal('bytes'), byteLength: z.number().int().positive().max(MAX_CATALOG_FRAME_BYTES) })
export const RetainedCatalogReferenceSchema = z.strictObject({ version: z.literal(1), kind: z.literal('retained-catalog-reference'), catalogId: NativeCatalogSnapshotSchema.shape.id, catalogRevisionId: NativeCatalogSnapshotSchema.shape.revisionId, checksum: z.string().min(1), schemaVersion: z.string().min(1), body: CatalogBodyRefSchema, codec: z.literal('catalog-document-v1') })
export const StoredCatalogSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('inline-catalog'), snapshot: NativeCatalogSnapshotSchema }), RetainedCatalogReferenceSchema])
export type StoredCatalog = z.infer<typeof StoredCatalogSchema>
export type RetainedCatalogReference = z.infer<typeof RetainedCatalogReferenceSchema>
