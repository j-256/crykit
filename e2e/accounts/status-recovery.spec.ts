import { CHROMIUM_STATUS_COMPLETION_TAG } from '../test-tags'
import { accountConnectivity, prepareAccountProofCache } from './network-fixture'
import { expect, test, type Page, type BrowserContext } from './test-fixture'
import { writeFile } from 'node:fs/promises'
import { assertAccountStorageRecovery } from './storage-recovery'
import { waitForPlannerReady } from '../local-data-helpers'
import type * as auth from '../../src/account/auth-client'

const password = 'synthetic status recovery password'
const STATUS_RECOVERY_PHASE_TIMEOUT_MS = 120_000
const LOCAL_RECOVERY_TITLE = 'local saves and queued tiles remain durable through network delay and offline reload'
let page: Page, context: BrowserContext
const syncResponses: Record<string, number> = {}
let started: number
let runtimeBefore: unknown
let network: Awaited<ReturnType<typeof accountConnectivity>>
let setupCompleted = false
test.describe.configure({ mode: 'serial' })
test.beforeAll(async ({ browser, accountRuntime, viewport, isMobile, hasTouch, userAgent, colorScheme, ignoreHTTPSErrors }) => { started = Date.now(); network = await accountConnectivity(accountRuntime.origin, accountRuntime.certificate); context = await browser.newContext({ baseURL: network.origin, viewport, isMobile, hasTouch, userAgent, colorScheme, ignoreHTTPSErrors }); page = await context.newPage(); runtimeBefore = await (await page.request.get('/__accounts/measurement')).json(); page.on('response', response => { if (response.url().includes('/api/v1/sync/')) { const key = `${new URL(response.url()).pathname.replace(/(\/uploads|\/mutations)\/[^/]+/g, '$1/:id')}:${response.status()}`; syncResponses[key] = (syncResponses[key] ?? 0) + 1 } }) })
test.afterAll(async () => { try { await context.close() } finally { await network.dispose() } })
test.afterEach(async ({}, info) => {
  if (info.title !== LOCAL_RECOVERY_TITLE) return
  // Include both serial phases and their setup; the extra phase budget is not a throughput improvement
  await info.attach('local-recovery-journey-receipt', { contentType: 'application/json', body: JSON.stringify({ elapsedFromJourneyStartMs: Date.now() - started, setupCompleted, checksCompleted: info.status === 'passed', sameContextAcrossCheckpoints: true, setupIncluded: true }) })
})
test('account setup and Playthrough publication establish the status recovery workspace', async () => {
  test.setTimeout(STATUS_RECOVERY_PHASE_TIMEOUT_MS)
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined }) })
  await page.request.post('/__accounts/control/reset-rate-counters', { data: {} })
  await page.goto('/__accounts-proof/')
  await prepareAccountProofCache(page)
  await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
  const username = `status_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`, email = `${username}@example.org`
  await page.evaluate(input => (window as unknown as { accountAuth: typeof auth }).accountAuth.registerAccount(input), { email, username, password, remember: true })
  await page.request.post('/__accounts/jobs')
  const emails = await (await page.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
  await page.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find(message => message.recipient === email)!.capability)
  await page.goto('/__accounts-proof/account-workspace.html#/settings/account')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByLabel('Remember this device').first().check()
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('button', { name: 'Open account workspace', exact: true }).click()
  const status = page.getByRole('complementary', { name: 'Account sync' }), remote = status.getByRole('status')
  await expect(remote).toHaveText('Synced', { timeout: 60_000 })
  // Initial cloud projection advances the managed root after App captured its empty workspace
  // Adopt that committed root through the normal reopen before starting a new form
  await page.getByRole('button', { name: 'Load updated data', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Load updated data', exact: true })).toBeHidden()
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const data = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await data.getByRole('button', { name: 'Playthrough', exact: true }).click()
  const label = data.getByLabel('New blank Playthrough')
  if (!await label.isVisible()) await data.locator('.playthrough-create > summary').click()
  await label.fill('Status recovery journey')
  await data.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(data.getByRole('combobox', { name: 'Active Playthrough', exact: true }).locator('option:checked')).toContainText('Status recovery journey')
  await data.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.evaluate(() => { location.hash = '#/progress/unlocks' })
  await expect(remote).toHaveText('Synced', { timeout: 60_000 })
  await page.getByRole('button', { name: 'Load updated data', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Load updated data', exact: true })).toBeHidden()
  setupCompleted = true
})
// The continuation owns the same page and native workspace; failed setup blocks all later checkpoints
test(LOCAL_RECOVERY_TITLE, async ({ browserName }) => {
  test.setTimeout(STATUS_RECOVERY_PHASE_TIMEOUT_MS)
  const status = page.getByRole('complementary', { name: 'Account sync' }), remote = status.getByRole('status')
  const tile = page.locator('.unlock-tile input').first(), surrounding = page.locator('.unlock-tile input').nth(1)
  await page.evaluate(() => {
    const original = window.fetch, gate: { arrived: boolean; release?: () => void } = { arrived: false }
    const held = new Promise<void>(resolve => { gate.release = resolve })
    Object.assign(window, { statusUploadGate: gate })
    window.fetch = async (...args) => {
      const response = await original(...args)
      if (String(args[0]).endsWith('/sync/uploads') && !gate.arrived) { gate.arrived = true; await held }
      return response
    }
    Object.assign(gate, { restore: () => { window.fetch = original; gate.release!() } })
  })
  try {
    await tile.check()
    await page.waitForFunction(() => (window as unknown as { statusUploadGate: { arrived: boolean } }).statusUploadGate.arrived)
    await expect(remote).toHaveText('Syncing')
    await expect(status.getByText('Saved on this device', { exact: true })).toBeVisible()
    await expect(tile).toBeEnabled(); await expect(surrounding).toBeEnabled()
    await tile.uncheck(); await tile.check()
    await expect(tile).toBeChecked()
  } finally { await page.evaluate(() => (window as unknown as { statusUploadGate: { restore(): void } }).statusUploadGate.restore()) }
  await context.setOffline(true)
  await tile.uncheck()
  await expect(remote).toHaveText('Offline with changes waiting')
  await status.getByText('Saved on this device', { exact: true }).waitFor()
  await expect(status.getByText('Saved on this device', { exact: true })).toBeVisible()
  await network.stop()
  // Keep the physical listener disconnected while bypassing WebKit's navigation-only emulation defect
  // Restore its offline indicator after the cached document loads; no network is available in between
  if (browserName === 'webkit') await context.setOffline(false)
  await page.reload()
  await waitForPlannerReady(page)
  if (browserName === 'webkit') await context.setOffline(true)
  await expect(status.getByText('Saved on this device', { exact: true })).toBeVisible()
  await expect(tile).not.toBeChecked()
  await expect(remote).toHaveText('Offline with changes waiting')
  await expect(status.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled()
  await network.start()
  await context.setOffline(false)
  await page.evaluate(() => { location.hash = '#/settings/account' })
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
  await expect(page.getByText('Online access reconnected.', { exact: true })).toBeVisible()
})
test('queued edits eventually publish after reconnect with measured continuation traffic', { tag: CHROMIUM_STATUS_COMPLETION_TAG }, async ({}, testInfo) => {
  // Bound this measurement process without redefining the product's throughput contract
  test.setTimeout(300_000)
  try {
    await expect(page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: 290_000 })
  } finally {
    // Retain progress on failure too; a status timeout otherwise loses the continuation evidence
    const diagnostics = await page.evaluate(() => ({ online: navigator.onLine, visibility: document.visibilityState, editor: (window as unknown as { workspaceProof?: { editorDiagnostics(): unknown } }).workspaceProof?.editorDiagnostics() })).catch(() => ({ unavailable: true }))
    const runtimeAfter = await page.request.get('/__accounts/measurement').then(response => response.json()).catch(() => ({ unavailable: true }))
    const receipt = testInfo.outputPath('queued-edits-drain.json')
    await writeFile(receipt, JSON.stringify({ elapsedFromJourneyStartMs: Date.now() - started, syncResponses, eventBytesExcludeRequestIds: true, runtimeBefore, runtimeAfter, diagnostics }, null, 2))
    await testInfo.attach('queued-edits-drain', { path: receipt, contentType: 'application/json' })
  }
})
test('observed storage, private backup and explicit device removal recover the same pending workspace', { tag: CHROMIUM_STATUS_COMPLETION_TAG }, async ({}, testInfo) => {
  test.setTimeout(120_000)
  // The completed cloud drain published a successor; storage and removal need its current owner
  await page.getByRole('button', { name: 'Load updated data', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Load updated data', exact: true })).toBeHidden()
  await assertAccountStorageRecovery(page, testInfo)
})
