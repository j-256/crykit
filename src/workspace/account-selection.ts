import { z } from 'zod'
import { assertActiveProfile, type ProfileToken } from '../account/profile'
import { OpaqueIdSchema, RevisionDescriptorSchema } from '../account/protocol'
import type { AccountDatabase, CipherRecord, CipherRef, EncryptedSyncState } from '../persistence/account-database'
import { NATIVE_BACKUP_JSON_LIMITS, parseBoundedJson } from '../interchange/json'
import { AccountProjectionSchema, CipherRefSchema, readAccountRecordBytes } from './account-cache'
import { AccountWorkspaceRootSchema, AccountWorkspaceRootV2Schema, sourceViewSchema } from './account-graph'
import type { AccountInheritedEvidence } from './account-evidence-snapshots'
import { sameCipherRefs } from './account-retaining'
import { WorkspaceError } from './repository'

const selectedSchema = z.union([AccountProjectionSchema, AccountWorkspaceRootSchema, AccountWorkspaceRootV2Schema])
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const integrity = () => new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'The selected encrypted workspace changed or has an unsupported format.')

// This invocation authenticates captured format inputs only; unchanged descriptors do not
// prove ciphertext immutability or semantic equivalence of an older pending source view
export async function prepareSelectedV1Check(database: AccountDatabase, token: ProfileToken, input: { readonly head: CipherRef; readonly records: readonly CipherRecord[]; readonly sourceCaptures?: readonly EncryptedSyncState[]; readonly validatedEvidence?: AccountInheritedEvidence }): Promise<{ recheckInTransaction(): Promise<void>; recheckSourceCapturesInTransaction(): Promise<void> }> {
  const { validatedEvidence } = input
  const { head, records, sourceCaptures = [] } = structuredClone({ head: input.head, records: input.records, sourceCaptures: input.sourceCaptures })
  assertActiveProfile(token)
  if (database.accountId !== token.accountId) throw integrity()
  CipherRefSchema.parse(head)
  const fresh = new Map<string, CipherRecord>(), checked = new Map<string, CipherRecord>()
  const rows = new Map<string, EncryptedSyncState | undefined>()
  const captures = new Map<string, EncryptedSyncState>()
  function validate(record: CipherRecord, ref: CipherRef) {
    CipherRefSchema.parse(ref)
    OpaqueIdSchema.parse(record.payloadId)
    RevisionDescriptorSchema.parse(record.descriptor)
    if (record.revisionId !== ref.revisionId || record.descriptor.revisionId !== ref.revisionId || record.descriptor.documentId !== ref.documentId || record.descriptor.accountId !== token.accountId) throw integrity()
  }
  for (const record of records) {
    validate(record, { revisionId: record.revisionId, documentId: record.descriptor.documentId })
    if (fresh.has(record.revisionId)) throw integrity()
    fresh.set(record.revisionId, record)
  }
  // Even an identical installed row is not a fresh revision owned by this operation
  for (const record of records) if (await database.encryptedRevisions.get(record.revisionId)) throw integrity()
  for (const capture of sourceCaptures) {
    CipherRefSchema.parse(capture.ref)
    if (captures.has(capture.id)) throw integrity()
    captures.set(capture.id, capture)
    if (capture.id.startsWith('source-view:')) rows.set(capture.id, await database.syncState.get(capture.id))
  }
  async function resolve(ref: CipherRef): Promise<CipherRecord> {
    const record = checked.get(ref.revisionId) ?? fresh.get(ref.revisionId) ?? await database.encryptedRevisions.get(ref.revisionId)
    if (!record) throw integrity()
    validate(record, ref)
    checked.set(ref.revisionId, record)
    return record
  }
  async function read<T>(ref: CipherRef, schema: z.ZodType<T>): Promise<T> {
    const bytes = await readAccountRecordBytes(database, token, ref, await resolve(ref))
    try { return schema.parse(parseBoundedJson(bytes, 'encrypted local record', NATIVE_BACKUP_JSON_LIMITS)) }
    finally { bytes.fill(0) }
  }
  async function checkView(row: EncryptedSyncState, selected?: CipherRef) {
    const saved = await read(row.ref, sourceViewSchema)
    const record = await resolve(row.ref)
    if (row.id !== `source-view:${saved.source.revisionId}` || selected && !sameCipherRefs([saved.source], [selected]) || !sameCipherRefs(record.descriptor.dependencies, [saved.source, saved.view])) throw integrity()
    const source = await read(saved.source, AccountWorkspaceRootSchema)
    const view = await read(saved.view, AccountWorkspaceRootSchema)
    if (view.sourceEvidenceVersion !== 1 || view.lineageId !== source.lineageId || view.localRevision !== source.localRevision || view.localUpdatedAt !== source.localUpdatedAt || !same(view.selections, source.selections)) throw integrity()
  }
  const root = await read(head, selectedSchema)
  if (root.kind === 'local-workspace-graph' && root.version === 2) {
    if (root.sourceEvidenceVersion !== 1) throw integrity()
    if (validatedEvidence) {
      if (!same(root.inheritedEvidence, validatedEvidence.root)) throw integrity()
      const { assertAccountInheritedEvidenceOwner } = await import('./account-evidence-snapshots')
      await assertAccountInheritedEvidenceOwner(validatedEvidence, database, token)
    } else {
      if (fresh.has(root.inheritedEvidence.revisionId)) throw integrity()
      const { openAccountInheritedEvidence } = await import('./account-evidence-snapshots')
      const inherited = await openAccountInheritedEvidence(database, token, root.inheritedEvidence)
      try { await inherited.check() } finally { await inherited.dispose() }
    }
  }
  for (const capture of sourceCaptures) if (capture.id.startsWith('source-view:')) await checkView(capture)
  if (root.kind === 'local-workspace-graph' && root.sourceEvidenceVersion === undefined) {
    const id = `source-view:${head.revisionId}`
    // Absence is authority too: an asynchronously appearing row changes what the opener follows
    if (!rows.has(id)) rows.set(id, await database.syncState.get(id))
    const effective = captures.get(id) ?? rows.get(id)
    if (effective) await checkView(effective, head)
  }
  assertActiveProfile(token)
  return { async recheckInTransaction() {
    assertActiveProfile(token)
    // Call after fresh inserts but before source captures or selected pointers are published
    // Native IDB requests only: no crypto or callbacks may keep this transaction alive
    for (const [revisionId, record] of checked) if (!same(await database.encryptedRevisions.get(revisionId), record)) throw integrity()
    for (const [id, row] of rows) if (!same(await database.syncState.get(id), row)) throw integrity()
  }, async recheckSourceCapturesInTransaction() {
    // The published wrapper pointer must be the same association authenticated above
    for (const [id, capture] of captures) if (id.startsWith('source-view:') && !same(await database.syncState.get(id), capture)) throw integrity()
  } }
}
