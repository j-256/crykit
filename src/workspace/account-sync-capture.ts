import { SyncError } from '../account/sync/client'
import { assertActiveProfile, type ProfileToken } from '../account/profile'
import type { AccountDatabase, AccountFence } from '../persistence/account-database'
import { openAccountJson } from './account-cache'
import { z } from 'zod'
import { openOrMapAccountWorkspace } from './account-intents'
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
export async function captureAccountSyncWorkspace(database: AccountDatabase, token: ProfileToken, input: AccountFence, signal?: AbortSignal) {
  const fence = structuredClone(input)
  if (!await isManagedAccountHead(database, token, fence)) {
    const captured = await openOrMapAccountWorkspace(database, token, fence)
    return { ...captured, managed: false as const, inheritedEvidence: captured.workspace.inheritedEvidence, validatedEvidence: undefined, operativePlanner: captured.workspace.state.planner, dispose: async () => {} }
  }
  const store = createAccountLocalStore(database, token)
  let validatedEvidence: AccountInheritedEvidence | undefined
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
    const associated = await readIncrementalAccountEvidence(database, token, selected.root.inheritedEvidence)
    const inheritedEvidence = associated && guestPlannerValuesEqual(associated, workspace.inheritedEvidence)
      ? workspace.inheritedEvidence : await ensureIncrementalAccountEvidence(database, token, store, selected, check)
    await check()
    // Keep this independently opened archive proof only for the enclosing sync operation
    // Exact own-publication readback can reuse it; another archive or later iteration validates afresh
    return { fence, workspace, inheritedEvidence, validatedEvidence, managed: true as const, operativePlanner: selected.state.planner, dispose: async () => { try { await validatedEvidence?.dispose() } finally { await store.dispose() } } }
  } catch (error) { try { await validatedEvidence?.dispose() } finally { await store.dispose() } throw error }
}
