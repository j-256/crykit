import { validatePassword } from './password-policy'
import { z } from 'zod'
import { accountRequest, loginAccount, loginWithRecovery, changePassword, clearPendingCredentialChanges, resumeCredentialChange, type UnlockResult } from './auth-client'
import { beginDeviceApproval, clearDeviceApproval, completeDeviceApproval, waitForDeviceApproval, type PendingDeviceApproval } from './device-approval'
import { createLocalPasswordEnvelope, unlockLocalPasswordEnvelope } from './crypto/local-unlock'
import { assertKey } from './crypto/types'
import { createRememberedEnvelope, openRememberedEnvelope, readDeviceProfile, removeDeviceEnvelopes, updateDeviceProfile } from './device-store'
import { assertActiveProfile, captureProfileEpoch, installProfile, invalidateProfile, onProfileTransition, profileSignal, profileSessionIdentity, setProfileSession, withAccountKey, withProfileSession, type ProfileToken } from './profile'
import { withAuthLock } from './auth-coordinator'
import { AccountMetadataSchema, SessionReceiptSchema } from './protocol'

export const defaultRemember = false
const RevokedSchema = z.strictObject({ revoked: z.literal(true) })
onProfileTransition(() => clearPendingCredentialChanges())
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => invalidateProfile('pagehide'))

export async function activateProfile(unlocked: UnlockResult, remember: boolean, password?: string): Promise<ProfileToken> {
  assertKey(unlocked.key)
  if (password !== undefined && !validatePassword(password).valid) throw new Error('INVALID_PASSWORD')
  const key = unlocked.key.slice()
  unlocked.key.fill(0)
  invalidateProfile()
  const epoch = captureProfileEpoch()
  // Pending activation owns this buffer before an active profile exists
  const clearPendingKey = () => key.fill(0)
  epoch.signal.addEventListener('abort', clearPendingKey, { once: true })
  try {
    const passwordEnvelope = password === undefined ? undefined : await createLocalPasswordEnvelope(key, password, unlocked.accountId)
    epoch.assertCurrent()
    const remembered = remember ? await createRememberedEnvelope(key, unlocked.accountId) : undefined
    epoch.assertCurrent()
    return await withAuthLock(async run => {
      // Derivation can outlive another tab's login; attach only the actual cookie principal under exclusion
      const metadata = await run(signal => accountRequest('account', undefined, AccountMetadataSchema, undefined, 'GET', signal))
      if (metadata.accountId !== unlocked.accountId) throw new Error('ONLINE_ACCESS_DISCONNECTED')
      await updateDeviceProfile(unlocked.accountId, state => ({ ...state, ...(passwordEnvelope ? { passwordEnvelope } : {}), remembered, lastSessionId: metadata.sessionId }), epoch.assertCurrent, epoch.signal)
      epoch.assertCurrent()
      return installProfile(unlocked.accountId, key, metadata)
    }, epoch)
  } catch (error) { key.fill(0); throw error }
  finally { epoch.signal.removeEventListener('abort', clearPendingKey) }
}
async function unlockLocal(accountId: string, password?: string): Promise<ProfileToken> {
  invalidateProfile()
  const epoch = captureProfileEpoch()
  const state = await readDeviceProfile(accountId)
  epoch.assertCurrent()
  if (!state || (password === undefined ? !state.remembered : !state.passwordEnvelope)) throw new Error('PROFILE_LOCKED')
  const key = password === undefined ? await openRememberedEnvelope(state.remembered!, accountId) : await unlockLocalPasswordEnvelope(state.passwordEnvelope, password, accountId)
  try { epoch.assertCurrent(); return installProfile(accountId, key) }
  catch (error) { key.fill(0); throw error }
}
export function unlockCachedProfile(accountId: string, password: string): Promise<ProfileToken> { return unlockLocal(accountId, password) }
export function unlockRememberedProfile(accountId: string): Promise<ProfileToken> { return unlockLocal(accountId) }
export async function lockProfile(token: ProfileToken): Promise<void> { assertActiveProfile(token); invalidateProfile() }
export async function updateOfflinePassword(token: ProfileToken, password: string): Promise<void> {
  if (!validatePassword(password).valid) throw new Error('INVALID_PASSWORD')
  const signal = profileSignal(token)
  await withAccountKey(token, async key => {
    const passwordEnvelope = await createLocalPasswordEnvelope(key, password, token.accountId)
    assertActiveProfile(token)
    await updateDeviceProfile(token.accountId, state => ({ ...state, passwordEnvelope }), () => assertActiveProfile(token), signal)
    assertActiveProfile(token)
  })
}
export class OfflinePasswordUpdateError extends Error {
  readonly onlinePasswordChanged = true
  constructor(cause: unknown) { super('OFFLINE_PASSWORD_UPDATE_FAILED', { cause }) }
}
export async function changeProfilePassword(token: ProfileToken, password: string, transactionId: string): Promise<void> {
  let confirmed = false
  try { await withProfileSession(token, async unlocked => { await changePassword(unlocked, password, transactionId, profileSignal(token)); confirmed = true }) }
  catch (error) { if (confirmed) throw new OfflinePasswordUpdateError(error); throw error }
  try { await updateOfflinePassword(token, password) } catch (error) { throw new OfflinePasswordUpdateError(error) }
}
export async function resumeProfileCredentialChange(token: ProfileToken, transactionId: string) {
  // Replay confirms the saved server command, not an arbitrary password supplied later by the caller
  // A caller retaining the exact original password may update its offline envelope after this confirms
  return withProfileSession(token, unlocked => resumeCredentialChange(unlocked, transactionId, profileSignal(token)))
}
export function cancelProfileCredentialChanges(token: ProfileToken): void { assertActiveProfile(token); clearPendingCredentialChanges(token.accountId) }

