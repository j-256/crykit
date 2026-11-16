import { assertActiveProfile, type ProfileToken } from '../account/profile'
import { activateLocalAccountCommit, type AccountDatabase, type AccountFence } from '../persistence/account-database'
import { accountLocalId } from './account-cache'
import { createAccountLocalStore } from './account-local-store'
import type { WorkspaceState } from './documents'
import { prepareLocalWorkspace } from './local-root'
import { WorkspaceError } from './repository'

// Fresh opening and guest copy must choose the same editable storage layout
// Creating a native graph here would manufacture a legacy source and force an immediate full migration
export async function initializeAccountWorkspace(database: AccountDatabase, token: ProfileToken, state: WorkspaceState, assertCurrent: () => void = () => {}): Promise<AccountFence> {
  const check = () => { assertActiveProfile(token); assertCurrent() }
  check()
  const existing = await database.profileMeta.get('active')
  check()
  if (existing) return existing
  const store = createAccountLocalStore(database, token), operation = accountLocalId()
  // Cancellation follows the same captured lifetime through staging and the activation transaction
  // Pure preflight completion never grants authority to select a head after its caller has retired
  const lifetime = { check() { store.lifetime.check(); check() }, async assertCurrent() { check(); await store.lifetime.assertCurrent(); check() } }
  try {
    const result = await prepareLocalWorkspace(store.adapter, operation, state, lifetime)
    try {
      const selected = await activateLocalAccountCommit(database, token, await store.prepareActivation(operation, result, undefined), check)
      store.committed(operation)
      return selected
    } catch (error) {
      if (!(error instanceof WorkspaceError && error.code === 'LOCAL_REVISION_CONFLICT')) throw error
      const winner = await database.profileMeta.get('active')
      check()
      if (!winner) throw error
      return winner
    }
  } finally { await store.dispose() }
}
