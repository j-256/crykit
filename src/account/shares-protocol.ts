import { z } from 'zod'
import { OpaqueIdSchema, UsernameSchema } from './protocol'
import { PublicSnapshotSchema, PUBLIC_SHARE_LIMITS, validatePublicSnapshot } from '../interchange/public-share-schema'

export const shareRequestBytes = PUBLIC_SHARE_LIMITS.bytes + 1024
export const shareListLimit = 50
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
// Semantic receipt/group validation is identical for portable and hosted publication
export const HostedSnapshotSchema = PublicSnapshotSchema.superRefine((value, context) => {
  try { validatePublicSnapshot(value) } catch { context.addIssue({ code: 'custom', message: 'Invalid public snapshot' }) }
})
export const PublishSnapshotSchema = z.strictObject({ mutationId: OpaqueIdSchema, snapshot: HostedSnapshotSchema, includeAttribution: z.boolean() })
export const UpdateSnapshotSchema = PublishSnapshotSchema.extend({ expectedRevision: revision }).strict()
export const StopSharingSchema = z.strictObject({ mutationId: OpaqueIdSchema, expectedRevision: revision })
export const PublishedShareSchema = z.strictObject({ shareId: OpaqueIdSchema, revision, url: z.string().max(2048), active: z.boolean() })
export const PublicShareSchema = z.strictObject({ snapshot: HostedSnapshotSchema, attribution: z.strictObject({ username: UsernameSchema }).optional(), revision })
export const OwnShareSchema = PublishedShareSchema.extend({ title: z.string().max(PUBLIC_SHARE_LIMITS.id), kind: z.enum(['build', 'team']), includeAttribution: z.boolean(), state: z.enum(['active', 'stopping', 'stopped']), stopMutationId: OpaqueIdSchema.optional(), stopExpectedRevision: revision.optional() }).strict()
export const OwnSharesSchema = z.strictObject({ shares: z.array(OwnShareSchema).max(shareListLimit), next: OpaqueIdSchema.nullable() })
export type PublishSnapshot = z.infer<typeof PublishSnapshotSchema>
export type UpdateSnapshot = z.infer<typeof UpdateSnapshotSchema>
export type StopSharing = z.infer<typeof StopSharingSchema>
export type PublishedShare = z.infer<typeof PublishedShareSchema>
export type PublicShare = z.infer<typeof PublicShareSchema>
export type OwnShare = z.infer<typeof OwnShareSchema>
