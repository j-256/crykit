import { openBuildPickerFilters } from './build-picker-helpers'
import { expect, test, type Page } from '@playwright/test'
import { MOBILE_TEST_TAG } from './test-tags'

async function choose(page: Page, label: string, name: string) {
  const input = page.getByRole('combobox', { name: label, exact: true }).filter({ visible: true })
  await input.fill(name)
  const expected = label === 'Sub-command' ? new RegExp(`\\(${name}\\)$`) : new RegExp(`^${name}$`)
  const choice = page.getByRole('listbox', { name: `Choose ${label}`, exact: true }).getByRole('option').filter({ has: page.locator('strong', { hasText: expected }) })
  await choice.click()
  await expect(input).toHaveValue(expected)
}

const members = [
  { name: 'Aster', primary: 'Warrior', secondary: 'Monk', weapon: 'Diamond Sword', offhand: 'Diamond Shield', head: 'Diamond Helm', body: 'Diamond Mail', accessories: ['Hemoring', 'Tall Stand Ring'], passives: ['HP Boost', 'Counter', 'Natural Tank'] },
  { name: 'Brin', primary: 'Cleric', secondary: 'Wizard', weapon: 'Diamond Staff', head: 'Diamond Crown', body: 'Diamond Robe', accessories: ['Mana Ring', 'Sanity Ring'], passives: ['Fast Cast', 'Regenerator', 'HP Boost'] },
  { name: 'Cora', primary: 'Rogue', secondary: 'Warrior', weapon: 'Diamond Dagger', offhand: 'Diamond Shield', head: 'Diamond Cap', body: 'Diamond Vest', accessories: ['Hemoring', 'Tall Stand Ring'], passives: ['Equip Shield', 'Backstabber', 'Critical Power', 'Fury'] },
  { name: 'Dax', primary: 'Wizard', secondary: 'Cleric', weapon: 'Diamond Wand', offhand: 'Diamond Shield', head: 'Diamond Crown', body: 'Diamond Robe', accessories: ['Mana Ring', 'Sanity Ring'], passives: ['Fast Cast', 'Equip Shield', 'HP Boost'] },
] as const

