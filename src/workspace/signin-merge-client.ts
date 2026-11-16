import { signinMergeDiagnosticsEnabled, createSigninMergeWorkerObserver, recordSigninMergeCiphertextWork, recordSigninMergeCiphertextFailure } from './signin-merge-diagnostics'
import { SigninDecisionSchema } from './signin-decision'
import type { Transaction } from 'dexie'
import { assertActiveProfile, profileSignal, type ProfileToken } from '../account/profile'
import { createProfileWorker, type ProfileWorkerLease } from '../account/profile-worker'
import { readRemoteHeads, RemoteStateSchema } from '../account/sync/pull'
import { requestSync } from '../account/sync/scheduler'
import type { AccountDatabase, CipherRecord, PreparedLocalActivation } from '../persistence/account-database'
import type { AccountSyncAttachmentValue } from '../persistence/account-activation-attachments'
import { ACCOUNT_RECEIPT_PREFIX } from '../persistence/account-activation-attachments'
import { jsonEqual } from '../persistence/local-data'
import { parseBoundedJson, NATIVE_BACKUP_JSON_LIMITS } from '../interchange/json'
import { cipherRef, openAccountJson, readAccountRecordBytes, stageAccountJson } from './account-cache'
import { createAccountPreparationOwner } from './account-prepared-records'
import { holdAccountPreparation, cleanupAccountPreparations, type AccountPreparationLease } from './account-preparation-registry'
import { assertReviewedAccountData, type ReviewedAccountData, type StableWorkspaceSnapshotIdentity } from './reviewed-replacement'
import { backupMetadataDigest } from './snapshot'
import { PENDING_COPY, SAVED_COPY_PREFIX } from './guest-copy-journal'
import { activateGuestCopyWithReceipt } from './managed-guest-copy'
import type { PreparedSigninMerge } from './guest-copy'
import type { GuestCopySource } from './guest-repository'
import { assertMergeProofEnvelope, validateMergeInstallation, type MergeInstallationProof } from './signin-merge-installation'
import { clearMergeCiphertext, observeMergeCiphertext, recheckMergeCiphertext, mergeRecordEqual, type MergeCipherObservation } from './signin-merge-observations'
import { SIGNIN_MERGE_ERRORS, SIGNIN_MERGE_LIMITS, SigninMergeManifestSchema, SigninMergeReviewSchema, SigninMergeProgressSchema, SigninMergeResourceFailureSchema, SigninMergeTicketSchema, assertSigninMergeBudget, type SigninMergeFence, type SigninMergeProgress } from './signin-merge-protocol'

const receipts = new WeakMap<object, { proof: MergeInstallationProof; consumed: boolean }>()
const mismatch = () => new Error('SIGNIN_RECEIPT_MISMATCH')
// Only the installer below issues entries; a structurally identical object carries no authority
export function consumeManagedMergeInstallation(receipt: object, database: AccountDatabase, token: ProfileToken, prepared: PreparedLocalActivation): MergeInstallationProof {
  const value = receipts.get(receipt)
  if (!value || value.consumed || !value.proof.managed || prepared.preparationAdmission) throw mismatch()
  assertMergeProofEnvelope(value.proof, database, token, prepared)
  value.consumed = true; return value.proof
}
export function nativeMergeInstallationCheck(database: AccountDatabase, token: ProfileToken, prepared: PreparedLocalActivation) {
  const value = prepared.preparationAdmission && receipts.get(prepared.preparationAdmission)
  if (!value || value.proof.managed || prepared.managedAdmission) throw mismatch()
  assertMergeProofEnvelope(value.proof, database, token, prepared)
  return { recheckInTransaction: value.proof.recheckInTransaction, async recheckSourceCapturesInTransaction() { value.proof.check() } }
}

