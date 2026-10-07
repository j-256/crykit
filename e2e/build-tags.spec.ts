import { closeBuildActions, clickBuildAction, openBuildActions, openBuildComparison } from './planning-header-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'
import { BUNDLED_CATALOGS } from '../src/catalog/bundled'
import type { LocalData } from '../src/domain/types'
import { previewNativeBackup } from '../src/interchange/native'
import { createSharePayload } from '../src/interchange/share'

const ORIGINAL_TITLE = 'Rowan: sample Warrior'
const TAG = 'guard rotation'
const NEW_TITLE = 'Synthetic tagged Build'
const DETAILS_ACTION_SPACING = 16

async function storedData(page: Page): Promise<LocalData> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('crykit')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const read = database.transaction('localDatas', 'readonly').objectStore('localDatas').getAll()
      read.onerror = () => { database.close(); reject(read.error) }
      read.onsuccess = () => { database.close(); resolve(read.result[0].localData) }
    }
  }))
}

function tagsControl(page: Page) { return page.locator('.build-tags-control') }
async function openTags(page: Page) { await openBuildActions(page); await tagsControl(page).locator('summary').click() }
async function addTag(page: Page, value: string) {
  await page.getByLabel('Add tag', { exact: true }).fill(value)
  await page.getByRole('button', { name: 'Add tag', exact: true }).click()
}
async function chooseWizard(page: Page) {
  await page.getByRole('combobox', { name: 'Class', exact: true }).fill('Wizard')
  await page.getByRole('listbox', { name: 'Choose Class', exact: true }).getByRole('option').filter({ hasText: 'PC 1.6.9.0' }).filter({ has: page.locator('strong', { hasText: /^Wizard$/ }) }).click()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/#/builds/library')
  await page.getByRole('button', { name: ORIGINAL_TITLE, exact: true }).click()
})

