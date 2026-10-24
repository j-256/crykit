import { expect, test } from '@playwright/test'
import type { LocalData } from '../../src/domain/types'
import { decodePublicSnapshot } from '../../src/interchange/public-share'

type Proof = { teamState(): Promise<LocalData>; seedTeamFixture(account?: boolean, publicSharing?: Record<string, string>): Promise<void> }
const app = '/__accounts-proof/account-workspace.html'
const privateValues = { effect: 'PRIVATE_EFFECT_T27', filename: 'PRIVATE_FILE_T27.json', artwork: 'PRIVATE_ART_T27', source: 'PRIVATE_SOURCE_T27', allocation: 'PRIVATE_ALLOCATION_T27', note: 'PRIVATE_NOTE_T27' }
const secrets = ['PRIVATE_EFFECT_T27', 'PRIVATE_FILE_T27', 'PRIVATE_ART_T27', 'PRIVATE_SOURCE_T27', 'PRIVATE_ALLOCATION_T27', 'PRIVATE_NOTE_T27']
for (const account of [false, true]) test(`${account ? 'account' : 'guest'} portable links publish selected receipts only across clipboard, DOM and cache`, async ({ page, browser, context }) => {
  await page.goto('/__accounts-proof/')
  await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
  const recipientContext = await browser.newContext(), recipient = await recipientContext.newPage()
  await recipient.goto(`${new URL(page.url()).origin}/__accounts-proof/`)
  await expect(recipient.locator('#status')).toHaveText('Browser worker and offline cache ready')
  if (account) {
    const username = `pub_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`, email = `${username}@example.org`, password = 'synthetic portable sharing password'
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
  } else {
    await page.goto(`${app}#/builds/library`)
    await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
    await page.evaluate(values => (window as unknown as { workspaceProof: Proof }).workspaceProof.seedTeamFixture(false, values), privateValues)
    await page.reload()
  }
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  let before = await page.evaluate(() => (window as unknown as { workspaceProof: Proof }).workspaceProof.teamState())
  await page.getByRole('button', { name: 'Teams', exact: true }).click()
  await page.locator('.team-list-card').filter({ has: page.getByRole('heading', { name: 'Portable Team', exact: true }) }).getByRole('button', { name: 'Open Team', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Portable Team', exact: true })).toBeVisible()
  const team = before.teams['public-team']!
  if (team.kind !== 'shared') throw new Error('Expected a shared Team')
  const selectedCheckpoint = team.latestRevisionId
  await page.getByRole('button', { name: 'Edit Team', exact: true }).click()
  await page.getByRole('button', { name: 'Move slot 2 left', exact: true }).click()
  await page.getByRole('button', { name: 'Save Team', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Team checkpoint', exact: true }).getByRole('option')).toHaveCount(2)
  before = await page.evaluate(() => (window as unknown as { workspaceProof: Proof }).workspaceProof.teamState())
  expect(before.teams['public-team']).not.toEqual(team)
  await page.getByRole('combobox', { name: 'Team checkpoint', exact: true }).selectOption(selectedCheckpoint)
  await page.getByRole('button', { name: 'Share team', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Share team', exact: true })
  await expect(dialog.getByRole('checkbox', { name: 'Include written notes' })).not.toBeChecked()
  const url = await dialog.getByLabel('Share URL', { exact: true }).inputValue()
  expect(new URL(url).hash).toMatch(/^#\/share\/v5\//)
  const snapshot = decodePublicSnapshot(new URL(url).hash.split('/')[3]!)
  expect(snapshot.slots.map(slot => slot !== null)).toEqual([true, false, true, false])
  expect(snapshot.slots[0]!.equipmentGroups).toEqual([['hand', 'second-hand']])
  for (const secret of secrets) expect(JSON.stringify(snapshot)).not.toContain(secret)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await dialog.getByRole('button', { name: 'Copy link', exact: true }).click()
  await expect(dialog.getByText('Share link copied.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url)
  try {
    await recipient.goto(url)
    await expect(recipient.getByRole('heading', { name: 'Portable Team', exact: true })).toBeVisible()
    await expect(recipient.getByText('Hand: Synthetic sword', { exact: true }).first()).toBeVisible()
    await expect(recipient.getByText('Empty slot', { exact: true })).toHaveCount(2)
    await expect(recipient.getByRole('button', { name: 'Save a copy', exact: true })).toBeVisible()
    for (const secret of secrets) expect(await recipient.locator('body').textContent()).not.toContain(secret)
    for (const cachePage of [page, recipient]) {
      const cached = await cachePage.evaluate(async () => {
        const text: string[] = []
        for (const key of await caches.keys()) { const cache = await caches.open(key); for (const request of await cache.keys()) { const response = await cache.match(request); if (response) text.push(request.url, await response.text()) } }
        return text.join('\n')
      })
      expect(cached.length).toBeGreaterThan(0)
      for (const secret of secrets) expect(cached).not.toContain(secret)
    }
    await recipient.reload()
    await expect(recipient.getByRole('heading', { name: 'Portable Team', exact: true })).toBeVisible()
  } finally { await recipientContext.close() }
  expect(await page.evaluate(() => (window as unknown as { workspaceProof: Proof }).workspaceProof.teamState())).toEqual(before)
  await dialog.getByRole('checkbox', { name: 'Include written notes' }).check()
  const optedIn = decodePublicSnapshot(new URL(await dialog.getByLabel('Share URL', { exact: true }).inputValue()).hash.split('/')[3]!)
  expect(optedIn.notes?.slots[0]?.rotationNotes).toBe('PRIVATE_NOTE_T27')
  for (const secret of secrets.slice(0, -1)) expect(JSON.stringify(optedIn)).not.toContain(secret)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Share team', exact: true }).click()
  await expect(dialog.getByRole('checkbox', { name: 'Include written notes' })).not.toBeChecked()
})