test('creates and equips four members from a Team and retains them after reload and sharing', { tag: MOBILE_TEST_TAG }, async ({ page, browser }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/#/teams/new')
  await page.getByRole('textbox', { name: 'Team name' }).fill('Audit Expedition')
  for (const [index, member] of members.entries()) {
    await test.step(`Equip ${member.name}`, async () => {
      await page.getByRole('region', { name: `Team slot ${index + 1} loadout`, exact: true }).getByRole('button', { name: 'Create member', exact: true }).click()
      await page.getByRole('textbox', { name: 'Build title', exact: true }).fill(member.name)
      if (index === 0) {
        await page.locator('.build-behavior > summary').click()
        await page.getByRole('combobox', { name: 'Copy Game Setup', exact: true }).selectOption('vanilla')
        await page.getByRole('combobox', { name: 'Game version', exact: true }).selectOption({ label: '1.6.9' })
        await page.locator('.build-behavior > summary').click()
      } else await expect(page.getByRole('region', { name: 'Team member context' })).toContainText("Starting with this Team's Game Setup: Unmodified game")
      await expect(page.getByRole('checkbox', { name: /Include innates/, includeHidden: true })).not.toBeChecked()
      await choose(page, 'Class', member.primary)
      await choose(page, 'Sub-command', member.secondary)
      for (const [passiveIndex, passive] of member.passives.entries()) await choose(page, `Equipped passive ${passiveIndex + 1}`, passive)
      await choose(page, 'Main hand', member.weapon)
      if ('offhand' in member) await choose(page, 'Off hand', member.offhand)
      else {
        await expect(page.locator('.build-occupied-slot')).toContainText('occupied by Diamond Staff')
        await expect(page.getByRole('combobox', { name: 'Off hand', exact: true })).toHaveCount(0)
      }
      await choose(page, 'Head', member.head)
      await choose(page, 'Body', member.body)
      await choose(page, 'Accessory 1', member.accessories[0])
      await choose(page, 'Accessory 2', member.accessories[1])
      await expect(page.getByRole('status', { name: 'Build PP summary' })).toContainText('10 / 10 PP')
      await expect(page.getByRole('region', { name: 'Build validity', exact: true })).toHaveAttribute('data-status', 'valid')
      await page.getByRole('button', { name: 'Save member and return to Team', exact: true }).click()
      await expect(page.getByRole('region', { name: `Team slot ${index + 1} loadout`, exact: true })).toContainText(member.name)
      await expect(page.getByRole('region', { name: 'Team review' })).toContainText(`${index + 1}/4 slots filled`)
    })
  }
  await page.reload()
  await expect(page.getByRole('region', { name: 'Team review' })).toContainText('4/4 selected members have a class')
  await expect(page.getByRole('region', { name: 'Team review' })).toContainText('4/4 selected checkpoints have no known build issues')
  for (const [index, member] of members.entries()) {
    const card = page.getByRole('region', { name: `Team slot ${index + 1} loadout`, exact: true })
    await expect(card).toContainText(member.weapon)
    await expect(card).toContainText(member.accessories[1])
  }
  await page.screenshot({ path: testInfo.outputPath('complete-team.png'), fullPage: true })
  await page.getByRole('button', { name: 'Share team', exact: true }).click()
  const url = await page.getByRole('dialog', { name: 'Share team', exact: true }).getByLabel('Share URL').inputValue()
  await testInfo.attach('complete-team-share-url', { body: url, contentType: 'text/plain' })
  const recipientContext = await browser.newContext()
  try {
    const recipient = await recipientContext.newPage()
    await recipient.goto(url)
    await expect(recipient.getByText('Read-only snapshot', { exact: true })).toBeVisible()
    await expect(recipient.getByRole('region', { name: /^Shared team slot \d$/ })).toHaveCount(4)
    for (const [index, member] of members.entries()) await expect(recipient.getByRole('region', { name: `Shared team slot ${index + 1}`, exact: true })).toContainText(member.name)
  } finally { await recipientContext.close() }
  expect(errors).toEqual([])
})

test('explains hand conflicts beside slots and remembers innate search preference without editing checkpoints', async ({ page }) => {
  await page.goto('/#/builds/library/new')
  await page.getByRole('textbox', { name: 'Build title', exact: true }).fill('Hand allocation review')
  await choose(page, 'Class', 'Warrior')
  const offhand = page.getByRole('combobox', { name: 'Off hand', exact: true })
  await offhand.fill('Diamond Sword')
  const list = page.getByRole('listbox', { name: 'Choose Off hand', exact: true })
  await expect(list).toContainText('hidden by equipment conflicts')
  await openBuildPickerFilters(page)
  await list.getByRole('checkbox', { name: 'Hide known equipment conflicts', exact: true }).uncheck()
  const sword = list.getByRole('option').filter({ has: page.locator('strong', { hasText: /^Diamond Sword$/ }) })
  await expect(sword).toContainText('Dual Wield')
  await sword.click()
  await expect(page.locator('.slot-entry').filter({ has: offhand }).locator('.build-field-issues')).toContainText('Dual Wield')
  await page.getByRole('button', { name: 'Clear Off hand', exact: true }).click()
  await choose(page, 'Class', 'Cleric')
  await choose(page, 'Equipped passive 1', 'Equip Shield')
  await choose(page, 'Main hand', 'Diamond Staff')
  await page.getByRole('button', { name: 'Clear Mainhand to choose Off hand', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toHaveValue('')
  await choose(page, 'Off hand', 'Diamond Shield')
  await page.locator('.build-passive-options > summary').click()
  const innate = page.getByRole('checkbox', { name: /Include innates/, includeHidden: true })
  await innate.check()
  await page.getByRole('button', { name: 'Save build', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save new revision', exact: true })).toBeVisible()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await page.reload()
  await expect(innate).toBeChecked()
  await innate.uncheck()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await page.reload()
  await expect(innate).not.toBeChecked()
})
