import { z } from 'zod'

export const wireVersion = 1 as const
export const revisionFormat = 1 as const
export const opaqueIdBytes = 16
export const digestBytes = 32
export const keyEnvelopeNonceBytes = 24
export const wrappedKeyCipherBytes = 48
export const secretStreamHeaderBytes = 24
export const keyEnvelopeAlgorithm = 'xchacha20poly1305-ietf' as const
export const maxRequestIdCharacters = 128
export const maxCapabilityCharacters = 2048
export const maxAuthJsonBytes = 64 * 1024
export const plainChunkBytes = 4 * 1024 * 1024
export const streamOverheadBytes = 17
export const maxDocumentBytes = 512 * 1024 * 1024
export const maxChunks = 128
export const defaultAccountCapacityBytes = 512 * 1024 * 1024
export const localProjectCapacityBytes = 2 * 1024 * 1024 * 1024
export const uploadReservationMs = 24 * 60 * 60 * 1000
export const maxChangedHeads = 32
export const maxMutationTransitionDocuments = maxChangedHeads
export const maxMutationTransitionQueryBytes = 4096
export const maxMutationTransitionResponseBytes = 8192
export const MAX_REVISION_PARENTS = 2
export const maxDependencies = 256
export const maxCommitJsonBytes = 1024 * 1024
export const maxChangePageRevisions = 100
export const defaultAdminPageRows = 50
export const maxAdminPageRows = 100
export const maxCursorBytes = 2048

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const BASE64URL_PADDING_MASKS = [0, 0b1111, 0b11] as const

