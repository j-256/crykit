import { z } from 'zod'
import { assertActiveProfile, profileSignal, type ProfileToken } from '../account/profile'
import { CommitRequestSchema, OpaqueIdSchema, type CommitRequest } from '../account/protocol'
import { SyncClient, SyncError } from '../account/sync/client'
import { readSyncState, writeSyncState, transferBudget, PublicationOperationSchema, EncryptedOutbox } from '../account/sync/outbox'
import { stagePull, readRemoteState, type PullCandidate } from '../account/sync/pull'
import { openRemoteProjection, assertProjectionAdvance, assertProjectionSuccessor, type RemoteProjection } from '../account/sync/projection'
import { AccountDatabase, activateLocalAccountCommit, type AccountFence, type CipherRef, type EncryptedSyncState, type PreparedLocalActivation } from '../persistence/account-database'
import { prepareAccountSyncAttachment, combineAccountActivationAttachments, releaseAccountActivationAttachment, type AccountActivationAttachment, type AccountBranchRetirement } from '../persistence/account-activation-attachments'
import { accountLocalId, cipherRef, openAccountJson, stageAccountJson } from './account-cache'
import { createAccountRecoveryService } from './account-recovery'
import { captureAccountSyncWorkspace } from './account-sync-capture'
import { captureAccountSnapshot } from './account-snapshot'
import { disposeWorkspaceSnapshot, backupMetadataDigest, snapshotMetadata, assertOwnedWorkspaceSnapshot, assertWorkspaceSnapshotCurrent, validateWorkspaceSnapshot, type WorkspaceSnapshot } from './snapshot'
import { previewAccountWorkspaceRestore, stageAccountWorkspaceRestore, activateAccountWorkspaceRestore, releaseAccountWorkspaceRestorePreview, releaseAccountWorkspaceRestoreStage } from './account-restore'
import { prepareAccountWorkspace, prepareAccountWorkspaceWithExistingEvidence } from './account-graph'
import { prepareManagedAccountProjection } from './account-managed-projection'
import type { SigninDecision } from './signin-reconciliation'

export interface ReviewedReplacementDiagnostic { readonly operationId: string; readonly phase: 'preserve' | 'bind' | 'complete' | 'activate' | 'use-latest'; readonly outcome: 'complete' | 'failed'; readonly elapsedMs: number; readonly code?: string }
const diagnostics = new Set<(value: ReviewedReplacementDiagnostic) => void>()
export function subscribeReviewedReplacementDiagnostics(listener: (value: ReviewedReplacementDiagnostic) => void): () => void { diagnostics.add(listener); return () => { diagnostics.delete(listener) } }
async function phase<T>(operationId: string, name: ReviewedReplacementDiagnostic['phase'], action: () => Promise<T>): Promise<T> {
  const started = performance.now()
  let failure: unknown
  try { return await action() } catch (error) { failure = error; throw error }
  finally {
    const value: ReviewedReplacementDiagnostic = { operationId, phase: name, outcome: failure ? 'failed' : 'complete', elapsedMs: Math.max(0, performance.now() - started), ...(failure ? { code: failure instanceof SyncError ? failure.code : 'FAILED' } : {}) }
    // Diagnostics cannot grant authority or make a successful pointer transaction appear to fail
    for (const listener of diagnostics) { try { listener(value) } catch { /* Observer failures do not alter persistence */ } }
  }
}

