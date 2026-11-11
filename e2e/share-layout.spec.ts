import { expect, test, type Page } from '@playwright/test'
import { createPublicShareUrl, decodePublicSnapshot } from '../src/interchange/public-share'
import { skipInitialModSetup, readLocalData } from './local-data-helpers'
import { openShareSources } from './share-view-helpers'
import { MOBILE_TEST_TAG } from './test-tags'

async function sampleBuildUrl(page: Page): Promise<string> {
  await page.goto('/')
  await skipInitialModSetup(page)
  const card = page.locator('.build-card').filter({ has: page.getByRole('button', { name: 'Tavi: sample Rogue', exact: true }) })
  await card.getByRole('button', { name: 'Share build', exact: true }).click()
  return page.getByRole('dialog', { name: 'Share build', exact: true }).getByLabel('Share URL', { exact: true }).inputValue()
}

test('a shared Build leads with one loadout and supports keyboard inspection and secondary sources', { tag: MOBILE_TEST_TAG }, async ({ page, isMobile }) => {
  const url = await sampleBuildUrl(page)
  const before = await readLocalData(page)
  await page.goto(url)
  const loadout = page.getByRole('region', { name: 'Shared build loadout', exact: true })
  const dirk = loadout.getByRole('button', { name: 'Inspect Main hand: Dirk', exact: true })
  await expect(dirk).toHaveCount(1)
  await expect(dirk).toBeInViewport()
  await expect(page.getByRole('heading', { name: 'Slot 1', exact: true })).toHaveCount(0)
  const sources = page.getByLabel('Game Setup and sources', { exact: true })
  await expect(sources).not.toHaveAttribute('open')
  await expect(page.getByRole('region', { name: 'Your matching definitions', exact: true })).not.toBeVisible()
  await dirk.focus()
  await dirk.press('Enter')
  const inspection = isMobile ? dirk.locator('..').locator('details') : loadout.getByRole('complementary', { name: 'Selection details', exact: true })
  await expect(inspection).toBeVisible()
  await expect(inspection).toContainText('Attack')
  await openShareSources(page)
  await expect(page.getByText('All selected definitions are available.', { exact: true })).toBeVisible()
  expect(await readLocalData(page)).toEqual(before)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('a shared Team keeps its roster while switching one member sheet and empty positions', { tag: MOBILE_TEST_TAG }, async ({ page, baseURL, isMobile }) => {
  const url = await sampleBuildUrl(page)
  const single = decodePublicSnapshot(new URL(url).hash.split('/')[3]!)
  const snapshot = { ...single, kind: 'team' as const, title: 'Synthetic review Team', slots: [{ ...single.slots[0]!, name: 'Tavi' }, null, { ...single.slots[0]!, name: 'A second Rogue' }, null] }
  const before = await readLocalData(page)
  await page.goto(createPublicShareUrl(snapshot, `${baseURL}/`))
  await expect(page.getByRole('region', { name: /^Shared team slot \d$/ })).toHaveCount(4)
  await expect(page.getByRole('region', { name: 'Selected Team member', exact: true }).getByRole('heading', { name: 'Tavi', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'View A second Rogue', exact: true }).click()
  await expect(page.getByRole('button', { name: 'View A second Rogue', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('region', { name: 'Slot 3 calculations', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Slot 1 calculations', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'View empty slot 2', exact: true }).click()
  await expect(page.getByText('No build in this slot.', { exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Read-only calculations', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'View Tavi', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Inspect Main hand: Dirk', exact: true })).toBeVisible()
  if (isMobile) {
    const paging = page.getByRole('group', { name: 'Team member navigation', exact: true })
    await expect(paging.getByRole('button', { name: 'Previous member', exact: true })).toBeDisabled()
    await paging.getByRole('button', { name: 'Next member', exact: true }).click()
    await expect(paging).toContainText('Member 2 of 4')
    await expect(page.getByText('No build in this slot.', { exact: true })).toBeVisible()
    await paging.getByRole('button', { name: 'Next member', exact: true }).click()
    await expect(page.getByRole('button', { name: 'View A second Rogue', exact: true })).toBeInViewport()
    await paging.getByRole('button', { name: 'Next member', exact: true }).click()
    await expect(paging.getByRole('button', { name: 'Next member', exact: true })).toBeDisabled()
    await paging.getByRole('button', { name: 'Previous member', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Slot 3 calculations', exact: true })).toBeVisible()
  }
  expect(await readLocalData(page)).toEqual(before)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('missing mechanics retain readable selections and conflicting setup receipts', { tag: MOBILE_TEST_TAG }, async ({ page, baseURL }) => {
  const url = await sampleBuildUrl(page)
  const snapshot = decodePublicSnapshot(new URL(url).hash.split('/')[3]!)
  const longName = 'Synthetic equipment with a very long unbroken identifier '.repeat(2) + 'x'.repeat(100)
  const missing = { ...snapshot, title: 'Synthetic missing sources', setup: { ...snapshot.setup, baseline: null, mode: { state: 'conflicting' as const } }, receipts: snapshot.receipts.map((receipt, index) => index === 0 ? { ...receipt, name: longName } : receipt) }
  await page.goto(createPublicShareUrl(missing, `${baseURL}/`))
  const loadout = page.getByRole('region', { name: 'Shared build loadout', exact: true })
  await expect(loadout.getByText(longName, { exact: true })).toBeVisible()
  await expect(loadout.getByText('Mechanics unknown', { exact: true })).not.toHaveCount(0)
  await expect(page.getByText('Calculations unavailable', { exact: true })).toBeVisible()
  await expect(page.getByRole('table', { name: 'Calculated character stats', exact: true })).toHaveCount(0)
  await openShareSources(page)
  await expect(page.getByText('The shared source reports conflicting claims.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
