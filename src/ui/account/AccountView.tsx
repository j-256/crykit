import { StoragePanel } from './StoragePanel'
import { createStorageService } from '../../account/storage'
import type { WorkspaceRepository } from '../../workspace/repository'
import { DeletionPanel } from './DeletionPanel'
import { LocalCopyPreview, type LocalCopyService } from './LocalCopyPreview'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { registerAccount } from '../../account/auth-client'
import * as lifecycle from '../../account/lifecycle'
import * as management from '../../account/management'
import * as credentials from '../../account/credential-workflow'
import { listCachedProfiles } from '../../account/device-store'
import { assertActiveProfile, captureProfileEpoch, currentProfileToken, invalidateProfile, onProfileTransition, profileAccess, type ProfileToken } from '../../account/profile'
import { clearEmailCapability, confirmPendingEmail, emailConfirmationKind, resendVerification } from '../../account/email-capability'
import { SignInForm } from './SignInForm'
import { RecoveryPanel } from './RecoveryPanel'
import { DeviceApprovalPanel } from './DeviceApprovalPanel'
import { formatAppError } from '../browser-actions'
import { CloudServiceNotice } from '../CloudServiceNotice'
import { readServiceNotice, subscribeServiceNotice } from '../../account/service-notice'
import './account.css'

