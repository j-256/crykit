import { expectOfflineReady } from '../offline-helpers'
import { skipInitialModSetup } from '../local-data-helpers'
import { expect, test } from '@playwright/test'
import type { LocalData } from '../../src/domain/types'
import type { PublicShare } from '../../src/account/shares-protocol'

type Proof = { teamState(): Promise<LocalData>; seedTeamFixture(account?: boolean, publicSharing?: Record<string, string>): Promise<void> }
const app = '/__accounts-proof/account-workspace.html'
const privateValues = { effect: 'PRIVATE_EFFECT_T28', filename: 'PRIVATE_FILE_T28.json', artwork: 'PRIVATE_ART_T28', source: 'PRIVATE_SOURCE_T28', allocation: 'PRIVATE_ALLOCATION_T28', note: 'PRIVATE_NOTE_T28' }
const secrets = Object.values(privateValues)

test('hosted owner, recipient and anonymous lifecycle keeps private drafts and copies isolated', async ({ page, browser, context }) => {
  test.setTimeout(120_000)
  await page.goto('/__accounts-proof/')
  await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
  const recipientContext = await browser.newContext(), recipient = await recipientContext.newPage()
  const origin = new URL(page.url()).origin
  // Preserve the existing readiness bound and initialize caches before account sync starts
  await recipient.goto(`${origin}/__accounts-proof/`)
  await expect(recipient.locator('#status')).toHaveText('Browser worker and offline cache ready')
  await recipient.goto(`${origin}/#/settings/storage`)
  await skipInitialModSetup(recipient)
  const storage = recipient.getByRole('dialog', { name: 'Data & settings', exact: true })
  await storage.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expectOfflineReady(storage)
  const username = `host_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`, email = `${username}@example.org`, password = 'synthetic hosted publication password'
  await page.evaluate(input => (window as unknown as { accountAuth: typeof import('../../src/account/auth-client') }).accountAuth.registerAccount(input), { email, username, password, remember: false })
  await page.request.post('/__accounts/jobs')
  const emails = await (await page.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
  await page.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find(value => value.recipient === email)!.capability)
  await page.goto(`${app}#/settings/account`)
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open account workspace', exact: true })).toBeVisible()
  await page.evaluate(values => (window as unknown as { accountBootstrapProof: Proof }).accountBootstrapProof.seedTeamFixture(true, values), privateValues)
  await page.getByRole('button', { name: 'Open account workspace', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  const before = await page.evaluate(() => (window as unknown as { workspaceProof: Proof }).workspaceProof.teamState())
  await page.getByRole('button', { name: 'Teams', exact: true }).click()
  await page.locator('.team-list-card').filter({ has: page.getByRole('heading', { name: 'Portable Team', exact: true }) }).getByRole('button', { name: 'Open Team', exact: true }).click()
  await page.getByRole('button', { name: 'Share team', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Share team', exact: true })
  await expect(dialog.getByRole('checkbox', { name: 'Include written notes' })).not.toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: 'Include my public screen name' })).not.toBeChecked()
  await dialog.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(dialog.getByText('Hosted link published.', { exact: true })).toBeVisible()
  const url = await dialog.getByLabel('Hosted URL', { exact: true }).inputValue(), shareId = new URL(url).hash.slice(4)
  expect(url).toBe(`${origin}/#/s/${shareId}`)
  expect(shareId).toMatch(/^[A-Za-z0-9_-]{22}$/)
  const read = async () => {
    const response = await recipient.request.get(`${origin}/api/public/v1/shares/${shareId}`)
    expect(response.headers()['cache-control']).toContain('no-store')
    expect(response.headers()['x-robots-tag']).toContain('noindex')
    return response
  }
  const first = await (await read()).json() as PublicShare
  expect(first.revision).toBe(1)
  expect(first.attribution).toBeUndefined()
  for (const secret of [...secrets, email, before.id, 'public-team']) expect(JSON.stringify(first)).not.toContain(secret)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await dialog.getByRole('button', { name: 'Copy hosted link', exact: true }).click()
  await expect(dialog.getByText('Hosted link copied.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url)
  await recipient.goto(url)
  await expect(recipient.getByRole('heading', { name: 'Portable Team', exact: true })).toBeVisible()
  await expect(recipient.getByText('Empty slot', { exact: true })).toHaveCount(2)
  for (const secret of [...secrets, email]) expect(await recipient.locator('body').textContent()).not.toContain(secret)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  expect(await page.evaluate(() => (window as unknown as { workspaceProof: Proof }).workspaceProof.teamState())).toEqual(before)
  await page.getByRole('button', { name: 'Edit Team', exact: true }).click()
  await page.getByRole('button', { name: 'Move slot 2 left', exact: true }).click()
  expect(await (await read()).json()).toEqual(first)
  await page.getByRole('button', { name: 'Save Team', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Team checkpoint', exact: true }).getByRole('option')).toHaveCount(2)
  expect(await (await read()).json()).toEqual(first)
  await page.getByRole('button', { name: 'Share team', exact: true }).click()
  await dialog.getByLabel('Published link', { exact: true }).selectOption(shareId)
  await dialog.getByRole('checkbox', { name: 'Include my public screen name' }).check()
  await page.request.post('/__accounts/control/faults', { data: ['shares.publish.before-batch'] })
  await dialog.getByRole('button', { name: 'Update shared version', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Retry publication request', exact: true })).toBeVisible()
  expect(await (await read()).json()).toEqual(first)
  await dialog.getByRole('button', { name: 'Retry publication request', exact: true }).click()
  await expect(dialog.getByText('Shared version updated.', { exact: true })).toBeVisible()
  const second = await (await read()).json() as PublicShare
  expect(second.revision).toBe(2)
  expect(second.snapshot.slots.map(Boolean)).toEqual([false, true, true, false])
  expect(second.attribution).toEqual({ username })
  await recipient.reload()
  await expect(recipient.getByText(`Shared by ${username}`, { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  const teamHash = new URL(page.url()).hash
  await page.goto(`${app}#/settings/account`)
  const renamed = `ren_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`
  await page.getByLabel('Public screen name', { exact: true }).fill(renamed)
  await page.getByRole('button', { name: 'Change screen name', exact: true }).click()
  await expect(page.getByText('Public screen name changed.', { exact: true })).toBeVisible()
  await recipient.reload()
  await expect(recipient.getByText(`Shared by ${renamed}`, { exact: true })).toBeVisible()
  expect((await page.request.post('/__accounts/control/withhold-screen-name', { data: { username: renamed } })).status()).toBe(200)
  await recipient.reload()
  await expect(recipient.getByRole('heading', { name: 'Portable Team', exact: true })).toBeVisible()
  await expect(recipient.getByText(`Shared by ${renamed}`, { exact: true })).toHaveCount(0)
  expect((await (await read()).json()).attribution).toBeUndefined()
  await page.goto(`${app}${teamHash}`)
  await page.getByRole('button', { name: 'Share team', exact: true }).click()
  await dialog.getByLabel('Published link', { exact: true }).selectOption(shareId)
  await expect(dialog.getByRole('checkbox', { name: 'Include my public screen name' })).not.toBeChecked()
  await dialog.getByRole('button', { name: 'Stop sharing', exact: true }).click()
  await expect(dialog.getByText('Sharing stopped. This hosted link is unavailable.', { exact: true })).toBeVisible()
  expect((await read()).status()).toBe(404)
  await recipient.reload()
  await expect(recipient.getByText('Shared snapshot unavailable', { exact: true })).toBeVisible()
  await expect(recipient.getByRole('heading', { name: 'Portable Team', exact: true })).toHaveCount(0)
  await recipientContext.setOffline(true)
  await recipient.reload()
  await expect(recipient.getByText('Shared snapshot unavailable', { exact: true })).toBeVisible()
  await recipientContext.setOffline(false)
  await dialog.getByLabel('Published link', { exact: true }).selectOption('')
  await dialog.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(dialog.getByText('Hosted link published.', { exact: true })).toBeVisible()
  expect(await dialog.getByLabel('Hosted URL', { exact: true }).inputValue()).not.toBe(url)
  for (const cachePage of [page, recipient]) {
    const cached = await cachePage.evaluate(async () => {
      const values: string[] = []
      for (const key of await caches.keys()) { const cache = await caches.open(key); for (const request of await cache.keys()) { values.push(request.url); const response = await cache.match(request); if (response) values.push(await response.text()) } }
      return values.join('\n')
    })
    expect(cached.length).toBeGreaterThan(0)
    for (const secret of [...secrets, email, `/api/public/v1/shares/${shareId}`]) expect(cached).not.toContain(secret)
  }
  await recipientContext.close()
})
