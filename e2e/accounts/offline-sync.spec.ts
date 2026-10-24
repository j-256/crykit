import { expect, test, type Page, type BrowserContext } from '@playwright/test'
import type * as auth from '../../src/account/auth-client'

const password = 'synthetic offline sync browser password'
const workspacePath = '/__accounts-proof/account-workspace.html#/settings/account'
interface WorkspaceProof { saveDefinition(name: string): Promise<unknown>; localDefinitions(): Promise<string[]> }
test.describe.serial('durable encrypted sync', () => {
let page: Page, context: BrowserContext
test.beforeAll(async ({ browser, baseURL }) => { context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true }); page = await context.newPage() })
test.afterAll(async () => { await context.close() })
test('publishesInitialAccountThroughActualRoutes', async () => {
  await page.goto('/__accounts-proof/')
  await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
  const username = `sync_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`, email = `${username}@example.org`
  await page.evaluate(async input => (window as unknown as { accountAuth: typeof auth }).accountAuth.registerAccount(input), { email, username, password, remember: true })
  await page.request.post('/__accounts/jobs')
  const emails = await (await page.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
  await page.evaluate(async capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find(message => message.recipient === email)!.capability)
  await page.goto(workspacePath)
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByLabel('Remember this device').first().check()
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  const initialPublication = page.waitForResponse(async response => { const request = response.request(); if (!response.url().endsWith('/sync/commits') || !response.ok()) return false; const value = request.postDataJSON(); return value.heads.length > 0 })
  await page.getByRole('button', { name: 'Open account workspace' }).click()
  const status = page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')
  await initialPublication
  await expect(status).toHaveText('Synced')
})
test('offlineSaveReloadPreservesExactPendingWork', async () => {
  const status = page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')
  await context.setOffline(true)
  await page.evaluate(() => (window as unknown as { workspaceProof: WorkspaceProof }).workspaceProof.saveDefinition('Synthetic offline retained item'))
  await page.reload()
  await expect(status).toHaveText('Offline with changes waiting')
  await expect.poll(async () => page.evaluate(() => (window as unknown as { workspaceProof: WorkspaceProof }).workspaceProof.localDefinitions())).toEqual(['Synthetic offline retained item'])
})
test('reconnectReconcilesALostAcceptedCommit', async ({}, testInfo) => {
  const status = page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')
  const commits: string[] = [], receipts: string[] = []
  page.on('request', request => {
    if (request.url().endsWith('/sync/commits')) commits.push(request.postData()!)
    if (request.url().includes('/sync/mutations/')) receipts.push(request.url().split('/').at(-1)!)
  })
  // The real transaction commits, then the owned Worker fault withholds its successful receipt
  expect((await page.request.post('/__accounts/control/faults', { data: ['sync.commit.after'] })).ok()).toBe(true)
  await context.setOffline(false)
  await page.evaluate(() => { window.location.hash = '#/settings/account' })
  const publication = page.waitForResponse(response => response.url().endsWith('/sync/commits') && response.ok() && response.request().postDataJSON().heads.length > 0)
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
  await publication
  await expect(status).toHaveText('Synced')
  const reconciled = commits.map(value => JSON.parse(value).mutationId).filter(id => receipts.includes(id))
  expect(reconciled.length).toBeGreaterThan(0)
  expect(await page.evaluate(() => (window as unknown as { workspaceProof: WorkspaceProof }).workspaceProof.localDefinitions())).toEqual(['Synthetic offline retained item'])
  await testInfo.attach('sync-runtime-evidence', { body: JSON.stringify({ actualWorker: true, offlineReload: true, lostAcceptedCommit: true, stableRequestReplay: reconciled.every(id => new Set(commits.filter(value => JSON.parse(value).mutationId === id)).size === 1) }), contentType: 'application/json' })
})

})
