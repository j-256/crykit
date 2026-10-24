import Dexie, { type EntityTable, type Table, type Transaction } from 'dexie'
import { OpaqueIdSchema, RevisionDescriptorSchema, type RevisionDescriptor } from '../account/protocol'
import { assertActiveProfile, profileSignal, type ProfileToken } from '../account/profile'
import { WorkspaceError } from '../workspace/repository'

export interface CipherRef { readonly documentId: string; readonly revisionId: string }
export interface CipherChunk { readonly payloadId: string; readonly index: number; readonly bytes: Uint8Array }
export interface CipherRecord { readonly revisionId: string; readonly payloadId: string; readonly descriptor: RevisionDescriptor }
export interface EncryptedSyncState { readonly id: string; readonly ref: CipherRef }
export interface AccountFence { readonly key: 'active'; readonly headRevision: number; readonly head: CipherRef }
export interface AccountIntentRecord { readonly id: string; readonly ref: CipherRef; readonly status: 'unmapped-local' | 'mapped-local'; readonly publicationBase?: CipherRef }
export interface LocalActivationJournal { readonly id: string; readonly version: 1; readonly head: CipherRef; readonly headRevision: number; readonly intent?: CipherRef; readonly localStatus: 'active'; readonly cloudStatus: 'unmapped-local' | 'mapped-local' }

export class AccountDatabase extends Dexie {
  stagedCipherChunks!: Table<CipherChunk, [string, number]>
  encryptedRevisions!: EntityTable<CipherRecord, 'revisionId'>
  documentHeads!: EntityTable<CipherRef, 'documentId'>
  outbox!: EntityTable<AccountIntentRecord, 'id'>
  conflicts!: EntityTable<{ readonly id: string; readonly ref: CipherRef }, 'id'>
  syncState!: EntityTable<EncryptedSyncState, 'id'>
  profileMeta!: EntityTable<AccountFence, 'key'>
  migrationJournal!: EntityTable<LocalActivationJournal, 'id'>
  constructor(readonly accountId: string) {
    super(`crykit-account-v1-${accountId}`)
    OpaqueIdSchema.parse(accountId)
    this.version(1).stores({ stagedCipherChunks: '[payloadId+index], payloadId', encryptedRevisions: 'revisionId, payloadId', documentHeads: 'documentId', outbox: 'id', conflicts: 'id', profileMeta: 'key', migrationJournal: 'id' })
    // New opaque journal pointers leave the existing encrypted local cache and pending intents intact
    this.version(2).stores({ syncState: 'id' })
  }
}

export interface PreparedLocalActivation {
  readonly version: 1
  readonly id: string
  readonly expected: AccountFence | undefined
  readonly head: CipherRef
  readonly intent?: CipherRef
  readonly records: readonly CipherRecord[]
  readonly intentStatus?: 'unmapped-local' | 'mapped-local'
  readonly sourceCaptures?: readonly EncryptedSyncState[]
  readonly replaceIntents?: readonly { readonly expected: AccountIntentRecord; readonly replacement: AccountIntentRecord }[]
  readonly validatedEvidence?: import('../workspace/account-evidence-snapshots').AccountInheritedEvidence
  readonly requireSettledSync?: true
  readonly managedAdmission?: object
}

