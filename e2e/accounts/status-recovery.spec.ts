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
const MAX_STATUS_OBSERVATIONS = 512
const STATUS_OBSERVATION_INTERVAL_MS = 1000
interface StatusObservation {
  readonly atMs: number
  readonly event: string
  readonly phase?: string
  readonly journeyMs?: number
  readonly method?: string
  readonly route?: string
  readonly status?: number | string
  readonly id?: string
  readonly kind?: string
  readonly pending?: boolean
  readonly mapperPending: number
  readonly current?: boolean
  readonly filePending?: boolean
  readonly online: boolean
  readonly visibility: DocumentVisibilityState
}
declare global {
  interface Window {
    recordStatusRecovery(observation: StatusObservation): Promise<void>
    statusRecoveryDiagnostics: { record(event: string, detail?: Partial<StatusObservation>): void }
  }
}
let page: Page, context: BrowserContext
const syncResponses: Record<string, number> = {}
let started: number
let runtimeBefore: unknown
let network: Awaited<ReturnType<typeof accountConnectivity>>
let setupCompleted = false
const statusObservations: StatusObservation[] = []
let droppedStatusObservations = 0
let recoveryPhase = 'setup'
test.describe.configure({ mode: 'serial' })
test.beforeAll(async ({ browser, accountRuntime, viewport, isMobile, hasTouch, userAgent, colorScheme, ignoreHTTPSErrors }) => { started = Date.now(); network = await accountConnectivity(accountRuntime.origin, accountRuntime.certificate); context = await browser.newContext({ baseURL: network.origin, viewport, isMobile, hasTouch, userAgent, colorScheme, ignoreHTTPSErrors }); page = await context.newPage(); runtimeBefore = await (await page.request.get('/__accounts/measurement')).json(); page.on('response', response => { if (response.url().includes('/api/v1/sync/')) { const key = `${new URL(response.url()).pathname.replace(/(\/uploads|\/mutations)\/[^/]+/g, '$1/:id')}:${response.status()}`; syncResponses[key] = (syncResponses[key] ?? 0) + 1 } }) })
test.afterAll(async () => { try { await context.close() } finally { await network.dispose() } })
test.afterEach(async ({}, info) => {
  if (info.title !== LOCAL_RECOVERY_TITLE) return
  // Include both serial phases and their setup; the extra phase budget is not a throughput improvement
  await info.attach('local-recovery-journey-receipt', { contentType: 'application/json', body: JSON.stringify({ elapsedFromJourneyStartMs: Date.now() - started, setupCompleted, checksCompleted: info.status === 'passed', sameContextAcrossCheckpoints: true, setupIncluded: true }) })
  // Keep observations in the test process before timeout teardown can close the page
  const diagnostics = info.outputPath('status-recovery-diagnostics.json')
  await writeFile(diagnostics, JSON.stringify({ recoveryPhase, droppedStatusObservations, observations: statusObservations }, null, 2))
  await info.attach('status-recovery-diagnostics', { contentType: 'application/json', path: diagnostics })
})
test('account setup and Playthrough publication establish the status recovery workspace', async () => {
  test.setTimeout(STATUS_RECOVERY_PHASE_TIMEOUT_MS)
  await page.exposeBinding('recordStatusRecovery', (_source, observation: StatusObservation) => {
    if (statusObservations.length === MAX_STATUS_OBSERVATIONS) { statusObservations.shift(); droppedStatusObservations++ }
    statusObservations.push({ ...observation, phase: recoveryPhase, journeyMs: Date.now() - started })
  })
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined })
    const mapperPending = new Set<string>()
    const record = (event: string, detail: Partial<StatusObservation> = {}) => {
      try {
        const proof = (window as unknown as { workspaceProof?: { editorDiagnostics(): { current: boolean; pending: boolean } } }).workspaceProof?.editorDiagnostics()
        void window.recordStatusRecovery({ atMs: performance.now(), event, ...detail, mapperPending: mapperPending.size, current: proof?.current, filePending: proof?.pending, online: navigator.onLine, visibility: document.visibilityState }).catch(() => {})
      } catch { /* Observation delivery must not alter the native operation during teardown */ }
    }
    window.statusRecoveryDiagnostics = { record }
    const NativeWorker = Worker
    window.Worker = class extends NativeWorker {
      private readonly statusMapper: boolean
      private readonly statusPending = new Set<string>()
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.statusMapper = String(url).includes('account-local-mapping-worker')
        if (!this.statusMapper) return
        record('mapper-created')
        this.addEventListener('message', event => {
          const { id, status } = event.data
          if (typeof id === 'string') { mapperPending.delete(id); this.statusPending.delete(id) }
          record('mapper-received', { id: typeof id === 'string' ? id : undefined, status: typeof status === 'string' ? status : undefined })
        })
        this.addEventListener('error', () => record('mapper-error'))
      }
      override postMessage(message: any, transfer: Transferable[] | StructuredSerializeOptions = []) {
        // Observe scheduling identities only, never initialization keys, intent payloads, or results
        if (this.statusMapper && ['map', 'baseline', 'foreground', 'cancel'].includes(message?.kind)) {
          const id = typeof message.id === 'string' ? message.id : undefined
          if (id && ['map', 'baseline'].includes(message.kind)) { mapperPending.add(id); this.statusPending.add(id) }
          record('mapper-sent', { kind: message.kind, id, pending: typeof message.pending === 'boolean' ? message.pending : undefined })
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer)
        else super.postMessage(message, transfer)
      }
      override terminate() {
        for (const id of this.statusPending) mapperPending.delete(id)
        this.statusPending.clear()
        if (this.statusMapper) record('mapper-terminated')
        super.terminate()
      }
    }
    const original = window.fetch
    window.fetch = async (...args) => {
      const route = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), location.href).pathname
      if (!route.startsWith('/api/v1/sync/')) return original(...args)
      // Remove transport identities and query values before any observation leaves the page
      const detail = { route: route.replace(/(\/uploads|\/mutations|\/revisions|\/blobs)\/[^/]+/g, '$1/:id'), method: args[1]?.method ?? (args[0] instanceof Request ? args[0].method : 'GET') }
      record('fetch-start', detail)
      try { const response = await original(...args); record('fetch-finished', { ...detail, status: response.status }); return response }
      catch (error) { record('fetch-failed', detail); throw error }
    }
  })
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
  recoveryPhase = 'install-upload-gate'
  await page.evaluate(() => {
    const original = window.fetch, gate: { arrived: boolean; release?: () => void } = { arrived: false }
    const held = new Promise<void>(resolve => { gate.release = resolve })
    Object.assign(window, { statusUploadGate: gate })
    window.fetch = async (...args) => {
      const response = await original(...args)
      if (String(args[0]).endsWith('/sync/uploads') && !gate.arrived) { gate.arrived = true; window.statusRecoveryDiagnostics.record('gate-arrived'); await held }
      return response
    }
    Object.assign(gate, { restore: () => { window.fetch = original; gate.release!() } })
  })
  try {
    recoveryPhase = 'check-first-tile'
    await tile.check()
    recoveryPhase = 'await-upload-gate'
    await page.waitForFunction(({ interval }) => {
      const gate = (window as unknown as { statusUploadGate: { arrived: boolean; lastObservation?: number } }).statusUploadGate
      // Sample inside the existing predicate so diagnostic page probes never overlap the gate wait
      if (gate.lastObservation === undefined || performance.now() - gate.lastObservation >= interval) { gate.lastObservation = performance.now(); window.statusRecoveryDiagnostics.record('await-upload-gate') }
      return gate.arrived
    }, { interval: STATUS_OBSERVATION_INTERVAL_MS })
    recoveryPhase = 'assert-held-upload'
    await expect(remote).toHaveText('Syncing')
    await expect(status.getByText('Saved on this device', { exact: true })).toBeVisible()
    await expect(tile).toBeEnabled(); await expect(surrounding).toBeEnabled()
    await tile.uncheck(); await tile.check()
    await expect(tile).toBeChecked()
  } finally { await page.evaluate(() => (window as unknown as { statusUploadGate: { restore(): void } }).statusUploadGate.restore()) }
  recoveryPhase = 'offline-save-and-reload'
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
  recoveryPhase = 'reconnect'
  await network.start()
  await context.setOffline(false)
  await page.evaluate(() => { location.hash = '#/settings/account' })
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
  await expect(page.getByText('Online access reconnected.', { exact: true })).toBeVisible()
  recoveryPhase = 'complete'
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
