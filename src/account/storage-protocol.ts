import { z } from 'zod'
import { OpaqueIdSchema, maxDependencies } from './protocol'
const uint = z.number().int().nonnegative().safe()
export const AUTOSAVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const AUTOSAVE_RETAINED_VERSIONS = 20
export const StorageObservationSchema = z.strictObject({ version: z.literal(1), source: z.literal('application-database'), observedAt: uint, capacityBytes: uint, usedBytes: uint })
export const ServiceRecoverySchema = z.strictObject({ version: z.literal(1), state: z.enum(['paused', 'verified', 'unverified']), lastVerifiedAt: uint.nullable(), ageMs: uint.nullable(), code: z.string().regex(/^[A-Z0-9_]+$/).max(80).nullable() })
export const CleanupRefSchema = z.strictObject({ documentId: OpaqueIdSchema, revisionId: OpaqueIdSchema })
export const CleanupPreviewRequestSchema = z.strictObject({ version: z.literal(1), ref: CleanupRefSchema })
export const CleanupRequestSchema = CleanupPreviewRequestSchema.extend({ generation: OpaqueIdSchema, publicationEpoch: uint })
export const CleanupReasonSchema = z.enum(['protected', 'young', 'recent', 'current', 'referenced', 'work', 'scan', 'snapshot', 'borrow', 'unavailable', 'stale'])
export const CleanupPreviewSchema = CleanupRequestSchema.extend({ observedAt: uint, eligible: z.boolean(), reasons: z.array(CleanupReasonSchema).max(12), reclaimableBytes: uint, dependencies: z.array(CleanupRefSchema).max(maxDependencies) })
export const CleanupResultSchema = z.strictObject({ version: z.literal(1), state: z.enum(['blocked', 'pending', 'complete']), releasedBytes: uint })
export type CleanupRequest = z.infer<typeof CleanupRequestSchema>
export type CleanupPreview = z.infer<typeof CleanupPreviewSchema>
