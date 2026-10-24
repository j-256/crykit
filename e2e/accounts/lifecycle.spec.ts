import { accountConnectivity, prepareAccountProofCache } from './network-fixture'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from './test-fixture'

// Independent synthetic cases retain the real limiter within each journey
test.beforeEach(async ({ request }) => { expect((await request.post('/__accounts/control/reset-rate-counters', { data: {} })).ok()).toBe(true) })
import type * as lifecycle from '../../src/account/lifecycle'
import type * as profile from '../../src/account/profile'
import type * as store from '../../src/account/device-store'
import type * as auth from '../../src/account/auth-client'
interface Harness {
  accountLifecycle: typeof lifecycle; accountProfile: typeof profile; accountDeviceStore: typeof store; accountAuth: typeof auth
  token: profile.ProfileToken; result: Promise<string>; oldSessionId: string; keyDigest: string; transactionId: string
}
const password = 'synthetic lifecycle browser password'
async function ready(page: Page, baseURL = '') {
  await page.goto(`${baseURL}/__accounts-proof/`)
  await prepareAccountProofCache(page)
  await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
}
async function register(page: Page) {
  const username = `life_${Date.now().toString(36)}`, email = `${username}@example.org`
  await page.evaluate(async input => (window as unknown as Harness).accountAuth.registerAccount(input), { email, username, password, remember: false })
  await page.request.post('/__accounts/jobs')
  const emails = await (await page.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
  await page.evaluate(async capability => { await fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }) }, emails.find(message => message.recipient === email)!.capability)
  return email
}
async function signIn(page: Page, email: string, remember = false) {
  return page.evaluate(async input => {
    const w = window as unknown as Harness
    w.token = await w.accountLifecycle.signInProfile(input)
    const metadata = await (await fetch('/api/v1/account')).json()
    w.oldSessionId = metadata.sessionId
    w.keyDigest = await w.accountProfile.withAccountKey(w.token, async key => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(key)))).join(','))
    return { accountId: w.token.accountId, sessionId: metadata.sessionId, keyDigest: w.keyDigest }
  }, { email, password, remember })
}
async function gate(page: Page, path: string, phase = 'before-headers') { expect((await page.request.post('/__accounts/control/response-gate', { data: { path, phase } })).ok()).toBe(true) }
async function arrived(page: Page) { await expect.poll(async () => (await (await page.request.get('/__accounts/control/response-gate')).json()).arrived).toBe(true) }
async function release(page: Page) { await page.request.post('/__accounts/control/release-response') }

test('realWorkerDelayedLogoutCannotClearNewerLoginCookie', async ({ page, context }) => {
  await ready(page); const email = await register(page); await signIn(page, email)
  const other = await context.newPage(); await ready(other)
  await gate(page, '/api/v1/auth/logout')
  await page.evaluate(() => {
    const w = window as unknown as Harness
    w.result = (async () => { const current = await (await fetch('/api/v1/account')).json(); const response = await fetch('/api/v1/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': current.csrf }, body: JSON.stringify({ sessionId: current.sessionId }) }); return String(response.status) })()
  })
  await arrived(page)
  const next = await signIn(other, email)
  await release(other)
  expect(await page.evaluate(() => (window as unknown as Harness).result)).toBe('200')
  expect(await other.evaluate(async () => { const w = window as unknown as Harness; w.accountProfile.assertActiveProfile(w.token); return (await (await fetch('/api/v1/account')).json()).sessionId })).toBe(next.sessionId)
})

test('realWorkerRenewalHoldsCookieLockThroughHeadersAndBodyBeforeNextLogin', async ({ page, context }) => {
  await ready(page); const email = await register(page); const first = await signIn(page, email)
  const other = await context.newPage(); await ready(other)
  await gate(page, '/api/v1/auth/renew', 'body')
  await page.evaluate(() => { const w = window as unknown as Harness; w.result = w.accountLifecycle.renewProfile(w.token).then(() => 'renewed', error => error.message) })
  await arrived(page)
  await other.evaluate(input => { const w = window as unknown as Harness; w.result = w.accountLifecycle.signInProfile(input).then(token => { w.token = token; return 'signed-in' }, error => error.message) }, { email, password })
  await expect.poll(async () => other.evaluate(async () => (await navigator.locks.query()).pending?.some(lock => lock.name === 'crykit-account-session-v1'))).toBe(true)
  await release(other)
  expect(await page.evaluate(() => (window as unknown as Harness).result)).toBe('renewed')
  expect(await other.evaluate(() => (window as unknown as Harness).result)).toBe('signed-in')
  const actual = await other.evaluate(async () => { const w = window as unknown as Harness; const metadata = await (await fetch('/api/v1/account')).json(); return { accountId: w.token.accountId, actualAccountId: metadata.accountId, digest: await w.accountProfile.withAccountKey(w.token, async key => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(key)))).join(',')) } })
  expect(actual).toEqual({ accountId: first.accountId, actualAccountId: first.accountId, digest: first.keyDigest })
})