// Reject alternate encodings before these values become identity or digest keys
export function base64urlSchema(bytes: number) {
  const encodedLength = Math.ceil(bytes * 4 / 3)
  const paddingMask = BASE64URL_PADDING_MASKS[bytes % 3] ?? 0
  const validWidth = Number.isInteger(bytes) && bytes > 0
  return z.string().length(encodedLength).regex(/^[A-Za-z0-9_-]+$/).refine(value => {
    // RFC 4648 section 3.5 requires zero unused bits: four after one byte, two after two bytes
    // Exact width and alphabet plus these bits prove canonicality without decoding every identity
    const lastSymbol = BASE64URL_ALPHABET.indexOf(value.at(-1) ?? '=')
    return validWidth && value.length === encodedLength && lastSymbol >= 0 && (lastSymbol & paddingMask) === 0
  }, 'Expected canonical base64url')
}
// Fixed ristretto255/SHA-512 serialization in @serenity-kit/opaque 1.1.0, not loose request budgets
export const opaqueServerIdentity = 'crykit/accounts/opaque/v1'
export const opaqueFieldBytes = Object.freeze({
  setup: 128, clientRegistrationState: 64, registrationRequest: 32, registrationResponse: 64,
  registrationRecord: 192, clientLoginState: 192, startLoginRequest: 96,
  serverLoginState: 128, loginResponse: 320, finishLoginRequest: 64, exportKey: 64,
})
export const OpaqueFieldSchemas = Object.freeze({
  setup: base64urlSchema(opaqueFieldBytes.setup), clientRegistrationState: base64urlSchema(opaqueFieldBytes.clientRegistrationState),
  registrationRequest: base64urlSchema(opaqueFieldBytes.registrationRequest), registrationResponse: base64urlSchema(opaqueFieldBytes.registrationResponse),
  registrationRecord: base64urlSchema(opaqueFieldBytes.registrationRecord), clientLoginState: base64urlSchema(opaqueFieldBytes.clientLoginState),
  startLoginRequest: base64urlSchema(opaqueFieldBytes.startLoginRequest), serverLoginState: base64urlSchema(opaqueFieldBytes.serverLoginState),
  loginResponse: base64urlSchema(opaqueFieldBytes.loginResponse), finishLoginRequest: base64urlSchema(opaqueFieldBytes.finishLoginRequest),
  exportKey: base64urlSchema(opaqueFieldBytes.exportKey),
})
// Role-specific stable IDs survive email changes and prevent reuse between password and recovery
export const CredentialIdSchema = z.string().regex(/^crykit\/(password|recovery)\/[A-Za-z0-9_-]{22}$/).refine(value => base64urlSchema(16).safeParse(value.split('/')[2]).success)
export const OpaqueIdSchema = base64urlSchema(opaqueIdBytes)
export const DigestSchema = base64urlSchema(digestBytes)
export type OpaqueId = z.infer<typeof OpaqueIdSchema>
const uint = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const KeyEnvelopeSchema = z.strictObject({
  version: z.literal(wireVersion), algorithm: z.literal(keyEnvelopeAlgorithm),
  nonce: base64urlSchema(keyEnvelopeNonceBytes), ciphertext: base64urlSchema(wrappedKeyCipherBytes),
})
export type KeyEnvelope = z.infer<typeof KeyEnvelopeSchema>
const HeadSchema = z.strictObject({ documentId: OpaqueIdSchema, revisionId: OpaqueIdSchema })
const ChunkSchema = z.strictObject({ index: z.number().int().min(0).max(maxChunks - 1), cipherBytes: z.number().int().min(streamOverheadBytes).max(plainChunkBytes + streamOverheadBytes), cipherDigest: DigestSchema })
const ChunksSchema = z.array(ChunkSchema).min(1).max(maxChunks).refine(chunks => chunks.every((chunk, index) => chunk.index === index), 'Chunks must be contiguous and ordered').readonly()
const unique = <T>(items: readonly T[], key: (item: T) => string) => new Set(items.map(key)).size === items.length
export const RevisionContextSchema = z.strictObject({
  format: z.literal(revisionFormat), accountId: OpaqueIdSchema, documentId: OpaqueIdSchema, revisionId: OpaqueIdSchema,
  parents: z.array(OpaqueIdSchema).max(MAX_REVISION_PARENTS).refine(ids => unique(ids, id => id)).readonly(),
  dependencies: z.array(HeadSchema).max(maxDependencies).refine(heads => unique(heads, head => `${head.documentId}:${head.revisionId}`)).readonly(),
  protected: z.boolean(), plainBytes: z.number().int().min(0).max(maxDocumentBytes),
})
export type RevisionContext = z.infer<typeof RevisionContextSchema>
export const RevisionDescriptorSchema = RevisionContextSchema.extend({
  keyEnvelope: KeyEnvelopeSchema, streamHeader: base64urlSchema(secretStreamHeaderBytes), uploadId: OpaqueIdSchema, chunks: ChunksSchema,
}).refine(revision => {
  // The authenticated plaintext length fixes the final chunk, including empty documents
  const count = Math.max(1, Math.ceil(revision.plainBytes / plainChunkBytes))
  return revision.chunks.length === count && revision.chunks.every((chunk, index) => chunk.cipherBytes === Math.min(plainChunkBytes, revision.plainBytes - index * plainChunkBytes) + streamOverheadBytes)
}, 'Chunk lengths must match plaintext length')
export type RevisionDescriptor = z.infer<typeof RevisionDescriptorSchema>
const PublicationHeadsSchema = z.array(HeadSchema).max(maxChangedHeads).refine(heads => unique(heads, head => head.documentId)).readonly()
export const CommitRequestSchema = z.strictObject({
  version: z.literal(wireVersion), mutationId: OpaqueIdSchema, expectedPublicationEpoch: uint.optional(),
  expected: z.array(z.strictObject({ documentId: OpaqueIdSchema, revisionId: OpaqueIdSchema.nullable() })).max(maxChangedHeads).refine(heads => unique(heads, head => head.documentId)).readonly(),
  heads: PublicationHeadsSchema,
  revisions: z.array(RevisionDescriptorSchema).max(maxChangedHeads).refine(revisions => unique(revisions, revision => revision.revisionId)).readonly(),
}).refine(commit => {
  // Immutable staging never changes heads; guards describe exactly the selected publications
  return (commit.expectedPublicationEpoch === undefined || commit.heads.length > 0)
    && commit.heads.length + commit.revisions.length > 0
    && commit.expected.length === commit.heads.length
    && commit.heads.every(head => commit.expected.some(expected => expected.documentId === head.documentId))
}, 'Expected guards must match published heads')
export type CommitRequest = z.infer<typeof CommitRequestSchema>
export const CommitReceiptSchema = z.strictObject({ version: z.literal(wireVersion), mutationId: OpaqueIdSchema, sequence: uint, publicationEpoch: uint, heads: PublicationHeadsSchema })
export type CommitReceipt = z.infer<typeof CommitReceiptSchema>
export const MutationTransitionDocumentsSchema = z.array(OpaqueIdSchema).min(1).max(maxMutationTransitionDocuments).refine(ids => unique(ids, id => id)).readonly()
export const MutationTransitionSchema = z.strictObject({
  version: z.literal(wireVersion), kind: z.literal('mutation-transition'), accountId: OpaqueIdSchema,
  mutationId: OpaqueIdSchema, requestDigest: DigestSchema, receipt: CommitReceiptSchema, previousPublicationEpoch: uint,
  documents: z.array(z.strictObject({ documentId: OpaqueIdSchema, before: OpaqueIdSchema.nullable(), after: OpaqueIdSchema.nullable() })).min(1).max(maxMutationTransitionDocuments).refine(rows => unique(rows, row => row.documentId)).readonly(),
}).refine(value => value.receipt.sequence >= 1 && value.receipt.mutationId === value.mutationId
  && value.previousPublicationEpoch <= value.receipt.publicationEpoch
  && value.receipt.publicationEpoch - value.previousPublicationEpoch <= 1
  && value.documents.every(row => value.receipt.heads.every(head => head.documentId !== row.documentId || head.revisionId === row.after)), 'Inconsistent accepted transition')
