import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { AccountDatabase } from '../persistence/account-database'
import { installProfile, invalidateProfile } from '../account/profile'
import { accountLocalId } from './account-cache'
import { initializeAccountWorkspace } from './account-initialization'
import { progress } from './signin-merge.test-helpers'
import { captureReadonlyMergeDestination } from './signin-merge-native'

it('requires the exact existing managed mapping without creating a worker mapping or evidence association', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32)), database = new AccountDatabase(token.accountId)
  try {
    const fence = await initializeAccountWorkspace(database, token, progress('record'))
    const before = await Promise.all(database.tables.map(async table => [table.name, await table.toArray()]))
    await expect(captureReadonlyMergeDestination(database, token, fence)).rejects.toThrow('SIGNIN_MAPPING_REQUIRED')
    expect(await Promise.all(database.tables.map(async table => [table.name, await table.toArray()]))).toEqual(before)
  } finally { await database.delete(); invalidateProfile() }
})

it('reads full local evidence without requiring or creating a publication evidence association', async () => {
  const token = installProfile(accountLocalId(), new Uint8Array(32)), database = new AccountDatabase(token.accountId)
  const { prepareIncrementalBaseline, activateIncrementalBaseline } = await import('./account-local-mapping')
  const { createAccountLocalStore } = await import('./account-local-store')
  const { prepareLocalWorkspace } = await import('./local-root')
  const { prepareLocalEvidence } = await import('./local-evidence')
  const { guestEvidenceFromFrozenCurrent, compareGuestEvidence, guestEvidenceSources } = await import('./guest-evidence')
  const { ownWorkspaceSnapshot, disposeWorkspaceSnapshot } = await import('./snapshot')
  const { LAUNCH_DATA_GENERATION } = await import('../domain/data-generation')
  const { activateLocalAccountCommit } = await import('../persistence/account-database')
  const state = progress('record'), store = createAccountLocalStore(database, token)
  const original = ownWorkspaceSnapshot({ dataGeneration: LAUNCH_DATA_GENERATION, version: 1, snapshotId: 'local-original', capturedAt: state.planner.localData.updatedAt, revisionVector: { source: 'one' }, state }, { check: async () => {}, dispose: async () => {} })
  let captured: Awaited<ReturnType<typeof captureReadonlyMergeDestination>> | undefined
  try {
    const operation = accountLocalId(), evidence = await guestEvidenceFromFrozenCurrent(original)
    const inherited = await prepareLocalEvidence(store.adapter, operation, evidence)
    const prepared = await prepareLocalWorkspace(store.adapter, operation, state, store.lifetime, undefined, inherited)
    const fence = await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, prepared, undefined)); store.committed(operation)
    await activateIncrementalBaseline(database, token, await prepareIncrementalBaseline(database, token, fence))
    await database.syncState.where('id').startsWith('incremental-evidence:').delete()
    const before = await Promise.all(database.tables.map(async table => [table.name, await table.toArray()]))
    captured = await captureReadonlyMergeDestination(database, token, fence)
    expect(captured.localEvidence).toBeDefined()
    expect(guestEvidenceSources(captured.localEvidence!).members).toHaveLength(1)
    await compareGuestEvidence(evidence, captured.localEvidence!)
    await captured.check()
    expect(await Promise.all(database.tables.map(async table => [table.name, await table.toArray()]))).toEqual(before)
  } finally { await captured?.dispose(); await store.dispose(); await disposeWorkspaceSnapshot(original); await database.delete(); invalidateProfile() }
})
