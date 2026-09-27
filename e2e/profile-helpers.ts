import { expect, type Page } from '@playwright/test'

export async function createBlankPlaythrough(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  await panel.getByLabel('New blank profile').fill('Blank test playthrough')
  await panel.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(panel.getByRole('combobox', { name: 'Active profile', exact: true }).locator('option:checked')).toContainText('Blank test playthrough')
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
}