export const MutationTransitionUnavailableSchema = z.strictObject({
  version: z.literal(wireVersion), kind: z.literal('mutation-transition-unavailable'), mutationId: OpaqueIdSchema,
  reason: z.enum(['unknown-mutation', 'history-unavailable']),
})
export const MutationTransitionResponseSchema = z.discriminatedUnion('kind', [MutationTransitionSchema, MutationTransitionUnavailableSchema])
export type MutationTransition = z.infer<typeof MutationTransitionSchema>
export type MutationTransitionUnavailable = z.infer<typeof MutationTransitionUnavailableSchema>
export type MutationTransitionResponse = z.infer<typeof MutationTransitionResponseSchema>
export const ChangePageSchema = z.strictObject({
  version: z.literal(wireVersion), mode: z.enum(['initial', 'incremental']), watermark: uint, publicationEpoch: uint,
  cursor: z.string().max(maxCursorBytes).refine(value => new TextEncoder().encode(value).length <= maxCursorBytes), hasMore: z.boolean(),
  groups: z.array(z.strictObject({ sequence: uint, mutationId: OpaqueIdSchema, heads: PublicationHeadsSchema, revisions: z.array(RevisionDescriptorSchema).max(maxChangedHeads).readonly() }).refine(group => group.heads.length + group.revisions.length > 0)).max(maxChangePageRevisions).readonly(),
}).refine(page => page.groups.reduce((sum, group) => sum + Math.max(group.revisions.length, group.heads.length), 0) <= maxChangePageRevisions)
export type ChangePage = z.infer<typeof ChangePageSchema>
export const UploadStartSchema = z.strictObject({ version: z.literal(wireVersion), uploadId: OpaqueIdSchema, documentId: OpaqueIdSchema, revisionId: OpaqueIdSchema, metadataBytes: z.number().int().min(1).max(maxCommitJsonBytes), chunks: ChunksSchema })
export type UploadStart = z.infer<typeof UploadStartSchema>
export const UploadReadySchema = z.strictObject({ version: z.literal(wireVersion), uploadId: OpaqueIdSchema, expiresAt: uint })
export type UploadReady = z.infer<typeof UploadReadySchema>
export const JobReceiptSchema = z.strictObject({ jobId: OpaqueIdSchema, state: z.enum(['queued', 'running', 'waiting', 'failed', 'complete']), requestId: z.string().min(1).max(maxRequestIdCharacters), statusCapability: z.string().min(1).max(maxCapabilityCharacters).optional() })
export type JobReceipt = z.infer<typeof JobReceiptSchema>
export const ServiceStatusSchema = z.strictObject({ version: z.literal(wireVersion), accountsAvailable: z.boolean(), signupAvailable: z.boolean(), supportedWireVersions: z.tuple([z.literal(wireVersion)]) })
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>
export const apiErrorStatuses = Object.freeze({ INVALID_REQUEST: 400, AUTH_REQUIRED: 401, AUTH_FAILED: 401, FORBIDDEN: 403, CSRF_FAILED: 403, ACCOUNT_RESTRICTED: 403, NOT_FOUND: 404, HEAD_CONFLICT: 409, IDEMPOTENCY_MISMATCH: 409, STALE_CURSOR: 409, QUOTA_EXCEEDED: 413, PAYLOAD_TOO_LARGE: 413, UNSUPPORTED_VERSION: 426, RATE_LIMITED: 429, SERVICE_PAUSED: 503, SERVICE_UNAVAILABLE: 503, INTEGRITY_FAILED: 422 } as const)
export type ApiErrorCode = keyof typeof apiErrorStatuses
export const CommitContinuationSchema = z.strictObject({ mutationId: OpaqueIdSchema, requestDigest: DigestSchema, workId: OpaqueIdSchema, expiresAt: uint, processed: uint })
export type CommitContinuation = z.infer<typeof CommitContinuationSchema>
export const ApiErrorSchema = z.strictObject({ error: z.strictObject({ code: z.enum(Object.keys(apiErrorStatuses) as [ApiErrorCode, ...ApiErrorCode[]]), requestId: z.string().min(1).max(maxRequestIdCharacters), retryAfterSeconds: uint.optional(), continuation: CommitContinuationSchema.optional() }).refine(value => !value.continuation || value.code === 'SERVICE_UNAVAILABLE') })
export type ApiError = z.infer<typeof ApiErrorSchema>

