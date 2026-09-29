import { expect, type Locator, type Page } from '@playwright/test'

export async function createBlankPlaythrough(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  await panel.getByLabel('New blank profile').fill('Blank test playthrough')
  await panel.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(panel.getByRole('combobox', { name: 'Active profile', exact: true }).locator('option:checked')).toContainText('Blank test playthrough')
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
}

export async function chooseFourTeamMembers(form: Locator): Promise<void> {
  const selectors = form.getByRole('combobox', { name: /^Team member \d$/ })
  await expect(selectors).toHaveCount(4)
  for (let index = 0; index < 4; index += 1) {
    const selector = selectors.nth(index)
    if (await selector.inputValue()) continue
    const option = selector.locator('option:not([disabled])').filter({ hasNotText: 'Choose character' }).first()
    await selector.selectOption((await option.getAttribute('value'))!)
  }
}

export async function openRulesetSection(panel: Locator, label: string): Promise<void> {
  const card = panel.locator('.ruleset-summary-card').filter({ hasText: label }).first()
  const sectionId = await card.getAttribute('aria-controls')
  const section = panel.locator(`#${sectionId}`)
  if (await section.getAttribute('open') === null) await card.click()
}

export async function openSwitchModPacks(panel: Locator): Promise<void> {
  await openRulesetSection(panel, 'Switch mods')
  const packs = panel.locator('.ruleset-mod-pack')
  for (let index = 0; index < await packs.count(); index += 1) {
    const pack = packs.nth(index)
    if (await pack.getAttribute('open') === null) await pack.locator(':scope > summary').click()
  }
}
