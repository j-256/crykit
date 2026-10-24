import { z } from 'zod'
import { OpaqueIdSchema, base64urlSchema, digestBytes } from './protocol'

export const adminLimits = Object.freeze({
  defaultPage: 50,
  maxPage: 100,
  previewMs: 15 * 60 * 1000,
  jsonBytes: 16 * 1024,
  retentionMs: 90 * 24 * 60 * 60 * 1000,
})
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const AdminSettingsPatchSchema = z
  .strictObject({
    registrationPaused: z.boolean().optional(),
    uploadsPaused: z.boolean().optional(),
    sharingPaused: z.boolean().optional(),
    emailPaused: z.boolean().optional(),
    maxAccountBytes: bytes.optional(),
    projectCapacityBytes: bytes.positive().optional(),
  })
  .refine((value) => Object.keys(value).length > 0)
export const AdminCommandPayloadSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('accounts.restrict'),
    policy: z.enum(['active', 'read-only', 'blocked']),
  }),
  z.strictObject({ type: z.literal('accounts.quota'), quotaBytes: bytes }),
  z.strictObject({
    type: z.literal('accounts.sessions.revoke'),
    all: z.boolean(),
    sessionIds: z.array(OpaqueIdSchema).min(1).max(100).optional(),
    revokePendingApprovals: z.boolean(),
  }),
  z.strictObject({ type: z.literal('accounts.verification.resend') }),
  z.strictObject({ type: z.literal('accounts.username.withhold') }),
  z.strictObject({ type: z.literal('shares.revoke') }),
  z.strictObject({ type: z.literal('jobs.retry') }),
  z.strictObject({ type: z.literal('jobs.cancel') }),
  z.strictObject({
    type: z.literal('service.settings'),
    patch: AdminSettingsPatchSchema,
  }),
  z.strictObject({
    type: z.literal('operators.invite'),
    email: z
      .email()
      .max(254)
      .regex(/^[\x21-\x7e]+$/),
    role: z.literal('administrator'),
  }),
  z.strictObject({ type: z.literal('operators.invitation.cancel') }),
  z.strictObject({ type: z.literal('operators.remove') }),
  z.strictObject({
    type: z.literal('accounts.delete'),
    confirmation: OpaqueIdSchema,
  }),
])
export type AdminCommandPayload = z.infer<typeof AdminCommandPayloadSchema>
export const adminCommandPolicy = {
  'accounts.restrict': { target: 'account', owner: false, confirmation: false },
  'accounts.quota': { target: 'account', owner: false, confirmation: false },
  'accounts.sessions.revoke': {
    target: 'account',
    owner: false,
    confirmation: false,
  },
  'accounts.verification.resend': {
    target: 'account',
    owner: false,
    confirmation: false,
  },
  'accounts.username.withhold': {
    target: 'account',
    owner: false,
    confirmation: false,
  },
  'shares.revoke': { target: 'share', owner: false, confirmation: true },
  'jobs.retry': { target: 'job', owner: false, confirmation: false },
  'jobs.cancel': { target: 'job', owner: false, confirmation: false },
  'service.settings': { target: 'service', owner: true, confirmation: true },
  'operators.invite': { target: 'invitation', owner: true, confirmation: true },
  'operators.invitation.cancel': {
    target: 'invitation',
    owner: true,
    confirmation: true,
  },
  'operators.remove': { target: 'operator', owner: true, confirmation: true },
  'accounts.delete': { target: 'account', owner: true, confirmation: true },
} as const
export const AdminAuditActionSchema = z.enum([
  ...Object.keys(adminCommandPolicy),
  'accounts.detail',
  'operators.invitation.accept',
  'session.login',
])
export const AdminCommandSchema = z
  .strictObject({
    version: z.literal(1),
    actionId: OpaqueIdSchema,
    expectedRevision: revision.max(Number.MAX_SAFE_INTEGER - 1),
    target: z.strictObject({
      kind: z.enum(['account', 'share', 'job', 'operator', 'invitation', 'service']),
      id: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9_-]+$/),
    }),
    reason: z.enum(['support', 'security', 'abuse', 'maintenance', 'user-request', 'operations']),
    caseId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_.:-]+$/)
      .optional(),
    command: AdminCommandPayloadSchema,
  })
  .superRefine((value, ctx) => {
    if (adminCommandPolicy[value.command.type].target !== value.target.kind)
      ctx.addIssue({ code: 'custom', message: 'Target kind mismatch' })
    if (
      value.target.kind === 'service'
        ? value.target.id !== 'service'
        : !OpaqueIdSchema.safeParse(value.target.id).success
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid target identifier' })
    const command = value.command
    if (command.type === 'accounts.delete' && command.confirmation !== value.target.id)
      ctx.addIssue({ code: 'custom', message: 'Confirmation mismatch' })
    if (
      command.type === 'accounts.sessions.revoke' &&
      (command.all
        ? command.sessionIds !== undefined
        : !command.sessionIds || new Set(command.sessionIds).size !== command.sessionIds.length)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid session selection' })
  })
export type AdminCommand = z.infer<typeof AdminCommandSchema>
export function requiresAdminConfirmation(command: AdminCommandPayload): boolean {
  return (
    adminCommandPolicy[command.type].confirmation ||
    (command.type === 'accounts.restrict' && command.policy === 'blocked') ||
    (command.type === 'accounts.sessions.revoke' && command.all)
  )
}
export const AdminReceiptSchema = z.strictObject({
  version: z.literal(1),
  actionId: OpaqueIdSchema,
  targetRevision: revision,
  state: z.enum(['complete', 'queued']),
  jobId: OpaqueIdSchema.optional(),
  requestId: z.string().min(1).max(128),
})
export type AdminReceipt = z.infer<typeof AdminReceiptSchema>
export const AdminPreviewSchema = z.strictObject({
  version: z.literal(1),
  commandDigest: base64urlSchema(digestBytes),
  target: AdminCommandSchema.shape.target,
  expectedRevision: revision,
  settingsRevision: revision,
  impact: z.array(z.string().max(256)).max(8),
  requiresConfirmation: z.boolean(),
  expiresAt: z.number().int().nonnegative(),
})
export type AdminPreview = z.infer<typeof AdminPreviewSchema>
export const AdminListQuerySchema = z
  .strictObject({
    limit: z.coerce.number().int().min(1).max(adminLimits.maxPage).default(adminLimits.defaultPage),
    cursor: z.string().max(512).optional(),
    order: z.enum(['asc', 'desc']).default('asc'),
    email: z.email().max(254).optional(),
    username: z
      .string()
      .regex(/^[a-z0-9_]{3,24}$/)
      .optional(),
    accountId: OpaqueIdSchema.optional(),
    shareId: OpaqueIdSchema.optional(),
    jobId: OpaqueIdSchema.optional(),
    access: z.enum(['pending', 'active', 'read-only', 'blocked', 'deleting']).optional(),
    state: z.enum(['active', 'stopping', 'stopped']).optional(),
    type: z.enum(['email', 'deletion', 'cleanup']).optional(),
    outcome: z.enum(['pending', 'queued', 'running', 'waiting', 'failed', 'complete', 'denied', 'read']).optional(),
    action: AdminAuditActionSchema.optional(),
  })
  .refine(
    (value) =>
      [value.email, value.username, value.accountId, value.shareId, value.jobId].filter(
        (v) => v !== undefined,
      ).length <= 1,
  )
export type AdminListQuery = z.infer<typeof AdminListQuerySchema>

export const AdminAuditPolicySchema = z.strictObject({
  access: z.enum(['active', 'read-only', 'blocked', 'deleting']).optional(),
  quotaBytes: bytes.optional(),
  usernameWithheld: z.boolean().optional(),
  registrationPaused: z.boolean().optional(),
  uploadsPaused: z.boolean().optional(),
  sharingPaused: z.boolean().optional(),
  emailPaused: z.boolean().optional(),
  maxAccountBytes: bytes.optional(),
  projectCapacityBytes: bytes.optional(),
})
export type AdminAuditPolicy = z.infer<typeof AdminAuditPolicySchema>
export const AdminObservationSchema = z.strictObject({
  observedAt: z.number().int().nonnegative(),
  source: z.literal('application-database'),
  freshness: z.literal('request-read'),
  offlineOutboxes: z.literal('unobserved'),
  providerHeadroom: z.literal('unknown'),
})
export const AdminAccountSummarySchema = z.strictObject({
  id: OpaqueIdSchema,
  email: z.string().max(254),
  username: z.string().max(64),
  access: z.enum(['pending', 'active', 'read-only', 'blocked', 'deleting']),
  revision,
  username_withheld: z.union([z.literal(0), z.literal(1)]),
  capacity_bytes: bytes,
  verified_at: z.number().int().nullable(),
  created_at: z.number().int(),
})
export const AdminShareSummarySchema = z.strictObject({
  id: OpaqueIdSchema,
  account_id: OpaqueIdSchema,
  revision,
  state: z.enum(['active', 'stopping', 'stopped']),
  created_at: z.number().int(),
  updated_at: z.number().int(),
})
export const AdminJobSummarySchema = z.strictObject({
  id: OpaqueIdSchema,
  type: z.enum(['email', 'deletion', 'cleanup']),
  phase: z.string().max(64),
  account_id: OpaqueIdSchema.nullable(),
  revision,
  attempts: z.number().int().nonnegative(),
  next_at: z.number().int(),
  outcome: z.enum(['pending', 'queued', 'running', 'waiting', 'failed', 'complete']),
  code: z.string().max(128).nullable(),
  request_id: z.string().max(128),
  created_at: z.number().int(),
})
export const AdminOperatorSummarySchema = z.strictObject({
  id: OpaqueIdSchema,
  email: z.string().max(254),
  role: z.enum(['owner', 'administrator']),
  state: z.enum(['active', 'revoked']),
  revision,
  created_at: z.number().int(),
})
export function AdminPageSchema<T extends z.ZodType>(item: T) {
  return AdminObservationSchema.extend({
    items: z.array(item).max(adminLimits.maxPage),
    next: z.string().max(512).nullable(),
    limit: z.number().int().min(1).max(adminLimits.maxPage),
  })
}
export type AdminAccountSummary = z.infer<typeof AdminAccountSummarySchema>
export type AdminShareSummary = z.infer<typeof AdminShareSummarySchema>
export type AdminJobSummary = z.infer<typeof AdminJobSummarySchema>
export type AdminOperatorSummary = z.infer<typeof AdminOperatorSummarySchema>
