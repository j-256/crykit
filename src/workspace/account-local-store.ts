import { consumeManagedMergeInstallation } from './signin-merge-client'
import { readManagedCopyComparisons } from './managed-copy-comparisons'
import { prepareSelectedV1Check } from './account-selection'
import { AccountMappingOriginSchema, IncrementalWorkspaceIntentSchema, accountMappingRootKey } from './account-mapping-origin'
import { blobIdentity, memoryBlob, readBlob } from './blobs'
import { assertActiveProfile, profileSignal, registerProfileCleanup, withAccountKey, type ProfileToken } from '../account/profile'
import type { Transaction } from 'dexie'
import type { AccountDatabase, AccountFence, CipherChunk, CipherRecord, EncryptedSyncState, PreparedLocalActivation } from '../persistence/account-database'
import { encryptRevision } from '../account/crypto/revisions'
import { accountLocalId, cipherRef } from './account-cache'
import { createAccountPreparationOwner, type AccountPreparationReservation } from './account-prepared-records'
import { openAccountSource, openPreparedAccountSource, stageAccountSource } from './account-streams'
import { LocalWorkspaceRootV3Schema, admitLocalRoot, admittedLocalReferences, type AdmittedLocalSnapshot, type CapturedLocalLifetime, type LocalStoreAdapter, type LocalRecordRef } from './local-root'
import { localEvidenceReadAdmission, localLegacyStreamBindings, prepareLocalEvidence, readLocalEvidence } from './local-evidence'
import type { AccountInheritedEvidencePreparation, PreparedAccountInheritedEvidence } from './account-evidence-snapshots'
import { mergeGuestEvidence, validateGuestCurrentBodies, type CapturedGuestEvidence } from './guest-evidence'
import { NATIVE_BACKUP_JSON_LIMITS, parseBoundedJson } from '../interchange/json'
import { encodeBytes, getSodium } from '../account/crypto/sodium'
import { maxDocumentBytes, streamOverheadBytes } from '../account/protocol'
import { recheckCiphertextObservations, sameCipherRecord, sameObservation, type Observation } from './account-ciphertext-observations'

const INSTALLED_EVIDENCE_BATCH = 64
const INLINE_OPERATION_BYTES = 4 * 1024 * 1024
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

interface Admission {
  readonly database: AccountDatabase; readonly token: ProfileToken; readonly prepared: PreparedLocalActivation
  readonly bridge?: { recheckInTransaction(): Promise<void> }
  readonly legacy?: Awaited<ReturnType<typeof prepareSelectedV1Check>>; readonly disposeLegacy?: () => Promise<void>; readonly association?: EncryptedSyncState
  readonly observations: readonly Observation[]; readonly retained: ReadonlySet<string>; readonly inline: readonly Observation[]; readonly check: () => void; readonly projection?: EncryptedSyncState
}
const admissions = new WeakMap<object, Admission>()
interface EvidenceReuse {
  readonly adapter: LocalStoreAdapter; readonly previous: CapturedGuestEvidence
  readonly admission: ReturnType<typeof localEvidenceReadAdmission>
  assert(): void; check(): Promise<void>
}
const evidenceReuses = new WeakMap<object, EvidenceReuse>()
// Only the installed-store issuer below can mint this operation-scoped proof
// The dynamic consumer avoids a static local-evidence/store initialization cycle
export function resolveLocalEvidenceReuse(adapter: LocalStoreAdapter, handle: object) {
  const proof = evidenceReuses.get(handle)
  if (!proof || proof.adapter !== adapter) throw new Error('Unadmitted installed evidence reuse')
  proof.assert()
  return proof
}
type InstalledLegacyStream = ReturnType<typeof localLegacyStreamBindings>[number]
interface CapturedMappingEvidence {
  readonly evidence: CapturedGuestEvidence
  prepare(): Promise<PreparedAccountInheritedEvidence & { recheckAssociationInTransaction(): Promise<void> }>
}
type CaptureMappingEvidence = (local: AdmittedLocalSnapshot, check: () => Promise<void>) => Promise<CapturedMappingEvidence | undefined>
const mappingStores = new WeakMap<object, { database: AccountDatabase; token: ProfileToken; capture: CaptureMappingEvidence }>()

