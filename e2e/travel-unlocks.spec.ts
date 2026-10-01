import { expectOfflineReady } from './offline-helpers'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'
import { expect, test, type Page } from '@playwright/test'
import { createBlankPlaythrough, selectedPlaythrough } from './local-data-helpers'
import type { LocalData } from '../src/domain'
import { TRAVEL_UNLOCK_GROUPS } from '../src/catalog/travel-unlocks'

async function openSettings(page: Page) {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  return page.getByRole('dialog', { name: 'Data & settings', exact: true })
}

async function exportLocalData(page: Page): Promise<LocalData> {
  const panel = await openSettings(page)
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const downloading = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
  const path = await (await downloading).path()
  if (!path) throw new Error('The backup download is unavailable')
  const files = unzipSync(await readFile(path))
  const localData = (JSON.parse(strFromU8(files['bundle.json']!)) as { localData: LocalData }).localData
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  return localData
}

test.beforeEach(async ({ page }) => {
  await page.goto('/#/progress')
  await expect(page.getByRole('heading', { name: 'Progress', exact: true })).toBeVisible()
  await createBlankPlaythrough(page)
  await page.getByRole('navigation', { name: 'Progress guides', exact: true }).getByRole('link', { name: 'Travel & unlocks', exact: true }).click()
  await expect(page).toHaveURL(/#\/progress\/unlocks$/)
})

test('shows a loaded native icon for every travel unlock', async ({ page }) => {
  const tiles = page.locator('.unlock-tile')
  await expect(tiles).toHaveCount(TRAVEL_UNLOCK_GROUPS.reduce((total, group) => total + group.entityIds.length, 0))
  for (let index = 0; index < await tiles.count(); index += 1) {
    const tile = tiles.nth(index)
    const image = tile.locator('img')
    await image.scrollIntoViewIfNeeded()
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await expect(tile.locator('[data-artwork-source="native"]')).toHaveCount(1)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('rapid acquisition changes keep the checklist interactive and persist the final state', async ({ page }) => {
  await page.evaluate(() => {
    document.body.dataset.unlockDisabledFlash = 'false'
    new MutationObserver(records => {
      if (records.some(record => record.target instanceof HTMLInputElement && record.target.closest('.unlock-grid') && record.target.disabled)) document.body.dataset.unlockDisabledFlash = 'true'
    }).observe(document.body, { attributes: true, attributeFilter: ['disabled'], subtree: true })
    const control = (name: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${name}: acquired"]`)!
    control('Gaea Stone').click()
    control('Mercury Stone').click()
    control('Gaea Stone').click()
  })
  await expect(page.getByRole('checkbox', { name: 'Gaea Stone: acquired', exact: true })).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Mercury Stone: acquired', exact: true })).toBeChecked()
  await expect(page.locator('.unlock-tile[aria-busy="true"]')).toHaveCount(0)
  expect(await page.locator('body').getAttribute('data-unlock-disabled-flash')).toBe('false')
  await page.reload()
  await expect(page.getByRole('checkbox', { name: 'Gaea Stone: acquired', exact: true })).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Mercury Stone: acquired', exact: true })).toBeChecked()
})

test('tracks mount instruments, shrine stones, and capability items independently with reference links', async ({ page }) => {
  for (const group of ['Mount instruments', 'Shrine stones', 'Capability items']) await expect(page.getByRole('region', { name: group, exact: true })).toBeVisible()
  for (const name of ['Quintar Flute', 'Quintar Ocarina', 'Ibek Bell', 'Owl Drum', 'Salmon Violin', 'Salmon Cello', 'New World Stone', 'Old World Stone']) {
    await expect(page.getByRole('checkbox', { name: `${name}: acquired`, exact: true })).not.toBeChecked()
    await expect(page.getByRole('link', { name: `${name}: location & requirements`, exact: true })).toHaveAttribute('href', /#\/reference\//)
  }
  for (const name of ['Ibek Bell', 'Gaea Stone', 'Treasure Finder']) {
    const toggle = page.getByRole('checkbox', { name: `${name}: acquired`, exact: true })
    await toggle.check()
    await expect(toggle).toBeEnabled()
  }
  await expect(page.getByRole('region', { name: 'Travel and unlock totals' })).toContainText('3 /')
  await page.getByRole('checkbox', { name: 'Ibek Bell: acquired', exact: true }).uncheck()
  await expect(page.getByRole('checkbox', { name: 'Ibek Bell: acquired', exact: true })).toBeEnabled()
  await expect(page.locator('.unlock-tile[aria-busy="true"]')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('checkbox', { name: 'Ibek Bell: acquired', exact: true })).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Gaea Stone: acquired', exact: true })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Treasure Finder: acquired', exact: true })).toBeChecked()
  const localData = await exportLocalData(page)
  expect(Object.values(selectedPlaythrough(localData).progress)).toHaveLength(3)
  expect(Object.values(selectedPlaythrough(localData).inventory)).toHaveLength(0)
  expect(Object.values(selectedPlaythrough(localData).characters)).toHaveLength(0)
  await page.getByRole('link', { name: 'Ibek Bell: location & requirements', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Ibek Bell', exact: true })).toBeVisible()
  await expect(page.getByText('Reward for clearing the Ancient Reservoir in Poko Poko Desert.', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Community wiki · Mounts', exact: true })).toHaveAttribute('href', /Mounts\?oldid=5937/)
  await page.goBack()
  await expect(page.getByRole('checkbox', { name: 'Treasure Finder: acquired', exact: true })).toBeChecked()
  await page.getByRole('navigation', { name: 'Progress guides', exact: true }).getByRole('link', { name: 'Class seals', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Warrior: Class not acquired/ })).toBeVisible()
  await expect(page.locator('.progress-other')).not.toContainText('Treasure Finder')
})

test('filters unfinished items and opens an acquisition search result on its own checklist', async ({ page }) => {
  const toggle = page.getByRole('checkbox', { name: 'Treasure Finder: acquired', exact: true })
  await toggle.check()
  await expect(toggle).toBeEnabled()
  await page.getByRole('combobox', { name: 'Acquisition filter', exact: true }).selectOption('acquired')
  await expect(page.locator('.unlock-tile')).toHaveCount(1)
  await page.getByLabel('Find an unlock', { exact: true }).fill('Salmon')
  await expect(page.getByText('No matching unlocks', { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Acquisition filter', exact: true }).selectOption('notAcquired')
  await expect(page.locator('.unlock-tile')).toHaveCount(2)
  await page.getByLabel('Find an unlock', { exact: true }).fill('')
  await expect(toggle).toHaveCount(0)
  await page.keyboard.press('Control+k')
  const search = page.getByRole('dialog', { name: 'Search CryKit', exact: true })
  await search.getByRole('searchbox', { name: 'Search CryKit', exact: true }).fill('Treasure Finder')
  await search.getByRole('link').filter({ hasText: 'Treasure Finder' }).filter({ hasText: 'Party progress' }).click()
  await expect(search).not.toBeVisible()
  await expect(page.locator('.unlock-tile[data-focused="true"]')).toContainText('Treasure Finder')
  await expect(toggle).toBeChecked()
  await expect(toggle).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('retains a failed acquisition and retries one record before continuing', async ({ page }) => {
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if (this.name === 'localDatas') {
        IDBObjectStore.prototype.put = original
        throw new DOMException('Synthetic acquisition storage failure', 'QuotaExceededError')
      }
      return original.apply(this, args)
    }
  })
  const toggle = page.getByRole('checkbox', { name: 'Owl Drum: acquired', exact: true })
  await toggle.check()
  await expect(page.getByText('Acquisition not saved', { exact: true })).toBeVisible()
  await expect(toggle).toBeChecked()
  await expect(toggle).toBeDisabled()
  await expect(page.getByRole('checkbox', { name: 'Gaea Stone: acquired', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Retry save', exact: true }).click()
  await expect(toggle).toBeEnabled()
  await page.reload()
  await expect(toggle).toBeChecked()
  const localData = await exportLocalData(page)
  expect(Object.values(selectedPlaythrough(localData).progress)).toHaveLength(1)
})

test('records and reads unlocks offline and starts a second Playthrough blank', async ({ page, context }) => {
  const panel = await openSettings(page)
  await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await panel.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expectOfflineReady(panel)
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  const toggle = page.getByRole('checkbox', { name: 'Babel Quintar: acquired', exact: true })
  await toggle.check()
  await expect(toggle).toBeEnabled()
  await page.getByRole('link', { name: 'Babel Quintar: location & requirements', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Babel Quintar', exact: true })).toBeVisible()
  await page.goBack()
  await page.reload()
  await expect(toggle).toBeChecked()
  await createBlankPlaythrough(page)
  await expect(toggle).not.toBeChecked()
  const localData = await exportLocalData(page)
  expect(Object.values(selectedPlaythrough(localData).progress)).toHaveLength(0)
  expect(Object.values(localData.playthroughs).some(playthrough => Object.values(playthrough.progress).some(record => record.displayName === 'Babel Quintar' && record.collection.state === 'known' && record.collection.value))).toBe(true)
  await context.setOffline(false)
})