const messages: Record<string, string> = {
  INVALID_PASSWORD: 'Use at least 15 Unicode characters and at most 1024 UTF-8 bytes for your password.',
  FORBIDDEN: 'Confirm your identity below, then retry this action.',
  AUTH_FAILED: 'Sign-in failed. Check your email and password or use your recovery code.',
  CSRF_FAILED: 'Online access expired. Sign in again to manage your account. Cached data stays on this device.',
  CREDENTIAL_CHANGE_PENDING: 'Finish or clear the existing credential change before starting another one.',
  AUTH_REQUIRED: 'Online access expired. Sign in again to manage your account. Cached data stays on this device.',
  ONLINE_ACCESS_DISCONNECTED: 'Online access is disconnected. Reconnect or sign in again. Cached data stays on this device.',
  AUTH_COORDINATION_UNAVAILABLE: 'Online sign-in is unavailable in this browser. Retry in a secure, updated browser or continue on this device.',
  UNSUPPORTED_VERSION: 'Reload CryKit before using your account. This account client needs an update.',
  SERVICE_UNAVAILABLE: 'This service or email delivery is unavailable. Retry later, sign in with existing access, or continue on this device.',
  SERVICE_PAUSED: 'Cloud operations are paused by a service usage safeguard. Continue editing on this device.',
  RATE_LIMITED: 'Requests are temporarily limited to protect CryKit. See the service notice for retry and contact details.',
  STALE_CURSOR: 'This device list expired. Choose Refresh devices and approvals to restart.',
  INVALID_REQUEST: 'This request is invalid or expired. Check the details or request a fresh link or approval.',
  CREDENTIAL_CHANGE_UNCONFIRMED: 'The change is not confirmed. Check the pending change before starting another one.',
  CREDENTIAL_CHANGE_NOT_PENDING: 'The saved change expired or was cleared. Sign in again to establish which password works.',
  OFFLINE_PASSWORD_UPDATE_FAILED: 'Your online password changed. Local unlocking still needs repair. Verify your new password below.',
  AUTH_REQUEST_TIMEOUT: 'The response timed out. The server may have completed the change. Reconnect or check the pending change.',
  AUTH_ACQUISITION_TIMEOUT: 'Another tab is signing in. Wait for it to finish, then retry.',
  DEVICE_APPROVAL_EXPIRED: 'Approval expired. Request approval again.',
  DEVICE_APPROVAL_NOT_READY: 'Approval was rejected, expired or already used. Request a fresh approval.',
  DEVICE_APPROVAL_CANCELLED: 'Approval cancelled or expired. Request approval again.',
  WORKSPACE_CONNECTION_UNAVAILABLE: 'Account access is ready. Retry opening the account workspace. Your local records stay on this device.',
  ACCOUNT_RESTRICTED: 'Online account changes are restricted. Keep working on this device, download a private backup, or contact the service operator.',
}
export function AccountView({ onOpenWorkspace, onContinueLocal, onBackup, localCopy, repository, assertMayRemove }: { onOpenWorkspace: (token: ProfileToken) => Promise<void>; onContinueLocal: () => Promise<void>; onBackup?: () => Promise<void>; localCopy?: LocalCopyService; repository?: WorkspaceRepository; assertMayRemove?: () => void }): ReactElement {
  const [token, setToken] = useState(currentProfileToken)
  const callbacks = useRef({ onBackup, assertMayRemove })
  callbacks.current = { onBackup, assertMayRemove }
  const storage = useMemo(() => token && repository?.kind === 'account' ? createStorageService(token, repository, async () => { if (!callbacks.current.onBackup) throw new Error('Open the account workspace first'); await callbacks.current.onBackup() }, () => { if (!callbacks.current.assertMayRemove) throw new Error('Open the account workspace first'); callbacks.current.assertMayRemove() }) : undefined, [token, repository])
  const [metadata, setMetadata] = useState<management.AccountViewMetadata>()
  const [cached, setCached] = useState<Awaited<ReturnType<typeof listCachedProfiles>>>([])
  const [working, setBusy] = useState(false)
  const [error, setError] = useState('')
  const serviceNotice = useSyncExternalStore(subscribeServiceNotice, readServiceNotice, () => undefined)
  const [status, setStatus] = useState('')
  const [pendingEmail, setPendingEmail] = useState('')
  const [confirmation, setConfirmation] = useState(emailConfirmationKind)
  const workflow = useSyncExternalStore(credentials.subscribeCredentialWorkflow, () => credentials.credentialWorkflow(token))
  const { pending, repair, recoveryDisplay: code } = workflow
  const busy = working || workflow.busy
  const alert = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  const operation = useRef(0)
  const profileVersion = useRef(0)
  const pendingAccess = useRef<ReturnType<typeof captureProfileEpoch>>(undefined)
  useEffect(() => {
    mounted.current = true
    if (!currentProfileToken()) pendingAccess.current = captureProfileEpoch()
    void listCachedProfiles().then(value => { if (mounted.current) setCached(value) }).catch(() => { if (mounted.current) setError('Saved account access could not be read. You can still sign in online.') })
    const stop = onProfileTransition(() => { pendingAccess.current = undefined; profileVersion.current++; setToken(undefined); setMetadata(undefined); setBusy(false); setError(''); setStatus('') })
    // Cancel only pre-login work this view owns; sign-out owns its successor revocation epoch
    return () => {
      mounted.current = false; operation.current++; stop()
      if (!currentProfileToken() && pendingAccess.current) {
        try { pendingAccess.current.assertCurrent(); invalidateProfile() } catch { /* A successor owns cleanup */ }
      }
    }
  }, [])
  useEffect(() => { const changed = () => setConfirmation(emailConfirmationKind()); window.addEventListener('account-email-link', changed); return () => window.removeEventListener('account-email-link', changed) }, [])
  useEffect(() => { if (error) alert.current?.focus() }, [error])
  useEffect(() => {
    if (!token || profileAccess(token) !== 'connected') return
    let active = true
    const version = profileVersion.current
    // Mount reads do not own user actions; discard their results after navigation or a newer action
    const id = operation.current
    void management.readAccountView(token).then(value => { if (active && version === profileVersion.current && id === operation.current) setMetadata(value) }).catch(reason => {
      if (!active || version !== profileVersion.current || id !== operation.current || (reason instanceof Error && reason.message === 'PROFILE_CHANGED')) return
      setMetadata(undefined)
      setError(messages[reason instanceof Error ? reason.message : ''] ?? 'Account details could not be read. Reconnect or retry when connected.')
    })
    return () => { active = false }
  }, [token])
  // Access and sign-out intentionally transition generations; ordinary requests must discard stale errors
  async function execute(work: () => Promise<void>, transitions = false, localBackup = false, ownsPendingAccess = true) {
    const id = ++operation.current
    const version = profileVersion.current
    setBusy(true); setError('')
    const startsWithoutProfile = !currentProfileToken()
    try {
      const result = work()
      // Sign-in starts a new epoch synchronously; capture it after that transition
      // Explicit guest handoff owns its new epoch after this view unmounts
      if (ownsPendingAccess && startsWithoutProfile && !currentProfileToken()) pendingAccess.current = captureProfileEpoch()
      await result
    }
    catch (reason) {
      if (!mounted.current || (id !== operation.current || (!transitions && version !== profileVersion.current)) || (reason instanceof Error && reason.message === 'PROFILE_CHANGED')) return
      const key = reason instanceof Error ? reason.message : ''
      setError(localBackup ? formatAppError(reason, 'The private backup could not be prepared. Saved data stays in place.') : messages[key] ?? 'The action could not be completed. Retry when connected. Saved data stays in place.')
    } finally { if (mounted.current && id === operation.current) setBusy(false) }
  }
  function run(work: () => Promise<void>, transitions = false, ownsPendingAccess = true) { void execute(work, transitions, false, ownsPendingAccess) }
  async function accessed(next: ProfileToken) {
    assertActiveProfile(next)
    if (!mounted.current) { await lifecycle.lockProfile(next); return }
    setToken(next); setBusy(false); setPendingEmail(''); setStatus(profileAccess(next) === 'connected' ? 'Signed in. Your local records have not been copied to this account.' : 'Unlocked on this device. Online access is disconnected.')
    setCached(await listCachedProfiles())
    if (profileAccess(next) === 'connected') {
      // The token effect owns initial metadata loading; another read here competes with that same request
      const result = await lifecycle.reconcilePendingRevocations(next)
      assertActiveProfile(next)
      if (result.revocationPending) setStatus('Signed in. An earlier sign-out is still pending. Retry reconciliation when connected.')
    }
  }
  async function refresh() { if (token) setMetadata(await management.readAccountView(token)) }
  const connected = token ? profileAccess(token) === 'connected' : false
  return <article className="account-view"><h1>Account</h1><p>Use CryKit on this device without an account, or sign in for account access. Signing in does not copy your local records.</p>
    <CloudServiceNotice/>
    <button onClick={() => run(async () => { invalidateProfile(); clearEmailCapability(); await onContinueLocal() }, true, false)}>Continue using this device</button>
    {error && (!serviceNotice || error !== messages[serviceNotice.code]) && <div className="account-error" role="alert" ref={alert} tabIndex={-1}><strong>Action needs attention</strong><p>{error}</p></div>}{status && <p role="status">{status}</p>}
    {confirmation && <section><h2>Confirm email</h2><p>{confirmation === 'verify' ? 'Confirm your account email, then sign in. Links expire after 30 minutes and work once.' : 'Sign in to the account that requested this new email, then confirm.'}</p><button disabled={busy || (confirmation === 'confirm-email' && !connected)} onClick={() => run(async () => { await confirmPendingEmail(token); setConfirmation(undefined); setStatus('Email confirmed. You can sign in.'); if (token) await refresh() })}>Confirm email</button><button onClick={() => { clearEmailCapability(); setConfirmation(undefined) }}>Discard link</button></section>}
    {(!token || !connected) && <SignInForm busy={busy} onSubmit={(input, signup) => execute(async () => { if (signup) { await registerAccount(input); setPendingEmail(input.email); setStatus('Check your email to verify your account before signing in or uploading. Pending signup expires after 24 hours.'); } else await accessed(await lifecycle.signInProfile(input)) }, true)}/>}
    {pendingEmail && <section><h2>Check your email</h2><p>Links expire after 30 minutes. If signup expires after 24 hours, create the account again.</p><button disabled={busy} onClick={() => run(async () => { await resendVerification(pendingEmail); setStatus('If signup is still pending, a new verification email has been requested.') })}>Resend verification email</button></section>}
    {cached.some(profile => profile.revocationPending) && <p role="status">An earlier sign-out is pending. Sign in to its account to finish revoking that session. Other accounts cannot clear it.</p>}
    {!token && cached.map(profile => <section key={profile.accountId}><h2>Saved account ending {profile.accountId.slice(-6)}</h2>{profile.remembered && <button disabled={busy} onClick={() => run(async () => accessed(await lifecycle.unlockRememberedProfile(profile.accountId)), true)}>Unlock remembered account</button>}{profile.passwordAvailable && <form onSubmit={event => { event.preventDefault(); const input = event.currentTarget.elements.namedItem('password') as HTMLInputElement; const password = input.value; input.value = ''; run(async () => accessed(await lifecycle.unlockCachedProfile(profile.accountId, password)), true) }}><label>Local password<input aria-label="Local password" type="password" name="password" autoComplete="current-password" required/></label><button disabled={busy}>Unlock on this device</button></form>}</section>)}
    {token && <section><h2>{metadata ? `Signed in as ${metadata.username}` : 'Account unlocked on this device'}</h2><p>{connected ? 'Online access connected.' : 'Online access disconnected. You can reconnect or sign in again.'}</p>{metadata?.access === 'read-only' && <p role="status">Online account changes are restricted. Local editing and private backups remain available. Contact the service operator to review the restriction.</p>}{metadata && <p>Email: {metadata.email}. Online session ends by {new Date(metadata.expiresAt).toLocaleString()}.</p>}<button disabled={busy} onClick={() => run(async () => { await onOpenWorkspace(token) })}>Open account workspace</button><button onClick={() => run(async () => { await lifecycle.lockProfile(token); setStatus('Account locked on this device.') }, true)}>Lock</button><button onClick={() => run(async () => { const result = await lifecycle.signOutProfile(token); setCached(await listCachedProfiles()); setStatus(result.revocationPending ? 'Signed out locally. Online revocation is pending; sign in to this account to retry.' : 'Signed out.'); }, true)}>Sign out</button><button disabled={busy} onClick={() => run(async () => { await lifecycle.reconnectProfile(token); await refresh(); setStatus('Online access reconnected.') })}>Reconnect</button><button disabled={busy || !connected} onClick={() => run(async () => { await lifecycle.renewProfile(token); await refresh(); setStatus('Online session renewed.') })}>Renew session</button><button disabled={busy || !connected} onClick={() => run(async () => { const result = await lifecycle.reconcilePendingRevocations(token); setCached(await listCachedProfiles()); setStatus(result.revocationPending ? 'Earlier sign-out is still pending.' : 'Earlier sign-outs reconciled for this account.') })}>Retry pending sign-out</button></section>}
    {token && localCopy && <LocalCopyPreview key={`copy-${token.generation}`} token={token} service={localCopy}/>}
    {pending && <p role="status">A credential change is not confirmed. Reconnect if needed, then check the saved change before starting another one.</p>}
    {repair && <p>Your online password changed. Local unlocking still needs repair. Verify your new password below.</p>}
    {token && connected && <section><h2>Account settings</h2><form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); const input = event.currentTarget.elements.namedItem('secret') as HTMLInputElement; const secret = input.value; input.value = ''; run(async () => { await management.reauthenticateProfile(token, secret, data.get('role') === 'recovery' ? 'recovery' : 'password'); setStatus('Identity confirmed for 10 minutes.') }) }}><label>Confirm with<select name="role"><option value="password">Password</option><option value="recovery">Recovery code</option></select></label><label>Current password or recovery code<input aria-label="Current password or recovery code" name="secret" type="password" required autoComplete="current-password"/></label><button disabled={busy}>Confirm identity</button></form>
      <form onSubmit={event => { event.preventDefault(); const input = event.currentTarget.elements.namedItem('password') as HTMLInputElement; const password = input.value; input.value = ''; run(async () => { await credentials.changeCredentialPassword(token, password); setStatus('Password changed online and on this device.') }) }}><label>New password<input aria-label="New password" name="password" type="password" autoComplete="new-password" required/></label><button disabled={busy || !!pending || repair}>Change password</button></form>
      {pending && <div><p>The exact submitted change is saved temporarily. Checking it cannot change the password to a newly typed value.</p><button disabled={busy} onClick={() => run(async () => { const receipt = await credentials.resumeCredentialWorkflow(token); if (receipt.role === 'recovery') { await refresh() } else { setStatus('Online password change confirmed. Verify your new password to repair local unlocking.') } })}>Check pending change</button><button disabled={busy} onClick={() => { credentials.clearCredentialRetry(token); setStatus('Saved retry cleared. This does not undo a server change. Sign in again to establish access.') }}>Clear saved retry</button></div>}
      {repair && <form onSubmit={event => { event.preventDefault(); const input = event.currentTarget.elements.namedItem('password') as HTMLInputElement; const password = input.value; input.value = ''; run(async () => { await credentials.repairCredentialPassword(token, password); setStatus('New password verified. Local unlocking repaired.') }) }}><label>Verify new password<input aria-label="Verify new password" name="password" type="password" autoComplete="current-password" required/></label><button disabled={busy}>Repair local unlocking</button></form>}
      {metadata && <><form onSubmit={event => { event.preventDefault(); const name = String(new FormData(event.currentTarget).get('username')); run(async () => { await management.renameProfile(token, name, metadata.revision); await refresh(); setStatus('Public screen name changed.') }) }}><label>Public screen name<input aria-label="Public screen name" name="username" defaultValue={metadata.username} pattern="[a-z0-9_]{3,24}" required/></label><button disabled={busy}>Change screen name</button></form><form onSubmit={event => { event.preventDefault(); const email = String(new FormData(event.currentTarget).get('email')); run(async () => { await management.changeProfileEmail(token, email, metadata.revision); setStatus('Check your new email address. Your existing address stays in use until you confirm.') }) }}><label>New email<input aria-label="New email" name="email" type="email" required autoComplete="email"/></label><button disabled={busy}>Send email confirmation</button></form></>}
    </section>}
    <RecoveryPanel key={token?.generation ?? 'guest'} token={connected ? token : undefined} missing={metadata?.recoveryRevision == null} code={code} busy={busy || !!pending || repair} onDismiss={() => { if (token) credentials.dismissCredentialDisplay(token) }} onCreate={() => { if (token) run(async () => { await credentials.createCredentialRecovery(token); await refresh(); setStatus('Recovery code ready. Choose Download recovery code to save it privately.') }) }} onRecover={(email, code, remember) => execute(async () => accessed(await lifecycle.recoverProfile(email, code, remember)), true)}/>
    <DeviceApprovalPanel key={`devices-${token?.generation ?? 'guest'}`} token={connected ? token : undefined} busy={busy} run={work => run(work, !token)} onAccess={accessed}/>
    <DeletionPanel token={connected ? token : undefined} busy={busy}/>
    {!storage && onBackup && <button disabled={busy} onClick={() => void execute(onBackup, false, true)}>Account backup</button>}
    {storage ? <StoragePanel key={token!.generation} service={storage}/> : token && <p>Open the account workspace to review storage, export a backup or remove this device copy.</p>}
  </article>
}
