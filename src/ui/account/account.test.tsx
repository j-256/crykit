import { act } from 'react'
import * as profile from '../../account/profile'
import * as lifecycle from '../../account/lifecycle'
import * as management from '../../account/management'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AccountView } from './AccountView'
import { captureEmailCapability, clearEmailCapability } from '../../account/email-capability'
import { parseAppRoute, formatAppRoute } from '../navigation/routes'

vi.mock('../../account/device-store', () => ({ listCachedProfiles: async () => [] }))
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  window.history.replaceState(null, '', '#/settings/account')
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); clearEmailCapability(); profile.invalidateProfile(); vi.restoreAllMocks() })
const render = async () => { await act(async () => root.render(<AccountView onOpenWorkspace={async () => {}} onContinueLocal={async () => {}}/>)) }
const click = async (name: string) => { const button = [...container.querySelectorAll('button')].find(button => button.textContent === name)!; expect(button).toBeDefined(); await act(async () => button.click()) }
it('labelsPublicNameAndRecoveryLimitsPlainly', async () => {
  await render(); await click('Create account')
  expect(container.querySelector('input[aria-label="Public screen name"]')).not.toBeNull()
  expect(container.querySelector<HTMLInputElement>('input[name="remember"]')!.checked).toBe(false)
  expect(container.textContent).toContain('Your email cannot unlock your saved data.')
})
it('verificationLinkRequiresConfirmation', async () => {
  const capability = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  window.history.replaceState(null, '', '#/account/verify/' + capability)
  captureEmailCapability()
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
  await render()
  expect(window.location.hash).toBe('#/settings/account')
  expect(fetch).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Confirm email')
})
it('lostAllAccessDoesNotReplaceData', async () => {
  localStorage.setItem('synthetic-ciphertext', 'unchanged')
  await render(); await click('Lost access?')
  expect(container.textContent).toContain('Your email cannot unlock your saved data.')
  expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Start over')!.disabled).toBe(true)
  expect(localStorage.getItem('synthetic-ciphertext')).toBe('unchanged')
})
it('accountRouteRoundTripsWithoutCapabilities', () => {
  const route = parseAppRoute('#/settings/account')
  expect(route.page).toEqual({ page: 'settings', section: 'account' })
  expect(formatAppRoute(route)).toBe('#/settings/account')
})

