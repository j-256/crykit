import { captureAccountSyncWorkspace } from '../../workspace/account-sync-capture'
import { prepareManagedAccountProjection } from '../../workspace/account-managed-projection'
import { retirePendingContent } from '../../workspace/pending-content'
import { z } from 'zod'
import { projectPlanner } from '../../workspace/planner-journal'
import { openAccountWorkspace, prepareAccountWorkspace } from '../../workspace/account-graph'
import { claimBulkRebase } from './scheduler'
import { preserveLocalSelections } from '../../workspace/local-selections'
import { MappedWorkspaceIntentSchema, readMappedWorkspaceChanges } from '../../workspace/account-intents'
import { assertActiveProfile, profileSignal, type ProfileToken } from '../profile'
import { CommitRequestSchema, CommitReceiptSchema, UploadStartSchema, maxCommitJsonBytes, type CommitRequest, type CommitReceipt } from '../protocol'
import type { AccountDatabase, CipherRecord, CipherRef, EncryptedSyncState } from '../../persistence/account-database'
import { accountLocalId, cipherRef, openAccountJson, stageAccountJson } from '../../workspace/account-cache'
import { SyncError, SyncClient } from './client'
import { CommitContinuationSchema } from '../protocol'
import { checkCommitProgress, CommitProgress } from './commit-progress'

export const MAX_TRANSFER_CHUNKS = 16
export const MAX_CONCURRENT_UPLOADS = 2
export const MAX_METADATA_READS = 100
export interface TransferBudget { remaining: number; metadataRemaining: number }
export function transferBudget(): TransferBudget { return { remaining: MAX_TRANSFER_CHUNKS, metadataRemaining: MAX_METADATA_READS } }
const uploadSchema = z.strictObject({ start: z.string(), payloadId: z.string(), nextChunk: z.number().int().nonnegative(), ready: z.boolean() })
export const TransportCommandSchema = z.strictObject({ version: z.literal(1), kind: z.literal('transport-command'), request: z.string(), uploads: z.array(uploadSchema), receipt: CommitReceiptSchema.optional(), continuation: CommitContinuationSchema.optional() })
export type TransportCommand = z.infer<typeof TransportCommandSchema>
const idFor = (mutationId: string) => `command:${mutationId}`

export async function readSyncState<T>(database: AccountDatabase, token: ProfileToken, id: string, schema: z.ZodType<T>): Promise<{ row: EncryptedSyncState; value: T } | undefined> {
  assertActiveProfile(token)
  const row = await database.syncState.get(id)
  return row ? { row, value: await openAccountJson(database, token, row.ref, schema) } : undefined
}
export async function writeSyncState(database: AccountDatabase, token: ProfileToken, id: string, value: unknown, expected?: EncryptedSyncState, dependencies: readonly CipherRef[] = []): Promise<EncryptedSyncState> {
  const record = await stageAccountJson(database, token, value, dependencies)
  const row = { id, ref: cipherRef(record) }
  const signal = profileSignal(token)
  let pending: import('dexie').Transaction | undefined
  const abort = () => pending?.abort()
  signal.addEventListener('abort', abort, { once: true })
  try {
    // Crypto and network have settled before this compare-and-swap publishes an encrypted journal pointer
    await database.transaction('rw', [database.syncState, database.encryptedRevisions], async transaction => {
      pending = transaction
      assertActiveProfile(token)
      if (JSON.stringify(await database.syncState.get(id)) !== JSON.stringify(expected)) throw new SyncError('LOCAL_REVISION_CONFLICT')
      await database.encryptedRevisions.add(record)
      await database.syncState.put(row)
      assertActiveProfile(token)
    })
  } finally { signal.removeEventListener('abort', abort) }
  return row
}