export async function createSigninMergeClient(database: AccountDatabase, token: ProfileToken, operationId: string, sourceInput: GuestCopySource, sourceIdentity: StableWorkspaceSnapshotIdentity, review: ReviewedAccountData, checkSource: () => Promise<void>, progress: (value: SigninMergeProgress) => void, signal: AbortSignal, createWorker: () => Worker, decisionId = 'signin-receipt:decision') {
  await assertReviewedAccountData(token, review)
  const locator = sourceInput.locator
  if (!locator) throw new Error('SIGNIN_SOURCE_CHANGED')
  const selected = await database.profileMeta.get('active'), projection = await database.syncState.get('projection')
  if (!selected || !projection) throw mismatch()
  const remote = await openAccountJson(database, token, projection.ref, RemoteStateSchema)
  const heads = [...await readRemoteHeads(database, token, remote.heads)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([documentId, revisionId]) => ({ documentId, revisionId }))
  if (!remote.initialComplete || remote.projectionPending || remote.publicationEpoch !== review.epoch || !jsonEqual(heads, review.heads)) throw mismatch()
  if (!decisionId.startsWith(ACCOUNT_RECEIPT_PREFIX)) throw mismatch()
  const previousDecision = await database.syncState.get(decisionId)
  const fence: SigninMergeFence = structuredClone({ selected, projection, epoch: review.epoch, heads })
  const source = structuredClone(locator), identity = structuredClone(sourceIdentity)
  const codecObserver = createSigninMergeWorkerObserver()
  let closed = false, installed = false, worker: ProfileWorkerLease | undefined, lease: AccountPreparationLease | undefined
  let observations: MergeCipherObservation[] = [], installedDecision: AccountSyncAttachmentValue | undefined
  let mainOwner: ReturnType<typeof createAccountPreparationOwner> | undefined
  const check = () => { assertActiveProfile(token); signal.throwIfAborted(); if (closed) throw mismatch(); if (!installed) worker?.check() }
  const checkCurrent = async () => {
    check(); await checkSource()
    if (!jsonEqual(await database.profileMeta.get('active'), selected) || !jsonEqual(await database.syncState.get('projection'), projection)) throw new Error('LOCAL_REVISION_CONFLICT')
    check()
  }
  const releaseWorker = async () => {
    const previous = worker; worker = undefined
    // Termination is synchronous and precedes main-share release even when acknowledgment was lost
    previous?.dispose(); await lease?.release(); lease = undefined
  }
  const acceptProgress = (value: unknown) => {
    // Malformed optional diagnostics must not turn a real resource refusal into a transport failure
    const { resourceFailure, ...ordinary } = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { resourceFailure: undefined }
    const message = SigninMergeProgressSchema.parse(ordinary)
    if (resourceFailure !== undefined) try {
      const parsed = SigninMergeResourceFailureSchema.safeParse(resourceFailure)
      if (parsed.success) codecObserver?.resourceFailure(parsed.data)
    } catch { /* Observer failure cannot suppress the worker's terminal code */ }
    if (message.codec) codecObserver?.work(message.codec)
    if (message.observations?.status === 'complete') recordSigninMergeCiphertextWork('worker', message.observations.records, message.observations.bytes)
    else if (message.observations?.status === 'failed') recordSigninMergeCiphertextFailure('worker')
    progress(message)
  }
  const observe = async (records: readonly CipherRecord[]) => {
    try {
      const values = await observeMergeCiphertext(database, token, records, check)
      recordSigninMergeCiphertextWork('main', values.length, values.reduce((sum, value) => sum + value.chunks.reduce((total, chunk) => total + chunk.bytes.length, 0), 0))
      return values
    } catch (error) { recordSigninMergeCiphertextFailure('main'); throw error }
  }
  const dispose = async () => {
    if (closed) return
    codecObserver?.endRequest()
    closed = true; await releaseWorker(); await mainOwner?.abandon(); clearMergeCiphertext(observations); observations = []
    // Cleanup can leave inert bytes when another realm still owns a share; it never deletes installed data
    try { assertActiveProfile(token); await cleanupAccountPreparations(database, token) } catch { /* A later unlocked coordinator retries exact registered cleanup */ }
  }
  try {
    await checkCurrent()
    codecObserver?.beginRequest()
    worker = await createProfileWorker(token, createWorker(), { ready: true, errorCodes: SIGNIN_MERGE_ERRORS, signal, ...(signinMergeDiagnosticsEnabled() ? { diagnostics: true } : {}) })
    const response = SigninMergeReviewSchema.parse(await worker.request({ kind: 'review', operationId, locator: source, fence }, signal, acceptProgress))
    if (response.preview.accountId !== token.accountId || !response.preview.signin || response.preview.resumable) throw mismatch()
    await checkCurrent()
    codecObserver?.endRequest()
    const previewDigest = await backupMetadataDigest(response.preview)
    let started = false
    return { preview: response.preview, dispose, async prepare(decision: AccountSyncAttachmentValue): Promise<PreparedSigninMerge> {
      if (started) throw mismatch()
      started = true
      try {
      await checkCurrent()
      const confirmed = structuredClone(decision), value = SigninDecisionSchema.parse(confirmed.value)
      if (confirmed.id !== decisionId || !jsonEqual(confirmed.expected, previousDecision)) throw mismatch()
      if (!confirmed.id.startsWith(ACCOUNT_RECEIPT_PREFIX) || confirmed.dependencies?.length || value.version !== 1 || value.kind !== 'signin-decision' || value.action !== 'merge' || value.status !== 'preparing' || value.accountId !== token.accountId || value.operationId !== operationId || value.copyId !== response.preview.copyId || !jsonEqual(value.source, identity)) throw mismatch()
      lease = await holdAccountPreparation(token, operationId, signal)
      codecObserver?.beginRequest()
      const ticket = SigninMergeTicketSchema.parse(await worker!.request({ kind: 'prepare', operationId, handle: response.handle }, signal, acceptProgress))
      codecObserver?.endRequest()
      if (ticket.operationId !== operationId || ticket.copyId !== response.preview.copyId || ticket.manifest.descriptor.accountId !== token.accountId || ticket.manifest.descriptor.dependencies.length) throw mismatch()
      assertSigninMergeBudget(ticket.manifest.descriptor.plainBytes, 0, 0)
      const reserved = async (records: readonly CipherRecord[]) => {
        const rows = await database.preparationPayloads.where('operationId').equals(operationId).toArray(), ids = new Set(records.map(record => record.payloadId))
        if (ids.size !== records.length || rows.length !== ids.size || rows.some(row => !ids.has(row.payloadId))) throw mismatch()
      }
      if (!await database.preparationPayloads.get([operationId, ticket.manifest.payloadId]) || await database.encryptedRevisions.get(ticket.manifest.revisionId)) throw mismatch()
      const bytes = await readAccountRecordBytes(database, token, cipherRef(ticket.manifest), ticket.manifest, SIGNIN_MERGE_LIMITS.manifestBytes)
      let manifest
      try { manifest = SigninMergeManifestSchema.parse(parseBoundedJson(bytes, 'merge manifest', NATIVE_BACKUP_JSON_LIMITS)) } finally { bytes.fill(0) }
      if (manifest.accountId !== token.accountId || manifest.operationId !== operationId || manifest.copyId !== ticket.copyId || manifest.previewDigest !== previewDigest || !jsonEqual(manifest.source, source) || !jsonEqual(manifest.sourceIdentity, identity) || !jsonEqual(manifest.destination, fence)) throw mismatch()
      if ([...manifest.output, ...manifest.consumed].some(record => record.revisionId === ticket.manifest.revisionId || record.payloadId === ticket.manifest.payloadId)) throw mismatch()
      await reserved([...manifest.output, ticket.manifest])
      const validated = await validateMergeInstallation(database, token, manifest)
      if (!jsonEqual(validated.journal.preview, response.preview)) throw mismatch()
      const observationBytes = (records: readonly CipherRecord[]) => records.reduce((sum, record) => sum + record.descriptor.chunks.reduce((total, chunk) => total + chunk.cipherBytes, 0), 0)
      assertSigninMergeBudget(ticket.manifest.descriptor.plainBytes, validated.records.length, observationBytes([...validated.records, ticket.manifest]))
      observations = await observe(validated.records)
      const transient = await observe([ticket.manifest])
      try {
        await checkCurrent(); lease.check()
        // Check the sealed worker set before staging the disjoint private main receipt allocation
        await reserved([...manifest.output, ticket.manifest])
        mainOwner = createAccountPreparationOwner(database, token, lease)
        const receiptRecord = await stageAccountJson(database, token, confirmed.value, [selected.head, manifest.selectedTarget, ...(manifest.mappingOrigin ? [manifest.mappingOrigin.ref] : [])], undefined, mainOwner)
        assertSigninMergeBudget(ticket.manifest.descriptor.plainBytes, validated.records.length, observationBytes([...validated.records, ticket.manifest, receiptRecord]))
        observations.push(...await observe([receiptRecord]))
        const receiptRow = { id: confirmed.id, ref: cipherRef(receiptRecord) }
        const exactRecords = [...manifest.output, receiptRecord, ticket.manifest]
        let transaction: Transaction | undefined
        const abort = () => transaction?.abort()
        const combined = AbortSignal.any([signal, profileSignal(token)])
        combined.addEventListener('abort', abort, { once: true })
        try {
          await checkCurrent()
          await database.transaction('rw', database.tables, async tx => {
            transaction = tx; check(); lease!.check()
            if (manifest.mappingOrigin && await database.syncState.get(manifest.mappingOrigin.id) || !jsonEqual(await database.profileMeta.get('active'), selected) || !jsonEqual(await database.syncState.get('projection'), projection) || !jsonEqual(await database.syncState.get(confirmed.id), confirmed.expected) || await database.syncState.get(PENDING_COPY) || await database.syncState.get(`${SAVED_COPY_PREFIX}${ticket.copyId}`)) throw mismatch()
            await reserved(exactRecords)
            for (const row of manifest.sourceRows) if (!jsonEqual(await database.syncState.get(row.id) ?? null, row.expected)) throw mismatch()
            for (const record of manifest.consumed) { const actual = await database.encryptedRevisions.get(record.revisionId); if (!actual || !mergeRecordEqual(actual, record)) throw mismatch() }
            for (const record of exactRecords) if (await database.encryptedRevisions.get(record.revisionId) || await database.encryptedRevisions.where('payloadId').equals(record.payloadId).count()) throw mismatch()
            await recheckMergeCiphertext(database, [...observations, ...transient])
            await database.encryptedRevisions.bulkAdd([...manifest.output, receiptRecord])
            await database.syncState.add({ id: `${SAVED_COPY_PREFIX}${ticket.copyId}`, ref: manifest.journal })
            await database.syncState.add({ id: PENDING_COPY, ref: manifest.journal })
            await database.syncState.put(receiptRow)
            await database.preparationPayloads.bulkDelete(exactRecords.map(record => [operationId, record.payloadId]))
            await database.stagedCipherChunks.where('payloadId').equals(ticket.manifest.payloadId).delete()
            check(); lease!.check()
          })
        } finally { combined.removeEventListener('abort', abort) }
        installed = true
        installedDecision = { ...confirmed, expected: receiptRow }
        const prepared: PreparedLocalActivation = { version: 1, id: ticket.copyId, expected: selected, head: manifest.selectedTarget, intent: manifest.intent, intentStatus: manifest.intentStatus, records: [] }
        const proof: MergeInstallationProof = { database, token, prepared, managed: validated.managed, observations, rows: manifest.sourceRows, association: manifest.mappingOrigin, projection, check,
          async recheckInTransaction() {
            check()
            if (!jsonEqual(await database.syncState.get(receiptRow.id), receiptRow) || !jsonEqual(await database.syncState.get('projection'), projection)) throw mismatch()
            for (const row of manifest.sourceRows) if (!jsonEqual(await database.syncState.get(row.id) ?? null, row.expected)) throw mismatch()
            for (const { record } of observations) { const actual = await database.encryptedRevisions.get(record.revisionId); if (!actual || !mergeRecordEqual(actual, record)) throw mismatch() }
            await recheckMergeCiphertext(database, observations)
            if (manifest.mappingOrigin) { if (await database.syncState.get(manifest.mappingOrigin.id)) throw mismatch(); await database.syncState.add(manifest.mappingOrigin) }
            check()
          } }
        // Commit is the issuance boundary; neither manifest fields nor caller-supplied observations can mint this receipt
        const receipt = Object.freeze({}); receipts.set(receipt, { proof, consumed: false })
        const activation = validated.managed ? (await import('./account-local-store')).admitInstalledMerge(database, token, prepared, receipt) : { ...prepared, preparationAdmission: receipt }
        // Main has independent bytes and a committed installation before worker ownership is retired
        codecObserver?.beginRequest()
        try { await worker!.request({ kind: 'release', operationId }, signal, acceptProgress) } catch { /* Durable journal readback handles lost acknowledgments */ }
        finally { codecObserver?.endRequest() }
        await releaseWorker()
        return { copyId: ticket.copyId, async activate(complete: AccountSyncAttachmentValue) {
          check()
          if (complete.id !== confirmed.id || !jsonEqual(complete.expected, installedDecision?.expected) || !jsonEqual(complete.value, { ...value, status: 'complete' })) throw mismatch()
          await checkSource(); check()
          await activateGuestCopyWithReceipt(database, token, activation, check, complete)
          await database.transaction('rw', database.syncState, async () => { check(); if (jsonEqual((await database.syncState.get(PENDING_COPY))?.ref, manifest.journal)) await database.syncState.delete(PENDING_COPY) })
          receipts.delete(receipt); requestSync(token, 'save')
          await dispose()
          return { copyId: ticket.copyId, accountId: token.accountId, mappings: [] }
        }, dispose }
      } finally { clearMergeCiphertext(transient) }
      } catch (error) { await dispose(); throw error }
    } }
  } catch (error) { await dispose(); throw error }
}
