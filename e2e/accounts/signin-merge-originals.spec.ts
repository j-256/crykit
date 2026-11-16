import 'fake-indexeddb/auto'
import { expect, test } from './test-fixture'
import { loadAccountUpdate } from './workspace-updates'
import { completeWorkspaceFixture } from './workspace-fixture'
import { beginSeededAccount, mountSeededAccount, finishAccountSignin, ACCOUNT_PREPARATION_TIMEOUT_MS } from './signin-helpers'
import { accountTableDigests, mergeInstallationBoundary, selectedAccountCiphertext } from './signin-qualification-storage'
import { readWorkspaceBackup, exportWorkspaceBackup } from '../../src/interchange/workspace-backup'
import { capturedBackupEvidence, historicalMetadataIdentity, inheritWorkspaceSnapshot } from '../../src/interchange/workspace-backup-evidence'
import { memoryBlob, hashBlob } from '../../src/workspace/blobs'
import { disposeWorkspaceSnapshot } from '../../src/workspace/snapshot'
import { SigninMergeResourceFailureSchema } from '../../src/workspace/signin-merge-protocol'

const app = '/__accounts-proof/account-workspace.html'
const password = 'synthetic complete original merge qualification password'

for (const resource of [false, true]) test(resource ? 'retains imported mod originals through real resource refusal, retry, and local continuation' : 'actual Merge preserves originals across devices and isolates old nested Progress refusal', async ({ page, browser, accountOrigin }, testInfo) => {
  test.skip(process.env.CRYKIT_MANAGED_COMPARISON_QUALIFICATION !== '1', 'Requires explicit synthetic comparison capability')
  test.setTimeout(180_000)
  if (!resource) expect(process.env.CRYKIT_OLD_MAPPING_WORKER_PATH, 'The original preservation journey also requires the immutable old reader assets').toBeTruthy()
  const initial = await completeWorkspaceFixture(), original = await readWorkspaceBackup(memoryBlob(initial.backup).open())
  const metadata = await historicalMetadataIdentity(capturedBackupEvidence(original).current)
  const bodies = await Promise.all(original.state.blobs.map(async body => ({ ref: body.ref, digest: await hashBlob(body.content) })))
  // Give the legacy stream an existing historical identity before any application restore or Merge
  // A fresh v1 current capture may be projected by restore and is a different preservation contract
  const inherited = await inheritWorkspaceSnapshot(original, [original]), chunks: Buffer[] = []
  try { for await (const chunk of exportWorkspaceBackup(inherited)) chunks.push(Buffer.from(chunk)) }
  finally { await disposeWorkspaceSnapshot(inherited); await disposeWorkspaceSnapshot(original) }
  const backup = Buffer.concat(chunks)
  await page.goto('/__accounts-proof/')
  await page.waitForFunction(() => !!(window as any).accountAuth)
  const username = `original_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`, email = `${username}@example.org`
  await page.evaluate(input => (window as any).accountAuth.registerAccount(input), { email, username, password, remember: false })
  await page.request.post('/__accounts/jobs')
  const emails = await (await page.request.get('/__accounts/emails')).json()
  await page.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find((value: { recipient: string }) => value.recipient === email).capability)
  let destinationEvidence: any, destinationPublication: { status: number; heads: number } | undefined
  const destination = await browser.newContext({ baseURL: accountOrigin, ignoreHTTPSErrors: true, serviceWorkers: 'block' })
  try {
    const account = await destination.newPage()
    await beginSeededAccount(account, app, email, password)
    await account.evaluate(() => (window as any).accountBootstrapProof.seedManagedComparisonDestination())
    // An empty settled remote is not proof that the seeded destination ever published
    const publication = account.waitForResponse(response => response.url().endsWith('/sync/commits') && response.ok() && response.request().postDataJSON().heads.length > 0)
    await mountSeededAccount(account)
    const accepted = await publication
    destinationPublication = { status: accepted.status(), heads: accepted.request().postDataJSON().heads.length }
    await expect(account.getByRole('complementary', { name: 'Account sync' }).getByRole('status')).toHaveText('Synced', { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
    await expect.poll(() => account.evaluate(() => (window as any).workspaceProof.signinMergeAcceptance()), { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS }).toMatchObject({ accepted: true })
    if (await account.getByRole('button', { name: 'Load updated data', exact: true }).isVisible()) await loadAccountUpdate(account)
    destinationEvidence = await account.evaluate(() => (window as any).workspaceProof.qualificationEvidence())
    expect(destinationEvidence.progress).toContainEqual(expect.objectContaining({ id: 'account', unlocked: { state: 'known', value: true } }))
    expect(destinationEvidence.editors).toContainEqual(expect.objectContaining({ id: 'editor-1', revision: 0 }))
  } finally { await destination.close() }
  await page.goto(`${app}#/settings/account`)
  await page.getByRole('button', { name: 'Continue using this device', exact: true }).click()
  await page.waitForFunction(() => !!(window as any).workspaceProof)
  expect(await page.evaluate(() => typeof (window as any).accountBootstrapProof?.qualificationScan)).toBe('function')
  if (!resource) expect(await page.evaluate(() => typeof (window as any).workspaceProof?.qualifyOldPublishedProgress)).toBe('function')
  await page.evaluate(() => { location.hash = '#/settings/data' })
  const panel = page.getByRole('region', { name: 'Data & Settings', exact: true })
  await panel.getByLabel('Choose complete workspace backup').setInputFiles({ name: 'synthetic-originals.crykit', mimeType: 'application/octet-stream', buffer: backup })
  await expect(panel.getByText('Complete workspace preview', { exact: true })).toBeVisible()
  await panel.getByLabel('Confirm complete workspace replacement').check()
  const restored = page.waitForEvent('load')
  await panel.getByRole('button', { name: 'Replace saved workspace', exact: true }).click()
  await restored
  await page.waitForFunction(() => !!(window as any).workspaceProof)
  await page.evaluate(() => (window as any).workspaceProof.editConflictFile('Synthetic source draft.json', false, 0xd802))
  await page.reload()
  await page.waitForFunction(() => !!(window as any).workspaceProof)
  await page.evaluate(baseline => (window as any).workspaceProof.seedQualificationChoices(baseline), resource ? 'default' : 'guide')
  await page.reload()
  await page.waitForFunction(() => !!(window as any).workspaceProof)
  const source = await page.evaluate(() => (window as any).workspaceProof.qualificationEvidence())
  expect(source.metadata).toContainEqual({ id: metadata.id, digest: metadata.metadataStreamDigest })
  for (const body of bodies) expect(source.bodies).toContainEqual(body)
  expect(source.setups).toHaveLength(1)
  expect(source.progress).toContainEqual(expect.objectContaining({ unlocked: { state: 'unknown', reason: 'Check later' } }))
  console.info('Qualification source originals and retained legacy stream verified')
  const workers: string[] = []
  page.on('worker', worker => workers.push(new URL(worker.url()).pathname))
  await page.getByRole('button', { name: 'Account', exact: true }).first().click()
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByLabel('Remember this device', { exact: true }).first().check()
  if (resource) await page.evaluate(() => (window as any).accountBootstrapProof.enableSigninMergeDiagnostics())
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Choose what to keep', exact: true })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  await expect(page.getByRole('region', { name: `Account: ${username}`, exact: true })).toContainText('1 Progress record')
  const beforeReview = await mergeInstallationBoundary(page), beforeScan = await page.evaluate(() => (window as any).accountBootstrapProof.qualificationScan())
  const destinationCiphertext = resource ? await selectedAccountCiphertext(page) : undefined
  const destinationOriginals = resource ? await page.evaluate(() => (window as any).accountBootstrapProof.compactCatalogEvidence()) : undefined
  if (resource) {
    const originalRef = destinationEvidence.editors.find((file: any) => file.id === 'editor-1').original
    expect(destinationOriginals.native).toContainEqual({ ref: originalRef, digest: originalRef.sha256 })
  }
  expect(beforeReview.counts.preparationPayloads).toBe(0)
  await page.getByRole('button', { name: 'Merge (recommended)', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Confirm merge', exact: true })).toBeEnabled({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  const afterReview = await mergeInstallationBoundary(page), afterScan = await page.evaluate(() => (window as any).accountBootstrapProof.qualificationScan())
  expect(afterReview.counts.preparationPayloads).toBe(0)
  // Authenticated discovery can refresh only its scan cursor before explicit Confirm
  // Selected heads, projection, decisions, journal, and outbox remain byte-for-byte unchanged
  const withoutScan = (boundary: typeof beforeReview) => ({ ...boundary.protected, syncState: (boundary.protected.syncState as { id: string }[]).filter(row => row.id !== 'scan') })
  expect(withoutScan(afterReview)).toEqual(withoutScan(beforeReview))
  expect(afterScan.state).toEqual(beforeScan.state)
  expect(afterScan.heads).toEqual(beforeScan.heads)
  await testInfo.attach('review-discovery-boundary', { body: JSON.stringify({ beforeReview, afterReview, beforeScan, afterScan }), contentType: 'application/json' })
  expect(workers.some(path => path.includes('signin-merge-worker-'))).toBe(true)
  console.info('Qualification review is interactive; selected state and discovery authority preserved')
  await page.getByRole('button', { name: 'Confirm merge', exact: true }).click()
  if (resource) {
    const observation: any = { fixture: 'default-baseline-imported-mod', source, beforeReview, afterReview, destinationCiphertext, destinationOriginals, retryDepth: 'fresh choices followed by a second real Merge, review, and Confirm' }
    try {
      await expect(page.getByRole('alert')).toContainText('This merge exceeds the background preparation limit', { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
      observation.diagnostics = await page.evaluate(() => (window as any).accountBootstrapProof.signinMergeDiagnostics())
      const terminals = observation.diagnostics.filter((event: any) => event.outcome === 'failed' && event.errorCode === 'resource-limit')
      expect(terminals).toHaveLength(1)
      // The private real-guard receipt measures its counted prefix, not total process memory
      const budget = SigninMergeResourceFailureSchema.parse(terminals[0].resourceFailure)
      expect(budget.value).toBeGreaterThan(budget.limit)
      if (budget.dimension === 'observationBytes') {
        expect(budget.records).toBeGreaterThan(0)
        expect(budget.records).toBeLessThanOrEqual(8192)
      }
      observation.budget = budget
      await page.evaluate(() => (window as any).accountBootstrapProof.stopSigninMergeDiagnostics())
      observation.refused = await mergeInstallationBoundary(page)
      expect(withoutScan(observation.refused)).toEqual(withoutScan(beforeReview))
      observation.refusedCiphertext = await selectedAccountCiphertext(page)
      expect(observation.refusedCiphertext).toEqual(destinationCiphertext)
      observation.refusedOriginals = await page.evaluate(() => (window as any).accountBootstrapProof.compactCatalogEvidence())
      expect(observation.refusedOriginals).toEqual(destinationOriginals)
      // Active preparation can own inert reservations until its failure cleanup has finished
      await expect.poll(async () => (await mergeInstallationBoundary(page)).counts.preparationPayloads, { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS }).toBe(0)
      expect(await selectedAccountCiphertext(page)).toEqual(destinationCiphertext)
      await page.getByRole('button', { name: 'Retry preparation', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Merge (recommended)', exact: true })).toBeEnabled({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
      await expect(page.getByRole('button', { name: 'Retry preparation', exact: true })).toHaveCount(0)
      observation.retried = await mergeInstallationBoundary(page)
      expect(withoutScan(observation.retried)).toEqual(withoutScan(beforeReview))
      expect(observation.retried.counts.preparationPayloads).toBe(0)
      await page.getByRole('button', { name: 'Merge (recommended)', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Confirm merge', exact: true })).toBeEnabled({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
      observation.secondReview = await mergeInstallationBoundary(page)
      expect(withoutScan(observation.secondReview)).toEqual(withoutScan(beforeReview))
      expect(observation.secondReview.counts.preparationPayloads).toBe(0)
      await page.getByRole('button', { name: 'Confirm merge', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('This merge exceeds the background preparation limit', { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
      observation.secondRefused = await mergeInstallationBoundary(page)
      expect(withoutScan(observation.secondRefused)).toEqual(withoutScan(beforeReview))
      observation.secondRefusedCiphertext = await selectedAccountCiphertext(page)
      expect(observation.secondRefusedCiphertext).toEqual(destinationCiphertext)
      observation.secondRefusedOriginals = await page.evaluate(() => (window as any).accountBootstrapProof.compactCatalogEvidence())
      expect(observation.secondRefusedOriginals).toEqual(destinationOriginals)
      await expect.poll(async () => (await mergeInstallationBoundary(page)).counts.preparationPayloads, { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS }).toBe(0)
      expect(await selectedAccountCiphertext(page)).toEqual(destinationCiphertext)
      await page.getByRole('button', { name: 'Cancel and return to workspace', exact: true }).click()
      await page.waitForFunction(() => !!(window as any).workspaceProof)
      const continued = await page.evaluate(() => (window as any).workspaceProof.qualificationEvidence())
      expect(continued).toEqual(source)
      observation.continued = await mergeInstallationBoundary(page)
      expect(withoutScan(observation.continued)).toEqual(withoutScan(beforeReview))
      expect(observation.continued.counts.preparationPayloads).toBe(0)
      observation.continuedCiphertext = await selectedAccountCiphertext(page)
      expect(observation.continuedCiphertext).toEqual(destinationCiphertext)
      observation.retryReturnedToChoices = true; observation.localOriginalsPreserved = true
    } finally {
      observation.diagnostics ??= await page.evaluate(() => (window as any).accountBootstrapProof.signinMergeDiagnostics())
      await page.evaluate(() => (window as any).accountBootstrapProof.stopSigninMergeDiagnostics())
      await testInfo.attach('actual-imported-mod-resource-refusal', { body: JSON.stringify(observation), contentType: 'application/json' })
    }
    return
  }
  await expect(page.getByRole('complementary', { name: 'Account sync' })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
  await expect.poll(() => page.evaluate(() => (window as any).workspaceProof.signinMergeAcceptance()), { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS }).toMatchObject({ accepted: true })
  console.info('Qualification Merge opened and sync was accepted')
  await expect(page.getByRole('button', { name: 'Load updated data', exact: true })).toBeVisible()
  await loadAccountUpdate(page)
  const installed = await mergeInstallationBoundary(page)
  const merged = await page.evaluate(() => (window as any).workspaceProof.qualificationEvidence())
  for (const value of source.metadata) expect(merged.metadata).toContainEqual(value)
  for (const value of source.bodies) expect(merged.bodies).toContainEqual(value)
  expect(merged.setups).toEqual(source.setups)
  for (const catalog of source.catalogs) expect(merged.catalogs).toContainEqual(catalog)
  const progress = merged.conflicts.find((entry: any) => entry.key === '["progress","play","account"]')
  expect(progress.branches.map((value: any) => value.unlocked)).toEqual([{ state: 'unknown', reason: 'Check later' }, { state: 'known', value: true }])
  const editor = merged.conflicts.find((entry: any) => entry.key === '["editor","editor-1"]')
  expect(editor.branches.map((value: any) => value.unfinished.text.sha256)).toContain(source.editors.find((file: any) => file.id === 'editor-1').unfinished.text.sha256)
  await page.reload()
  await page.waitForFunction(() => !!(window as any).workspaceProof)
  const reopened = await page.evaluate(() => (window as any).workspaceProof.qualificationEvidence())
  expect(reopened.metadata).toEqual(merged.metadata)
  expect(reopened.bodies).toEqual(merged.bodies)
  expect(reopened.conflicts).toEqual(merged.conflicts)
  const other = await browser.newContext({ baseURL: accountOrigin, ignoreHTTPSErrors: true, serviceWorkers: 'block' })
  try {
    const second = await other.newPage()
    await second.goto(`${app}#/settings/account`)
    await second.getByLabel('Email', { exact: true }).fill(email)
    await second.getByLabel('Password', { exact: true }).fill(password)
    await second.getByRole('button', { name: 'Sign in', exact: true }).click()
    await finishAccountSignin(second)
    await expect.poll(() => second.evaluate(() => (window as any).workspaceProof.signinMergeAcceptance()), { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS }).toMatchObject({ accepted: true })
    if (await second.getByRole('button', { name: 'Load updated data', exact: true }).isVisible()) await loadAccountUpdate(second)
    const downloaded = await second.evaluate(() => (window as any).workspaceProof.qualificationEvidence())
    expect(downloaded.metadata).toEqual(merged.metadata)
    expect(downloaded.bodies).toEqual(merged.bodies)
    expect(downloaded.conflicts).toEqual(merged.conflicts)
    expect(downloaded.setups).toEqual(source.setups)
  } finally { await other.close() }
  const oldBefore = await accountTableDigests(page)
  const oldProgress = await page.evaluate(() => (window as any).workspaceProof.qualifyOldPublishedProgress())
  expect(oldProgress).toMatchObject({ candidateAccepted: true, compatibleControlAccepted: true, oldAccepted: false, bodyAssociationsPreserved: true })
  expect(oldProgress.issues).toContainEqual({ code: 'invalid_value', path: ['progressIdentity', 'version'] })
  expect(await accountTableDigests(page)).toEqual(oldBefore)
  await testInfo.attach('old-nested-progress-version-refusal', { body: JSON.stringify({ ...oldProgress, allAccountTablesUnchanged: true, scope: 'synthetic V1 container around actual published conflict and exact bodies; not a legacy export or startup test' }), contentType: 'application/json' })
  await testInfo.attach('actual-merge-original-preservation', { body: JSON.stringify({ metadata, bodies, source, merged, workers, destinationEvidence, destinationPublication, selectedAfterPublication: installed.protected.profileMeta, localReloadPreserved: true, independentDevicePreserved: true }), contentType: 'application/json' })
})
