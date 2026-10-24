import { CommitReceiptSchema, DigestSchema, MutationTransitionDocumentsSchema, MutationTransitionResponseSchema, OpaqueIdSchema, maxMutationTransitionResponseBytes, type CommitReceipt, type MutationTransitionResponse } from '../../src/account/protocol'
import type { CustomerPrincipal } from '../auth/session'
import type { ServiceContext } from '../context'
import { ApiFailure } from '../http'
import { encodedBytes, syncBatch } from './storage'

// CASE prevents an oversized retained body from crossing the database binding boundary
const boundedReceipt = (alias: string) => `CASE WHEN length(CAST(${alias}.receipt AS BLOB)) <= ${maxMutationTransitionResponseBytes} THEN ${alias}.receipt ELSE NULL END AS receipt`
const receiptColumns = (alias: string) => `${alias}.account_id, ${alias}.mutation_id, ${alias}.digest, ${alias}.sequence, ${boundedReceipt(alias)}`
interface ReceiptRow { account_id: unknown; mutation_id: unknown; digest: unknown; sequence: unknown; receipt: unknown }
interface HistoryRow { ordinal: number; document_id: string; first_sequence: number | null; earliest_sequence: number | null; before_sequence: number | null; before_revision: string | null; after_sequence: number | null; after_revision: string | null }
const positiveSequence = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
function parseReceipt(row: ReceiptRow | undefined, accountId: string): CommitReceipt | null {
  if (!row || row.account_id !== accountId || !OpaqueIdSchema.safeParse(row.mutation_id).success || !DigestSchema.safeParse(row.digest).success || !positiveSequence(row.sequence) || typeof row.receipt !== 'string') return null
  try {
    const receipt = CommitReceiptSchema.parse(JSON.parse(row.receipt))
    return receipt.sequence === row.sequence && receipt.mutationId === row.mutation_id ? receipt : null
  } catch { return null }
}

