import { ApiFailure } from '../http'

// Maintained schema projection: no request or backup payload can select SQL identifiers
// Add owning migrations here before accepting snapshots of their durable records
export const recoveryProjection = {
  email_jobs: [
    'id',
    'request_digest',
    'request_id',
    'payload',
    'state',
    'delivery',
    'attempts',
    'eligible',
    'next_attempt_at',
    'expires_at',
    'created_at',
    'updated_at',
    'lease_token',
    'lease_until',
    'code',
    'message_id',
    'resend_of',
    'admin_revision',
  ],
  email_attempts: ['job_id', 'attempt', 'lease_token', 'delivery', 'started_at', 'finished_at', 'code'],
  email_audit: ['id', 'job_id', 'stage', 'attempt', 'code', 'created_at'],
  accounts: [
    'id',
    'normalized_email',
    'delivery_email',
    'username',
    'verified_at',
    'access',
    'revision',
    'capacity_bytes',
    'created_at',
    'session_epoch',
    'username_withheld',
  ],
  credentials: ['account_id', 'role', 'credential_id', 'record', 'account_envelope', 'revision'],
  devices: ['id', 'account_id', 'created_at', 'revoked_at'],
  account_security_notices: ['transaction_id', 'account_id', 'root_job_id', 'created_at'],
  quota_counters: ['scope', 'payload_bytes', 'reserved_metadata', 'metadata_bytes', 'metadata_rows', 'edges'],
  account_sequences: ['account_id', 'sequence', 'publication_epoch'],
  upload_reservations: [
    'account_id',
    'upload_id',
    'document_id',
    'revision_id',
    'request_digest',
    'request_json',
    'generation',
    'descriptor_reserve',
  ],
  storage_generations: ['account_id', 'id', 'upload_id', 'expires_at', 'state'],
  upload_chunks: [
    'account_id',
    'generation',
    'chunk_index',
    'object_key',
    'cipher_bytes',
    'cipher_digest',
    'seed',
    'marker',
    'seed_etag',
    'state',
    'released',
  ],
  sync_documents: ['account_id', 'document_id', 'head', 'first_sequence'],
  sync_revisions: ['account_id', 'revision_id', 'document_id', 'upload_id', 'descriptor', 'protected'],
  sync_dependencies: ['account_id', 'revision_id', 'dependency_id', 'document_id'],
  mutation_receipts: ['account_id', 'mutation_id', 'digest', 'sequence', 'receipt', 'group_json'],
  head_history: ['account_id', 'document_id', 'sequence', 'revision_id'],
  scan_leases: ['account_id', 'id', 'watermark', 'publication_epoch', 'expires_at'],
  publication_work: ['account_id', 'mutation_id', 'digest', 'state', 'expires_at'],
  publication_pins: [
    'account_id',
    'mutation_id',
    'revision_id',
    'document_id',
    'generation',
    'done',
    'retained',
  ],
  publication_progress: ['account_id', 'mutation_id', 'work_id', 'processed_steps'],
  publication_certificates: [
    'account_id',
    'mutation_id',
    'digest',
    'work_id',
    'head_document',
    'head_revision',
    'head_generation',
    'version',
    'state',
  ],
  publication_borrows: [
    'account_id',
    'mutation_id',
    'work_id',
    'digest',
    'revision_id',
    'document_id',
    'generation',
    'source_mutation',
    'source_digest',
    'source_work',
    'source_head_document',
    'source_head_revision',
    'source_head_generation',
  ],
  shares: [
    'id',
    'account_id',
    'revision',
    'snapshot_revision',
    'state',
    'include_attribution',
    'created_at',
    'updated_at',
  ],
  share_snapshots: ['share_id', 'account_id', 'revision', 'snapshot'],
  share_mutations: ['account_id', 'mutation_id', 'share_id', 'digest', 'kind', 'event', 'receipt'],
  service_jobs: [
    'id',
    'type',
    'phase',
    'account_id',
    'actor_id',
    'expected_revision',
    'attempts',
    'lease_token',
    'lease_until',
    'next_at',
    'outcome',
    'code',
    'request_id',
    'created_at',
    'cursor',
    'admin_revision',
  ],
  revocation_intents: ['id', 'job_id', 'event', 'liabilities', 'acknowledged', 'cursor'],
  service_audit: ['id', 'job_id', 'stage', 'code', 'created_at'],
  operators: ['id', 'issuer', 'subject', 'email', 'role', 'state', 'revision', 'created_at'],
  admin_access_sessions: ['id', 'token_hash', 'issuer', 'subject', 'created_at', 'expires_at', 'revoked_at'],
  admin_sessions: [
    'id',
    'token_hash',
    'operator_id',
    'membership_revision',
    'created_at',
    'expires_at',
    'revoked_at',
  ],
  admin_confirmations: [
    'id',
    'operator_id',
    'session_id',
    'membership_revision',
    'command_digest',
    'created_at',
    'expires_at',
    'confirmed_until',
  ],
  admin_bootstrap_intents: ['id', 'operator_id', 'issuer', 'subject'],
  admin_security_audit: ['id', 'actor_id', 'action', 'target_id', 'request_id', 'created_at'],
  admin_actions: ['id', 'actor_id', 'action', 'digest', 'target_kind', 'target_id', 'receipt', 'created_at'],
  admin_previews: ['id', 'actor_id', 'session_id', 'digest', 'settings_revision', 'expires_at'],
  admin_audit: [
    'id',
    'actor_id',
    'action',
    'target_kind',
    'target_id',
    'action_id',
    'reason',
    'case_id',
    'outcome',
    'policy_before',
    'policy_after',
    'request_id',
    'created_at',
  ],
  admin_invitations: [
    'id',
    'normalized_email',
    'delivery_email',
    'role',
    'state',
    'revision',
    'token_hash',
    'root_job_id',
    'created_by',
    'accepted_by',
    'created_at',
    'expires_at',
  ],
  service_settings: [
    'id',
    'revision',
    'registration_paused',
    'uploads_paused',
    'sharing_paused',
    'email_paused',
    'max_account_bytes',
    'project_capacity_bytes',
  ],
  admin_revocations: ['id', 'action_id', 'event', 'acknowledged', 'code', 'created_at'],
} as const
export type RecoveryTable = keyof typeof recoveryProjection
export const recoveryTables = Object.keys(recoveryProjection) as RecoveryTable[]

