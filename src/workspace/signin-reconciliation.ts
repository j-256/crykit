import { beginSigninMergeDiagnostics, type SigninMergeStage } from './signin-merge-diagnostics'
import { z } from 'zod'
import { assertActiveProfile, onProfileSessionChange, profileSignal, type ProfileToken } from '../account/profile'
import { OpaqueIdSchema } from '../account/protocol'
import { attachSyncScheduler, drainSyncSchedulers, subscribeSync, type Runner, type SyncSchedulerOwner } from '../account/sync/scheduler'
import { readRemoteHeads, RemoteStateSchema } from '../account/sync/pull'
import { registerSyncProjectionGuard, runSyncIteration } from '../account/sync/outbox'
import { AccountDatabase, type EncryptedSyncState } from '../persistence/account-database'
import { commitAccountReceipt, prepareAccountReceiptAttachment, releaseAccountActivationAttachment } from '../persistence/account-activation-attachments'
import { jsonEqual } from '../persistence/local-data'
import { accountLocalId, openAccountJson } from './account-cache'
import { captureExistingGuestWorkspaceForSignin, type GuestCopySource } from './guest-repository'
import { createGuestCopyService, type GuestCopyPreview, type SigninMergeReview, type PreparedSigninMerge } from './guest-copy'
import { GuestCopyJournalSchema, PENDING_COPY, SAVED_COPY_PREFIX } from './guest-copy-journal'
import { captureWorkspaceDocuments, privateRecordKey, type WorkspaceState } from './documents'
import { classifySigninLocalData, type SigninLocalSummary } from './signin-local-data'
import { assertReviewedDecisionActivation, createReviewedReplacementService, stableWorkspaceSnapshotIdentity, type ReviewedAccountData, type ReviewedReplacement, type StableWorkspaceSnapshotIdentity } from './reviewed-replacement'
import { createAccountRecoveryService } from './account-recovery'
import { captureAccountSyncWorkspace } from './account-sync-capture'
import { captureAccountSnapshot } from './account-snapshot'
import { disposeWorkspaceSnapshot, type WorkspaceSnapshot } from './snapshot'

