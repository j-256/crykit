import { z } from 'zod'
import { OpaqueIdSchema } from '../account/protocol'

export const SigninDecisionSchema = z.strictObject({
  version: z.literal(1), kind: z.literal('signin-decision'), accountId: OpaqueIdSchema,
  source: z.strictObject({ revisionVector: z.record(z.string(), z.string()), metadataDigest: z.string() }).nullable(),
  action: z.enum(['merge', 'account', 'device', 'latest']), operationId: OpaqueIdSchema,
  copyId: OpaqueIdSchema.optional(), cleanupPending: z.boolean().optional(), status: z.enum(['preparing', 'complete', 'cancelled']),
}).refine(value => value.action === 'merge' ? !!value.copyId && !!value.source : value.copyId === undefined)
export type SigninDecision = z.infer<typeof SigninDecisionSchema>
