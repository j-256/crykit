import { createHash } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, test } from './test-fixture'
import { beginSeededAccount, mountSeededAccount, finishAccountSignin, ACCOUNT_PREPARATION_TIMEOUT_MS } from './signin-helpers'
import { loadAccountUpdate } from './workspace-updates'

const app = '/__accounts-proof/account-workspace.html'
const password = 'synthetic managed comparison qualification password'

async function publishManagedDestination(page: Page) {
  await page.evaluate(() => (window as any).accountBootstrapProof.seedManagedComparisonDestination())
  // Empty initial catch-up can be accepted before any authored destination values publish
  const publication = page.waitForResponse(response => response.url().endsWith('/sync/commits') && response.ok() && response.request().postDataJSON().heads.length > 0, { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  await mountSeededAccount(page)
  const accepted = await publication
  await expect(page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  await expect.poll(() => page.evaluate(() => (window as any).workspaceProof.signinMergeAcceptance()), { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS }).toMatchObject({ accepted: true, pending: 0 })
  if (await page.getByRole('button', { name: 'Load updated data', exact: true }).isVisible()) await loadAccountUpdate(page)
  const evidence = await page.evaluate(() => (window as any).workspaceProof.qualificationEvidence())
  expect(evidence.progress).toContainEqual(expect.objectContaining({ id: 'account', unlocked: { state: 'known', value: true } }))
  expect(evidence.editors).toContainEqual(expect.objectContaining({ id: 'editor-1', revision: 0 }))
  return { status: accepted.status(), heads: accepted.request().postDataJSON().heads.length, evidence }
}

test('qualifies managed comparisons against an immutable old local reader', async ({ page, context, accountOrigin }, testInfo) => {
  test.skip(process.env.CRYKIT_MANAGED_COMPARISON_QUALIFICATION !== '1' || !process.env.CRYKIT_OLD_MAPPING_WORKER_PATH, 'Requires explicit synthetic candidate and immutable old assets')
  test.setTimeout(180_000)
  await page.goto('/__accounts-proof/')
  await page.waitForFunction(() => !!(window as any).accountAuth)
  const username = `compare_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`, email = `${username}@example.org`
  await page.evaluate(input => (window as any).accountAuth.registerAccount(input), { email, username, password, remember: false })
  await page.request.post('/__accounts/jobs')
  const emails = await (await page.request.get('/__accounts/emails')).json()
  await page.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find((value: { recipient: string }) => value.recipient === email).capability)
  await beginSeededAccount(page, app, email, password)
  await publishManagedDestination(page)
  // Both entry pages use this exact origin and BrowserContext, so they share the account IndexedDB
  // Service workers are blocked by the dedicated qualification context; immutable hashed imports stay distinct
  const old = await context.newPage()
  await beginSeededAccount(old, '/__accounts-proof/old-account-workspace.html', email, password)
  await mountSeededAccount(old)
  await old.evaluate(() => (window as any).workspaceProof.queueDefinition('Rejected old stale edit'))
  // The candidate remains unmounted during local activation, keeping publication a separate observed boundary
  await beginSeededAccount(page, app, email, password)
  const staged = await page.evaluate(() => (window as any).accountBootstrapProof.stageManagedComparisonFixture())
  expect(staged).toMatchObject({ version: 2, status: 'unmapped-local' })
  const before = await page.evaluate(() => (window as any).accountBootstrapProof.comparisonStorageDigests())
  const oldSchema = await page.evaluate(copyId => (window as any).accountBootstrapProof.qualifyOldIntentSchema('/__accounts-proof/assets/account-graph-BJ7RvXuw.js', 'm', copyId), staged.copyId)
  expect(oldSchema).toMatchObject({ copyId: staged.copyId, candidateAccepted: true, oldAccepted: false, oldV1ControlAccepted: true })
  expect(oldSchema.issues).toContainEqual({ code: 'invalid_value', path: ['version'] })
  const refused = await page.evaluate(input => (window as any).accountBootstrapProof.qualifyOldComparisonWorker(input.path, input.copyId), { path: process.env.CRYKIT_OLD_MAPPING_WORKER_PATH!, copyId: staged.copyId })
  expect(refused).toBe('failed')
  expect(await page.evaluate(() => (window as any).accountBootstrapProof.comparisonStorageDigests())).toEqual(before)
  const stale = await old.evaluate(() => (window as any).workspaceProof.releaseQueued())
  expect(stale).toBe('The managed account changed')
  expect(await page.evaluate(() => (window as any).accountBootstrapProof.comparisonStorageDigests())).toEqual(before)
  const localOriginals = await page.evaluate(() => (window as any).accountBootstrapProof.managedComparisonOriginals())
  expect(localOriginals.originals).toHaveLength(1)
  await old.reload()
  await expect(old.getByRole('heading', { name: 'Account workspace locked', exact: true })).toBeVisible()
  await beginSeededAccount(old, '/__accounts-proof/old-account-workspace.html', email, password)
  await old.evaluate(() => (window as any).accountBootstrapProof.mount())
  await expect(old.getByText('Online access connected.', { exact: true })).toBeVisible()
  await expect(old.getByRole('heading', { name: 'Account workspace locked', exact: true })).toBeVisible()
  expect(await old.evaluate(() => !!(window as any).workspaceProof)).toBe(false)
  expect(await page.evaluate(() => (window as any).accountBootstrapProof.comparisonStorageDigests())).toEqual(before)
  expect((await page.evaluate(() => (window as any).accountBootstrapProof.managedComparisonOriginals())).originals).toEqual(localOriginals.originals)
  await old.close()
  await testInfo.attach('old-local-qualification', { body: JSON.stringify({ origin: accountOrigin, staged, oldMapping: refused, oldStaleSave: stale, oldSchema, oldFreshOpen: 'locked-after-authentication-cause-inconclusive', accountTableDigestsPreserved: true, oldSavedTransportQualified: false }), contentType: 'application/json' })
})

test('publishes managed comparisons and preserves originals on an independent device', async ({ page, browser, accountOrigin }, testInfo) => {
  test.skip(process.env.CRYKIT_MANAGED_COMPARISON_QUALIFICATION !== '1', 'Requires explicit synthetic candidate')
  test.setTimeout(180_000)
  await page.goto('/__accounts-proof/')
  await page.waitForFunction(() => !!(window as any).accountAuth)
  const username = `compare_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`, email = `${username}@example.org`
  await page.evaluate(input => (window as any).accountAuth.registerAccount(input), { email, username, password, remember: false })
  await page.request.post('/__accounts/jobs')
  const emails = await (await page.request.get('/__accounts/emails')).json()
  await page.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find((value: { recipient: string }) => value.recipient === email).capability)
  await beginSeededAccount(page, app, email, password)
  const destinationPublication = await publishManagedDestination(page)
  await beginSeededAccount(page, app, email, password)
  const staged = await page.evaluate(() => (window as any).accountBootstrapProof.stageManagedComparisonFixture())
  expect(staged).toMatchObject({ version: 2, status: 'unmapped-local' })
  expect(staged.conflicts).toEqual(expect.arrayContaining(['["progress","play","account"]', '["editor","editor-1"]']))
  expect(staged.progressMappings).toContainEqual({ version: 1, sourceKey: '["progress","play","local"]', destinationKey: '["progress","play","account"]', equivalent: false })
  const localOriginals = await page.evaluate(() => (window as any).accountBootstrapProof.managedComparisonOriginals())
  expect(localOriginals.originals).toHaveLength(1)
  expect(localOriginals.originals[0].state.editorDocuments[0].filename).toBe('incoming.json')
  expect(localOriginals.originals[0].state.planner.localData.playthroughs.play.progress.local.unlocked).toEqual({ state: 'unknown', reason: 'Check later' })
  const sourceEditor = localOriginals.originals[0].state.editorDocuments[0]
  for (const [ref, bytes] of [[sourceEditor.unfinished.text, [66, 0]], [sourceEditor.original, [0, 216]]] as const) {
    expect(localOriginals.originals[0].state.blobs).toContainEqual({ ref, digest: createHash('sha256').update(new Uint8Array(bytes)).digest('hex') })
  }
  // Reopen the staged local account through the product's explicit account choice
  await page.goto(`${app}#/settings/account`)
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await finishAccountSignin(page)
  expect(await page.evaluate(async () => (await fetch('/api/v1/account')).status)).toBe(200)
  try {
    await expect.poll(() => page.evaluate(() => (window as any).workspaceProof.signinMergeAcceptance()), { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS }).toMatchObject({ accepted: true })
  } catch (error) {
    await testInfo.attach('sync-failure-fingerprint', { body: JSON.stringify(await page.evaluate(() => (window as any).workspaceProof.comparisonSyncDiagnostic())), contentType: 'application/json' })
    throw error
  }
  const published = await page.evaluate(() => (window as any).workspaceProof.managedComparisonOriginals())
  expect(published.originals).toEqual(localOriginals.originals)
  expect(published.branches.find((entry: any) => entry.key === '["progress","play","account"]').branches.map((branch: any) => branch.value.unlocked)).toEqual([{ state: 'unknown', reason: 'Check later' }, { state: 'known', value: true }])
  expect(published.branches.find((entry: any) => entry.key === '["editor","editor-1"]').branches.map((branch: any) => branch.bytes)).toEqual([[66, 0], [0, 216]])
  const otherContext = await browser.newContext({ baseURL: accountOrigin, ignoreHTTPSErrors: true, serviceWorkers: 'block' })
  try {
    const second = await otherContext.newPage()
    await second.goto(`${app}#/settings/account`)
    await second.getByLabel('Email', { exact: true }).fill(email)
    await second.getByLabel('Password', { exact: true }).fill(password)
    await second.getByRole('button', { name: 'Sign in', exact: true }).click()
    await finishAccountSignin(second)
    await expect.poll(() => second.evaluate(() => (window as any).workspaceProof.signinMergeAcceptance()), { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS }).toMatchObject({ accepted: true })
    const downloaded = await second.evaluate(() => (window as any).workspaceProof.managedComparisonOriginals())
    expect(downloaded.originals).toEqual(published.originals)
    expect(downloaded.branches).toEqual(published.branches)
  } finally { await otherContext.close() }
  await testInfo.attach('candidate-publication-qualification', { body: JSON.stringify({ origin: accountOrigin, destinationPublication, staged, exactOriginalsOnSecondDevice: true, exactBranchesOnSecondDevice: true }), contentType: 'application/json' })
})
