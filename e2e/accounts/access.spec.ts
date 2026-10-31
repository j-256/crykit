import { expectPrimedSignInRateLimit, nativeCredentialQuota, prepareAccountProofCache } from './network-fixture'
import { readCompleteBackup } from '../workspace-backup'
import { formatAppRoute } from '../../src/ui/navigation/routes'
import { BUILDS_ROUTE } from '../../src/ui/navigation/types'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { expect, test } from './test-fixture'
import type { UnlockResult } from '../../src/account/auth-client'
import { expectLoadingMotion, holdWorkspaceSelection, loadingScreen } from '../startup-helpers'
import { WORKSPACE_STARTUP_MARK } from '../../src/diagnostics/workspace-startup'
import { startStartupResources } from './startup-resources'
import { errors } from '@playwright/test'

// Reset only between independent synthetic journeys; every case keeps the real limiter
const CROSS_ACCOUNT_CONTINUATION = 'continues captured account switch through logout and queued rejection'
const CROSS_ACCOUNT_RECOVERY = 'recovers the same switched account after a crash without changing guest data'
test.beforeEach(async ({ request }, testInfo) => {
  if ([CROSS_ACCOUNT_CONTINUATION, CROSS_ACCOUNT_RECOVERY].includes(testInfo.title)) return
  expect((await request.post('/__accounts/control/reset-rate-counters', { data: {} })).ok()).toBe(true)
})

interface Auth {
  changePassword(unlocked: UnlockResult, password: string, transactionId: string): Promise<void>
  replaceRecoveryCode(unlocked: UnlockResult, transactionId: string): Promise<string>
  loginWithRecovery(email: string, code: string, remember: boolean): Promise<UnlockResult>
  registerAccount(input: { email: string; username: string; password: string; remember: boolean }): Promise<{ transactionId: string; pending: true }>
  loginAccount(input: { email: string; password: string; remember: boolean }): Promise<UnlockResult>
}
test('capturedEmailActivatesRealOpaqueAndSecureHttpOnlyCustomerCookie', async ({ page, context, browser, baseURL }, testInfo) => {
  const username = `synthetic_${Date.now().toString(36)}`
  const email = `${username}@example.org`
  const password = ' e\u0301 synthetic browser password '
  const bodies: string[] = []
  page.on('request', request => { if (request.url().includes('/api/v1/auth/') && !request.url().endsWith('/verify')) bodies.push(request.postData() ?? '') })
  await page.goto('/__accounts-proof/')
  await prepareAccountProofCache(page)
  await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
  const pending = await page.evaluate(async input => (window as unknown as { accountAuth: Auth }).accountAuth.registerAccount(input), { email, username, password, remember: false })
  expect(pending.pending).toBe(true)
  expect(await context.cookies()).toEqual([])
  await page.request.post('/__accounts/jobs')
  const emails = await (await page.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
  const capability = emails.find(message => message.recipient === email)!.capability
  const verified = await page.evaluate(async capability => {
    const response = await fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) })
    return { status: response.status, value: await response.json() }
  }, capability)
  expect(verified).toEqual({ status: 200, value: { verified: true } })
  expect(await context.cookies()).toEqual([])
  const unlocked = await page.evaluate(async input => {
    const result = await (window as unknown as { accountAuth: Auth }).accountAuth.loginAccount(input)
    return { ...result, key: Array.from(result.key) }
  }, { email, password, remember: false })
  const cookies = await context.cookies()
  expect(cookies).toHaveLength(1)
  expect(cookies[0]).toMatchObject({ name: '__Host-crykit-session', httpOnly: true, secure: true, sameSite: 'Lax', path: '/', expires: -1 })
  expect(await page.evaluate(() => document.cookie)).not.toContain('__Host-crykit-session')
  expect(await page.evaluate(async () => (await fetch('/api/v1/account')).status)).toBe(200)
  const second = await browser.newContext({ ignoreHTTPSErrors: baseURL?.startsWith('https:') })
  try {
    const other = await second.newPage()
    await other.goto(`${baseURL}/__accounts-proof/`)
    // This independent context owns a cold cache, just like the first browser
    await prepareAccountProofCache(other)
    await expect(other.locator('#status')).toHaveText('Browser worker and offline cache ready')
    const key = await other.evaluate(async input => Array.from((await (window as unknown as { accountAuth: Auth }).accountAuth.loginAccount(input)).key), { email, password, remember: true })
    expect(key).toEqual(unlocked.key)
    expect((await second.cookies())[0].expires).toBeGreaterThan(Date.now() / 1000)
  } finally { await second.close() }
  expect(JSON.stringify(bodies)).not.toContain(password)
  expect(JSON.stringify(bodies)).not.toContain(JSON.stringify(unlocked.key))
  const renewed = await page.evaluate(async csrf => {
    const response = await fetch('/api/v1/auth/renew', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: '{}' })
    return { status: response.status, body: await response.json() }
  }, unlocked.csrf)
  expect(renewed.status).toBe(200)
  expect((await context.cookies())[0].value).not.toBe(cookies[0].value)
  const evidence = JSON.stringify({ origin: baseURL, signupPending: true, verifiedWithoutSession: true, opaqueUnlock: true, independentContextSameKey: true, cookie: { name: cookies[0].name, httpOnly: cookies[0].httpOnly, secure: cookies[0].secure, sameSite: cookies[0].sameSite, path: cookies[0].path }, authenticatedAccountStatus: 200, renewedStatus: renewed.status })
  await writeFile(testInfo.outputPath('customer-cookie-evidence.json'), evidence)
  await testInfo.attach('customer-cookie-evidence', { body: evidence, contentType: 'application/json' })
})

