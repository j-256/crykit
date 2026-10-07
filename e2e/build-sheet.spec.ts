import { openBuildPickerFilters } from './build-picker-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import { expectOfflineReady } from './offline-helpers'
import { skipInitialModSetup, selectedPlaythrough, createBlankPlaythrough } from './local-data-helpers'
import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'
import type { LocalData } from '../src/domain/types'

async function choose(page: Page, label: string, name: string, options: { readonly allowConflicts?: boolean; readonly includeUnavailable?: boolean; readonly requiredMod?: string } = {}) {
  await page.getByRole('combobox', { name: label, exact: true }).fill(name)
  const results = page.getByRole('listbox', { name: `Choose ${label}`, exact: true })
  if (options.allowConflicts) {
    await openBuildPickerFilters(page)
    await results.getByRole('checkbox', { name: 'Hide known equipment conflicts', exact: true }).uncheck()
  }
  if (options.includeUnavailable) {
    await openBuildPickerFilters(page)
    await results.getByText('Broader planning options', { exact: true }).click()
    await results.getByRole('checkbox', { name: 'Include disabled or unconfirmed mods', exact: true }).check()
  }
  const choices = results.getByRole('option').filter({ has: page.getByText(name, { exact: true }) })
  await choices.filter({ hasText: options.requiredMod ?? 'PC 1.6.9.0' }).click()
  if (options.requiredMod) {
    const dialog = page.getByRole('dialog', { name: `Enable ${options.requiredMod}?`, exact: true })
    await expect(dialog).toContainText(`${name} requires ${options.requiredMod}`)
    await dialog.getByRole('button', { name: `Enable and select ${name}`, exact: true }).click()
    await expect(dialog).toHaveCount(0)
  }
  await expect(page.getByRole('combobox', { name: label, exact: true })).toHaveValue(name)
}

async function exportLocalData(page: Page): Promise<LocalData> {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const settings = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await settings.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const download = page.waitForEvent('download')
  await settings.getByRole('button', { name: 'Export backup', exact: true }).click()
  const archive = unzipSync(await readFile((await (await download).path())!))
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  return (JSON.parse(strFromU8(archive['bundle.json']!)) as { localData: LocalData }).localData
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  await createBlankPlaythrough(page)
})

