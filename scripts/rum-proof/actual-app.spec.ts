import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { test, expect, type BrowserContext, type Page } from '../../e2e/accounts/test-fixture'
import { readLocalData, replacePlannerFixture, selectedPlaythrough, waitForPlannerReady } from '../../e2e/local-data-helpers'
import { privateScreenshot } from './screenshot'
import type { LocalData } from '../../src/domain/types'

const COLLECTOR = 'https://cloudflareinsights.com/cdn-cgi/rum'
const BEACON = 'https://static.cloudflareinsights.com/beacon.min.js'
const DIGEST = '637381256384554e1cc3309a62fb238a51b83e7f10b2a56d8ba15dbc73ca762e'
const OBSERVER_FLUSH_MS = 200
const INTERACTION_WORK_MS = 100
const MAX_REQUESTS = 2000
const IMAGE_IMPORT_TIMEOUT_MS = 60_000
const ADMIN_SETTLE_MS = 300
const ACCOUNT_SYNC_TIMEOUT_MS = 90_000
const TOKEN = '11111111111111111111111111111111'
const PRIVATE = Object.freeze({ query: 'CK_RUM_PRIVATE_QUERY_123456789', name: 'CK_RUM_PRIVATE_NAME_123456789', file: 'CK_RUM_PRIVATE_FILENAME_123456789', content: 'CK_RUM_PRIVATE_CONTENT_123456789', password: 'CK_RUM_PRIVATE_PASSWORD_123456789', capability: 'CK_RUM_PRIVATE_CAPABILITY_123456789', hostedShare: 'U0VOU0lUSVZFU0hBUkVJRA', scenario: 'CK_RUM_PRIVATE_SCENARIO_123456789' })
type Capture = { phase: string; method: string; url: string; headers: Record<string, string>; payload: Record<string, any> }
const sensitive = new Set<string>(Object.values(PRIVATE))
function scan(value: unknown) {
  let encoded = JSON.stringify(value)
  for (let count = 0; count < 2; count++) { try { encoded += decodeURIComponent(encoded) } catch { break } }
  return [...sensitive].filter(marker => encoded.includes(marker))
}
async function flush(page: Page) {
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
  await page.waitForTimeout(OBSERVER_FLUSH_MS)
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')) })
}

