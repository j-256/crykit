import { expect, test, type Page } from '@playwright/test'
import { createBlankPlaythrough, skipInitialModSetup } from './local-data-helpers'
import { MOBILE_TEST_TAG } from './test-tags'

async function chooseNative(page: Page, label: string, query: string, displayName = query) {
  const input = page.getByRole('combobox', { name: label, exact: true })
  await input.fill(query)
  await page.getByRole('listbox', { name: `Choose ${label}`, exact: true }).getByRole('option')
    .filter({ has: page.getByText(displayName, { exact: true }) })
    .filter({ hasText: 'Windows 1.6.9' }).click()
  await expect(input).toHaveValue(displayName)
}

async function openPreview(page: Page) {
  await page.getByRole('button', { name: 'Checks & notes', exact: true }).click()
  if (!(await page.getByRole('region', { name: 'Combat preview', exact: true }).isVisible())) {
    await page.getByText('Ability and hit-chance preview', { exact: true }).click()
  }
}

test('preview abilities prioritize primary class and subclass while retaining broader choices', { tag: MOBILE_TEST_TAG }, async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await skipInitialModSetup(page)
  await createBlankPlaythrough(page)
  await page.goto('/#/builds/library/new')
  await chooseNative(page, 'Class', 'Hunter')
  await chooseNative(page, 'Sub-command', 'Wizard', 'Black Magic (Wizard)')
  await openPreview(page)
  const preview = page.getByRole('combobox', { name: 'Preview ability', exact: true })
  const picker = page.getByRole('listbox', { name: 'Choose Preview ability', exact: true })
  await expect(preview).toHaveValue('')
  await preview.click()
  await expect(picker.locator('.build-picker-group-heading')).toHaveText(['Class: Hunter', 'Subclass: Wizard', 'Other abilities'])
  const hunter = picker.getByRole('group', { name: 'Class: Hunter', exact: true })
  const wizard = picker.getByRole('group', { name: 'Subclass: Wizard', exact: true })
  await expect(hunter.getByRole('option').filter({ has: page.getByText('Snipe', { exact: true }) })).toHaveCount(1)
  await expect(wizard.getByRole('option').filter({ has: page.getByText('Fire', { exact: true }) })).toHaveCount(1)
  const firstClassChoice = hunter.getByRole('option').first()
  const firstClassAbility = await firstClassChoice.locator('.picker-result__heading > strong').innerText()
  await preview.press('ArrowDown')
  await expect(preview).toHaveAttribute('aria-activedescendant', (await firstClassChoice.getAttribute('id'))!)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('class-ability-picker.png') })
  await preview.press('Enter')
  await expect(picker).not.toBeVisible()
  await expect(preview).toHaveValue(firstClassAbility)

  await preview.fill('Cure')
  const other = picker.getByRole('group', { name: 'Other abilities', exact: true })
  await other.getByRole('option').filter({ has: page.getByText('Cure', { exact: true }) }).filter({ hasText: 'Windows 1.6.9' }).click()
  await expect(preview).toHaveValue('Cure')
  await expect(page.getByLabel('Selected ability', { exact: true }).getByRole('heading', { name: 'Cure', exact: true })).toBeVisible()
  await preview.click()
  await expect(preview).toHaveValue('')
  await expect(picker.locator('.build-picker-group-heading')).toHaveText(['Class: Hunter', 'Subclass: Wizard', 'Other abilities'])
  await preview.press('Escape')
  await expect(preview).toHaveValue('Cure')

  await page.getByRole('button', { name: 'Loadout', exact: true }).click()
  await chooseNative(page, 'Class', 'Warrior')
  await openPreview(page)
  await expect(preview).toHaveValue('Cure')
  await preview.click()
  await expect(picker.locator('.build-picker-group-heading')).toHaveText(['Class: Warrior', 'Subclass: Wizard', 'Other abilities'])
  await preview.press('Escape')
  await page.getByRole('button', { name: 'Loadout', exact: true }).click()
  await chooseNative(page, 'Sub-command', 'Cleric', 'White Magic (Cleric)')
  await openPreview(page)
  await expect(preview).toHaveValue('Cure')
  await preview.click()
  await expect(picker.locator('.build-picker-group-heading')).toHaveText(['Class: Warrior', 'Subclass: Cleric', 'Other abilities'])
  const selectedCure = picker.getByRole('group', { name: 'Subclass: Cleric', exact: true }).getByRole('option')
    .filter({ has: page.getByText('Cure', { exact: true }) }).filter({ hasText: 'Windows 1.6.9' })
  await expect(selectedCure).toHaveAttribute('aria-selected', 'true')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
})