export class EncryptedOutbox {
  constructor(private readonly database: AccountDatabase, private readonly token: ProfileToken) {}
  async assertMapped(): Promise<void> {
    assertActiveProfile(this.token)
    if ((await this.database.outbox.toArray()).some(row => row.status !== 'mapped-local')) throw new SyncError('UNMAPPED_LOCAL_INTENT')
  }
  async read(mutationId: string): Promise<TransportCommand | undefined> { return (await readSyncState(this.database, this.token, idFor(mutationId), TransportCommandSchema))?.value }
  async prepare(input: CommitRequest): Promise<void> {
    CommitRequestSchema.parse(input)
    const request = JSON.stringify(input)
    if (new TextEncoder().encode(request).length > maxCommitJsonBytes) throw new SyncError('PAYLOAD_TOO_LARGE')
    const prior = await this.read(input.mutationId)
    if (prior) { if (prior.request !== request) throw new SyncError('IDEMPOTENCY_MISMATCH'); return }
    const uploads: TransportCommand['uploads'] = []
    for (const descriptor of input.revisions) {
      const record = await this.database.encryptedRevisions.get(descriptor.revisionId)
      if (!record || record.descriptor.accountId !== this.token.accountId || JSON.stringify(record.descriptor) !== JSON.stringify(descriptor)) throw new SyncError('LOCAL_INTEGRITY_FAILED')
      // Save the declaration once: metadata reservation and retry bytes are part of immutable upload identity
      const start = { version: 1 as const, uploadId: descriptor.uploadId, documentId: descriptor.documentId, revisionId: descriptor.revisionId, metadataBytes: new TextEncoder().encode(JSON.stringify(descriptor)).length, chunks: descriptor.chunks }
      UploadStartSchema.parse(start)
      uploads.push({ start: JSON.stringify(start), payloadId: record.payloadId, nextChunk: 0, ready: false })
    }
    await writeSyncState(this.database, this.token, idFor(input.mutationId), { version: 1, kind: 'transport-command', request, uploads }, undefined, input.revisions.map(({ documentId, revisionId }) => ({ documentId, revisionId })))
  }
  async verifyReadiness(mutationId: string, client: SyncClient): Promise<boolean> {
    const state = await this.read(mutationId)
    if (!state) throw new SyncError('LOCAL_INTEGRITY_FAILED')
    // Receipts prove historical acceptance; finishing checks readiness of the actual current generation
    let offset = 0, ready = true, failed = false
    // Upload identities are independent; reuse the transfer concurrency bound without skipping any probe
    // Drain active requests before returning failure so no check outlives its captured publication turn
    const worker = async () => {
      while (ready && !failed) {
        const upload = state.uploads[offset++]
        if (!upload) return
        try {
          const start = UploadStartSchema.parse(JSON.parse(upload.start))
          await client.finishUpload(start.uploadId)
        } catch (error) {
          if (error instanceof SyncError && ['NOT_FOUND', 'INTEGRITY_FAILED'].includes(error.code)) { ready = false; return }
          failed = true; throw error
        }
      }
    }
    const results = await Promise.allSettled(Array.from({ length: MAX_CONCURRENT_UPLOADS }, worker))
    for (const result of results) if (result.status === 'rejected') throw result.reason
    return ready
  }
  async prepareRevival(mutationId: string): Promise<string> {
    const state = await this.read(mutationId)
    if (!state) throw new SyncError('LOCAL_INTEGRITY_FAILED')
    const original = JSON.parse(state.request) as CommitRequest
    if (original.heads.length) throw new SyncError('LOCAL_INTEGRITY_FAILED')
    const fresh = (await import('../../workspace/account-cache')).accountLocalId()
    // Only registration receives a fresh identity; original declarations and ciphertext stay byte-exact
    await writeSyncState(this.database, this.token, idFor(fresh), { version: 1, kind: 'transport-command', request: JSON.stringify({ ...original, mutationId: fresh }), uploads: state.uploads.map(upload => ({ ...upload, nextChunk: 0, ready: false })) }, undefined, original.revisions.map(({ documentId, revisionId }) => ({ documentId, revisionId })))
    return fresh
  }
  async advance(mutationId: string, client: SyncClient, budget: TransferBudget): Promise<CommitReceipt | null> {
    const stored = await readSyncState(this.database, this.token, idFor(mutationId), TransportCommandSchema)
    if (!stored) throw new SyncError('LOCAL_INTEGRITY_FAILED')
    let row = stored.row
    const state = stored.value, input = CommitRequestSchema.parse(JSON.parse(state.request))
    if (input.mutationId !== mutationId) throw new SyncError('LOCAL_INTEGRITY_FAILED')
    if (state.receipt) return state.receipt
    const save = async () => { row = await writeSyncState(this.database, this.token, row.id, state, row, input.revisions.map(({ documentId, revisionId }) => ({ documentId, revisionId }))) }
    const accept = async (receipt: CommitReceipt) => {
      if (receipt.mutationId !== mutationId || JSON.stringify(receipt.heads) !== JSON.stringify(input.heads)) throw new SyncError('INTEGRITY_FAILED')
      state.receipt = receipt; await save(); return receipt
    }
    // Receipt lookup precedes retry even when the previous process died before recording a successful response
    const receipt = await client.receipt(mutationId)
    if (receipt) return accept(receipt)
    const pending = state.uploads.filter(upload => !upload.ready)
    const transfer = async (upload: TransportCommand['uploads'][number]) => {
      if (budget.remaining === 0) return
      const start = UploadStartSchema.parse(JSON.parse(upload.start))
      const ready = await client.startUpload(start)
      if (ready.uploadId !== start.uploadId) throw new SyncError('INTEGRITY_FAILED')
      while (upload.nextChunk < start.chunks.length && budget.remaining > 0) {
        // Reserve before awaiting storage/network so concurrent uploads cannot exceed the shared iteration budget
        budget.remaining--
        const chunk = start.chunks[upload.nextChunk]
        const stored = await this.database.stagedCipherChunks.get([upload.payloadId, chunk.index])
        assertActiveProfile(this.token)
        if (!stored || stored.bytes.length !== chunk.cipherBytes) throw new SyncError('LOCAL_INTEGRITY_FAILED')
        await client.putChunk(start.uploadId, chunk.index, stored.bytes)
        assertActiveProfile(this.token)
        upload.nextChunk++
      }
      if (upload.nextChunk === start.chunks.length) {
        try {
          const finished = await client.finishUpload(start.uploadId)
          if (finished.uploadId !== start.uploadId) throw new SyncError('INTEGRITY_FAILED')
          upload.ready = true
        } catch (error) {
          // Only actual missing/incomplete payload evidence authorizes exact-ciphertext revival
          if (error instanceof SyncError && ['NOT_FOUND', 'INTEGRITY_FAILED'].includes(error.code)) upload.nextChunk = 0
          throw error
        }
      }
    }
    // Two workers fill the bounded chunk budget without reopening the whole workspace per upload
    const worker = async () => { while (budget.remaining > 0) { const upload = pending.shift(); if (!upload) return; await transfer(upload) } }
    const results = await Promise.allSettled(Array.from({ length: MAX_CONCURRENT_UPLOADS }, worker))
    await save()
    for (const result of results) if (result.status === 'rejected') throw result.reason
    if (state.uploads.some(upload => !upload.ready)) return null
    // Reconstruct the stored JSON object without regenerating IDs, encryption or command bytes
    try { return accept(await client.commit(JSON.parse(state.request) as CommitRequest)) }
    catch (error) {
      if (error instanceof SyncError && error.remoteResponse && ['NOT_FOUND', 'INTEGRITY_FAILED'].includes(error.code)) {
        const missing: TransportCommand['uploads'] = []
        // A saved ready flag can outlive reclaimed staging; only structured exact-upload evidence
        // permits resetting transfer progress, never uncertain transport or malformed responses
        for (const upload of state.uploads) {
          const start = UploadStartSchema.parse(JSON.parse(upload.start))
          try {
            const ready = await client.finishUpload(start.uploadId)
            if (ready.uploadId !== start.uploadId) throw new SyncError('INTEGRITY_FAILED')
          } catch (reason) {
            if (!(reason instanceof SyncError && reason.remoteResponse && ['NOT_FOUND', 'INTEGRITY_FAILED'].includes(reason.code))) throw reason
            missing.push(upload)
          }
        }
        if (missing.length) {
          for (const upload of missing) { upload.ready = false; upload.nextChunk = 0 }
          // Keep the exact original command and continuation allowance across generation revival
          await save()
          return null
        }
      }
      if (error instanceof SyncError && error.continuation) {
        if (error.code !== 'SERVICE_UNAVAILABLE') throw new SyncError('INTEGRITY_FAILED')
        const advancing = await checkCommitProgress(state.request, state.continuation, error.continuation, Date.now())
        if (advancing || !state.continuation) {
          state.continuation = error.continuation
          // Even expired first evidence fixes the incarnation; a replacement cannot reset progress after restart
          await save()
        }
        if (advancing) throw new CommitProgress(error.retryAfterMs)
      }
      throw error
    }
  }
}

