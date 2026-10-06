import { closeBuildActions, clickBuildAction, openBuildComparison, openBuildLibrary } from './planning-header-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'
import type { LocalData } from '../src/domain/types'

const ORIGINAL_TITLE = 'Rowan: sample Warrior'
const RENAMED_TITLE = 'Rowan: frontline protector'

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

async function rename(page: Page, title: string) {
  await clickBuildAction(page, 'Rename')
  const input = page.getByRole('textbox', { name: 'Build title', exact: true })
  await expect(input).toBeFocused()
  await input.fill(title)
}

async function chooseWizard(page: Page) {
  await page.getByRole('combobox', { name: 'Class', exact: true }).fill('Wizard')
  await page.getByRole('listbox', { name: 'Choose Class', exact: true }).getByRole('option').filter({ hasText: 'Windows 1.6.9' }).filter({ has: page.locator('strong', { hasText: /^Wizard$/ }) }).click()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/#/builds/library')
  await page.getByRole('button', { name: ORIGINAL_TITLE, exact: true }).click()
})

test('renaming persists the title while preserving every checkpoint and team assignment', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  const before = await exportLocalData(page)
  const build = Object.values(before.builds).find(build => build.title === ORIGINAL_TITLE)!
  await rename(page, `  ${RENAMED_TITLE}  `)
  await page.getByRole('textbox', { name: 'Build title', exact: true }).press('Enter')
  await expect(page.getByRole('heading', { name: RENAMED_TITLE, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeFocused()
  const after = await exportLocalData(page)
  expect(after.builds[build.id]).toMatchObject({ title: RENAMED_TITLE, latestRevisionId: build.latestRevisionId })
  expect(after.buildRevisions).toEqual(before.buildRevisions)
  expect(after.playthroughs).toEqual(before.playthroughs)
  await page.reload()
  await expect(page.getByRole('heading', { name: RENAMED_TITLE, exact: true })).toBeVisible()
  await openBuildLibrary(page)
  await expect(page.getByRole('button', { name: RENAMED_TITLE, exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('canceling and saving an unchanged title make no local transaction', async ({ page }) => {
  const before = await exportLocalData(page)
  await rename(page, RENAMED_TITLE)
  await page.getByRole('button', { name: 'Cancel details', exact: true }).click()
  await expect(page.getByRole('heading', { name: ORIGINAL_TITLE, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeFocused()
  await rename(page, ` ${ORIGINAL_TITLE} `)
  await page.getByRole('button', { name: 'Save details', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeFocused()
  expect(await exportLocalData(page)).toEqual(before)
})

test('renaming keeps an unfinished loadout and its navigation guard even when the library search stops matching', async ({ page }) => {
  const before = await exportLocalData(page)
  await openBuildLibrary(page)
  await page.getByRole('searchbox', { name: 'Search Build library', exact: true }).fill(ORIGINAL_TITLE)
  await chooseWizard(page)
  await rename(page, RENAMED_TITLE)
  await page.getByRole('button', { name: 'Save details', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Wizard')
  await closeBuildActions(page)
  await openBuildComparison(page)
  await expect(page.getByText('Build edits are still open', { exact: true })).toBeVisible()
  await closeBuildActions(page)
  await page.getByRole('button', { name: 'Discard and continue', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Revision A', exact: true })).toBeVisible()
  const after = await exportLocalData(page)
  expect(after.buildRevisions).toEqual(before.buildRevisions)
  await page.goto('/#/builds/library')
  await page.getByRole('button', { name: RENAMED_TITLE, exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Warrior')
})

test('save and continue resolves title and loadout drafts together', async ({ page }) => {
  const before = await exportLocalData(page)
  const build = Object.values(before.builds).find(build => build.title === ORIGINAL_TITLE)!
  await chooseWizard(page)
  await rename(page, RENAMED_TITLE)
  await page.getByRole('button', { name: 'Characters', exact: true }).filter({ visible: true }).click()
  await expect(page.getByText('Unsaved edits are still open', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click()
  await expect(page).toHaveURL(/#\/characters/)
  const after = await exportLocalData(page)
  expect(after.builds[build.id]?.title).toBe(RENAMED_TITLE)
  const checkpoints = Object.values(after.buildRevisions).filter(revision => revision.buildId === build.id)
  expect(checkpoints).toHaveLength(Object.values(before.buildRevisions).filter(revision => revision.buildId === build.id).length + 1)
  expect(after.buildRevisions[build.latestRevisionId!]).toEqual(before.buildRevisions[build.latestRevisionId!])
  await page.goto('/#/builds/library')
  await page.getByRole('button', { name: RENAMED_TITLE, exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Wizard')
})

test('failed title persistence retains both drafts for retry without creating a checkpoint', async ({ page }) => {
  const before = await exportLocalData(page)
  await chooseWizard(page)
  await rename(page, RENAMED_TITLE)
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if (this.name === 'localDatas') { IDBObjectStore.prototype.put = original; throw new DOMException('Synthetic failed title save', 'QuotaExceededError') }
      return original.apply(this, args)
    }
  })
  await page.getByRole('button', { name: 'Save details', exact: true }).click()
  await expect(page.locator('.context-bar').getByRole('alert').getByText('Build details not saved.', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: ORIGINAL_TITLE, exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Build title', exact: true })).toHaveValue(RENAMED_TITLE)
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Wizard')
  await page.getByRole('button', { name: 'Save details', exact: true }).click()
  await expect(page.getByRole('heading', { name: RENAMED_TITLE, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeFocused()
  await closeBuildActions(page)
  await openBuildComparison(page)
  await closeBuildActions(page)
  await page.getByRole('button', { name: 'Discard and continue', exact: true }).click()
  const after = await exportLocalData(page)
  expect(after.buildRevisions).toEqual(before.buildRevisions)
  expect(after.playthroughs).toEqual(before.playthroughs)
})

test('a blank title cannot pass the navigation guard and discard leaves the name intact', async ({ page }) => {
  const before = await exportLocalData(page)
  await rename(page, '   ')
  await closeBuildActions(page)
  await openBuildComparison(page)
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click()
  await expect(page.locator('.context-bar').getByRole('alert').getByText('Enter a Build title.', { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Build title', exact: true })).toHaveValue('   ')
  await expect(page.getByRole('heading', { name: ORIGINAL_TITLE, exact: true })).toBeVisible()
  await closeBuildActions(page)
  await page.getByRole('button', { name: 'Discard and continue', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Revision A', exact: true })).toBeVisible()
  expect(await exportLocalData(page)).toEqual(before)
})