it('skippedRecoveryRemainsVisible', async () => {
  const { RecoveryPanel } = await import('./RecoveryPanel')
  await act(async () => root.render(<RecoveryPanel token={{ accountId: 'synthetic', generation: 1 }} busy={false} onCreate={() => {}} onRecover={async () => {}}/>))
  await click('Skip for now')
  expect(container.textContent).toContain('Recovery setup skipped. You still need a recovery code.')
  expect([...container.querySelectorAll('button')].some(button => button.textContent === 'Download recovery code')).toBe(true)
})
it('focusesValidationAndPreservesPasswordWhitespace', async () => {
  const { SignInForm } = await import('./SignInForm')
  const submit = vi.fn(async () => {})
  await act(async () => root.render(<SignInForm busy={false} onSubmit={submit}/>))
  const form = container.querySelector('form')!
  const email = container.querySelector<HTMLInputElement>('input[name="email"]')!
  const password = container.querySelector<HTMLInputElement>('input[name="password"]')!
  email.value = 'synthetic@example.org'; password.value = 'short'
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await new Promise(resolve => setTimeout(resolve, 30)) })
  expect(document.activeElement?.getAttribute('role')).toBe('alert')
  expect(submit).not.toHaveBeenCalled()
  password.value = ' e\u0301 synthetic password '
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ password: ' e\u0301 synthetic password ', remember: false }), false)
  expect(password.value).toBe('')
})
it('loads account details once when sign-in installs a new profile', async () => {
  profile.invalidateProfile()
  const metadata = vi.spyOn(management, 'readAccountView').mockResolvedValue({ username: 'synthetic', email: 'synthetic@example.org', revision: 1, recoveryRevision: null, expiresAt: Date.now() + 10000, access: 'active' })
  vi.spyOn(lifecycle, 'signInProfile').mockImplementation(async () => profile.installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32), { accountId: 'AAAAAAAAAAAAAAAAAAAAAA', username: 'synthetic', sessionId: 'session', deviceId: 'device', csrf: 'secret', authenticatedAt: 1 }))
  vi.spyOn(lifecycle, 'reconcilePendingRevocations').mockResolvedValue({ revocationPending: false })
  await render()
  const form = container.querySelector('form')!
  container.querySelector<HTMLInputElement>('input[name="email"]')!.value = 'synthetic@example.org'
  container.querySelector<HTMLInputElement>('input[name="password"]')!.value = 'synthetic account password'
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  expect(container.textContent).toContain('Signed in as synthetic')
  expect(metadata).toHaveBeenCalledTimes(1)
})
it('discardsLateFailureAfterLock', async () => {
  const profile = await import('../../account/profile')
  const lifecycle = await import('../../account/lifecycle')
  const management = await import('../../account/management')
  const token = profile.installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32), { accountId: 'AAAAAAAAAAAAAAAAAAAAAA', username: 'synthetic', sessionId: 'session', deviceId: 'device', csrf: 'secret', authenticatedAt: 1 })
  vi.spyOn(management, 'readAccountView').mockResolvedValue({ username: 'synthetic', email: 'synthetic@example.org', revision: 1, recoveryRevision: null, expiresAt: Date.now() + 10000, access: 'active' })
  let reject!: (error: Error) => void
  vi.spyOn(lifecycle, 'renewProfile').mockImplementation(() => new Promise((_resolve, failure) => { reject = failure }))
  await render()
  await click('Renew session')
  await act(async () => profile.invalidateProfile())
  await act(async () => reject(new Error('SERVICE_UNAVAILABLE')))
  expect(container.textContent).not.toContain('This service or email delivery is unavailable.')
  expect(() => profile.assertActiveProfile(token)).toThrow()
})
it('cancelsLateApprovalStartAfterPanelUnmount', async () => {
  const { DeviceApprovalPanel } = await import('./DeviceApprovalPanel')
  const lifecycle = await import('../../account/lifecycle')
  let finish!: (value: import('../../account/lifecycle').ApprovalView) => void
  const pending = new Promise<import('../../account/lifecycle').ApprovalView>(resolve => { finish = resolve })
  vi.spyOn(lifecycle, 'startAccountDeviceApproval').mockReturnValue(pending)
  vi.spyOn(lifecycle, 'waitForAccountDeviceApproval').mockResolvedValue()
  const cancel = vi.spyOn(lifecycle, 'cancelAccountDeviceApproval').mockImplementation(() => {})
  let work: Promise<void> | undefined
  await act(async () => root.render(<DeviceApprovalPanel busy={false} run={action => { work = action() }} onAccess={async () => {}}/>))
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await act(async () => root.render(<p>Other screen</p>))
  const view = { handle: { id: 'synthetic' }, requestId: 'synthetic', fingerprint: '0000 0000 0000 0000', expiresAt: Date.now() + 10000 }
  await act(async () => { finish(view); await work })
  expect(cancel).toHaveBeenCalledWith(view.handle)
})
it('emailUnavailableKeepsLocalContinuationAndRetryVisible', async () => {
  const auth = await import('../../account/auth-client')
  vi.spyOn(auth, 'registerAccount').mockRejectedValue(new Error('SERVICE_UNAVAILABLE'))
  await render(); await click('Create account')
  container.querySelector<HTMLInputElement>('input[name="email"]')!.value = 'synthetic@example.org'
  container.querySelector<HTMLInputElement>('input[name="username"]')!.value = 'synthetic'
  container.querySelector<HTMLInputElement>('input[name="password"]')!.value = 'synthetic valid password'
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(container.textContent).toContain('This service or email delivery is unavailable.')
  expect(document.activeElement?.getAttribute('role')).toBe('alert')
  expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Continue using this device')?.disabled).toBe(false)
  expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Create account and send email')?.disabled).toBe(false)
})
it('expiredVerificationKeepsExplicitRetryAndDiscard', async () => {
  const email = await import('../../account/email-capability')
  window.history.replaceState(null, '', '#/account/verify/' + 'A'.repeat(43)); captureEmailCapability()
  vi.spyOn(email, 'confirmPendingEmail').mockRejectedValue(new Error('INVALID_REQUEST'))
  await render(); await click('Confirm email')
  expect(container.textContent).toContain('This request is invalid or expired.')
  expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Confirm email')?.disabled).toBe(false)
  await click('Discard link')
  expect(email.emailConfirmationKind()).toBeUndefined()
})
it('newLockActionDiscardsAnOlderSignInFailure', async () => {
  const profile = await import('../../account/profile')
  const lifecycle = await import('../../account/lifecycle')
  profile.installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32))
  let reject!: (error: Error) => void
  vi.spyOn(lifecycle, 'signInProfile').mockImplementation(() => new Promise((_resolve, failure) => { reject = failure }))
  await render()
  container.querySelector<HTMLInputElement>('input[name="email"]')!.value = 'synthetic@example.org'
  container.querySelector<HTMLInputElement>('input[name="password"]')!.value = 'synthetic valid password'
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await click('Lock')
  await act(async () => reject(new Error('AUTH_FAILED')))
  expect(container.textContent).not.toContain('Sign-in failed.')
})