export interface LimitDiagnostic {
  readonly limiter?: string
  readonly scope?: 'network' | 'account' | 'target' | 'service' | 'location'
  readonly limit?: number
  readonly windowMs?: number
  readonly observedCount?: number
  readonly counter?: 'admitted' | 'work-units' | 'unavailable'
  readonly retryAfterSeconds?: number
  readonly route?: string
  readonly method?: string
}
export interface SafeEvent extends LimitDiagnostic {
  readonly operation: string
  readonly stage?: string
  readonly code?: string
  readonly durationMs?: number
  readonly attempt?: number
  readonly bytes?: number
  readonly rowsRead?: number
  readonly rowsWritten?: number
  readonly jobId?: string
  readonly mutationId?: string
}

export function credentialIdForRole(accountId: string, role: 'password' | 'recovery'): string {
  return CredentialIdSchema.parse(`crykit/${role}/${OpaqueIdSchema.parse(accountId)}`)
}
export const UsernameSchema = z.string().regex(/^[a-z0-9_]{3,24}$/)
export const EmailSchema = z.string().max(320).transform(value => value.trim()).pipe(z.email().max(254))
export const SignupStartSchema = z.strictObject({ email: EmailSchema, username: UsernameSchema, registrationRequest: OpaqueFieldSchemas.registrationRequest })
export const SignupFinishSchema = z.strictObject({ attemptId: OpaqueIdSchema, transactionId: OpaqueIdSchema, registrationRecord: OpaqueFieldSchemas.registrationRecord, accountEnvelope: KeyEnvelopeSchema, remember: z.boolean() })
export const SignupStartedSchema = z.strictObject({ attemptId: OpaqueIdSchema, accountId: OpaqueIdSchema, credentialId: CredentialIdSchema, registrationResponse: OpaqueFieldSchemas.registrationResponse, expiresAt: uint })
export const SignupPendingSchema = z.strictObject({ pending: z.literal(true), transactionId: OpaqueIdSchema })
export const LoginStartSchema = z.strictObject({ email: EmailSchema, role: z.enum(['password', 'recovery']), startLoginRequest: OpaqueFieldSchemas.startLoginRequest })
export const LoginStartedSchema = z.strictObject({ attemptId: OpaqueIdSchema, credentialId: CredentialIdSchema, loginResponse: OpaqueFieldSchemas.loginResponse, expiresAt: uint })
export const LoginFinishSchema = z.strictObject({ attemptId: OpaqueIdSchema, finishLoginRequest: OpaqueFieldSchemas.finishLoginRequest, remember: z.boolean() })
export const SessionReceiptSchema = z.strictObject({ accountId: OpaqueIdSchema, username: UsernameSchema, sessionId: OpaqueIdSchema, deviceId: OpaqueIdSchema, csrf: DigestSchema, authenticatedAt: uint })
export const LoginReceiptSchema = SessionReceiptSchema.extend({ accountEnvelope: KeyEnvelopeSchema })
export const VerifySchema = z.strictObject({ capability: DigestSchema })
export const ResendSchema = z.strictObject({ email: EmailSchema })
export const LogoutSchema = z.strictObject({ sessionId: OpaqueIdSchema })

