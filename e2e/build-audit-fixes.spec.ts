import { expect, test, type Page } from '@playwright/test'
import { MOBILE_TEST_TAG } from './test-tags'

async function choose(page: Page, label: string, name: string) {
  const input = page.getByRole('combobox', { name: label, exact: true }).filter({ visible: true })
  await input.fill(name)
  await page.getByRole('listbox', { name: `Choose ${label}`, exact: true }).getByRole('option').filter({ hasText: 'PC 1.6.9.0' }).filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).click()
}

test('starts fresh with explicit rules and draft feedback while retaining sample Builds', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/settings/data')
  await page.getByRole('button', { name: 'New blank Playthrough', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'New blank Playthrough', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'New blank Playthrough', exact: true }).fill('Fresh audit')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Active Playthrough', exact: true })).toHaveValue(/playthrough/)
  await expect(page.locator('.playthrough-game-summary')).toContainText('Fresh audit settings')
  await page.goto('/#/builds/library/new')
  await expect(page.locator('.build-behavior > summary')).toContainText('Fresh audit settings')
  await expect(page.locator('.build-behavior > summary')).not.toContainText('Sample')
  await expect(page.getByRole('region', { name: 'Build validity', exact: true })).not.toContainText('No known loadout conflicts')
  await expect(page.getByRole('region', { name: 'Build validity', exact: true })).toContainText('Choose a class')
  await expect(page.locator('.build-passive-options')).not.toHaveAttribute('open')
  await page.getByRole('textbox', { name: 'Build title', exact: true }).fill('Fresh Wizard')
  await choose(page, 'Class', 'Wizard')
  await choose(page, 'Accessory 1', 'Earring')
  await choose(page, 'Accessory 2', 'Earring')
  await expect(page.getByRole('combobox', { name: 'Accessory 2: Item copies', exact: true })).toHaveValue('')
  await expect(page.getByRole('combobox', { name: 'Accessory 2: Item copies', exact: true })).toContainText('Use a separate item')
  await page.getByRole('button', { name: 'Save build', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save new revision', exact: true })).toBeVisible()
  await page.goto('/#/builds/library')
  await expect(page.locator('.build-card').filter({ hasText: 'sample' })).not.toHaveCount(0)
  await page.getByRole('checkbox', { name: 'Show sample Builds', exact: true }).uncheck()
  await expect(page.locator('.build-card')).toHaveCount(1)
  await expect(page.locator('.build-card')).toContainText('Fresh Wizard')
  await page.getByRole('checkbox', { name: 'Show sample Builds', exact: true }).check()
  await expect(page.locator('.build-card').filter({ hasText: 'sample' })).not.toHaveCount(0)
})
