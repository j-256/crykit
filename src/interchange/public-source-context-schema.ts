import { z } from 'zod'
import { PUBLIC_SHARE_LIMITS, PublicEntityReceiptSchema, PublicEntityReceiptV1Schema, PublicSetupSchema } from './public-share-schema'
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const PublicSetupContextSchema = z.object({ version: z.literal(1), setup: PublicSetupSchema.refine(value => value.catalogLock !== undefined, 'The exact public lock is required') }).strict()
// Complete v1 receipts keep their historical acceptance; nullable catalog metadata has an explicit persisted version
export const PublicCheckpointContextV1Schema = z.object({ version: z.literal(1), setupDigest: digest, receipts: z.array(PublicEntityReceiptV1Schema).max(PUBLIC_SHARE_LIMITS.receipts), personalBindings: z.array(z.object({ fingerprint: digest, ref: z.object({ kind: z.literal('personal'), definitionId: z.string().min(1).max(PUBLIC_SHARE_LIMITS.id) }).strict() }).strict()).max(PUBLIC_SHARE_LIMITS.receipts) }).strict()
export const PublicCheckpointContextV2Schema = PublicCheckpointContextV1Schema.extend({ version: z.literal(2), receipts: z.array(PublicEntityReceiptSchema).max(PUBLIC_SHARE_LIMITS.receipts) })
export const PublicCheckpointContextSchema = z.discriminatedUnion('version', [PublicCheckpointContextV1Schema, PublicCheckpointContextV2Schema])
export type PublicSetupContext = z.infer<typeof PublicSetupContextSchema>
export type PublicCheckpointContext = z.infer<typeof PublicCheckpointContextSchema>
