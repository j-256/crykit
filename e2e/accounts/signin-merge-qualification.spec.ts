import { expect, test } from './test-fixture'
import { beginSeededAccount } from './signin-helpers'
import { accountTableDigests } from './signin-qualification-storage'

const app = '/__accounts-proof/account-workspace.html'
const password = 'synthetic complete merge qualification password'

test('refuses a selected native account at public startup without changing its encrypted data', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Caught startup exception evidence requires Chromium CDP')
  await page.goto('/__accounts-proof/')
  await page.waitForFunction(() => !!(window as any).accountAuth)
  const username = `native_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`, email = `${username}@example.org`
  await page.evaluate(input => (window as any).accountAuth.registerAccount(input), { email, username, password, remember: true })
  await page.request.post('/__accounts/jobs')
  const emails = await (await page.request.get('/__accounts/emails')).json()
  await page.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find((value: { recipient: string }) => value.recipient === email).capability)
  await beginSeededAccount(page, app, email, password, true)
  const seeded = await page.evaluate(() => (window as any).accountBootstrapProof.seedSelectedNativeAccount())
  const before = await accountTableDigests(page)
  const storage = await page.evaluate(() => (window as any).accountBootstrapProof.accountStorage())
  expect(storage).toMatchObject({ rootVersion: 1, pending: [] })
  expect(seeded.originals.length).toBeGreaterThan(0)

  // Observe the actual caught startup exception without modifying the reader or injecting a refusal
  const cdp = await context.newCDPSession(page)
  const exceptions: string[] = []
  await cdp.send('Debugger.enable')
  await cdp.send('Debugger.setPauseOnExceptions', { state: 'all' })
  cdp.on('Debugger.paused', event => {
    if (event.reason === 'exception' || event.reason === 'promiseRejection') exceptions.push(event.data?.description ?? '')
    void cdp.send('Debugger.resume')
  })
  const syncWrites: string[] = []
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/v1/sync/')) syncWrites.push(new URL(request.url()).pathname) })
  await page.goto(`${app}#/settings/account`)
  await expect(page.getByRole('heading', { name: 'Account workspace locked', exact: true })).toBeVisible()
  await cdp.send('Debugger.setPauseOnExceptions', { state: 'none' })
  await cdp.detach()
  expect(exceptions.some(value => value.includes('unsupported prelaunch format'))).toBe(true)
  expect(await page.evaluate(() => !!(window as any).workspaceProof)).toBe(false)
  await expect(page.getByRole('complementary', { name: 'Account sync' })).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).accountBootstrapProof.accountStorage())).toEqual(storage)
  expect(await accountTableDigests(page)).toEqual(before)
  await page.getByRole('button', { name: 'Continue using this device', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New Build', exact: true })).toBeVisible()
  // Guest continuation is a separate user choice; the refused account remains byte-for-byte intact
  expect(await accountTableDigests(page)).toEqual(before)
  expect(syncWrites).toEqual([])
  await testInfo.attach('native-public-startup-refusal', { body: JSON.stringify({ seeded, storage, accountTables: before, syncWrites, startupErrors: exceptions.filter(value => value.includes('unsupported prelaunch format')), actualStartupFormatRefusal: true, noAccountEditorOrScheduler: true, localContinuation: true }), contentType: 'application/json' })
})