test('realWorkerAfterCookieRotationCancellationClearsProfileAndPreservesSuccessorAuthority', async ({ page, context }) => {
  await ready(page); const email = await register(page); await signIn(page, email)
  const other = await context.newPage(); await ready(other)
  const originalCookie = (await context.cookies())[0].value
  // Pause JSON completion after native fetch applied the real Worker's cookie
  // Firefox does not expose headers while the server-side body gate is held; the separate renewal test retains that native-body interleaving
  await page.evaluate(() => {
    const nativeFetch = window.fetch
    window.fetch = async (...args) => {
      const response = await nativeFetch(...args)
      if (!String(args[0]).endsWith('/auth/renew')) return response
      const json = response.json.bind(response), signal = args[1]?.signal
      response.json = async () => {
        const value = await json()
        Object.assign(window, { renewJsonPending: true })
        await new Promise<void>((_resolve, reject) => {
          const abort = () => { signal?.removeEventListener('abort', abort); reject(signal?.reason) }
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) abort()
        })
        return value
      }
      return response
    }
  })
  await page.evaluate(() => { const w = window as unknown as Harness; w.result = w.accountLifecycle.renewProfile(w.token).then(() => 'unexpected', error => error.message) })
  await expect.poll(async () => { const cookie = (await context.cookies()).find(value => value.name === '__Host-crykit-session'); return !!cookie && cookie.value !== originalCookie }).toBe(true)
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { renewJsonPending?: boolean }).renewJsonPending)).toBe(true)
  await page.evaluate(() => { const w = window as unknown as Harness; return w.accountLifecycle.lockProfile(w.token) })
  expect(await page.evaluate(() => (window as unknown as Harness).result)).toBe('PROFILE_CHANGED')
  const next = await signIn(other, email)
  expect(await other.evaluate(async () => (await (await fetch('/api/v1/account')).json()).sessionId)).toBe(next.sessionId)
})

test('realWorkerTimeoutAfterCommitReconcilesBeforeExplicitNewLogin', async ({ page, context }) => {
  test.setTimeout(50_000)
  await ready(page); const email = await register(page); await signIn(page, email)
  const other = await context.newPage(); await ready(other)
  await gate(page, '/api/v1/auth/renew')
  await page.evaluate(() => { const w = window as unknown as Harness; w.result = w.accountLifecycle.renewProfile(w.token).then(() => 'unexpected', error => error.message) })
  await arrived(page)
  expect(await page.evaluate(() => (window as unknown as Harness).result)).toBe('AUTH_REQUEST_TIMEOUT')
  expect(await page.evaluate(() => { const w = window as unknown as Harness; return w.accountProfile.profileAccess(w.token) })).toBe('disconnected')
  const next = await signIn(other, email)
  await release(other)
  expect(await other.evaluate(async () => (await (await fetch('/api/v1/account')).json()).sessionId)).toBe(next.sessionId)
})