export const CredentialRoleSchema = z.enum(['password', 'recovery'])
export const CredentialRevisionsSchema = z.strictObject({ passwordRevision: uint.min(1), recoveryRevision: uint.min(1).nullable() })
export const devicePageLimit = 50
export const DeviceSchema = z.strictObject({ id: OpaqueIdSchema, createdAt: uint, revokedAt: uint.nullable() })
export const maxDeviceCursorCharacters = 512
export const DevicePageSchema = z.strictObject({ devices: z.array(DeviceSchema).max(devicePageLimit), currentDevice: DeviceSchema, hasMore: z.boolean(), nextCursor: z.string().max(maxDeviceCursorCharacters).nullable() })
export const AccountMetadataSchema = z.strictObject({
  accountId: OpaqueIdSchema, sessionId: OpaqueIdSchema, deviceId: OpaqueIdSchema, authenticatedAt: uint, absoluteExpiresAt: uint,
  access: z.enum(['active', 'read-only']), username: UsernameSchema, email: EmailSchema, verified: z.literal(true), revision: uint.min(1),
  quota: z.strictObject({ capacityBytes: uint }),
  policy: z.strictObject({ ordinary: z.strictObject({ idleMs: uint, absoluteMs: uint }), remembered: z.strictObject({ idleMs: uint, absoluteMs: uint }) }),
  devicePage: DevicePageSchema, csrf: DigestSchema,
  credentials: CredentialRevisionsSchema,
})
export const CredentialStartSchema = z.strictObject({ transactionId: OpaqueIdSchema, role: CredentialRoleSchema, registrationRequest: OpaqueFieldSchemas.registrationRequest })
export const CredentialStartedSchema = z.strictObject({ credentialId: CredentialIdSchema, registrationResponse: OpaqueFieldSchemas.registrationResponse })
export const CredentialCommitSchema = z.strictObject({ transactionId: OpaqueIdSchema, expectedCredentialRevision: uint, role: CredentialRoleSchema, registrationRecord: OpaqueFieldSchemas.registrationRecord, accountEnvelope: KeyEnvelopeSchema })
export const CredentialReceiptSchema = z.strictObject({ transactionId: OpaqueIdSchema, credentialRevision: uint.min(1), completed: z.literal(true) })
export const UsernameChangeSchema = z.strictObject({ transactionId: OpaqueIdSchema, expectedRevision: uint.min(1), username: UsernameSchema })
export const UsernameReceiptSchema = z.strictObject({ transactionId: OpaqueIdSchema, revision: uint.min(1), username: UsernameSchema, completed: z.literal(true) })
export const EmailChangeSchema = z.strictObject({ transactionId: OpaqueIdSchema, expectedRevision: uint.min(1), email: EmailSchema })
export const EmailPendingSchema = z.strictObject({ pending: z.literal(true) })
export const EmailReceiptSchema = z.strictObject({ transactionId: OpaqueIdSchema, revision: uint.min(1), completed: z.literal(true) })
export const TransactionReceiptSchema = z.union([CredentialReceiptSchema, UsernameReceiptSchema, EmailReceiptSchema, EmailPendingSchema])
export const ReauthStartSchema = z.strictObject({ role: CredentialRoleSchema, startLoginRequest: OpaqueFieldSchemas.startLoginRequest })
export const ReauthFinishSchema = z.strictObject({ attemptId: OpaqueIdSchema, finishLoginRequest: OpaqueFieldSchemas.finishLoginRequest })
export const ReauthReceiptSchema = z.strictObject({ authenticatedAt: uint })

