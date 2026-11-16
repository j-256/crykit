import { expect, test } from './test-fixture'
import { beginSeededAccount, ACCOUNT_PREPARATION_TIMEOUT_MS } from './signin-helpers'
import { mergeInstallationBoundary, selectedAccountCiphertext } from './signin-qualification-storage'
import { SIGNIN_MERGE_LIMITS, SigninMergeResourceFailureSchema } from '../../src/workspace/signin-merge-protocol'

const app = '/__accounts-proof/account-workspace.html'
const password = 'synthetic current-only resource qualification password'

test('retains settled current originals through real resource refusal, retry, and local continuation', async ({ page }, testInfo) => {
  test.skip(process.env.CRYKIT_MANAGED_COMPARISON_QUALIFICATION !== '1', 'Requires explicit synthetic comparison capability')
  test.setTimeout(180_000)
  const observation: any = { fixture: 'settled-current-only-64MiB-destination-small-guest', attempts: [], status: 'setup' }
  try {
    await page.goto('/__accounts-proof/')
    await page.waitForFunction(() => !!(window as any).accountAuth)
    const username = `resource_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`, email = `${username}@example.org`
    await page.evaluate(input => (window as any).accountAuth.registerAccount(input), { email, username, password, remember: false })
    await page.request.post('/__accounts/jobs')
    const emails = await (await page.request.get('/__accounts/emails')).json()
    await page.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find((value: { recipient: string }) => value.recipient === email).capability)
    await beginSeededAccount(page, app, email, password)
    observation.expectedOriginal = await page.evaluate(() => (window as any).accountBootstrapProof.seedCurrentOnlyResourceDestination())
    const publications: { status: number; heads: number }[] = []
    page.on('response', response => {
      if (response.url().endsWith('/sync/commits') && response.ok()) {
        const heads = response.request().postDataJSON()?.heads?.length ?? 0
        if (heads) publications.push({ status: response.status(), heads })
      }
    })
    await expect.poll(async () => {
      const iteration = await page.evaluate(() => (window as any).accountBootstrapProof.syncCatalogOnce())
      const acceptance = await page.evaluate(() => (window as any).accountBootstrapProof.signinMergeAcceptance())
      return { iteration, acceptance, published: publications.some(value => value.status === 200 && value.heads > 0) }
    }, { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS }).toMatchObject({ iteration: { state: 'synced', moreWork: false }, acceptance: { accepted: true }, published: true })
    expect(publications.some(value => value.status === 200 && value.heads > 0)).toBe(true)
    observation.publications = publications
    observation.acceptance = await page.evaluate(() => (window as any).accountBootstrapProof.signinMergeAcceptance())
    observation.preconditions = await page.evaluate(() => (window as any).accountBootstrapProof.currentOnlyResourceEvidence())
    expect(observation.preconditions).toMatchObject({ localInheritedEmpty: true, nativeInheritedEmpty: true })
    expect(observation.preconditions.localBody.original).toEqual(observation.expectedOriginal)
    expect(observation.preconditions.nativeBody.original).toEqual(observation.expectedOriginal)
    expect(observation.preconditions.localBody.digest).toBe(observation.expectedOriginal.sha256)
    expect(observation.preconditions.nativeBody.digest).toBe(observation.expectedOriginal.sha256)
    expect(observation.preconditions.localBody.frame.revisionId).not.toBe(observation.preconditions.nativeBody.frame.revisionId)
    expect(observation.preconditions.localBody.record.payloadId).not.toBe(observation.preconditions.nativeBody.record.payloadId)
    expect(observation.preconditions.distinctBodyCipherBytes).toBeGreaterThan(SIGNIN_MERGE_LIMITS.observationBytes)
    console.info('Resource destination has accepted publication and two distinct installed current body frames')
    // Reload retires the unremembered setup key while preserving this device's settled account storage
    await page.goto(`${app}?fixture-setup=1#/settings/account`)
    await page.waitForFunction(() => !!(window as any).accountBootstrapProof)
    await page.evaluate(() => (window as any).accountBootstrapProof.seedEmptyGuestControl())
    await page.getByRole('button', { name: 'Continue using this device', exact: true }).click()
    await page.waitForFunction(() => !!(window as any).workspaceProof)
    await page.evaluate(() => (window as any).workspaceProof.seedGuestEditor({ id: 'resource-guest-editor', filename: 'Synthetic small guest.json', originalText: '{"original":true}', draftText: '{"unfinished":' }))
    await page.reload()
    await page.waitForFunction(() => !!(window as any).workspaceProof)
    const source = await page.evaluate(() => (window as any).workspaceProof.qualificationEvidence())
    expect(source.editors).toHaveLength(1)
    expect(source.bodies.length).toBeGreaterThan(0)
    observation.source = source
    await page.getByRole('button', { name: 'Account', exact: true }).first().click()
    await page.getByLabel('Email', { exact: true }).fill(email)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByLabel('Remember this device', { exact: true }).first().check()
    await page.evaluate(() => (window as any).accountBootstrapProof.enableSigninMergeDiagnostics())
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Choose what to keep', exact: true })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
    const beforeReview = await mergeInstallationBoundary(page), beforeScan = await page.evaluate(() => (window as any).accountBootstrapProof.qualificationScan())
    const initialAuthority = await page.evaluate(() => (window as any).accountBootstrapProof.resourceProjectionAuthority())
    const syncAuthorityRows = (boundary: typeof beforeReview) => (boundary.protected.syncState as { id: string }[]).filter(row => ['remote', 'projection'].includes(row.id)).sort((left, right) => left.id.localeCompare(right.id))
    expect([...initialAuthority.rows].sort((left, right) => left.id.localeCompare(right.id))).toEqual(syncAuthorityRows(beforeReview))
    expect([initialAuthority.selected]).toEqual(beforeReview.protected.profileMeta)
    const destinationCiphertext = await selectedAccountCiphertext(page)
    const destinationOriginals = await page.evaluate(() => (window as any).accountBootstrapProof.currentOnlyResourceEvidence())
    expect(destinationOriginals).toEqual(observation.preconditions)
    expect(beforeReview.counts.preparationPayloads).toBe(0)
    Object.assign(observation, { beforeReview, initialAuthority, destinationCiphertext, destinationOriginals })
    const withoutScan = (boundary: typeof beforeReview) => ({ ...boundary.protected, syncState: (boundary.protected.syncState as { id: string }[]).filter(row => row.id !== 'scan') })
    // Across Retry only, authenticated cache-page relocation is proved separately below
    // Review and refusal still require exact remote/projection pointers from their own completed chooser
    const outsideRetryCache = (boundary: typeof beforeReview) => ({ ...withoutScan(boundary), syncState: (boundary.protected.syncState as { id: string }[]).filter(row => !['scan', 'remote', 'projection'].includes(row.id)) })
    let reviewBaseline = beforeReview, scanBaseline = beforeScan
    for (let attempt = 0; attempt < 2; attempt++) {
      const evidence: any = { attempt: attempt + 1, status: 'review' }
      observation.attempts.push(evidence)
      await page.getByRole('button', { name: 'Merge (recommended)', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Confirm merge', exact: true })).toBeEnabled({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
      evidence.review = await mergeInstallationBoundary(page)
      expect(evidence.review.counts.preparationPayloads).toBe(0)
      expect(withoutScan(evidence.review)).toEqual(withoutScan(reviewBaseline))
      expect(await selectedAccountCiphertext(page)).toEqual(destinationCiphertext)
      const scan = await page.evaluate(() => (window as any).accountBootstrapProof.qualificationScan())
      expect(scan.state).toEqual(scanBaseline.state)
      expect(scan.heads).toEqual(scanBaseline.heads)
      await page.getByRole('button', { name: 'Confirm merge', exact: true }).click()
      await expect(page.getByRole('alert')).toContainText('This merge exceeds the background preparation limit', { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
      // The trace belongs to coordinator.begin, not each retry on that same coordinator
      // Only the first refusal has numeric accounting; both attempts require real UI refusal and preservation
      if (attempt === 0) {
        evidence.diagnostics = await page.evaluate(() => (window as any).accountBootstrapProof.signinMergeDiagnostics())
        await page.evaluate(() => (window as any).accountBootstrapProof.stopSigninMergeDiagnostics())
        const terminals = evidence.diagnostics.filter((event: any) => event.outcome === 'failed' && event.errorCode === 'resource-limit')
        expect(terminals).toHaveLength(1)
        evidence.budget = SigninMergeResourceFailureSchema.parse(terminals[0].resourceFailure)
        expect(evidence.budget.dimension).toBe('observationBytes')
        expect(evidence.budget.value).toBeGreaterThan(SIGNIN_MERGE_LIMITS.observationBytes)
        expect(evidence.budget.records).toBeGreaterThan(0)
        expect(evidence.budget.records).toBeLessThan(SIGNIN_MERGE_LIMITS.records)
      }
      evidence.refused = await mergeInstallationBoundary(page)
      expect(withoutScan(evidence.refused)).toEqual(withoutScan(reviewBaseline))
      expect(await selectedAccountCiphertext(page)).toEqual(destinationCiphertext)
      evidence.originals = await page.evaluate(() => (window as any).accountBootstrapProof.currentOnlyResourceEvidence())
      expect(evidence.originals).toEqual(destinationOriginals)
      await expect.poll(async () => (await mergeInstallationBoundary(page)).counts.preparationPayloads, { timeout: ACCOUNT_PREPARATION_TIMEOUT_MS }).toBe(0)
      evidence.cleaned = await mergeInstallationBoundary(page)
      expect(withoutScan(evidence.cleaned)).toEqual(withoutScan(reviewBaseline))
      const refusedScan = await page.evaluate(() => (window as any).accountBootstrapProof.qualificationScan())
      expect(refusedScan.state).toEqual(scanBaseline.state)
      expect(refusedScan.heads).toEqual(scanBaseline.heads)
      expect(await selectedAccountCiphertext(page)).toEqual(destinationCiphertext)
      evidence.status = 'refused-originals-preserved-cleaned'
      if (attempt === 0) {
        await page.getByRole('button', { name: 'Retry preparation', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Retry preparation', exact: true })).toHaveCount(0)
        await expect(page.getByRole('heading', { name: 'Choose what to keep', exact: true })).toBeVisible({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
        await expect(page.getByRole('button', { name: 'Merge (recommended)', exact: true })).toBeEnabled({ timeout: ACCOUNT_PREPARATION_TIMEOUT_MS })
        const retried = await mergeInstallationBoundary(page)
        observation.retryAuthority = await page.evaluate(() => (window as any).accountBootstrapProof.resourceProjectionAuthority())
        expect([...observation.retryAuthority.rows].sort((left, right) => left.id.localeCompare(right.id))).toEqual(syncAuthorityRows(retried))
        expect([observation.retryAuthority.selected]).toEqual(retried.protected.profileMeta)
        expect(observation.retryAuthority.selected).toEqual(initialAuthority.selected)
        expect(observation.retryAuthority.authority).toEqual(initialAuthority.authority)
        expect(outsideRetryCache(retried)).toEqual(outsideRetryCache(beforeReview))
        expect(retried.counts.preparationPayloads).toBe(0)
        expect(await selectedAccountCiphertext(page)).toEqual(destinationCiphertext)
        observation.retryOriginals = await page.evaluate(() => (window as any).accountBootstrapProof.currentOnlyResourceEvidence())
        expect(observation.retryOriginals).toEqual(destinationOriginals)
        reviewBaseline = retried
        scanBaseline = await page.evaluate(() => (window as any).accountBootstrapProof.qualificationScan())
        Object.assign(observation, { retryBaseline: reviewBaseline, retryScanBaseline: scanBaseline })
        observation.retryReturnedToChoices = true
      }
    }
    await page.getByRole('button', { name: 'Cancel and return to workspace', exact: true }).click()
    await page.waitForFunction(() => !!(window as any).workspaceProof)
    expect(await page.evaluate(() => (window as any).workspaceProof.qualificationEvidence())).toEqual(source)
    const continued = await mergeInstallationBoundary(page)
    expect(withoutScan(continued)).toEqual(withoutScan(reviewBaseline))
    expect(continued.counts.preparationPayloads).toBe(0)
    expect(await selectedAccountCiphertext(page)).toEqual(destinationCiphertext)
    observation.status = 'complete'; observation.localOriginalsPreserved = true
  } finally {
    await testInfo.attach('current-only-resource-refusal', { body: JSON.stringify(observation), contentType: 'application/json' })
  }
})