export async function activateLocalAccountCommit(database: AccountDatabase, token: ProfileToken, prepared: PreparedLocalActivation, assertMayActivate: () => void = () => {}): Promise<AccountFence> {
  assertActiveProfile(token)
  assertMayActivate()
  if (database.accountId !== token.accountId || prepared.version !== 1) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'The prepared operation belongs to another workspace.')
  // One captured envelope controls authentication, transaction writes and the returned fence
  const validatedEvidence = prepared.validatedEvidence, managedAdmission = prepared.managedAdmission
  prepared = { ...structuredClone({ ...prepared, validatedEvidence: undefined, managedAdmission: undefined }), ...(managedAdmission ? { managedAdmission } : {}) }
  OpaqueIdSchema.parse(prepared.id)
  for (const record of prepared.records) {
    RevisionDescriptorSchema.parse(record.descriptor)
    if (record.descriptor.accountId !== token.accountId || record.revisionId !== record.descriptor.revisionId) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'The encrypted record identity is invalid.')
  }
  const { prepareSelectedV1Check } = await import('../workspace/account-selection')
  const managedSelection = managedAdmission ? (await import('../workspace/account-local-store')).accountLocalActivationCheck(database, token, prepared) : undefined
  const selection = managedSelection ?? await prepareSelectedV1Check(database, token, { ...prepared, validatedEvidence })
  const signal = profileSignal(token)
  const fence: AccountFence = { key: 'active', headRevision: (prepared.expected?.headRevision ?? -1) + 1, head: prepared.head }
  if (!Number.isSafeInteger(fence.headRevision)) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'The local revision limit has been reached.')
  // All expensive preparation has finished; only IDB requests and captured-authority checks run here
  let pending: Transaction | undefined
  const abort = () => pending?.abort()
  signal.addEventListener('abort', abort, { once: true })
  try {
    await database.transaction('rw', database.tables, async transaction => {
      pending = transaction
      assertActiveProfile(token)
      const active = await database.profileMeta.get('active')
      if (JSON.stringify(active) !== JSON.stringify(prepared.expected)) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'This account changed in another tab. Reload before saving.')
      if (prepared.requireSettledSync && (await database.outbox.count() || await database.syncState.get('publication'))) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'Finish syncing before restoring this account.')
      await managedSelection?.installInlineInTransaction()
      for (const record of prepared.records) {
        for (const chunk of managedSelection?.hasInlineRecord(record) ? [] : record.descriptor.chunks) {
          const stored = await database.stagedCipherChunks.get([record.payloadId, chunk.index])
          if (!stored || stored.bytes.byteLength !== chunk.cipherBytes) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'Encrypted staging is incomplete. The previous save is unchanged.')
        }
        const existing = await database.encryptedRevisions.get(record.revisionId)
        if (existing) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'An encrypted revision identity was reused.')
        await database.encryptedRevisions.add(record)
      }
      // Exact dependencies include history and sources; no reference may publish before its ciphertext
      for (const record of prepared.records) for (const ref of record.descriptor.dependencies) {
        if (managedSelection?.isUnchangedDependency(ref) || managedSelection?.preparedDependency(ref)) continue
        const dependency = await database.encryptedRevisions.get(ref.revisionId)
        if (!dependency || dependency.descriptor.documentId !== ref.documentId || dependency.descriptor.accountId !== token.accountId) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'An encrypted dependency is missing.')
      }
      for (const ref of [prepared.head, ...(prepared.intent ? [prepared.intent] : [])]) {
        if (managedSelection?.preparedDependency(ref)) continue
        const record = await database.encryptedRevisions.get(ref.revisionId)
        if (!record || record.descriptor.documentId !== ref.documentId || record.descriptor.accountId !== token.accountId) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'A prepared head is not ready.')
      }
      for (const { expected, replacement } of prepared.replaceIntents ?? []) {
        const actual = await database.outbox.get(expected.id)
        if (JSON.stringify(actual) !== JSON.stringify(expected) || replacement.id !== expected.id || replacement.status !== 'mapped-local') throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'Pending workspace preparation changed. Retry from its original base.')
        const ready = await database.encryptedRevisions.get(replacement.ref.revisionId)
        if (!ready || ready.descriptor.documentId !== replacement.ref.documentId || ready.descriptor.accountId !== token.accountId) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'Mapped pending preparation is unavailable.')
        await database.outbox.put(replacement)
      }
      await selection.recheckInTransaction()
      for (const capture of prepared.sourceCaptures ?? []) {
        if ((!capture.id.startsWith('source-context:') && !capture.id.startsWith('source-view:')) || await database.syncState.get(capture.id)) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'The source migration context changed.')
        const ready = await database.encryptedRevisions.get(capture.ref.revisionId)
        if (!ready || ready.descriptor.documentId !== capture.ref.documentId) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'The source migration context is unavailable.')
        await database.syncState.add(capture)
      }
      await selection.recheckSourceCapturesInTransaction()
      assertActiveProfile(token)
      await database.documentHeads.put(prepared.head)
      if (prepared.intent) {
        // Capture authority with the local intent; a later pull cannot substitute its envelope parents
        const publicationBase = (await database.syncState.get('projection'))?.ref
        await database.outbox.add({ id: prepared.id, ref: prepared.intent, status: prepared.intentStatus ?? 'unmapped-local', ...(publicationBase ? { publicationBase } : {}) })
      }
      await database.migrationJournal.add({ version: 1, id: prepared.id, head: prepared.head, headRevision: fence.headRevision, ...(prepared.intent ? { intent: prepared.intent } : {}), localStatus: 'active', cloudStatus: prepared.intentStatus ?? 'unmapped-local' })
      assertMayActivate()
      await database.profileMeta.put(fence)
      assertActiveProfile(token)
      assertMayActivate()
    })
  } finally { signal.removeEventListener('abort', abort) }
  assertActiveProfile(token)
  return fence
}
