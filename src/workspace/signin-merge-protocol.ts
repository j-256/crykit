import { z } from 'zod'
import { OpaqueIdSchema, RevisionDescriptorSchema } from '../account/protocol'
import { CipherRefSchema } from './account-cache'
import { GuestManagedManifestSchema } from './guest-managed-contract'
import { PreviewSchema } from './guest-copy-journal'

// These worker resource limits are independent of persisted-format and account capacity limits
export const SIGNIN_MERGE_LIMITS = Object.freeze({ manifestBytes: 4 * 1024 * 1024, records: 8192, observationBytes: 128 * 1024 * 1024 })
const resourceFailures = new WeakMap<Error, SigninMergeResourceFailure>()
// Only this real guard associates measured values with an error; matching public text grants no observation
export function signinMergeResourceFailure(error: unknown): SigninMergeResourceFailure | undefined { return error instanceof Error ? resourceFailures.get(error) : undefined }
export function assertSigninMergeBudget(manifestBytes: number, records: number, observationBytes: number): void {
  const values = [manifestBytes, records, observationBytes], dimensions = ['manifestBytes', 'records', 'observationBytes'] as const
  for (const [index, value] of values.entries()) {
    const dimension = dimensions[index], limit = SIGNIN_MERGE_LIMITS[dimension]
    if (!Number.isSafeInteger(value) || value < 0 || value > limit) {
      const error = new Error('SIGNIN_MERGE_RESOURCE_LIMIT')
      // Invalid counters remain unavailable; zero placeholders in other dimensions are not totals
      if (Number.isSafeInteger(value) && value > limit) resourceFailures.set(error, Object.freeze({ dimension, value, limit, basis: dimension === 'records' ? 'record-cardinality' : 'counted-byte-prefix', ...(dimension === 'observationBytes' && Number.isSafeInteger(records) && records > 0 ? { records } : {}) }) as SigninMergeResourceFailure)
      throw error
    }
  }
}
export const SIGNIN_MERGE_ERRORS = Object.freeze(['SIGNIN_MERGE_RESOURCE_LIMIT', 'SIGNIN_COORDINATION_UNAVAILABLE', 'SIGNIN_SOURCE_CHANGED', 'LOCAL_REVISION_CONFLICT', 'SIGNIN_RECEIPT_MISMATCH', 'SIGNIN_MAPPING_REQUIRED', 'SIGNIN_PREPARATION_FAILED'] as const)
export const MergeCipherRecordSchema = z.strictObject({ revisionId: OpaqueIdSchema, payloadId: OpaqueIdSchema, descriptor: RevisionDescriptorSchema })
const row = z.strictObject({ id: z.string().min(1).max(256), ref: CipherRefSchema })
export const MergeAccountFenceSchema = z.strictObject({ key: z.literal('active'), headRevision: z.number().int().nonnegative().safe(), head: CipherRefSchema })
export const SigninMergeLocatorSchema = z.strictObject({ databaseName: z.string().min(1).max(256), manifest: GuestManagedManifestSchema })
export const SigninMergeFenceSchema = z.strictObject({ selected: MergeAccountFenceSchema, projection: row, epoch: z.number().int().nonnegative().safe(), heads: z.array(CipherRefSchema).max(SIGNIN_MERGE_LIMITS.records) })
export const MergeSourceIdentitySchema = z.strictObject({ revisionVector: z.record(z.string(), z.string()), metadataDigest: z.string().regex(/^[a-f0-9]{64}$/) })
export const SigninMergeReviewSchema = z.strictObject({ handle: z.string().uuid(), preview: PreviewSchema })
export const SigninMergeTicketSchema = z.strictObject({ version: z.literal(1), operationId: OpaqueIdSchema, copyId: OpaqueIdSchema, manifest: MergeCipherRecordSchema })
export const SigninMergeManifestSchema = z.strictObject({
  version: z.literal(1), kind: z.literal('signin-merge-manifest'), accountId: OpaqueIdSchema, operationId: OpaqueIdSchema, copyId: OpaqueIdSchema,
  source: SigninMergeLocatorSchema, sourceIdentity: MergeSourceIdentitySchema, destination: SigninMergeFenceSchema, previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  journal: CipherRefSchema, journalTarget: CipherRefSchema, selectedTarget: CipherRefSchema, intent: CipherRefSchema,
  intentStatus: z.enum(['unmapped-local', 'mapped-local']),
  mappingOrigin: row.optional(),
  output: z.array(MergeCipherRecordSchema).max(SIGNIN_MERGE_LIMITS.records),
  consumed: z.array(MergeCipherRecordSchema).max(SIGNIN_MERGE_LIMITS.records),
  sourceRoots: z.array(CipherRefSchema).max(SIGNIN_MERGE_LIMITS.records),
  sourceRows: z.array(z.strictObject({ id: z.string().min(1).max(256), expected: row.nullable() })).max(SIGNIN_MERGE_LIMITS.records),
})
export type SigninMergeLocator = z.infer<typeof SigninMergeLocatorSchema>
export type SigninMergeFence = z.infer<typeof SigninMergeFenceSchema>
export type SigninMergeManifest = z.infer<typeof SigninMergeManifestSchema>
export type SigninMergeTicket = z.infer<typeof SigninMergeTicketSchema>
export type SigninMergeReviewResult = z.infer<typeof SigninMergeReviewSchema>
const workCount = z.number().int().nonnegative().safe()
export const SigninMergeResourceFailureSchema = z.discriminatedUnion('dimension', [
  z.strictObject({ dimension: z.literal('manifestBytes'), value: workCount, limit: z.literal(SIGNIN_MERGE_LIMITS.manifestBytes), basis: z.literal('counted-byte-prefix') }),
  z.strictObject({ dimension: z.literal('records'), value: workCount, limit: z.literal(SIGNIN_MERGE_LIMITS.records), basis: z.literal('record-cardinality') }),
  z.strictObject({ dimension: z.literal('observationBytes'), value: workCount, limit: z.literal(SIGNIN_MERGE_LIMITS.observationBytes), basis: z.literal('counted-byte-prefix'), records: workCount.positive().max(SIGNIN_MERGE_LIMITS.records).optional() }),
]).refine(value => value.value > value.limit, 'A numeric resource refusal must exceed its unchanged limit')
export type SigninMergeResourceFailure = z.infer<typeof SigninMergeResourceFailureSchema>
export const SigninMergeProgressSchema = z.strictObject({ stage: z.enum(['reading-source', 'comparing-records', 'preparing-merge']),
  observations: z.discriminatedUnion('status', [z.strictObject({ status: z.literal('complete'), records: workCount, bytes: workCount }), z.strictObject({ status: z.literal('failed') })]).optional(),
  codec: z.strictObject({ encodedOutputBytes: workCount.optional(), decodedInputBytes: workCount.optional() }).optional(),
  resourceFailure: SigninMergeResourceFailureSchema.optional(),
})
export type SigninMergeProgress = z.infer<typeof SigninMergeProgressSchema>
export type SigninMergeCommand =
  | { readonly kind: 'review'; readonly operationId: string; readonly locator: SigninMergeLocator; readonly fence: SigninMergeFence }
  | { readonly kind: 'prepare'; readonly operationId: string; readonly handle: string }
  | { readonly kind: 'release'; readonly operationId: string }