test('realIndexedDbRememberedKeyReopensAndOfflineSignoutSurvivesBrowserRestart', async ({ browser, accountRuntime }, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-a04-browser-'))
  const network = await accountConnectivity(accountRuntime.origin, accountRuntime.certificate)
  const options = { ...testInfo.project.use.launchOptions, headless: true, ignoreHTTPSErrors: true, baseURL: network.origin }
  let context = await browser.browserType().launchPersistentContext(directory, options)
  try {
    let page = await context.newPage(); await ready(page, network.origin)
    const email = await register(page), first = await signIn(page, email, true)
    await page.reload(); await prepareAccountProofCache(page)
    await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
    expect(await page.evaluate(async accountId => {
      const w = window as unknown as Harness
      const record = await w.accountDeviceStore.readDeviceProfile(accountId)
      w.token = await w.accountLifecycle.unlockRememberedProfile(accountId)
      return { extractable: record!.remembered!.deviceKey.extractable, access: w.accountProfile.profileAccess(w.token), digest: await w.accountProfile.withAccountKey(w.token, async key => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(key)))).join(',')) }
    }, first.accountId)).toEqual({ extractable: false, access: 'disconnected', digest: first.keyDigest })
    await page.evaluate(() => { const w = window as unknown as Harness; return w.accountLifecycle.reconnectProfile(w.token) })
    expect(network.forwarded()).toBeGreaterThan(0)
    await network.stop()
    expect(await page.evaluate(async () => fetch('/api/v1/account?uncached=1', { cache: 'no-store' }).then(() => false, () => true))).toBe(true)
    expect(await page.evaluate(() => { const w = window as unknown as Harness; return w.accountLifecycle.signOutProfile(w.token) })).toEqual({ revocationPending: true })
    await context.clearCookies()
    await context.close()
    context = await browser.browserType().launchPersistentContext(directory, options)
    page = await context.newPage(); await ready(page, network.origin)
    expect(await context.cookies()).toEqual([])
    expect(await page.evaluate(async input => {
      const w = window as unknown as Harness
      const stored = await w.accountDeviceStore.readDeviceProfile(input.accountId)
      w.token = await w.accountLifecycle.unlockCachedProfile(input.accountId, input.password)
      return { remembered: !!stored!.remembered, pending: stored!.pendingRevocations, access: w.accountProfile.profileAccess(w.token), digest: await w.accountProfile.withAccountKey(w.token, async key => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(key)))).join(',')) }
    }, { accountId: first.accountId, password })).toEqual({ remembered: false, pending: [first.sessionId], access: 'disconnected', digest: first.keyDigest })
    await network.start()
    const next = await signIn(page, email)
    expect(next.sessionId).not.toBe(first.sessionId)
    expect(await page.evaluate(() => { const w = window as unknown as Harness; return w.accountLifecycle.reconcilePendingRevocations(w.token) })).toEqual({ revocationPending: false })
    expect(await page.evaluate(async () => (await (await fetch('/api/v1/account')).json()).sessionId)).toBe(next.sessionId)
    await testInfo.attach('restart-proof', { body: JSON.stringify({ engine: browser.browserType().name(), actualBrowserRestart: true, rememberedCryptoKeyReopened: true, ordinaryCookieAbsent: true, offlinePasswordUnlocked: true, exactPendingRevocationReconciled: true, newerSessionValid: true }), contentType: 'application/json' })
  } finally {
    try { await context.close() } finally {
      try { await network.dispose() } finally { await rm(directory, { recursive: true, force: true }) }
    }
  }
})

test('confirmedPasswordChangeAndOfflineCacheFailureRemainDistinct', async ({ page, context }) => {
  await ready(page); const email = await register(page); const first = await signIn(page, email)
  const replacement = 'synthetic replacement lifecycle password'
  await page.request.post('/__accounts/control/faults', { data: ['auth.credentials.before-batch'] })
  expect(await page.evaluate(async password => {
    const w = window as unknown as Harness
    const transaction = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    w.transactionId = transaction()
    try { await w.accountLifecycle.changeProfilePassword(w.token, password, w.transactionId); return 'unexpected' } catch (error) { return (error as Error).message }
  }, replacement)).toBe('CREDENTIAL_CHANGE_UNCONFIRMED')
  await page.evaluate(() => { const w = window as unknown as Harness; return w.accountLifecycle.lockProfile(w.token) })
  await signIn(page, email)
  expect(await page.evaluate(async () => { const w = window as unknown as Harness; try { await w.accountLifecycle.resumeProfileCredentialChange(w.token, w.transactionId); return 'unexpected' } catch (error) { return (error as Error).message } })).toBe('CREDENTIAL_CHANGE_NOT_PENDING')
  const before = await page.evaluate(async accountId => (window as unknown as Harness).accountDeviceStore.readDeviceProfile(accountId), first.accountId)
  let lost = false
  await page.route('**/api/v1/account/credentials/commit', async route => {
    if (lost) { await route.continue(); return }
    lost = true
    expect((await route.fetch()).status()).toBe(200)
    await route.abort('failed')
  })
  expect(await page.evaluate(async password => {
    const w = window as unknown as Harness
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = () => { throw new DOMException('synthetic local quota', 'QuotaExceededError') }
    const transaction = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    try { await w.accountLifecycle.changeProfilePassword(w.token, password, transaction); return { error: 'unexpected', onlinePasswordChanged: false } }
    catch (error) { return { error: (error as Error).message, onlinePasswordChanged: (error as { onlinePasswordChanged?: boolean }).onlinePasswordChanged } }
    finally { IDBObjectStore.prototype.put = put }
  }, replacement)).toEqual({ error: 'OFFLINE_PASSWORD_UPDATE_FAILED', onlinePasswordChanged: true })
  expect(await page.evaluate(async accountId => (window as unknown as Harness).accountDeviceStore.readDeviceProfile(accountId), first.accountId)).toEqual(before)
  expect(await page.evaluate(async input => { const result = await (window as unknown as Harness).accountAuth.loginAccount({ ...input, remember: false }); result.key.fill(0); return result.accountId }, { email, password: replacement })).toBe(first.accountId)
  await context.setOffline(true)
  expect(await page.evaluate(async input => { const w = window as unknown as Harness; await w.accountLifecycle.lockProfile(w.token); w.token = await w.accountLifecycle.unlockCachedProfile(input.accountId, input.password); return w.token.accountId }, { accountId: first.accountId, password })).toBe(first.accountId)
})