test('details actions have balanced spacing within the Build actions popover', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  const form = page.locator('.build-details-control')
  const cancel = form.getByRole('button', { name: 'Cancel details', exact: true })
  const save = form.getByRole('button', { name: 'Save details', exact: true })
  const secondaryCommands = page.locator('.workspace-more__commands')
  const expectSpacing = async (preceding: Locator) => {
    const [previousBox, cancelBox, saveBox, commandsBox] = await Promise.all([preceding.boundingBox(), cancel.boundingBox(), save.boundingBox(), secondaryCommands.boundingBox()])
    expect(previousBox).not.toBeNull()
    expect(cancelBox).not.toBeNull()
    expect(saveBox).not.toBeNull()
    expect(commandsBox).not.toBeNull()
    expect(cancelBox!.y - previousBox!.y - previousBox!.height).toBeCloseTo(DETAILS_ACTION_SPACING, 0)
    expect(commandsBox!.y).toBeGreaterThan(saveBox!.y + saveBox!.height)
    expect(cancelBox!.y).toBeCloseTo(saveBox!.y, 0)
    expect(saveBox!.x).toBeGreaterThan(cancelBox!.x + cancelBox!.width)
  }
  await openTags(page)
  await page.getByRole('button', { name: 'Remove tag sample', exact: true }).click()
  await expectSpacing(tagsControl(page).locator('.field__hint'))
  await page.getByLabel('Add tag', { exact: true }).fill(TAG)
  await openTags(page)
  await expectSpacing(tagsControl(page).locator('summary'))
  await cancel.click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('optional tags persist independently, round-trip in backups, and match both searches', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  const before = await storedData(page)
  const build = Object.values(before.builds).find(build => build.title === ORIGINAL_TITLE)!
  await openBuildActions(page)
  await expect(tagsControl(page).locator('summary')).toHaveAccessibleName('Tags (1)')
  await expect(page.getByLabel('Add tag', { exact: true })).not.toBeVisible()
  await openTags(page)
  await page.getByRole('button', { name: 'Remove tag sample', exact: true }).click()
  await addTag(page, `  ${TAG}  `)
  await addTag(page, TAG.toUpperCase())
  await expect(page.getByRole('list', { name: 'Build tags', exact: true }).locator('li')).toHaveCount(1)
  await page.getByLabel('Add tag', { exact: true }).fill('early game')
  await page.getByRole('button', { name: 'Save details', exact: true }).click()
  await expect(tagsControl(page)).not.toHaveAttribute('open')
  await expect(tagsControl(page).locator('summary')).toBeFocused()
  await expect(tagsControl(page).locator('summary')).toHaveAccessibleName('Tags (2)')
  const after = await storedData(page)
  expect(after.builds[build.id]).toMatchObject({ tags: [TAG, 'early game'], latestRevisionId: build.latestRevisionId })
  expect(after.buildRevisions).toEqual(before.buildRevisions)
  expect(after.playthroughs).toEqual(before.playthroughs)
  expect(createSharePayload(after, { kind: 'build', revisionId: build.latestRevisionId! }).records.builds[build.id]!.tags).toEqual([])

  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const settings = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await settings.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const download = page.waitForEvent('download')
  await settings.getByRole('button', { name: 'Export backup', exact: true }).click()
  const bytes = await readFile((await (await download).path())!)
  const backup = JSON.parse(strFromU8(unzipSync(bytes)['bundle.json']!)) as { localData: LocalData }
  expect(backup.localData.builds).toEqual(after.builds)
  expect((await previewNativeBackup(bytes, 'synthetic-tags.zip', BUNDLED_CATALOGS)).proposed.localData.builds).toEqual(after.builds)
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.reload()
  await openTags(page)
  await expect(page.getByRole('list', { name: 'Build tags', exact: true })).toContainText(TAG)
  await page.getByRole('button', { name: 'Cancel details', exact: true }).click()
  await closeBuildActions(page)
  await page.getByRole('button', { name: 'Back to Build library', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search Build library', exact: true }).fill(TAG)
  await expect(page.locator('.build-card')).toHaveCount(1)
  await expect(page.locator('.build-card .badge').filter({ hasText: TAG })).toBeVisible()
  await page.keyboard.press('Control+k')
  const search = page.getByRole('dialog', { name: 'Search CryKit', exact: true })
  await search.getByRole('searchbox', { name: 'Search CryKit', exact: true }).fill(TAG)
  await expect(search.getByRole('link').filter({ hasText: ORIGINAL_TITLE })).toBeVisible()
})

test('cancel and unchanged saves make no transaction, and collapsing retains pending edits', async ({ page }) => {
  const before = await storedData(page)
  await openTags(page)
  await page.getByLabel('Add tag', { exact: true }).fill(TAG)
  await openTags(page)
  await expect(tagsControl(page)).not.toHaveAttribute('open')
  await openTags(page)
  await expect(page.getByLabel('Add tag', { exact: true })).toHaveValue(TAG)
  await page.getByRole('button', { name: 'Cancel details', exact: true }).click()
  await openTags(page)
  await expect(page.getByLabel('Add tag', { exact: true })).toHaveValue('')
  await page.getByRole('button', { name: 'Save details', exact: true }).click()
  expect(await storedData(page)).toEqual(before)
  await openTags(page)
  await page.getByLabel('Add tag', { exact: true }).fill(TAG)
  await closeBuildActions(page)
  await openBuildComparison(page)
  await expect(page.getByText('Build edits are still open', { exact: true })).toBeVisible()
  await closeBuildActions(page)
  await page.getByRole('button', { name: 'Discard and continue', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Revision A', exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
})

test('failed detail saves roll back title and tags together while retaining the loadout draft', async ({ page }) => {
  const before = await storedData(page)
  const build = Object.values(before.builds).find(build => build.title === ORIGINAL_TITLE)!
  await chooseWizard(page)
  await clickBuildAction(page, 'Rename')
  await page.getByRole('textbox', { name: 'Build title', exact: true }).fill(NEW_TITLE)
  await openTags(page)
  await page.getByLabel('Add tag', { exact: true }).fill(TAG)
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if (this.name === 'localDatas') { IDBObjectStore.prototype.put = original; throw new DOMException('Synthetic failed tag save', 'QuotaExceededError') }
      return original.apply(this, args)
    }
  })
  await page.getByRole('button', { name: 'Save details', exact: true }).click()
  await expect(page.locator('.context-bar').getByRole('alert').getByText('Build details not saved.', { exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(before)
  await expect(page.getByRole('heading', { name: ORIGINAL_TITLE, exact: true })).toBeVisible()
  await expect(page.locator('.context-bar').getByRole('textbox', { name: 'Build title', exact: true })).toHaveValue(NEW_TITLE)
  await openBuildActions(page)
  await expect(page.getByLabel('Add tag', { exact: true })).toHaveValue(TAG)
  await closeBuildActions(page)
  await page.getByRole('button', { name: 'Save details', exact: true }).click()
  await openBuildActions(page)
  await expect(tagsControl(page)).not.toHaveAttribute('open')
  await expect(page.getByRole('heading', { name: NEW_TITLE, exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Wizard')
  await closeBuildActions(page)
  await openBuildComparison(page)
  await closeBuildActions(page)
  await page.getByRole('button', { name: 'Discard and continue', exact: true }).click()
  const after = await storedData(page)
  expect(after.builds[build.id]).toMatchObject({ title: NEW_TITLE, tags: ['sample', TAG] })
  expect(after.revision).toBe(before.revision + 1)
  expect(after.buildRevisions).toEqual(before.buildRevisions)
  expect(after.playthroughs).toEqual(before.playthroughs)
})

test('save and continue handles title, tag, and loadout drafts together', async ({ page }) => {
  const before = await storedData(page)
  const build = Object.values(before.builds).find(build => build.title === ORIGINAL_TITLE)!
  await chooseWizard(page)
  await clickBuildAction(page, 'Rename')
  await page.getByRole('textbox', { name: 'Build title', exact: true }).fill(NEW_TITLE)
  await openTags(page)
  await page.getByLabel('Add tag', { exact: true }).fill(TAG)
  await page.getByRole('button', { name: 'Characters', exact: true }).filter({ visible: true }).click()
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click()
  await expect(page).toHaveURL(/#\/characters/)
  const after = await storedData(page)
  expect(after.builds[build.id]).toMatchObject({ title: NEW_TITLE, tags: ['sample', TAG] })
  expect(after.buildRevisions[build.latestRevisionId!]).toEqual(before.buildRevisions[build.latestRevisionId!])
  expect(Object.keys(after.buildRevisions)).toHaveLength(Object.keys(before.buildRevisions).length + 1)
  await page.goto('/#/builds/library')
  await page.getByRole('button', { name: NEW_TITLE, exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Wizard')
})

test('new Builds offer optional tags and save pending text through the navigation guard', async ({ page }) => {
  await clickBuildAction(page, 'New Build')
  const newBuildUrl = page.url()
  const before = await storedData(page)
  await expect(page.getByRole('button', { name: 'Loadout', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const title = page.locator('.context-bar').getByRole('textbox', { name: 'Build title', exact: true })
  await title.fill(NEW_TITLE)
  await expect(page.getByLabel('Add tag', { exact: true })).not.toBeVisible()
  await page.locator('.build-sheet .build-tags-control').locator('summary').click()
  await expect(tagsControl(page).locator('datalist option[value="sample"]')).toHaveCount(1)
  await page.getByLabel('Add tag', { exact: true }).fill(TAG)
  await page.getByLabel('Add tag', { exact: true }).press('Enter')
  await expect(page).toHaveURL(newBuildUrl)
  await expect(title).toHaveValue(NEW_TITLE)
  expect(await storedData(page)).toEqual(before)
  await page.getByLabel('Add tag', { exact: true }).fill('early game')
  await page.getByRole('button', { name: 'Characters', exact: true }).filter({ visible: true }).click()
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click()
  await expect(page).toHaveURL(/#\/characters/)
  const data = await storedData(page)
  expect(Object.values(data.builds).find(build => build.title === NEW_TITLE)!.tags).toEqual([TAG, 'early game'])
})

test('long tags wrap on cards and in the editor, survive cloning, and can all be removed', { tag: MOBILE_TEST_TAG }, async ({ page, isMobile }) => {
  const longTag = 'synthetic-label'.repeat(12)
  await openTags(page)
  await addTag(page, longTag)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Save details', exact: true }).click()
  await expect(tagsControl(page)).not.toHaveAttribute('open')
  await clickBuildAction(page, 'Clone Build')
  await expect(page.getByRole('heading', { name: `${ORIGINAL_TITLE} (copy)`, exact: true })).toBeVisible()
  await openTags(page)
  await expect(page.getByRole('list', { name: 'Build tags', exact: true })).toContainText(longTag)
  await page.getByRole('button', { name: `Remove tag ${longTag}`, exact: true }).click()
  await page.getByRole('button', { name: 'Remove tag sample', exact: true }).click()
  await page.getByRole('button', { name: 'Save details', exact: true }).click()
  await expect(tagsControl(page)).not.toHaveAttribute('open')
  expect(Object.values((await storedData(page)).builds).find(build => build.title === `${ORIGINAL_TITLE} (copy)`)!.tags).toEqual([])
  await closeBuildActions(page)
  await page.getByRole('button', { name: 'Back to Build library', exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search Build library', exact: true }).fill(longTag)
  await expect(page.locator('.build-card')).toHaveCount(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  if (isMobile) await expect(page.locator('.build-card .badge').filter({ hasText: longTag })).toBeVisible()
})
