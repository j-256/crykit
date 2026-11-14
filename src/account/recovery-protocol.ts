import { z } from 'zod'
import { CommitRequestSchema, OpaqueIdSchema, RevisionDescriptorSchema, maxChangedHeads, maxCommitJsonBytes } from './protocol'

export const MAX_RECOVERY_POINTS = 3
export const MAX_RECOVERY_BYTES = 128 * 1024 * 1024
export const RECOVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
// Covers bounded publication guards and opaque control records in recovery admission
export const RECOVERY_CONTROL_BYTES = 16 * 1024
export const RECOVERY_REVISION_CONTROL_BYTES = 512
export const MAX_RECOVERY_RESPONSE_BYTES = MAX_RECOVERY_POINTS * (maxCommitJsonBytes + RECOVERY_CONTROL_BYTES)
const uint = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const RecoveryReserveSchema = z.strictObject({
  version: z.literal(1), operationId: OpaqueIdSchema,
  revisions: z.array(RevisionDescriptorSchema).min(1).max(maxChangedHeads).readonly(),
  reservedBytes: uint,
}).refine(input => input.revisions.every(r => r.parents.length === 0 && r.dependencies.length === 0)
  && new Set(input.revisions.map(r => r.revisionId)).size === input.revisions.length
  && new Set(input.revisions.map(r => r.uploadId)).size === input.revisions.length)
export type RecoveryReserve = z.infer<typeof RecoveryReserveSchema>
export const RecoveryBindingSchema = z.strictObject({
  version: z.literal(1), operationId: OpaqueIdSchema,
  publication: CommitRequestSchema,
  // Rebinding requires both a deliberate client reconciliation and server proof of supersession
  supersedesMutationId: OpaqueIdSchema.optional(),
}).refine(input => input.publication.expectedPublicationEpoch !== undefined && input.publication.heads.length > 0
  && input.publication.recoveryOperationId === input.operationId)
export type RecoveryBinding = z.infer<typeof RecoveryBindingSchema>
export const RecoveryPointSchema = z.strictObject({
  version: z.literal(1), operationId: OpaqueIdSchema, state: z.enum(['pending', 'completed']),
  sealed: z.boolean(), reservedBytes: uint, admittedBytes: uint,
  revisions: z.array(RevisionDescriptorSchema).min(1).max(maxChangedHeads).readonly(),
  createdAt: uint, completedAt: uint.nullable(), expiresAt: uint.nullable(),
  mutationId: OpaqueIdSchema.nullable(), acceptedAt: uint.nullable(),
}).refine(point => {
  if (point.admittedBytes < point.reservedBytes || (!point.sealed && (point.mutationId !== null || point.acceptedAt !== null))) return false
  if (point.acceptedAt !== null && point.mutationId === null) return false
  return point.state === 'pending'
    ? point.completedAt === null && point.expiresAt === null
    : point.sealed && point.acceptedAt !== null && point.completedAt === point.acceptedAt && point.expiresAt === point.acceptedAt + RECOVERY_RETENTION_MS
}, 'Recovery state must retain its exact accepted publication deadline')
export type RecoveryPoint = z.infer<typeof RecoveryPointSchema>
export const RecoveryListSchema = z.strictObject({ version: z.literal(1), points: z.array(RecoveryPointSchema).max(MAX_RECOVERY_POINTS) })
export const RecoveryRemovalSchema = z.strictObject({ version: z.literal(1), state: z.enum(['complete', 'pending', 'blocked']) })

export const RecoverySupersessionSchema = z.strictObject({
  version: z.literal(1), operationId: OpaqueIdSchema, mutationId: OpaqueIdSchema,
  successorOperationId: OpaqueIdSchema, successorMutationId: OpaqueIdSchema,
}).refine(input => input.operationId !== input.successorOperationId && input.mutationId !== input.successorMutationId)
export type RecoverySupersession = z.infer<typeof RecoverySupersessionSchema>
export const RecoverySupersessionReceiptSchema = z.strictObject({
  version: z.literal(1), operationId: OpaqueIdSchema, successorOperationId: OpaqueIdSchema, successorMutationId: OpaqueIdSchema,
})