export const SIGNIN_DECISION_KEY = 'signin-receipt:decision'
const RECOVERY_DECISION_PREFIX = 'signin-receipt:recovery:'
export const SigninDecisionSchema = z.strictObject({
  version: z.literal(1), kind: z.literal('signin-decision'), accountId: OpaqueIdSchema,
  source: z.strictObject({ revisionVector: z.record(z.string(), z.string()), metadataDigest: z.string() }).nullable(),
  action: z.enum(['merge', 'account', 'device', 'latest']), operationId: OpaqueIdSchema,
  copyId: OpaqueIdSchema.optional(), cleanupPending: z.boolean().optional(), status: z.enum(['preparing', 'complete', 'cancelled']),
}).refine(value => value.action === 'merge' ? !!value.copyId && !!value.source : value.copyId === undefined)
export type SigninDecision = z.infer<typeof SigninDecisionSchema>
// Startup must discover this owner before ordinary pull can replace a saved copy's publication base
// The encrypted preparing receipt grants identity; a manual pending copy alone never selects recovery
export async function readPendingRecoveryEntry(token: ProfileToken): Promise<SigninReconciliationOptions['entry']> {
  assertActiveProfile(token)
  const database = new AccountDatabase(token.accountId)
  try {
    const rows = await database.syncState.where('id').startsWith(RECOVERY_DECISION_PREFIX).toArray()
    assertActiveProfile(token)
    let entry: SigninReconciliationOptions['entry']
    let pending: EncryptedSyncState | undefined, copy: EncryptedSyncState | undefined
    for (const row of rows) {
      assertActiveProfile(token)
      const value = await openAccountJson(database, token, row.ref, SigninDecisionSchema)
      assertActiveProfile(token)
      if (value.accountId !== token.accountId) throw new Error('SIGNIN_RECEIPT_MISMATCH')
      if (value.status !== 'preparing') continue
      const pointId = OpaqueIdSchema.parse(row.id.slice(RECOVERY_DECISION_PREFIX.length))
      if (entry) throw new Error('SIGNIN_RECEIPT_MISMATCH')
      if (value.action === 'merge') {
        pending = await database.syncState.get(PENDING_COPY)
        assertActiveProfile(token)
        copy = await database.syncState.get(`${SAVED_COPY_PREFIX}${value.copyId}`)
        assertActiveProfile(token)
        if (!pending || !copy || !jsonEqual(pending.ref, copy.ref)) throw new Error('SIGNIN_RECEIPT_MISMATCH')
        const journal = await openAccountJson(database, token, copy.ref, GuestCopyJournalSchema)
        assertActiveProfile(token)
        if (!journal.preview.signin || journal.preview.accountId !== token.accountId || journal.preview.copyId !== value.copyId) throw new Error('SIGNIN_RECEIPT_MISMATCH')
      }
      entry = { kind: 'recovery', pointId }
    }
    // Crypto reads happen outside native transactions; recheck every discovered association before handing off
    await database.transaction('r', database.syncState, async () => {
      assertActiveProfile(token)
      if (!jsonEqual(await database.syncState.where('id').startsWith(RECOVERY_DECISION_PREFIX).toArray(), rows)
        || pending && !jsonEqual(await database.syncState.get(PENDING_COPY), pending)
        || copy && !jsonEqual(await database.syncState.get(copy.id), copy)) throw new Error('SIGNIN_RECEIPT_MISMATCH')
      assertActiveProfile(token)
    })
    assertActiveProfile(token)
    return entry
  } finally { database.close() }
}
export type SigninAction = 'merge' | 'account' | 'device'
export type SigninPreparationStage = 'waiting-for-sync' | 'reading-source' | 'opening-account' | 'syncing-account' | 'checking-account' | 'checking-source' | 'comparing-records' | 'preparing-review' | 'preparing-merge'
export type SigninPhase = 'inspecting' | 'preparing' | 'choosing' | 'confirming' | 'committing' | 'opening' | 'complete' | 'cancelled' | 'failed'
export interface SigninDisplaySummary extends SigninLocalSummary {
  readonly recordNames?: Readonly<Record<string, string>>
  readonly progressByPlaythrough: readonly { readonly playthroughId: string; readonly label?: string; readonly count: number }[]
  readonly otherByKind: readonly { readonly kind: string; readonly count: number }[]
}
function summarize(workspace: WorkspaceState): SigninDisplaySummary {
  const summary = classifySigninLocalData(workspace)
  const recordNames: Record<string, string> = {}
  // Display names come from captured metadata, never persisted preview fallback strings or storage IDs
  captureWorkspaceDocuments(workspace, (kind, key, input) => {
    const value = input as { title?: string; label?: string; name?: string; filename?: string; relativePath?: string; metadata?: { label?: string } } | undefined
    const name = [value?.title, value?.label, value?.name, value?.filename, value?.relativePath, value?.metadata?.label].find(value => typeof value === 'string' && value.trim())
    if (name) recordNames[key] = name
    return { version: 1, kind, key, value: null }
  })
  for (const [id, playthrough] of Object.entries(workspace.planner.localData.playthroughs)) {
    if (playthrough.label) recordNames[privateRecordKey('inventory', id)] = playthrough.label
    for (const [recordId, progress] of Object.entries(playthrough.progress)) {
      const name = [playthrough.label, progress.displayName].filter(Boolean).join(' / ')
      if (name) recordNames[privateRecordKey('progress', id, recordId)] = name
    }
  }
  const progress = new Map<string, number>(), other = new Map<string, number>()
  for (const reason of summary.reasons) {
    if (reason.category === 'progress') {
      const [, id] = JSON.parse(reason.rootKey) as string[]
      progress.set(id, (progress.get(id) ?? 0) + 1)
    } else if (reason.category === 'other') other.set(reason.code, (other.get(reason.code) ?? 0) + 1)
  }
  // Labels are private display content only; exact IDs, never labels, group source observations
  return { ...summary, recordNames, progressByPlaythrough: [...progress].map(([playthroughId, count]) => ({ playthroughId, label: workspace.planner.localData.playthroughs[playthroughId]?.label, count })), otherByKind: [...other].map(([kind, count]) => ({ kind, count })) }
}
export interface SigninReconciliationState {
  readonly phase: SigninPhase
  readonly stage?: SigninPreparationStage
  readonly source: 'unknown' | 'absent' | 'available' | 'unavailable'
  readonly local?: SigninDisplaySummary
  readonly account?: SigninDisplaySummary
  readonly fresh: boolean
  readonly canOpenAccount: boolean
  readonly action?: SigninAction | 'latest'
  readonly preview?: GuestCopyPreview
  readonly replacement?: ReviewedReplacement
  readonly reason?: string
  readonly cleanupPending?: boolean
}
export interface SigninReconciliationOptions {
  // Selection effects belong to the provider; successful activation survives an effect failure
  readonly openAccount: (token: ProfileToken) => Promise<void>
  readonly continueLocal: (token: ProfileToken) => Promise<void>
  readonly entry?: { readonly kind: 'recovery'; readonly pointId: string }
  readonly captureGuest?: () => Promise<GuestCopySource | undefined>
  readonly run?: Runner
  // Only a previously admitted selected account may use this offline escape hatch
  readonly admittedOffline?: boolean
}