export async function reconnectProfile(token: ProfileToken): Promise<void> {
  assertActiveProfile(token)
  try {
    await withAuthLock(async run => {
      assertActiveProfile(token)
      const metadata = await run(signal => accountRequest('account', undefined, AccountMetadataSchema, undefined, 'GET', signal))
      assertActiveProfile(token)
      if (metadata.accountId !== token.accountId) throw new Error('ONLINE_ACCESS_DISCONNECTED')
      await updateDeviceProfile(token.accountId, state => ({ ...state, lastSessionId: metadata.sessionId }), () => assertActiveProfile(token), profileSignal(token))
      setProfileSession(token, metadata)
    })
  } catch (error) { assertActiveProfile(token); setProfileSession(token); throw error }
}
export async function renewProfile(token: ProfileToken): Promise<void> {
  assertActiveProfile(token)
  try {
    await withAuthLock(async run => {
      assertActiveProfile(token)
      // Capture current cookie authority after acquiring cross-tab exclusion, never from a stale UI closure
      const metadata = await run(signal => accountRequest('account', undefined, AccountMetadataSchema, undefined, 'GET', signal))
      if (metadata.accountId !== token.accountId) throw new Error('ONLINE_ACCESS_DISCONNECTED')
      await run(signal => accountRequest('auth/renew', {}, SessionReceiptSchema, metadata.csrf, 'POST', signal))
      const actual = await run(signal => accountRequest('account', undefined, AccountMetadataSchema, undefined, 'GET', signal))
      assertActiveProfile(token)
      if (actual.accountId !== token.accountId) throw new Error('ONLINE_ACCESS_DISCONNECTED')
      await updateDeviceProfile(token.accountId, state => ({ ...state, lastSessionId: actual.sessionId }), () => assertActiveProfile(token), profileSignal(token))
      setProfileSession(token, actual)
    })
  } catch (error) { assertActiveProfile(token); setProfileSession(token); throw error }
}
export async function reconcilePendingRevocations(token: ProfileToken): Promise<{ revocationPending: boolean }> {
  assertActiveProfile(token)
  const state = await readDeviceProfile(token.accountId)
  assertActiveProfile(token)
  for (const sessionId of state?.pendingRevocations ?? []) {
    try {
      await withAuthLock(async run => {
        assertActiveProfile(token)
        const metadata = await run(signal => accountRequest('account', undefined, AccountMetadataSchema, undefined, 'GET', signal))
        if (metadata.accountId !== token.accountId) throw new Error('ONLINE_ACCESS_DISCONNECTED')
        await run(signal => accountRequest('account/sessions/revoke', { sessionId }, RevokedSchema, metadata.csrf, 'POST', signal))
        assertActiveProfile(token)
        await updateDeviceProfile(token.accountId, record => ({ ...record, pendingRevocations: record.pendingRevocations.filter(id => id !== sessionId) }), () => assertActiveProfile(token), profileSignal(token))
      })
    } catch { assertActiveProfile(token); return { revocationPending: true } }
  }
  return { revocationPending: false }
}
export async function signOutProfile(token: ProfileToken): Promise<{ revocationPending: boolean }> {
  assertActiveProfile(token)
  const captured = profileSessionIdentity(token)
  invalidateProfile()
  const epoch = captureProfileEpoch()
  // Last observed session identity is a revocation target, never authority for local or online access
  // Keep it across restart so offline sign-out can name the original session even without its cookie
  await updateDeviceProfile(token.accountId, record => {
    const sessionId = captured.sessionId ?? record.lastSessionId
    return { ...record, remembered: undefined, lastSessionId: undefined, pendingRevocations: sessionId ? [...new Set([...record.pendingRevocations, sessionId])] : record.pendingRevocations }
  }, epoch.assertCurrent, epoch.signal)
  const state = await readDeviceProfile(token.accountId)
  epoch.assertCurrent()
  if (!state?.pendingRevocations.length) return { revocationPending: false }
  try {
    await withAuthLock(async run => {
      const current = await run(signal => accountRequest('account', undefined, AccountMetadataSchema, undefined, 'GET', signal))
      if (current.accountId !== token.accountId) throw new Error('ONLINE_ACCESS_DISCONNECTED')
      // Reconcile exact saved IDs, never substitute the session carried by the ambient cookie
      for (const sessionId of state.pendingRevocations) {
        await run(signal => accountRequest('account/sessions/revoke', { sessionId }, RevokedSchema, current.csrf, 'POST', signal))
        await updateDeviceProfile(token.accountId, record => ({ ...record, pendingRevocations: record.pendingRevocations.filter(id => id !== sessionId) }), epoch.assertCurrent, epoch.signal)
      }
    }, epoch)
    const remaining = await readDeviceProfile(token.accountId)
    epoch.assertCurrent()
    return { revocationPending: !!remaining?.pendingRevocations.length }
  } catch { epoch.assertCurrent(); return { revocationPending: true } }
}
// S01 supplies real pending-work and backup/removal operations; no invented empty repository lives here
export interface DeviceRemovalReview {
  readonly pendingWork: boolean
  exportBackup(): Promise<void>
  removeEncryptedData(): Promise<void>
}
export async function removeProfileFromDevice(token: ProfileToken, review: DeviceRemovalReview, confirmation: { confirmed: true; recovery: 'backup' | 'discard' }): Promise<void> {
  assertActiveProfile(token)
  if (confirmation.confirmed !== true || !['backup', 'discard'].includes(confirmation.recovery)) throw new Error('DEVICE_REMOVAL_CONFIRMATION_REQUIRED')
  if (confirmation.recovery === 'backup') { await review.exportBackup(); assertActiveProfile(token) }
  await review.removeEncryptedData(); assertActiveProfile(token)
  await removeDeviceEnvelopes(token.accountId, () => assertActiveProfile(token), profileSignal(token))
  await lockProfile(token)
}
export interface ApprovalHandle { readonly id: string }
export interface ApprovalView { readonly handle: ApprovalHandle; readonly requestId: string; readonly fingerprint: string; readonly expiresAt: number }
const approvals = new Map<string, { pending: PendingDeviceApproval; epoch: ReturnType<typeof captureProfileEpoch>; controller: AbortController }>()
onProfileTransition(() => {
  for (const owned of approvals.values()) { owned.controller.abort(); clearDeviceApproval(owned.pending) }
  approvals.clear()
})
function ownedApproval(handle: ApprovalHandle) {
  const owned = approvals.get(handle.id)
  if (!owned) throw new Error('DEVICE_APPROVAL_CANCELLED')
  owned.epoch.assertCurrent()
  return owned
}
export async function startAccountDeviceApproval(email: string): Promise<ApprovalView> {
  const epoch = captureProfileEpoch()
  const pending = await beginDeviceApproval(email, epoch.signal)
  try {
    epoch.assertCurrent()
    const handle = Object.freeze({ id: crypto.randomUUID() })
    approvals.set(handle.id, { pending, epoch, controller: new AbortController() })
    return { handle, requestId: pending.requestId, fingerprint: pending.fingerprint, expiresAt: pending.expiresAt }
  } catch (error) { clearDeviceApproval(pending); throw error }
}
export function cancelAccountDeviceApproval(handle: ApprovalHandle): void {
  const owned = approvals.get(handle.id)
  if (!owned) return
  approvals.delete(handle.id)
  owned.controller.abort()
  clearDeviceApproval(owned.pending)
}
export async function waitForAccountDeviceApproval(handle: ApprovalHandle): Promise<void> {
  const owned = ownedApproval(handle)
  try {
    await waitForDeviceApproval(owned.pending, { signal: owned.controller.signal, isCurrentProfile: () => { try { owned.epoch.assertCurrent(); return approvals.has(handle.id) } catch { return false } } })
    owned.epoch.assertCurrent()
  } catch (error) { cancelAccountDeviceApproval(handle); throw error }
}
export async function completeAccountDeviceApproval(handle: ApprovalHandle, remember = defaultRemember): Promise<ProfileToken> {
  const owned = ownedApproval(handle)
  try {
    const unlocked = await completeDeviceApproval(owned.pending, remember)
    try { owned.epoch.assertCurrent(); owned.controller.signal.throwIfAborted() } catch (error) { unlocked.key.fill(0); throw error }
    return await activateProfile(unlocked, remember)
  } finally { cancelAccountDeviceApproval(handle) }
}

export async function signInProfile(input: { email: string; password: string; remember?: boolean }): Promise<ProfileToken> {
  const epoch = captureProfileEpoch()
  const unlocked = await loginAccount({ ...input, remember: input.remember ?? defaultRemember })
  try { epoch.assertCurrent() } catch (error) { unlocked.key.fill(0); throw error }
  return activateProfile(unlocked, input.remember ?? defaultRemember, input.password)
}
export async function recoverProfile(email: string, code: string, remember = defaultRemember): Promise<ProfileToken> {
  const epoch = captureProfileEpoch()
  const unlocked = await loginWithRecovery(email, code, remember)
  try { epoch.assertCurrent() } catch (error) { unlocked.key.fill(0); throw error }
  return activateProfile(unlocked, remember)
}
