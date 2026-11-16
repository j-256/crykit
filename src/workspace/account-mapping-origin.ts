import { ConflictResolutionIntentSchema } from './conflict-authority'
import { assertActiveProfile, type ProfileToken } from '../account/profile'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'
import { z } from 'zod'
import { OpaqueIdSchema } from '../account/protocol'
import { CipherRefSchema, openAccountJson } from './account-cache'
import type { CipherRef, AccountFence, AccountDatabase } from '../persistence/account-database'

// The migration CAS publishes this exact local-root/native-baseline association together
// It is retained independently of pending rows so ordinary mapping never reallocates the old source
export const AccountMappingOriginSchema = z.strictObject({ version: z.literal(1), kind: z.literal('incremental-mapping-origin'), accountId: OpaqueIdSchema, operationId: OpaqueIdSchema, localRoot: CipherRefSchema, mappedRoot: CipherRefSchema, headRevision: z.number().int().nonnegative().safe() })
export const accountMappingRootKey = (ref: CipherRef) => `incremental-root:${ref.revisionId}`

const IncrementalWorkspaceIntentV1Schema = z.strictObject({ version: z.literal(1), kind: z.literal('incremental-workspace-intent'), operationId: OpaqueIdSchema, mode: z.enum(['additive', 'replace']), operation: z.enum(['save', 'undo', 'workspace-command', 'import', 'mod-setup']).default('workspace-command'), conflictResolution: ConflictResolutionIntentSchema.optional(), sequence: z.number().int().nonnegative().safe(), before: CipherRefSchema, after: CipherRefSchema, publicationBase: CipherRefSchema.optional() })
// V1 remains strict: an old intent cannot silently acquire comparison semantics
const IncrementalWorkspaceIntentV2Schema = IncrementalWorkspaceIntentV1Schema.extend({ version: z.literal(2), mode: z.literal('additive'), operation: z.literal('workspace-command'), copiedComparisons: CipherRefSchema })
export const IncrementalWorkspaceIntentSchema = z.discriminatedUnion('version', [IncrementalWorkspaceIntentV1Schema, IncrementalWorkspaceIntentV2Schema])
export type IncrementalWorkspaceIntent = z.infer<typeof IncrementalWorkspaceIntentSchema>
export const IncrementalMappingRowSchema = z.strictObject({ id: OpaqueIdSchema, ref: CipherRefSchema, status: z.literal('unmapped-local'), publicationBase: CipherRefSchema.optional() })
export const IncrementalMappingReceiptSchema = z.strictObject({ version: z.literal(1), kind: z.literal('incremental-mapping-receipt'), accountId: OpaqueIdSchema, original: IncrementalMappingRowSchema, intent: IncrementalWorkspaceIntentSchema, base: CipherRefSchema, target: CipherRefSchema, mappedIntent: CipherRefSchema, predecessor: z.strictObject({ id: z.string(), ref: CipherRefSchema }).optional() })

export async function readIncrementalMappedRoot(database: AccountDatabase, token: ProfileToken, fence: Pick<AccountFence, 'head' | 'headRevision'> & Partial<AccountFence>): Promise<CipherRef | undefined> {
  assertActiveProfile(token)
  const row = await database.syncState.get(accountMappingRootKey(fence.head))
  if (!row) return undefined
  const value = await openAccountJson(database, token, row.ref, z.union([IncrementalMappingReceiptSchema, AccountMappingOriginSchema]))
  if (value.accountId !== token.accountId) throw new Error('Foreign mapped root')
  if (value.kind === 'incremental-mapping-origin') return guestPlannerValuesEqual(value.localRoot, fence.head) && value.headRevision === fence.headRevision ? value.mappedRoot : undefined
  if (guestPlannerValuesEqual(value.intent.after, fence.head) && value.intent.sequence === fence.headRevision) return value.target
  if (guestPlannerValuesEqual(value.intent.before, fence.head) && value.intent.sequence - 1 === fence.headRevision) return value.base
  return undefined
}

// Migration journals retain their original local intent even after the outbox row is mapped
// Consumers follow the durable exact receipt instead of interpreting that intent as a native one
export async function readIncrementalMappedIntent(database: AccountDatabase, token: ProfileToken, operationId: string, original: CipherRef): Promise<CipherRef | undefined> {
  assertActiveProfile(token)
  const row = await database.syncState.get(`incremental-mapping:${operationId}`)
  if (!row) return undefined
  const receipt = await openAccountJson(database, token, row.ref, IncrementalMappingReceiptSchema)
  if (receipt.accountId !== token.accountId || receipt.original.id !== operationId || receipt.intent.operationId !== operationId || !guestPlannerValuesEqual(receipt.original.ref, original)) throw new Error('Foreign copied comparison mapping receipt')
  return receipt.mappedIntent
}
