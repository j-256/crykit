import { z } from 'zod'
import { PUBLIC_SHARE_LIMITS, PublicEntityReceiptSchema, PublicSetupSchema } from './public-share-schema'
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const PublicSetupContextSchema = z.object({ version: z.literal(1), setup: PublicSetupSchema.refine(value => value.catalogLock !== undefined, 'The exact public lock is required') }).strict()
export const PublicCheckpointContextSchema = z.object({ version: z.literal(1), setupDigest: digest, receipts: z.array(PublicEntityReceiptSchema).max(PUBLIC_SHARE_LIMITS.receipts), personalBindings: z.array(z.object({ fingerprint: digest, ref: z.object({ kind: z.literal('personal'), definitionId: z.string().min(1).max(PUBLIC_SHARE_LIMITS.id) }).strict() }).strict()).max(PUBLIC_SHARE_LIMITS.receipts) }).strict()
export type PublicSetupContext = z.infer<typeof PublicSetupContextSchema>
export type PublicCheckpointContext = z.infer<typeof PublicCheckpointContextSchema>
