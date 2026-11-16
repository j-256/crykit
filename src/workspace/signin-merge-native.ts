import { z } from 'zod'
import { assertActiveProfile, type ProfileToken } from '../account/profile'
import type { AccountDatabase, AccountFence, CipherRecord, EncryptedSyncState } from '../persistence/account-database'
import { jsonEqual } from '../persistence/local-data'
import { accountMappingRootKey, readIncrementalMappedRoot } from './account-mapping-origin'
import { AccountWorkspaceRootSchema, AccountWorkspaceRootV2Schema, authenticateAccountWorkspaceSubtree } from './account-graph'
import { openAccountJson } from './account-cache'
import { accountInheritedEvidenceCheck, openAccountInheritedEvidence, type AccountInheritedEvidence } from './account-evidence-snapshots'
import { createAccountLocalStore } from './account-local-store'
import { admitLocalRoot } from './local-root'
import { readLocalEvidence } from './local-evidence'
import { isManagedAccountHead } from './account-sync-capture'

// This capture cannot invoke the mapper or publish an evidence association
// A missing native mapping is a main-coordinator prerequisite, never worker write authority
export async function captureReadonlyMergeDestination(database: AccountDatabase, token: ProfileToken, input: AccountFence) {
  const expected = structuredClone(input), store = createAccountLocalStore(database, token)
  let native: Awaited<ReturnType<typeof authenticateAccountWorkspaceSubtree>> | undefined
  let evidence: AccountInheritedEvidence | undefined
  let disposed = false
  const check = async () => {
    assertActiveProfile(token)
    if (disposed || !jsonEqual(await database.profileMeta.get('active'), expected)) throw new Error('LOCAL_REVISION_CONFLICT')
  }
  const dispose = async () => {
    if (disposed) return
    disposed = true
    const results = await Promise.allSettled([native?.dispose(), evidence?.dispose(), store.dispose()])
    const failures = results.flatMap(value => value.status === 'rejected' ? [value.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Merge source cleanup failed')
  }
  try {
    await check()
    const managed = await isManagedAccountHead(database, token, expected)
    const local = managed ? await admitLocalRoot(store.adapter, expected.head, { check: () => assertActiveProfile(token), assertCurrent: check }) : undefined
    const rows: { id: string; expected: EncryptedSyncState | null }[] = []
    const mappedKey = accountMappingRootKey(expected.head)
    if (managed) rows.push({ id: mappedKey, expected: await database.syncState.get(mappedKey) ?? null })
    const mapped = managed ? await readIncrementalMappedRoot(database, token, expected) : expected.head
    if (!mapped) throw new Error('SIGNIN_MAPPING_REQUIRED')
    const root = await openAccountJson(database, token, mapped, z.union([AccountWorkspaceRootSchema, AccountWorkspaceRootV2Schema]))
    native = await authenticateAccountWorkspaceSubtree(database, token, mapped, { version: root.version })
    if (root.version === 2) evidence = await openAccountInheritedEvidence(database, token, root.inheritedEvidence)
    const localEvidence = local ? await readLocalEvidence(store.adapter, local.root.inheritedEvidence, check) : undefined
    if (local?.root.inheritedEvidence) {
      const id = `incremental-evidence:${local.root.inheritedEvidence.revisionId}`
      rows.push({ id, expected: await database.syncState.get(id) ?? null })
    }
    await native.recheck(); await evidence?.check(); await localEvidence?.check(); await check()
    const captured = native
    const known = new Map<string, CipherRecord>()
    const record = (value: CipherRecord) => {
      const previous = known.get(value.revisionId)
      if (previous && !jsonEqual(previous, value)) throw new Error('SIGNIN_RECEIPT_MISMATCH')
      known.set(value.revisionId, value)
    }
    for (const value of [...captured.recordObservations(), ...store.observedRecords(), ...(evidence ? accountInheritedEvidenceCheck(evidence, database, token).observations() : [])]) record(value)
    return { managed, workspace: { ...captured.workspace, state: { ...captured.workspace.state, planner: local?.state.planner ?? captured.workspace.state.planner } }, evidence, localEvidence,
      sourceRoots: [expected.head, mapped], sourceRows: [...rows, ...captured.observations().map(({ id, row }) => ({ id, expected: row ?? null }))], records: [...known.values()],
      async check() {
        await check(); await captured.recheck(); await evidence?.check(); await localEvidence?.check()
        for (const row of rows) if (!jsonEqual(await database.syncState.get(row.id) ?? null, row.expected)) throw new Error('LOCAL_REVISION_CONFLICT')
        await check()
      }, dispose,
    }
  } catch (error) { await dispose(); throw error }
}
