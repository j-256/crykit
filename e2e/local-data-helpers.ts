import { expect, type Locator, type Page } from '@playwright/test'
import type { LocalData, Playthrough } from '../src/domain'

export function selectedPlaythrough(localData: LocalData): Playthrough {
  const playthrough = localData.selectedPlaythroughId ? localData.playthroughs[localData.selectedPlaythroughId] : undefined
  if (!playthrough) throw new Error('The fixture has no selected Playthrough')
  return playthrough
}

export async function createBlankPlaythrough(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  await panel.getByLabel('New blank Playthrough').fill('Blank test playthrough')
  await panel.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(panel.getByRole('combobox', { name: 'Active Playthrough', exact: true }).locator('option:checked')).toContainText('Blank test playthrough')
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
}

export async function replacePlannerData(panel: Locator): Promise<void> {
  await panel.getByRole('checkbox', { name: /Replace all local planner data after validation/ }).check()
  await panel.getByRole('button', { name: 'Replace planner data', exact: true }).click()
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

export async function openGameSetupSection(panel: Locator, label: string): Promise<void> {
  const advanced = panel.locator('.game-setup-advanced')
  if (await advanced.getAttribute('open') === null) await advanced.locator(':scope > summary').click()
  const section = advanced.locator('.game-setup-editor-section').filter({ hasText: label }).first()
  if (await section.getAttribute('open') === null) await section.locator(':scope > summary').click()
}

export async function openSwitchModPacks(panel: Locator): Promise<void> {
  const packs = panel.locator('.game-setup-mod-pack')
  for (let index = 0; index < await packs.count(); index += 1) {
    const pack = packs.nth(index)
    if (await pack.getAttribute('open') === null) await pack.locator(':scope > summary').click()
  }
}
