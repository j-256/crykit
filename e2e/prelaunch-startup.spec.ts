import { expect, test, type Page } from '@playwright/test'
import { MOBILE_TEST_TAG } from './test-tags'

async function readOriginal(page: Page) {
  return page.evaluate(() => new Promise<string>((resolve, reject) => {
    const request = indexedDB.open('crykit')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('sentinel', 'readonly')
      const read = transaction.objectStore('sentinel').get('original')
      transaction.oncomplete = () => { database.close(); resolve(read.result as string) }
      transaction.onerror = () => { database.close(); reject(transaction.error) }
    }
  }))
}

test('old-format storage has one startup decision and survives starting a new workspace', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  // A static same-origin page lets the fixture predate the first application startup
  await page.goto('/icon.svg')
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('crykit', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('sentinel')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('sentinel', 'readwrite')
      transaction.objectStore('sentinel').put('Synthetic original data', 'original')
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onerror = () => { database.close(); reject(transaction.error) }
    }
  }))
  await page.goto('/#/builds/library')
  await expect(page.getByRole('heading', { name: 'A new source catalog', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start new workspace', exact: true })).toBeEnabled()
  expect(await readOriginal(page)).toBe('Synthetic original data')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'A new source catalog', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: 'Start new workspace', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(await readOriginal(page)).toBe('Synthetic original data')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(await readOriginal(page)).toBe('Synthetic original data')
})
