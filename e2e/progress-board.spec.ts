import { MOBILE_TEST_TAG } from './test-tags'
import { expect, test, type Page } from '@playwright/test'

import { createBlankPlaythrough } from './local-data-helpers'

const QUEUED_SAVE_DRAIN_TIMEOUT_MS = 120_000
const QUEUED_SAVE_TEST_TIMEOUT_MS = 150_000

test.beforeEach(async ({ page }) => {
  await page.goto('/#/progress')
  await expect(page.getByRole('heading', { name: 'Progress', exact: true })).toBeVisible()
  await createBlankPlaythrough(page)
})

async function observeStableProgressRegions(page: Page, untouchedClass: string): Promise<void> {
  await page.evaluate((className) => {
    const tiles = [...document.querySelectorAll<HTMLElement>('.class-seal-tile')]
    const untouchedTile = tiles.find(tile => tile.textContent?.includes(className))
    const contextBar = document.querySelector<HTMLElement>('.context-bar')
    if (!untouchedTile || !contextBar) throw new Error('Progress render sentinels are unavailable')
    const state = window as unknown as {
      progressRenderState: {
        untouchedTile: HTMLElement
        untouchedClass: string
        untouchedMutations: MutationRecord[]
        contextMutations: MutationRecord[]
        observers: MutationObserver[]
      }
    }
    const untouchedMutations: MutationRecord[] = []
    const contextMutations: MutationRecord[] = []
    const untouchedObserver = new MutationObserver(records => untouchedMutations.push(...records))
    const contextObserver = new MutationObserver(records => contextMutations.push(...records))
    untouchedObserver.observe(untouchedTile, { attributes: true, characterData: true, childList: true, subtree: true })
    contextObserver.observe(contextBar, { attributes: true, characterData: true, childList: true, subtree: true })
    state.progressRenderState = { untouchedTile, untouchedClass: className, untouchedMutations, contextMutations, observers: [untouchedObserver, contextObserver] }
  }, untouchedClass)
}

async function expectStableProgressRegions(page: Page): Promise<void> {
  const renderResult = await page.evaluate(() => {
    const state = (window as unknown as { progressRenderState: { untouchedTile: HTMLElement; untouchedClass: string; untouchedMutations: MutationRecord[]; contextMutations: MutationRecord[] } }).progressRenderState
    const currentTile = [...document.querySelectorAll<HTMLElement>('.class-seal-tile')].find(tile => tile.textContent?.includes(state.untouchedClass))
    const summarize = (record: MutationRecord) => `${record.type}:${record.target.nodeName}:${record.attributeName ?? ''}:${record.target.textContent?.slice(0, 60) ?? ''}`
    return { sameTile: state.untouchedTile === currentTile, untouchedMutations: state.untouchedMutations.map(summarize), contextMutations: state.contextMutations.map(summarize) }
  })
  expect(renderResult).toEqual({ sameTile: true, untouchedMutations: [], contextMutations: [] })
}

test('the vanilla mastery board cycles one class through all four playthrough states', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  const board = page.getByRole('region', { name: 'Vanilla class mastery board', exact: true })
  const tiles = board.locator('.class-seal-tile')
  await expect(tiles).toHaveCount(24)
  await expect(board.getByRole('button', { name: /^Warrior: Class not acquired/ })).toBeVisible()
  await expect(board.getByRole('button', { name: /^Mimic: Class not acquired/ })).toBeVisible()
  await expect(board.getByRole('link', { name: 'Warrior Seal', exact: true })).toHaveAttribute('href', /#\/reference\//)
  await expect(board.locator('.class-seal-tile__seal img')).toHaveCount(24)
  await expect(board.locator('[data-artwork-placeholder="item"]')).toHaveCount(0)
  await expect(board.locator('.class-seal-tile__seal img').first()).toHaveAttribute('src', /class-seal/)
  await expect(page.locator('.progress-summary__icon img')).toHaveAttribute('src', /class-seal/)

  const warrior = tiles.filter({ has: page.getByRole('button', { name: /^Warrior:/ }) })
  const advance = warrior.getByRole('button', { name: /^Warrior:/ })
  await expect(warrior).toHaveAttribute('data-stage', 'notAcquired')

  await observeStableProgressRegions(page, 'Monk')

  await advance.click()
  await expect(warrior).toHaveAttribute('data-stage', 'unlocked')
  await expect(advance).toHaveAccessibleName(/^Warrior: Class unlocked/)
  await expect(advance).toBeEnabled()
  await expectStableProgressRegions(page)

  await advance.click()
  await expect(warrior).toHaveAttribute('data-stage', 'mastered')
  await expect(advance).toHaveAccessibleName(/^Warrior: Class mastered/)

  await advance.click()
  await expect(warrior).toHaveAttribute('data-stage', 'sealAcquired')
  await expect(advance).toHaveAccessibleName(/^Warrior: Seal acquired/)
  await expect(page.locator('.progress-summary__primary strong')).toHaveText('1')

  await advance.click()
  await expect(warrior).toHaveAttribute('data-stage', 'notAcquired')
  await expect(page.locator('.progress-summary__primary strong')).toHaveText('0')

  const columnCount = await board.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)
  expect(columnCount).toBeGreaterThanOrEqual(2)
})

