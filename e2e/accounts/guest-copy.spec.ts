import { loadAccountUpdate } from './workspace-updates'
import { finishAccountSignin } from './signin-helpers'
import { readManagedGuestWorkspace } from '../guest-planner-reader'
import { readEditorContent } from '../../src/workspace/editor-document'
import { prepareAccountProofCache } from './network-fixture'
import { expect, test } from './test-fixture'

const MAX_SYNC_FAILURE_DIAGNOSTICS = 8

// Independent synthetic cases retain the real limiter within each journey
test.beforeEach(async ({ request }) => { expect((await request.post('/__accounts/control/reset-rate-counters', { data: {} })).ok()).toBe(true) })

test('signInNeverUploadsGuestData and explicit saved-draft copy keeps guest originals', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const username = `copy_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  const email = `${username}@example.org`, password = 'synthetic guest copy account password'
  await page.goto('/__accounts-proof/')
  await prepareAccountProofCache(page)
  await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
  await page.evaluate(input => (window as unknown as { accountAuth: typeof import('../../src/account/auth-client') }).accountAuth.registerAccount(input), { email, username, password, remember: false })
  await page.request.post('/__accounts/jobs')
  const emails = await (await page.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
  await page.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find(row => row.recipient === email)!.capability)
  const original = { id: 'copy-browser-editor', filename: 'Private local draft.json', originalText: '{"private":"local"}', draftText: '\ud800unfinished local text' }
  await page.goto('/__accounts-proof/account-workspace.html#/settings/account')
  await page.getByRole('button', { name: 'Continue using this device', exact: true }).click()
  await page.waitForFunction(() => !!(window as unknown as { workspaceProof?: unknown }).workspaceProof)
  await page.evaluate(input => (window as unknown as { workspaceProof: { seedGuestEditor(input: typeof original): Promise<void> } }).workspaceProof.seedGuestEditor(input), original)
  await page.reload()
  await page.waitForFunction(() => !!(window as unknown as { workspaceProof?: unknown }).workspaceProof)
  const guestBefore = await guestEditorContent(page)
  await page.getByRole('button', { name: 'Account', exact: true }).first().click()
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Choose what to keep', exact: true })).toBeVisible({ timeout: 60_000 })
  // Baseline account publication is allowed; the private guest draft is not selected before review
  expect(await guestEditorContent(page)).toEqual(guestBefore)
  await finishAccountSignin(page)
  await page.getByRole('button', { name: 'Account', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: `Signed in as ${username}`, exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Copy local work', exact: true }).click()
  const preview = page.getByRole('region', { name: 'Copy local work' })
  await preview.getByText('Preparing local copy...', { exact: true }).waitFor({ state: 'hidden', timeout: 30_000 })
  await expect(preview.getByRole('heading', { name: 'Choose local records' })).toBeVisible()
  expect(await preview.getByRole('checkbox').evaluateAll(inputs => inputs.filter(input => (input as HTMLInputElement).checked).length)).toBe(0)
  await preview.getByRole('checkbox', { name: 'Private local draft.json', exact: true }).check()
  await preview.getByText('Preparing local copy...', { exact: true }).waitFor({ state: 'hidden', timeout: 30_000 })
  await expect(preview.getByRole('checkbox', { name: /Exact inherited workspace originals/ })).toHaveCount(0)
  await expect(preview.getByRole('button', { name: 'Copy selected work' })).toBeEnabled()
  const started = Date.now(), responses: Record<string, number> = {}, failures: unknown[] = [], pendingDiagnostics: Promise<void>[] = []
  let firstResponseMs: number | undefined, lastResponseMs: number | undefined, durableMs: number | undefined
  const runtimeBefore = await (await page.request.get('/__accounts/measurement')).json()
  page.on('response', response => {
    if (!response.url().includes('/api/v1/sync/')) return
    firstResponseMs ??= Date.now() - started; lastResponseMs = Date.now() - started
    const key = `${new URL(response.url()).pathname.replace(/(\/uploads|\/mutations|\/revisions)\/[^/]+/g, '$1/:id')}:${response.status()}`
    responses[key] = (responses[key] ?? 0) + 1
    if (!response.ok() && pendingDiagnostics.length < MAX_SYNC_FAILURE_DIAGNOSTICS) {
      const atMs = Date.now() - started
      pendingDiagnostics.push(response.json().then((body: { error?: { code?: string; retryAfterSeconds?: number; continuation?: { processed?: number } } }) => {
        // Record only transport progress and error codes, never ciphertext, identity or credential bodies
        failures.push({ key, atMs, code: body.error?.code, retryAfterSeconds: body.error?.retryAfterSeconds, processed: body.error?.continuation?.processed })
      }, () => { failures.push({ key, atMs, bodyUnavailable: true }) }))
    }
  })
  await test.step('Copy selected work is durable on this device', async () => {
    await preview.getByRole('button', { name: 'Copy selected work' }).click()
    await preview.getByText('Preparing local copy...', { exact: true }).waitFor({ state: 'hidden', timeout: 30_000 })
    await expect(preview.getByRole('status')).toContainText('Copied to this account')
    durableMs = Date.now() - started
  })
  expect(await guestEditorContent(page)).toEqual(guestBefore)
  await test.step('Open the copied account workspace', async () => {
    await page.getByRole('button', { name: 'Builds', exact: true }).first().click()
    await expect(page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: 60_000 })
    await loadAccountUpdate(page)
    await expect(page.getByRole('heading', { name: 'Plan your next Build', exact: true })).toBeVisible()
  })
  const content = await page.evaluate(() => (window as unknown as { workspaceProof: { editorContent(): Promise<{ unfinishedText: string; validation: string }>; inspect(): Promise<{ titles: string[] }> } }).workspaceProof.editorContent())
  expect(content.unfinishedText).toBe(original.draftText)
  expect(content.validation).toBe('unchecked')
  const titles = await page.evaluate(() => (window as unknown as { workspaceProof: { inspect(): Promise<{ titles: string[] }> } }).workspaceProof.inspect())
  expect(titles.titles).toEqual([])
  const waitStartedMs = Date.now() - started
  try { await expect(page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: 60_000 }) }
  finally {
    await Promise.allSettled(pendingDiagnostics)
    const runtimeAfter = await page.request.get('/__accounts/measurement').then(response => response.json()).catch(() => ({ unavailable: true }))
    await testInfo.attach('guest-copy-sync', { body: Buffer.from(JSON.stringify({ totalMs: Date.now() - started, durableMs, waitStartedMs, firstResponseMs, lastResponseMs, responses, failures, runtimeBefore, runtimeAfter }, null, 2)), contentType: 'application/json' })
  }
})

async function guestEditorContent(page: import('@playwright/test').Page) {
  let content: Awaited<ReturnType<typeof readEditorContent>> | undefined
  await readManagedGuestWorkspace(page, async state => {
    const file = state.editorDocuments[0]
    if (!file) throw new Error('Missing synthetic guest editor')
    content = await readEditorContent(state, file)
  })
  if (!content) throw new Error('Missing managed guest workspace')
  return content
}

test('Copy local work opens when account details arrive during a stationary press', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const username = `copy_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  const email = `${username}@example.org`, password = 'synthetic guest copy account password'
  await page.goto('/__accounts-proof/')
  await prepareAccountProofCache(page)
  await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
  await page.evaluate(input => (window as unknown as { accountAuth: typeof import('../../src/account/auth-client') }).accountAuth.registerAccount(input), { email, username, password, remember: false })
  await page.request.post('/__accounts/jobs')
  const emails = await (await page.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
  await page.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find(row => row.recipient === email)!.capability)
  const original = { id: 'copy-browser-editor', filename: 'Private local draft.json', originalText: '{"private":"local"}', draftText: '\ud800unfinished local text' }
  await page.goto('/__accounts-proof/account-workspace.html#/settings/account')
  await page.getByRole('button', { name: 'Continue using this device', exact: true }).click()
  await page.waitForFunction(() => !!(window as unknown as { workspaceProof?: unknown }).workspaceProof)
  await page.evaluate(input => (window as unknown as { workspaceProof: { seedGuestEditor(input: typeof original): Promise<void> } }).workspaceProof.seedGuestEditor(input), original)
  await page.reload()
  await page.waitForFunction(() => !!(window as unknown as { workspaceProof?: unknown }).workspaceProof)
  const guestBefore = await guestEditorContent(page)
  await page.getByRole('button', { name: 'Account', exact: true }).first().click()
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Choose what to keep', exact: true })).toBeVisible({ timeout: 60_000 })
  // Baseline account publication is allowed; the private guest draft is not selected before review
  expect(await guestEditorContent(page)).toEqual(guestBefore)
  await finishAccountSignin(page)

  const region = page.getByRole('region', { name: 'Copy local work' })
  const copy = region.getByRole('button', { name: 'Copy local work', exact: true })
  const gate = '/__accounts/control/response-gate'
  const releaseGate = async () => { expect((await page.request.post('/__accounts/control/release-response')).ok()).toBe(true) }
  let gateReleased = false
  let pointerMayBeDown = false
  let attachGeometry: (() => Promise<void>) | undefined
  try {
    // The fixture can apply the gate before the client receives its acknowledgment
    expect((await page.request.post(gate, { data: { path: '/api/v1/account', phase: 'before-headers' } })).ok()).toBe(true)
    await page.getByRole('button', { name: 'Account', exact: true }).first().click()
    await expect.poll(async () => (await (await page.request.get(gate)).json()).arrived).toBe(true)
    await expect(page.getByRole('heading', { name: 'Account unlocked on this device' })).toBeVisible()
    await expect(copy).toBeEnabled()
    await copy.scrollIntoViewIfNeeded()
    const observer = await copy.evaluateHandle(originalButton => {
      const selector = 'section[aria-label="Copy local work"]'
      const originalRegion = originalButton.closest(selector)!
      const bounds = originalButton.getBoundingClientRect()
      const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
      const category = (node: EventTarget | null) => {
        if (!(node instanceof Node)) return 'outside'
        if (originalButton.contains(node)) return 'original-copy'
        const region = document.querySelector(selector)
        const replacement = Array.from(region?.querySelectorAll('button') ?? []).find(button => button.textContent === 'Copy local work')
        if (replacement?.contains(node)) return 'replacement-copy'
        return region?.contains(node) ? 'in-region' : 'outside'
      }
      const measure = () => {
        const box = originalButton.getBoundingClientRect()
        return {
          rect: { x: box.x, y: box.y, width: box.width, height: box.height },
          scrollTop: document.scrollingElement?.scrollTop, connected: originalButton.isConnected,
          sameRegion: document.querySelector(selector) === originalRegion,
          hit: category(document.elementFromPoint(center.x, center.y)),
        }
      }
      const events: { type: string; target: string; x: number; y: number }[] = []
      const controller = new AbortController()
      const capture = (event: Event) => {
        if (event.isTrusted && event instanceof MouseEvent) events.push({ type: event.type, target: category(event.target), x: event.clientX, y: event.clientY })
      }
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        window.addEventListener(type, capture, { capture: true, passive: true, signal: controller.signal })
      }
      return { center, measure, events, stop: () => controller.abort() }
    })
    const before = await observer.evaluate(value => ({ center: value.center, ...value.measure() }))
    let after: Omit<typeof before, 'center'> | undefined
    attachGeometry = async () => {
      try {
        const events = await observer.evaluate(value => { value.stop(); return value.events })
        await testInfo.attach('copy-pointer-geometry', { body: Buffer.from(JSON.stringify({ before, after, events, cleanupPointerUp: pointerMayBeDown })), contentType: 'application/json' })
      } finally { await observer.dispose() }
    }
    expect(before.hit).toBe('original-copy')
    await page.mouse.move(before.center.x, before.center.y)
    // Native dispatch can press the button before Playwright acknowledges the command
    pointerMayBeDown = true
    await page.mouse.down()
    expect(await observer.evaluate(value => value.events.some(event => event.type === 'pointerdown' && event.target === 'original-copy'))).toBe(true)
    await releaseGate()
    gateReleased = true
    // Keep the pointer at its original center while the actual metadata commit can move the control
    await expect(page.getByRole('heading', { name: `Signed in as ${username}`, exact: true })).toBeVisible()
    after = await observer.evaluate(value => value.measure())
    await page.mouse.up()
    pointerMayBeDown = false
    await region.getByText('Preparing local copy...', { exact: true }).waitFor({ state: 'hidden', timeout: 30_000 })
    await expect(region.getByRole('heading', { name: 'Choose local records' })).toBeVisible()
  } finally {
    // Start both outstanding releases before diagnostic reads or attachment I/O
    const releases: Promise<void>[] = []
    if (!gateReleased) releases.push(releaseGate())
    if (pointerMayBeDown) releases.push(page.mouse.up())
    try {
      for (const result of await Promise.allSettled(releases)) if (result.status === 'rejected') throw result.reason
    } finally { await attachGeometry?.() }
  }
})