export const REVIEWED_REPLACEMENT_KEY = 'reviewed-replacement'
const refSchema = z.strictObject({ documentId: OpaqueIdSchema, revisionId: OpaqueIdSchema })
export const ReviewedReplacementSchema = z.strictObject({
  version: z.literal(1), kind: z.literal('reviewed-replacement'), operationId: OpaqueIdSchema, intentId: OpaqueIdSchema,
  recoveryOperationId: OpaqueIdSchema, predecessorRecoveryId: OpaqueIdSchema.optional(), predecessorAuthority: refSchema.optional(),
  reviewedEpoch: z.number().int().nonnegative().safe(), reviewedHeads: z.array(refSchema), reviewedHeadRoot: refSchema,
  state: z.enum(['active', 'paused', 'accepted', 'selected-latest']), final: CommitRequestSchema.optional(),
  pauseReason: z.enum(['remote-advanced', 'head-conflict']).optional(),
})
export interface StableWorkspaceSnapshotIdentity { readonly revisionVector: Readonly<Record<string, string>>; readonly metadataDigest: string }
export async function stableWorkspaceSnapshotIdentity(snapshot: WorkspaceSnapshot): Promise<StableWorkspaceSnapshotIdentity> {
  await assertOwnedWorkspaceSnapshot(snapshot)
  await validateWorkspaceSnapshot(snapshot)
  await assertWorkspaceSnapshotCurrent(snapshot)
  const metadata: Record<string, unknown> = { ...snapshotMetadata(snapshot) }
  // Only the outer capture envelope is transient; nested original identities and times remain authority
  delete metadata.snapshotId
  delete metadata.capturedAt
  const identity = { revisionVector: Object.fromEntries(Object.entries(snapshot.revisionVector).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), metadataDigest: await backupMetadataDigest(metadata) }
  await assertWorkspaceSnapshotCurrent(snapshot)
  return identity
}
const PREPARATION_PREFIX = 'reviewed-preparation:'
const PreparationSchema = z.strictObject({
  version: z.literal(1), kind: z.literal('reviewed-replacement-preparation'), operationId: OpaqueIdSchema,
  intent: z.enum(['replace', 'use-latest']), sourceIdentity: z.string(), sourceVector: z.record(z.string(), z.string()),
  fence: z.strictObject({ key: z.literal('active'), headRevision: z.number().int().nonnegative().safe(), head: refSchema }),
  reviewedEpoch: z.number().int().nonnegative().safe(), reviewedHeads: z.array(refSchema),
  predecessorRecoveryId: OpaqueIdSchema.optional(), state: z.enum(['preserving', 'sealed', 'activated']),
})
export type ReviewedReplacement = z.infer<typeof ReviewedReplacementSchema>
export type StoredReviewedReplacement = { readonly row: EncryptedSyncState; readonly value: ReviewedReplacement }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const refs = (heads: ReadonlyMap<string, string>) => [...heads].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([documentId, revisionId]) => ({ documentId, revisionId }))
export function readReviewedReplacement(database: AccountDatabase, token: ProfileToken) { return readSyncState(database, token, REVIEWED_REPLACEMENT_KEY, ReviewedReplacementSchema) }
// Version 1 decisions and activated preparations authenticate only their target head
// Join that exact head to the activation journal, not to the mutable latest replacement
export async function assertReviewedDecisionActivation(database: AccountDatabase, token: ProfileToken, receipt: EncryptedSyncState, decision: SigninDecision): Promise<void> {
  const mismatch = () => new Error('SIGNIN_RECEIPT_MISMATCH')
  assertActiveProfile(token)
  if (decision.accountId !== token.accountId || decision.status !== 'complete' || !['device', 'latest'].includes(decision.action)) throw mismatch()
  const id = `${PREPARATION_PREFIX}${OpaqueIdSchema.parse(decision.operationId)}`
  const row = await database.syncState.get(id)
  if (!row) throw mismatch()
  const preparationRecord = await database.encryptedRevisions.get(row.ref.revisionId)
  const receiptRecord = await database.encryptedRevisions.get(receipt.ref.revisionId)
  const preparation = await openAccountJson(database, token, row.ref, PreparationSchema)
  if (!same(await openAccountJson(database, token, receipt.ref, z.unknown()), decision)) throw mismatch()
  if (!preparationRecord || !receiptRecord || preparation.operationId !== decision.operationId || preparation.state !== 'activated'
    || preparation.intent !== (decision.action === 'latest' ? 'use-latest' : 'replace')) throw mismatch()
  const head = preparationRecord.descriptor.dependencies[0]
  if (!head || preparationRecord.descriptor.dependencies.length !== 1 || !same(receiptRecord.descriptor.dependencies, [head])) throw mismatch()
  const source = preparation.predecessorRecoveryId
    ? { revisionVector: { accountHead: JSON.stringify(preparation.fence.head), headRevision: String(preparation.fence.headRevision) }, metadataDigest: await backupMetadataDigest({ accountId: token.accountId, branch: preparation.fence }) }
    : decision.source
  if (!source || !same(preparation.sourceVector, source.revisionVector) || preparation.sourceIdentity !== source.metadataDigest) throw mismatch()
  // The stage ID differs from the decision ID; the authenticated target and prior fence
  // establish its association without assuming those independently allocated IDs are equal
  const ambiguousMatchLimit = 2
  const matchingJournals = () => database.migrationJournal.filter(value => same(value.head, head) && value.headRevision === preparation.fence.headRevision + 1).limit(ambiguousMatchLimit).toArray()
  const journals = await matchingJournals()
  if (journals.length !== 1 || journals[0].localStatus !== 'active') throw mismatch()
  await database.transaction('r', database.syncState, database.encryptedRevisions, database.migrationJournal, async () => {
    assertActiveProfile(token)
    if (!same(await database.syncState.get(id), row) || !same(await database.syncState.get(receipt.id), receipt)
      || !same(await database.encryptedRevisions.get(row.ref.revisionId), preparationRecord)
      || !same(await database.encryptedRevisions.get(receipt.ref.revisionId), receiptRecord)
      || !same(await matchingJournals(), journals)) throw mismatch()
  })
  assertActiveProfile(token)
}
export function reviewedRemoteMatches(value: ReviewedReplacement, epoch: number, heads: ReadonlyMap<string, string>): boolean {
  return value.reviewedEpoch === epoch && same(value.reviewedHeads, refs(heads))
}
// The paged root retains every head without exceeding the per-record dependency bound
const dependencies = (value: ReviewedReplacement): CipherRef[] => [value.reviewedHeadRoot, ...(value.predecessorAuthority ? [value.predecessorAuthority] : [])]
export async function pauseReviewedReplacement(database: AccountDatabase, token: ProfileToken, stored: StoredReviewedReplacement, reason: 'remote-advanced' | 'head-conflict') {
  const value: ReviewedReplacement = { ...stored.value, state: 'paused', pauseReason: reason }
  return { value, row: await writeSyncState(database, token, REVIEWED_REPLACEMENT_KEY, value, stored.row, dependencies(value)) }
}

