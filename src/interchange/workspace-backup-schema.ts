import { z } from 'zod'
import { WorkspaceBlobRefSchema, ClosureSchema } from '../workspace/file-schemas'

export const WORKSPACE_BACKUP_MAGIC = new TextEncoder().encode('CRYKIT-WORKSPACE/1\n')
export const WORKSPACE_BACKUP_VERSION = '1.0.0'
export const WORKSPACE_BACKUP_EVIDENCE_VERSION = '1.1.0'
export const WORKSPACE_BACKUP_LIMITS = Object.freeze({ payload: 4 * 1024 * 1024, metadata: 64 * 1024, depth: 64, frames: 1_000_000, bytes: 32 * 1024 ** 3 })
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const SourceEvidenceSchema = z.object({ version: z.literal(1), units: z.array(z.object({ key: z.string().min(1), source: z.object({ documentId: z.string().min(1), revisionId: z.string().min(1), digest }).strict(), projectedDigest: digest, closure: ClosureSchema }).strict()), blobs: z.array(WorkspaceBlobRefSchema) }).strict()
export const SnapshotHeaderSchema = z.object({ version: z.literal(1), snapshotId: z.string().min(1), capturedAt: z.string().min(1), revisionVector: z.record(z.string(), z.string()), sourceEvidence: SourceEvidenceSchema.optional() }).strict()
export const HistoricalEvidenceSchema = z.object({ version: z.literal(1), snapshots: z.array(z.object({ id: digest }).strict()), blobs: z.array(WorkspaceBlobRefSchema) }).strict()
export const SnapshotHeaderV2Schema = SnapshotHeaderSchema.extend({ version: z.literal(2), historicalEvidence: HistoricalEvidenceSchema })
export const BackupFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('content'), document: integer, key: z.string().min(1), encoding: z.enum(['deflate-json-tokens-v1', 'bytes']), schema: z.literal(1), chunk: integer, final: z.boolean(), length: integer.max(WORKSPACE_BACKUP_LIMITS.payload), digest }).strict(),
  z.object({ kind: z.literal('manifest'), format: z.literal('crykit-workspace-backup'), version: z.literal(WORKSPACE_BACKUP_VERSION), frames: integer.max(WORKSPACE_BACKUP_LIMITS.frames), bytes: integer.max(WORKSPACE_BACKUP_LIMITS.bytes), documents: integer, chain: digest, vector: digest }).strict(),
])
export const BackupManifestV2Schema = BackupFrameSchema.options[1].extend({ version: z.literal(WORKSPACE_BACKUP_EVIDENCE_VERSION) })
export type BackupManifestV2 = z.infer<typeof BackupManifestV2Schema>
export type BackupFrame = z.infer<typeof BackupFrameSchema>
export class WorkspaceBackupError extends Error {
  constructor(readonly code: 'SNAPSHOT_CHANGED' | 'BACKUP_INVALID' | 'BACKUP_RESOURCE_LIMIT' | 'BACKUP_DISPOSED' | 'UNSUPPORTED_VERSION', message: string) { super(message) }
}