export async function captureAccountMappingEvidence(database: AccountDatabase, token: ProfileToken, store: object, local: AdmittedLocalSnapshot, check: () => Promise<void>) {
  const issuer = mappingStores.get(store)
  if (issuer?.database !== database || issuer.token.accountId !== token.accountId || issuer.token.generation !== token.generation) throw new Error('Foreign mapping store')
  return issuer.capture(local, check)
}

interface InstalledMappingProof {
  member(id: string): InstalledLegacyStream | undefined
  checkObservation(ref: LocalRecordRef, observed: Observation | undefined): void
}
const mappingProofs = new WeakMap<object, { database: AccountDatabase; token: ProfileToken; evidence: CapturedGuestEvidence; proof: InstalledMappingProof }>()

// Only the single-use native preparation can claim its own registration
// Neither a captured sidecar nor a structurally similar preparation carries these rights
export function claimInstalledMappingProof(operation: object, database: AccountDatabase, token: ProfileToken, evidence: CapturedGuestEvidence) {
  const entry = mappingProofs.get(operation)
  if (!entry) return undefined
  mappingProofs.delete(operation)
  if (entry.database !== database || entry.token.accountId !== token.accountId || entry.token.generation !== token.generation || entry.evidence !== evidence) throw new Error('Foreign installed mapping proof')
  return entry.proof
}

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
      // These independent collision reads share the activation transaction's snapshot
      // Issue them before inserting payloads so per-record callbacks do not serialize independent checks
      const payloadIds = admission.inline.map(({ record }) => record.payloadId)
      if (new Set(payloadIds).size !== payloadIds.length) throw new Error('Encrypted payload identity was reused')
      const collisions = await Promise.all(payloadIds.map(payloadId => Promise.all([
        database.stagedCipherChunks.where('payloadId').equals(payloadId).count(),
        database.encryptedRevisions.where('payloadId').equals(payloadId).count(),
      ])))
      if (collisions.some(counts => counts.some(count => count > 0))) throw new Error('Encrypted payload identity was reused')
      await database.stagedCipherChunks.bulkAdd(admission.inline.flatMap(({ chunks }) => chunks))
      admission.check()
    },
    isUnchangedDependency(ref: LocalRecordRef) { admission.check(); return admission.retained.has(blobIdentity(ref)) },
    async recheckInTransaction() {
      admission.check()
      if (!same(await database.syncState.get('projection'), admission.projection)) throw new Error('Managed publication base changed')
      await admission.legacy?.recheckInTransaction()
      await admission.bridge?.recheckInTransaction()
      if (admission.association) {
        if (await database.syncState.get(admission.association.id)) throw new Error('Managed mapping origin was reused')
        await database.syncState.add(admission.association)
      }
      await recheckCiphertextObservations(database, admission.observations)
      admission.check()
    },
    async recheckSourceCapturesInTransaction() { admission.check(); await admission.legacy?.recheckSourceCapturesInTransaction() },
    async disposeSelection() { await admission.disposeLegacy?.() },
  }
}

// The issuer registry, not receipt fields, certifies the installed worker operation
export function admitInstalledMerge(database: AccountDatabase, token: ProfileToken, prepared: PreparedLocalActivation, receipt: object): PreparedLocalActivation {
  if (prepared.managedAdmission || prepared.preparationAdmission) throw new Error('SIGNIN_RECEIPT_MISMATCH')
  const proof = consumeManagedMergeInstallation(receipt, database, token, prepared), managedAdmission = Object.freeze({})
  const result = { ...prepared, managedAdmission }
  admissions.set(managedAdmission, { database, token, prepared: structuredClone(prepared), observations: [], retained: new Set(), inline: [], projection: proof.projection, check: proof.check, bridge: proof })
  return result
}

export function createAccountLocalStore(database: AccountDatabase, token: ProfileToken, reservation?: AccountPreparationReservation) {
  return createLocalStore(database, token, reservation, false)
}

// Only background mapping admits installed local rows for native historical reuse
export function createMappingAccountLocalStore(database: AccountDatabase, token: ProfileToken) {
  return createLocalStore(database, token, undefined, true)
}