test('loadout columns stay stable before inspection and after clearing or reopening a build', { tag: MOBILE_TEST_TAG }, async ({ page, isMobile }) => {
  await page.getByRole('button', { name: 'New Build', exact: true }).click()
  const details = page.getByRole('complementary', { name: 'Selection details', exact: true })
  const slots = page.locator('.build-sheet__slots')
  await expect(details).toContainText('Choose a selection to inspect its definition.')
  const initialSlots = (await slots.boundingBox())!
  const initialDetails = (await details.boundingBox())!
  if (isMobile) expect(initialDetails.y).toBeGreaterThanOrEqual(initialSlots.y + initialSlots.height)
  else expect(initialDetails.x).toBeGreaterThanOrEqual(initialSlots.x + initialSlots.width)
  const expectStableWidths = async () => {
    await expect.poll(async () => {
      const slotsBox = (await slots.boundingBox())!
      const detailsBox = (await details.boundingBox())!
      return [slotsBox.x, slotsBox.width, detailsBox.x, detailsBox.width]
    }).toEqual([initialSlots.x, initialSlots.width, initialDetails.x, initialDetails.width])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  const hand = page.getByRole('combobox', { name: 'Main hand', exact: true })
  await hand.click()
  await expectStableWidths()
  await choose(page, 'Main hand', 'Muramasa')
  await expect(details.getByRole('heading', { name: 'Muramasa', exact: true })).toBeVisible()
  await expectStableWidths()
  await page.getByRole('button', { name: 'Clear Main hand', exact: true }).click()
  await expect(details).toContainText('Choose a selection to inspect its definition.')
  await expectStableWidths()
  await choose(page, 'Main hand', 'Muramasa')
  await page.getByRole('button', { name: 'Save build', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save new revision', exact: true })).toBeVisible()
  await page.reload()
  await expect(hand).toHaveValue('Muramasa')
  await expect(details).toContainText('Choose a selection to inspect its definition.')
  const reopenedWidth = (await slots.boundingBox())!.width
  await hand.click()
  await expect(details.getByRole('heading', { name: 'Muramasa', exact: true })).toBeVisible()
  expect((await slots.boundingBox())!.width).toBe(reopenedWidth)
})

test('a blank playthrough can plan unowned gear directly and reopen it offline', { tag: MOBILE_TEST_TAG }, async ({ page, context }, testInfo) => {
  await expect(page).toHaveURL(/#\/builds\/library$/)
  await expect(page.getByRole('button', { name: /^Party plan:/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'New Build', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toBeVisible()
  await expect(page.locator('dialog:modal')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Build title', exact: true })).toBeVisible()
  await choose(page, 'Class', 'Warrior')
  await choose(page, 'Sub-command', 'White Magic (Cleric)')
  await choose(page, 'Main hand', 'Muramasa', { allowConflicts: true })
  await choose(page, 'Off hand', "Wizard's Wall", { allowConflicts: true })
  await choose(page, 'Head', 'Red Hat', { allowConflicts: true })
  await choose(page, 'Body', 'Shadow Gi', { allowConflicts: true })
  await choose(page, 'Accessory 1', 'Acrobat Shoes')
  await choose(page, 'Accessory 2', 'Ring of Wizardry', { includeUnavailable: true, requiredMod: 'Equipment Expansion' })
  await choose(page, 'Equipped passive 1', 'Counter')
  await expect(page.getByRole('combobox', { name: 'Equipped passive 2', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('planned-sheet.png'), fullPage: true })
  await page.getByRole('button', { name: 'Save build', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save new revision', exact: true })).toBeVisible()
  await expect(page.locator('.build-readiness')).not.toHaveAttribute('open')
  const before = await exportLocalData(page)
  const buildId = decodeURIComponent(/#\/builds\/library\/([^/]+)/.exec(page.url())?.[1] ?? '')
  const build = before.builds[buildId]
  expect(build).toMatchObject({ title: 'Warrior build', archived: false })
  const originalRevision = Object.values(before.buildRevisions).find(revision => revision.buildId === buildId)!
  for (const key of ['inventory', 'inventoryEvents', 'characters', 'scenarios', 'progress'] as const) expect(selectedPlaythrough(before)[key]).toEqual({})
  expect(before.personalDefinitions).toEqual({})
  expect(before.gameSetups[before.planningGameSetupRevisionId!]!.mods.state).toBe('unknown')
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const settings = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await settings.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await settings.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expectOfflineReady(settings)
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toHaveValue('Muramasa')
  await expect(page.getByRole('combobox', { name: 'Sub-command', exact: true })).toHaveValue('White Magic (Cleric)')
  await choose(page, 'Accessory 2', 'Acrobat Shoes', { allowConflicts: true })
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  const after = await exportLocalData(page)
  expect(after.buildRevisions[originalRevision.id]).toEqual(originalRevision)
  expect(Object.values(after.buildRevisions).filter(revision => revision.buildId === buildId)).toHaveLength(2)
  expect(selectedPlaythrough(after).inventory).toEqual({})
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('inline search accepts only exact choices and supports keyboard, touch, and history', { tag: MOBILE_TEST_TAG }, async ({ page, isMobile }, testInfo) => {
  await page.goto('/#/builds/library/new')
  const hand = page.getByRole('combobox', { name: 'Main hand', exact: true })
  await hand.click()
  const results = page.getByRole('listbox', { name: 'Choose Main hand', exact: true })
  await expect(results).toBeVisible()
  const firstPageCount = await results.getByRole('option').count()
  await hand.press('End')
  await hand.press('Enter')
  await expect.poll(() => results.getByRole('option').count()).toBeGreaterThan(firstPageCount)
  await hand.press('Escape')
  await hand.click()
  await expect.poll(() => results.getByRole('option').count()).toBeGreaterThan(firstPageCount)
  await hand.fill('Muramasa')
  await expect(results).toBeVisible()
  const popup = (await results.boundingBox())!
  const viewport = page.viewportSize()!
  expect(popup.x).toBeGreaterThanOrEqual(0)
  expect(popup.x + popup.width).toBeLessThanOrEqual(viewport.width)
  expect(popup.y).toBeGreaterThanOrEqual(0)
  expect(popup.y + popup.height).toBeLessThanOrEqual(viewport.height)
  await page.screenshot({ path: testInfo.outputPath('inline-search.png'), fullPage: true })
  await hand.press('ArrowDown')
  await hand.press('Enter')
  await expect(hand).toHaveValue('Muramasa')
  await expect(results).not.toBeVisible()
  await hand.fill('made up equipment')
  await expect(results.getByText(/No matching definitions/)).toBeVisible()
  await hand.press('Enter')
  await expect(page.getByRole('button', { name: 'Save build', exact: true })).toBeVisible()
  await hand.press('Escape')
  await expect(hand).toHaveValue('Muramasa')
  await hand.fill('Potion')
  await expect(results.getByRole('option').filter({ hasText: 'PC 1.6.9.0' }).filter({ has: page.locator('strong', { hasText: /^Potion$/ }) })).toHaveCount(0)
  const head = page.getByRole('combobox', { name: 'Head', exact: true })
  if (isMobile) {
    await page.getByRole('heading', { name: 'Equipment', exact: true }).tap()
    await expect(results).not.toBeVisible()
    await head.tap()
  }
  else await head.click()
  await head.fill('Red Hat')
  await expect(page.getByRole('listbox')).toHaveCount(1)
  await page.goBack()
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await page.goForward()
  await expect(head).toHaveValue('Red Hat')
  if (isMobile) {
    await page.getByRole('listbox').getByRole('option').filter({ hasText: 'PC 1.6.9.0' }).filter({ has: page.locator('strong', { hasText: /^Red Hat$/ }) }).tap()
    await expect(page.getByRole('complementary', { name: 'Selection details', exact: true }).getByRole('heading', { name: 'Red Hat', exact: true })).toBeVisible()
    const details = page.getByLabel('Details for Red Hat', { exact: true })
    await expect(details).toHaveText('Details')
    await expect(details).toHaveAccessibleName('Details for Red Hat')
    await page.getByRole('button', { name: 'Clear Head', exact: true }).tap()
  } else await head.press('Escape')
  await expect(head).toHaveValue('')
  await page.getByRole('button', { name: 'Save build', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save new revision', exact: true })).toBeVisible()
  const saved = await exportLocalData(page)
  expect(saved.personalDefinitions).toEqual({})
  const buildId = decodeURIComponent(/#\/builds\/library\/([^/]+)/.exec(page.url())?.[1] ?? '')
  const equipment = Object.values(saved.buildRevisions).find(revision => revision.buildId === buildId)!.content.equipment
  expect(Object.values(equipment).filter(Boolean)).toHaveLength(1)
})

test('build details preview pointer and keyboard inspection without changing the selection', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Pointer transit is checked on desktop')
  await page.goto('/#/builds/library/new')
  await choose(page, 'Class', 'Warrior')
  const details = page.getByRole('complementary', { name: 'Selection details', exact: true })
  await expect(details.getByRole('heading', { name: 'Warrior', exact: true })).toBeVisible()

  const classField = page.getByRole('combobox', { name: 'Class', exact: true })
  await classField.fill('Wizard')
  const candidate = page.getByRole('listbox', { name: 'Choose Class', exact: true }).getByRole('option').filter({ hasText: 'PC 1.6.9.0' }).filter({ has: page.locator('strong', { hasText: /^Wizard$/ }) })
  await candidate.hover()
  await expect(details.getByRole('heading', { name: 'Wizard', exact: true })).toBeVisible()
  await classField.press('Home')
  await expect(candidate).toHaveClass(/picker-result--active/)
  await expect(details.getByRole('heading', { name: 'Wizard', exact: true })).toBeVisible()
  await classField.press('Escape')
  await expect(classField).toHaveValue('Warrior')
})

test('failed creation retains the sheet and retry saves one build and checkpoint', async ({ page }) => {
  await page.goto('/#/builds/library/new')
  await choose(page, 'Main hand', 'Muramasa')
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if (this.name === 'localDatas') { IDBObjectStore.prototype.put = original; throw new DOMException('Synthetic failed build save', 'QuotaExceededError') }
      return original.apply(this, args)
    }
  })
  await page.getByRole('button', { name: 'Save build', exact: true }).click()
  await expect(page.getByText('Revision not saved', { exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toHaveValue('Muramasa')
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Retry save', exact: true }).click()
  await expect(page.getByText('Local save failed', { exact: true })).not.toBeVisible()
  await page.getByRole('button', { name: 'Save build', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save new revision', exact: true })).toBeVisible()
  const saved = await exportLocalData(page)
  const buildId = decodeURIComponent(/#\/builds\/library\/([^/]+)/.exec(page.url())?.[1] ?? '')
  expect(saved.builds[buildId]).toBeDefined()
  expect(Object.values(saved.buildRevisions).filter(revision => revision.buildId === buildId)).toHaveLength(1)
  expect(selectedPlaythrough(saved).inventory).toEqual({})
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Main hand', exact: true })).toHaveValue('Muramasa')
})

test('direct links reveal the next passive position and restore its inline search', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/builds/library/new/pick/slot/passive-1?q=Counter')
  const passive = page.getByRole('combobox', { name: 'Equipped passive 1', exact: true })
  await expect(passive).toBeFocused()
  await expect(passive).toHaveValue('Counter')
  await expect(page.getByRole('listbox', { name: 'Choose Equipped passive 1', exact: true })).toBeVisible()
  await page.reload()
  await expect(passive).toBeFocused()
  await expect(passive).toHaveValue('Counter')
})