test('ownerNavigationAndQueuedCancellationReleaseSessionCoordinationSafely', async ({ page, context }) => {
  await ready(page); const email = await register(page); await signIn(page, email)
  const other = await context.newPage(); await ready(other)
  await gate(page, '/api/v1/auth/renew')
  await page.evaluate(() => { const w = window as unknown as Harness; w.result = w.accountLifecycle.renewProfile(w.token).then(() => 'unexpected', error => error.message) })
  await arrived(page)
  await page.goto('about:blank')
  const next = await signIn(other, email)
  await release(other)
  expect(await other.evaluate(async () => (await (await fetch('/api/v1/account')).json()).sessionId)).toBe(next.sessionId)
  await ready(page)
  await page.evaluate(() => { const w = window as unknown as { releaseLock: () => void }; void navigator.locks.request('crykit-account-session-v1', () => new Promise<void>(resolve => { w.releaseLock = resolve })) })
  await expect.poll(async () => page.evaluate(() => typeof (window as unknown as { releaseLock?: () => void }).releaseLock)).toBe('function')
  await other.evaluate(() => { const w = window as unknown as Harness; w.result = w.accountLifecycle.renewProfile(w.token).then(() => 'unexpected', error => error.message) })
  await expect.poll(async () => other.evaluate(async () => (await navigator.locks.query()).pending?.length)).toBe(1)
  await other.evaluate(() => { const w = window as unknown as Harness; return w.accountLifecycle.lockProfile(w.token) })
  expect(await other.evaluate(() => (window as unknown as Harness).result)).toBe('PROFILE_CHANGED')
  await page.evaluate(() => (window as unknown as { releaseLock: () => void }).releaseLock())
})

test('unavailableLocksPreserveOfflineUnlockAndRejectOnlineSessionChanges', async ({ page, context }) => {
  await ready(page); const email = await register(page); const first = await signIn(page, email)
  await page.evaluate(() => { Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }); const w = window as unknown as Harness; return w.accountLifecycle.lockProfile(w.token) })
  await context.setOffline(true)
  expect(await page.evaluate(async input => { const w = window as unknown as Harness; w.token = await w.accountLifecycle.unlockCachedProfile(input.accountId, input.password); return w.token.accountId }, { accountId: first.accountId, password })).toBe(first.accountId)
  expect(await page.evaluate(async () => { const w = window as unknown as Harness; try { await w.accountLifecycle.renewProfile(w.token); return 'unexpected' } catch (error) { return (error as Error).message } })).toBe('AUTH_COORDINATION_UNAVAILABLE')
  expect(await page.evaluate(() => { const w = window as unknown as Harness; return w.accountProfile.profileAccess(w.token) })).toBe('disconnected')
})

