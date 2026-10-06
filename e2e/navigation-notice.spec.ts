import { expect, test, type Locator, type Page } from '@playwright/test'
import type { LocalData } from '../src/domain/types'
import { formatAppRoute, type AppRoute } from '../src/ui/navigation'
import { openCurrentGameSetup, openGameSetupSection, selectedPlaythrough, skipInitialModSetup } from './local-data-helpers'
import { chooseTeamCheckpoint, teamCheckpointControl } from './team-helpers'
import { MOBILE_TEST_TAG } from './test-tags'

const MIN_DEEP_SCROLL_PX = 100
const LAYOUT_TOLERANCE_PX = 1
const inventoryRoute: AppRoute = { page: { page: 'inventory', view: 'list' }, overlays: [], query: {} }

async function storedData(page: Page): Promise<LocalData> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('crykit')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const read = database.transaction('localDatas', 'readonly').objectStore('localDatas').get('local-data-record')
      read.onerror = () => { database.close(); reject(read.error) }
      read.onsuccess = () => { database.close(); resolve(read.result.localData) }
    }
  }))
}

async function attemptRoute(page: Page, route: AppRoute): Promise<void> {
  // A browser history attempt avoids a locator click scrolling the warning into view for the test
  await page.evaluate(hash => { window.location.hash = hash }, formatAppRoute(route))
}

async function scrollDeep(page: Page, dialog?: Locator): Promise<void> {
  const distance = dialog ? await dialog.locator('.sheet__body').evaluate(element => {
    element.scrollTop = element.scrollHeight
    return element.scrollTop
  }) : await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('.main-shell')!
    main.scrollTop = main.scrollHeight
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
    return main.scrollTop + window.scrollY
  })
  expect(distance).toBeGreaterThan(MIN_DEEP_SCROLL_PX)
}

async function expectRecoveryVisible(region: Locator, actions: readonly string[]): Promise<void> {
  await expect(region).toBeFocused()
  for (const name of actions) await expect(region.getByRole('button', { name, exact: true })).toBeEnabled()
  await expect.poll(() => region.evaluate((element, tolerance) => {
    const regionBox = element.getBoundingClientRect()
    const dialog = element.closest('dialog')
    const shown = (node: Element) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden'
    let top = 0
    let bottom = window.innerHeight
    if (dialog) {
      // Native modal Sheets cover background navigation; their own fixed header and body clip the usable area
      top = dialog.querySelector('.sheet__header')!.getBoundingClientRect().bottom
      bottom = Math.min(bottom, (element.closest('.sheet__body') ?? dialog).getBoundingClientRect().bottom)
    } else {
      for (const header of document.querySelectorAll('.mobile-header, .context-bar')) if (shown(header)) top = Math.max(top, header.getBoundingClientRect().bottom)
      for (const navigation of document.querySelectorAll('.bottom-nav')) if (shown(navigation)) bottom = Math.min(bottom, navigation.getBoundingClientRect().top)
    }
    const boxes = [regionBox, ...[...element.querySelectorAll('button')].map(button => button.getBoundingClientRect())]
    return {
      clearOfHeader: boxes.every(box => box.top >= top - tolerance),
      clearOfBottomNavigation: boxes.every(box => box.bottom <= bottom + tolerance),
      fullyInsideWidth: boxes.every(box => box.left >= -tolerance && box.right <= window.innerWidth + tolerance),
      regionTop: regionBox.top, regionBottom: regionBox.bottom, usableTop: top, usableBottom: bottom,
    }
  }, LAYOUT_TOLERANCE_PX)).toMatchObject({ clearOfHeader: true, clearOfBottomNavigation: true, fullyInsideWidth: true })
}

test('repeated blocked Team navigation reveals all recovery choices between fixed navigation and retains the draft', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  const before = await storedData(page)
  await page.goto(formatAppRoute({ page: { page: 'teams', view: 'new' }, overlays: [], query: {} }))
  await page.getByRole('textbox', { name: 'Team name', exact: true }).fill('Synthetic deep Team draft')
  const revisions = Object.values(before.builds).map(build => build.latestRevisionId!)
  for (let index = 0; index < 4; index += 1) await chooseTeamCheckpoint(page, index + 1, revisions[index]!)
  const selected = await Promise.all(Array.from({ length: 4 }, (_, index) => teamCheckpointControl(page, index + 1).innerText()))
  const editorUrl = page.url()
  const notice = page.getByRole('region', { name: 'Resolve unsaved edits', exact: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) await notice.evaluate(element => (element as HTMLElement).blur())
    await scrollDeep(page)
    await attemptRoute(page, inventoryRoute)
    await expect(page).toHaveURL(editorUrl)
    await expectRecoveryVisible(notice, ['Save and continue', 'Discard and continue'])
    await expect(page.getByRole('textbox', { name: 'Team name', exact: true })).toHaveValue('Synthetic deep Team draft')
    expect(await Promise.all(Array.from({ length: 4 }, (_, index) => teamCheckpointControl(page, index + 1).innerText()))).toEqual(selected)
    expect(await storedData(page)).toEqual(before)
  }
})