// Publication identity and reviewed authority become durable together before bind or any submission
// A crash cannot allocate a different final mutation against the same protected recovery
export async function installReviewedPublication(database: AccountDatabase, token: ProfileToken, stored: StoredReviewedReplacement, final: CommitRequest, operation: unknown, expectedPublication: EncryptedSyncState | undefined, operationDependencies: readonly CipherRef[]) {
  if (stored.value.state !== 'active' || stored.value.final || final.recoveryOperationId !== stored.value.recoveryOperationId || final.expectedPublicationEpoch !== stored.value.reviewedEpoch) throw new SyncError('LOCAL_INTEGRITY_FAILED')
  const value = ReviewedReplacementSchema.parse({ ...stored.value, final })
  const authority = await stageAccountJson(database, token, value, dependencies(value))
  const journal = await stageAccountJson(database, token, PublicationOperationSchema.parse(operation), operationDependencies)
  await database.transaction('rw', database.syncState, database.encryptedRevisions, async () => {
    assertActiveProfile(token)
    if (!same(await database.syncState.get(REVIEWED_REPLACEMENT_KEY), stored.row) || !same(await database.syncState.get('publication'), expectedPublication)) throw new SyncError('LOCAL_REVISION_CONFLICT')
    await database.encryptedRevisions.bulkAdd([authority, journal])
    await database.syncState.put({ id: REVIEWED_REPLACEMENT_KEY, ref: cipherRef(authority) })
    await database.syncState.put({ id: 'publication', ref: cipherRef(journal) })
    assertActiveProfile(token)
  })
}
export async function bindReviewedPublication(token: ProfileToken, stored: StoredReviewedReplacement): Promise<void> {
  if (!stored.value.final || stored.value.state !== 'active') throw new SyncError('LOCAL_INTEGRITY_FAILED')
  const recovery = createAccountRecoveryService(token)
  await phase(stored.value.operationId, 'bind', async () => {
    await recovery.bind(stored.value.recoveryOperationId, stored.value.final!)
    if (stored.value.predecessorRecoveryId) await recovery.supersede(stored.value.recoveryOperationId)
  })
}
export async function completeReviewedPublication(database: AccountDatabase, token: ProfileToken, stored: StoredReviewedReplacement) {
  if (!stored.value.final) throw new SyncError('LOCAL_INTEGRITY_FAILED')
  await phase(stored.value.operationId, 'complete', () => createAccountRecoveryService(token).complete(stored.value.recoveryOperationId, stored.value.final!.mutationId, stored.value.final))
  const value: ReviewedReplacement = { ...stored.value, state: 'accepted' }
  return { value, row: await writeSyncState(database, token, REVIEWED_REPLACEMENT_KEY, value, stored.row, dependencies(value)) }
}