// The external artifact stays outside source and is checked again in the browser worker
// A missing beacon or empty capture must never masquerade as a successful privacy check
test('real app retains SPA/vitals without leaking synthetic private state', async ({ browser, accountRuntime }, testInfo) => {
  const builtInputs = Object.fromEntries(await Promise.all(['dist/index.html', 'dist/_headers'].map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])))
  const browserVersion = browser.version()
  const bytes = await readFile(process.env.CRYKIT_RUM_BEACON_PATH!)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(DIGEST)
  const lifecycle: { name: string; visibility: string; persisted?: boolean }[] = []
  let nativeExitVitalsObserved = false
  const pending = new Set<Promise<void>>()
  const cookieControlPages = new WeakSet<Page>()
  const origin = accountRuntime.origin, scriptRequests: { headers: Record<string, string> }[] = [], captures: Capture[] = [], rejected: string[] = [], contexts: BrowserContext[] = [], policies: unknown[] = [], coverage: string[] = []
  let phase = 'startup', requests = 0
  const stage = (name: string) => { phase = name; console.error(`RUM proof phase: ${name}`) }
  const makeContext = async (blockBeacon = false, scope?: string) => {
    const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width: 1280, height: 900 } })
    contexts.push(context)
    await context.routeWebSocket('**/*', socket => { rejected.push('WEBSOCKET_EGRESS'); socket.close() })
    await context.route('**/*', route => {
      const operation = (async () => {
      const request = route.request(), url = new URL(request.url())
      if (++requests > MAX_REQUESTS) { rejected.push('REQUEST_LIMIT'); await route.abort(); return }
      if (request.url() === BEACON) {
        scriptRequests.push({ headers: await request.allHeaders() })
        if (blockBeacon) await route.abort()
        else await route.fulfill({ contentType: 'text/javascript', body: bytes })
        return
      }
      if (request.url() === COLLECTOR || url.origin === origin && url.pathname === '/cdn-cgi/rum') {
        const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' }
        const sameOriginCollector = url.origin === origin
        const expectedCookieControl = sameOriginCollector && request.url() === origin + '/cdn-cgi/rum' && cookieControlPages.has(request.frame().page())
        if (sameOriginCollector && !expectedCookieControl) { rejected.push('UNEXPECTED_SAME_ORIGIN_COLLECTOR'); await route.abort(); return }
        const capturePhase = expectedCookieControl ? 'expected-cookie-control' : scope ?? phase
        if (request.method() === 'OPTIONS') { captures.push({ phase: capturePhase, method: 'OPTIONS', url: request.url(), headers: await request.allHeaders(), payload: {} }); await route.fulfill({ status: 204, headers: cors }); return }
        try { captures.push({ phase: capturePhase, method: request.method(), url: request.url(), headers: await request.allHeaders(), payload: JSON.parse(request.postData() ?? '') }) }
        catch { rejected.push('INVALID_BEACON_PAYLOAD') }
        await route.fulfill({ status: 204, headers: cors }); return
      }
      if (url.origin !== origin) { rejected.push(url.origin + url.pathname); await route.abort(); return }
      // Only the owned HTTPS acceptance runtime can receive application/API requests
      // No provider URL, remote binding, email transport or arbitrary external origin is admitted
      if (url.pathname === '/api/v1/auth/login/finish' || url.pathname === '/api/v1/account') {
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 })
        if (response.ok()) {
          const metadata = await response.json()
          for (const key of ['accountId', 'sessionId', 'deviceId', 'csrf']) if (typeof metadata[key] === 'string') sensitive.add(metadata[key])
        }
        await route.fulfill({ response }); return
      }
      if (url.pathname.startsWith('/api/v1/') || url.pathname.startsWith('/__accounts/')) { await route.continue(); return }
      if (url.pathname === '/__rum-exit') { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic owned exit</title>' }); return }
      if (url.pathname === '/__rum-admin-policy') {
        const html = (await readFile(resolve('dist/admin/index.html'), 'utf8')).replace('</head>', `<script defer src="${BEACON}" data-cf-beacon='${JSON.stringify({ token: TOKEN, spa: true })}'></script></head>`)
        const publicPolicy = policies.find((policy: any) => !policy.admin) as { csp: string; referrer: string }
        await route.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': publicPolicy.csp, 'Referrer-Policy': publicPolicy.referrer }, body: html }); return
      }
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 })
      if (response.headers()['content-type']?.includes('text/html')) {
        let html = await response.text()
        const isAdmin = /\/admin(?:\.html|\/|$)/.test(url.pathname)
        if (!url.pathname.startsWith('/__accounts-proof/')) {
          if (url.searchParams.has('rum-cookie-negative-control')) {
            html = html.replace(/data-cf-beacon=(?:"[^"]*"|'[^']*')/, `data-cf-beacon='${JSON.stringify({ token: TOKEN, spa: true, send: { to: '/cdn-cgi/rum' } })}'`)
          }
          policies.push({ path: url.pathname, admin: isAdmin, csp: response.headers()['content-security-policy'], referrer: response.headers()['referrer-policy'], metaCsp: [...html.matchAll(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]+>/g)].map(value => value[0]) })
        }
        await route.fulfill({ response, body: html }); return
      }
      await route.fulfill({ response })
      })()
      pending.add(operation)
      return operation.finally(() => pending.delete(operation))
    })
    return context
  }
  try {
    stage('expected-negative-control')
    const negativeContext = await makeContext(false, 'expected-negative-control'), negative = await negativeContext.newPage()
    await negative.goto('/#/builds/teams')
    await waitForPlannerReady(negative)
    const negativeCard = negative.locator('.scenario-card').first()
    await expect(negativeCard).toBeVisible()
    await negativeCard.evaluate((element, id) => { element.id = 'scenario-' + id }, PRIVATE.scenario)
    await negative.evaluate(duration => document.addEventListener('click', () => { const until = performance.now() + duration; while (performance.now() < until) {} }, { once: true, capture: true }), INTERACTION_WORK_MS)
    await negativeCard.getByRole('button', { name: 'Share team', exact: true }).click()
    await negative.waitForTimeout(OBSERVER_FLUSH_MS)
    await flush(negative)
    await expect.poll(() => captures.filter(value => value.phase === 'expected-negative-control').some(value => scan(value).includes(PRIVATE.scenario))).toBe(true)
    await negativeContext.close()
    coverage.push('expected failure: real beacon INP leaked restored historical scenario DOM ID in isolated negative-control context')
    stage('startup')
    const context = await makeContext(), page = await context.newPage()
    await page.goto(`/?private=${PRIVATE.query}#/builds/library`)
    await waitForPlannerReady(page)
    await expect.poll(() => captures.length).toBeGreaterThan(0)
    const configured = await page.evaluate(() => (window as any).__cfBeacon)
    expect(configured.spa).toBe(true)
    expect(configured.send).toBeUndefined()
    const data = await readLocalData(page), scenario = Object.values(selectedPlaythrough(data).scenarios)[0]!
    expect(scenario).toBeTruthy()
    // Import through the app's supported archive path, preserving its real validation/publication behavior
    let replaced = JSON.parse(JSON.stringify(data).replaceAll(scenario.id, PRIVATE.scenario)) as LocalData
    const playthrough = selectedPlaythrough(replaced)
    replaced = { ...replaced, playthroughs: { ...replaced.playthroughs, [playthrough.id]: { ...playthrough, characters: Object.fromEntries(Object.entries(playthrough.characters).map(([id, character]) => [id, { ...character, name: PRIVATE.name }])) } } }
    await replacePlannerFixture(page, replaced)
    for (const value of Object.values(replaced.builds)) sensitive.add(value.id)
    for (const value of Object.values(replaced.buildRevisions)) sensitive.add(value.id)
    coverage.push('validated planner backup import; persisted scenario/build identities and character names')
    stage('scenario-interaction')
    await page.evaluate(hash => { location.hash = hash }, `#/builds/teams/${PRIVATE.scenario}`)
    const card = page.locator('.scenario-card').filter({ has: page.getByRole('heading', { name: scenario.label, exact: true }) })
    await expect(card).toBeVisible()
    expect(await card.getAttribute('id')).toBeNull()
    // Deterministic event work makes this actual app interaction eligible for useful INP attribution
    await page.evaluate(duration => document.addEventListener('click', () => { const end = performance.now() + duration; while (performance.now() < end) {} }, { once: true, capture: true }), INTERACTION_WORK_MS)
    await card.getByRole('button', { name: 'Share team', exact: true }).click()
    const share = page.getByRole('dialog', { name: 'Share team', exact: true })
    await expect(share).toBeVisible()
    const shareUrl = await share.getByRole('textbox', { name: 'Share URL', exact: true }).inputValue()
    sensitive.add(new URL(shareUrl).hash.slice('#/share/v6/'.length))
    coverage.push('actual portable share generation and private names in rendered dialog/form')
    await page.keyboard.press('Escape')
    await flush(page)
    stage('portable-share')
    await page.evaluate(hash => { location.hash = hash }, new URL(shareUrl).hash)
    await expect(page.locator('main')).toContainText('Shared')
    await flush(page)
    stage('private-screenshot')
    const screenshotContext = await makeContext(), screenshotPage = await screenshotContext.newPage()
    await screenshotPage.goto('/#/characters')
    await waitForPlannerReady(screenshotPage)
    const character = Object.keys(selectedPlaythrough(await readLocalData(screenshotPage)).characters)[0]!
    await screenshotPage.goto('/#/characters/' + encodeURIComponent(character) + '/current')
    await screenshotPage.getByRole('button', { name: 'Import skill screenshots', exact: true }).click()
    const image = await privateScreenshot(screenshotPage, PRIVATE.content)
    sensitive.add(image.dataPrefix)
    await screenshotPage.getByLabel('Skill screenshots', { exact: true }).setInputFiles({ name: `${PRIVATE.file}.png`, mimeType: 'image/png', buffer: image.bytes })
    const preview = screenshotPage.getByAltText('Skill tree from the selected screenshot', { exact: true })
    await expect(preview).toBeVisible({ timeout: IMAGE_IMPORT_TIMEOUT_MS })
    expect(await preview.getAttribute('src')).toMatch(/^blob:/)
    await screenshotPage.getByText('Show full screenshot', { exact: true }).click()
    await expect(screenshotPage.getByAltText('Full screenshot with character header and selected class')).toBeVisible()
    await flush(screenshotPage)
    coverage.push('actual private Learn screenshot import/OCR/review creates opaque Blob image handles; raw pixels/data URL and filename checked')
    stage('private-json-editor')
    await page.evaluate(() => { location.hash = '#/mods/editor' })
    await page.getByLabel('Open mod JSON file', { exact: true }).setInputFiles({ name: `${PRIVATE.file}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ Name: PRIVATE.content, Password: PRIVATE.password })) })
    await page.getByRole('button', { name: 'Edit whole document JSON', exact: true }).click()
    await page.getByRole('textbox', { name: /^Exact JSON value/ }).fill(JSON.stringify({ Name: PRIVATE.content, Secret: PRIVATE.capability }))
    await flush(page)
    coverage.push('actual JSON import and unfinished private editing')
    stage('credential-and-capability')
    const credentialContext = await makeContext(), credential = await credentialContext.newPage()
    await credential.goto('/?private=' + PRIVATE.query + '#/settings/account')
    await credential.getByLabel('Email', { exact: true }).fill(`${PRIVATE.name.toLowerCase()}@example.org`)
    await credential.getByLabel('Password', { exact: true }).fill(PRIVATE.password)
    await flush(credential)
    await credential.evaluate(hash => { location.hash = hash }, `#/account/verify/${PRIVATE.capability}`)
    await flush(credential)
    coverage.push('account credential form and fragment verification capability intake')
    stage('hosted-share-shape')
    const shareContext = await makeContext(), hosted = await shareContext.newPage()
    await hosted.goto('/#/builds/library')
    await waitForPlannerReady(hosted)
    await hosted.evaluate(hash => { location.hash = hash }, '#/s/' + PRIVATE.hostedShare)
    await expect(hosted.getByText('Shared snapshot unavailable', { exact: true })).toBeVisible()
    await flush(hosted)
    coverage.push('valid hosted-share fragment shape and unavailable-share response; no publication claim')
    stage('hash-history-navigation')
    await hosted.evaluate(() => { location.hash = '#/reference'; history.pushState({}, '', '#/builds/library') })
    await hosted.goBack()
    await flush(hosted)
    const rootPolicy = await hosted.evaluate(() => ({ referrer: document.querySelector('meta[name="referrer"]')?.getAttribute('content'), policy: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') }))
    expect(rootPolicy.referrer).toBe('no-referrer')
    expect(rootPolicy.policy).toContain(BEACON)
    // Insertion is attempted under the actual header and meta policies; unrelated script must be blocked
    const forbidden = 'https://unrelated-rum.invalid/forbidden.js'
    const forbiddenResult = await hosted.evaluate(url => new Promise<string>(resolve => { const script = document.createElement('script'); script.src = url; script.onload = () => resolve('loaded'); script.onerror = () => resolve('blocked'); document.head.append(script) }), forbidden)
    expect(forbiddenResult).toBe('blocked')
    coverage.push('query-bearing public document header/meta CSP and no-referrer; unrelated external script rejection')
    stage('local-account-preparation')
    const seedContext = await makeContext(), seed = await seedContext.newPage()
    await seed.goto('/__accounts-proof/')
    await seed.waitForFunction(() => !!(window as any).accountAuth)
    const email = 'rum_proof@example.org'
    sensitive.add(email)
    await seed.evaluate(async input => { await (window as any).accountAuth.registerAccount({ ...input, remember: false }) }, { email, username: 'rum_proof', password: PRIVATE.password })
    const capability = await seed.evaluate(async () => { await fetch('/__accounts/jobs', { method: 'POST' }); const messages = await (await fetch('/__accounts/emails')).json(); return messages.find((message: any) => message.recipient === 'rum_proof@example.org').capability as string })
    sensitive.add(capability)
    const keyMarkers = await seed.evaluate(async input => {
      await fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability: input.capability }) })
      const result = await (window as any).accountAuth.loginAccount({ email: input.email, password: input.password, remember: false })
      return { encoded: btoa(String.fromCharCode(...result.key)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''), hex: [...result.key].map((value: number) => value.toString(16).padStart(2, '0')).join(''), accountId: result.accountId, sessionId: result.sessionId, csrf: result.csrf, deviceId: result.deviceId, bytes: JSON.stringify([...result.key]), standardBase64: btoa(String.fromCharCode(...result.key)) }
    }, { email, password: PRIVATE.password, capability })
    Object.values(keyMarkers).forEach(value => sensitive.add(value))
    await seed.close()
    stage('unlocked-account-document')
    const accountContext = await makeContext(), account = await accountContext.newPage()
    await account.goto('/?account=synthetic#/settings/account')
    await account.getByLabel('Email', { exact: true }).fill(email)
    await account.getByLabel('Password', { exact: true }).fill(PRIVATE.password)
    await account.getByRole('button', { name: 'Sign in', exact: true }).click()
    await account.getByRole('button', { name: 'Open account workspace', exact: true }).click()
    await waitForPlannerReady(account)
    await account.evaluate(() => { location.hash = '#/mods/editor' })
    await account.getByLabel('Open mod JSON file', { exact: true }).setInputFiles({ name: `${PRIVATE.file}-account.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ Name: PRIVATE.content, Key: PRIVATE.capability })) })
    await account.getByRole('button', { name: 'Edit whole document JSON', exact: true }).click()
    await account.getByRole('textbox', { name: /^Exact JSON value/ }).fill(JSON.stringify({ Private: PRIVATE.content, Draft: PRIVATE.password }))
    await expect(account.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: ACCOUNT_SYNC_TIMEOUT_MS })
    await flush(account)
    coverage.push('actual production app unlocked against isolated local Worker/D1/R2/email-capture runtime; private account JSON original and unfinished draft; actual account-key encodings checked')
    const activeCookies = await accountContext.cookies(origin)
    expect(activeCookies.some(cookie => cookie.name === '__Host-crykit-session')).toBe(true)
    activeCookies.forEach(cookie => sensitive.add(cookie.value))
    stage('cookie-control-check')
    const cookieControl = await accountContext.newPage()
    cookieControlPages.add(cookieControl)
    await cookieControl.goto('/?rum-cookie-negative-control=1#/builds/library')
    await cookieControl.waitForFunction(() => !!(window as any).__cfBeacon)
    await expect.poll(() => captures.filter(value => value.phase === 'expected-cookie-control').some(value => !!value.headers.cookie && scan(value).length > 0)).toBe(true)
    await cookieControl.goto('/__rum-exit')
    await cookieControl.close()
    coverage.push('expected failure: same-origin collector received actual active session cookie; separate default collector checked against that real cookie value')
    stage('admin-policy')
    const beforeAdmin = captures.filter(value => value.phase === 'admin-policy').length
    const admin = await context.newPage()
    await admin.goto('/__rum-admin-policy?private=' + PRIVATE.query)
    const adminMeta = await admin.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
    expect(adminMeta).not.toContain(BEACON)
    await admin.waitForTimeout(ADMIN_SETTLE_MS)
    expect(await admin.evaluate(() => (window as any).__cfBeacon)).toBeUndefined()
    expect(captures.filter(value => value.phase === 'admin-policy').length).toBe(beforeAdmin)
    coverage.push('actual built admin HTML meta-policy fixture rejects beacon; no Access/admission claim')
    stage('blocked-beacon-edit')
    const blockedContext = await makeContext(true), blocked = await blockedContext.newPage()
    await blocked.goto('/#/mods/editor')
    await blocked.getByLabel('Open mod JSON file', { exact: true }).setInputFiles({ name: 'blocked-beacon.json', mimeType: 'application/json', buffer: Buffer.from('{"Name":"Blocked beacon still edits"}') })
    await blocked.getByRole('button', { name: 'Edit whole document JSON', exact: true }).click()
    const blockedField = blocked.getByRole('textbox', { name: /^Exact JSON value/ })
    await blockedField.fill('{"Saved":"without analytics"}')
    await expect(blockedField).toHaveValue('{"Saved":"without analytics"}')
    expect(await blocked.evaluate(() => (window as any).__cfBeacon)).toBeUndefined()
    coverage.push('actual private editor remains usable with beacon download blocked; no service-worker/offline claim')
    stage('actual-page-exit')
    const exitContext = await makeContext(), exitPage = await exitContext.newPage()
    await exitPage.exposeBinding('__rumLifecycle', (_source, event) => { lifecycle.push(event) })
    await exitPage.addInitScript(() => {
      document.addEventListener('visibilitychange', () => { void (window as any).__rumLifecycle({ name: 'visibilitychange', visibility: document.visibilityState }) })
      window.addEventListener('pagehide', event => { void (window as any).__rumLifecycle({ name: 'pagehide', visibility: document.visibilityState, persisted: event.persisted }) })
    })
    await exitPage.goto('/#/builds/library')
    await waitForPlannerReady(exitPage)
    const exitLoad = captures.filter(value => value.phase === 'actual-page-exit' && value.payload.eventType === 1).at(-1)
    expect(exitLoad).toBeTruthy()
    await exitPage.evaluate(() => { const link = document.createElement('a'); link.href = '/__rum-exit'; link.textContent = 'Synthetic proof exit'; Object.assign(link.style, { position: 'fixed', zIndex: '2147483647', top: '12px', right: '12px', padding: '12px', background: 'white', color: 'black' }); document.body.append(link) })
    await exitPage.getByRole('link', { name: 'Synthetic proof exit', exact: true }).click()
    await expect(exitPage).toHaveTitle('Synthetic owned exit')
    await expect.poll(() => captures.some(value => value.phase === 'actual-page-exit' && value.payload.eventType === 3 && value.payload.pageloadId === exitLoad!.payload.pageloadId)).toBe(true)
    await Promise.allSettled([...pending])
    nativeExitVitalsObserved = captures.some(value => value.phase === 'actual-page-exit' && value.payload.eventType === 3 && value.payload.pageloadId === exitLoad!.payload.pageloadId)
    coverage.push('trusted-link document exit to owned blank page emitted matching-page vitals')
    await Promise.all(contexts.map(context => context.close()))
    await Promise.allSettled([...pending])
    nativeExitVitalsObserved = captures.some(value => value.phase === 'actual-page-exit' && value.payload.eventType === 3 && value.payload.pageloadId === exitLoad!.payload.pageloadId)
    expect(nativeExitVitalsObserved, 'matching-page native exit vitals must remain captured after close/drain').toBe(true)
    const publicPolicies = policies.filter((value: any) => !value.admin) as any[]
    expect(publicPolicies.length).toBeGreaterThan(0)
    for (const policy of publicPolicies) { expect(policy.csp).toContain(BEACON); expect(policy.referrer).toBe('no-referrer') }
    expect(rejected).toEqual([])
    const cleanCaptures = captures.filter(value => !['expected-negative-control', 'expected-cookie-control'].includes(value.phase))
    expect(scriptRequests.length).toBeGreaterThan(0)
    for (const request of scriptRequests) { expect(request.headers.cookie).toBeUndefined(); expect(request.headers.referer).toBeUndefined(); expect(scan(request)).toEqual([]) }
    for (const capture of cleanCaptures) { expect(capture.url).toBe(COLLECTOR); expect(capture.headers.cookie).toBeUndefined(); expect(capture.headers.referer).toBeUndefined(); expect(capture.headers.origin).toBe(origin); expect(scan(capture), 'private marker appeared in outgoing beacon fields/headers').toEqual([]) }
    expect(cleanCaptures.some(value => value.payload.eventType === 1)).toBe(true)
    expect(cleanCaptures.some(value => value.payload.nt === 'routing-apis' || value.payload.nt === 'soft-navigation')).toBe(true)
    expect(cleanCaptures.some(value => value.payload.lcp?.value > 0 || value.payload.fcp?.value > 0)).toBe(true)
    expect(cleanCaptures.some(value => value.payload.inp?.value > 0)).toBe(true)
    expect(cleanCaptures.some(value => value.phase === 'private-screenshot' && value.payload.lcp?.url?.startsWith('blob:'))).toBe(true)
    // A known historical selector shape must trip the very same whole-payload guard
    expect(scan({ element: `#scenario-${PRIVATE.scenario}>button` })).toContain(PRIVATE.scenario)
    expect(scan({ element: '.scenario-card>button' })).toEqual([])
    coverage.push('positive load/SPA/rendering/interaction metrics; deterministic historical-selector negative control')
    await writeFile(resolve(process.env.CRYKIT_RUM_OUTPUT!, 'receipt.json'), JSON.stringify({ beaconSha256: DIGEST, builtInputs, browserVersion, observedAt: new Date().toISOString(), captures, scriptRequests, policies, coverage, lifecycle, nativeExitVitalsObserved, requestCount: requests, rejected, checkedSensitiveValues: sensitive.size, limitations: ['Chromium only; headless native visibility/exit delivery is reported separately', 'Service workers blocked; no offline claim', 'Local isolated account runtime; no hosted account or provider metrics', 'Actual manual embedding/site-region settings and live collector acceptance remain rollout checks', 'Private artwork attachment not separately exercised; real screenshot Blob LCP attribution positively asserted' ] }, null, 2) + '\n')
  } finally {
    await writeFile(resolve(process.env.CRYKIT_RUM_OUTPUT!, 'attempt.json'), JSON.stringify({ builtInputs, browserVersion, phase, captures, scriptRequests, policies, coverage, lifecycle, nativeExitVitalsObserved, rejected, requestCount: requests }, null, 2) + '\n')
    await Promise.all(contexts.map(context => context.close()))
  }
})
