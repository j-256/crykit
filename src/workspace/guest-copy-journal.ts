import { z } from 'zod'
import { CipherRefSchema } from './account-cache'

export const SAVED_COPY_PREFIX = 'guest-copy:'
export const PENDING_COPY = `${SAVED_COPY_PREFIX}pending`
const RecordSchema = z.strictObject({ key: z.string(), kind: z.string(), label: z.string(), sample: z.boolean() })
export const PreviewSchema = z.strictObject({ copyId: z.string(), snapshotId: z.string(), accountId: z.string(), records: z.array(RecordSchema), selectedKeys: z.array(z.string()), closure: z.array(RecordSchema), estimatedBytes: z.number().nonnegative(), conflicts: z.array(z.string()), problems: z.array(z.string()), resumable: z.boolean() })
export type GuestCopyPreview = Readonly<z.infer<typeof PreviewSchema>>

// Version 1 retains its native synchronization target and mapped intent for exact legacy recovery
// Version 2 retains a managed local target and incremental intent; projection follows local activation
const NativeJournalSchema = z.strictObject({ version: z.literal(1), kind: z.literal('guest-copy'), preview: PreviewSchema, expected: z.strictObject({ key: z.literal('active'), headRevision: z.number().int().nonnegative(), head: CipherRefSchema }), target: CipherRefSchema, intent: CipherRefSchema })
export const ManagedGuestCopyJournalSchema = NativeJournalSchema.extend({ version: z.literal(2) })
export const GuestCopyJournalSchema = z.discriminatedUnion('version', [NativeJournalSchema, ManagedGuestCopyJournalSchema])
export type GuestCopyJournal = z.infer<typeof GuestCopyJournalSchema>
export type ManagedGuestCopyJournal = z.infer<typeof ManagedGuestCopyJournalSchema>