test('browserCredentialInterruptionsPreserveKeyAndReconcileRecovery', async ({ page }, testInfo) => {
  const username = `recovery_${Date.now().toString(36)}`
  const email = `${username}@example.org`, password = 'synthetic original browser password', replacement = 'synthetic replacement browser password'
  const requests: { path: string; body: string }[] = []
  page.on('request', request => { if (request.url().includes('/api/v1/')) requests.push({ path: new URL(request.url()).pathname, body: request.postData() ?? '' }) })
  await page.goto('/__accounts-proof/')
  await prepareAccountProofCache(page)
  await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
  await page.evaluate(async input => (window as unknown as { accountAuth: Auth }).accountAuth.registerAccount(input), { email, username, password, remember: false })
  await page.request.post('/__accounts/jobs')
  const emails = await (await page.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
  await page.evaluate(async capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find(message => message.recipient === email)!.capability)
  const before = await page.evaluate(async input => {
    const w = window as unknown as { accountAuth: Auth; unlocked: UnlockResult }
    w.unlocked = await w.accountAuth.loginAccount(input)
    return Array.from(w.unlocked.key)
  }, { email, password, remember: false })
  await page.request.post('/__accounts/control/faults', { data: ['auth.credentials.before-batch'] })
  const interruption = await page.evaluate(async replacement => {
    const w = window as unknown as { accountAuth: Auth; unlocked: UnlockResult }
    const id = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    try { await w.accountAuth.changePassword(w.unlocked, replacement, id()); return 'unexpected success' } catch (error) { return (error as Error).message }
  }, replacement)
  expect(interruption).toBe('CREDENTIAL_CHANGE_UNCONFIRMED')
  const afterFailure = await page.evaluate(async input => {
    const w = window as unknown as { accountAuth: Auth; unlocked: UnlockResult }
    w.unlocked = await w.accountAuth.loginAccount(input)
    return Array.from(w.unlocked.key)
  }, { email, password, remember: false })
  expect(afterFailure).toEqual(before)
  let dropped = false
  await page.route('**/api/v1/account/credentials/commit', async route => {
    if (dropped) { await route.continue(); return }
    dropped = true
    expect((await route.fetch()).status()).toBe(200)
    await route.abort('failed')
  })
  await page.evaluate(async replacement => {
    const w = window as unknown as { accountAuth: Auth; unlocked: UnlockResult }
    const transactionId = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    await w.accountAuth.changePassword(w.unlocked, replacement, transactionId)
  }, replacement)
  await page.unroute('**/api/v1/account/credentials/commit')
  const afterSuccess = await page.evaluate(async input => {
    const w = window as unknown as { accountAuth: Auth; unlocked: UnlockResult }
    w.unlocked = await w.accountAuth.loginAccount(input)
    return Array.from(w.unlocked.key)
  }, { email, password: replacement, remember: false })
  expect(afterSuccess).toEqual(before)
  const recovery = await page.evaluate(async email => {
    const w = window as unknown as { accountAuth: Auth; unlocked: UnlockResult }
    const id = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const code = await w.accountAuth.replaceRecoveryCode(w.unlocked, id())
    w.unlocked = await w.accountAuth.loginWithRecovery(email, code, false)
    const key = Array.from(w.unlocked.key)
    const next = await w.accountAuth.replaceRecoveryCode(w.unlocked, id())
    let oldRejected = false
    try { await w.accountAuth.loginWithRecovery(email, code, false) } catch { oldRejected = true }
    w.unlocked = await w.accountAuth.loginWithRecovery(email, next, false)
    return { key, nextKey: Array.from(w.unlocked.key), oldRejected, code, next }
  }, email)
  expect(recovery.key).toEqual(before)
  expect(recovery.nextKey).toEqual(before)
  expect(recovery.oldRejected).toBe(true)
  const requestsText = JSON.stringify(requests)
  for (const secret of [password, replacement, recovery.code, recovery.next]) expect(requestsText).not.toContain(secret)
  expect(requests.filter(request => /upload|commit/.test(request.path) && !request.path.endsWith('/credentials/commit'))).toEqual([])
  const evidence = JSON.stringify({ failedActivationPreservedPasswordAndKey: true, lostResponseReconciled: dropped, newPasswordSameKey: true, recoverySameKey: true, replacedRecoveryRejected: recovery.oldRejected, privatePayloadUploads: 0 })
  await writeFile(testInfo.outputPath('credential-interruption-evidence.json'), evidence)
  await testInfo.attach('credential-interruption-evidence', { body: evidence, contentType: 'application/json' })
})

interface UiProof {
  inspect(): Promise<{ token?: { accountId: string; generation: number }; principal?: string; session?: string; digest?: string; access?: string }>
  cached(): Promise<{ accountId: string; revocationPending: boolean }[]>
}
const uiPath = '/__accounts-proof/account-ui'
test('explainsARealRateLimitAndKeepsContactAndLocalEditingAvailable', async ({ page, request, baseURL }, testInfo) => {
  const password = 'synthetic rate limit browser password'
  // Invalid JSON reaches native credential admission without registering an account or sending customer email
  const primingWindow = Math.floor(Date.now() / nativeCredentialQuota.periodMs)
  for (let attempt = 0; attempt < nativeCredentialQuota.requests; attempt++) {
    const response = await request.post('/api/v1/auth/login/start', { data: {}, headers: { origin: baseURL! } })
    expect(response.status()).toBe(400)
  }
  // Start with the planner so account management retains the full shell and its settings dialog
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'New Build', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Account', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible()
  await page.getByLabel('Email', { exact: true }).fill('synthetic@example.org')
  await page.getByLabel('Password', { exact: true }).fill(password)
  const { noticeDeadline } = await expectPrimedSignInRateLimit(page, request, baseURL!, primingWindow, password)
  const notice = page.getByRole('alert').filter({ hasText: 'Requests temporarily limited' })
  // The HTTP response proof and rendering retain the original shared notice deadline
  await expect(notice).toBeVisible({ timeout: Math.max(1, noticeDeadline - performance.now()) })
  await expect(page.getByRole('alert')).toHaveCount(1)
  await expect(notice).toContainText('keep editing on this device')
  await expect(notice.locator('time')).toHaveAttribute('datetime', /\d{4}-\d{2}-\d{2}T/)
  const contact = notice.getByRole('link', { name: 'Contact us' })
  const href = await contact.getAttribute('href')
  expect(href).toContain('mailto:abuse@crykit.lasers.app')
  expect(new URL(href!).searchParams.get('body')).toMatch(/Reference: [a-z0-9-]+/)
  expect(href).not.toContain('synthetic%40example.org')
  expect(href).not.toContain('password')
  await contact.focus()
  await expect(contact).toBeFocused()
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    // CryKit deliberately uses a fixed dark palette under either system appearance preference
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark')
    await page.setViewportSize({ width: theme === 'light' ? 1280 : 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`rate-limit-${theme}.png`), fullPage: true })
  }
  // Opening navigation keeps the pending account scope; changing destination intentionally clears it
  await page.getByRole('button', { name: 'More destinations', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('link', { name: 'Contact us' })).toBeVisible()
  await dialog.getByRole('link', { name: 'Contact us' }).focus()
  await expect(dialog.getByRole('link', { name: 'Contact us' })).toBeFocused()
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Continue using this device' }).click()
  await expect.poll(() => new URL(page.url()).hash).toBe(formatAppRoute(BUILDS_ROUTE))
  await expect(page.getByRole('button', { name: 'New Build', exact: true })).toBeEnabled()
})
// Allow the real five-second status poll plus browser scheduling and rendering
const approvalPollJourneyMs = 10_000
const uiPassword = 'synthetic account UI password'
async function uiSignup(page: import('@playwright/test').Page, path = uiPath) {
  const username = `ui_${crypto.randomUUID().replaceAll('-', '').slice(0, 15)}`
  const email = `${username}@example.org`
  await page.goto(path)
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Public screen name', { exact: true }).fill(username)
  await page.getByLabel('Password', { exact: true }).fill(uiPassword)
  await expect(page.getByLabel('Remember this device').first()).not.toBeChecked()
  await page.getByRole('button', { name: 'Create account and send email' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await page.request.post('/__accounts/jobs')
  const emails = await (await page.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
  const capability = emails.find(message => message.recipient === email)!.capability
  let verifies = 0
  page.on('request', request => { if (request.url().endsWith('/auth/verify')) verifies++ })
  await page.goto(`${path.split('#')[0]}#/account/verify/${capability}`)
  await expect(page.getByRole('heading', { name: 'Confirm email' })).toBeVisible()
  expect(new URL(page.url()).hash).toBe('#/settings/account')
  expect(verifies).toBe(0)
  await page.getByRole('button', { name: 'Confirm email', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Email confirmed. You can sign in.')
  const back = page.getByRole('button', { name: 'Back to sign in' })
  if (await back.count()) await back.click()
  return { email, username }
}
async function uiSignin(page: import('@playwright/test').Page, email: string, username: string) {
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(uiPassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: `Signed in as ${username}` })).toBeVisible()
  return page.evaluate(() => (window as unknown as { accountUiProof: UiProof }).accountUiProof.inspect())
}

// Planner remount and guest preservation proofs need an explicitly opened guest workspace
// A cold Account entry intentionally leaves both the guest database and planner navigation unopened
async function openAccountSettingsInMountedPlanner(page: import('@playwright/test').Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'New Build', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Account', exact: true }).first().click()
}

test('accountScreensVerifySignInRecoverAndContinueLocally', async ({ page }, testInfo) => {
  const account = await uiSignup(page)
  const signed = await uiSignin(page, account.email, account.username)
  expect(signed.token?.accountId).toBe(signed.principal)
  await page.getByRole('button', { name: 'Skip for now', exact: true }).click()
  await expect(page.getByText('Recovery setup skipped. You still need a recovery code.')).toBeVisible()
  await page.getByRole('button', { name: 'Download recovery code', exact: true }).click()
  await expect(page.getByText('Recovery code ready. Choose Download recovery code to save it privately.')).toBeVisible()
  const code = await page.locator('.account-code').first().textContent()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download recovery code', exact: true }).click()
  expect((await download).suggestedFilename()).toBe('crykit-recovery-code.txt')
  await page.getByRole('button', { name: 'Lock', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  await page.getByLabel('Recovery email').fill(account.email)
  await page.getByLabel('Recovery code', { exact: true }).fill(code!)
  await page.getByRole('button', { name: 'Use recovery code' }).click()
  await expect(page.getByRole('heading', { name: `Signed in as ${account.username}` })).toBeVisible()
  const recovered = await page.evaluate(() => (window as unknown as { accountUiProof: UiProof }).accountUiProof.inspect())
  expect(recovered.digest).toBe(signed.digest)
  await page.getByRole('button', { name: 'Refresh devices and approvals' }).click()
  await expect(page.getByText('Removing a device stops its online access.', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove this device', exact: true })).toHaveCount(1)
  await page.setViewportSize({ width: 375, height: 812 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('account-narrow.png'), fullPage: true })
  await page.getByRole('button', { name: 'Continue using this device' }).click()
  await expect(page.getByText('Local continuation selected')).toBeVisible()
})

test('actualScreensKeepDistinctAccountKeysAlignedDuringRenewalAndPreserveForeignPendingRevocation', async ({ page, context }, testInfo) => {
  const firstAccount = await uiSignup(page)
  const first = await uiSignin(page, firstAccount.email, firstAccount.username)
  const other = await context.newPage()
  const secondAccount = await uiSignup(other)
  await page.request.post('/__accounts/control/response-gate', { data: { path: '/api/v1/auth/renew', phase: 'body' } })
  await page.getByRole('button', { name: 'Renew session' }).click()
  await expect.poll(async () => (await (await page.request.get('/__accounts/control/response-gate')).json()).arrived).toBe(true)
  await other.getByLabel('Email', { exact: true }).fill(secondAccount.email)
  await other.getByLabel('Password', { exact: true }).fill(uiPassword)
  await other.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect.poll(async () => other.evaluate(async () => (await navigator.locks.query()).pending?.some(lock => lock.name === 'crykit-account-session-v1'))).toBe(true)
  await page.request.post('/__accounts/control/release-response')
  await expect(other.getByRole('heading', { name: `Signed in as ${secondAccount.username}` })).toBeVisible()
  const second = await other.evaluate(() => (window as unknown as { accountUiProof: UiProof }).accountUiProof.inspect())
  expect(second.token?.accountId).toBe(second.principal)
  expect(second.principal).not.toBe(first.principal)
  expect(second.digest).not.toBe(first.digest)
  // Renewal releases its session lock before refreshing metadata, so the foreign sign-in can
  // disconnect this tab automatically and remove its online controls before the manual refresh
  const refreshDevices = page.getByRole('button', { name: 'Refresh devices and approvals' })
  const optionalRefreshTimeoutMs = 1_000
  if (await refreshDevices.isVisible()) {
    try { await refreshDevices.click({ timeout: optionalRefreshTimeoutMs }) }
    catch (reason) {
      if (!(reason instanceof errors.TimeoutError)) throw reason
      await expect(page.getByRole('alert')).toContainText('Online access expired.')
    }
  }
  await expect(page.getByRole('alert')).toContainText('Online access expired.')
  const disconnected = await page.evaluate(() => (window as unknown as { accountUiProof: UiProof }).accountUiProof.inspect())
  expect(disconnected.access).toBe('disconnected')
  expect(disconnected.digest).toBe(first.digest)
  await expect(page.getByRole('heading', { name: `Signed in as ${secondAccount.username}` })).toHaveCount(0)
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByText('Signed out locally. Online revocation is pending; sign in to this account to retry.')).toBeVisible()
  await other.getByRole('button', { name: 'Retry pending sign-out' }).click()
  await expect(other.getByText('Earlier sign-outs reconciled for this account.')).toBeVisible()
  const pending = await other.evaluate(() => (window as unknown as { accountUiProof: UiProof }).accountUiProof.cached())
  expect(pending.find(row => row.accountId === first.principal)?.revocationPending).toBe(true)
  expect((await other.evaluate(() => (window as unknown as { accountUiProof: UiProof }).accountUiProof.inspect())).principal).toBe(second.principal)
  await testInfo.attach('distinct-account-ui-alignment', { body: JSON.stringify({ distinctAccounts: true, distinctKeys: true, successorTokenCookieKeyAligned: true, foreignRevocationPreserved: true }), contentType: 'application/json' })
})

test('normalAppAccountRouteSupportsKeyboardErrorsAndLocalGuestContinuation', async ({ page }, testInfo) => {
  let authRequests = 0
  page.on('request', request => { if (request.url().includes('/api/v1/')) authRequests++ })
  await page.goto('/#/settings/account')
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible()
  await page.getByLabel('Email', { exact: true }).fill('synthetic@example.org')
  await page.getByLabel('Password', { exact: true }).fill('short')
  await page.getByRole('button', { name: 'Sign in', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('alert').filter({ hasText: 'Use at least 15 characters' })).toBeFocused()
  expect(authRequests).toBe(0)
  await page.screenshot({ path: testInfo.outputPath('account-desktop.png'), fullPage: true })
  await page.getByRole('button', { name: 'Continue using this device' }).click()
  await expect.poll(() => new URL(page.url()).hash).toBe(formatAppRoute(BUILDS_ROUTE))
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByRole('button', { name: 'More destinations' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Account', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('account-app-narrow.png'), fullPage: true })
  expect(authRequests).toBe(0)
})

test('screenCredentialResumeConfirmsOriginalCommandAndSeparatesLocalWriteFailure', async ({ page }) => {
  const account = await uiSignup(page)
  await openAccountSettingsInMountedPlanner(page)
  await page.getByLabel('Email', { exact: true }).fill(account.email)
  await page.getByLabel('Password', { exact: true }).fill(uiPassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: `Signed in as ${account.username}` })).toBeVisible()
  const remount = async () => {
    await page.getByRole('button', { name: 'Builds', exact: true }).first().click()
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Account', exact: true }).first().click()
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible()
  }
  const replacement = 'synthetic confirmed replacement password'
  await page.route('**/api/v1/account/credentials/commit', route => route.abort('failed'))
  await page.route('**/api/v1/account/transactions/*', route => route.abort('failed'))
  await page.getByLabel('New password', { exact: true }).fill(replacement)
  await page.getByRole('button', { name: 'Change password', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Check pending change' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('not confirmed')
  await remount()
  await expect(page.getByRole('button', { name: 'Check pending change' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Change password', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Download recovery code' })).toBeDisabled()
  await page.unroute('**/api/v1/account/credentials/commit')
  await page.unroute('**/api/v1/account/transactions/*')
  await page.getByLabel('New password', { exact: true }).fill('different typed password must not be activated')
  await page.getByRole('button', { name: 'Check pending change' }).click()
  await expect(page.getByText('Online password change confirmed. Verify your new password to repair local unlocking.')).toBeVisible()
  await remount()
  await expect(page.getByLabel('Verify new password')).toBeVisible()
  await page.getByLabel('Verify new password').fill(replacement)
  await page.getByRole('button', { name: 'Repair local unlocking' }).click()
  await expect(page.getByText('New password verified. Local unlocking repaired.')).toBeVisible()
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'profiles') { IDBObjectStore.prototype.put = put; throw new DOMException('Synthetic write failure', 'QuotaExceededError') }
      return put.apply(this, args)
    }
  })
  const finalPassword = 'synthetic final browser password'
  await page.getByLabel('New password', { exact: true }).fill(finalPassword)
  await page.getByRole('button', { name: 'Change password', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Your online password changed. Local unlocking still needs repair.')
  await remount()
  await expect(page.getByText('Your online password changed. Local unlocking still needs repair. Verify your new password below.', { exact: true })).toBeVisible()
  await page.getByLabel('Verify new password').fill(finalPassword)
  await page.getByRole('button', { name: 'Repair local unlocking' }).click()
  await expect(page.getByText('New password verified. Local unlocking repaired.')).toBeVisible()
})

test('actualDeviceScreensRequireComparisonBeforeApproval', async ({ page, browser, baseURL }) => {
  const account = await uiSignup(page)
  await uiSignin(page, account.email, account.username)
  const requester = await browser.newContext({ baseURL, ignoreHTTPSErrors: baseURL?.startsWith('https:') })
  try {
    const other = await requester.newPage()
    await other.goto(uiPath)
    await other.getByLabel('Account email', { exact: true }).fill(account.email)
    await other.getByRole('button', { name: 'Request approval', exact: true }).click()
    await expect(other.getByText('Compare this code on both devices:', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Refresh devices and approvals' }).click()
    await expect(page.getByRole('button', { name: 'Approve device', exact: true })).toBeDisabled()
    await page.getByLabel('The codes match on both devices').check()
    await page.getByRole('button', { name: 'Approve device', exact: true }).click()
    await expect(other.getByRole('button', { name: 'Complete approval' })).toBeVisible({ timeout: approvalPollJourneyMs })
    await expect(other.getByLabel('Remember this device').last()).not.toBeChecked()
    await other.getByRole('button', { name: 'Complete approval' }).click()
    await expect(other.getByRole('heading', { name: `Signed in as ${account.username}` })).toBeVisible()
    const first = await page.evaluate(() => (window as unknown as { accountUiProof: UiProof }).accountUiProof.inspect())
    const second = await other.evaluate(() => (window as unknown as { accountUiProof: UiProof }).accountUiProof.inspect())
    expect(second.digest).toBe(first.digest)
    expect(second.token?.accountId).toBe(second.principal)
  } finally { await requester.close() }
})

async function databaseDump(page: import('@playwright/test').Page, name: string): Promise<string> {
  return page.evaluate(async name => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    try {
      return JSON.stringify(await Promise.all([...database.objectStoreNames].map(store => new Promise(resolve => { const request = database.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve([store, request.result]) }))))
    } finally { database.close() }
  }, name)
}

test('normalAppSignInOpensIndependentEncryptedWorkspaceAndLocksOnReload', async ({ page }, testInfo) => {
  const prefix = 'workspace-startup '
  const startup: { navigationId: string; phase: string; elapsedMilliseconds: number; observedMilliseconds: number; hostObservedMilliseconds: number; lastTimerDelayMilliseconds: number; visibility: string }[] = []
  page.on('console', message => { if (message.text().startsWith(prefix)) startup.push({ ...JSON.parse(message.text().slice(prefix.length)), hostObservedMilliseconds: Date.now() }) })
  await page.addInitScript(({ mark, prefix }) => {
    const navigationId = crypto.randomUUID()
    const intervalMilliseconds = 100
    let expected = performance.now() + intervalMilliseconds
    let lastTimerDelayMilliseconds = 0
    // Timer drift measures callback starvation, not CPU usage or the cause of a slow storage read
    // Emit only phase observations and large delays so a stalled page needs no diagnostic evaluation
    const observe = (phase: string, elapsedMilliseconds: number) => console.info(prefix + JSON.stringify({ navigationId, phase, elapsedMilliseconds, observedMilliseconds: performance.now(), lastTimerDelayMilliseconds, visibility: document.visibilityState }))
    setInterval(() => {
      const now = performance.now()
      lastTimerDelayMilliseconds = Math.max(0, now - expected)
      expected = now + intervalMilliseconds
      if (lastTimerDelayMilliseconds >= intervalMilliseconds * 2) observe('scheduler-delay', now)
    }, intervalMilliseconds)
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (entry.name === mark) observe((entry as PerformanceMark).detail.phase, entry.startTime)
    }).observe({ entryTypes: ['mark'] })
  }, { mark: WORKSPACE_STARTUP_MARK, prefix })
  const stopResources = startStartupResources({ enabled: process.platform === 'linux' && testInfo.project.name === 'firefox' })
  let completed = false
  try {
    const account = await uiSignup(page)
    const writes: string[] = []
    page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method()) && /\/api\/v1\/(uploads|sync|documents)/.test(request.url())) writes.push(request.url()) })
    await openAccountSettingsInMountedPlanner(page)
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
    const guestBefore = await databaseDump(page, 'crykit')
    await page.getByLabel('Email', { exact: true }).fill(account.email)
    await page.getByLabel('Password', { exact: true }).fill(uiPassword)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('heading', { name: `Signed in as ${account.username}` })).toBeVisible()
    await page.getByRole('button', { name: 'Open account workspace' }).click()
    await expect(page.getByRole('heading', { name: 'Plan your next Build' })).toBeVisible()
    expect(await databaseDump(page, 'crykit')).toBe(guestBefore)
    expect(writes).toEqual([])
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Account workspace locked' })).toBeVisible()
    await page.getByRole('button', { name: 'Continue using this device' }).click()
    await expect(page.getByRole('button', { name: 'New Build', exact: true })).toBeVisible()
    expect(await databaseDump(page, 'crykit')).toBe(guestBefore)
    completed = true
  } finally {
    const resources = await stopResources()
    if (!completed && resources.supported) await testInfo.attach('workspace-startup-resources', { body: JSON.stringify(resources), contentType: 'application/json' })
    // Console observations survive a stalled admission without another evaluation on the failing page
    await testInfo.attach('workspace-startup', { body: JSON.stringify(startup), contentType: 'application/json' })
  }
})

test('normalAppRemountRejectsForeignCookieAndKeepsLocalProfile', async ({ page, context }) => {
  const first = await uiSignup(page)
  await openAccountSettingsInMountedPlanner(page)
  await page.getByLabel('Email', { exact: true }).fill(first.email)
  await page.getByLabel('Password', { exact: true }).fill(uiPassword)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: `Signed in as ${first.username}` })).toBeVisible()
  await page.getByRole('button', { name: 'Builds', exact: true }).first().click()
  const other = await context.newPage()
  const second = await uiSignup(other)
  await uiSignin(other, second.email, second.username)
  await page.getByRole('button', { name: 'Account', exact: true }).first().click()
  await expect(page.getByRole('alert')).toContainText('Online access expired.')
  await expect(page.getByText('Online access disconnected. You can reconnect or sign in again.', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Account unlocked on this device' })).toBeVisible()
  await expect(page.getByRole('heading', { name: `Signed in as ${second.username}` })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeVisible()
})

const workspacePath = '/__accounts-proof/account-workspace#/settings/account'
interface WorkspaceProof {
  savedPlanner(): Promise<import('../../src/domain/types').LocalData>
  readBackupPlanner(file: File): Promise<import('../../src/domain/types').LocalData>
  inspect(): Promise<{ playthroughs: { label: string; characters: number; inventory: number; progress: number; scenarios: number }[]; kind: string; token?: { accountId: string; generation: number }; principal?: string; digest?: string; access?: string; titles: string[]; backupTitles: string[]; definitions: string[]; backupDefinitions: string[] }>
  pending(accountId: string): Promise<string[]>
  saveDefinition(name: string): Promise<{ localData: import('../../src/domain/types').LocalData }>
  queueDefinition(name: string): Promise<void>
  releaseQueued(): Promise<string>
  crash(): void
}
const workspaceProof = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { workspaceProof: WorkspaceProof }).workspaceProof.inspect())
async function openWorkspaceAccount(page: import('@playwright/test').Page, account: { email: string; username: string }, remember = false) {
  await page.getByLabel('Email', { exact: true }).fill(account.email)
  await page.getByLabel('Password', { exact: true }).fill(uiPassword)
  if (remember) await page.getByLabel('Remember this device').first().check()
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: `Signed in as ${account.username}` })).toBeVisible()
  await page.getByRole('button', { name: 'Open account workspace' }).click()
  await expect(page.getByRole('button', { name: 'New Build', exact: true })).toBeVisible()
}
test.describe('actualWorkspaceSwitchesDistinctAccountsAndRecoveryWithoutCrossingGuestOrPendingRevocation', () => {
  // These checkpoints retain the same context, pages, captured keys and queued command
  // Splitting reporting must not reseed the account or grant a new lifetime to old work
  test.describe.configure({ mode: 'serial' })
  let context: import('@playwright/test').BrowserContext, page: import('@playwright/test').Page, other: import('@playwright/test').Page
  let second: Awaited<ReturnType<typeof uiSignup>>, before: Awaited<ReturnType<typeof workspaceProof>>, otherOpened: Awaited<ReturnType<typeof workspaceProof>>, guestBefore: string, started: number
  test.beforeAll(async ({ browser, accountOrigin: baseURL, ignoreHTTPSErrors, viewport, isMobile, hasTouch, userAgent, colorScheme }) => {
    context = await browser.newContext({ baseURL, ignoreHTTPSErrors, viewport, isMobile, hasTouch, userAgent, colorScheme })
    page = await context.newPage()
    other = await context.newPage()
  })
  test.afterAll(async () => { await context.close() })
  test('captures distinct principals and retains the saved private backup under a foreign cookie', async () => {
    started = Date.now()
    // Register through the real App without reloading a second harness before opening its workspace
    // No account is unlocked by registration, and the two pages must retain their distinct live owners below
    const first = await uiSignup(page, workspacePath)
    second = await uiSignup(other, workspacePath)
    await openWorkspaceAccount(page, first)
    before = await workspaceProof(page)
    expect(before.kind).toBe('account')
    expect(before.token?.accountId).toBe(before.principal)
    expect(before.titles).toEqual([])
    guestBefore = await databaseDump(page, 'crykit')
    await page.getByRole('button', { name: 'New Build', exact: true }).click()
    await page.getByLabel('Build title', { exact: true }).fill('Synthetic private account A Build')
    await page.getByRole('button', { name: 'Save build', exact: true }).click()
    // The saved route opens only after the durable command resolves; graph reads can capture an earlier head
    await expect(page.getByRole('button', { name: 'Save new revision', exact: true })).toBeVisible()
    const firstSaved = await workspaceProof(page)
    expect(firstSaved.titles).toEqual(['Synthetic private account A Build'])
    expect(firstSaved.backupTitles).toEqual(firstSaved.titles)
    await page.evaluate(() => (window as unknown as { workspaceProof: WorkspaceProof }).workspaceProof.queueDefinition('Obsolete account A draft'))
    await openWorkspaceAccount(other, second)
    otherOpened = await workspaceProof(other)
    expect(otherOpened.token?.accountId).toBe(otherOpened.principal)
    expect(otherOpened.digest).not.toBe(before.digest)
    const mismatch = await workspaceProof(page)
    expect(mismatch.principal).toBe(otherOpened.token?.accountId)
    expect(mismatch.token?.accountId).toBe(before.token?.accountId)
    expect(mismatch.digest).toBe(before.digest)
    expect(mismatch.backupTitles).toEqual(['Synthetic private account A Build'])
  })
  test(CROSS_ACCOUNT_CONTINUATION, async () => {
    await page.getByRole('button', { name: 'Account', exact: true }).first().click()
    // Sync can disconnect before Account mounts, so mount-time error copy is not the authority boundary
    await expect(page.getByText('Online access disconnected. You can reconnect or sign in again.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Renew session', exact: true })).toBeDisabled()
    await expect(page.getByRole('heading', { name: 'Account unlocked on this device', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: `Signed in as ${second.username}`, exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Account workspace locked' })).toBeVisible()
    await openWorkspaceAccount(page, second)
    const after = await workspaceProof(page)
    expect(after.token?.accountId).toBe(otherOpened.token?.accountId)
    expect(after.digest).toBe(otherOpened.digest)
    expect(after.principal).toBe(after.token?.accountId)
    expect(after.titles).toEqual([])
    expect(await page.evaluate(() => (window as unknown as { workspaceProof: WorkspaceProof }).workspaceProof.releaseQueued())).toBe('PROFILE_CHANGED')
    expect(await page.evaluate(id => (window as unknown as { workspaceProof: WorkspaceProof }).workspaceProof.pending(id), before.token!.accountId)).not.toEqual([])
    await page.evaluate(() => (window as unknown as { workspaceProof: WorkspaceProof }).workspaceProof.saveDefinition('Synthetic private account B definition'))
    const secondSaved = await workspaceProof(page)
    expect(secondSaved.backupDefinitions).toEqual(['Synthetic private account B definition'])
    const accountDump = await databaseDump(page, `crykit-account-v1-${after.token!.accountId}`)
    expect(accountDump).not.toContain('Synthetic private')
    expect(await databaseDump(page, 'crykit')).toBe(guestBefore)
  })
  test(CROSS_ACCOUNT_RECOVERY, async ({}, testInfo) => {
    await page.evaluate(() => { Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }) })
    const downloaded = page.waitForEvent('download')
    await page.evaluate(() => (window as unknown as { workspaceProof: WorkspaceProof }).workspaceProof.crash())
    await expect(page.getByRole('heading', { name: 'This view could not be displayed' })).toBeVisible()
    await page.getByRole('button', { name: 'Export last saved data' }).click()
    const download = await downloaded
    expect(download.suggestedFilename()).toBe('crykit-workspace.crykit')
    const backupPath = (await download.path())!
    const readerStarted = performance.now()
    let recovered: import('../../src/domain/types').LocalData
    // Native file selection keeps archive bytes out of automation's JSON transport
    // The independent live document runs the complete strict reader before returning planner assertions
    const input = await other.evaluateHandle(() => {
      const input = document.createElement('input'); input.type = 'file'; input.hidden = true; document.body.append(input); return input
    })
    try {
      await input.asElement()!.setInputFiles(backupPath)
      recovered = await input.evaluate(input => (window as unknown as { workspaceProof: WorkspaceProof }).workspaceProof.readBackupPlanner(input.files![0]))
    } finally { await input.evaluate(input => input.remove()); await input.dispose() }
    const readerMs = performance.now() - readerStarted
    expect(Object.values(recovered.personalDefinitions).map((value: unknown) => (value as { name: string }).name)).toEqual(['Synthetic private account B definition'])
    expect(Object.values(recovered.builds)).toEqual([])
    expect(await databaseDump(page, 'crykit')).toBe(guestBefore)
    await writeFile(testInfo.outputPath('cross-account-journey.json'), JSON.stringify({ elapsedMs: Date.now() - started, sameContextAcrossCheckpoints: true, oldQueuedResult: 'PROFILE_CHANGED', exactRecovery: true, reader: 'native-browser', readerMs, backupBytes: (await stat(backupPath)).size }))
  })
})
test('rememberedWorkspaceReopensLocallyAndExplicitLockSuppressesReopening', async ({ page }) => {
  const account = await uiSignup(page)
  await page.goto(workspacePath)
  await openWorkspaceAccount(page, account, true)
  const before = await workspaceProof(page)
  await page.evaluate(() => (window as unknown as { workspaceProof: WorkspaceProof }).workspaceProof.saveDefinition('Synthetic remembered private definition'))
  const reducedMotion = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const releaseStorage = await holdWorkspaceSelection(page)
  try {
    // This fixture has no pre-script loader; finish module navigation before sampling the storage-held App phase
    await page.reload()
    const loading = loadingScreen(page)
    await expect(loading.getByRole('status')).toHaveText('Opening saved workspace...')
    await expectLoadingMotion(loading, reducedMotion)
  } finally { await releaseStorage() }
  await expect(page.getByRole('button', { name: 'New Build', exact: true })).toBeVisible()
  const reopened = await workspaceProof(page)
  expect(reopened.token?.accountId).toBe(before.token?.accountId)
  expect(reopened.digest).toBe(before.digest)
  expect(reopened.access).toBe('disconnected')
  expect(reopened.definitions).toEqual(['Synthetic remembered private definition'])
  await page.getByRole('button', { name: 'Account', exact: true }).first().click()
  await page.getByRole('button', { name: 'Lock', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Account workspace locked' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Unlock remembered account' })).toBeVisible()
})