export const deviceApprovalLifetimeMs = 10 * 60 * 1000
export const deviceFingerprintBytes = 8
export const DeviceStartSchema = z.strictObject({ email: EmailSchema, requestId: OpaqueIdSchema, requestPublicKey: DigestSchema, requestCapabilityHash: DigestSchema })
export const DeviceStartedSchema = z.strictObject({ requestId: OpaqueIdSchema, pairingContext: OpaqueIdSchema, expiresAt: uint })
export const DeviceStatusInputSchema = z.strictObject({ requestId: OpaqueIdSchema, requestCapability: DigestSchema })
const minSealedPayloadCharacters = 64
const maxSealedPayloadCharacters = 2048
const SealedPayloadSchema = z.string().min(minSealedPayloadCharacters).max(maxSealedPayloadCharacters).regex(/^[A-Za-z0-9_-]+$/).refine(value => {
  // Keep decoding bounded even when other Zod checks have already rejected the value
  if (value.length < minSealedPayloadCharacters || value.length > maxSealedPayloadCharacters) return false
  try {
    const bytes = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
    return btoa(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === value
  } catch { return false }
}, 'Expected canonical base64url')
export const DeviceStatusSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.enum(['pending', 'expired', 'rejected', 'consumed']) }),
  z.strictObject({ state: z.literal('approved'), accountId: OpaqueIdSchema, sealedPayload: SealedPayloadSchema }),
])
export const ApprovalRequestSchema = DeviceStartedSchema.extend({ accountId: OpaqueIdSchema, requestPublicKey: DigestSchema, fingerprint: z.string().regex(/^[0-9A-F]{4}( [0-9A-F]{4}){3}$/) })
export const approvalRequestListLimit = 20
export const ApprovalRequestListSchema = z.strictObject({ requests: z.array(ApprovalRequestSchema).max(approvalRequestListLimit), hasMore: z.boolean() })
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>
export const DeviceApproveSchema = z.strictObject({ requestId: OpaqueIdSchema, requestPublicKey: DigestSchema, sealedPayload: SealedPayloadSchema, completionHash: DigestSchema })
export const DeviceCompleteSchema = DeviceStatusInputSchema.extend({ completionSecret: DigestSchema, remember: z.boolean() })
export const DeviceRejectSchema = z.strictObject({ requestId: OpaqueIdSchema })
export const DeviceApprovalReceiptSchema = z.strictObject({ approved: z.literal(true) })
export const DeviceRejectedReceiptSchema = z.strictObject({ rejected: z.literal(true) })
export const DeviceRemovedReceiptSchema = z.strictObject({ revoked: z.literal(true) })
export async function deviceFingerprint(request: { pairingContext: string; requestId: string; requestPublicKey: string }): Promise<string> {
  // Explicit tuple order is the shared comparison contract, independent of object property order
  const bytes = new TextEncoder().encode(JSON.stringify([request.pairingContext, request.requestId, request.requestPublicKey]))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest.slice(0, deviceFingerprintBytes), byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{4}/g)!.join(' ')
}
export async function deviceSecretHash(secret: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
