import { chooseTeamCheckpoint } from './team-helpers'
import { expect, test, type Page } from '@playwright/test'
import type { LocalData } from '../src/domain/types'
import { MOBILE_TEST_TAG } from './test-tags'
import { closeBuildActions, openBuildActions } from './planning-header-helpers'

const SAMPLE_BUILD = 'Rowan: sample Warrior'

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

async function expectHeaderControls(page: Page) {
  const header = page.locator('.context-bar')
  const viewport = page.viewportSize()!
  for (const control of await header.locator('button, select, input').filter({ visible: true }).all()) {
    const bounds = (await control.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
    expect(await control.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      return hit === element || element.contains(hit)
    })).toBe(true)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

test('planning headers identify the page and keep commands usable at narrow widths', { tag: MOBILE_TEST_TAG }, async ({ page, isMobile }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  for (const width of isMobile ? [320, 390] : [821, 1024, 1440]) {
    await page.setViewportSize({ width, height: isMobile ? 844 : 1000 })
    await page.goto('/#/builds/library')
    const header = page.locator('.context-bar')
    await expect(header.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
    await expect(header.getByRole('button', { name: 'New Build', exact: true })).toBeVisible()
    await expect(page.locator('.content .screen-header')).toHaveCount(0)
    await expect(page.locator('.content').getByRole('searchbox', { name: 'Search Build library', exact: true })).toBeVisible()
    await expectHeaderControls(page)
    await page.getByRole('button', { name: SAMPLE_BUILD, exact: true }).click()
    await expect(header.getByRole('heading', { name: SAMPLE_BUILD, exact: true })).toBeVisible()
    const checkpoint = header.getByRole('combobox', { name: 'Editor checkpoint', exact: true })
    await expect(checkpoint).toBeVisible()
    if (width <= 820) {
      const checkpointBounds = (await checkpoint.boundingBox())!
      expect(checkpointBounds.width).toBeGreaterThanOrEqual(width - 30)
      expect(checkpointBounds.height).toBeGreaterThanOrEqual(44)
    }
    await expect(header.getByRole('button', { name: 'Save new revision', exact: true })).toBeVisible()
    await expect(page.locator('.build-sheet').getByRole('button', { name: 'Save new revision', exact: true })).toHaveCount(0)
    await expectHeaderControls(page)
    await header.getByRole('button', { name: 'Rename', exact: true }).click()
    const title = header.getByRole('textbox', { name: 'Build title', exact: true })
    await expect(title).toBeFocused()
    await expect(title).toHaveValue(SAMPLE_BUILD)
    await expect(page.locator('.build-sheet').getByRole('textbox', { name: 'Build title', exact: true })).toHaveCount(0)
    // A hit-test alone can pass for an input too narrow to read or edit
    expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(120)
    await expectHeaderControls(page)
    await title.press('Escape')
    await expect(header.getByRole('button', { name: 'Rename', exact: true })).toBeFocused()
    const fallbackFont = await page.addStyleTag({ content: '.loadout-sheet { font-family: monospace; }' })
    await expectHeaderControls(page)
    await fallbackFont.evaluate(element => element.parentNode?.removeChild(element))
    await page.goto('/#/reference')
    await expect(header.getByRole('heading', { name: 'Reference', exact: true })).toBeVisible()
    await expectHeaderControls(page)
  }
  await page.screenshot({ path: testInfo.outputPath('reference-command-header.png'), fullPage: true })
  await page.goto('/#/teams')
  await expect(page.locator('.context-bar').getByRole('heading', { name: 'Teams', exact: true })).toBeVisible()
  await page.goto('/#/reference')
  await expect(page.locator('.context-bar').getByRole('heading', { name: 'Reference', exact: true })).toBeVisible()
  await page.goto('/#/mods')
  await expect(page.locator('.context-bar').getByRole('heading', { name: 'Mods', exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('header revision saves retain failures for retry and preserve the earlier checkpoint', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/builds/library')
  await page.getByRole('button', { name: SAMPLE_BUILD, exact: true }).click()
  const before = await storedData(page)
  const build = Object.values(before.builds).find(build => build.title === SAMPLE_BUILD)!
  const original = before.buildRevisions[build.latestRevisionId!]!
  const save = page.locator('.context-bar').getByRole('button', { name: 'Save new revision', exact: true })
  expect(await save.evaluate(button => (button as HTMLButtonElement).form?.classList.contains('build-sheet'))).toBe(true)
  await page.getByRole('combobox', { name: 'Class', exact: true }).fill('Wizard')
  await page.getByRole('listbox', { name: 'Choose Class', exact: true }).getByRole('option').filter({ hasText: 'Windows 1.6.9' }).filter({ has: page.locator('strong', { hasText: /^Wizard$/ }) }).click()
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if (this.name === 'localDatas') { IDBObjectStore.prototype.put = original; throw new DOMException('Synthetic header save failure', 'QuotaExceededError') }
      return original.apply(this, args)
    }
  })
  await save.click()
  await expect(page.getByText('Revision not saved', { exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Wizard')
  expect((await storedData(page)).buildRevisions).toEqual(before.buildRevisions)
  await page.getByRole('button', { name: 'Retry save', exact: true }).click()
  await expect(page.getByText('Local save failed', { exact: true })).not.toBeVisible()
  const after = await storedData(page)
  expect(after.buildRevisions[original.id]).toEqual(original)
  expect(after.buildRevisions[after.builds[build.id]!.latestRevisionId!]!.revision).toBe(original.revision + 1)
  expect(Object.keys(after.buildRevisions)).toHaveLength(Object.keys(before.buildRevisions).length + 1)
  await page.getByRole('button', { name: 'Discard edits', exact: true }).click()
  await page.locator('.context-bar').getByRole('combobox', { name: 'Editor checkpoint', exact: true }).selectOption(after.builds[build.id]!.latestRevisionId!)
  await expect(page.locator('.context-bar').getByRole('combobox', { name: 'Editor checkpoint', exact: true }).locator('option:checked')).toContainText('r2')
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Wizard')
})

test('dismissing More preserves metadata drafts and restores its keyboard focus', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/builds/library')
  await page.getByRole('button', { name: SAMPLE_BUILD, exact: true }).click()
  const before = await storedData(page)
  const build = Object.values(before.builds).find(build => build.title === SAMPLE_BUILD)!
  const header = page.locator('.context-bar')
  await openBuildActions(page)
  await page.getByRole('dialog', { name: 'Build actions', exact: true }).getByRole('button', { name: 'Rename', exact: true }).click()
  const title = header.getByRole('textbox', { name: 'Build title', exact: true })
  await expect(page.getByRole('button', { name: 'More', exact: true })).toHaveAttribute('aria-expanded', 'false')
  await expect(title).toBeFocused()
  await title.fill('Synthetic retained title')
  await openBuildActions(page)
  await page.locator('.build-tags-control').locator('summary').click()
  await page.getByLabel('Add tag', { exact: true }).fill('synthetic retained tag')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'More', exact: true })).toBeFocused()
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Editor checkpoint', exact: true })).toBeDisabled()
  await expect(title).toHaveValue('Synthetic retained title')
  await openBuildActions(page)
  await expect(page.getByLabel('Add tag', { exact: true })).toHaveValue('synthetic retained tag')
  expect(await storedData(page)).toEqual(before)
  await closeBuildActions(page)
  await header.getByRole('button', { name: 'Save details', exact: true }).click()
  await expect(header.getByRole('heading', { name: 'Synthetic retained title', exact: true })).toBeVisible()
  await expect(header.getByRole('button', { name: 'Rename', exact: true })).toBeFocused()
  const after = await storedData(page)
  expect(after.builds[build.id]).toMatchObject({ title: 'Synthetic retained title', tags: ['sample', 'synthetic retained tag'], latestRevisionId: build.latestRevisionId })
  expect(after.buildRevisions).toEqual(before.buildRevisions)
  expect(after.playthroughs).toEqual(before.playthroughs)
})

test('header Rename saves with Enter and Escape cancels only the title draft', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/builds/library')
  await page.getByRole('button', { name: SAMPLE_BUILD, exact: true }).click()
  const before = await storedData(page)
  const build = Object.values(before.builds).find(build => build.title === SAMPLE_BUILD)!
  const header = page.locator('.context-bar')
  await header.getByRole('button', { name: 'Rename', exact: true }).click()
  const title = header.getByRole('textbox', { name: 'Build title', exact: true })
  await expect(title).toBeFocused()
  expect(await title.evaluate(input => (input as HTMLInputElement).form?.classList.contains('build-sheet'))).toBe(false)
  await title.fill('Synthetic inline rename')
  await title.press('Enter')
  await expect(header.getByRole('heading', { name: 'Synthetic inline rename', exact: true })).toBeVisible()
  await expect(title).toHaveCount(0)
  await expect(header.getByRole('button', { name: 'Rename', exact: true })).toBeFocused()
  const renamed = await storedData(page)
  expect(renamed.builds[build.id]).toMatchObject({ title: 'Synthetic inline rename', latestRevisionId: build.latestRevisionId })
  expect(renamed.revision).toBe(before.revision + 1)
  expect(renamed.buildRevisions).toEqual(before.buildRevisions)
  expect(renamed.playthroughs).toEqual(before.playthroughs)

  await openBuildActions(page)
  await page.locator('.build-tags-control').locator('summary').click()
  await page.getByLabel('Add tag', { exact: true }).fill('synthetic pending tag')
  await closeBuildActions(page)
  await header.getByRole('button', { name: 'Rename', exact: true }).click()
  await title.fill('Synthetic canceled title')
  await title.press('Escape')
  await expect(header.getByRole('heading', { name: 'Synthetic inline rename', exact: true })).toBeVisible()
  await expect(header.getByRole('button', { name: 'Rename', exact: true })).toBeFocused()
  await expect(title).toHaveCount(0)
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible()
  await openBuildActions(page)
  await expect(page.getByLabel('Add tag', { exact: true })).toHaveValue('synthetic pending tag')
  expect(await storedData(page)).toEqual(renamed)
  await page.getByRole('button', { name: 'Save details', exact: true }).click()
  const tagged = await storedData(page)
  expect(tagged.builds[build.id]).toMatchObject({ title: 'Synthetic inline rename', tags: ['sample', 'synthetic pending tag'], latestRevisionId: build.latestRevisionId })
  expect(tagged.buildRevisions).toEqual(before.buildRevisions)
  expect(tagged.playthroughs).toEqual(before.playthroughs)
})

test('a new Build title in the header alone activates the navigation guard', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/builds/library/new')
  const newBuildUrl = page.url()
  const header = page.locator('.context-bar')
  const title = header.getByRole('textbox', { name: 'Build title', exact: true })
  await expect(title).toHaveValue('')
  const before = await storedData(page)
  await expect(page.locator('.build-sheet').getByRole('textbox', { name: 'Build title', exact: true })).toHaveCount(0)
  expect(await title.evaluate(input => (input as HTMLInputElement).form?.classList.contains('build-sheet'))).toBe(true)
  await title.fill('Synthetic title-only draft')
  await expectHeaderControls(page)
  await page.getByRole('button', { name: 'Characters', exact: true }).filter({ visible: true }).click()
  const guard = page.getByRole('region', { name: 'Resolve unsaved edits', exact: true })
  await expect(guard.getByText('Unsaved edits are still open', { exact: true })).toBeVisible()
  await expect(guard).toBeInViewport()
  await expect(page).toHaveURL(newBuildUrl)
  await expect(title).toHaveValue('Synthetic title-only draft')
  expect(await storedData(page)).toEqual(before)
  await guard.getByRole('button', { name: 'Discard and continue', exact: true }).click()
  await expect(page).toHaveURL(/#\/characters/)
  expect(await storedData(page)).toEqual(before)
})

test('Team member Build titles live in the header and cancellation preserves the pending Team', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/teams/new')
  await expect(page.getByRole('textbox', { name: 'Team name', exact: true })).toBeVisible()
  const before = await storedData(page)
  const build = Object.values(before.builds).find(build => build.title === SAMPLE_BUILD)!
  await page.getByRole('textbox', { name: 'Team name', exact: true }).fill('Synthetic pending header Team')
  await chooseTeamCheckpoint(page, 1, build.latestRevisionId!)
  const header = page.locator('.context-bar')
  const slot = page.getByRole('region', { name: 'Team slot 1 loadout', exact: true })
  await slot.getByRole('button', { name: 'Edit member', exact: true }).click()
  const title = header.getByRole('textbox', { name: 'Build title', exact: true })
  await expect(title).toHaveValue(SAMPLE_BUILD)
  await expect(title).toHaveAttribute('required', '')
  await expect(page.locator('.build-sheet').getByRole('textbox', { name: 'Build title', exact: true })).toHaveCount(0)
  expect(await title.evaluate(input => (input as HTMLInputElement).form?.classList.contains('build-sheet'))).toBe(true)
  await title.fill('Synthetic canceled Team member')
  await expectHeaderControls(page)
  await page.getByRole('button', { name: 'Cancel and return to Team', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Team name', exact: true })).toHaveValue('Synthetic pending header Team')
  await expect(slot).toContainText(`Selected checkpoint: ${SAMPLE_BUILD}`)
  expect(await storedData(page)).toEqual(before)

  await page.getByRole('region', { name: 'Team slot 2 loadout', exact: true }).getByRole('button', { name: 'Create member', exact: true }).click()
  await expect(title).toHaveValue('')
  await expect(title).not.toHaveAttribute('required')
  await expect(page.locator('.build-sheet').getByRole('textbox', { name: 'Build title', exact: true })).toHaveCount(0)
  await title.fill('Synthetic canceled new member')
  await expectHeaderControls(page)
  await page.getByRole('button', { name: 'Cancel and return to Team', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Team name', exact: true })).toHaveValue('Synthetic pending header Team')
  await expect(slot).toContainText(`Selected checkpoint: ${SAMPLE_BUILD}`)
  expect(await storedData(page)).toEqual(before)
})

test('Team header saves use native validation and sharing leaves the saved Team unchanged', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/teams/new')
  const header = page.locator('.context-bar')
  const save = header.getByRole('button', { name: 'Save Team', exact: true })
  await expect(save).toBeDisabled()
  const name = page.getByRole('textbox', { name: 'Team name', exact: true })
  await name.fill('Synthetic header Team')
  await chooseTeamCheckpoint(page, 1)
  await name.evaluate(input => (input as HTMLInputElement).setCustomValidity('Synthetic invalid Team name'))
  await save.click()
  await expect(header.getByRole('heading', { name: 'New Team', exact: true })).toBeVisible()
  expect(Object.values((await storedData(page)).teams).map(team => team.title)).toEqual(['Sample starter Team'])
  await name.evaluate(input => (input as HTMLInputElement).setCustomValidity(''))
  await save.click()
  await expect(header.getByRole('heading', { name: 'Synthetic header Team', exact: true })).toBeVisible()
  const beforeShare = await storedData(page)
  await header.getByRole('button', { name: 'Share team', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Share team', exact: true })).toBeVisible()
  expect(await storedData(page)).toEqual(beforeShare)
  await page.getByRole('dialog', { name: 'Share team', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
  await expectHeaderControls(page)
})

test('reference research shows its own header while preserving the Build and metadata drafts', { tag: MOBILE_TEST_TAG }, async ({ page, isMobile }) => {
  if (!isMobile) await page.setViewportSize({ width: 821, height: 1000 })
  await page.goto('/#/builds/library')
  await expect(page.locator('.context-bar').getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  const libraryHeaderHeight = (await page.locator('.context-bar').boundingBox())!.height
  await page.getByRole('button', { name: SAMPLE_BUILD, exact: true }).click()
  const buildUrl = page.url()
  await page.getByRole('combobox', { name: 'Class', exact: true }).fill('Wizard')
  await page.getByRole('listbox', { name: 'Choose Class', exact: true }).getByRole('option').filter({ hasText: 'Windows 1.6.9' }).filter({ has: page.locator('strong', { hasText: /^Wizard$/ }) }).click()
  await openBuildActions(page)
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await page.getByRole('textbox', { name: 'Build title', exact: true }).fill('Synthetic research draft')
  await page.getByRole('navigation', { name: 'Primary navigation', exact: true }).filter({ visible: true }).getByRole('button', { name: 'Reference', exact: true }).click()
  await expect(page.locator('.context-bar').getByRole('heading', { name: 'Reference', exact: true })).toBeVisible()
  await expect(page.locator('.context-bar').getByRole('heading')).toHaveCount(1)
  if (!isMobile) expect((await page.locator('.context-bar').boundingBox())!.height).toBe(libraryHeaderHeight)
  await expect(page.locator('.context-bar').getByRole('button', { name: 'Save new revision', exact: true })).toHaveCount(0)
  await page.goBack()
  await expect(page).toHaveURL(buildUrl)
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Wizard')
  await expect(page.locator('.context-bar').getByRole('textbox', { name: 'Build title', exact: true })).toHaveValue('Synthetic research draft')
})