test('ordinarySessionCookieNaturallyDisappearsAcrossBrowserRestartWhilePendingTargetRemains', async ({ browser, accountRuntime }, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-a04-ordinary-'))
  const network = await accountConnectivity(accountRuntime.origin, accountRuntime.certificate)
  const options = { ...testInfo.project.use.launchOptions, headless: true, ignoreHTTPSErrors: true, baseURL: network.origin }
  let context = await browser.browserType().launchPersistentContext(directory, options)
  try {
    let page = await context.newPage(); await ready(page, network.origin)
    const email = await register(page), first = await signIn(page, email, false)
    expect((await context.cookies())[0]).toMatchObject({ name: '__Host-crykit-session', expires: -1, secure: true, httpOnly: true, sameSite: 'Lax', path: '/' })
    expect(network.forwarded()).toBeGreaterThan(0)
    await network.stop()
    expect(await page.evaluate(async () => fetch('/api/v1/account?uncached=1', { cache: 'no-store' }).then(() => false, () => true))).toBe(true)
    expect(await page.evaluate(() => { const w = window as unknown as Harness; return w.accountLifecycle.signOutProfile(w.token) })).toEqual({ revocationPending: true })
    // No cookie deletion or storage-state injection: close the real process and reopen the same directory
    await context.close()
    context = await browser.browserType().launchPersistentContext(directory, options)
    page = await context.newPage(); await ready(page, network.origin)
    expect(await context.cookies()).toEqual([])
    expect(await page.evaluate(async accountId => {
      const record = await (window as unknown as Harness).accountDeviceStore.readDeviceProfile(accountId)
      return { remembered: !!record?.remembered, pending: record?.pendingRevocations }
    }, first.accountId)).toEqual({ remembered: false, pending: [first.sessionId] })
    await network.start()
    const next = await signIn(page, email, false)
    expect(next.sessionId).not.toBe(first.sessionId)
    expect(await page.evaluate(() => { const w = window as unknown as Harness; return w.accountLifecycle.reconcilePendingRevocations(w.token) })).toEqual({ revocationPending: false })
    expect(await page.evaluate(async () => (await (await fetch('/api/v1/account')).json()).sessionId)).toBe(next.sessionId)
    await testInfo.attach('ordinary-session-restart', { body: JSON.stringify({ engine: browser.browserType().name(), ordinaryCookieNaturallyAbsent: true, pendingExactTargetRetained: true, newerSessionPreserved: true }), contentType: 'application/json' })
  } finally {
    try { await context.close() } finally {
      try { await network.dispose() } finally { await rm(directory, { recursive: true, force: true }) }
    }
  }
})

test('pendingApprovalStartCancelsNativeTransportOnLifecycleTransition', async ({ page }) => {
  await ready(page); const email = await register(page)
  await gate(page, '/api/v1/auth/devices/start')
  await page.evaluate(email => {
    const w = window as unknown as Harness
    w.result = w.accountLifecycle.startAccountDeviceApproval(email).then(() => 'unexpected', error => error.message)
  }, email)
  await arrived(page)
  await page.evaluate(() => (window as unknown as Harness).accountProfile.invalidateProfile())
  expect(await page.evaluate(() => (window as unknown as Harness).result)).toBe('PROFILE_CHANGED')
  await release(page)
})

test('pendingSignoutRejectsAfterSwitchAndPreservesDistinctCachedProfile', async ({ page }) => {
  await ready(page)
  const otherEmail = await register(page), other = await signIn(page, otherEmail)
  const email = await register(page), current = await signIn(page, email)
  expect(other.keyDigest).not.toBe(current.keyDigest)
  await gate(page, '/api/v1/account/sessions/revoke')
  await page.evaluate(() => {
    const w = window as unknown as Harness
    w.result = w.accountLifecycle.signOutProfile(w.token).then(() => 'unexpected', error => error.message)
  })
  await arrived(page)
  await page.evaluate(async input => {
    const w = window as unknown as Harness
    w.token = await w.accountLifecycle.unlockCachedProfile(input.accountId, input.password)
  }, { accountId: other.accountId, password })
  expect(await page.evaluate(() => (window as unknown as Harness).result)).toBe('PROFILE_CHANGED')
  await release(page)
  expect(await page.evaluate(async accountId => {
    const w = window as unknown as Harness
    return { accountId: w.token.accountId, digest: await w.accountProfile.withAccountKey(w.token, async key => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(key)))).join(',')), pending: (await w.accountDeviceStore.readDeviceProfile(accountId))?.pendingRevocations }
  }, current.accountId)).toEqual({ accountId: other.accountId, digest: other.keyDigest, pending: [current.sessionId] })
})
