import { prepareSelectedV1Check } from './account-selection'
import { AccountMappingOriginSchema, IncrementalWorkspaceIntentSchema, accountMappingRootKey } from './account-mapping-origin'
import { blobIdentity, memoryBlob, readBlob } from './blobs'
import { assertActiveProfile, profileSignal, registerProfileCleanup, withAccountKey, type ProfileToken } from '../account/profile'
import type { Transaction } from 'dexie'
import type { AccountDatabase, AccountFence, CipherChunk, CipherRecord, EncryptedSyncState, PreparedLocalActivation } from '../persistence/account-database'
import { encryptRevision } from '../account/crypto/revisions'
import { accountLocalId, cipherRef } from './account-cache'
import { createAccountPreparationOwner } from './account-prepared-records'
import { openAccountSource, openPreparedAccountSource, stageAccountSource } from './account-streams'
import { admitLocalRoot, admittedLocalReferences, type AdmittedLocalSnapshot, type CapturedLocalLifetime, type LocalStoreAdapter, type LocalRecordRef } from './local-root'
import { readLocalEvidence } from './local-evidence'
import { mergeGuestEvidence, validateGuestCurrentBodies } from './guest-evidence'
import { parseBoundedJson } from '../interchange/json'
import { encodeBytes, getSodium } from '../account/crypto/sodium'
import { maxDocumentBytes, RevisionDescriptorSchema, streamOverheadBytes } from '../account/protocol'

const INLINE_OPERATION_BYTES = 4 * 1024 * 1024
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
interface Observation { readonly record: CipherRecord; readonly chunks: readonly CipherChunk[] }
interface Admission {
  readonly database: AccountDatabase; readonly token: ProfileToken; readonly prepared: PreparedLocalActivation
  readonly legacy?: Awaited<ReturnType<typeof prepareSelectedV1Check>>; readonly association?: EncryptedSyncState
  readonly observations: readonly Observation[]; readonly retained: ReadonlySet<string>; readonly inline: readonly Observation[]; readonly check: () => void; readonly projection?: EncryptedSyncState
}
const admissions = new WeakMap<object, Admission>()

// Only an exact preparation made by this adapter can replace full unrelated-root admission
// The existing activation transaction still owns the selected fence, dependency and source checks
export function accountLocalActivationCheck(database: AccountDatabase, token: ProfileToken, prepared: PreparedLocalActivation) {
  const admission = prepared.managedAdmission && admissions.get(prepared.managedAdmission)
  if (!admission || admission.database !== database || admission.token !== token) throw new Error('Unadmitted managed account activation')
  const plain = (value: PreparedLocalActivation) => ({ ...value, managedAdmission: undefined })
  if (!same(plain(admission.prepared), plain(prepared))) throw new Error('Managed account activation changed')
  admission.check()
  return {
    hasInlineRecord(record: CipherRecord) { return admission.inline.some(value => same(value.record, record)) },
    preparedDependency(ref: LocalRecordRef) { return admission.prepared.records.some(record => record.revisionId === ref.revisionId && record.descriptor.documentId === ref.documentId) },
    async installInlineInTransaction() {
      admission.check()
      // Candidate payload IDs become owned only in the same transaction that publishes the root
      // Collision failure rolls back every insertion and never acquires cleanup rights over old bytes
      for (const { record, chunks } of admission.inline) {
        if (await database.stagedCipherChunks.where('payloadId').equals(record.payloadId).count()
          || await database.encryptedRevisions.where('payloadId').equals(record.payloadId).count()) throw new Error('Encrypted payload identity was reused')
        await database.stagedCipherChunks.bulkAdd(chunks)
      }
      admission.check()
    },
    isUnchangedDependency(ref: LocalRecordRef) { admission.check(); return admission.retained.has(blobIdentity(ref)) },
    async recheckInTransaction() {
      admission.check()
      if (!same(await database.syncState.get('projection'), admission.projection)) throw new Error('Managed publication base changed')
      await admission.legacy?.recheckInTransaction()
      if (admission.association) {
        if (await database.syncState.get(admission.association.id)) throw new Error('Managed mapping origin was reused')
        await database.syncState.add(admission.association)
      }
      for (const { record, chunks } of admission.observations) {
        const actualRecord = await database.encryptedRevisions.get(record.revisionId)
        // Schema parsing normalizes field order without dropping any authenticated descriptor field
        const normalized = (value: CipherRecord) => ({ ...value, descriptor: RevisionDescriptorSchema.parse(value.descriptor) })
        if (!actualRecord || !same(normalized(actualRecord), normalized(record))) throw new Error('Consumed encrypted descriptor changed')
        for (const captured of chunks) {
          const actual = await database.stagedCipherChunks.get([captured.payloadId, captured.index])
          if (!actual || actual.bytes.length !== captured.bytes.length || actual.bytes.some((byte, index) => byte !== captured.bytes[index])) throw new Error('Consumed encrypted bytes changed')
        }
      }
      admission.check()
    },
    async recheckSourceCapturesInTransaction() { admission.check(); await admission.legacy?.recheckSourceCapturesInTransaction() },
  }
}

