import { expect, test, type Page } from '@playwright/test'
import type { LocalData } from '../src/domain/types'

const ORIGINAL_TITLE = 'Rowan: sample Warrior'

async function archiveBuildFixture(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('crykit')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('localDatas', 'readwrite')
      const store = transaction.objectStore('localDatas')
      const read = store.getAll()
      let titles: readonly string[] = []
      transaction.onerror = transaction.onabort = () => { database.close(); reject(transaction.error) }
      transaction.oncomplete = () => { database.close(); resolve(titles) }
      read.onsuccess = () => {
        const record = read.result[0] as { localData: LocalData }
        const archived = Object.values(record.localData.builds)[0]
        if (!archived) { transaction.abort(); return }
        titles = [archived.title]
        store.put({ ...record, localData: { ...record.localData, builds: {
          ...record.localData.builds,
          [archived.id]: { ...archived, archived: true },
        } } })
      }
    }
  }))
}

test('saved and cloned Builds have no classification badges', async ({ page }) => {
  await page.goto('/#/builds/library')
  await expect(page.getByRole('button', { name: ORIGINAL_TITLE, exact: true })).toBeVisible()
  await expect(page.locator('.build-card__header .badge')).toHaveCount(0)
  await page.getByRole('button', { name: ORIGINAL_TITLE, exact: true }).click()
  await page.getByRole('button', { name: 'Clone Build', exact: true }).click()
  await expect(page.getByRole('heading', { name: `${ORIGINAL_TITLE} (copy)`, exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Build library', exact: true }).click()
  await expect(page.getByRole('button', { name: `${ORIGINAL_TITLE} (copy)`, exact: true })).toBeVisible()
  await expect(page.locator('.build-card__header .badge')).toHaveCount(0)
  await expect(page.locator('.build-card .badge').filter({ hasText: /^sample$/ }).first()).toBeVisible()
})

test('archived Builds stay hidden without lifecycle classifications', async ({ page }) => {
  await page.goto('/#/builds/library')
  await expect(page.getByRole('button', { name: ORIGINAL_TITLE, exact: true })).toBeVisible()
  const originalCount = await page.locator('.build-card').count()
  const [archived] = await archiveBuildFixture(page)
  await page.reload()
  await expect(page.getByRole('button', { name: archived, exact: true })).toHaveCount(0)
  await expect(page.locator('.build-card')).toHaveCount(originalCount - 1)
  await expect(page.locator('.build-card__header .badge')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