test('deep Game Setup navigation and close attempts reveal their own choices without saving or discarding fields', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await openCurrentGameSetup(panel)
  await openGameSetupSection(panel, 'Rules from game data')
  for (const summary of await panel.locator('.game-setup-derived summary').all()) {
    if (await summary.isVisible() && await summary.evaluate(element => !element.parentElement!.hasAttribute('open'))) await summary.click()
  }
  const before = await storedData(page)
  const label = panel.getByRole('textbox', { name: 'Game Setup label', exact: true })
  await label.fill('Synthetic deep setup draft')
  await expect(panel.getByRole('button', { name: 'Save Game Setup', exact: true })).toBeEnabled()
  const editorUrl = page.url()
  const notice = panel.getByRole('region', { name: 'Game Setup navigation warning', exact: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) await notice.evaluate(element => (element as HTMLElement).blur())
    await scrollDeep(page, panel)
    await attemptRoute(page, { page: { page: 'settings', section: 'history' }, overlays: [], query: {} })
    await expect(page).toHaveURL(editorUrl)
    await expect(notice).toContainText('Save or discard your Game Setup changes')
    await expectRecoveryVisible(notice, ['Save Game Setup', 'Discard changes'])
    await expect(label).toHaveValue('Synthetic deep setup draft')
    expect(await storedData(page)).toEqual(before)
  }
  const closeNotice = panel.getByRole('region', { name: 'Game Setup close choices', exact: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await scrollDeep(page, panel)
    await page.keyboard.press('Escape')
    await expectRecoveryVisible(closeNotice, ['Discard and close', 'Keep editing'])
    await expect(label).toHaveValue('Synthetic deep setup draft')
    expect(await storedData(page)).toEqual(before)
    await closeNotice.getByRole('button', { name: 'Keep editing', exact: true }).click()
  }
})

test('repeated deep snapshot close attempts reveal save and discard choices while preserving entered and unknown fields', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  const before = await storedData(page)
  const character = Object.values(selectedPlaythrough(before).characters).find(character => character.currentSnapshotId)!
  await page.goto(formatAppRoute({ page: { page: 'characters', view: 'character', characterId: character.id, tab: 'current' }, overlays: [], query: {} }))
  await page.getByRole('button', { name: 'Capture snapshot', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Capture character snapshot', exact: true })
  const statFields = panel.locator('.grid-3')
  // Sample snapshots contain no displayed totals, so enter a stat to make retained-field checks meaningful
  const initialStatCount = await statFields.count()
  await panel.getByRole('button', { name: 'Add stat', exact: true }).click()
  await expect(statFields).toHaveCount(initialStatCount + 1)
  const enteredStat = statFields.last()
  await enteredStat.getByRole('textbox', { name: 'Stat name', exact: true }).fill('Synthetic HP')
  await enteredStat.getByRole('combobox', { name: 'Displayed value certainty', exact: true }).selectOption('known')
  await enteredStat.getByRole('spinbutton', { name: 'Displayed value', exact: true }).fill('420')
  await enteredStat.getByRole('textbox', { name: 'Stat unit', exact: true }).fill('points')
  await expect(enteredStat.getByRole('spinbutton', { name: 'Displayed value', exact: true })).toHaveValue('420')
  const enteredStats = await statFields.evaluateAll(rows => rows.map(row => [...row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')].map(field => field.value)))
  const note = panel.getByLabel('Snapshot note', { exact: true })
  await note.fill('Synthetic deep snapshot draft')
  await panel.getByRole('combobox', { name: 'Level certainty', exact: true }).selectOption('unknown')
  const notice = panel.getByRole('region', { name: 'Snapshot navigation warning', exact: true })
  const editorUrl = page.url()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) await notice.evaluate(element => (element as HTMLElement).blur())
    await scrollDeep(page, panel)
    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(editorUrl)
    await expect(notice).toContainText('Unsaved snapshot')
    await expectRecoveryVisible(notice, ['Save snapshot', 'Cancel and discard'])
    await expect(note).toHaveValue('Synthetic deep snapshot draft')
    await expect(panel.getByRole('combobox', { name: 'Level certainty', exact: true })).toHaveValue('unknown')
    expect(await statFields.evaluateAll(rows => rows.map(row => [...row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')].map(field => field.value)))).toEqual(enteredStats)
    expect(await storedData(page)).toEqual(before)
  }
})
