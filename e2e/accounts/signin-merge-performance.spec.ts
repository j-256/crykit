import { performance } from 'node:perf_hooks'
import { ApiErrorSchema } from '../../src/account/protocol'
import { expect, test } from './test-fixture'
import { ACCOUNT_PREPARATION_TIMEOUT_MS, assessSigninMergeResponsiveness, installSigninMergeResponsivenessProbe, observeSigninMergeReadback, readSigninMergeResponsivenessProbe, SIGNIN_MERGE_INPUT_TO_PAINT_TARGET_MS, SIGNIN_MERGE_REVIEW_TARGET_MS, SIGNIN_MERGE_INPUT_CADENCE_MS, SIGNIN_MERGE_PREPARATION_PHASES, sampleSigninMergePreparation, assessScheduledSigninMergeInputs, type ScheduledSigninMergeInput } from './signin-helpers'

const app = '/__accounts-proof/account-workspace.html'
const password = 'synthetic merge measurement password'
// Timing cohorts never enable a CPU profiler or change existing readiness/save deadlines
const MEASUREMENT_ENABLED = process.env.CRYKIT_SIGNIN_MERGE_MEASUREMENT === '1'
for (const fixture of ['default-guest', 'empty-control'] as const) test(`complete sign-in merge measurement: ${fixture}`, async ({ page, accountOrigin }, testInfo) => {
  test.skip(!MEASUREMENT_ENABLED, 'Opt-in controlled performance cohort')
  test.setTimeout(240_000)
  const report: any = { fixture, conditions: { measurementVersion: 3, baseline: process.env.CRYKIT_MEASUREMENT_BASELINE === '1', timingEndpoint: 'trusted-click-to-interactive-ready-double-rAF-paint-opportunity', networkScope: 'finished API requests from setup through optional readback; diagnostic only, not complete transfer accounting', preparationPhases: SIGNIN_MERGE_PREPARATION_PHASES, inputCadenceMs: SIGNIN_MERGE_INPUT_CADENCE_MS, browser: testInfo.project.name, browserVersion: page.context().browser()?.version(), origin: accountOrigin, coldContext: true, appModuleCache: 'warm after fixture setup and reload', dataCache: 'fixture read before reload', source: process.env.CRYKIT_MEASUREMENT_SOURCE ?? null, build: process.env.CRYKIT_ACCOUNT_INPUTS ?? null, contention: process.env.CRYKIT_MEASUREMENT_CONTENTION ?? 'unknown', profiler: false }, targets: { reviewMs: SIGNIN_MERGE_REVIEW_TARGET_MS, inputToPaintMs: SIGNIN_MERGE_INPUT_TO_PAINT_TARGET_MS }, phases: [], network: [], workerRealms: [], errors: [], status: 'setup' }
  page.on('worker', worker => {
    const realm: { path: string; startedEpochMs: number; closedEpochMs?: number } = { path: new URL(worker.url()).pathname, startedEpochMs: Date.now() }
    report.workerRealms.push(realm)
    worker.on('close', () => { realm.closedEpochMs = Date.now() })
  })
  const pendingNetwork = new Set<Promise<void>>()
  // CDP command completion precedes renderer handling; native event timestamps bind the scheduled receipts
  // Scheduled wall time and the browser time origin share this controlled host's clock
  const cdp = await page.context().newCDPSession(page)
  const responsivenessSamples: ScheduledSigninMergeInput[] = []
  const samplePreparation = (phase: string, action: () => Promise<void>) => sampleSigninMergePreparation(cdp, phase, responsivenessSamples, action)
  report.responsivenessSamples = responsivenessSamples
  const onFinished = (request: import('@playwright/test').Request) => {
    if (!new URL(request.url()).pathname.startsWith('/api/')) return
    const observedAt = performance.now()
    const pending = (async () => {
      const response = await request.response()
      let errorCode: string | undefined
      if (response && response.status() >= 400) {
        try { const parsed = ApiErrorSchema.safeParse(await response.json()); if (parsed.success) errorCode = parsed.data.error.code } catch { /* Arbitrary response text is private */ }
      }
      report.network.push({ method: request.method(), endpoint: new URL(request.url()).pathname.replace(/(\/(?:uploads|mutations|revisions|devices|shares)\/)[^/]+/g, '$1:id'), timing: request.timing(), observedAt, status: response?.status(), ...(errorCode ? { errorCode } : {}) })
    })().catch(() => { report.errors.push({ phase: 'network-observer', code: 'unavailable' }) }).finally(() => pendingNetwork.delete(pending))
    pendingNetwork.add(pending)
  }
  page.on('requestfinished', onFinished)
  const span = async (name: string, action: () => Promise<void>) => {
    const started = performance.now()
    const value: any = { name, started, outcome: 'pending' }
    report.phases.push(value)
    try { await action(); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); value.outcome = 'complete' }
    catch (error) { value.outcome = 'failed'; throw error }
    finally { value.elapsedMs = performance.now() - started }
  }
  try {
    await page.goto('/__accounts-proof/')
    await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
    const username = `perf_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`, email = `${username}@example.org`
    await page.evaluate(input => (window as any).accountAuth.registerAccount(input), { username, email, password, remember: false })
    await page.request.post('/__accounts/jobs')
    const emails = await (await page.request.get('/__accounts/emails')).json()
    await page.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find((value: { recipient: string }) => value.recipient === email).capability)
    if (fixture === 'empty-control') {
      await page.goto(`${app}?fixture-setup=1#/settings/account`)
      await page.waitForFunction(() => !!(window as any).accountBootstrapProof, undefined, { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
      await page.evaluate(() => (window as any).accountBootstrapProof.seedEmptyGuestControl())
      await page.getByRole('button', { name: 'Continue using this device', exact: true }).click()
    } else {
      await page.goto(`${app}#/settings/account`)
      await page.getByRole('button', { name: 'Continue using this device', exact: true }).click()
      await page.waitForFunction(() => !!(window as any).workspaceProof, undefined, { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
      await page.evaluate(() => (window as any).workspaceProof.seedDefaultGuestProgress())
    }
    await page.waitForFunction(() => !!(window as any).workspaceProof, undefined, { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
    report.before = await page.evaluate(() => (window as any).workspaceProof.signinMergeFixtureSizes())
    expect(report.before.progress).toBeGreaterThan(0)
    if (fixture === 'default-guest') {
      expect(report.before.catalogs).toBeGreaterThan(0)
      expect(report.before.catalogJsonBytes).toBeGreaterThan(1_000_000)
      expect(report.before.history).toBeGreaterThan(0)
    } else {
      expect(report.before).toMatchObject({ catalogs: 0, history: 0, sources: 0, blobs: 0, blobBytes: 0 })
      expect(report.before.catalogJsonBytes).toBe(2)
    }
    // Navigation remounts the provider onto the saved repository before timed authentication
    await page.reload()
    await page.getByRole('button', { name: 'Account', exact: true }).first().click()
    await page.getByLabel('Email', { exact: true }).fill(email)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.evaluate(() => (window as any).accountBootstrapProof.enableSigninMergeDiagnostics())
    await installSigninMergeResponsivenessProbe(page)
    report.status = 'measuring'
    const journeyStarted = performance.now()
    report.journeyStartedEpochMs = Date.now()
    try {
      await span('signin-to-chooser', async () => samplePreparation('signin', async () => {
        await page.getByRole('button', { name: 'Sign in', exact: true }).click()
        await expect(page.getByRole('heading', { name: 'Choose what to keep', exact: true })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
      }))
      await span('merge-to-interactive-review', async () => {
        await samplePreparation('review', async () => {
          await page.getByRole('button', { name: 'Merge (recommended)', exact: true }).click()
          await expect(page.getByRole('button', { name: 'Confirm merge', exact: true })).toBeEnabled({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
        })
      })
      report.pendingInputProbeAtReview = assessSigninMergeResponsiveness(await readSigninMergeResponsivenessProbe(page))
      await span('confirm-to-interactive-local-open', async () => {
        await samplePreparation('confirm', async () => {
          await page.getByRole('button', { name: 'Confirm merge', exact: true }).click()
          await expect(page.getByRole('complementary', { name: 'Account sync' })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
          await expect(page.getByRole('button', { name: 'Account', exact: true }).first()).toBeEnabled()
        })
      })
      await span('local-open-to-remote-accepted', async () => {
        await expect.poll(async () => { report.acceptance = await page.evaluate(() => (window as any).accountBootstrapProof.signinMergeAcceptance()); return report.acceptance.accepted }, { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS }).toBe(true)
        await expect(page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText(/Synced|Conflicting versions/, { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
      })
      await page.evaluate(() => (window as any).accountBootstrapProof.recordSigninMergeBoundary('remote-accepted'))
      report.status = 'complete'
    } finally { report.journeyEndedEpochMs = Date.now(); report.phases.push({ name: 'complete-journey', elapsedMs: performance.now() - journeyStarted, outcome: report.status === 'complete' ? 'complete' : 'failed' }) }
    // Post-timing readback can admit large retained metadata and must not extend the journey span
    report.after = {
      storage: await observeSigninMergeReadback(() => page.evaluate(async () => ({ rootVersion: (await (window as any).accountBootstrapProof.accountStorage()).rootVersion }))),
      workspace: await observeSigninMergeReadback(() => page.evaluate(() => (window as any).workspaceProof.signinMergeFixtureSizes())),
    }
  } catch (error) {
    report.errors.push({ phase: report.status, code: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'assertion-or-runtime-failure' })
    throw error
  } finally {
    page.off('requestfinished', onFinished)
    await Promise.allSettled([...pendingNetwork])
    if (!page.isClosed()) {
      await page.evaluate(() => (window as any).accountBootstrapProof?.stopSigninMergeDiagnostics()).catch(() => {})
      report.diagnostics = await page.evaluate(() => (window as any).accountBootstrapProof?.signinMergeDiagnostics() ?? null).catch(() => null)
      report.responsiveness = await readSigninMergeResponsivenessProbe(page).catch(() => null)
      await page.evaluate(() => (window as any).signinMergeResponsiveness?.stop()).catch(() => {})
    }
    // Late timing delivery can fill an admitted sample, but cannot rescue a missing or off-phase required receipt
    report.pendingInputProbe = report.pendingInputProbeAtReview && report.pendingInputProbeAtReview.receiptStatus !== 'pending'
      ? report.pendingInputProbeAtReview : assessSigninMergeResponsiveness(report.responsiveness ?? null)
    const review = report.phases.find((phase: any) => phase.name === 'merge-to-interactive-review')
    report.budgets = { review: review?.outcome === 'complete' ? review.elapsedMs <= SIGNIN_MERGE_REVIEW_TARGET_MS : null,
      sampledInputToPaint: report.pendingInputProbe.sampledInputToPaint, wholePreparationResponsiveness: null }
    const assessment = assessScheduledSigninMergeInputs(report.responsiveness ?? null, responsivenessSamples)
    Object.assign(report, { scheduledInputReceipts: assessment.scheduledInputReceipts, phaseInputCoverage: assessment.phaseInputCoverage, browserPhases: assessment.browserPhases })
    report.budgets.driverReview = report.budgets.review
    report.budgets.review = assessment.review
    report.budgets.wholePreparationResponsiveness = assessment.wholePreparationResponsiveness
    report.accountingBoundaries = Object.fromEntries(['local-open', 'remote-accepted'].map(stage => {
      const matches = report.diagnostics?.filter((event: any) => event.stage === stage && event.outcome === 'complete') ?? []
      const event = matches.length === 1 ? matches[0] : undefined
      const worker = event?.workerAccounting
      const complete = worker && worker.startedRequests === worker.reportedRequests && worker.incompleteRequests === 0
      return [stage, { status: !event?.metadata ? 'unavailable' : report.conditions.baseline ? 'main-realm-lower-bound' : !complete ? 'incomplete-worker-accounting' : 'available', event: event ?? null }]
    }))
    await testInfo.attach('signin-merge-measurement', { body: JSON.stringify(report), contentType: 'application/json' })
    if (report.status === 'complete' && process.env.CRYKIT_MEASUREMENT_BASELINE !== '1') {
      const final = report.accountingBoundaries['remote-accepted'].event
      expect(report.accountingBoundaries['remote-accepted'].status).toBe('available')
      expect(final?.ciphertextObservations?.worker?.completedPasses, 'Require actual worker observation accounting').toBeGreaterThan(0)
      expect(final?.ciphertextObservations?.main?.completedPasses, 'Require independent main observation accounting').toBeGreaterThan(0)
    }
  }
})

const CONTROL_BLOCK_MS = 500
const CONTROL_BLOCK_START_MS = 25
const CONTROL_READY_MS = 650
for (const blocked of [false, true]) test(`controlled scheduled preparation detects delivery after readiness: ${blocked}`, async ({ page }, testInfo) => {
  test.skip(!MEASUREMENT_ENABLED, 'Opt-in controlled responsiveness oracle')
  await page.setContent('<h1>Choose what to keep</h1><button>Merge (recommended)</button>')
  await installSigninMergeResponsivenessProbe(page)
  await page.evaluate(({ blocked, blockMs, blockStartMs, readyMs }) => {
    const ready = () => { document.querySelector('h1')!.textContent = 'Included records'; document.querySelector('button')!.textContent = 'Confirm merge' }
    document.querySelector('button')!.addEventListener('click', () => {
      document.querySelector('h1')!.textContent = 'Preparing your workspace'
      if (blocked) setTimeout(() => {
        const end = performance.now() + blockMs
        while (performance.now() < end) { /* Deliberate synthetic blocked-renderer negative control */ }
        // The input was scheduled during preparation but its handler sees the ready DOM
        ready()
      }, blockStartMs)
      else setTimeout(ready, readyMs)
    })
  }, { blocked, blockMs: CONTROL_BLOCK_MS, blockStartMs: CONTROL_BLOCK_START_MS, readyMs: CONTROL_READY_MS })
  const cdp = await page.context().newCDPSession(page), samples: ScheduledSigninMergeInput[] = []
  await sampleSigninMergePreparation(cdp, 'review', samples, async () => {
    await page.getByRole('button', { name: 'Merge (recommended)', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Confirm merge', exact: true })).toBeEnabled()
    await page.waitForFunction(() => (window as any).signinMergeResponsiveness.phases.some((phase: any) => phase.name === 'review' && phase.readyEpochMs))
  })
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const probe = await readSigninMergeResponsivenessProbe(page)
  const assessment = assessScheduledSigninMergeInputs(probe, samples, ['review'])
  await testInfo.attach('controlled-scheduled-responsiveness', { body: JSON.stringify({ blocked, samples, probe, assessment }), contentType: 'application/json' })
  expect(assessment.browserPhases[0].status).toBe('complete')
  expect(assessment.wholePreparationResponsiveness).toBe(!blocked)
  if (blocked) {
    expect(probe.paints.some((receipt: any) => !receipt.pendingAtInput)).toBe(true)
    expect(assessment.scheduledInputReceipts.some(receipt => receipt.inPhase && receipt.receiptStatus === 'associated' && receipt.scheduledToPaintOpportunityMs! > SIGNIN_MERGE_INPUT_TO_PAINT_TARGET_MS)).toBe(true)
  }
  await page.evaluate(() => (window as any).signinMergeResponsiveness.stop())
})
