import { assertActiveProfile, profileSignal, type ProfileToken } from '../account/profile'
import type { AccountDatabase, AccountFence, CipherRef, CipherRecord } from '../persistence/account-database'
import { accountLocalId } from './account-cache'
import type { PreparedAccountWorkspace } from './account-graph'
import { createAccountLocalStore } from './account-local-store'
import { admitLocalRoot, prepareLocalWorkspace } from './local-root'
import { checkLocalEvidenceRoot, readLocalEvidence, prepareLocalEvidence } from './local-evidence'
import { accountInheritedSources, openAccountInheritedEvidence } from './account-evidence-snapshots'
import { guestEvidenceFromSnapshot, emptyPlannerEvidence } from './guest-evidence'
import { joinWorkspaceSnapshotEvidence } from '../interchange/workspace-backup-evidence'
import { ownWorkspaceSnapshot, disposeWorkspaceSnapshot, type WorkspaceSnapshot } from './snapshot'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'
import { readIncrementalAccountEvidence } from './account-local-mapping'

// Bulk pull/restore keeps one authoritative local pointer while retaining the exact native mapping target
// This preparation owns no activation authority until the existing transaction rechecks both captured views
export async function prepareManagedAccountProjection(database: AccountDatabase, token: ProfileToken, input: AccountFence, native: PreparedAccountWorkspace, intent?: { readonly id: string; readonly ref: CipherRef; readonly records: readonly CipherRecord[] }, requireSettledSync?: true) {
  const expected = structuredClone(input), store = createAccountLocalStore(database, token), operationId = intent?.id ?? accountLocalId()
  const check = async () => {
    assertActiveProfile(token)
    if (!guestPlannerValuesEqual(await database.profileMeta.get('active'), expected)) throw new Error('The managed projection source changed')
    assertActiveProfile(token)
  }
  let snapshot: WorkspaceSnapshot | undefined
  let inherited: Awaited<ReturnType<typeof openAccountInheritedEvidence>> | undefined
  try {
    await check()
    const previous = await admitLocalRoot(store.adapter, expected.head, store.lifetime)
    let evidenceRef = previous.root.inheritedEvidence
    if (native.opened.inheritedEvidence) {
      inherited = native.validatedEvidence ?? await openAccountInheritedEvidence(database, token, native.opened.inheritedEvidence)
      const mapped = await readIncrementalAccountEvidence(database, token, evidenceRef)
      if (guestPlannerValuesEqual(mapped, native.opened.inheritedEvidence)) {
        // This authenticated association already binds both exact archives; the incoming native graph is validated above
        // Retain the local control and payloads without consuming their history again or granting cleanup authority
        await checkLocalEvidenceRoot(store.adapter, evidenceRef, check)
        await inherited.check()
      } else {
        snapshot = ownWorkspaceSnapshot({ version: 1, snapshotId: accountLocalId(), capturedAt: native.opened.state.planner.localData.updatedAt, revisionVector: { projection: JSON.stringify(native.head) }, state: native.opened.state }, { check, dispose: async () => {} })
        snapshot = await joinWorkspaceSnapshotEvidence(snapshot, await accountInheritedSources(inherited), { signal: profileSignal(token) })
        const evidence = await guestEvidenceFromSnapshot(snapshot, emptyPlannerEvidence())
        evidenceRef = await prepareLocalEvidence(store.adapter, operationId, evidence)
      }
    } else if (await readLocalEvidence(store.adapter, evidenceRef, check)) throw new Error('A native projection cannot discard managed historical originals')
    const result = await prepareLocalWorkspace(store.adapter, operationId, native.opened.state, store.lifetime, undefined, evidenceRef)
    // Native admission already accepts this exact live handle; retain that proof within this preparation
    const admittedNative = inherited ? { ...native, validatedEvidence: inherited } : native
    const prepared = await store.prepareMappedActivation(operationId, result, expected, previous, admittedNative, intent, requireSettledSync)
    await check()
    return { prepared, async dispose() { await store.dispose() } }
  } catch (error) { await store.dispose(); throw error }
  finally {
    if (snapshot) await disposeWorkspaceSnapshot(snapshot)
    // A supplied C handle belongs to its existing bulk preparation and must remain live through activation
    if (inherited && inherited !== native.validatedEvidence) await inherited.dispose()
  }
}