export interface ReviewedAccountData {
  readonly epoch: number
  readonly heads: readonly CipherRef[]
  readonly snapshot: WorkspaceSnapshot
  dispose(): Promise<void>
}
interface Review {
  readonly database: AccountDatabase; readonly token: ProfileToken; readonly fence: AccountFence
  readonly candidate: PullCandidate; readonly projection: RemoteProjection; readonly captured: Awaited<ReturnType<typeof captureAccountSyncWorkspace>>
  readonly previous?: StoredReviewedReplacement; readonly snapshot: WorkspaceSnapshot
  disposed: boolean
}
const reviews = new WeakMap<ReviewedAccountData, Review>()
export interface ReviewedReplacementStage {
  readonly id: string; readonly expected: AccountFence; readonly head: CipherRef
  dispose(): Promise<void>
}
interface Stage { readonly operationId: string; readonly review: Review; readonly restore?: Awaited<ReturnType<typeof stageAccountWorkspaceRestore>>; readonly prepared?: PreparedLocalActivation; readonly attachment: AccountActivationAttachment; ownedSource?: WorkspaceSnapshot }
const stages = new WeakMap<ReviewedReplacementStage, Stage>()
const branchSources = new WeakSet<WorkspaceSnapshot>()
const branches = new WeakMap<object, { readonly database: AccountDatabase; readonly token: ProfileToken; readonly fence: AccountFence; readonly retirement: AccountBranchRetirement }>()
const selections = new WeakMap<object, { readonly database: AccountDatabase; readonly token: ProfileToken; readonly fence: AccountFence; readonly branch: object; readonly recoveryOperationId: string }>()

