import { expect, test, type Locator, type Page } from '@playwright/test'
import type { LocalData } from '../src/domain/types'
import { CONFLICTING_MOD, DISABLED_MOD, ENABLED_MOD, MODDED_BUILD_TITLE, UNKNOWN_MOD, modsBadgeFixture } from './build-mods-badge-fixture'
import { MOBILE_TEST_TAG } from './test-tags'

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

async function loadFixture(page: Page): Promise<LocalData> {
  await page.goto('/#/builds/library')
  await expect(page.getByRole('button', { name: 'Rowan: sample Warrior', exact: true })).toBeVisible()
  const fixture = modsBadgeFixture(await storedData(page))
  await page.evaluate(serialized => new Promise<void>((resolve, reject) => {
    const localData = JSON.parse(serialized) as LocalData
    const request = indexedDB.open('crykit')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('localDatas', 'readwrite')
      const store = transaction.objectStore('localDatas')
      const read = store.getAll()
      transaction.onerror = transaction.onabort = () => { database.close(); reject(transaction.error) }
      transaction.oncomplete = () => { database.close(); resolve() }
      read.onsuccess = () => store.put({ ...read.result[0], localData, revision: localData.revision, updatedAt: localData.updatedAt })
    }
  }), JSON.stringify(fixture))
  await page.reload()
  await expect(page.getByRole('button', { name: MODDED_BUILD_TITLE, exact: true })).toBeVisible()
  return fixture
}

async function expectWithinViewport(tooltip: Locator) {
  const bounds = await tooltip.evaluate(element => {
    const box = element.getBoundingClientRect()
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight, overflow: element.scrollWidth - element.clientWidth }
  })
  expect(bounds.left).toBeGreaterThanOrEqual(0)
  expect(bounds.top).toBeGreaterThanOrEqual(0)
  expect(bounds.right).toBeLessThanOrEqual(bounds.width)
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height)
  expect(bounds.overflow).toBe(0)
}

test('Build Mods badges consolidate requirements without overflow or changing saved data', { tag: MOBILE_TEST_TAG }, async ({ page, isMobile }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const before = await loadFixture(page)
  const card = page.locator('.build-card').filter({ has: page.getByRole('button', { name: MODDED_BUILD_TITLE, exact: true }) })
  const badge = card.getByRole('button', { name: `Mods for ${MODDED_BUILD_TITLE}`, exact: true })
  const tooltip = card.getByRole('tooltip')
  await expect(badge).toHaveText('Mods')
  await expect(card.locator('.build-loadout-summary .mod-badge')).toHaveCount(0)
  await expect(page.locator('.build-card__header .build-mods-badge')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Mods for Rowan: sample Warrior', exact: true })).toHaveCount(0)
  await expect(tooltip).not.toBeVisible()
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  if (isMobile) await badge.tap()
  else await badge.hover()
  await expect(tooltip).toBeVisible()
  await expect(tooltip.getByText('Mods required by this Build', { exact: true })).toBeVisible()
  await expect(badge).toHaveAttribute('aria-expanded', 'true')
  await expect(tooltip.locator('li')).toHaveCount(4)
  for (const [name, state, selections] of [
    [ENABLED_MOD, 'Enabled', ['Synthetic class', 'Synthetic focus']],
    [UNKNOWN_MOD, 'Enabled status not recorded', ['Synthetic sub-command']],
    [DISABLED_MOD, "Disabled in this Build's setup", ['Synthetic sword']],
    [CONFLICTING_MOD, 'Enabled status has conflicting records', ['Synthetic conflicting passive']],
  ] as const) {
    const mod = tooltip.locator('li').filter({ has: page.getByText(name, { exact: true }) })
    await expect(mod).toHaveCount(1)
    await expect(mod.locator('.badge')).toHaveText(state)
    for (const selection of selections) await expect(mod).toContainText(selection)
  }
  await expectWithinViewport(tooltip)
  if (!isMobile) {
    await tooltip.hover()
    await expect(tooltip).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(tooltip).not.toBeVisible()
    await page.getByRole('searchbox', { name: 'Search Build library', exact: true }).focus()
    await badge.focus()
    await expect(tooltip).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(tooltip).not.toBeVisible()
    await expect(badge).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(tooltip).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(tooltip).not.toBeVisible()
    await page.keyboard.press('Tab')
    await expect(tooltip).not.toBeVisible()
    await page.setViewportSize({ width: 640, height: 600 })
    await badge.focus()
    await expect(tooltip).toBeVisible()
    await expectWithinViewport(tooltip)
    await badge.press('End')
    const scrolling = await tooltip.evaluate(element => ({ top: element.scrollTop, height: element.clientHeight, total: element.scrollHeight }))
    expect(scrolling.top + scrolling.height).toBe(scrolling.total)
    await badge.press('Home')
    expect(await tooltip.evaluate(element => element.scrollTop)).toBe(0)
  } else {
    await badge.tap()
    await expect(tooltip).not.toBeVisible()
    await badge.tap()
    await expect(tooltip).toBeVisible()
    await expectWithinViewport(tooltip)
  }
  await page.getByRole('searchbox', { name: 'Search Build library', exact: true }).click()
  await expect(tooltip).not.toBeVisible()
  await expect(page).toHaveURL(/#\/builds\/library$/)
  expect(await storedData(page)).toEqual(before)
  await page.getByRole('button', { name: MODDED_BUILD_TITLE, exact: true }).click()
  const library = page.locator('.build-library')
  if (await library.getAttribute('open') === null) await library.locator(':scope > summary').click()
  const editorUrl = page.url()
  const nestedBadge = library.getByRole('button', { name: `Mods for ${MODDED_BUILD_TITLE}`, exact: true })
  if (isMobile) await nestedBadge.tap()
  else await nestedBadge.focus()
  const nestedTooltip = library.getByRole('tooltip')
  await expect(nestedTooltip).toBeVisible()
  await expectWithinViewport(nestedTooltip)
  expect(await nestedTooltip.evaluate(element => {
    const box = element.getBoundingClientRect()
    return element.contains(document.elementFromPoint(box.left + 10, box.top + 10))
  })).toBe(true)
  await expect(page).toHaveURL(editorUrl)
  expect(await storedData(page)).toEqual(before)
  expect(errors).toEqual([])
})
