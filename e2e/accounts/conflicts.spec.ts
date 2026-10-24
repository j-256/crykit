import { expect, test, type Page, type BrowserContext } from '@playwright/test'
import type * as auth from '../../src/account/auth-client'

const password = 'synthetic retained conflict browser password'
const path = '/__accounts-proof/account-workspace.html#/settings/account'
interface Snapshot { files: string[]; conflicts: { id: string; disposition: string; versions: { role: string; filename: string; validation: string; draftBytes: number[] }[] }[] }
interface Proof { seedConflictFixture(): Promise<void>; editConflictFile(filename: string, unrelated?: boolean, draftCodeUnit?: number): Promise<void>; saveUnrelatedConflictFile(): Promise<void>; conflictSnapshot(): Promise<Snapshot>; flushSync(): void }
const snapshot = (page: Page) => page.evaluate(() => (window as unknown as { workspaceProof: Proof }).workspaceProof.conflictSnapshot())
const flush = (page: Page) => page.evaluate(() => (window as unknown as { workspaceProof: Proof }).workspaceProof.flushSync())
async function headPublication(page: Page) {
  let done = false
  const response = page.waitForResponse(value => value.url().endsWith('/sync/commits') && value.ok() && value.request().postDataJSON().heads.length > 0, { timeout: 0 }).finally(() => { done = true })
  while (!done) {
    await Promise.race([response, page.waitForTimeout(250)])
  }
  return response
}
const status = (page: Page) => page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')
async function signIn(page: Page, email: string, seed = false) {
  await page.goto(path)
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open account workspace' })).toBeVisible()
  if (seed) await page.evaluate(() => (window as unknown as { accountBootstrapProof: Proof }).accountBootstrapProof.seedConflictFixture())
  const ready = seed ? headPublication(page) : page.evaluate(() => new Promise<void>(resolve => window.addEventListener('crykit-account-sync-applied', () => resolve(), { once: true })))
  await page.getByRole('button', { name: 'Open account workspace' }).click()
  await ready
}
test.describe.serial('retained conflict choices across actual browser profiles', () => {
  let a: Page, b: Page, c: Page, contexts: BrowserContext[] = [], email: string, frozen: Snapshot['conflicts'][number], pendingPublication: ReturnType<typeof headPublication>
  test.beforeAll(async ({ browser, baseURL }) => {
    contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ baseURL })))
    ;[a, b, c] = await Promise.all(contexts.map(context => context.newPage()))
    const started = Date.now(), identities = new Map<string, number>()
    for (const [device, page] of [a, b, c].entries()) page.on('response', async response => {
      if (!response.url().endsWith('/sync/commits')) return
      const command = response.request().postDataJSON()
      if (!identities.has(command.mutationId)) identities.set(command.mutationId, identities.size)
      try {
        const progress = await (await page.request.post('/__accounts/probe/sync-progress', { data: { mutationId: command.mutationId } })).json()
        console.info(JSON.stringify({ proof: 'conflict-browser-publication', elapsedMs: Date.now() - started, device, command: identities.get(command.mutationId), heads: command.heads.length, status: response.status(), ...progress }))
      } catch { /* The owning test closes contexts after a failed phase */ }
    })
    await a.goto('/__accounts-proof/'); await expect(a.locator('#status')).toHaveText('Browser worker and offline cache ready')
    const username = `conflicts_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`; email = `${username}@example.org`
    await a.evaluate(input => (window as unknown as { accountAuth: typeof auth }).accountAuth.registerAccount(input), { email, username, password, remember: false })
    await a.request.post('/__accounts/jobs')
    const emails = await (await a.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
    await a.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find(value => value.recipient === email)!.capability)
  })
  test.afterAll(async () => { for (const context of contexts) await context.close() })
  test('publishesAnExactInvalidDraftAndPullsItOnASecondDevice', async () => {
    await signIn(a, email, true); await expect(status(a)).toHaveText('Synced')
    await signIn(b, email); await expect(status(b)).toHaveText('Synced')
    expect((await snapshot(b)).files).toEqual(['before.json'])
  })
  test('savesAnOfflineDraftWhileTheOtherDevicePublishesNewWork', async () => {
    await contexts[1].setOffline(true)
    await b.evaluate(() => (window as unknown as { workspaceProof: Proof }).workspaceProof.editConflictFile('Competing invalid draft.json', true))
    const acceptedPublication = headPublication(a)
    await a.evaluate(() => (window as unknown as { workspaceProof: Proof }).workspaceProof.editConflictFile('Competing invalid draft.json', false, 0xd801))
    await flush(a); await acceptedPublication; await expect(status(a)).toHaveText('Synced')
  })
  test('visibleRetryContinuesBoundedConflictPublication', async () => {
    let injected = false, retried = false
    await b.route('**/api/v1/sync/commits', async route => {
      if (!injected && route.request().postDataJSON().heads.length) {
        injected = true
        await route.fulfill({ status: 503, headers: { 'content-type': 'application/json', 'retry-after': '1', 'x-synthetic-retry': '1' }, body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', requestId: 'synthetic-retry', retryAfterSeconds: 1 } }) })
      } else await route.continue()
    })
    const conflictPublication = headPublication(b)
    const rejected = b.waitForResponse(response => response.headers()['x-synthetic-retry'] === '1')
    const retryClick = async () => {
      await rejected
      await expect(status(b)).toHaveText('Sync failed')
      await b.getByRole('button', { name: 'Retry', exact: true }).click(); retried = true
    }
    const retrying = retryClick()
    await contexts[1].setOffline(false); await flush(b); await retrying; await conflictPublication
    await b.unroute('**/api/v1/sync/commits'); expect(injected && retried).toBe(true)
    await expect(b.getByRole('heading', { name: 'Saved versions need review' })).toBeVisible()
  })
  test('unrelatedSaveDurablyUploadsAutomaticallyWhileTheComparisonStaysUnresolved', async () => {
    pendingPublication = headPublication(b)
    const finalAttempt = b.waitForResponse(value => value.url().endsWith('/sync/commits') && value.request().postDataJSON().heads.length > 0)
    await b.evaluate(() => (window as unknown as { workspaceProof: Proof }).workspaceProof.saveUnrelatedConflictFile())
    await flush(b); await finalAttempt
    expect((await snapshot(b)).files).toContain('Additional unrelated progress.json')
  })
  test('unrelatedPublicationFinishesAutomaticallyAfterBoundedClosureValidation', async () => {
    await pendingPublication
    await expect(b.getByRole('heading', { name: 'Saved versions need review' })).toBeVisible()
    expect((await snapshot(b)).conflicts[0].disposition).toBe('unresolved')
  })
  test('thirdDeviceIndependentlyInspectsOriginalsAndUnrelatedProgress', async () => {
    await signIn(c, email)
    await expect(c.getByRole('heading', { name: 'Saved versions need review' })).toBeVisible()
    const inspected = await snapshot(c)
    expect(inspected.files).toContain('Additional unrelated progress.json')
    expect(inspected.conflicts).toHaveLength(1); frozen = inspected.conflicts[0]
    expect(frozen.versions).toEqual([{ role: 'local-pending', filename: 'Competing invalid draft.json', validation: 'invalid', draftBytes: [0, 216] }, { role: 'accepted-cloud', filename: 'Competing invalid draft.json', validation: 'invalid', draftBytes: [1, 216] }])
    await expect(c.getByRole('button', { name: 'Keep both configurations' })).toHaveCount(0)
  })
  test('mobileExplicitChoiceSavesAndUploadsAutomatically', async () => {
    await c.setViewportSize({ width: 390, height: 844 })
    const panel = c.getByRole('region', { name: 'Saved version conflicts' })
    const inspect = panel.getByRole('button', { name: 'Inspect saved draft', exact: true })
    await inspect.nth(0).click(); await inspect.nth(1).click()
    await expect(panel.getByLabel('Saved draft content')).toHaveText(['"\\ud800"', '"\\ud801"'])
    expect(await c.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    pendingPublication = headPublication(c)
    const finalAttempt = c.waitForResponse(value => value.url().endsWith('/sync/commits') && value.request().postDataJSON().heads.length > 0)
    await c.getByRole('button', { name: 'Use pending version', exact: true }).click()
    await finalAttempt
  })
  test('explicitChoiceFinishesAutomaticallyAndKeepsMobileOriginalInspection', async ({}, testInfo) => {
    await pendingPublication; await expect(status(c)).toHaveText('Synced')
    await expect(c.getByRole('heading', { name: 'Saved version history' })).toBeVisible()
    const selected = await snapshot(c)
    expect(selected.files).toContain('Competing invalid draft.json')
    expect(selected.files).toContain('Additional unrelated progress.json')
    expect(selected.conflicts[0]).toEqual({ ...frozen, disposition: 'resolved' })
    await expect(c.getByRole('button', { name: 'Use pending version' })).toHaveCount(0)
    await c.getByRole('button', { name: 'Inspect saved draft', exact: true }).nth(0).click()
    await c.getByRole('button', { name: 'Inspect saved draft', exact: true }).nth(1).click()
    await expect(c.getByLabel('Saved draft content')).toHaveText(['"\\ud800"', '"\\ud801"'])
    await testInfo.attach('retained-originals', { body: JSON.stringify(selected), contentType: 'application/json' })
    const screenshot = testInfo.outputPath('mobile-conflict-history.png')
    await c.screenshot({ path: screenshot, fullPage: true })
    await testInfo.attach('mobile-conflict-history', { path: screenshot, contentType: 'image/png' })
  })
})