export async function readMutationTransition(principal: CustomerPrincipal, mutationId: string, documentIds: readonly string[], context: ServiceContext): Promise<MutationTransitionResponse> {
  const parsed = MutationTransitionDocumentsSchema.safeParse(documentIds)
  if (!OpaqueIdSchema.safeParse(mutationId).success || !parsed.success) throw new ApiFailure('INVALID_REQUEST')
  const documents = parsed.data, db = context.env.DB!, started = performance.now()
  // Receipts include headless commands, so the predecessor epoch cannot be inferred from head history
  const results = await syncBatch(principal, '1', [], [
    db.prepare(`SELECT ${receiptColumns('current')} FROM mutation_receipts current WHERE current.account_id = ? AND current.mutation_id = ?`).bind(principal.accountId, mutationId),
    db.prepare(`SELECT ${receiptColumns('previous')} FROM mutation_receipts current JOIN mutation_receipts previous ON previous.account_id = current.account_id AND previous.sequence = current.sequence - 1 WHERE current.account_id = ? AND current.mutation_id = ?`).bind(principal.accountId, mutationId),
    // These bounded indexed seeks select physical heads, never encrypted effective selection
    db.prepare(`WITH anchor AS (SELECT account_id, sequence FROM mutation_receipts WHERE account_id = ? AND mutation_id = ?),
      requested AS (SELECT CAST(key AS INTEGER) AS ordinal, value AS document_id FROM json_each(?))
      SELECT requested.ordinal, requested.document_id, d.first_sequence,
        (SELECT h.sequence FROM head_history h WHERE h.account_id = anchor.account_id AND h.document_id = requested.document_id ORDER BY h.sequence LIMIT 1) AS earliest_sequence,
        (SELECT h.sequence FROM head_history h WHERE h.account_id = anchor.account_id AND h.document_id = requested.document_id AND h.sequence < anchor.sequence ORDER BY h.sequence DESC LIMIT 1) AS before_sequence,
        (SELECT h.revision_id FROM head_history h WHERE h.account_id = anchor.account_id AND h.document_id = requested.document_id AND h.sequence < anchor.sequence ORDER BY h.sequence DESC LIMIT 1) AS before_revision,
        (SELECT h.sequence FROM head_history h WHERE h.account_id = anchor.account_id AND h.document_id = requested.document_id AND h.sequence <= anchor.sequence ORDER BY h.sequence DESC LIMIT 1) AS after_sequence,
        (SELECT h.revision_id FROM head_history h WHERE h.account_id = anchor.account_id AND h.document_id = requested.document_id AND h.sequence <= anchor.sequence ORDER BY h.sequence DESC LIMIT 1) AS after_revision
      FROM anchor CROSS JOIN requested LEFT JOIN sync_documents d ON d.account_id = anchor.account_id AND d.document_id = requested.document_id ORDER BY requested.ordinal`).bind(principal.accountId, mutationId, JSON.stringify(documents)),
  ], context, 'AUTH_REQUIRED', false, false)
  const anchors = results[0].results as unknown as ReceiptRow[], predecessors = results[1].results as unknown as ReceiptRow[], history = results[2].results as unknown as HistoryRow[]
  const unavailable = (reason: 'unknown-mutation' | 'history-unavailable'): MutationTransitionResponse => ({ version: 1, kind: 'mutation-transition-unavailable', mutationId, reason })
  let response: MutationTransitionResponse = unavailable(anchors.length === 0 ? 'unknown-mutation' : 'history-unavailable')
  const receipt = anchors.length === 1 ? parseReceipt(anchors[0], principal.accountId) : null
  const previous = predecessors.length === 1 ? parseReceipt(predecessors[0], principal.accountId) : null
  if (receipt && receipt.mutationId === mutationId && (receipt.sequence === 1 ? predecessors.length === 0 : previous?.sequence === receipt.sequence - 1) && history.length === documents.length) {
    // Null requires a complete lifetime ledger: local checks cannot detect jointly deleted membership/history
    // Recovery must fence serving authority until the entire incarnation is restored coherently
    const valid = history.every((row, index) => {
      if (row.ordinal !== index || row.document_id !== documents[index]) return false
      if (row.first_sequence === null) return row.earliest_sequence === null && row.before_sequence === null && row.before_revision === null && row.after_sequence === null && row.after_revision === null
      if (!positiveSequence(row.first_sequence) || row.earliest_sequence !== row.first_sequence) return false
      const boundary = (sequence: number | null, revision: string | null, limit: number) => row.first_sequence! > limit
        ? sequence === null && revision === null
        : positiveSequence(sequence) && sequence >= row.first_sequence! && sequence <= limit && OpaqueIdSchema.safeParse(revision).success
      // Strict-before and inclusive-after preserve unchanged guards and later publications
      return boundary(row.before_sequence, row.before_revision, receipt.sequence - 1) && boundary(row.after_sequence, row.after_revision, receipt.sequence)
    })
    if (valid) {
      const candidate = MutationTransitionResponseSchema.safeParse({ version: 1, kind: 'mutation-transition', accountId: principal.accountId, mutationId, requestDigest: anchors[0].digest, receipt, previousPublicationEpoch: previous?.publicationEpoch ?? 0, documents: history.map(row => ({ documentId: row.document_id, before: row.before_revision, after: row.after_revision })) })
      if (candidate.success && encodedBytes(candidate.data) <= maxMutationTransitionResponseBytes) response = candidate.data
    }
  }
  context.checkpoint('sync.transition.before-authority')
  // Captured principals cannot outlive revocation during the historical observation
  await syncBatch(principal, '1', [], [], context, 'AUTH_REQUIRED', false, false)
  // A candidate denied by the final authority check was never a served outcome
  context.emit({ operation: 'sync', stage: 'mutation-transition', mutationId, durationMs: Math.max(0, performance.now() - started), bytes: encodedBytes(response), ...(response.kind === 'mutation-transition-unavailable' && response.reason === 'history-unavailable' ? { code: 'INTEGRITY_FAILED' } : {}) })
  return response
}