export function createSigninReconciliation(options: SigninReconciliationOptions) {
  let diagnostics: ReturnType<typeof beginSigninMergeDiagnostics>
  let diagnosticStarted = 0
  let diagnosticStage: SigninMergeStage = 'signin'
  const recordDiagnostic = (stage: SigninMergeStage, outcome: 'started' | 'complete' | 'failed' | 'cancelled', errorCode?: string) => diagnostics?.record({ stage, outcome, elapsedMs: performance.now() - diagnosticStarted, ...(errorCode ? { errorCode } : {}) })
  const recoveryEntry = options.entry
  const decisionKey = recoveryEntry ? `${RECOVERY_DECISION_PREFIX}${OpaqueIdSchema.parse(recoveryEntry.pointId)}` : SIGNIN_DECISION_KEY
  let state: SigninReconciliationState = { phase: 'inspecting', source: 'unknown', fresh: false, canOpenAccount: false }
  const listeners = new Set<() => void>()
  let token: ProfileToken, database: AccountDatabase | undefined
  let source: GuestCopySource | undefined, identity: StableWorkspaceSnapshotIdentity | null = null
  let review: ReviewedAccountData | undefined, copy: ReturnType<typeof createGuestCopyService> | undefined
  // This owner is deliberately absent from storage until Confirm; reload must ask again
  let pendingMerge: { readonly review: SigninMergeReview; readonly decision: SigninDecision; readonly expected?: EncryptedSyncState } | undefined
  let preparedMerge: PreparedSigninMerge | undefined
  let saved: { row: EncryptedSyncState; value: SigninDecision } | undefined
  let scheduler: SyncSchedulerOwner | undefined, unregister: (() => void) | undefined
  let active: Promise<void> | undefined, disposed = false, activated = false, cancelling = false
  let lifetime = new AbortController()
  let operationId: string | undefined
  let unsubscribeSession: (() => void) | undefined
  const online = () => { void reconnect() }
  const check = () => { if (disposed || cancelling) throw new Error('SIGNIN_CANCELLED'); lifetime.signal.throwIfAborted(); assertActiveProfile(token) }
  const publish = (change: Partial<SigninReconciliationState>) => {
    if (disposed) return
    // Stage feedback is transient; a phase transition cannot retain a completed operation's label
    state = { ...state, ...(change.phase ? { stage: undefined } : {}), ...change }
    if (change.phase === 'choosing') recordDiagnostic('chooser', 'complete')
    else if (change.phase === 'confirming') recordDiagnostic('review', 'complete')
    else if (change.phase === 'complete') recordDiagnostic('local-open', 'complete')
    else if (change.phase === 'failed') recordDiagnostic(diagnosticStage, 'failed', change.reason)
    else if (change.phase === 'cancelled') recordDiagnostic(diagnosticStage, 'cancelled')
    for (const listener of listeners) { try { listener() } catch { /* Observers cannot alter durable decisions */ } }
  }
  const preparationStage = (stage: SigninPreparationStage) => { check(); diagnosticStage = stage; recordDiagnostic(stage, 'started'); publish({ stage }) }
  const service = () => createReviewedReplacementService(database!, token)
  async function readDecision() {
    const row = await database!.syncState.get(decisionKey)
    const value = row ? await openAccountJson(database!, token, row.ref, SigninDecisionSchema) : undefined
    if (value && value.accountId !== token.accountId) throw new Error('SIGNIN_RECEIPT_MISMATCH')
    return row && value ? { row, value } : undefined
  }
  async function drain() {
    const owner = scheduler; scheduler = undefined
    try { await owner?.drain() } finally { unregister?.(); unregister = undefined }
  }
  async function releaseReview() { const old = review; review = undefined; await old?.dispose() }
  async function releaseSource() {
    await preparedMerge?.dispose(); preparedMerge = undefined
    await pendingMerge?.review.dispose(); pendingMerge = undefined
    await copy?.dispose(); copy = undefined
    const old = source; source = undefined
    if (old) await disposeWorkspaceSnapshot(old.snapshot)
  }
  function safeReason(error: unknown) {
    const code = error instanceof Error ? error.message : ''
    const known: Record<string, string> = { QUOTA_EXCEEDED: 'quota', LOCAL_REVISION_CONFLICT: 'review-stale', HEAD_CONFLICT: 'review-stale', REPLACEMENT_REVIEW_REQUIRED: 'replacement-review-required', IDEMPOTENCY_MISMATCH: 'source-changed', SIGNIN_SOURCE_CHANGED: 'source-changed', SIGNIN_RECEIPT_MISMATCH: 'receipt-mismatch', SIGNIN_OFFLINE: 'offline', ONLINE_ACCESS_DISCONNECTED: 'signin-required', AUTH_REQUIRED: 'signin-required', CSRF_FAILED: 'signin-required', SIGNIN_CANCELLED: 'cancelled', PROFILE_CHANGED: 'profile-changed', ACCOUNT_PROJECTION_UNAVAILABLE: 'account-unavailable' }
    if (['A pending copy must be resumed by its saved operation ID or kept before starting a new sign-in merge', 'The saved sign-in copy is unavailable', 'The saved sign-in copy identity is unsupported'].includes(code)) return 'saved-copy-review-required'
    return known[code] ?? (state.phase === 'opening' ? 'opening-failed' : 'preparation-failed')
  }
  function execute(work: () => Promise<void>): Promise<void> {
    if (active) return active
    if (disposed) return Promise.resolve()
    const pending = Promise.resolve().then(work).catch(error => {
      if (!disposed && !cancelling) publish({ phase: 'failed', reason: safeReason(error) })
    }).finally(() => { if (active === pending) active = undefined })
    active = pending
    return pending
  }
  async function remember(value: SigninDecision, cancellation = false) {
    if (cancellation) assertActiveProfile(token); else check()
    const expected = await database!.profileMeta.get('active')
    if (!expected) throw new Error('ACCOUNT_PROJECTION_UNAVAILABLE')
    const attachment = await prepareAccountReceiptAttachment(database!, token, { expected, head: expected.head }, { id: decisionKey, expected: saved?.row, value })
    try { if (cancellation) assertActiveProfile(token); else check(); await commitAccountReceipt(database!, token, attachment) }
    finally { await releaseAccountActivationAttachment(attachment) }
    saved = await readDecision(); operationId = value.operationId
  }
  async function open() {
    await drain(); check()
    await releaseReview(); await releaseSource(); check()
    publish({ phase: 'opening', reason: undefined })
    await options.openAccount(token)
    check(); publish({ phase: 'complete' })
  }
  async function cleanupRecoveries() {
    // Read-only transport cleanup must never make an admitted cached account unavailable offline
    try { await createAccountRecoveryService(token).list() } catch { /* Reconnection retries exact local ownership */ }
  }
  async function reconnect() { if (!disposed && database) await cleanupRecoveries() }
  async function selectedProjection() {
    const fence = await database!.profileMeta.get('active'), row = await database!.syncState.get('projection')
    if (!fence || !row) return undefined
    const selected = await openAccountJson(database!, token, row.ref, RemoteStateSchema)
    if (!selected.initialComplete || selected.projectionPending) return undefined
    const heads = await readRemoteHeads(database!, token, selected.heads)
    check(); publish({ canOpenAccount: true })
    return { epoch: selected.publicationEpoch, heads: [...heads].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([documentId, revisionId]) => ({ documentId, revisionId })) }
  }
  async function requireSelectedReview(handle: ReviewedAccountData) {
    const selected = await selectedProjection()
    // Read-only discovery can be newer than the selected destination; it cannot authorize a merge into that old base
    if (!selected || selected.epoch !== handle.epoch || !jsonEqual(selected.heads, handle.heads)) throw new Error('HEAD_CONFLICT')
  }
  async function prepareAccount() {
    publish({ phase: 'preparing', fresh: false, reason: undefined })
    preparationStage('waiting-for-sync')
    await drainSyncSchedulers(); check()
    preparationStage('opening-account')
    if (!await database!.profileMeta.get('active')) {
      const { openAccountRepository } = await import('./account-repository')
      await openAccountRepository(token)
    }
    check()
    await selectedProjection()
    if (typeof navigator !== 'undefined' && !navigator.onLine) throw new Error('SIGNIN_OFFLINE')
    const retainedPreparation = await database!.syncState.get('guest-copy:pending') || saved?.value.status === 'preparing'
    if (!retainedPreparation) {
      preparationStage('syncing-account')
      unregister = registerSyncProjectionGuard(token, () => !disposed && !cancelling)
      scheduler = attachSyncScheduler(token, options.run ?? runSyncIteration)
      let unsubscribe: (() => void) | undefined
      const signal = AbortSignal.any([lifetime.signal, profileSignal(token)])
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          let observed = false
          const unlisten = subscribeSync(token, next => {
            if (next === 'syncing') observed = true
            if (next === 'synced' || next === 'conflict' || observed && next === 'paused') resolve()
            else if (['offline', 'signin-required', 'quota', 'failed'].includes(next)) reject(new Error(next === 'offline' ? 'SIGNIN_OFFLINE' : next === 'quota' ? 'QUOTA_EXCEEDED' : 'SIGNIN_PREPARATION_FAILED'))
          })
          unsubscribe = () => { unlisten(); signal.removeEventListener('abort', abort) }
          if (signal.aborted) abort()
        })
      } finally { unsubscribe?.(); await drain() }
    } else if (!await database!.syncState.get('projection')) throw new Error('ACCOUNT_PROJECTION_UNAVAILABLE')
    // Discovery must not rewrite the publication-base row owned by an exact saved copy
    preparationStage('checking-account')
    await releaseReview(); review = await service().refresh(); check()
    const replacement = await service().status()
    if (replacement?.state !== 'paused') await requireSelectedReview(review)
    publish({ fresh: true, account: summarize(review.snapshot.state), replacement })
  }
  async function currentSource() {
    if (!source || !identity || !jsonEqual(await stableWorkspaceSnapshotIdentity(source.snapshot), identity)) throw new Error('SIGNIN_SOURCE_CHANGED')
  }
  async function freshReview() {
    if (!state.fresh || !review) throw new Error('ACCOUNT_PROJECTION_UNAVAILABLE')
    const latest = await service().refresh()
    try {
      check()
      if (state.replacement?.state !== 'paused') await requireSelectedReview(latest)
      if (review.epoch !== latest.epoch || !jsonEqual(review.heads, latest.heads)) throw new Error('HEAD_CONFLICT')
    } finally { await latest.dispose() }
  }
  async function verifyCompletedDecision() {
    if (!await database!.profileMeta.get('active')) throw new Error('ACCOUNT_PROJECTION_UNAVAILABLE')
    if (!saved || saved.value.status !== 'complete') throw new Error('SIGNIN_RECEIPT_MISMATCH')
    if (saved.value.action === 'merge') {
      if (!saved.value.copyId || !await database!.migrationJournal.get(saved.value.copyId)) throw new Error('SIGNIN_RECEIPT_MISMATCH')
      copy ??= createGuestCopyService(async () => { throw new Error('SIGNIN_RECEIPT_MISMATCH') }, check)
      const preview = await copy.previewSigninMerge(token, saved.value.copyId)
      await copy.commitGuestCopy(token, preview, { id: decisionKey, expected: saved.row, value: saved.value })
    } else if (saved.value.action !== 'account') {
      await assertReviewedDecisionActivation(database!, token, saved.row, saved.value)
    }
  }
  async function inspect() {
    check(); publish({ phase: 'inspecting', reason: undefined })
    saved = await readDecision()
    const replacement = await service().status()
    publish({ replacement })
    await releaseSource()
    try {
      preparationStage('reading-source')
      source = await (options.captureGuest ?? captureExistingGuestWorkspaceForSignin)(); check()
      identity = source ? await stableWorkspaceSnapshotIdentity(source.snapshot) : null
      check(); publish({ source: source ? 'available' : 'absent', local: source ? summarize(source.snapshot.state) : undefined })
    } catch (error) { check(); if (source) await disposeWorkspaceSnapshot(source.snapshot); source = undefined; identity = null; publish({ source: 'unavailable', local: undefined }); if (error instanceof Error && error.message === 'PROFILE_CHANGED') throw error }
    check()
    void cleanupRecoveries()
    const matches = state.source !== 'unavailable' && saved && jsonEqual(saved.value.source, identity)
    // A completed exact receipt admits cached opening without reimporting or waiting on network
    if (!recoveryEntry && matches && saved!.value.status === 'complete' && replacement?.state !== 'paused') { await verifyCompletedDecision(); activated = true; publish({ canOpenAccount: true }); await open(); return }
    try { await prepareAccount() }
    catch (error) {
      if (options.admittedOffline && state.canOpenAccount) {
        publish({ phase: 'choosing', fresh: false, reason: safeReason(error) }); return
      }
      throw error
    }
    // Explicit recovery entry always reviews even empty snapshots and completed prior choices
    // Preparing receipts still resume below; opening retry follows activated ownership
    if (!recoveryEntry && state.replacement?.state !== 'paused' && (!source && state.source === 'absent' || source && !state.local?.meaningful)) {
      await remember(SigninDecisionSchema.parse({ version: 1, kind: 'signin-decision', accountId: token.accountId, source: identity, action: 'account', operationId: accountLocalId(), status: 'complete' }))
      activated = true; await open(); return
    }
    publish({ phase: 'choosing', cleanupPending: saved?.value.cleanupPending })
    if (matches && saved!.value.status === 'preparing') {
      operationId = saved!.value.operationId
      const preparation = (await service().preparations()).find(value => value.operationId === operationId)
      if (preparation && saved!.value.action === 'device' && state.replacement?.state !== 'paused'
        && (!jsonEqual(preparation.sourceVector, identity?.revisionVector) || preparation.sourceIdentity !== identity?.metadataDigest)) throw new Error('SIGNIN_SOURCE_CHANGED')
      if (saved!.value.action === 'merge') {
        copy = createGuestCopyService(async () => { await currentSource(); return source! }, check)
        publish({ phase: 'preparing' }); preparationStage('comparing-records')
        const preview = await copy.previewSigninMerge(token, saved!.value.copyId)
        check(); publish({ phase: 'confirming', action: 'merge', preview })
      } else publish({ phase: 'confirming', action: saved!.value.action })
    }
  }
  function begin(next: ProfileToken) {
    return execute(async () => {
      if (database) throw new Error('SIGNIN_ALREADY_STARTED')
      diagnostics = beginSigninMergeDiagnostics(); diagnosticStarted = performance.now(); recordDiagnostic('signin', 'started')
      token = next; assertActiveProfile(token); preparationStage('waiting-for-sync'); await drainSyncSchedulers(); check(); database = new AccountDatabase(token.accountId)
      publish({ canOpenAccount: !!options.admittedOffline && !!await database.profileMeta.get('active') })
      unsubscribeSession = onProfileSessionChange(token, online)
      if (typeof window !== 'undefined') window.addEventListener('online', online)
      await inspect()
    })
  }
  function choose(action: SigninAction) {
    return execute(async () => {
      recordDiagnostic('review', 'started')
      check()
      if (activated) { await open(); return }
      if (state.replacement?.state === 'paused') throw new Error('REPLACEMENT_REVIEW_REQUIRED')
      if (action === 'account') {
        if (!state.canOpenAccount) throw new Error('ACCOUNT_PROJECTION_UNAVAILABLE')
        publish({ phase: 'committing', action, preview: undefined, reason: undefined })
        if (state.source !== 'unavailable') await remember(SigninDecisionSchema.parse({ version: 1, kind: 'signin-decision', accountId: token.accountId, source: identity, action, operationId: accountLocalId(), status: 'complete' }))
        activated = true; await open(); return
      }
      // Source and remote validation can be expensive; retire the visible choices before awaiting either
      publish({ phase: 'preparing', action, preview: undefined, reason: undefined })
      preparationStage('checking-source'); await currentSource()
      preparationStage('checking-account'); await freshReview()
      await pendingMerge?.review.dispose(); pendingMerge = undefined
      const value: SigninDecision = { version: 1, kind: 'signin-decision', accountId: token.accountId, source: identity, action, operationId: accountLocalId(), status: 'preparing' }
      if (action === 'merge') {
        copy ??= createGuestCopyService(async () => { await currentSource(); return source! }, check)
        preparationStage('comparing-records')
        const mergeReview = await copy.previewSigninMergeReview(token, review!)
        value.copyId = mergeReview.preview.copyId
        operationId = value.operationId
        pendingMerge = { review: mergeReview, decision: value, expected: saved?.row }
        check(); publish({ phase: 'confirming', preview: mergeReview.preview })
      } else { preparationStage('preparing-review'); await remember(value); check(); publish({ phase: 'confirming' }) }
    })
  }
  function confirm() {
    return execute(async () => {
      recordDiagnostic('confirm', 'started')
      check()
      saved = await readDecision()
      if (activated || saved?.value.status === 'complete' && saved.value.operationId === operationId) { activated = true; await open(); return }
      const pending = pendingMerge
      const reviewed = pending?.decision ?? saved?.value
      if (!reviewed || reviewed.status !== 'preparing' || state.phase !== 'confirming' || reviewed.operationId !== operationId || reviewed.action !== state.action || !jsonEqual(reviewed.source, identity)) throw new Error('SIGNIN_REVIEW_REQUIRED')
      // Preserve the exact reviewed action and preview while checking its authority again
      publish({ phase: 'preparing', reason: undefined })
      preparationStage('checking-account'); await freshReview()
      if (pending) {
        preparationStage('checking-source'); await currentSource(); check()
        preparationStage('preparing-merge')
        preparedMerge = await copy!.prepareReviewedSigninMerge(token, pending.review, { id: decisionKey, expected: pending.expected, value: pending.decision })
        // Readback is authoritative when staging persisted but its response was lost
        saved = await readDecision(); check()
      }
      // IDs alone cannot authorize a receipt rewritten while preparation was returning
      if (!saved || !jsonEqual(saved.value, reviewed)) throw new Error('SIGNIN_RECEIPT_MISMATCH')
      const decision = { ...saved.value, status: 'complete' as const }
      const receipt = { id: decisionKey, expected: saved.row, value: decision }
      publish({ phase: 'committing', reason: undefined })
      if (decision.action === 'merge') {
        if (!copy || !state.preview || decision.copyId !== state.preview.copyId) throw new Error('SIGNIN_RECEIPT_MISMATCH')
        if (preparedMerge) await preparedMerge.activate(receipt)
        else await copy.commitGuestCopy(token, state.preview, receipt)
      } else {
        const replacements = service()
        if (decision.action === 'device' && state.replacement?.state !== 'paused') await currentSource()
        const stage = decision.action === 'latest' ? await replacements.prepareLatest(review!, decision.operationId)
          : state.replacement?.state === 'paused' ? await replacements.approve(review!, decision.operationId)
            : await replacements.prepare(review!, source!.snapshot, decision.operationId)
        let attachment
        try {
          attachment = await prepareAccountReceiptAttachment(database!, token, stage, receipt)
          check(); await replacements.activate(stage, attachment)
        } finally { if (attachment) await releaseAccountActivationAttachment(attachment); await stage.dispose() }
      }
      activated = true; saved = await readDecision(); await releaseReview(); await open()
    })
  }
  function retry() {
    return execute(async () => {
      check(); saved = await readDecision()
      if (activated || saved?.value.status === 'complete' && saved.value.operationId === operationId) { activated = true; await open(); return }
      await inspect()
    })
  }
  async function cancel() {
    if (disposed) return
    cancelling = true
    scheduler?.()
    // Stop a waiting preparation immediately, then let any activation finish before interpreting cancellation
    lifetime.abort(new Error('SIGNIN_CANCELLED'))
    await active
    await drain()
    if (!database) { assertActiveProfile(token); await options.continueLocal(token); publish({ phase: 'cancelled' }); return }
    saved = await readDecision()
    if (activated || saved?.value.status === 'complete' && saved.value.operationId === operationId) {
      cancelling = false; lifetime = new AbortController(); activated = true
      // A durable result still releases every capture before the provider acquires editing ownership
      try { await open() } catch { publish({ phase: 'failed', reason: 'opening-failed' }) }
      return
    }
    let cleanupPending = false
    if (saved && (saved.value.status === 'preparing' || saved.value.cleanupPending) && saved.value.action !== 'merge') {
      try {
        const result = await createAccountRecoveryService(token).cancelPreparation(saved.value.operationId)
        cleanupPending = result.state === 'blocked' || result.state === 'pending'
      } catch { cleanupPending = true }
    }
    if (saved && (saved.value.status === 'preparing' || saved.value.cleanupPending)) {
      try { await remember({ ...saved.value, status: 'cancelled', cleanupPending }, true) } catch { cleanupPending = true }
    }
    await releaseReview(); await releaseSource()
    assertActiveProfile(token); await options.continueLocal(token)
    publish({ phase: 'cancelled', cleanupPending, reason: cleanupPending ? 'cleanup-pending' : undefined })
  }
  function reviewReplacement(action: 'device' | 'latest') {
    return execute(async () => {
      check()
      publish({ phase: 'preparing', action, preview: undefined, reason: undefined })
      preparationStage('checking-account')
      await releaseReview(); review = await service().refresh(); check()
      const replacement = await service().status()
      if (replacement?.state !== 'paused') throw new Error('REPLACEMENT_REVIEW_REQUIRED')
      publish({ fresh: true, replacement, action, preview: undefined })
      await remember({ version: 1, kind: 'signin-decision', accountId: token.accountId, source: identity, action, operationId: accountLocalId(), status: 'preparing' })
      check(); publish({ phase: 'confirming' })
    })
  }
  function declineReplacement() {
    return execute(async () => {
      check()
      if ((await service().status())?.state !== 'paused') throw new Error('REPLACEMENT_REVIEW_REQUIRED')
      if (saved?.value.status === 'preparing') await remember({ ...saved.value, status: 'cancelled' })
      publish({ phase: 'choosing', action: undefined, preview: undefined }); await open()
    })
  }
  async function withPrivateBackup<T>(read: (snapshot: WorkspaceSnapshot) => Promise<T>): Promise<T> {
    check()
    const fence = await database!.profileMeta.get('active')
    if (!fence) throw new Error('ACCOUNT_PROJECTION_UNAVAILABLE')
    const captured = await captureAccountSyncWorkspace(database!, token, fence)
    const current = async () => { check(); if (!jsonEqual(await database!.profileMeta.get('active'), fence)) throw new Error('LOCAL_REVISION_CONFLICT') }
    let snapshot: WorkspaceSnapshot | undefined
    try {
      snapshot = await captureAccountSnapshot({ ...captured.workspace, inheritedEvidence: captured.inheritedEvidence }, fence, current, { database: database!, token })
      const result = await read(snapshot); await current(); return result
    } finally { if (snapshot) await disposeWorkspaceSnapshot(snapshot); await captured.dispose() }
  }
  async function dispose() {
    if (disposed) return
    disposed = true; unsubscribeSession?.(); if (typeof window !== 'undefined') window.removeEventListener('online', online); lifetime.abort(new Error('SIGNIN_CANCELLED')); scheduler?.()
    await active; await drain(); await releaseReview(); await releaseSource(); database?.close(); listeners.clear()
  }
  return { begin, choose, confirm, cancel, retry, reconnect, reviewReplacement, declineReplacement, withPrivateBackup, dispose,
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
