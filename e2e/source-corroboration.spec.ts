import { openSavedCatalogVersion } from './definition-fixtures'
import { referencePath } from './reference-helpers'
import { expect, test, type Page } from '@playwright/test'

const WARRIOR_PATH = referencePath('base:job:0')

function fact(page: Page, name: string) {
  return page.getByRole('region', { name: 'Definition facts', exact: true }).locator('.definition-row').filter({ has: page.locator('dt', { hasText: new RegExp(`^${name}$`) }) })
}

test('corroborated facts omit disclosures while acquisition evidence and source attribution remain accessible', async ({ page }) => {
  await page.goto(WARRIOR_PATH)
  await expect(page.getByRole('heading', { name: 'Warrior', exact: true })).toBeVisible()
  for (const name of ['Weapons', 'Armor', 'Command', 'Growth ratings']) {
    await expect(fact(page, name)).toHaveCount(1)
    await expect(fact(page, name).locator('.definition-fact-sources')).toHaveCount(0)
  }
  const master = fact(page, 'Master').filter({ has: page.getByText('Capital Sequoia', { exact: true }) })
  await expect(master).toHaveCount(1)
  await master.locator('.definition-fact-sources summary').click()
  await expect(master.getByRole('link', { name: /Community wiki/ })).toBeVisible()
  await page.getByText('Source and version details', { exact: true }).click()
  await expect(page.getByRole('region', { name: 'Source trail', exact: true })).toContainText('Community wiki')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.reload()
  await expect(fact(page, 'Weapons').locator('.definition-fact-sources')).toHaveCount(0)
})

test('a personal value retains its evidence without replacing the corroborated source', async ({ page }) => {
  await page.goto(WARRIOR_PATH)
  await openSavedCatalogVersion(page, 'base:job:0', 'Synthetic personal Warrior', { fields: { Weapons: { state: 'known', value: 'Synthetic weapons', sources: [{ sourceId: 'synthetic-observation', locator: 'Synthetic equipment notes' }] } } })
  const weapons = fact(page, 'Weapons')
  await expect(weapons).toContainText('Synthetic weapons')
  await expect(weapons.locator('.definition-fact-sources')).toHaveCount(1)
  await page.reload()
  await expect(weapons).toContainText('Synthetic weapons')
  await expect(weapons.locator('.definition-fact-sources')).toHaveCount(1)
  await page.goto(WARRIOR_PATH)
  await expect(weapons).not.toContainText('Synthetic weapons')
  for (const name of ['Weapons', 'Armor']) await expect(fact(page, name).locator('.definition-fact-sources')).toHaveCount(0)
})

test('partial mechanic evidence keeps the source disclosure', async ({ page }) => {
  await page.goto(referencePath('base:mechanic:stat:ref-631'))
  await expect(fact(page, 'Description').locator('.definition-fact-sources')).toHaveCount(1)
  await page.goto(referencePath('base:mechanic:stat:ref-464'))
  await expect(fact(page, 'Description').locator('.definition-fact-sources')).toHaveCount(0)
})