function connectedProfile() {
  const token = profile.installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32).fill(7), { accountId: 'AAAAAAAAAAAAAAAAAAAAAA', username: 'synthetic', sessionId: 'session', deviceId: 'device', csrf: 'secret', authenticatedAt: 1 })
  vi.spyOn(management, 'readAccountView').mockResolvedValue({ username: 'synthetic', email: 'synthetic@example.org', revision: 1, recoveryRevision: null, expiresAt: Date.now() + 10000, access: 'active' })
  return token
}
const leaveAccount = async () => { await act(async () => root.render(<p>Other destination</p>)) }
async function submitPassword(label: string, password: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  input.value = password
  await act(async () => input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}
it('pendingPasswordSurvivesNavigationAndResumesOriginalTransaction', async () => {
  const token = connectedProfile()
  let transaction = ''
  vi.spyOn(lifecycle, 'changeProfilePassword').mockImplementation(async (_token, _password, id) => { transaction = id; throw Object.assign(new Error('CREDENTIAL_CHANGE_UNCONFIRMED'), { transactionId: id }) })
  const resume = vi.spyOn(lifecycle, 'resumeProfileCredentialChange').mockResolvedValue({ role: 'password' })
  await render(); await submitPassword('New password', 'original synthetic password')
  await leaveAccount(); await render()
  expect(container.textContent).toContain('Check pending change')
  expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Change password')!.disabled).toBe(true)
  expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Download recovery code')!.disabled).toBe(true)
  container.querySelector<HTMLInputElement>('input[aria-label="New password"]')!.value = 'different synthetic password'
  await click('Check pending change')
  expect(resume).toHaveBeenCalledWith(token, transaction)
  expect(container.textContent).toContain('Verify new password')
  await leaveAccount(); await render()
  expect(container.textContent).toContain('Local unlocking still needs repair')
  await click('Lock'); await render()
  expect(container.textContent).not.toContain('Verify new password')
})
it('confirmedPasswordLocalFailureSurvivesNavigationAndRepair', async () => {
  connectedProfile()
  vi.spyOn(lifecycle, 'changeProfilePassword').mockRejectedValue(new Error('OFFLINE_PASSWORD_UPDATE_FAILED'))
  vi.spyOn(management, 'repairOfflinePassword').mockResolvedValue()
  await render(); await submitPassword('New password', 'original synthetic password')
  await leaveAccount(); await render()
  expect(container.textContent).toContain('Local unlocking still needs repair')
  expect(container.querySelector('input[aria-label="Verify new password"]')).not.toBeNull()
  await submitPassword('Verify new password', 'original synthetic password')
  await leaveAccount(); await render()
  expect(container.querySelector('input[aria-label="Verify new password"]')).toBeNull()
})
it('recoveryPendingCompletionWhileAwaySurvivesRemount', async () => {
  connectedProfile()
  let reject!: (error: Error) => void
  vi.spyOn(management, 'createProfileRecovery').mockImplementation((_token, id) => new Promise((_resolve, failure) => { reject = error => failure(Object.assign(error, { transactionId: id })) }))
  vi.spyOn(lifecycle, 'resumeProfileCredentialChange').mockResolvedValue({ role: 'recovery', display: 'synthetic recovery display' })
  await render(); await click('Download recovery code')
  await leaveAccount(); await render()
  expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Change password')!.disabled).toBe(true)
  await leaveAccount()
  await act(async () => reject(new Error('CREDENTIAL_CHANGE_UNCONFIRMED')))
  await render(); await click('Check pending change')
  expect(container.textContent).toContain('synthetic recovery display')
  await leaveAccount(); await render()
  expect(container.textContent).toContain('synthetic recovery display')
  await click('Lock')
  expect(container.textContent).not.toContain('synthetic recovery display')
})
it.each(['AUTH_REQUIRED', 'CSRF_FAILED'])('remountPublishesDisconnectedMetadataFailure %s', async reason => {
  const token = connectedProfile()
  await render(); await leaveAccount()
  vi.mocked(management.readAccountView).mockImplementation(async () => { profile.setProfileSession(token); throw new Error(reason) })
  await render()
  expect(container.textContent).toContain('Online access disconnected.')
  expect(container.querySelector('[role="alert"]')).not.toBeNull()
  expect(container.textContent).not.toContain('Online access connected.')
  expect(await profile.withAccountKey(token, async key => key[0])).toBe(7)
})

it('expiredPendingCommandStaysVisibleUntilExplicitDiscard', async () => {
  connectedProfile()
  vi.spyOn(lifecycle, 'changeProfilePassword').mockRejectedValue(Object.assign(new Error('CREDENTIAL_CHANGE_UNCONFIRMED'), { transactionId: 'saved-id' }))
  vi.spyOn(lifecycle, 'resumeProfileCredentialChange').mockRejectedValue(new Error('CREDENTIAL_CHANGE_NOT_PENDING'))
  await render(); await submitPassword('New password', 'original synthetic password')
  await leaveAccount(); await render(); await click('Check pending change')
  expect(container.textContent).toContain('The saved change expired or was cleared.')
  expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Change password')!.disabled).toBe(true)
  await click('Clear saved retry')
  expect(container.textContent).toContain('This does not undo a server change.')
  await leaveAccount(); await render()
  expect(container.textContent).not.toContain('Check pending change')
})
it('oldCredentialCompletionCannotRepopulateSuccessorWorkflow', async () => {
  connectedProfile()
  let finish!: (display: string) => void
  vi.spyOn(management, 'createProfileRecovery').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await render(); await click('Download recovery code'); await leaveAccount()
  profile.invalidateProfile(); connectedProfile()
  await act(async () => finish('obsolete recovery display'))
  await render()
  expect(container.textContent).not.toContain('obsolete recovery display')
  expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Change password')!.disabled).toBe(false)
})
it('remountMetadataUnavailableIsVisibleAndRetryable', async () => {
  connectedProfile(); await render(); await leaveAccount()
  vi.mocked(management.readAccountView).mockRejectedValue(new Error('SERVICE_UNAVAILABLE'))
  await render()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('This service or email delivery is unavailable.')
  expect([...container.querySelectorAll('button')].find(button => button.textContent === 'Reconnect')!.disabled).toBe(false)
})
it('profile-transition unmount does not cancel the sign-out revocation epoch', async () => {
  profile.installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32))
  let finish!: () => void
  let completed = false
  vi.spyOn(lifecycle, 'signOutProfile').mockImplementation(async () => {
    profile.invalidateProfile()
    const epoch = profile.captureProfileEpoch()
    await new Promise<void>(resolve => { finish = resolve })
    epoch.assertCurrent()
    completed = true
    return { revocationPending: true }
  })
  await render()
  await click('Sign out')
  await act(async () => root.render(<p>Account locked</p>))
  await act(async () => finish())
  expect(completed).toBe(true)
})
it('later abandoned sign-in cancels its epoch even after an earlier view transition', async () => {
  profile.installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32))
  await render(); await click('Lock')
  let epoch!: ReturnType<typeof profile.captureProfileEpoch>
  let finish!: () => void
  vi.spyOn(lifecycle, 'signInProfile').mockImplementation(async () => {
    profile.invalidateProfile()
    epoch = profile.captureProfileEpoch()
    await new Promise<void>(resolve => { finish = resolve })
    epoch.assertCurrent()
    return profile.installProfile('AAAAAAAAAAAAAAAAAAAAAA', new Uint8Array(32))
  })
  container.querySelector<HTMLInputElement>('input[name="email"]')!.value = 'synthetic@example.org'
  container.querySelector<HTMLInputElement>('input[name="password"]')!.value = 'synthetic long password'
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await act(async () => root.render(<p>Other screen</p>))
  expect(epoch.signal.aborted).toBe(true)
  await act(async () => finish())
  expect(profile.currentProfileToken()).toBeUndefined()
})

it('surfacesLocalBackupFailureWithoutRequiringOnlineAccess', async () => {
  const backup = vi.fn(async () => { throw new Error('Finish the open form before exporting.') })
  await act(async () => root.render(<AccountView onOpenWorkspace={async () => {}} onContinueLocal={async () => {}} onBackup={backup}/>))
  await click('Account backup')
  expect(backup).toHaveBeenCalledOnce()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Finish the open form before exporting.')
  expect(container.querySelector('[role="alert"]')?.textContent).not.toContain('when connected')
})