// Only a rejected branch captured by this module can relax restore's settled prerequisite
// The activation attachment rechecks the same complete intent set in the head transaction
export async function assertReviewedBranch(database: AccountDatabase, token: ProfileToken, handle: object): Promise<void> {
  const branch = branches.get(handle)
  if (!branch || branch.database !== database || branch.token !== token) throw new SyncError('LOCAL_INTEGRITY_FAILED')
  assertActiveProfile(token)
  if (!same(await database.profileMeta.get('active'), branch.fence) || !same(await database.syncState.get(REVIEWED_REPLACEMENT_KEY), branch.retirement.authority)
    || !same(await database.syncState.get('publication'), branch.retirement.publication) || !same(await database.outbox.toArray(), branch.retirement.intents)) throw new SyncError('LOCAL_REVISION_CONFLICT')
}
export function assertReviewedBranchSelection(database: AccountDatabase, token: ProfileToken, fence: AccountFence, handle: object): void {
  const selection = selections.get(handle)
  if (!selection || selection.database !== database || selection.token !== token || !same(selection.fence, fence) || !branches.has(selection.branch)) throw new SyncError('LOCAL_INTEGRITY_FAILED')
  assertActiveProfile(token)
}
async function rejectedBranch(review: Review): Promise<{ handle: object; retirement: AccountBranchRetirement }> {
  const { database, token, previous, fence } = review
  if (!previous || previous.value.state !== 'paused') throw new SyncError('REPLACEMENT_REVIEW_REQUIRED')
  const publication = await readSyncState(database, token, 'publication', PublicationOperationSchema)
  if (publication && (!publication.value.conflicted || publication.value.accepted || publication.value.finalMutationId !== previous.value.final?.mutationId)) throw new SyncError('REPLACEMENT_PUBLICATION_UNCERTAIN')
  if (previous.value.final) {
    if (!publication) throw new SyncError('LOCAL_INTEGRITY_FAILED')
    const command = await new EncryptedOutbox(database, token).read(previous.value.final.mutationId)
    if (command?.receipt || await new SyncClient(token, profileSignal(token)).receipt(previous.value.final.mutationId)) throw new SyncError('REPLACEMENT_PUBLICATION_UNCERTAIN')
  }
  const handle = Object.freeze({})
  const retirement = { proof: handle, authority: previous.row, publication: publication?.row, intents: await database.outbox.toArray() }
  branches.set(handle, { database, token, fence, retirement })
  await assertReviewedBranch(database, token, handle)
  return { handle, retirement }
}

