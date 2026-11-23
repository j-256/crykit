import { holdSigninInstallationReply, holdSigninWorkerReply, readSigninInstallation } from './signin-merge-faults'
import { ACCOUNT_PREPARATION_TIMEOUT_MS, beginSeededAccount, mountSeededAccount } from './signin-helpers'
import { expect, test, type Page } from './test-fixture'
const password = 'synthetic reconciliation browser password'
const app = '/__accounts-proof/account-workspace.html'
async function signIn(page: Page, email: string) {
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByLabel('Remember this device', { exact: true }).first().check()
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}
async function guestProgress(page: Page, label: string) {
  await page.goto(`${app}#/settings/account`)
  await page.getByRole('button', { name: 'Continue using this device', exact: true }).click()
  await page.waitForFunction(() => !!(window as any).workspaceProof)
  await page.evaluate(label => (window as any).workspaceProof.seedGuestProgress(label), label)
  await page.reload()
  await page.getByRole('button', { name: 'Account', exact: true }).first().click()
}
async function register(page: Page) {
  await page.goto('/__accounts-proof/')
  await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
  const username = `entry_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`, email = `${username}@example.org`
  await page.evaluate(input => (window as any).accountAuth.registerAccount(input), { email, username, password, remember: false })
  await page.request.post('/__accounts/jobs')
  const emails = await (await page.request.get('/__accounts/emails')).json()
  await page.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find((value: { recipient: string }) => value.recipient === email).capability)
  return email
}
async function reachStandaloneActionByUserScroll(page: Page, action: string) {
  const main = page.getByRole('main'), button = page.getByRole('button', { name: action, exact: true })
  const scrollTop = () => main.evaluate(element => element.scrollTop)
  const inViewport = () => button.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth })
  async function scrollByInput(input: 'wheel' | 'PageUp' | 'PageDown', before: number) {
    const movingAction = await button.elementHandle()
    const controller = new AbortController()
    const moved = (top: number) => input === 'PageUp' ? top < before : top > before
    try {
      if (input === 'wheel') await page.mouse.wheel(0, 1200)
      else await page.keyboard.press(input)
      // The main's rectangle stays fixed while its contents move. A changed offset alone can be mid-animation
      // NaN keeps both numeric assertions pending, even when the pre-input offset is already positive
      const observedOffset = expect.poll(async () => {
        if (!moved(await scrollTop())) return Number.NaN
        await movingAction.waitForElementState('stable', { signal: controller.signal, timeout: 0 })
        const after = await scrollTop()
        return moved(after) ? after : Number.NaN
      })
      if (input === 'PageUp') await observedOffset.toBeLessThan(before)
      else await observedOffset.toBeGreaterThan(0)
    } finally {
      // Cancel any outstanding geometry wait when the numeric assertion reaches its deadline
      controller.abort()
      await movingAction.dispose()
    }
  }
  // Locator clicks can scroll inaccessible content into view, so establish native input access first
  expect(await main.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await page.mouse.move(195, 422)
  await scrollByInput('wheel', await scrollTop())
  const maxScrollSteps = 8
  for (let step = 0; step < maxScrollSteps; step++) {
    const before = await scrollTop()
    if (before === 0) break
    await scrollByInput('PageUp', before)
  }
  await expect.poll(scrollTop).toBe(0)
  await scrollByInput('PageDown', await scrollTop())
  for (let step = 0; step < maxScrollSteps && !await inViewport(); step++) {
    const key = await button.evaluate(element => element.getBoundingClientRect().top < 0) ? 'PageUp' : 'PageDown'
    await scrollByInput(key, await scrollTop())
  }
  await expect.poll(inViewport).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}
