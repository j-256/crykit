import { z } from 'zod'
import { GuestManifestSchema, GuestManifestV2Schema, requireGuestRestoreManifest } from './guest-coordinator'

// The retained monitor admits journals without loading planner writers or bundled catalogs
const refSchema = z.strictObject({ documentId: z.string().min(1), revisionId: z.string().min(1) })
export const GuestManagedManifestSchema = z.strictObject({ version: z.literal(3), id: z.string().min(1), revision: z.number().int().nonnegative().safe(), root: refSchema, recoveryId: z.string().min(1).optional() })
export type GuestManagedManifest = z.infer<typeof GuestManagedManifestSchema>

const captureSchema = z.strictObject({ id: z.string().min(1), version: z.literal(1), completed: z.literal(true), participants: z.array(z.strictObject({ kind: z.enum(['planner', 'inspector', 'files']), name: z.string().min(1), tables: z.array(z.string().min(1)) })) })
const migrationSchema = z.strictObject({
  version: z.literal(1), kind: z.literal('guest-managed-migration'), id: z.string().uuid(),
  expected: z.discriminatedUnion('version', [GuestManifestSchema, GuestManifestV2Schema]),
  capture: captureSchema,
  phase: z.enum(['prepared', 'publishing', 'published', 'failed']), owner: z.string().optional(), target: GuestManagedManifestSchema.optional(),
})
export type GuestManagedMigration = z.infer<typeof migrationSchema>
export function requireGuestManagedMigration(value: unknown): GuestManagedMigration {
  migrationSchema.parse(value)
  // Validation must not rewrite native capture key order, which is part of exact retained evidence
  const row = value as GuestManagedMigration
  if (row.expected.version === 2) requireGuestRestoreManifest(row.expected)
  if (row.capture.participants.length !== 3 || row.capture.participants.map(value => value.kind).join(',') !== 'planner,inspector,files'
    || row.capture.participants.some(value => row.expected[value.kind] !== value.name || new Set(value.tables).size !== value.tables.length)) throw new Error('Managed migration source association changed')
  if (row.phase === 'published' && (!row.target || row.target.id !== row.id || row.target.revision !== row.expected.revision + 1)) throw new Error('Managed migration publication association changed')
  if (row.phase !== 'published' && row.target) throw new Error('Unpublished migration has a selected target')
  return row
}

export const GuestManagedRecoverySelectionSchema = z.strictObject({
  version: z.literal(1), kind: z.literal('selected-guest-recovery'), branchId: z.string().min(1),
  originalCaptureId: z.string().min(1), previousCaptureId: z.string().min(1), capture: captureSchema,
})
export type GuestManagedRecoverySelection = z.infer<typeof GuestManagedRecoverySelectionSchema>
const recoveryReceiptSchema = z.strictObject({
  version: z.literal(1), id: z.string().min(1), kind: z.literal('managed-local-commit'),
  expected: GuestManagedManifestSchema, target: GuestManagedManifestSchema, recovery: GuestManagedRecoverySelectionSchema,
})
export function requireGuestManagedRecoveryReceipt(value: unknown) {
  recoveryReceiptSchema.parse(value)
  const row = value as z.infer<typeof recoveryReceiptSchema>
  if (row.target.id !== row.expected.id || row.target.revision !== row.expected.revision + 1 || row.target.recoveryId !== row.id
    || row.expected.recoveryId === row.id || row.recovery.capture.id === row.recovery.previousCaptureId
    || row.recovery.capture.participants.map(value => value.kind).join(',') !== 'planner,inspector,files') throw new Error('Managed recovery receipt association changed')
  return row
}