const OperationSchema = z.strictObject({ version: z.literal(1), kind: z.literal('publication-operation'), intentId: z.string().optional(), intentRef: z.strictObject({ documentId: z.string(), revisionId: z.string() }).optional(), commands: z.strictObject({ documentId: z.string(), revisionId: z.string() }), bindings: z.strictObject({ documentId: z.string(), revisionId: z.string() }), offset: z.number().int().nonnegative(), finalMutationId: z.string(), accepted: z.boolean(), bulk: z.boolean(), lineageId: z.string().optional(), newLineageId: z.string(), target: z.strictObject({ documentId: z.string(), revisionId: z.string() }).optional(), conflicted: z.boolean().optional(), readinessOffset: z.number().int().nonnegative().default(0), revivalMutationId: z.string().optional() })
const guards = new Map<string, () => boolean>()
export function registerSyncProjectionGuard(token: ProfileToken, mayReplace: () => boolean): () => void {
  const id = `${token.accountId}:${token.generation}`
  guards.set(id, mayReplace)
  return () => { if (guards.get(id) === mayReplace) guards.delete(id) }
}
export async function runSyncIteration(token: ProfileToken, signal: AbortSignal): Promise<import('./scheduler').SyncOutcome> {
  const { AccountDatabase } = await import('../../persistence/account-database')
  const { stagePull, activatePulledState, readRemoteState, readRemoteHeads, RemoteStateSchema } = await import('./pull')
  const { openRemoteProjection, readPublicationPages, assertProjectionAdvance, assertProjectionSuccessor } = await import('./projection')
  const { preparePublicationAttempt, stagePublicationPages, publicationPageSchema } = await import('./publication')
  const client = new SyncClient(token, signal), database = new AccountDatabase(token.accountId), budget = transferBudget()
  let localRead: ReturnType<typeof captureAccountSyncWorkspace> | undefined
  let managedProjection: Awaited<ReturnType<typeof prepareManagedAccountProjection>> | undefined
  let evidenceUnion: Awaited<ReturnType<typeof import('../../workspace/account-evidence-union').prepareAccountEvidenceUnion>> | undefined
  const commandEntry = z.strictObject({ mutationId: z.string(), ref: z.strictObject({ documentId: z.string(), revisionId: z.string() }) })
  const commandPages = publicationPageSchema(commandEntry, 'local-command-index')
  try {
    signal.throwIfAborted(); assertActiveProfile(token)
    const fence = await database.profileMeta.get('active')
    if (!fence) throw new SyncError('LOCAL_INTEGRITY_FAILED')
    const captureLocal = () => localRead ??= captureAccountSyncWorkspace(database, token, fence, signal)
    const outbox = new EncryptedOutbox(database, token)
    if ((await database.outbox.toArray()).some(row => row.status === 'unmapped-local')) await captureLocal()
    await outbox.assertMapped()
    let operation = await readSyncState(database, token, 'publication', OperationSchema)
    if (operation && !operation.value.accepted && !operation.value.conflicted) {
      const commands = await readPublicationPages(database, token, operation.value.commands, commandPages, entry => [entry.ref])
      const selected = commands[operation.value.offset]
      if (!selected) throw new SyncError('LOCAL_INTEGRITY_FAILED')
      if (selected.mutationId === operation.value.finalMutationId && operation.value.readinessOffset < operation.value.offset) {
        const previous = commands[operation.value.readinessOffset]
        if (operation.value.revivalMutationId) {
          if (!await outbox.advance(operation.value.revivalMutationId, client, budget)) return { state: 'syncing', moreWork: true }
          delete operation.value.revivalMutationId
          operation.value.readinessOffset++
        } else if (await outbox.verifyReadiness(previous.mutationId, client)) operation.value.readinessOffset++
        else operation.value.revivalMutationId = await outbox.prepareRevival(previous.mutationId)
        operation.row = await writeSyncState(database, token, 'publication', operation.value, operation.row, [operation.value.commands, operation.value.bindings, ...(operation.value.target ? [operation.value.target] : []), ...(operation.value.intentRef ? [operation.value.intentRef] : [])])
        return { state: 'syncing', moreWork: true }
      }
      let receipt: CommitReceipt | null
      try { receipt = await outbox.advance(selected.mutationId, client, budget) }
      catch (error) {
        if (!(error instanceof SyncError && error.code === 'HEAD_CONFLICT')) throw error
        // Only a definitive rejection releases an attempt; uncertain results retry their exact receipt identity
        operation.value.conflicted = true
        operation.row = await writeSyncState(database, token, 'publication', operation.value, operation.row, [operation.value.commands, operation.value.bindings, ...(operation.value.target ? [operation.value.target] : []), ...(operation.value.intentRef ? [operation.value.intentRef] : [])])
        const retry = claimBulkRebase(token)
        return { state: retry ? 'syncing' : 'paused', moreWork: retry }
      }
      if (!receipt) return { state: 'syncing', moreWork: true }
      operation.value.offset++
      if (selected.mutationId === operation.value.finalMutationId) operation.value.accepted = true
      operation.row = await writeSyncState(database, token, 'publication', operation.value, operation.row, [operation.value.commands, operation.value.bindings, ...(operation.value.target ? [operation.value.target] : []), ...(operation.value.intentRef ? [operation.value.intentRef] : [])])
      if (!operation.value.accepted) return { state: 'syncing', moreWork: true }
    }
    const previousRemote = await readRemoteState(database, token)
    let remote: Awaited<ReturnType<typeof openRemoteProjection>> = null
    const candidate = await stagePull(database, token, client, async heads => {
      const local = await captureLocal(), next = await openRemoteProjection(database, token, heads, local.workspace.head, local.operativePlanner.localData.revision, local.validatedEvidence)
      // Establish the persisted floor once per call, including the reconstructed predecessor on resume
      // Every subsequent group advances that validated predecessor transitively; downloads alone never establish authority
      if (!remote) await assertProjectionAdvance(database, token, next, previousRemote?.value.effective)
      // Every indivisible group must advance the preceding validated group, including within one downloaded page
      await assertProjectionSuccessor(database, token, next, remote)
      remote = next
    }, budget)
    if (!candidate) return { state: 'syncing', moreWork: true }
    const local = await captureLocal()
    // The validator callback has completed before the candidate can be returned
    const projection = remote as Awaited<ReturnType<typeof openRemoteProjection>>
    const localEvidence = local.inheritedEvidence, remoteEvidence = projection?.inheritedEvidence
    let chosenEvidence: import('../../persistence/account-database').CipherRef | undefined
    const chooseEvidence = async () => {
      if (chosenEvidence) return chosenEvidence
      if (!localEvidence || !remoteEvidence || JSON.stringify(localEvidence) === JSON.stringify(remoteEvidence)) return chosenEvidence = localEvidence ?? remoteEvidence
      const { accountEvidenceContains, prepareAccountEvidenceUnion } = await import('../../workspace/account-evidence-union')
      if (await accountEvidenceContains(database, token, localEvidence, remoteEvidence)) return chosenEvidence = localEvidence
      if (await accountEvidenceContains(database, token, remoteEvidence, localEvidence)) return chosenEvidence = remoteEvidence
      evidenceUnion = await prepareAccountEvidenceUnion(database, token, localEvidence, remoteEvidence)
      return chosenEvidence = evidenceUnion.prepared.root
    }
    const rows = await database.outbox.toArray()
    const completedRow = operation?.value.accepted && operation.value.intentId ? rows.find(row => row.id === operation!.value.intentId) : undefined
    if (operation?.value.accepted && operation.value.intentId && (!completedRow || JSON.stringify(completedRow.ref) !== JSON.stringify(operation.value.intentRef))) throw new SyncError('LOCAL_INTEGRITY_FAILED')
    const remaining = rows.filter(row => row.id !== completedRow?.id)
    const mayReplaceNow = () => guards.get(`${token.accountId}:${token.generation}`)?.() ?? false
    const mayReplace = mayReplaceNow()
    const previousHeads = previousRemote ? await readRemoteHeads(database, token, previousRemote.value.heads) : new Map<string, string>()
    const changed = JSON.stringify([...previousHeads].sort()) !== JSON.stringify([...candidate.heads].sort()) || previousRemote?.value.projectionPending === true
    let keepLocalInitialPublication = false
    if (local.managed && projection && completedRow && operation && operation.value.lineageId === undefined && !remaining.length && !previousHeads.size
      && JSON.stringify(operation.value.target) === JSON.stringify(local.workspace.head)
      && JSON.stringify(localEvidence) === JSON.stringify(remoteEvidence)
      && JSON.stringify(local.workspace.inheritedEvidence) === JSON.stringify(remoteEvidence)) {
      const command = await outbox.read(operation.value.finalMutationId)
      if (!command?.receipt) throw new SyncError('LOCAL_INTEGRITY_FAILED')
      const request = CommitRequestSchema.parse(JSON.parse(command.request))
      if (request.mutationId !== operation.value.finalMutationId || command.receipt.mutationId !== request.mutationId
        || JSON.stringify(command.receipt.heads) !== JSON.stringify(request.heads)) throw new SyncError('LOCAL_INTEGRITY_FAILED')
      const ownHeads = new Map(command.receipt.heads.map(head => [head.documentId, head.revisionId]))
      keepLocalInitialPublication = command.receipt.sequence === candidate.state.watermark && command.receipt.publicationEpoch === candidate.state.publicationEpoch
        && JSON.stringify([...ownHeads].sort()) === JSON.stringify([...candidate.heads].sort())
    }
    // Full remote validation and the exact receipt, heads, target and archive prove this initial publication is already local
    // Complete only its remote bookkeeping; reimporting it would replace the foreground root and interrupt draft owners
    let state = local.workspace.state
    let projectionBase = local.workspace
    if (projection && changed && mayReplace && remaining.length === 0 && !keepLocalInitialPublication) {
      const pendingContent = state.retainedContent.filter(entry => entry.kind === 'pending-content')
      state = { ...projection.workspace.state, retainedContent: [...projection.workspace.state.retainedContent, ...pendingContent], ...(pendingContent.length ? { blobs: [...new Map([...state.blobs, ...projection.workspace.state.blobs].map(blob => [JSON.stringify(blob.ref), blob])).values()] } : {}), planner: projectPlanner(local.operativePlanner, { ...projection.workspace.state.planner, localData: preserveLocalSelections(projection.workspace.state.planner.localData, local.operativePlanner.localData) }, !previousRemote?.value.effective && local.operativePlanner.localData.changes.length === 0) }
      projectionBase = projection.workspace
    }
    if (completedRow && !keepLocalInitialPublication) {
      const intent = await openAccountJson(database, token, completedRow.ref, MappedWorkspaceIntentSchema)
      state = await retirePendingContent(state, intent.portableGroupId)
    }
    const selectedEvidence = projection ? await chooseEvidence() : localEvidence
    const needsEvidencePublication = !!projection && !!selectedEvidence && JSON.stringify(selectedEvidence) !== JSON.stringify(remoteEvidence) && remaining.length === 0
    // Pending intents keep their selected local C until their publication is accepted
    // The publication target carries the union; accepted pull selects it once
    const needsEvidenceSelection = remaining.length === 0 && JSON.stringify(selectedEvidence) !== JSON.stringify(projectionBase.inheritedEvidence)
    const prepared = state !== local.workspace.state || needsEvidenceSelection || needsEvidencePublication
      ? evidenceUnion ? await (await import('../../workspace/account-graph')).prepareAccountWorkspaceWithEvidence(database, token, state, evidenceUnion.prepared, projectionBase)
        : selectedEvidence && (needsEvidenceSelection || needsEvidencePublication) ? await (await import('../../workspace/account-graph')).prepareAccountWorkspaceWithExistingEvidence(database, token, state, selectedEvidence, projectionBase)
          : await prepareAccountWorkspace(database, token, state, projectionBase)
      : undefined
    let newEvidenceIntent: { readonly id: string; readonly ref: CipherRef; readonly records: readonly CipherRecord[] } | undefined
    // Finish an accepted publication under its existing CAS before authoring another command
    // Its exact receipt and outbox row cannot also authorize a new evidence intent
    // Remote adoption also changes physical unit identities; author evidence only from the selected predecessor
    if (needsEvidencePublication && prepared && !operation?.value.accepted && projectionBase === local.workspace) {
      const { stageMappedWorkspaceIntent, mappedChanges } = await import('../../workspace/account-intents')
      const id = accountLocalId(), portableGroupId = accountLocalId()
      const staged = await stageMappedWorkspaceIntent(database, token, { version: 1, kind: 'mapped-workspace-intent', operationId: id, portableGroupId, operation: 'workspace-command', mode: 'replace', original: { base: local.workspace.head, target: prepared.head }, base: local.workspace.head, target: prepared.head, localRevision: local.fence.headRevision + 1, changes: mappedChanges(local.workspace, prepared.opened) })
      newEvidenceIntent = { id, ref: cipherRef(staged.record), records: staged.records }
    }
    const deferred = !!projection && changed && !keepLocalInitialPublication && (!mayReplace || remaining.length > 0)
    const effective = projection ? { lineageId: projection.lineageId, control: projection.control, units: await stagePublicationPages(database, token, 'local-effective-units', [...projection.units.values()].map(unit => ({ key: unit.key, body: unit.body.ref, publication: unit.ref })).concat([...projection.lineages].map(([key, anchor]) => ({ key, body: anchor.value.selected, publication: anchor.ref }))), entry => [entry.body, entry.publication]) } : undefined
    const committedCandidate = { ...candidate, state: { ...candidate.state, projectionPending: deferred, ...(effective ? { effective } : {}) } }
    signal.throwIfAborted(); assertActiveProfile(token)
    // A draft opened during preparation must also prevent the final pointer transaction
    const assertMayActivate = () => { if (projectionBase !== local.workspace && !mayReplaceNow()) throw new SyncError('LOCAL_REVISION_CONFLICT') }
    assertMayActivate()
    const bindingPages = publicationPageSchema(z.strictObject({ body: z.strictObject({ documentId: z.string(), revisionId: z.string() }), publication: z.strictObject({ documentId: z.string(), revisionId: z.string() }) }), 'local-publication-bindings')
    const acceptedBindings = operation?.value.accepted ? await readPublicationPages(database, token, operation.value.bindings, bindingPages, entry => [entry.body, entry.publication]) : []
    if (prepared && local.managed) managedProjection = await prepareManagedAccountProjection(database, token, local.fence, prepared, newEvidenceIntent)
    await activatePulledState(database, token, committedCandidate, local.fence, prepared, completedRow && operation ? { intent: completedRow, publication: operation.row } : undefined, operation?.value.accepted && !completedRow ? operation.row : undefined, assertMayActivate, acceptedBindings.map(entry => entry.body.revisionId), newEvidenceIntent, managedProjection?.prepared)
    if (prepared && typeof window !== 'undefined') window.dispatchEvent(new Event('crykit-account-sync-applied'))
    if (needsEvidencePublication) return { state: 'syncing', moreWork: true }
    const settledState = state.conflicts.some(conflict => conflict.disposition.kind === 'unresolved' && !projection?.supersededConflictIds.has(conflict.id)) ? 'conflict' as const : 'synced' as const
    if (operation?.value.accepted) return { state: !remaining.length && projection && !deferred ? settledState : deferred && !remaining.length ? 'paused' : 'syncing', moreWork: remaining.length > 0 || !projection }
    const installingLineages = projection && [...(await import('./lineage')).personalLineageChains(projection.workspace.state.planner.localData).keys()].some(key => !projection.lineages.has(key))
    if (!remaining.length && projection && !installingLineages) return { state: deferred ? 'paused' : settledState, moreWork: false }
    const intents = await Promise.all(remaining.map(async row => ({ row, value: await openAccountJson(database, token, row.ref, MappedWorkspaceIntentSchema) })))
    intents.sort((a, b) => a.value.localRevision - b.value.localRevision)
    const first = installingLineages ? undefined : intents[0]
    // One pending change can establish the initial publication and be acknowledged by that exact receipt
    // Multiple changes queued before initial acceptance retain the existing baseline and full reference checks
    // Existing uncertain journals keep their saved requests and receipt identities in the earlier reconciliation path
    const publishFirst = !!first && (!!projection || intents.length === 1)
    const pendingHead = first && (publishFirst ? first.value.target : first.value.base)
    const pendingTarget = pendingHead && JSON.stringify(pendingHead) !== JSON.stringify(local.workspace.head)
      ? await openAccountWorkspace(database, token, pendingHead) : local.workspace
    let target = installingLineages ? projection!.workspace : pendingTarget
    const changes = projection && first ? await readMappedWorkspaceChanges(database, token, first.value) : undefined
    const parents = new Map<string, CipherRef>(), anchorParents = new Map<string, CipherRef>()
    let capturedLineage: string | undefined
    let mappingBase: import('./projection').RemoteProjection | undefined
    if (first?.row.publicationBase) {
      const snapshot = await openAccountJson(database, token, first.row.publicationBase, RemoteStateSchema)
      if (snapshot.effective) {
        if (snapshot.effective.lineageId !== projection?.lineageId || changes?.some(change => projection?.units.has(change.key) && change.after?.documentId !== projection.units.get(change.key)!.body.ref.documentId)) mappingBase = await openRemoteProjection(database, token, await readRemoteHeads(database, token, snapshot.heads), first.value.base, first.value.localRevision) ?? undefined
        capturedLineage = snapshot.effective.lineageId
        const pages = publicationPageSchema(z.strictObject({ key: z.string(), body: z.strictObject({ documentId: z.string(), revisionId: z.string() }), publication: z.strictObject({ documentId: z.string(), revisionId: z.string() }) }), 'local-effective-units')
        for (const entry of await readPublicationPages(database, token, snapshot.effective.units, pages, entry => [entry.body, entry.publication])) { if ((await import('./lineage-publication')).isPersonalLineageKey(entry.key)) anchorParents.set(entry.key, entry.publication); else parents.set(entry.body.revisionId, entry.publication) }
      }
    }
    // Prepared/uncertain commands reconcile above; only an unaccepted or definitively rejected intent reaches this admission
    const firstAllocationCapture = !!(first && projection && capturedLineage !== projection.lineageId && !first.value.conflictResolution && await (await import('./mapping-admission')).admitFirstAllocationComparison(database, token, mappingBase, projection, target, changes!, first.value.mode))
    if (operation?.value.conflicted && operation.value.lineageId && operation.value.lineageId !== projection?.lineageId && !firstAllocationCapture) throw new SyncError('HEAD_CONFLICT')
    // A history-only replacement can cross a remote bulk lineage when both published body sets
    // are identical; the authenticated C union supplies the only new authority
    const evidenceOnly = !!(first && projection && selectedEvidence && localEvidence && remoteEvidence && first.value.mode === 'replace' && changes?.length === 0 && JSON.stringify(localEvidence) !== JSON.stringify(remoteEvidence) && await (async () => {
      const { publicationDocuments } = await import('../../workspace/closure')
      const identity = async (workspace: typeof target) => {
        const eligible = new Set((await publicationDocuments(workspace.state)).map(document => document.key))
        return JSON.stringify(workspace.entries.filter(entry => eligible.has(entry.key) || entry.kind === 'tombstone' && projection.units.has(entry.key)).map(entry => [entry.key, entry.kind, entry.ref, entry.digest]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
      }
      return await identity(target) === await identity(projection.workspace)
    })())
    if (evidenceOnly) capturedLineage = projection!.lineageId
    if (first && projection && !first.value.conflictResolution && capturedLineage !== projection.lineageId && !firstAllocationCapture) {
      const { publicationDocuments } = await import('../../workspace/closure')
      const semanticRoots = new Map<string, Promise<string>>()
      const rootIdentity = (ref: CipherRef) => {
        let saved = semanticRoots.get(ref.revisionId)
        if (!saved) {
          saved = (async () => {
            const workspace = await openAccountWorkspace(database, token, ref)
            const eligible = new Set((await publicationDocuments(workspace.state)).map(document => document.key))
            return JSON.stringify(workspace.entries.filter(entry => eligible.has(entry.key) || entry.kind === 'tombstone' && projection.units.has(entry.key)).map(entry => [entry.key, entry.ref.documentId, entry.ref.revisionId]).sort((a, b) => a[0].localeCompare(b[0])))
          })()
          semanticRoots.set(ref.revisionId, saved)
        }
        return saved
      }
      const accepted: { value: z.infer<typeof OperationSchema>; intent: z.infer<typeof MappedWorkspaceIntentSchema> | undefined }[] = []
      for (const row of await database.syncState.toArray()) if (row.id.startsWith('accepted:')) {
        const value = await openAccountJson(database, token, row.ref, OperationSchema)
        if (!value.accepted || !value.target) continue
        const command = await outbox.read(value.finalMutationId)
        if (!command?.receipt || command.receipt.mutationId !== value.finalMutationId) continue
        const request = CommitRequestSchema.parse(JSON.parse(command.request))
        if (request.mutationId !== value.finalMutationId || command.receipt.mutationId !== value.finalMutationId || JSON.stringify(request.heads) !== JSON.stringify(command.receipt.heads)) throw new SyncError('LOCAL_INTEGRITY_FAILED')
        const intent = value.intentRef ? await openAccountJson(database, token, value.intentRef, MappedWorkspaceIntentSchema) : undefined
        if (intent && (intent.operationId !== value.intentId || JSON.stringify(intent.target) !== JSON.stringify(value.target) || intent.localRevision >= first.value.localRevision)) continue
        accepted.push({ value, intent })
      }
      const wanted = await rootIdentity(first.value.base)
      const walk = async (lineage: string | undefined, afterRevision: number, previousTarget?: string, initialTarget?: CipherRef): Promise<typeof accepted | undefined> => {
        for (const candidate of accepted) {
          const revision = candidate.intent?.localRevision ?? -1
          if (candidate.value.lineageId !== lineage || revision <= afterRevision) continue
          if (previousTarget !== undefined && (!candidate.intent || await rootIdentity(candidate.intent.base) !== previousTarget)) continue
          // The initial anchor requires the next full base ref; later local links can compare eligible semantic roots
          if (initialTarget && (!candidate.intent || JSON.stringify(candidate.intent.base) !== JSON.stringify(initialTarget))) continue
          if (!candidate.intent && lineage !== undefined) continue
          const targetIdentity = await rootIdentity(candidate.value.target!)
          if (candidate.value.newLineageId === projection.lineageId && targetIdentity === wanted && (candidate.intent || JSON.stringify(candidate.value.target) === JSON.stringify(first.value.base))) return [candidate]
          const rest = await walk(candidate.value.newLineageId, revision, targetIdentity, candidate.intent ? undefined : candidate.value.target)
          if (rest) return [candidate, ...rest]
        }
        return undefined
      }
      const bridge = await walk(capturedLineage, -2)
      if (!bridge) throw new SyncError('HEAD_CONFLICT')
      // An unchanged body can receive a new seed envelope; replace bindings through the proven local journal chain
      for (const step of bridge) for (const entry of await readPublicationPages(database, token, step.value.bindings, bindingPages, entry => [entry.body, entry.publication])) parents.set(entry.body.revisionId, entry.publication)
      capturedLineage = projection.lineageId
    }
    for (const change of changes ?? []) if (change.kind !== 'workspace-identity' && change.before && projection?.units.has(change.key) && !parents.has(change.before.revisionId)) {
      const binding = await readSyncState(database, token, `binding:${change.before.revisionId}`, OperationSchema)
      if (!binding?.value.accepted || capturedLineage && capturedLineage !== binding.value.newLineageId) throw new SyncError('HEAD_CONFLICT')
      capturedLineage ??= binding.value.newLineageId
      const entries = await readPublicationPages(database, token, binding.value.bindings, bindingPages, entry => [entry.body, entry.publication])
      const exact = entries.find(entry => JSON.stringify(entry.body) === JSON.stringify(change.before))
      if (!exact) throw new SyncError('HEAD_CONFLICT')
      parents.set(change.before.revisionId, exact.publication)
    }
    let refreshedConflict: import('./convergence').ConvergenceResult | undefined
    const resolutionParents = new Map<string, readonly CipherRef[]>()
    const mappingResolutions = new Map<string, { parents: readonly CipherRef[]; record: import('../../workspace/conflict-authority').OriginalPublication }>()
    if (first?.value.conflictResolution && projection) {
      const choice = first.value.conflictResolution
      const conflictUnit = projection.units.get(JSON.stringify(['conflict', choice.conflictId]))
      const anchor = projection.lineages.get(choice.privateKey)
      const mapping = conflictUnit?.conflictAuthority?.unit.kind === 'directory-mapping' ? conflictUnit.conflictAuthority : undefined
      const directory = mapping?.unit.kind === 'directory-mapping' ? projection.directories.get(mapping.unit.shard) : undefined
      const selected = directory ? { ref: directory.ref } : anchor ? { ref: anchor.ref } : projection.units.get(choice.privateKey)
      if (!selected || !conflictUnit || JSON.stringify(conflictUnit.conflictAuthority?.branches[0].publication.ref) !== JSON.stringify(choice.local)) throw new SyncError('INTEGRITY_FAILED')
      const { assertUnchangedPublicationContinuation } = await import('./conflict-authority')
      try {
        await assertUnchangedPublicationContinuation(database, token, conflictUnit.ref, choice.conflict)
        if (mapping) {
          await (await import('./mapping-continuation')).assertUnchangedMappingContinuation(database, token, projection, mapping.branches[1].publication)
          if (choice.choice === 'both') throw new SyncError('CONFLICT_COPY_UNAVAILABLE')
          const record = mapping.branches[choice.choice === 'this' ? 0 : 1].publication.mapping?.record
          if (!record) throw new SyncError('INTEGRITY_FAILED')
          mappingResolutions.set(choice.privateKey, { parents: [choice.local, selected.ref], record })
          target = await (await import('./mapping-selection')).selectMappingBranch(database, token, target, projection.workspace, record)
        } else {
          await assertUnchangedPublicationContinuation(database, token, selected.ref, choice.remote)
          resolutionParents.set(choice.privateKey, [choice.local, selected.ref])
        }
      } catch (error) {
        if (!(error instanceof SyncError && error.code === 'STALE_CONFLICT_CHOICE')) throw error
        if (mapping) throw error
        refreshedConflict = await (await import('./conflict-refresh')).prepareRefreshedConflict(database, token, projection, choice)
      }
      // Only an authenticated explicit choice can follow this proven current branch context
      capturedLineage = projection.lineageId
    }
    const anchorCandidates = new Map<string, CipherRef>(), mappingCandidates = new Map<string, CipherRef>()
    if (operation?.value.conflicted) {
      for (const entry of await readPublicationPages(database, token, operation.value.bindings, bindingPages, entry => [entry.body, entry.publication])) mappingCandidates.set(entry.body.revisionId, entry.publication)
      const { PublicationLineageSchema } = await import('./lineage-publication')
      const commands = await readPublicationPages(database, token, operation.value.commands, commandPages, entry => [entry.ref])
      for (const command of commands) {
        const saved = await outbox.read(command.mutationId)
        if (!saved) throw new SyncError('LOCAL_INTEGRITY_FAILED')
        for (const descriptor of CommitRequestSchema.parse(JSON.parse(saved.request)).revisions) {
          if (descriptor.parents.length) continue
          const ref = { documentId: descriptor.documentId, revisionId: descriptor.revisionId }
          // Only the exact rejected operation may supply a retained first-allocation candidate
          let value: unknown
          try { value = await openAccountJson(database, token, ref, z.unknown()) } catch { continue }
          const anchor = PublicationLineageSchema.safeParse(value)
          if (anchor.success) anchorCandidates.set(anchor.data.privateKey, ref)
        }
      }
    }
    let convergence = refreshedConflict ?? (projection && first && first.value.mode !== 'replace' ? await (await import('./convergence')).prepareConvergence(database, token, JSON.stringify(first.value.base) === JSON.stringify(target.head) ? target : await openAccountWorkspace(database, token, first.value.base), target, projection, changes!, parents, anchorParents, anchorCandidates, mappingBase, new Set(mappingResolutions.keys()), mappingCandidates) : undefined)
    if (first?.value.copiedConflicts && projection) convergence = await (await import('../../workspace/copied-conflicts')).prepareCopiedConflictPublication(database, token, first.value, convergence?.target ?? target, projection, convergence)
    // The original intent/target remains immutable; only the prepared publication uses the coherent converged projection
    let publicationChanges = convergence?.changes ?? changes
    if (convergence && !refreshedConflict && first?.value.conflictResolution && !projection!.lineages.has(first.value.conflictResolution.privateKey) && !convergence.changes.some(change => change.key === first.value.conflictResolution!.privateKey)) {
      const key = first.value.conflictResolution.privateKey, entry = convergence.target.entries.find(entry => entry.key === key)!
      publicationChanges = [...convergence.changes, { key, kind: entry.kind, before: projection!.units.get(key)!.body.ref, after: entry.ref }]
    }
    const publicationParents = convergence ? new Map([...projection!.units.values()].map(unit => [unit.body.ref.revisionId, unit.ref])) : parents
    let publicationTarget = convergence?.target ?? target
    if (first && projection && selectedEvidence && JSON.stringify(publicationTarget.inheritedEvidence) !== JSON.stringify(selectedEvidence)) {
      const { openAccountWorkspace, prepareAccountWorkspaceWithEvidence, prepareAccountWorkspaceWithExistingEvidence } = await import('../../workspace/account-graph')
      const merged = evidenceUnion ? await prepareAccountWorkspaceWithEvidence(database, token, publicationTarget.state, evidenceUnion.prepared, publicationTarget) : await prepareAccountWorkspaceWithExistingEvidence(database, token, publicationTarget.state, selectedEvidence, publicationTarget)
      await database.transaction('rw', database.encryptedRevisions, async () => { assertActiveProfile(token); await database.encryptedRevisions.bulkAdd(merged.records); assertActiveProfile(token) })
      publicationTarget = await openAccountWorkspace(database, token, merged.head)
    }
    const attempt = await preparePublicationAttempt(database, token, publicationTarget, projection, candidate.heads, candidate.state.publicationEpoch, installingLineages ? [] : publicationChanges, first?.value.mode, capturedLineage ? { lineageId: convergence ? projection!.lineageId : capturedLineage, parents: publicationParents } : undefined, installingLineages ? { installLineages: true } : convergence ? { authorities: convergence.authorities, resolutionParents, mappingResolutions, initialTombstones: convergence.initialTombstones } : undefined)

    const commands = []
    for (const input of [...attempt.registrations, attempt.final]) {
      await outbox.prepare(input)
      const row = (await database.syncState.get(idFor(input.mutationId)))!
      commands.push({ mutationId: input.mutationId, ref: row.ref })
    }
    const commandIndex = await stagePublicationPages(database, token, 'local-command-index', commands, entry => [entry.ref])
    const bindingIndex = await stagePublicationPages(database, token, 'local-publication-bindings', [...attempt.bindings, ...(convergence?.archivedBindings ?? [])], entry => [entry.body, entry.publication])
    const value = OperationSchema.parse({ version: 1, kind: 'publication-operation', ...(publishFirst ? { intentId: first!.row.id, intentRef: first!.row.ref } : {}), commands: commandIndex, bindings: bindingIndex, offset: 0, finalMutationId: attempt.final.mutationId, accepted: false, bulk: attempt.bulk, newLineageId: attempt.lineageId, target: target.head, ...(projection ? { lineageId: projection.lineageId } : {}) })
    if (operation?.value.conflicted) {
      // Keep losing attempt envelopes and original-base bindings available to conflict inspection
      await database.syncState.put({ id: `attempt:${operation.row.ref.revisionId}`, ref: operation.row.ref })
    }
    await writeSyncState(database, token, 'publication', value, operation?.row, [commandIndex, bindingIndex, target.head, ...(publishFirst ? [first!.row.ref] : [])])
    // A pending journal is durable before the first upload; staging cannot be reported as synchronized
    return { state: 'syncing', moreWork: true }
  } finally {
    try {
      const captured = localRead ? await localRead.catch(() => undefined) : undefined
      const cleanup = await Promise.allSettled([managedProjection?.dispose(), evidenceUnion?.dispose(), captured?.dispose()])
      const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Account sync capture cleanup failed')
    } finally { database.close() }
  }
}