test('sign-in merges Progress once across reload and confirms account data on a second device', async ({ page, browser, accountOrigin }, testInfo) => {
  test.setTimeout(240_000)
  const journeyStarted = Date.now()
  const phase = async (name: string) => testInfo.attach(`phase-${name}`, { body: JSON.stringify({ elapsedMilliseconds: Date.now() - journeyStarted }), contentType: 'application/json' })
  const realms = ['before-reload', 'after-reload', 'second-device'] as const
  type Realm = typeof realms[number]
  const attempted = new Set<Realm>()
  let active: { realm: Realm; page: Page; enabled: boolean; startEpochMs: number } | undefined
  async function enable(realm: Realm, target: Page) {
    const startEpochMs = Date.now()
    const enabled = await target.evaluate(() => {
      const proof = (window as any).accountBootstrapProof
      if (!proof?.enableSigninMergeDiagnostics || !proof.readLiveSigninSyncDiagnostics || !proof.stopSigninMergeDiagnostics || !proof.signinMergeDiagnostics || !proof.recordSigninMergeBoundary) return false
      proof.enableSigninMergeDiagnostics()
      return true
    }).catch(() => false)
    active = { realm, page: target, enabled, startEpochMs }
  }
  async function attach(realm: Realm, data: object) {
    attempted.add(realm)
    // A reporter failure during cleanup must preserve the original journey assertion
    await testInfo.attach('signin-diagnostics-' + realm, { body: JSON.stringify({ realm, ...data }), contentType: 'application/json' }).catch(() => {})
  }
  async function collect(reached: boolean) {
    const capture = active
    if (!capture) return
    active = undefined
    const sample = capture.enabled ? await capture.page.evaluate(remote => {
      const proof = (window as any).accountBootstrapProof
      if (remote) proof.recordSigninMergeBoundary('remote-accepted')
      let live = null
      try { live = proof.readLiveSigninSyncDiagnostics() } catch { /* Preserve the historical receipt if live sampling is unavailable */ }
      proof.stopSigninMergeDiagnostics()
      const events = proof.signinMergeDiagnostics().map(({ stage, outcome, elapsedMs, errorCode, resourceFailure, metadata, workerMetadata, workerAccounting, ciphertextObservations }: any) =>
        ({ stage, outcome, elapsedMs, errorCode, resourceFailure, metadata, workerMetadata, workerAccounting, ciphertextObservations }))
      return { events, live }
    }, reached && capture.realm === 'after-reload').catch(() => null) : null
    const events = sample?.events
    const available = !!events?.length
    const worker = events?.at(-1)?.workerAccounting
    const workerReports = !worker ? 'unavailable' : worker.incompleteRequests || worker.startedRequests > worker.reportedRequests ? 'incomplete-at-last-boundary' : 'reported-at-last-boundary'
    await attach(capture.realm, { state: !capture.enabled ? 'enable-unavailable' : !events ? 'read-unavailable' : available ? 'observed' : 'empty',
      reached, live: sample?.live ?? null, workerReports, boundedHistoryAtCapacity: events?.length === 128, incomplete: !reached || !available, counters: available ? 'last-recorded-boundary-only' : 'unavailable',
      startEpochMs: capture.startEpochMs, endEpochMs: Date.now(), events: events ?? [] })
  }
  try {
    const email = await register(page)
    const label = 'Synthetic Progress ' + 'long-name-'.repeat(16)
    await guestProgress(page, label)
    await page.setViewportSize({ width: 390, height: 844 })
    await enable('before-reload', page)
    const started = Date.now()
    await signIn(page, email)
    await expect(page.getByRole('heading', { name: 'Choose what to keep', exact: true })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
    await testInfo.attach('fresh-account-preparation', { body: JSON.stringify({ milliseconds: Date.now() - started, defaultCatalog: true }), contentType: 'application/json' })
    await expect(page.getByText(label, { exact: false }).first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await reachStandaloneActionByUserScroll(page, 'Merge (recommended)')
    await page.getByRole('button', { name: 'Merge (recommended)', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Review your merge', exact: true })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
    await expect(page.getByRole('heading', { name: 'Review your merge', exact: true })).toBeFocused()
    await reachStandaloneActionByUserScroll(page, 'Confirm merge')
    await phase('merge-prepared')
    await collect(true)
    await page.reload()
    await enable('after-reload', page)
    await signIn(page, email)
    await expect(page.getByRole('heading', { name: 'Choose what to keep', exact: true })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
    await page.getByRole('button', { name: 'Merge (recommended)', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Review your merge', exact: true })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
    await expect(page.getByRole('heading', { name: 'Review your merge', exact: true })).toBeFocused()
    await reachStandaloneActionByUserScroll(page, 'Confirm merge')
    await phase('fresh-review-after-reload')
    await page.getByRole('button', { name: 'Confirm merge', exact: true }).click()
    await expect(page.getByRole('complementary', { name: 'Account sync' })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
    const merged = await page.evaluate(() => (window as any).workspaceProof.inspect(false))
    expect(merged.playthroughs).toContainEqual(expect.objectContaining({ label, progress: 1 }))
    await expect(page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
    await expect.poll(() => page.evaluate(async () => (await (window as any).accountBootstrapProof.accountStorage()).pending.length), { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS }).toBe(0)
    await phase('merge-published')
    await collect(true)
    const context = await browser.newContext({ baseURL: accountOrigin, ignoreHTTPSErrors: true })
    const second = await context.newPage()
    try {
      await guestProgress(second, 'Second synthetic device')
      await enable('second-device', second)
      await signIn(second, email)
      await expect(second.getByRole('heading', { name: 'Choose what to keep', exact: true })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
      await phase('second-device-reviewed')
      await second.getByRole('button', { name: 'Use account data on this device', exact: true }).click()
      await expect(second.getByRole('heading', { name: 'Use account data on this device?', exact: true })).toBeVisible()
      await second.getByRole('button', { name: 'Confirm use account data', exact: true }).click()
      await expect(second.getByRole('complementary', { name: 'Account sync' })).toBeVisible()
      expect((await second.evaluate(() => (window as any).workspaceProof.inspect(false))).playthroughs).toContainEqual(expect.objectContaining({ label, progress: 1 }))
      await phase('account-choice-opened')
      await collect(true)
    } finally {
      try { await collect(false) } finally { await context.close() }
    }
  } finally {
    await collect(false)
    for (const realm of realms) if (!attempted.has(realm)) {
      await attach(realm, { state: 'not-entered', reached: false, live: null, incomplete: true, counters: 'unavailable', workerReports: 'unavailable', boundedHistoryAtCapacity: false, events: [] })
    }
  }
})


test('device replacement survives reload and reviews displaced account data for recovery', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const started = Date.now()
  const phase = async (name: string) => testInfo.attach(`phase-${name}`, { body: JSON.stringify({ elapsedMilliseconds: Date.now() - started }), contentType: 'application/json' })
  const email = await register(page)
  const displaced = 'Displaced synthetic account Progress', replacement = 'Replacement synthetic device Progress'
  // Seed only this independent journey's displaced account through the existing pre-mount fixture boundary
  await beginSeededAccount(page, app, email, password, true)
  await page.evaluate(label => (window as any).accountBootstrapProof.seedSigninProgress(label), displaced)
  await mountSeededAccount(page)
  const sync = page.getByRole('complementary', { name: 'Account sync' })
  await expect(sync.getByRole('status')).toHaveText('Synced', { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  await expect.poll(() => page.evaluate(async () => (await (window as any).accountBootstrapProof.accountStorage()).pending.length), { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS }).toBe(0)
  await guestProgress(page, replacement)
  await signIn(page, email)
  await expect(page.getByRole('heading', { name: 'Choose what to keep', exact: true })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  await expect(page.getByText(displaced, { exact: false })).toBeVisible()
  await phase('device-replacement-reviewed')
  await page.getByRole('button', { name: "Replace account data with this device's data", exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Replace account data?', exact: true })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  await page.getByRole('button', { name: 'Confirm replace account data', exact: true }).click()
  await expect(sync).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  expect((await page.evaluate(() => (window as any).workspaceProof.inspect(false))).playthroughs).toEqual([expect.objectContaining({ label: replacement, progress: 1 })])
  await phase('device-replacement-opened')
  await page.reload()
  await expect(sync).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  expect((await page.evaluate(() => (window as any).workspaceProof.inspect(false))).playthroughs).toEqual([expect.objectContaining({ label: replacement, progress: 1 })])
  await phase('replacement-reloaded')
  await page.getByRole('button', { name: 'Account', exact: true }).first().click()
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click()
  await expect(page.getByText('Online access reconnected.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Refresh recovery points', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Download recovery backup', exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: 'Review recovery data', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Choose what to keep', exact: true })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  const recovery = page.getByRole('heading', { name: 'Recovery snapshot', exact: true }).locator('..')
  await expect(recovery).toContainText(displaced)
  await expect(recovery).not.toContainText(replacement)
  await phase('recovery-reviewed')
  await page.getByRole('button', { name: 'Cancel and return to workspace', exact: true }).click()
  await expect(sync).toBeVisible()
  expect((await page.evaluate(() => (window as any).workspaceProof.inspect(false))).playthroughs).toEqual([expect.objectContaining({ label: replacement, progress: 1 })])
})

for (const remember of [true, false]) test(`pending recovery Merge resumes before ordinary sync after ${remember ? 'remembered' : 'locked'} reload`, async ({ page }) => {
  test.setTimeout(240_000)
  const email = await register(page), label = 'Synthetic recovered Progress after reload'
  await beginSeededAccount(page, app, email, password, remember)
  await page.evaluate(() => (window as any).accountBootstrapProof.seedSelectionFixture())
  const pointId = await page.evaluate(label => (window as any).accountBootstrapProof.seedRecoveryProgress(label), label)
  await mountSeededAccount(page)
  const sync = page.getByRole('complementary', { name: 'Account sync' })
  await expect(sync.getByRole('status')).toHaveText('Synced', { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  await expect.poll(() => page.evaluate(async () => (await (window as any).accountBootstrapProof.accountStorage()).pending.length), { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS }).toBe(0)
  await page.getByRole('button', { name: 'Account', exact: true }).first().click()
  await page.getByRole('button', { name: 'Refresh recovery points', exact: true }).click()
  await page.getByRole('button', { name: 'Review recovery data', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Choose what to keep', exact: true })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  await page.getByRole('button', { name: 'Merge (recommended)', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review your merge', exact: true })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  const read = () => page.evaluate(id => (window as any).accountBootstrapProof.recoveryDecision(id), pointId)
  expect((await read()).decision).toBeUndefined()
  await holdSigninInstallationReply(page)
  await page.getByRole('button', { name: 'Confirm merge', exact: true }).click()
  await page.waitForFunction(() => (window as any).signinInstallationCommitted === true, undefined, { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  expect((await readSigninInstallation(page)).pending).toBeDefined()
  const prepared = await read()
  expect(prepared.decision.status).toBe('preparing')
  expect(prepared.journalVersion).toBe(2)
  expect(prepared.pending).toEqual([])
  await page.reload()
  if (!remember) {
    await expect(page.getByRole('heading', { name: 'Account workspace locked', exact: true })).toBeVisible()
    await page.getByLabel('Local password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Unlock on this device', exact: true }).click()
  }
  // Local unlocking restores the pending owner without granting online review authority
  await expect(page.getByRole('heading', { name: 'Choose what to keep', exact: true })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  await expect(sync).toHaveCount(0)
  expect(await read()).toMatchObject({ decision: prepared.decision, active: prepared.active, projection: prepared.projection, pending: [], copies: prepared.copies })
  await page.getByRole('button', { name: 'Reconnect to review', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Review your merge', exact: true })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  expect(await read()).toMatchObject({ decision: prepared.decision, active: prepared.active, projection: prepared.projection, pending: [], copies: prepared.copies })
  await page.getByRole('button', { name: 'Confirm merge', exact: true }).click()
  await expect(sync).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  const completed = await read()
  expect(completed.decision).toEqual({ ...prepared.decision, status: 'complete' })
  expect(completed.activation).toBeDefined()
  expect(completed.copies).toEqual(prepared.copies)
  expect(completed.pending.every((row: { id: string }) => row.id === prepared.decision.copyId)).toBe(true)
  expect((await page.evaluate(() => (window as any).workspaceProof.inspect(false))).playthroughs).toContainEqual(expect.objectContaining({ label, progress: 1 }))
  await page.reload()
  if (!remember) {
    await page.getByLabel('Local password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Unlock on this device', exact: true }).click()
  }
  await expect(sync).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  expect(await read()).toMatchObject({ decision: completed.decision, activation: completed.activation, copies: completed.copies })
})

for (const reply of ['prepare', 'release'] as const) test(`merge worker lost ${reply} reply recovers across reload at its durable boundary`, async ({ page }) => {
  test.setTimeout(240_000)
  const email = await register(page)
  await page.goto(`${app}?fixture-setup=1#/settings/account`)
  await page.waitForFunction(() => !!(window as any).accountBootstrapProof)
  await page.evaluate(() => (window as any).accountBootstrapProof.seedEmptyGuestControl())
  await page.getByRole('button', { name: 'Continue using this device', exact: true }).click()
  await page.waitForFunction(() => !!(window as any).workspaceProof, undefined, { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  await expect(page.getByRole('button', { name: 'Account', exact: true }).first()).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Account', exact: true }).first().click()
  await signIn(page, email)
  await expect(page.getByRole('heading', { name: 'Choose what to keep', exact: true })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  await holdSigninWorkerReply(page, reply)
  await page.getByRole('button', { name: 'Merge (recommended)', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Confirm merge', exact: true })).toBeEnabled({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  const before = await readSigninInstallation(page)
  expect(before.pending).toBeUndefined(); expect(before.reservations).toEqual([])
  await page.getByRole('button', { name: 'Confirm merge', exact: true }).click()
  await page.waitForFunction(reply => (window as any).signinWorkerReplyHeld === reply, reply, { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  const interrupted = await readSigninInstallation(page)
  expect(interrupted.active).toEqual(before.active)
  if (reply === 'prepare') {
    expect(interrupted.pending).toBeUndefined(); expect(interrupted.receipts).toEqual(before.receipts)
    // Confirm refreshes independent remote metadata before issuing worker preparation
    // The authenticated operation inventory, not a global revision count, defines inert output
    const operation = await page.evaluate(() => (window as any).accountBootstrapProof.signinPreparationState((window as any).signinWorkerHeldValue))
    expect(operation).toMatchObject({ exactReservationSet: true, installedOutputs: 0, savedJournal: undefined })
    expect(operation.outputCount).toBeGreaterThan(0); expect(interrupted.reservations.length).toBeGreaterThan(0)
    for (const revision of before.revisions) expect(interrupted.revisions).toContain(revision)
    for (const chunk of before.ciphertext) expect(interrupted.ciphertext).toContainEqual(chunk)
  } else {
    expect(interrupted.pending).toBeDefined(); expect(interrupted.receipts).toHaveLength(1)
    expect(interrupted.reservations).toEqual([]); expect(interrupted.revisions.length).toBeGreaterThan(before.revisions.length)
  }
  await page.reload()
  await signIn(page, email)
  if (reply === 'prepare') {
    await expect(page.getByRole('heading', { name: 'Choose what to keep', exact: true })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
    expect((await readSigninInstallation(page)).reservations).toEqual([])
    await page.getByRole('button', { name: 'Merge (recommended)', exact: true }).click()
  }
  await expect(page.getByRole('button', { name: 'Confirm merge', exact: true })).toBeEnabled({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  await page.getByRole('button', { name: 'Confirm merge', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Account sync' })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  const after = await readSigninInstallation(page)
  expect(after.active.headRevision).toBe(before.active.headRevision + 1)
  expect(after.pending).toBeUndefined(); expect(after.reservations).toEqual([])
  if (reply === 'release') for (const revision of interrupted.revisions) expect(after.revisions).toContain(revision)
})