function createLocalStore(database: AccountDatabase, token: ProfileToken, reservation: AccountPreparationReservation | undefined, mapping: boolean) {
  let closed = false
  const check = () => { assertActiveProfile(token); if (closed) throw new Error('Managed account store is closed'); if (database.accountId !== token.accountId) throw new Error('Wrong managed account') }
  const owner = createAccountPreparationOwner(database, token, reservation)
  const inline = new Map<string, Observation>()
  const pending = new Map<string, CipherRecord[]>(), observations = new Map<string, Observation>()
  const pinnedEvidence = new Set<string>()
  let evidenceGeneration = 0
  const clearEvidenceAdmission = () => { pinnedEvidence.clear(); observations.clear(); evidenceGeneration++ }
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
      if (!reservation && heldBytes + source.byteLength + streamOverheadBytes <= INLINE_OPERATION_BYTES) {
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
        check()
        const observed = { record, chunks }, previous = observations.get(record.revisionId)
        // A later successful decrypt must not replace the exact installed bytes admitted for reuse
        if (pinnedEvidence.has(record.revisionId) || mapping && previous) {
          if (!previous || !sameObservation(previous, observed)) throw new Error('Retained managed evidence observation changed')
          return
        }
        observations.set(record.revisionId, observed)
      })
    },
  }
  if (mapping) Object.freeze(adapter)
  async function captureMappingEvidence(local: AdmittedLocalSnapshot, checkpoint: () => Promise<void>) {
    admittedLocalReferences(local, adapter)
    const generation = evidenceGeneration
    const assert = () => { check(); if (generation !== evidenceGeneration) throw new Error('Installed mapping proof expired') }
    const current = async () => { assert(); await checkpoint(); assert() }
    const evidence = await readLocalEvidence(adapter, local.root.inheritedEvidence, current)
    if (!evidence) return undefined
    const admission = localEvidenceReadAdmission(evidence, adapter, local.root.inheritedEvidence)
    const refs = [local.head, ...admission.dependencies.map(entry => entry.ref)]
    const staged = new Set([...pending.values()].flat().map(record => record.revisionId))
    if (refs.some(ref => inline.has(ref.revisionId) || staged.has(ref.revisionId))) throw new Error('Mapping requires an installed local archive')
    if (!observations.has(local.head.revisionId)) {
      // Committing a prepared snapshot clears producer observations. Authenticate its actual
      // installed head before the first durable association can bind that snapshot's archive
      const bytes = await readBlob(await adapter.read(local.head), maxDocumentBytes)
      try {
        const head = LocalWorkspaceRootV3Schema.parse(parseBoundedJson(bytes, 'managed mapping source', NATIVE_BACKUP_JSON_LIMITS))
        if (!same(head, local.root)) throw new Error('Installed mapping source head changed')
      } finally { bytes.fill(0) }
    }
    const consumed = new Map<string, Observation>()
    for (const ref of refs) {
      const observed = observations.get(ref.revisionId)
      if (!observed || !same(cipherRef(observed.record), ref)) throw new Error('Missing installed mapping source observation')
      consumed.set(ref.revisionId, observed)
    }
    const retainedPayloads = new Set<string>()
    let used = false
    return {
      evidence,
      async prepare() {
        assert()
        if (used) throw new Error('Mapping evidence preparation is single-use')
        used = true
        const { accountInheritedEvidenceCheck, createAccountInheritedEvidencePreparation } = await import('./account-evidence-snapshots')
        const operation = createAccountInheritedEvidencePreparation(database, token)
        try {
          const prepared = await prepareMappingEvidence(operation, local, evidence, admission, consumed, assert, retainedPayloads)
          const native = accountInheritedEvidenceCheck(prepared.handle, database, token)
          return { ...prepared, async recheckAssociationInTransaction() {
            assert()
            await native.recheckInTransaction(consumed.values())
            if (retainedPayloads.size && await database.preparationPayloads.where('payloadId').anyOf([...retainedPayloads]).count()) throw new Error('Installed evidence acquired a preparation owner')
            assert()
          } }
        } catch (error) { await operation.abandon(); throw error }
      },
    }
  }
  async function prepareMappingEvidence(operation: AccountInheritedEvidencePreparation, local: AdmittedLocalSnapshot, evidence: CapturedGuestEvidence, admission: ReturnType<typeof localEvidenceReadAdmission>, consumed: ReadonlyMap<string, Observation>, checkCapture: () => void, retainedPayloads: Set<string>) {
    const prepare = () => operation.prepare({ sourceEvidence: evidence })
    if (!mapping) return prepare()
    const members = localLegacyStreamBindings(evidence, adapter, local.root.inheritedEvidence)
    if (!members.length) return prepare()
    let active = true
    const assert = () => { checkCapture(); if (!active) throw new Error('Installed mapping proof expired') }
    const root = local.root.inheritedEvidence
    const head = consumed.get(local.head.revisionId)
    if (!head || !same(cipherRef(head.record), local.head)
      || !head.record.descriptor.dependencies.some(ref => same(ref, root))) throw new Error('Missing installed mapping source head')
    const bindings = new Map<string, Observation>(), aliases = new Set<string>(), payloads = new Set<string>()
    const references = [{ ref: local.head }, ...admission.dependencies]
    // The complete index binds row roles to exact installed refs. An alias can be a valid
    // older encoding, but no member sharing that leaf may claim it as a unique native node
    const reserved = new Set<string>()
    for (let offset = 0; offset < references.length; offset += INSTALLED_EVIDENCE_BATCH) {
      const batch = references.slice(offset, offset + INSTALLED_EVIDENCE_BATCH)
      const installedRows = await database.encryptedRevisions.bulkGet(batch.map(entry => entry.ref.revisionId))
      const allocations = await database.preparationPayloads.where('payloadId').anyOf(installedRows.flatMap(row => row ? [row.payloadId] : [])).toArray()
      for (const row of allocations) reserved.add(row.payloadId)
      await admission.check(); assert()
      for (const [index, entry] of batch.entries()) {
        const id = entry.ref.revisionId, observed = consumed.get(id)
        if (!observed || !same(cipherRef(observed.record), entry.ref)) throw new Error('Missing installed evidence observation')
        const installed = installedRows[index]
        if (!installed || !sameCipherRecord(installed, observed.record)) throw new Error('Installed evidence descriptor changed')
        if ('dependencies' in entry && !same(observed.record.descriptor.dependencies, [...new Map(entry.dependencies.map(ref => [blobIdentity(ref), ref])).values()])) throw new Error('Installed evidence dependencies changed')
        if (bindings.has(id)) aliases.add(id)
        else if (payloads.has(observed.record.payloadId)) throw new Error('Installed evidence payload identity was reused')
        bindings.set(id, observed); payloads.add(observed.record.payloadId)
      }
    }
    const streams = new Map<string, InstalledLegacyStream>()
    for (const member of members) {
      const eligible = member.segments.every(segment => {
        const observed = bindings.get(segment.content.revisionId)
        if (!observed || observed.record.descriptor.plainBytes !== segment.byteLength) throw new Error('Installed historical segment binding changed')
        const { descriptor } = observed.record
        return !aliases.has(segment.content.revisionId) && !reserved.has(observed.record.payloadId) && descriptor.protected && !descriptor.parents.length
      })
      if (eligible) {
        streams.set(member.id, member)
        for (const segment of member.segments) retainedPayloads.add(bindings.get(segment.content.revisionId)!.record.payloadId)
      }
    }
    if (!streams.size) return prepare()
    const proof: InstalledMappingProof = Object.freeze({
      member(id: string) { assert(); return streams.get(id) },
      checkObservation(ref: LocalRecordRef, actual: Observation | undefined) {
        assert()
        const expected = bindings.get(ref.revisionId)
        if (!actual || !expected || !sameObservation(expected, actual)) throw new Error('Installed historical segment observation changed')
      },
    })
    await admission.check(); assert()
    mappingProofs.set(operation, { database, token, evidence, proof })
    try { return await prepare() }
    finally { active = false; mappingProofs.delete(operation) }
  }
  const selections = new Set<Awaited<ReturnType<typeof prepareSelectedV1Check>>>()
  const releaseSelections = async () => {
    const results = await Promise.allSettled([...selections].map(async selection => { await selection.dispose(); selections.delete(selection) }))
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Managed selection cleanup failed')
  }
  const unregister = registerProfileCleanup(token, () => { void releaseSelections().catch(() => {}); closed = true; pending.clear(); inline.clear(); clearEvidenceAdmission(); void owner.abandon().catch(() => {}) })
  // Logical read admission cannot authorize reuse of this owner's uninstalled allocations
  // Prove the exact selected graph is installed, then pin its authenticated observations through activation
  async function prepareInheritedEvidence(operationId: string, evidence: CapturedGuestEvidence, previous: CapturedGuestEvidence | undefined, before: AdmittedLocalSnapshot, input: AccountFence): Promise<LocalRecordRef> {
    const expected = structuredClone(input), generation = evidenceGeneration
    const assert = () => { check(); if (evidenceGeneration !== generation) throw new Error('Managed evidence admission expired') }
    const current = async () => {
      assert()
      if (!same(await database.profileMeta.get('active'), expected)) throw new Error('Managed evidence predecessor changed')
      assert()
    }
    await current()
    const admitted = admittedLocalReferences(before, adapter)
    if (!same(before.head, expected.head) || !admitted.has(blobIdentity(before.root.inheritedEvidence))) throw new Error('Managed evidence predecessor changed')
    if (!previous) return prepareLocalEvidence(adapter, operationId, evidence)
    const admission = localEvidenceReadAdmission(previous, adapter, before.root.inheritedEvidence)
    await admission.check(); await current()
    const staged = new Set([...pending.values()].flat().map(record => record.revisionId))
    const refs = [{ ref: before.head }, ...admission.dependencies]
    const consumed: Observation[] = []
    for (const entry of refs) {
      const observed = observations.get(entry.ref.revisionId)
      if (!observed || staged.has(entry.ref.revisionId) || inline.has(entry.ref.revisionId)
        || observed.record.descriptor.documentId !== entry.ref.documentId || observed.record.descriptor.accountId !== token.accountId
        || 'dependencies' in entry && !same(observed.record.descriptor.dependencies, entry.dependencies)) throw new Error('Evidence reuse requires exact installed source records')
      const installed = await database.encryptedRevisions.get(entry.ref.revisionId)
      if (!installed || !sameCipherRecord(installed, observed.record)) throw new Error('Evidence reuse source is not installed')
      consumed.push(observed); assert()
    }
    await recheckCiphertextObservations(database, consumed)
    await current()
    for (const observed of consumed) pinnedEvidence.add(observed.record.revisionId)
    const handle = Object.freeze({})
    evidenceReuses.set(handle, { adapter, previous, admission, assert, async check() { await admission.check(); await current() } })
    try { return await prepareLocalEvidence(adapter, operationId, evidence, handle) }
    finally { evidenceReuses.delete(handle) }
  }
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
    admissions.set(managedAdmission, { database, token, prepared: structuredClone({ ...prepared, managedAdmission: undefined }), observations: [...observations.values()], inline: records.flatMap(record => inline.get(record.revisionId) ?? []), retained, check, legacy, disposeLegacy: legacy && (async () => { await legacy.dispose(); selections.delete(legacy) }), association: association && structuredClone(association), projection: projection && structuredClone(projection) })
    return prepared
  }
  async function persistOperation(operationId: string, writeJournal: () => Promise<void>, assertMayPersist: () => void): Promise<void> {
    check(); assertMayPersist()
    if (reservation) throw new Error('Reserved preparation must remain inert until main installation')
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
    if (value.version === 2) await readManagedCopyComparisons(database, token, adapter, value, before, assertCurrent, intent)
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
    selections.add(legacy)
    try {
      const projection = await database.syncState.get('projection')
      const origin = AccountMappingOriginSchema.parse({ version: 1, kind: 'incremental-mapping-origin', accountId: token.accountId, operationId, localRoot: result.head, mappedRoot: predecessor.head, headRevision: predecessor.headRevision + 1 })
      const bytes = new TextEncoder().encode(JSON.stringify(origin))
      let ref: LocalRecordRef
      try { ref = await adapter.stage(operationId, memoryBlob(bytes), [result.head, predecessor.head]) } finally { bytes.fill(0) }
      return await prepareActivation(operationId, result, predecessor, undefined, undefined, projection, legacy, { id: accountMappingRootKey(result.head), ref })
    } catch (error) {
      try { await legacy.dispose(); selections.delete(legacy) }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Managed selection preparation and cleanup failed') }
      throw error
    }
  }
  async function prepareMappedActivation(operationId: string, result: { readonly head: LocalRecordRef; readonly snapshot: AdmittedLocalSnapshot }, expected: AccountFence, previous: AdmittedLocalSnapshot, native: import('./account-graph').PreparedAccountWorkspace, intent?: { readonly ref: LocalRecordRef; readonly records: readonly CipherRecord[] }, requireSettledSync?: true): Promise<PreparedLocalActivation> {
    check()
    const selection = await prepareSelectedV1Check(database, token, native)
    selections.add(selection)
    try {
      const projection = await database.syncState.get('projection')
      const origin = AccountMappingOriginSchema.parse({ version: 1, kind: 'incremental-mapping-origin', accountId: token.accountId, operationId, localRoot: result.head, mappedRoot: native.head, headRevision: expected.headRevision + 1 })
      const bytes = new TextEncoder().encode(JSON.stringify(origin))
      let ref: LocalRecordRef
      try { ref = await adapter.stage(operationId, memoryBlob(bytes), [result.head, native.head]) } finally { bytes.fill(0) }
      // Native projection and managed selection publish together; the existing native/source checks remain mandatory
      // The exact association survives removal of a completed outbox row and supplies the next local command's base
      return await prepareActivation(operationId, result, expected, previous, intent?.ref, projection, selection, { id: accountMappingRootKey(result.head), ref }, { records: [...native.records, ...(intent?.records ?? [])], intentStatus: 'mapped-local', ...(requireSettledSync ? { requireSettledSync } : {}) })
    } catch (error) {
      try { await selection.dispose(); selections.delete(selection) }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Managed selection preparation and cleanup failed') }
      throw error
    }
  }
  // Mapping receipts use the same live adapter observations; callers cannot provide or revive authority
  // This closure performs only IDB reads inside the caller-owned descriptor/chunk transaction
  const store = { adapter, lifetime, prepareInheritedEvidence,
    observedRecords() { check(); return structuredClone([...observations.values()].map(value => value.record)) },
    stagedRecords(operationId: string) { check(); return structuredClone(pending.get(operationId) ?? []) },
    describePreparation(prepared: PreparedLocalActivation) {
      check()
      const admission = prepared.managedAdmission && admissions.get(prepared.managedAdmission)
      if (!admission || admission.database !== database || admission.token !== token || !same(admission.prepared, { ...prepared, managedAdmission: undefined })) throw new Error('Unadmitted managed preparation')
      return { records: structuredClone(prepared.records), consumed: structuredClone(admission.observations.map(value => value.record)), retained: [...admission.retained], native: admission.legacy?.observations(), association: admission.association && structuredClone(admission.association) }
    },
    async recheckObservationsInTransaction() { check(); await recheckCiphertextObservations(database, observations.values()); check() }, persistOperation, prepareSavedActivation, preparePersistedActivation, prepareActivation: (operationId: string, result: { readonly head: LocalRecordRef; readonly snapshot: AdmittedLocalSnapshot }, expected: AccountFence | undefined, previous?: AdmittedLocalSnapshot, intent?: LocalRecordRef, projection?: EncryptedSyncState) => prepareActivation(operationId, result, expected, previous, intent, projection), prepareLegacyActivation, prepareMappedActivation, committed(operationId: string) { check(); for (const record of pending.get(operationId) ?? []) inline.delete(record.revisionId); pending.delete(operationId); clearEvidenceAdmission() }, finishAdmission() { check(); clearEvidenceAdmission() }, async dispose() {
    unregister(); closed = true; pending.clear(); inline.clear(); clearEvidenceAdmission()
    const results = await Promise.allSettled([releaseSelections(), owner.abandon()])
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Managed store cleanup failed')
  } }
  mappingStores.set(store, { database, token, capture: captureMappingEvidence })
  return store
}