test('blankAccountCreatesOnlyRequestedPlaythroughAndKeepsGuestEditorsClosed', async ({ page }) => {
  const account = await uiSignup(page)
  await page.goto(workspacePath)
  await openWorkspaceAccount(page, account)
  expect((await workspaceProof(page)).playthroughs).toEqual([])
  const guestBefore = await databaseDump(page, 'crykit')
  await page.evaluate(() => { location.hash = '#/characters' })
  await page.getByRole('button', { name: 'Create or select Playthrough', exact: true }).click()
  await page.getByLabel('New blank Playthrough', { exact: true }).fill('Synthetic account Playthrough')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  // Selection is optimistic, but this form clears its input only after onCreate acknowledges persistence
  await expect(page.getByLabel('New blank Playthrough', { exact: true })).toHaveValue('')
  expect(await page.evaluate(async () => Object.values((await (window as unknown as { workspaceProof: WorkspaceProof }).workspaceProof.savedPlanner()).playthroughs).map(value => ({ label: value.label, characters: Object.keys(value.characters).length, inventory: Object.keys(value.inventory).length, progress: Object.keys(value.progress).length, scenarios: Object.keys(value.scenarios).length })))).toEqual([{ label: 'Synthetic account Playthrough', characters: 0, inventory: 0, progress: 0, scenarios: 0 }])
  expect((await workspaceProof(page)).playthroughs).toEqual([{ label: 'Synthetic account Playthrough', characters: 0, inventory: 0, progress: 0, scenarios: 0 }])
  await page.evaluate(() => { location.hash = '#/mods/editor' })
  await expect(page.getByLabel('Open mod JSON file', { exact: true })).toBeEnabled()
  await expect(page.getByRole('combobox', { name: 'Files opened in this tool', exact: true }).locator('option')).toHaveCount(1)
  await page.evaluate(() => { location.hash = '#/save-editor' })
  await expect(page.getByLabel('Open Crystal Project save', { exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Choose a save file', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Saved game saves', exact: true })).toHaveCount(0)
  expect(await databaseDump(page, 'crykit')).toBe(guestBefore)
  const browserStorage = await page.evaluate(async () => ({ local: JSON.stringify(localStorage), session: JSON.stringify(sessionStorage), cache: await Promise.all((await caches.keys()).map(async key => { const cache = await caches.open(key); return Promise.all((await cache.keys()).map(async request => (await cache.match(request))!.text())) })) }))
  expect(JSON.stringify(browserStorage)).not.toContain('Synthetic account Playthrough')
})

