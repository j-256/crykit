import { z } from 'zod'
import { assertActiveProfile, type ProfileToken } from '../account/profile'
import type { AccountDatabase, CipherRef, EncryptedSyncState, PreparedLocalActivation } from '../persistence/account-database'
import { jsonEqual } from '../persistence/local-data'
import { NATIVE_BACKUP_JSON_LIMITS, parseBoundedJson } from '../interchange/json'
import { cipherRef, readAccountRecordBytes, CipherRefSchema } from './account-cache'
import { AccountWorkspaceRootSchema, AccountWorkspaceRootV2Schema, sourceViewSchema } from './account-graph'
import { AccountMappingOriginSchema, accountMappingRootKey, readIncrementalMappedRoot } from './account-mapping-origin'
import { readIncrementalAccountEvidence } from './account-local-mapping'
import { LocalWorkspaceRootV3Schema } from './local-root'
import { sameCipherRefs } from './account-retaining'
import { GuestCopyJournalSchema } from './guest-copy-journal'
import { mergeObservationBudget, mergeRecordEqual, uniqueMergeRecords, type MergeCipherObservation } from './signin-merge-observations'
import type { SigninMergeManifest } from './signin-merge-protocol'

const sourceContextSchema = z.strictObject({ version: z.literal(1), kind: z.literal('local-source-context'), source: CipherRefSchema, index: CipherRefSchema })
const mismatch = () => new Error('SIGNIN_RECEIPT_MISMATCH')
export async function validateMergeInstallation(database: AccountDatabase, token: ProfileToken, manifest: SigninMergeManifest) {
  const all = uniqueMergeRecords([...manifest.output, ...manifest.consumed])
  if (all.length !== manifest.output.length + manifest.consumed.length) throw mismatch()
  mergeObservationBudget(all)
  const records = new Map(all.map(record => [record.revisionId, record])), output = new Set(manifest.output.map(record => record.revisionId))
  const get = (ref: CipherRef) => {
    const record = records.get(ref.revisionId)
    if (!record || record.descriptor.documentId !== ref.documentId || record.descriptor.accountId !== token.accountId) throw mismatch()
    return record
  }
  const read = async <T>(ref: CipherRef, schema: z.ZodType<T>): Promise<T> => {
    const bytes = await readAccountRecordBytes(database, token, ref, get(ref))
    try { return schema.parse(parseBoundedJson(bytes, 'merge structural record', NATIVE_BACKUP_JSON_LIMITS)) } finally { bytes.fill(0) }
  }
  function reach(roots: readonly CipherRef[], destination: Set<string>, allowed: 'source' | 'all') {
    const pending = [...roots], queued = new Set(roots.map(ref => ref.revisionId))
    while (pending.length) {
      const ref = pending.pop()!, record = get(ref)
      if (allowed === 'source' && output.has(ref.revisionId)) throw mismatch()
      if (destination.has(ref.revisionId)) continue
      destination.add(ref.revisionId)
      for (const dependency of record.descriptor.dependencies) { get(dependency); if (!queued.has(dependency.revisionId)) { queued.add(dependency.revisionId); pending.push(dependency) } }
    }
  }
  for (const record of manifest.consumed) {
    const actual = await database.encryptedRevisions.get(record.revisionId)
    if (!actual || !mergeRecordEqual(actual, record)) throw mismatch()
  }
  for (const record of manifest.output) if (await database.encryptedRevisions.get(record.revisionId) || await database.encryptedRevisions.where('payloadId').equals(record.payloadId).count()) throw mismatch()
  const rows = new Map(manifest.sourceRows.map(row => [row.id, row.expected]))
  if (rows.size !== manifest.sourceRows.length) throw mismatch()
  for (const [id, expected] of rows) if (expected && expected.id !== id || !jsonEqual(await database.syncState.get(id) ?? null, expected)) throw mismatch()
  const selected = manifest.destination.selected, admitted = new Set<string>()
  reach([selected.head, manifest.destination.projection.ref], admitted, 'source')
  const selectedBytes = await read(selected.head, z.unknown())
  const local = LocalWorkspaceRootV3Schema.safeParse(selectedBytes)
  if (!local.success) z.union([AccountWorkspaceRootSchema, AccountWorkspaceRootV2Schema]).parse(selectedBytes)
  let native = selected.head
  if (local.success) {
    const id = accountMappingRootKey(selected.head), row = rows.get(id)
    if (!row) throw mismatch()
    const mapped = await readIncrementalMappedRoot(database, token, selected)
    if (!mapped) throw mismatch()
    native = mapped; reach([row.ref, native], admitted, 'source'); rows.delete(id)
    const evidenceId = `incremental-evidence:${local.data.inheritedEvidence.revisionId}`
    if (!rows.has(evidenceId)) throw mismatch()
    const evidenceRow = rows.get(evidenceId)
    if (evidenceRow) {
      const mappedEvidence = await readIncrementalAccountEvidence(database, token, local.data.inheritedEvidence)
      if (!mappedEvidence) throw mismatch()
      reach([evidenceRow.ref, mappedEvidence], admitted, 'source')
    }
    rows.delete(evidenceId)
  }
  if (!jsonEqual(manifest.sourceRoots, [selected.head, native])) throw mismatch()
  // Source associations are edges from already admitted predecessor roots, never arbitrary extra roots
  // Iterate because a validated source-view can expose another checkpoint whose association follows it
  while (rows.size) {
    let advanced = false
    for (const [id, expected] of rows) {
      const prefix = id.startsWith('source-view:') ? 'source-view:' : id.startsWith('source-context:') ? 'source-context:' : undefined
      if (!prefix) throw mismatch()
      const source = records.get(id.slice(prefix.length))
      if (!source || !admitted.has(source.revisionId)) continue
      if (expected) {
        if (prefix === 'source-view:') {
          const wrapper = await read(expected.ref, sourceViewSchema)
          if (!jsonEqual(wrapper.source, cipherRef(source)) || !sameCipherRefs(get(expected.ref).descriptor.dependencies, [wrapper.source, wrapper.view])) throw mismatch()
          const original = await read(wrapper.source, AccountWorkspaceRootSchema), view = await read(wrapper.view, AccountWorkspaceRootSchema)
          if (view.sourceEvidenceVersion !== 1 || view.lineageId !== original.lineageId || view.localRevision !== original.localRevision || view.localUpdatedAt !== original.localUpdatedAt || !jsonEqual(view.selections, original.selections)) throw mismatch()
        } else {
          const wrapper = await read(expected.ref, sourceContextSchema)
          if (!jsonEqual(wrapper.source, cipherRef(source)) || !sameCipherRefs(get(expected.ref).descriptor.dependencies, [wrapper.source, wrapper.index])) throw mismatch()
        }
        reach([expected.ref], admitted, 'source')
      }
      rows.delete(id); advanced = true
    }
    if (!advanced) throw mismatch()
  }
  for (const record of manifest.consumed) if (!admitted.has(record.revisionId)) throw mismatch()
  const persistent = new Set<string>()
  reach([manifest.journal, manifest.selectedTarget, ...(manifest.mappingOrigin ? [manifest.mappingOrigin.ref] : [])], persistent, 'all')
  for (const record of manifest.output) if (!persistent.has(record.revisionId)) throw mismatch()
  const journal = await read(manifest.journal, GuestCopyJournalSchema)
  if (journal.preview.copyId !== manifest.copyId || journal.preview.accountId !== token.accountId || !journal.preview.signin || !jsonEqual(journal.expected, selected) || !jsonEqual(journal.target, manifest.journalTarget) || !jsonEqual(journal.intent, manifest.intent)) throw mismatch()
  const target = await read(manifest.selectedTarget, z.unknown()), managed = LocalWorkspaceRootV3Schema.safeParse(target).success
  if (!managed) z.union([AccountWorkspaceRootSchema, AccountWorkspaceRootV2Schema]).parse(target)
  if (journal.version === 2 && (!managed || manifest.intentStatus !== 'unmapped-local' || !jsonEqual(manifest.journalTarget, manifest.selectedTarget) || manifest.mappingOrigin)) throw mismatch()
  if (journal.version === 1 && manifest.intentStatus !== 'mapped-local') throw mismatch()
  if (managed && journal.version === 1) {
    const row = manifest.mappingOrigin
    if (!row || row.id !== accountMappingRootKey(manifest.selectedTarget) || await database.syncState.get(row.id)) throw mismatch()
    const origin = await read(row.ref, AccountMappingOriginSchema)
    if (origin.accountId !== token.accountId || origin.operationId !== manifest.copyId || origin.headRevision !== selected.headRevision + 1 || !jsonEqual(origin.localRoot, manifest.selectedTarget) || !jsonEqual(origin.mappedRoot, manifest.journalTarget) || !sameCipherRefs(get(row.ref).descriptor.dependencies, [manifest.selectedTarget, manifest.journalTarget])) throw mismatch()
  } else if (!managed && (local.success || manifest.mappingOrigin || !jsonEqual(manifest.selectedTarget, manifest.journalTarget))) throw mismatch()
  return { managed, journal, records: all }
}

export interface MergeInstallationProof {
  readonly database: AccountDatabase; readonly token: ProfileToken; readonly prepared: PreparedLocalActivation; readonly managed: boolean
  readonly observations: readonly MergeCipherObservation[]; readonly rows: readonly { readonly id: string; readonly expected: EncryptedSyncState | null }[]
  readonly association?: EncryptedSyncState; readonly projection: EncryptedSyncState
  check(): void
  recheckInTransaction(): Promise<void>
}

// This module validates data only; authority is issued privately by the client after its transaction
// Keep the receipt registry in that issuer, so no public function can bless manifest-shaped input
export function assertMergeProofEnvelope(proof: MergeInstallationProof, database: AccountDatabase, token: ProfileToken, prepared: PreparedLocalActivation) {
  assertActiveProfile(token); proof.check()
  const plain = (value: PreparedLocalActivation) => ({ ...value, managedAdmission: undefined, preparationAdmission: undefined, validatedEvidence: undefined })
  if (proof.database !== database || proof.token !== token || !jsonEqual(plain(proof.prepared), plain(prepared))) throw mismatch()
}
