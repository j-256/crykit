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
    await expect(fact(page, name).locator('.sources-trigger')).toHaveCount(0)
  }
  const master = fact(page, 'Master').filter({ has: page.getByText('Capital Sequoia', { exact: true }) })
  await expect(master).toHaveCount(1)
  await master.getByRole('button', { name: 'Sources for Master', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Sources for Master', exact: true }).getByRole('link', { name: /Community wiki/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Sources for Warrior', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Sources for Warrior', exact: true })).toContainText('Community wiki')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.reload()
  await expect(fact(page, 'Weapons').locator('.sources-trigger')).toHaveCount(0)
})

test('a personal value retains its evidence without replacing the corroborated source', async ({ page }) => {
  await page.goto(WARRIOR_PATH)
  await openSavedCatalogVersion(page, 'base:job:0', 'Synthetic personal Warrior', { fields: { Weapons: { state: 'known', value: 'Synthetic weapons', sources: [{ sourceId: 'synthetic-observation', locator: 'Synthetic equipment notes' }] } } })
  const weapons = fact(page, 'Weapons')
  await expect(weapons).toContainText('Synthetic weapons')
  await expect(weapons.locator('.sources-trigger')).toHaveCount(1)
  await page.reload()
  await expect(weapons).toContainText('Synthetic weapons')
  await expect(weapons.locator('.sources-trigger')).toHaveCount(1)
  await page.goto(WARRIOR_PATH)
  await expect(weapons).not.toContainText('Synthetic weapons')
  for (const name of ['Weapons', 'Armor']) await expect(fact(page, name).locator('.sources-trigger')).toHaveCount(0)
})

test('partial mechanic evidence keeps the source disclosure', async ({ page }) => {
  await page.goto(referencePath('base:mechanic:stat:ref-501'))
  await expect(page.getByRole('heading', { name: 'Flat CritResist [X]', exact: true })).toBeVisible()
  const description = page.locator('.reference-description')
  await expect(fact(page, 'Description')).toHaveCount(0)
  await expect(description).toContainText('it does not affect the non-Critical portion of damage')
  await expect(description.locator('.sources-trigger')).toHaveCount(1)
  await description.getByRole('button', { name: 'Sources for Description', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Sources for Description', exact: true })).toContainText("GEEF's Crystal Project modding guide")
  await page.goto(referencePath('base:mechanic:stat:ref-464'))
  await expect(fact(page, 'Description')).toHaveCount(0)
  await expect(page.locator('.reference-description')).not.toBeEmpty()
  await expect(page.locator('.reference-description .sources-trigger')).toHaveCount(0)
})

test('a reviewed mechanic replacement leads with native facts and preserves the original guide claim', async ({ page }) => {
  await page.goto(referencePath('base:mechanic:stat:ref-631'))
  await expect(page.getByRole('heading', { name: 'StealChanceUp [X]', exact: true })).toBeVisible()
  await expect(page.locator('.reference-detail .reference-description')).toContainText('100 * (base chance + bonus) / (100 + bonus)')
  await expect(fact(page, 'Description')).toHaveCount(0)
  await page.getByRole('button', { name: 'Sources for StealChanceUp [X]', exact: true }).click()
  const original = page.getByText('Original guide and native evidence', { exact: true }).locator('..')
  await original.locator(':scope > summary').click()
  await expect(original).toContainText('Increase steal success chance by X%')
  await expect(original).toContainText('Sang/Battle/Calculator.cs: CalculateStealChance')
})
