import { expect, test, type Page, type BrowserContext } from '@playwright/test'
import type * as auth from '../../src/account/auth-client'

const password = 'synthetic selection sync browser password'
interface SelectionSnapshot { selectedPlaythroughId?: string; planningGameSetupRevisionId?: string; scenarios: Record<string, string>; definitions: string[]; characters: string[] }
interface Proof { seedSelectionFixture(): Promise<unknown>; chooseSelectors(index: number): Promise<unknown>; selectionSnapshot(): Promise<SelectionSnapshot>; saveDefinition(name: string): Promise<unknown>; flushSync(): void }
const proof = (page: Page) => ({ snapshot: () => page.evaluate(() => (window as unknown as { workspaceProof: Proof }).workspaceProof.selectionSnapshot()) })
const status = (page: Page) => page.getByRole('complementary', { name: 'Account sync' }).getByRole('status')
const selectors = ({ selectedPlaythroughId, planningGameSetupRevisionId, scenarios }: SelectionSnapshot) => ({ selectedPlaythroughId, planningGameSetupRevisionId, scenarios })
async function signIn(page: Page, email: string, seed = false, waitForProjection = true) {
  await page.goto('/__accounts-proof/account-workspace.html#/settings/account')
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open account workspace' })).toBeVisible()
  if (seed) await page.evaluate(() => (window as unknown as { accountBootstrapProof: Proof }).accountBootstrapProof.seedSelectionFixture())
  const applied = waitForProjection ? page.evaluate(() => new Promise<void>(resolve => window.addEventListener('crykit-account-sync-applied', () => resolve(), { once: true }))) : Promise.resolve()
  await page.getByRole('button', { name: 'Open account workspace' }).click()
  await applied
  await expect(status(page)).toHaveText('Synced')
}
async function flush(page: Page) { await page.evaluate(() => (window as unknown as { workspaceProof: Proof }).workspaceProof.flushSync()) }
async function publish(page: Page, action: () => Promise<unknown>) {
  const response = page.waitForResponse(response => response.url().endsWith('/sync/commits') && response.ok() && response.request().postDataJSON().heads.length > 0)
  await action(); await flush(page); await response; await expect(status(page)).toHaveText('Synced')
}
test.describe.serial('remote projection respects local interaction', () => {
  let a: Page, b: Page, ca: BrowserContext, cb: BrowserContext, email: string, selectedA: SelectionSnapshot, selectedB: SelectionSnapshot
  test.beforeAll(async ({ browser, baseURL }) => {
    ca = await browser.newContext({ baseURL }); cb = await browser.newContext({ baseURL }); a = await ca.newPage(); b = await cb.newPage()
    await a.goto('/__accounts-proof/'); await expect(a.locator('#status')).toHaveText('Browser worker and offline cache ready')
    const username = `selectors_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`; email = `${username}@example.org`
    await a.evaluate(input => (window as unknown as { accountAuth: typeof auth }).accountAuth.registerAccount(input), { email, username, password, remember: false })
    await a.request.post('/__accounts/jobs')
    const emails = await (await a.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
    await a.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find(value => value.recipient === email)!.capability)
    await signIn(a, email, true)
  })
  test.afterAll(async () => { await ca?.close(); await cb?.close() })
  test('distinctSelectionsPersistOnBothActualDevices', async () => {
    await publish(a, () => a.evaluate(() => (window as unknown as { workspaceProof: Proof }).workspaceProof.chooseSelectors(0)))
    selectedA = await proof(a).snapshot()
    await signIn(b, email)
    await publish(b, () => b.evaluate(() => (window as unknown as { workspaceProof: Proof }).workspaceProof.chooseSelectors(1)))
    selectedB = await proof(b).snapshot()
    expect(selectedB.selectedPlaythroughId).not.toBe(selectedA.selectedPlaythroughId)
    expect(selectedB.planningGameSetupRevisionId).not.toBe(selectedA.planningGameSetupRevisionId)
    for (const id of Object.keys(selectedA.scenarios)) expect(selectedB.scenarios[id]).not.toBe(selectedA.scenarios[id])
    await flush(a); await expect(status(a)).toHaveText('Synced')
    expect(selectors(await proof(a).snapshot())).toEqual(selectors(selectedA))
  })
  test('typedFormSurvivesAnActualRemoteArrivalAndRetainsDeviceSelectors', async () => {
    // Reopen through the real profile/provider so fixture selector writes become the mounted App's initial state
    await signIn(b, email, false, false)
    await b.evaluate(() => { window.location.hash = '#/characters' })
    await expect(b.getByRole('button', { name: 'Playthrough: Second local journey', exact: true })).toBeVisible()
    await expect(b.getByRole('button', { name: 'Party plan: Second local scenario', exact: true })).toBeVisible()
    await b.getByRole('button', { name: 'Add character', exact: true }).click()
    await b.getByLabel('Character name').fill('Typed local value awaiting decision')
    await publish(a, () => a.evaluate(() => (window as unknown as { workspaceProof: Proof }).workspaceProof.saveDefinition('Arrived while typing')))
    await flush(b)
    await expect(status(b)).toHaveText('Sync paused')
    await expect(b.getByLabel('Character name')).toHaveValue('Typed local value awaiting decision')
    const held = await proof(b).snapshot()
    expect(held.definitions).not.toContain('Arrived while typing')
    expect(selectors(held)).toEqual(selectors(selectedB))
    expect(selectors(await proof(a).snapshot())).toEqual(selectors(selectedA))
  })
  test('explicitDiscardAndRetryAppliesRemoteContentWithoutChangingLocalSelections', async ({}, testInfo) => {
    await b.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(b.getByLabel('Character name')).toHaveCount(0)
    await b.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(status(b)).toHaveText('Synced')
    await expect.poll(async () => (await proof(b).snapshot()).definitions).toContain('Arrived while typing')
    await expect(b.getByRole('button', { name: 'Playthrough: Second local journey', exact: true })).toBeVisible()
    await expect(b.getByRole('button', { name: 'Party plan: Second local scenario', exact: true })).toBeVisible()
    const applied = await proof(b).snapshot()
    expect(selectors(applied)).toEqual(selectors(selectedB))
    expect(applied.characters).not.toContain('Typed local value awaiting decision')
    await testInfo.attach('actual-provider-selection-and-form-evidence', { body: JSON.stringify({ deviceA: selectors(selectedA), deviceB: selectors(selectedB), applied: selectors(applied), typedFieldPreservedUntilExplicitDiscard: true, remoteAppliedAfterRetry: true }), contentType: 'application/json' })
  })
})
