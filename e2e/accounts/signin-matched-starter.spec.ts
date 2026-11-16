import { expect, test } from './test-fixture'
import { prepareMatchedStarter } from './signin-matched-starter'
import { ACCOUNT_PREPARATION_TIMEOUT_MS } from './signin-helpers'

test('matched pre-edit starter setup preserves ordinary Progress history', async ({ page, accountOrigin }, testInfo) => {
  const config = process.env.CRYKIT_MATCHED_STARTER_CONFIG
  test.skip(!config, 'Opt-in immutable starter setup qualification')
  test.setTimeout(ACCOUNT_PREPARATION_TIMEOUT_MS)
  await page.goto('/__accounts-proof/')
  await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
  const username = `starter_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`, email = `${username}@example.org`
  await page.evaluate(input => (window as any).accountAuth.registerAccount(input), { username, email, password: 'synthetic starter setup qualification password', remember: false })
  const fixture = await prepareMatchedStarter(page, testInfo, config!)
  const sizes = await page.evaluate(() => (window as any).workspaceProof.signinMergeFixtureSizes())
  expect(sizes.progress).toBeGreaterThan(0)
  expect(sizes.catalogJsonBytes).toBeGreaterThan(1_000_000)
  expect(sizes.history).toBe(1)
  await page.reload()
  await page.getByRole('button', { name: 'Account', exact: true }).first().waitFor()
  const reopening = await fixture.qualifyReloadPreservation()
  expect(reopening.reloadPreserved).toBe(true)
  await testInfo.attach('matched-starter-setup-qualification', { body: JSON.stringify({ status: 'complete', variant: process.env.CRYKIT_MEASUREMENT_BASELINE === '1' ? 'baseline' : 'candidate', source: process.env.CRYKIT_MEASUREMENT_SOURCE, build: process.env.CRYKIT_ACCOUNT_INPUTS, accountOrigin, ...fixture.evidence, ...reopening, sizes }), contentType: 'application/json' })
})