export function createReviewedReplacementService(database: AccountDatabase, token: ProfileToken) {
  const signal = profileSignal(token)
  const check = async (fence: AccountFence) => {
    assertActiveProfile(token)
    if (!same(await database.profileMeta.get('active'), fence)) throw new SyncError('LOCAL_REVISION_CONFLICT')
  }
  const ownedReview = (handle: ReviewedAccountData): Review => {
    const review = reviews.get(handle)
    if (!review || review.disposed || review.database !== database || review.token !== token) throw new SyncError('LOCAL_INTEGRITY_FAILED')
    return review
  }
  async function refresh(): Promise<ReviewedAccountData> {
    const fence = await database.profileMeta.get('active')
    if (!fence) throw new SyncError('LOCAL_INTEGRITY_FAILED')
    const captured = await captureAccountSyncWorkspace(database, token, fence, signal)
    let snapshot: WorkspaceSnapshot | undefined
    try {
      // A completed unactivated scan is a snapshot, not evidence that the account stayed unchanged
      // Restart discovery from the last selected remote floor and validate every complete group again
      const scan = await database.syncState.get('scan')
      await database.transaction('rw', database.syncState, async () => {
        assertActiveProfile(token)
        if (!same(await database.syncState.get('scan'), scan)) throw new SyncError('LOCAL_REVISION_CONFLICT')
        await database.syncState.delete('scan')
      })
      const previousRemote = await readRemoteState(database, token)
      let projection: RemoteProjection | null = null
      let candidate: PullCandidate | null = null
      while (!candidate) {
        await check(fence)
        candidate = await stagePull(database, token, new SyncClient(token, signal), async heads => {
          const next = await openRemoteProjection(database, token, heads, captured.workspace.head, captured.operativePlanner.localData.revision, captured.validatedEvidence)
          if (!projection) await assertProjectionAdvance(database, token, next, previousRemote?.value.effective)
          await assertProjectionSuccessor(database, token, next, projection)
          projection = next
        }, transferBudget())
      }
      const validated = projection as RemoteProjection | null
      if (!validated) throw new SyncError('ACCOUNT_PROJECTION_UNAVAILABLE')
      const previous = await readReviewedReplacement(database, token)
      snapshot = await captureAccountSnapshot(validated.workspace, { ...fence, head: validated.workspace.head }, () => check(fence), { database, token })
      const review: Review = { database, token, fence, captured, candidate, projection: validated, snapshot, previous, disposed: false }
      const handle: ReviewedAccountData = Object.freeze({ epoch: candidate.state.publicationEpoch, heads: Object.freeze(refs(candidate.heads)), snapshot, async dispose() {
        if (review.disposed) return
        review.disposed = true
        try { await disposeWorkspaceSnapshot(review.snapshot) } finally { await captured.dispose() }
      } })
      reviews.set(handle, review)
      return handle
    } catch (error) { if (snapshot) await disposeWorkspaceSnapshot(snapshot); await captured.dispose(); throw error }
  }
  async function assertFresh(review: Review) {
    await check(review.fence)
    if (!same(await database.syncState.get(REVIEWED_REPLACEMENT_KEY), review.previous?.row)) throw new SyncError('LOCAL_REVISION_CONFLICT')
    const fresh = await refresh()
    try { if (fresh.epoch !== review.candidate.state.publicationEpoch || !same(fresh.heads, refs(review.candidate.heads))) throw new SyncError('REPLACEMENT_REVIEW_REQUIRED') }
    finally { await fresh.dispose() }
  }
  async function preserve(review: Review, snapshot: WorkspaceSnapshot, operationId: string, intent: 'replace' | 'use-latest', displaced: WorkspaceSnapshot) {
    const id = `${PREPARATION_PREFIX}${OpaqueIdSchema.parse(operationId)}`
    const source = intent === 'use-latest' || branchSources.has(snapshot)
      ? { revisionVector: { accountHead: JSON.stringify(review.fence.head), headRevision: String(review.fence.headRevision) }, metadataDigest: await backupMetadataDigest({ accountId: token.accountId, branch: review.fence }) }
      : await stableWorkspaceSnapshotIdentity(snapshot)
    const binding = { version: 1 as const, kind: 'reviewed-replacement-preparation' as const, operationId, intent,
      sourceIdentity: source.metadataDigest, sourceVector: source.revisionVector, fence: review.fence,
      reviewedEpoch: review.candidate.state.publicationEpoch, reviewedHeads: refs(review.candidate.heads),
      ...(review.previous?.value.state === 'paused' ? { predecessorRecoveryId: review.previous.value.recoveryOperationId } : {}) }
    let stored = await readSyncState(database, token, id, PreparationSchema)
    if (stored && !same({ ...stored.value, state: undefined }, { ...binding, state: undefined })) throw new SyncError('IDEMPOTENCY_MISMATCH')
    if (!stored) {
      const value = { ...binding, state: 'preserving' as const }
      stored = { value, row: await writeSyncState(database, token, id, value, undefined, [review.fence.head, review.candidate.state.heads]) }
    }
    const recovery = createAccountRecoveryService(token)
    // The saved archive owns snapshot IDs, timestamps and ciphertext after its installation
    // A fresh capture at the same reviewed heads must resume it, never regenerate that archive
    if (await recovery.hasPreparation(operationId)) await recovery.resume(operationId)
    else if (binding.predecessorRecoveryId) await recovery.prepareSuccessor(operationId, displaced, binding.predecessorRecoveryId)
    else await recovery.prepare(operationId, displaced)
    if (stored.value.state !== 'sealed') {
      const value = { ...stored.value, state: 'sealed' as const }
      stored = { value, row: await writeSyncState(database, token, id, value, stored.row, [review.fence.head, review.candidate.state.heads]) }
    }
    return stored
  }
  async function prepare(handle: ReviewedAccountData, source: WorkspaceSnapshot, operationId: string): Promise<ReviewedReplacementStage> {
    const review = ownedReview(handle)
    await check(review.fence)
    await assertOwnedWorkspaceSnapshot(source)
    await assertWorkspaceSnapshotCurrent(source)
    const previous = review.previous
    if (previous && !['paused', 'accepted', 'selected-latest'].includes(previous.value.state)) throw new SyncError('REPLACEMENT_REVIEW_REQUIRED')
    if (previous?.value.state === 'paused' && !branchSources.has(source)) throw new SyncError('REPLACEMENT_REVIEW_REQUIRED')
    const branch = previous?.value.state === 'paused' ? await rejectedBranch(review) : undefined
    if (!branch && (await database.outbox.count() || await database.syncState.get('publication'))) throw new SyncError('REPLACEMENT_REVIEW_REQUIRED')
    const preparation = await phase(operationId, 'preserve', () => preserve(review, source, operationId, 'replace', review.snapshot))
    await assertFresh(review)
    const preview = await previewAccountWorkspaceRestore(database, token, source, branch?.handle)
    let restore: Awaited<ReturnType<typeof stageAccountWorkspaceRestore>> | undefined
    try {
      restore = await stageAccountWorkspaceRestore(preview)
      const value: ReviewedReplacement = { version: 1, kind: 'reviewed-replacement', operationId, intentId: restore.id, recoveryOperationId: operationId,
        reviewedEpoch: review.candidate.state.publicationEpoch, reviewedHeads: refs(review.candidate.heads), reviewedHeadRoot: review.candidate.state.heads, state: 'active',
        ...(branch ? { predecessorRecoveryId: previous!.value.recoveryOperationId, predecessorAuthority: previous!.row.ref } : {}) }
      const target = { expected: review.fence, head: restore.targetHead }
      const attachment = await prepareAccountSyncAttachment(database, token, target, [{ id: REVIEWED_REPLACEMENT_KEY, expected: previous?.row, value, dependencies: dependencies(value) }, { id: preparation.row.id, expected: preparation.row, value: { ...preparation.value, state: 'activated' } }], branch?.retirement)
      const staged = restore
      const result: ReviewedReplacementStage = Object.freeze({ id: restore.id, ...target, async dispose() { const ownedSource = stages.get(result)?.ownedSource; stages.delete(result); try { await releaseAccountWorkspaceRestoreStage(staged) } finally { await releaseAccountActivationAttachment(attachment); if (ownedSource) await disposeWorkspaceSnapshot(ownedSource) } } })
      stages.set(result, { operationId, review, restore, attachment })
      return result
    } catch (error) { if (restore) await releaseAccountWorkspaceRestoreStage(restore); throw error }
    finally { releaseAccountWorkspaceRestorePreview(preview) }
  }
  async function activate(handle: ReviewedReplacementStage, receipt?: AccountActivationAttachment): Promise<AccountFence> {
    const stage = stages.get(handle)
    if (!stage || stage.review.database !== database || stage.review.token !== token || stage.review.disposed) throw new SyncError('LOCAL_INTEGRITY_FAILED')
    await assertFresh(stage.review)
    const attachment = receipt ? combineAccountActivationAttachments(stage.attachment, receipt) : stage.attachment
    return phase(stage.operationId, stage.prepared ? 'use-latest' : 'activate', () => stage.prepared
      ? activateLocalAccountCommit(database, token, stage.prepared, undefined, attachment)
      : activateAccountWorkspaceRestore(stage.restore!, undefined, attachment))
  }
  async function approve(handle: ReviewedAccountData, operationId: string): Promise<ReviewedReplacementStage> {
    const review = ownedReview(handle)
    if (review.previous?.value.state !== 'paused') throw new SyncError('REPLACEMENT_REVIEW_REQUIRED')
    const snapshot = await captureAccountSnapshot({ ...review.captured.workspace, inheritedEvidence: review.captured.inheritedEvidence }, review.fence, () => check(review.fence), { database, token })
    branchSources.add(snapshot)
    try { const stage = await prepare(handle, snapshot, operationId); stages.get(stage)!.ownedSource = snapshot; return stage }
    // Restore retains its source through activation; the stage owns this capture until release
    catch (error) { await disposeWorkspaceSnapshot(snapshot); throw error }
  }
  async function prepareLatest(handle: ReviewedAccountData, operationId: string): Promise<ReviewedReplacementStage> {
    const review = ownedReview(handle), branch = await rejectedBranch(review)
    const snapshot = await captureAccountSnapshot({ ...review.captured.workspace, inheritedEvidence: review.captured.inheritedEvidence }, review.fence, () => check(review.fence), { database, token })
    let managed: Awaited<ReturnType<typeof prepareManagedAccountProjection>> | undefined
    let stagedAttachment: AccountActivationAttachment | undefined
    try {
      // No publication follows this read-only switch, so its sealed recovery remains pending
      const preparation = await phase(operationId, 'preserve', () => preserve(review, snapshot, operationId, 'use-latest', snapshot))
      await assertFresh(review)
      const remote = review.projection.workspace
      const native = remote.inheritedEvidence ? await prepareAccountWorkspaceWithExistingEvidence(database, token, remote.state, remote.inheritedEvidence, remote) : await prepareAccountWorkspace(database, token, remote.state, remote)
      const selection = Object.freeze({})
      selections.set(selection, { database, token, fence: review.fence, branch: branch.handle, recoveryOperationId: operationId })
      if (review.captured.managed) managed = await prepareManagedAccountProjection(database, token, review.fence, native, undefined, true, selection)
      const prepared: PreparedLocalActivation = managed?.prepared ?? { version: 1, id: accountLocalId(), expected: review.fence, head: native.head, records: native.records, requireSettledSync: true, validatedEvidence: native.validatedEvidence }
      const value: ReviewedReplacement = { ...review.previous!.value, operationId, recoveryOperationId: operationId, predecessorRecoveryId: review.previous!.value.recoveryOperationId, predecessorAuthority: review.previous!.row.ref, state: 'selected-latest', final: undefined, pauseReason: undefined, reviewedEpoch: review.candidate.state.publicationEpoch, reviewedHeads: refs(review.candidate.heads), reviewedHeadRoot: review.candidate.state.heads }
      const { stagePublicationPages } = await import('../account/sync/publication')
      const effective = { lineageId: review.projection.lineageId, control: review.projection.control, units: await stagePublicationPages(database, token, 'local-effective-units', [...review.projection.units.values()].map(unit => ({ key: unit.key, body: unit.body.ref, publication: unit.ref })).concat([...review.projection.lineages].map(([key, anchor]) => ({ key, body: anchor.value.selected, publication: anchor.ref }))), entry => [entry.body, entry.publication]) }
      const remoteState = { ...review.candidate.state, projectionPending: false, effective }
      const attachment = await prepareAccountSyncAttachment(database, token, prepared, [
        { id: REVIEWED_REPLACEMENT_KEY, expected: review.previous!.row, value, dependencies: dependencies(value) },
        { id: preparation.row.id, expected: preparation.row, value: { ...preparation.value, state: 'activated' } },
        { id: 'remote', expected: review.candidate.previous, value: remoteState, dependencies: [remoteState.heads, effective.control, effective.units] },
        { id: 'projection', expected: await database.syncState.get('projection'), value: remoteState, dependencies: [remoteState.heads, effective.control, effective.units] },
      ], branch.retirement)
      stagedAttachment = attachment
      await assertFresh(review)
      const owner = managed
      const result: ReviewedReplacementStage = Object.freeze({ id: prepared.id, expected: review.fence, head: prepared.head, async dispose() {
        stages.delete(result)
        try { await owner?.dispose() } finally { await releaseAccountActivationAttachment(attachment); await disposeWorkspaceSnapshot(snapshot) }
      } })
      stages.set(result, { operationId, review, prepared, attachment })
      return result
    } catch (error) { await managed?.dispose(); if (stagedAttachment) await releaseAccountActivationAttachment(stagedAttachment); await disposeWorkspaceSnapshot(snapshot); throw error }
  }
  async function useLatest(handle: ReviewedAccountData, operationId: string): Promise<AccountFence> {
    const stage = await prepareLatest(handle, operationId)
    try { return await activate(stage) } finally { await stage.dispose() }
  }
  const preparations = async () => {
    const values = []
    for (const row of await database.syncState.toArray()) if (row.id.startsWith(PREPARATION_PREFIX)) {
      const saved = await readSyncState(database, token, row.id, PreparationSchema)
      if (saved && saved.value.state !== 'activated') values.push(saved.value)
    }
    return values
  }
  return { refresh, prepare, activate, approve, prepareLatest, useLatest, preparations, status: async () => (await readReviewedReplacement(database, token))?.value }
}
