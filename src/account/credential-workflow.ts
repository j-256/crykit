import * as lifecycle from './lifecycle'
import * as management from './management'
import { assertActiveProfile, currentProfileToken, registerProfileCleanup, type ProfileToken } from './profile'

interface CredentialWorkflow {
  readonly busy: boolean
  readonly pending?: { readonly transactionId: string; readonly role: 'password' | 'recovery' }
  readonly repair: boolean
  readonly recoveryDisplay?: string
}
const empty: CredentialWorkflow = Object.freeze({ busy: false, repair: false })
let owner: ProfileToken | undefined
let state = empty
const listeners = new Set<() => void>()
export function subscribeCredentialWorkflow(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
function publish(next: CredentialWorkflow): void { state = Object.freeze(next); for (const listener of listeners) listener() }
export function credentialWorkflow(token?: ProfileToken): CredentialWorkflow {
  return token && owner === token && currentProfileToken() === token ? state : empty
}
function capture(token: ProfileToken): void {
  assertActiveProfile(token)
  if (owner === token) return
  owner = token
  state = empty
  // Navigation may unmount every subscriber; lifecycle cleanup still erases the transient display
  registerProfileCleanup(token, () => { if (owner === token) { owner = undefined; publish(empty) } })
}
async function perform<T>(token: ProfileToken, role: 'password' | 'recovery', action: () => Promise<T>, completed: (result: T) => CredentialWorkflow): Promise<T> {
  capture(token)
  if (state.busy) throw new Error('CREDENTIAL_CHANGE_PENDING')
  publish({ ...state, busy: true })
  try {
    const result = await action()
    assertActiveProfile(token)
    publish(completed(result))
    return result
  } catch (error) {
    assertActiveProfile(token)
    if (error instanceof Error && error.message === 'CREDENTIAL_CHANGE_UNCONFIRMED' && 'transactionId' in error) publish({ ...state, pending: { transactionId: String(error.transactionId), role } })
    if (error instanceof Error && error.message === 'OFFLINE_PASSWORD_UPDATE_FAILED') publish({ ...state, pending: undefined, repair: true })
    // Expired/missing prepared commands stay visibly unresolved until explicit discard or a lifecycle transition
    throw error
  } finally { if (currentProfileToken() === token) publish({ ...state, busy: false }) }
}
function requireNewChange(token: ProfileToken): void {
  capture(token)
  if (state.pending || state.repair) throw new Error('CREDENTIAL_CHANGE_PENDING')
}
export function changeCredentialPassword(token: ProfileToken, password: string): Promise<void> {
  requireNewChange(token)
  return perform(token, 'password', () => lifecycle.changeProfilePassword(token, password, management.accountTransactionId()), () => empty)
}
export function createCredentialRecovery(token: ProfileToken): Promise<string> {
  requireNewChange(token)
  return perform(token, 'recovery', () => management.createProfileRecovery(token, management.accountTransactionId()), display => ({ ...empty, recoveryDisplay: display }))
}
export function resumeCredentialWorkflow(token: ProfileToken) {
  capture(token)
  const pending = state.pending
  if (!pending) throw new Error('CREDENTIAL_CHANGE_NOT_PENDING')
  // Only A02 owns the original prepared command; no password or substitute input enters resume
  return perform(token, pending.role, () => lifecycle.resumeProfileCredentialChange(token, pending.transactionId), receipt => receipt.role === 'password' ? { ...empty, repair: true } : { ...empty, recoveryDisplay: receipt.display })
}
export function repairCredentialPassword(token: ProfileToken, password: string): Promise<void> {
  return perform(token, 'password', () => management.repairOfflinePassword(token, password), () => ({ ...state, repair: false }))
}
export function clearCredentialRetry(token: ProfileToken): void {
  capture(token)
  if (state.busy) throw new Error('CREDENTIAL_CHANGE_PENDING')
  lifecycle.cancelProfileCredentialChanges(token)
  publish({ ...state, pending: undefined })
}
export function dismissCredentialDisplay(token: ProfileToken): void {
  capture(token)
  publish({ ...state, recoveryDisplay: undefined })
}