test('completeAccountCrashRecoveryRetainsPrivateDefinitionAndGuestIsolation', async ({ page }) => {
  // Account setup, a committed definition, complete fallback download, and strict reread share this case budget
  const COMPLETE_ACCOUNT_RECOVERY_TIMEOUT_MS = 90_000
  test.setTimeout(COMPLETE_ACCOUNT_RECOVERY_TIMEOUT_MS)
  const account = await uiSignup(page)
  await page.goto(workspacePath)
  await openWorkspaceAccount(page, account)
  const guestBefore = await databaseDump(page, 'crykit')
  await page.evaluate(() => (window as unknown as { workspaceProof: WorkspaceProof }).workspaceProof.saveDefinition('Synthetic complete recovery definition'))
  await page.evaluate(() => { Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }) })
  await page.evaluate(() => (window as unknown as { workspaceProof: WorkspaceProof }).workspaceProof.crash())
  await expect(page.getByRole('heading', { name: 'This view could not be displayed' })).toBeVisible()
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export last saved data' }).click()
  const download = await downloaded
  expect(download.suggestedFilename()).toBe('crykit-workspace.crykit')
  const recovered = await readCompleteBackup(await readFile((await download.path())!))
  expect(Object.values(recovered.planner.localData.personalDefinitions).map(value => value.name)).toEqual(['Synthetic complete recovery definition'])
  expect(recovered.planner.localData.builds).toEqual({})
  expect(await databaseDump(page, 'crykit')).toBe(guestBefore)
})
