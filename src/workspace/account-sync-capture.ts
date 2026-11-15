import { SyncError } from '../account/sync/client'
import { assertActiveProfile, type ProfileToken } from '../account/profile'
import type { AccountDatabase, AccountFence, CipherRef } from '../persistence/account-database'
import { openAccountJson } from './account-cache'
import { z } from 'zod'
import { openExactAccountWorkspace } from './account-intents'
import { AccountWorkspaceRootV1Schema, AccountWorkspaceRootV2Schema, openAccountWorkspace } from './account-graph'
import { openAccountInheritedEvidence, type AccountInheritedEvidence } from './account-evidence-snapshots'
import { createAccountLocalStore } from './account-local-store'
import { admitLocalRoot, LocalWorkspaceRootV3Schema } from './local-root'
import { IncrementalWorkspaceIntentSchema } from './account-managed-repository'
import { mapIncrementalAccountIntent, mapIncrementalAccountBaseline } from './account-local-mapping-client'
import { ensureIncrementalAccountEvidence, readIncrementalAccountEvidence, readIncrementalMappedRoot } from './account-local-mapping'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'

export async function isManagedAccountHead(database: AccountDatabase, token: ProfileToken, fence: AccountFence): Promise<boolean> {
  const root = await openAccountJson(database, token, fence.head, z.object({ kind: z.string() }).passthrough())
  if (root.kind !== 'incremental-local-workspace') return false
  LocalWorkspaceRootV3Schema.parse(root)
  return true
}

// Cloud comparison uses the exact native mapping association while local merge/Undo uses the actual managed journal
// Neither a newer selected root nor a later pending row may retarget this captured sync iteration
async function captureAccountWorkspace(database: AccountDatabase, token: ProfileToken, input: AccountFence, signal: AbortSignal | undefined, publication: boolean) {
  const fence = structuredClone(input)
  if (!await isManagedAccountHead(database, token, fence)) {
    const captured = await openExactAccountWorkspace(database, token, fence)
    const result = { ...captured, managed: false as const, validatedEvidence: undefined, publicationValidatedEvidence: undefined, operativePlanner: captured.workspace.state.planner, dispose: async () => {} }
    return publication ? { ...result, inheritedEvidence: captured.workspace.inheritedEvidence } : { ...result, inheritedEvidence: undefined }
  }
  const store = createAccountLocalStore(database, token)
  let validatedEvidence: AccountInheritedEvidence | undefined
  let publicationValidatedEvidence: AccountInheritedEvidence | undefined
  let releasePublication: (() => Promise<void>) | undefined
  // Each retained role has one owner; aliases share the mapped owner and never add another release
  // Keep failed releases retryable and attempt every owner even if another cleanup fails
  const dispose = async () => {
    const failures: unknown[] = []
    // Retire proof readers before closing their enclosing local store
    for (const release of [releasePublication, () => validatedEvidence?.dispose(), () => store.dispose()]) {
      try { await release?.() } catch (error) { failures.push(error) }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Account capture cleanup failed')
  }
  const check = async () => {
    signal?.throwIfAborted(); assertActiveProfile(token)
    if (!guestPlannerValuesEqual(await database.profileMeta.get('active'), fence)) throw new SyncError('LOCAL_REVISION_CONFLICT')
    assertActiveProfile(token)
  }
  try {
    await check()
    const selected = await admitLocalRoot(store.adapter, fence.head, store.lifetime)
    const pending = []
    for (const row of await database.outbox.toArray()) if (row.status === 'unmapped-local') {
      const intent = await openAccountJson(database, token, row.ref, IncrementalWorkspaceIntentSchema)
      if (intent.sequence <= fence.headRevision) pending.push({ row, sequence: intent.sequence })
    }
    pending.sort((left, right) => left.sequence - right.sequence)
    for (const { row } of pending) { await check(); await mapIncrementalAccountIntent(database, token, row, signal) }
    const mapped = await readIncrementalMappedRoot(database, token, fence) ?? await mapIncrementalAccountBaseline(database, token, fence, signal)
    await check()
    const root = await openAccountJson(database, token, mapped, z.union([AccountWorkspaceRootV1Schema, AccountWorkspaceRootV2Schema]))
    if (root.version === 2) validatedEvidence = await openAccountInheritedEvidence(database, token, root.inheritedEvidence)
    const workspace = await openAccountWorkspace(database, token, mapped, validatedEvidence)
    // Exact associated archives can reuse the authenticated mapped view
    // Migration origins can retain additional local originals that still need their own publication archive
    let inheritedEvidence: CipherRef | undefined
    if (publication) {
      const associated = await readIncrementalAccountEvidence(database, token, selected.root.inheritedEvidence)
      if (associated && guestPlannerValuesEqual(associated, workspace.inheritedEvidence)) {
        inheritedEvidence = workspace.inheritedEvidence
        publicationValidatedEvidence = validatedEvidence
      } else inheritedEvidence = await ensureIncrementalAccountEvidence(database, token, store, selected, check, (handle, release) => {
        publicationValidatedEvidence = handle
        releasePublication = release
      })
    }
    await check()
    // Keep mapped and full-publication authority distinct and scoped to this capture
    // Remote readback may borrow either exact root; another archive or later iteration validates afresh
    const result = { fence, workspace, validatedEvidence, publicationValidatedEvidence, managed: true as const, operativePlanner: selected.state.planner, dispose }
    return publication ? { ...result, inheritedEvidence } : { ...result, inheritedEvidence: undefined }
  } catch (error) { await dispose(); throw error }
}

export async function captureAccountSyncWorkspace(database: AccountDatabase, token: ProfileToken, input: AccountFence, signal?: AbortSignal) {
  return captureAccountWorkspace(database, token, input, signal, true)
}

// Review needs the admitted mapped view, not a publication of every local historical original
// Omit that authority entirely; branch actions must recapture the complete archive at their exact review fence
export async function captureAccountReviewWorkspace(database: AccountDatabase, token: ProfileToken, input: AccountFence, signal?: AbortSignal) {
  const { inheritedEvidence: _publication, publicationValidatedEvidence: _publicationProof, ...review } = await captureAccountWorkspace(database, token, input, signal, false)
  return review
}