const MANIFEST_JSON_DEPTH_LIMIT = 64

// Count JSON punctuation, escaping, and UTF-8 before allocating its contiguous plaintext buffer
// This is a transient structural manifest encoder, not a persisted native/token codec
export function encodeSigninMergeManifest(value: unknown): Uint8Array {
  let length = 0
  const reserve = (bytes: number) => { length += bytes; assertSigninMergeBudget(length, 0, 0) }
  const stringBytes = (value: string) => {
    if (value.length + 2 > SIGNIN_MERGE_LIMITS.manifestBytes) throw new Error('SIGNIN_MERGE_RESOURCE_LIMIT')
    let bytes = 2
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) bytes += 2
      else if (code < 32) bytes += 6
      else if (code < 128) bytes++
      else if (code < 2048) bytes += 2
      else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++ }
      else if (code >= 0xd800 && code <= 0xdfff) bytes += 6
      else bytes += 3
      if (bytes > SIGNIN_MERGE_LIMITS.manifestBytes) throw new Error('SIGNIN_MERGE_RESOURCE_LIMIT')
    }
    return bytes
  }
  const visit = (value: unknown, depth: number) => {
    if (depth > MANIFEST_JSON_DEPTH_LIMIT) throw new Error('SIGNIN_MERGE_RESOURCE_LIMIT')
    if (value === null) reserve(4)
    else if (typeof value === 'string') reserve(stringBytes(value))
    else if (typeof value === 'boolean') reserve(value ? 4 : 5)
    else if (typeof value === 'number' && Number.isFinite(value)) reserve(String(value).length)
    else if (Array.isArray(value)) { reserve(2 + Math.max(0, value.length - 1)); for (const child of value) visit(child ?? null, depth + 1) }
    else if (value && typeof value === 'object') {
      const entries = Object.entries(value).filter(([, child]) => child !== undefined)
      reserve(2 + Math.max(0, entries.length - 1))
      for (const [key, child] of entries) { reserve(stringBytes(key) + 1); visit(child, depth + 1) }
    } else throw new Error('SIGNIN_RECEIPT_MISMATCH')
  }
  visit(value, 0)
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  if (bytes.length !== length) { bytes.fill(0); throw new Error('SIGNIN_RECEIPT_MISMATCH') }
  return bytes
}
