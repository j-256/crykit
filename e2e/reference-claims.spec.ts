import { referencePath } from './reference-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import { expect, test, type Page } from '@playwright/test'

const ITEM_PATH = referencePath('base:item:assassin-seal')
const EQUIVALENT_ITEM_PATH = referencePath('base:item:adjudicator')
const ITEM_SOURCE = 'https://crystal-project.fandom.com/wiki/Assassin_Seal?oldid=12583'
const TABLE_SOURCE = 'https://crystal-project.fandom.com/wiki/Accessories/table?oldid=12905'
const SELECTED_LOCATION = 'Reward: Master Assassin in Shoudu Province'

function locationRow(page: Page) {
  return page.locator('.definition-row').filter({ has: page.locator('dt', { hasText: /^Location$/ }) })
}

test('equivalent source wording is shown as one fact with known implied', async ({ page }) => {
  await page.goto(EQUIVALENT_ITEM_PATH)
  const location = locationRow(page)
  await expect(location.getByText('Drop: Anubis in the Ancient Labyrinth', { exact: true })).toBeVisible()
  await expect(location.locator('.badge').getByText('known', { exact: true })).toHaveCount(0)
  await expect(location.getByText('differing source values')).toHaveCount(0)
  await expect(page.getByText('Source descriptions differ', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Review source differences', exact: true })).toHaveCount(0)
  await page.getByRole('region', { name: 'Source trail', exact: true }).locator('summary').filter({ hasText: /^Source and version details$/ }).click()
  await expect(page.getByRole('link', { name: 'Community wiki · Scythes/table', exact: true })).toHaveAttribute('href', 'https://crystal-project.fandom.com/wiki/Scythes/table?oldid=10848')
  await expect(page.getByRole('link', { name: 'Community wiki · Adjudicator', exact: true })).toHaveAttribute('href', 'https://crystal-project.fandom.com/wiki/Adjudicator?oldid=11911')
})

test('conflicting fields retain every claim and its exact source evidence', { tag: MOBILE_TEST_TAG }, async ({ page, baseURL }) => {
  const externalRequests: string[] = []
  page.on('request', (request) => { if (!request.url().startsWith(`${baseURL}/`)) externalRequests.push(request.url()) })
  await page.goto(ITEM_PATH)
  const location = locationRow(page)
  await expect(location.getByText(SELECTED_LOCATION, { exact: true })).toBeVisible()
  await expect(location.getByText(/The Assassin Master is found in Capital Sequoia/)).toBeVisible()
  await expect(location.getByRole('link', { name: 'Community wiki · Assassin Seal', exact: true })).toHaveAttribute('href', ITEM_SOURCE)
  await expect(location.getByRole('link', { name: 'Community wiki · Accessories/table', exact: true })).toHaveAttribute('href', TABLE_SOURCE)
  await expect(location.locator('.badge').getByText('Sources differ', { exact: true })).toBeVisible()
  await expect(location.getByText(/revision 12583/)).toBeVisible()
  await expect(location.getByText(/revision 12905/)).toBeVisible()
  await expect(page.getByText('Windows 1.6.9 · base database', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await expect(page.getByRole('button', { name: /Review source differences|Create personal version/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Report a data issue', exact: true })).toBeVisible()
  await page.reload()
  await expect(location.getByText('2 differing source values', { exact: true })).toBeVisible()
  expect(externalRequests).toEqual([])
})