export function createAccountLocalStore(database: AccountDatabase, token: ProfileToken) {
  let closed = false
  const check = () => { assertActiveProfile(token); if (closed) throw new Error('Managed account store is closed'); if (database.accountId !== token.accountId) throw new Error('Wrong managed account') }
  const owner = createAccountPreparationOwner(database, token)
  const inline = new Map<string, Observation>()
  const pending = new Map<string, CipherRecord[]>(), observations = new Map<string, Observation>()
  const lifetime: CapturedLocalLifetime = { check, assertCurrent: async () => check() }
  const capture = async (record: CipherRecord): Promise<Observation> => {
    const chunks: CipherChunk[] = [], sodium = await getSodium()
    for (const part of record.descriptor.chunks) {
      const chunk = await database.stagedCipherChunks.get([record.payloadId, part.index]); check()
      if (!chunk || chunk.bytes.length !== part.cipherBytes || encodeBytes(sodium, sodium.crypto_hash_sha256(chunk.bytes)) !== part.cipherDigest) throw new Error('Managed encrypted chunk is missing or changed')
      chunks.push(chunk)
    }
    return { record, chunks }
  }
  const adapter: LocalStoreAdapter = {
    async stage(operationId, source, dependencies, previous) {
      check()
      const own = pending.get(operationId) ?? []
      const heldBytes = own.reduce((sum, record) => sum + (inline.get(record.revisionId)?.chunks.reduce((bytes, chunk) => bytes + chunk.bytes.length, 0) ?? 0), 0)
      let record: CipherRecord
      if (heldBytes + source.byteLength + streamOverheadBytes <= INLINE_OPERATION_BYTES) {
        const payloadId = accountLocalId(), documentId = previous?.documentId ?? accountLocalId(), chunks: CipherChunk[] = []
        async function* captured() { for await (const bytes of source.open()) { check(); yield bytes; check() } }
        const encrypted = await withAccountKey(token, key => encryptRevision(key, { format: 1, accountId: token.accountId, documentId, revisionId: accountLocalId(), parents: previous ? [previous.revisionId] : [], dependencies, protected: true, plainBytes: source.byteLength }, accountLocalId(), captured(), {
          id: payloadId, async write(index, bytes) { check(); chunks.push({ payloadId, index, bytes: bytes.slice() }) },
        }))
        check(); record = { revisionId: encrypted.descriptor.revisionId, payloadId, descriptor: encrypted.descriptor }
        if (inline.has(record.revisionId) || [...inline.values()].some(value => value.record.payloadId === payloadId)) throw new Error('Prepared ciphertext identity was reused')
        inline.set(record.revisionId, { record, chunks })
      } else {
        // Large preparation retains the existing durable staging and allocation cleanup protocol
        record = await stageAccountSource(database, token, source, dependencies, previous, undefined, owner)
        observations.set(record.revisionId, await capture(record))
      }
      check(); pending.set(operationId, [...own, record])
      return cipherRef(record)
    },
    async read(ref) {
      check()
      const prepared = inline.get(ref.revisionId)
      if (prepared) {
        if (prepared.record.descriptor.documentId !== ref.documentId) throw new Error('Prepared ciphertext identity changed')
        return openPreparedAccountSource(token, prepared.record, prepared.chunks, owner)
      }
      return openAccountSource(database, token, ref, owner, undefined, (record, chunks) => {
        // Capture the ciphertext actually authenticated by this read, without reading it again
        check(); observations.set(record.revisionId, { record, chunks })
      })
    },
  }
  const unregister = registerProfileCleanup(token, () => { closed = true; pending.clear(); inline.clear(); observations.clear(); void owner.abandon().catch(() => {}) })
  async function prepareActivation(operationId: string, result: { readonly head: LocalRecordRef; readonly snapshot: AdmittedLocalSnapshot }, expected: AccountFence | undefined, previous?: AdmittedLocalSnapshot, intent?: LocalRecordRef, projection?: EncryptedSyncState, legacy?: Awaited<ReturnType<typeof prepareSelectedV1Check>>, association?: EncryptedSyncState, additional?: Pick<PreparedLocalActivation, 'records' | 'intentStatus' | 'requireSettledSync'>, saved = false): Promise<PreparedLocalActivation> {
    check()
    admittedLocalReferences(result.snapshot, adapter)
    if (!same(result.head, result.snapshot.head) || expected && !legacy && (!previous || !same(previous.head, expected.head))) throw new Error('Managed account predecessor changed')
    // Only immutable references admitted under the exact predecessor can skip unrelated reads
    // Consumed records still recheck their actual ciphertext, and activation retains the head CAS
    const retained = new Set(previous ? admittedLocalReferences(previous, adapter) : [])
    for (const observation of observations.values()) retained.delete(blobIdentity(cipherRef(observation.record)))
    const records = [...(pending.get(operationId) ?? []), ...(additional?.records ?? [])]
    if (!records.some(record => blobIdentity(cipherRef(record)) === blobIdentity(result.head))
      && !(saved && observations.has(result.head.revisionId) && !records.length)) throw new Error('Managed account operation lacks its root')
    const managedAdmission = Object.freeze({})
    const prepared: PreparedLocalActivation = { version: 1, id: operationId, expected, head: result.head, ...(intent ? { intent } : {}), intentStatus: additional?.intentStatus ?? 'unmapped-local', ...(additional?.requireSettledSync ? { requireSettledSync: true } : {}), records: structuredClone(records), managedAdmission }
    admissions.set(managedAdmission, { database, token, prepared: structuredClone({ ...prepared, managedAdmission: undefined }), observations: [...observations.values()], inline: records.flatMap(record => inline.get(record.revisionId) ?? []), retained, check, legacy, association: association && structuredClone(association), projection: projection && structuredClone(projection) })
    return prepared
  }
  async function persistOperation(operationId: string, writeJournal: () => Promise<void>, assertMayPersist: () => void): Promise<void> {
    check(); assertMayPersist()
    const records = pending.get(operationId)
    if (!records?.length) throw new Error('No managed preparation is available to persist')
    const signal = profileSignal(token)
    let transaction: Transaction | undefined
    const abort = () => transaction?.abort()
    signal.addEventListener('abort', abort, { once: true })
    try {
      // Payloads and the recovery pointer publish together, without selecting a root or adding an outbox row
      // A failed transaction leaves the previous workspace selected and gives cleanup no rights over older records
      await database.transaction('rw', database.tables, async current => {
        transaction = current
        check(); assertMayPersist()
        for (const record of records) {
          if (await database.encryptedRevisions.get(record.revisionId)) throw new Error('Managed staging identity was reused')
          const held = inline.get(record.revisionId)
          if (held) {
            if (await database.stagedCipherChunks.where('payloadId').equals(record.payloadId).count()
              || await database.encryptedRevisions.where('payloadId').equals(record.payloadId).count()) throw new Error('Encrypted payload identity was reused')
            await database.stagedCipherChunks.bulkAdd(held.chunks)
          }
          for (const chunk of record.descriptor.chunks) {
            const stored = await database.stagedCipherChunks.get([record.payloadId, chunk.index])
            if (!stored || stored.bytes.length !== chunk.cipherBytes) throw new Error('Managed staging is incomplete')
          }
          await database.encryptedRevisions.add(record)
        }
        for (const record of records) for (const ref of record.descriptor.dependencies) {
          const dependency = await database.encryptedRevisions.get(ref.revisionId)
          if (!dependency || dependency.descriptor.documentId !== ref.documentId || dependency.descriptor.accountId !== token.accountId) throw new Error('Managed staging dependency is missing')
        }
        if (pending.get(operationId) !== records) throw new Error('Managed preparation changed while staging')
        await writeJournal()
        check(); assertMayPersist()
      })
    } finally { signal.removeEventListener('abort', abort) }
    // Preserve this producer's exact ciphertext observations through immediate activation
    // A restarted caller has no such authority and must fully reopen its saved target instead
    for (const record of records) {
      const held = inline.get(record.revisionId)
      if (held) observations.set(record.revisionId, held)
      inline.delete(record.revisionId)
    }
    pending.delete(operationId)
  }
  // Stored targets need exact observations from this adapter, either retained from its producer
  // or authenticated by a full durable reopen; their activation still uses the same private admission and CAS
  async function preparePersistedActivation(operationId: string, result: { readonly head: LocalRecordRef; readonly snapshot: AdmittedLocalSnapshot }, expected: AccountFence, previous: AdmittedLocalSnapshot, intent: LocalRecordRef, projection?: EncryptedSyncState) {
    return prepareActivation(operationId, result, expected, previous, intent, projection, undefined, undefined, undefined, true)
  }
  async function prepareSavedActivation(operationId: string, head: LocalRecordRef, intentRef: LocalRecordRef, input: AccountFence) {
    const expected = structuredClone(input), target = structuredClone(head), intent = structuredClone(intentRef)
    const assertCurrent = async () => { check(); if (!same(await database.profileMeta.get('active'), expected)) throw new Error('The saved copy destination changed'); check() }
    await assertCurrent()
    const before = await admitLocalRoot(adapter, expected.head, { check, assertCurrent })
    const selected = await admitLocalRoot(adapter, target, { check, assertCurrent })
    const previousEvidence = await readLocalEvidence(adapter, before.root.inheritedEvidence, assertCurrent)
    const evidence = await readLocalEvidence(adapter, selected.root.inheritedEvidence, assertCurrent)
    if (previousEvidence) {
      if (!evidence || (await mergeGuestEvidence(previousEvidence, evidence, evidence.planner)).setDigest !== evidence.setDigest) throw new Error('The saved copy discarded inherited originals')
    }
    if (evidence) await validateGuestCurrentBodies(selected.state, evidence)
    const bytes = await readBlob(await adapter.read(intent), maxDocumentBytes)
    let value: ReturnType<typeof IncrementalWorkspaceIntentSchema.parse>
    try { value = IncrementalWorkspaceIntentSchema.parse(parseBoundedJson(bytes, 'saved managed intent')) }
    finally { bytes.fill(0) }
    const projection = await database.syncState.get('projection')
    if (value.operationId !== operationId || !same(value.before, expected.head) || !same(value.after, target)
      || value.sequence !== expected.headRevision + 1 || value.operation !== 'workspace-command' || value.mode !== 'additive'
      || !same(value.publicationBase, projection?.ref)) throw new Error('The saved copy intent or publication base changed')
    await assertCurrent()
    // A restarted operation has lost producer authority and must authenticate its complete durable target
    // Ciphertext observations remain bound to this adapter and are rechecked in the selected-head CAS
    const prepared = await preparePersistedActivation(operationId, { head: target, snapshot: selected }, expected, before, intent, projection)
    return { prepared, snapshot: selected }
  }
  async function prepareLegacyActivation(operationId: string, result: { readonly head: LocalRecordRef; readonly snapshot: AdmittedLocalSnapshot }, expected: AccountFence): Promise<PreparedLocalActivation> {
    const predecessor = structuredClone(expected)
    check()
    // Only this bulk entrypoint admits a native predecessor; ordinary saves still require an admitted v3 view
    // The old selected codec and source-view associations retain their native transactional rechecks
    const legacy = await prepareSelectedV1Check(database, token, { head: predecessor.head, records: [] })
    const projection = await database.syncState.get('projection')
    const origin = AccountMappingOriginSchema.parse({ version: 1, kind: 'incremental-mapping-origin', accountId: token.accountId, operationId, localRoot: result.head, mappedRoot: predecessor.head, headRevision: predecessor.headRevision + 1 })
    const bytes = new TextEncoder().encode(JSON.stringify(origin))
    let ref: LocalRecordRef
    try { ref = await adapter.stage(operationId, memoryBlob(bytes), [result.head, predecessor.head]) } finally { bytes.fill(0) }
    return prepareActivation(operationId, result, predecessor, undefined, undefined, projection, legacy, { id: accountMappingRootKey(result.head), ref })
  }
  async function prepareMappedActivation(operationId: string, result: { readonly head: LocalRecordRef; readonly snapshot: AdmittedLocalSnapshot }, expected: AccountFence, previous: AdmittedLocalSnapshot, native: import('./account-graph').PreparedAccountWorkspace, intent?: { readonly ref: LocalRecordRef; readonly records: readonly CipherRecord[] }, requireSettledSync?: true): Promise<PreparedLocalActivation> {
    check()
    const selection = await prepareSelectedV1Check(database, token, native)
    const projection = await database.syncState.get('projection')
    const origin = AccountMappingOriginSchema.parse({ version: 1, kind: 'incremental-mapping-origin', accountId: token.accountId, operationId, localRoot: result.head, mappedRoot: native.head, headRevision: expected.headRevision + 1 })
    const bytes = new TextEncoder().encode(JSON.stringify(origin))
    let ref: LocalRecordRef
    try { ref = await adapter.stage(operationId, memoryBlob(bytes), [result.head, native.head]) } finally { bytes.fill(0) }
    // Native projection and managed selection publish together; the existing native/source checks remain mandatory
    // The exact association survives removal of a completed outbox row and supplies the next local command's base
    return prepareActivation(operationId, result, expected, previous, intent?.ref, projection, selection, { id: accountMappingRootKey(result.head), ref }, { records: [...native.records, ...(intent?.records ?? [])], intentStatus: 'mapped-local', ...(requireSettledSync ? { requireSettledSync } : {}) })
  }
  return { adapter, lifetime, persistOperation, prepareSavedActivation, preparePersistedActivation, prepareActivation: (operationId: string, result: { readonly head: LocalRecordRef; readonly snapshot: AdmittedLocalSnapshot }, expected: AccountFence | undefined, previous?: AdmittedLocalSnapshot, intent?: LocalRecordRef, projection?: EncryptedSyncState) => prepareActivation(operationId, result, expected, previous, intent, projection), prepareLegacyActivation, prepareMappedActivation, committed(operationId: string) { check(); for (const record of pending.get(operationId) ?? []) inline.delete(record.revisionId); pending.delete(operationId); observations.clear() }, finishAdmission() { check(); observations.clear() }, async dispose() { unregister(); closed = true; pending.clear(); inline.clear(); observations.clear(); await owner.abandon() } }
}