const legacyJobTupleWidths = Object.freeze({ email_jobs: 17, service_jobs: 15 })
const initialAdminRevision = 1

// Version 1 snapshots predate the separate job revision columns
// Only the exact original tuples gain the migration's default; immutable backup bytes stay untouched
export function normalizeRecoveryTuple(table: RecoveryTable, value: unknown): (string | number | null)[] {
  const columns: readonly string[] = recoveryProjection[table]
  if (!Array.isArray(value)) throw new ApiFailure('INTEGRITY_FAILED')
  const legacyWidth = table === 'email_jobs' || table === 'service_jobs' ? legacyJobTupleWidths[table] : null
  const values = legacyWidth !== null && value.length === legacyWidth ? [...value, initialAdminRevision] : value
  if (
    values.length !== columns.length ||
    values.some(
      (item) =>
        item !== null &&
        typeof item !== 'string' &&
        !(typeof item === 'number' && Number.isSafeInteger(item)),
    )
  )
    throw new ApiFailure('INTEGRITY_FAILED')
  if (legacyWidth !== null) {
    const numeric = new Set([
      'attempts',
      'eligible',
      'next_attempt_at',
      'expires_at',
      'created_at',
      'updated_at',
      'lease_until',
      'expected_revision',
      'next_at',
      'admin_revision',
    ])
    const nullable = new Set([
      'payload',
      'lease_token',
      'lease_until',
      'code',
      'message_id',
      'resend_of',
      'account_id',
      'actor_id',
    ])
    for (const [index, column] of columns.entries()) {
      const item = values[index]
      if (item === null ? !nullable.has(column) : typeof item !== (numeric.has(column) ? 'number' : 'string'))
        throw new ApiFailure('INTEGRITY_FAILED')
      if (column === 'admin_revision' && (typeof item !== 'number' || item < 1))
        throw new ApiFailure('INTEGRITY_FAILED')
    }
  }
  return values as (string | number | null)[]
}
