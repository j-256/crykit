import { MOBILE_TEST_TAG } from './test-tags'
import { referencePath } from './reference-helpers'
import { expect, test } from '@playwright/test'

test('native class facts use plain labels and leave provenance out of routine details', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(referencePath('base:job:0'))
  const facts = page.getByRole('region', { name: 'Definition facts', exact: true })
  const ratings = facts.locator('.definition-row').filter({ has: page.locator('dt', { hasText: /^Growth ratings$/ }) })
  await expect(ratings).toHaveCount(1)
  await expect(ratings.locator('.stat-rating').filter({ has: page.locator('abbr', { hasText: /^HP$/ }) }).getByRole('img', { name: '4 of 5 stars', exact: true })).toBeVisible()
  await expect(ratings.locator('summary')).toHaveCount(0)
  await expect(ratings.locator('.badge')).toHaveCount(0)
  await expect(facts.locator('dt', { hasText: /^Stat growth$|^Crystal Edit/ })).toHaveCount(0)
  await expect(facts.getByText('Equipment permissions', { exact: true })).toBeVisible()
  await expect(page.getByText('Artwork source', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/fingerprint|copied job ID|job\.dat SHA|Crystal Edit vanilla class export/)).toHaveCount(0)
  const sources = page.getByRole('dialog', { name: 'Sources for Warrior', exact: true })
  await expect(sources).toHaveCount(0)
  await page.getByRole('button', { name: 'Sources for Warrior', exact: true }).click()
  await expect(sources.getByRole('link').first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sources).toHaveCount(0)
  await page.getByText('Growth calculator', { exact: true }).click()
  await page.getByRole('button', { name: 'Use Warrior for all growth levels', exact: true }).click()
  await expect(page.getByRole('table', { name: 'Native base stats', exact: true })).toContainText('1,244')
  await expect(page.getByRole('button', { name: 'Sources for growth calculations', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
