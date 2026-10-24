import { assertActiveProfile, type ProfileToken } from '../account/profile'
import type { AccountDatabase, AccountFence } from '../persistence/account-database'
import { accountLocalId } from './account-cache'
import { openOrMapAccountWorkspace } from './account-intents'
import { createAccountLocalStore } from './account-local-store'
import { captureAccountSnapshot } from './account-snapshot'
import { disposeWorkspaceSnapshot } from './snapshot'
import { inheritWorkspaceSnapshot } from '../interchange/workspace-backup-evidence'
import { guestEvidenceFromSnapshot, compareGuestEvidence, validateGuestCurrentBodies, emptyPlannerEvidence } from './guest-evidence'
import { prepareLocalEvidence, readLocalEvidence } from './local-evidence'
import { prepareLocalWorkspace, admitLocalRoot } from './local-root'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'

// One-time native preparation preserves the exact source graph as inherited evidence
// Staging cannot select itself after restart; only the existing encrypted head CAS publishes it
export async function prepareAccountManagedMigration(database: AccountDatabase, token: ProfileToken, input: AccountFence) {
  assertActiveProfile(token)
  const selected = await openOrMapAccountWorkspace(database, token, structuredClone(input))
  const expected = selected.fence, store = createAccountLocalStore(database, token), operationId = accountLocalId()
  const check = async () => {
    assertActiveProfile(token)
    if (!guestPlannerValuesEqual(await database.profileMeta.get('active'), expected)) throw new Error('The account migration source changed')
    assertActiveProfile(token)
  }
  let source: Awaited<ReturnType<typeof captureAccountSnapshot>> | undefined
  let inherited: Awaited<ReturnType<typeof inheritWorkspaceSnapshot>> | undefined
  try {
    await check()
    // Earlier domain migration owns normalization and its mapped intent; do not reinterpret its old endpoints here
    if (selected.workspace.state.planner.localData.schemaVersion !== '2.5.0') throw new Error('The account needs its native domain migration before managed preparation')
    source = await captureAccountSnapshot(selected.workspace, expected, check, { database, token })
    inherited = await inheritWorkspaceSnapshot(source, [source])
    const evidence = await guestEvidenceFromSnapshot(inherited, emptyPlannerEvidence())
    const sidecar = await prepareLocalEvidence(store.adapter, operationId, evidence)
    const result = await prepareLocalWorkspace(store.adapter, operationId, selected.workspace.state, store.lifetime, undefined, sidecar)
    const reopened = await admitLocalRoot(store.adapter, result.head, { check: () => assertActiveProfile(token), assertCurrent: check })
    const durableEvidence = await readLocalEvidence(store.adapter, reopened.root.inheritedEvidence, check)
    if (!durableEvidence) throw new Error('The account migration originals are missing')
    await compareGuestEvidence(evidence, durableEvidence)
    await validateGuestCurrentBodies(reopened.state, durableEvidence)
    const metadata = (state: typeof reopened.state) => ({ ...state, blobs: state.blobs.map(body => body.ref) })
    if (!guestPlannerValuesEqual(metadata(reopened.state), metadata(selected.workspace.state))) throw new Error('The account migration changed native values')
    const prepared = await store.prepareLegacyActivation(operationId, result, expected)
    await check()
    return { prepared, async dispose() { await store.dispose() } }
  } catch (error) { await store.dispose(); throw error }
  finally { if (inherited) await disposeWorkspaceSnapshot(inherited); if (source) await disposeWorkspaceSnapshot(source) }
}
