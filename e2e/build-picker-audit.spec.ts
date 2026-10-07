import { expect, test, type Page } from '@playwright/test'
import { MOBILE_TEST_TAG } from './test-tags'
import { openBuildPickerFilters } from './build-picker-helpers'

async function choose(page: Page, label: string, name: string) {
  await page.getByRole('combobox', { name: label, exact: true }).fill(name)
  await page.getByRole('listbox', { name: `Choose ${label}`, exact: true }).getByRole('option').filter({ hasText: 'Windows 1.6.9' }).filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).click()
}

test('equipment searches explain conflicts, search visible facts, and prioritize exact names', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/builds/library/new')
  await choose(page, 'Class', 'Rogue')
  await choose(page, 'Main hand', 'Silver Dagger')
  const offHand = page.getByRole('combobox', { name: 'Off hand', exact: true })
  await offHand.fill('dagger')
  const list = page.getByRole('listbox', { name: 'Choose Off hand', exact: true })
  const ritualDagger = list.getByRole('option').filter({ has: page.locator('strong', { hasText: /^Ritual Dagger$/ }) })
  await expect(ritualDagger).toContainText("Mod: Outfitter's Guild")
  await expect(ritualDagger).toContainText("Ritual Dagger's equipment category is unavailable")
  await offHand.fill('Silver Dagger')
  await expect(list).toContainText('matching choices are hidden by equipment conflicts')
  await expect(list).toContainText('requires Dual Wield')
  await expect(list).toContainText('Choose a class that grants Dual Wield')
  await expect(list.getByRole('option').filter({ hasText: 'Windows 1.6.9' }).filter({ has: page.locator('strong', { hasText: /^Silver Dagger$/ }) })).toHaveCount(0)
  await list.getByRole('button', { name: /^Show \d+ conflicts$/ }).click()
  const results = list.getByRole('option').filter({ has: page.locator('.picker-result__heading') })
  await expect(results.first().locator('strong')).toHaveText('Silver Dagger')
  await expect(results.first()).toHaveAttribute('data-permission-state', 'invalid')
  await expect(results.first()).toContainText('requires Dual Wield')
  await offHand.press('Escape')
  await expect(offHand).toHaveValue('')
  const accessory = page.getByRole('combobox', { name: 'Accessory 1', exact: true })
  await accessory.fill('agility')
  const shoes = page.getByRole('listbox', { name: 'Choose Accessory 1', exact: true }).getByRole('option').filter({ hasText: 'Windows 1.6.9' }).filter({ has: page.locator('strong', { hasText: /^Acrobat Shoes$/ }) })
  await expect(shoes).toContainText('Agility')
  await expect(shoes).toContainText('Matched details:')
  await openBuildPickerFilters(page)
  await page.getByRole('combobox', { name: 'Sort results', exact: true }).selectOption('Dexterity')
  await expect(shoes).toContainText('Listed Dexterity: 14')
  await shoes.click()
  await expect(accessory).toHaveValue('Acrobat Shoes')
})

test('equipment choices reserve the first screen for results and support sole-result Enter', { tag: MOBILE_TEST_TAG }, async ({ page, isMobile }) => {
  if (!isMobile) await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/#/builds/library/new')
  await choose(page, 'Class', 'Warrior')
  const command = page.getByRole('combobox', { name: 'Sub-command', exact: true })
  await command.fill('Hunter Windows 1.6.9')
  await expect(page.getByRole('listbox', { name: 'Choose Sub-command', exact: true })).toContainText('1 result · Enter to select')
  await command.press('Enter')
  await expect(command).toHaveValue('Hunt (Hunter)')
  await page.getByRole('combobox', { name: 'Head', exact: true }).click()
  const list = page.getByRole('listbox', { name: 'Choose Head', exact: true })
  await expect(list.locator('.build-picker-filters')).not.toHaveAttribute('open')
  const rows = list.getByRole('option').filter({ has: page.locator('.picker-result__heading') })
  await expect(rows.nth(2)).toBeVisible()
  await expect.poll(() => list.evaluate(popup => {
    const third = popup.querySelectorAll('.picker-result__heading')[2]?.closest('.picker-result')
    if (!third) return false
    const bounds = popup.getBoundingClientRect()
    const itemBounds = third.getBoundingClientRect()
    return itemBounds.top >= bounds.top && itemBounds.bottom <= bounds.bottom
  })).toBe(true)
})
