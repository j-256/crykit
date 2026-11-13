import Dexie from 'dexie'
import { BUNDLED_CATALOGS } from '../catalog/bundled'
import { createBlankLocalData } from '../domain/local-data'
import { assertActiveProfile, profileSignal, type ProfileToken } from '../account/profile'
import { AccountDatabase, type AccountFence } from '../persistence/account-database'
import { jsonEqual } from '../persistence/local-data'
import { validateWorkspaceClosure } from './closure'
import type { WorkspaceState } from './documents'
import { WorkspaceError, type WorkspaceRepository } from './repository'
import { createAccountLocalStore } from './account-local-store'
import { admitLocalRoot } from './local-root'

// New accounts retain the complete starting collection; saved graphs keep their exact source bodies
const INITIAL_ACCOUNT_CATALOGS = BUNDLED_CATALOGS
export async function openAccountRepository(token: ProfileToken): Promise<WorkspaceRepository> {
  assertActiveProfile(token)
  const database = new AccountDatabase(token.accountId)
  try {
    const { isManagedAccountHead } = await import('./account-sync-capture')
    const { openAccountManagedRepository } = await import('./account-managed-repository')
    let selected = await database.profileMeta.get('active')
    if (!selected) {
      // Fresh profiles prepare the managed layout before editing, without manufacturing a legacy source
      const { initializeAccountWorkspace } = await import('./account-initialization')
      const localData = createBlankLocalData()
      const state: WorkspaceState = { planner: { localData, lineage: { rootLocalDataId: localData.id }, catalogs: INITIAL_ACCOUNT_CATALOGS, evidence: [], sources: [], history: [] }, editorDocuments: [], saveDocuments: [], assets: [], libraryDefaults: { version: 1, layers: [] }, conflicts: [], retainedContent: [], blobs: [] }
      selected = await initializeAccountWorkspace(database, token, state)
    }
    if (!selected) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'No active encrypted workspace is available.')
    if (!await isManagedAccountHead(database, token, selected)) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'This encrypted workspace uses an unsupported prelaunch format.')
    assertActiveProfile(token)
    return await openAccountManagedRepository(database, token, selected)
  } catch (error) { database.close(); throw error }
}

export async function accountPendingWork(token: ProfileToken): Promise<boolean> {
  assertActiveProfile(token)
  const database = new AccountDatabase(token.accountId)
  try { const pending = await database.outbox.count(); assertActiveProfile(token); return pending > 0 }
  finally { database.close() }
}
export async function removeEncryptedAccountData(token: ProfileToken, expected?: AccountFence, assertMayRemove: () => void = () => {}): Promise<void> {
  assertActiveProfile(token)
  const database = new AccountDatabase(token.accountId)
  const signal = profileSignal(token)
  let transaction: import('dexie').Transaction | undefined
  const abort = () => transaction?.abort()
  signal.addEventListener('abort', abort, { once: true })
  try {
    // Keep the named shell: a deleteDatabase request cannot be cancelled after a profile switch
    // Clearing ciphertext and the active fence together also rejects previously prepared writers
    await database.transaction('rw', database.tables, async () => {
      transaction = Dexie.currentTransaction ?? undefined
      assertActiveProfile(token)
      assertMayRemove()
      if (expected && !jsonEqual(await database.profileMeta.get('active'), expected)) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'Saved data changed after removal review. Review this device copy again.')
      for (const table of database.tables) await table.clear()
      assertMayRemove()
      assertActiveProfile(token)
    })
    assertActiveProfile(token)
  } finally { signal.removeEventListener('abort', abort); database.close() }
}

export async function readAccountSaveRecovery(token: ProfileToken, expected: import('./documents').SaveWorkspaceDocument) {
  assertActiveProfile(token)
  const database = new AccountDatabase(token.accountId)
  const store = createAccountLocalStore(database, token)
  try {
    const fence = await database.profileMeta.get('active')
    if (!fence) throw new WorkspaceError('LOCAL_INTEGRITY_FAILED', 'No active encrypted workspace is available.')
    const state = (await admitLocalRoot(store.adapter, fence.head, store.lifetime)).state
    await validateWorkspaceClosure(state)
    const file = state.saveDocuments.find(value => value.id === expected.id)
    if (JSON.stringify(file) !== JSON.stringify(expected)) throw new Error('The saved recovery file changed')
    const { readSaveContent } = await import('./save-repository')
    const content = await readSaveContent(state, expected)
    assertActiveProfile(token)
    if (!jsonEqual(await database.profileMeta.get('active'), fence)) throw new WorkspaceError('LOCAL_REVISION_CONFLICT', 'The saved recovery workspace changed.')
    return content
  } finally { await store.dispose(); database.close() }
}
