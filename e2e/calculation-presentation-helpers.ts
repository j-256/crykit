import { expect, type Locator, type Page } from '@playwright/test'

export async function openStatBreakdown(root: Page | Locator) {
  const details = root.locator('.loadout-stat-breakdown')
  await expect(details).toBeVisible()
  if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click()
}

export async function openCalculationSources(root: Page | Locator) {
  const details = root.locator('.calculation-coverage')
  await expect(details).toBeVisible()
  if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click()
}