test('rapid class clicks stay interactive, drain in order, and guard tab close while queued', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  test.setTimeout(QUEUED_SAVE_TEST_TIMEOUT_MS)
  const board = page.getByRole('region', { name: 'Vanilla class mastery board', exact: true })
  const warrior = board.locator('.class-seal-tile').filter({ hasText: 'Warrior' }).first()
  await observeStableProgressRegions(page, 'Monk')

  const queuedState = await warrior.evaluate((tile) => {
    const button = tile.querySelector<HTMLButtonElement>('.class-seal-tile__advance')
    if (!button) throw new Error('Warrior progress control is unavailable')
    for (let index = 0; index < 23; index += 1) button.click()
    const beforeUnload = new Event('beforeunload', { cancelable: true })
    const beforeUnloadAllowed = window.dispatchEvent(beforeUnload)
    return {
      beforeUnloadPrevented: !beforeUnloadAllowed || beforeUnload.defaultPrevented,
      disabled: button.disabled,
    }
  })

  expect(queuedState).toEqual({ beforeUnloadPrevented: true, disabled: false })
  await expect(warrior).toHaveAttribute('data-stage', 'sealAcquired')
  await expect(page.locator('.progress-summary__primary strong')).toHaveText('1')
  await expect(page.locator('.class-seal-tile__queue')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => {
    const beforeUnload = new Event('beforeunload', { cancelable: true })
    return !window.dispatchEvent(beforeUnload) || beforeUnload.defaultPrevented
  }), { timeout: QUEUED_SAVE_DRAIN_TIMEOUT_MS }).toBe(false)
  await expect(warrior).toHaveAttribute('data-stage', 'sealAcquired')
  await expectStableProgressRegions(page)

  await page.reload()
  await expect(board.locator('.class-seal-tile').filter({ hasText: 'Warrior' }).first()).toHaveAttribute('data-stage', 'sealAcquired')
})

test('bulk edit sets selected classes to one explicit state and persists them together', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  const board = page.getByRole('region', { name: 'Vanilla class mastery board', exact: true })
  await page.getByRole('button', { name: 'Edit multiple', exact: true }).click()
  const bulkEditor = page.getByRole('region', { name: 'Bulk edit class mastery', exact: true })
  await expect(bulkEditor).toContainText('0 selected')

  for (const className of ['Warrior', 'Monk', 'Mimic']) {
    const tile = board.locator('.class-seal-tile').filter({ hasText: className }).first()
    const selector = tile.locator('.class-seal-tile__advance')
    await expect(selector).toHaveAccessibleName(new RegExp(`^${className}: not selected for bulk edit`))
    await selector.click()
    await expect(selector).toHaveAttribute('aria-pressed', 'true')
  }
  await expect(bulkEditor).toContainText('3 selected')
  await observeStableProgressRegions(page, 'Rogue')

  await bulkEditor.getByRole('button', { name: 'Seal acquired', exact: true }).click()
  await expect(bulkEditor).toContainText('0 selected')
  for (const className of ['Warrior', 'Monk', 'Mimic']) {
    await expect(board.locator('.class-seal-tile').filter({ hasText: className })).toHaveAttribute('data-stage', 'sealAcquired')
  }
  await expect(page.locator('.progress-summary__primary strong')).toHaveText('3')
  await expectStableProgressRegions(page)

  await bulkEditor.getByRole('button', { name: 'Done', exact: true }).click()
  await page.reload()
  await expect(page.locator('.progress-summary__primary strong')).toHaveText('3')
  await expect(board.locator('.class-seal-tile[data-stage="sealAcquired"]')).toHaveCount(3)
})
