import { prepareAccountProofCache } from './network-fixture'
import { writeFile } from 'node:fs/promises'
import { expect, test } from './test-fixture'

// Independent synthetic cases retain the real limiter within each journey
test.beforeEach(async ({ request }) => { expect((await request.post('/__accounts/control/reset-rate-counters', { data: {} })).ok()).toBe(true) })
import { readLocalData, skipInitialModSetup, waitForPlannerReady } from '../local-data-helpers'

test('coldGuestEditingSurvivesUnavailableAccountApiAndPasswordRuntime', async ({ page, context }, testInfo) => {
  const blocked: string[] = [], privateTitle = `PRIVATE_O05_GUEST_${crypto.randomUUID()}`
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.startsWith('/api/')) { await route.fulfill({ status: 503, contentType: 'application/json', body: '{"code":"SERVICE_UNAVAILABLE"}' }); return }
    // The pinned OPAQUE package is emitted as a separate esm chunk; block its emitted URL as well as worker/WASM paths
    if (/opaque|password-worker|\/esm-[^/]+\.js$|\.wasm$/i.test(url.pathname)) { blocked.push(url.pathname); await route.abort(); return }
    await route.continue()
  })
  await page.goto('/#/builds')
  await waitForPlannerReady(page)
  await skipInitialModSetup(page)
  await page.getByRole('button', { name: 'New Build', exact: true }).click()
  await page.getByLabel('Build title', { exact: true }).fill(privateTitle)
  await page.getByRole('button', { name: 'Save build', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  const before = await readLocalData(page)
  expect(Object.values(before.builds).map(build => build.title)).toContain(privateTitle)
  await page.reload()
  await waitForPlannerReady(page)
  expect((await readLocalData(page)).builds).toEqual(before.builds)
  expect(blocked).toEqual([])
  const artifacts: string[] = []
  for (const path of ['/admin', '/admin/', '/admin/confirm/', '/api/admin/v1/accounts', '/api/v1/account']) {
    // APIRequestContext reaches the actual Worker independently of the browser's unavailable-API route
    const response = await page.request.get(path)
    // This fixture has no configured Access operator; authenticated-admin artifacts have their own suite
    const admin = path.startsWith('/admin') || path.startsWith('/api/admin/')
    expect(response.status()).toBe(admin ? 503 : 401)
    expect((await response.json()).error.code).toBe(admin ? 'SERVICE_UNAVAILABLE' : 'AUTH_REQUIRED')
    artifacts.push(await response.text())
  }
  expect(artifacts.filter(body => body.includes(privateTitle))).toEqual([])
  await testInfo.attach('cold-guest-privacy', { body: JSON.stringify({ opaqueRequests: blocked, guestRevision: before.revision, protectedHttpPaths: true, accountApiUnavailable: true }), contentType: 'application/json' })
})

test('backForwardReturnCannotReuseThePreviousProfileKey', async ({ browser, baseURL, ignoreHTTPSErrors }, testInfo) => {
  // Playwright's Firefox configuration and WebKit inspector patch disable their back/forward cache
  // Chromium exercises the actual persisted document; the other builds must create a fresh one
  const persistedReturn = browser.browserType().name() === 'chromium'
  const process = await browser.browserType().launch({ ...testInfo.project.use.launchOptions, ...(browser.browserType().name() === 'chromium' ? { channel: 'chromium' } : {}), ignoreDefaultArgs: ['--disable-back-forward-cache'] })
  const context = await process.newContext({ baseURL, ignoreHTTPSErrors })
  try {
    const page = await context.newPage()
    await page.addInitScript(() => { addEventListener('pageshow', event => Object.assign(window, { returnedFromBFCache: event.persisted })) })
    await page.goto('/__accounts-proof/')
    await prepareAccountProofCache(page)
    await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
    const username = `cache_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`, email = `${username}@example.org`, password = 'synthetic BFCache password'
    await page.evaluate(input => (window as unknown as { accountAuth: typeof import('../../src/account/auth-client') }).accountAuth.registerAccount(input), { email, username, password, remember: false })
    await page.request.post('/__accounts/jobs')
    const mail = await (await page.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
    await page.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), mail.find(message => message.recipient === email)!.capability)
    const originalToken = await page.evaluate(async input => {
      const w = window as unknown as { accountLifecycle: typeof import('../../src/account/lifecycle'); savedToken: import('../../src/account/profile').ProfileToken }
      w.savedToken = await w.accountLifecycle.signInProfile(input)
      return w.savedToken
    }, { email, password })
    await page.goto('/icon.svg')
    // A persisted return has no fresh load event; observe actual pageshow instead
    await page.goBack({ waitUntil: 'commit' })
    await expect.poll(() => page.evaluate(() => { const w = window as unknown as { returnedFromBFCache?: boolean; accountProfile?: unknown }; return typeof w.returnedFromBFCache === 'boolean' && !!w.accountProfile })).toBe(true)
    const outcome = await page.evaluate(async originalToken => {
      const w = window as unknown as { returnedFromBFCache: boolean; savedToken?: import('../../src/account/profile').ProfileToken; accountProfile: typeof import('../../src/account/profile') }
      let keyAccess: string
      try { await w.accountProfile.withAccountKey(w.savedToken ?? originalToken, async () => undefined); keyAccess = 'unexpected' } catch (error) { keyAccess = (error as Error).message }
      return { persisted: w.returnedFromBFCache, originalTokenRetained: !!w.savedToken, currentProfileInstalled: !!w.accountProfile.currentProfileToken(), keyAccess }
    }, originalToken)
    const receipt = testInfo.outputPath('bfcache-return.json')
    await writeFile(receipt, JSON.stringify({ engine: browser.browserType().name(), ...outcome, navigation: await page.evaluate(() => performance.getEntriesByType('navigation').map(entry => entry.toJSON())) }, null, 2))
    await testInfo.attach('bfcache-return', { path: receipt, contentType: 'application/json' })
    expect(outcome).toEqual({ persisted: persistedReturn, originalTokenRetained: persistedReturn, currentProfileInstalled: false, keyAccess: 'PROFILE_CHANGED' })
  } finally { await context.close(); await process.close() }
})
