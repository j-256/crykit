import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { unzipSync } from 'fflate'
import { referencePath } from './reference-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import { openCustomDefinition, openSavedCatalogVersion } from './definition-fixtures'

test('reference entries are read-only and offer source issue reporting', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(referencePath('base:equipment:160'))
  await expect(page.getByRole('heading', { name: 'Artisan Rapier', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create personal version', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Report a data issue', exact: true })).toHaveAttribute('href', 'https://github.com/j-256/crykit/issues')
  await expect(page.getByRole('button', { name: /^(Quick edit|Correct shared reference|Corrections)/ })).toHaveCount(0)
  await page.goto('/#/settings/data')
  await expect(page.getByRole('heading', { name: 'Data & settings', exact: true })).toBeVisible()
  await expect(page.getByText('Reference corrections', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('unused correction metadata cannot change source values or break planner backups', async ({ page }) => {
  const path = referencePath('base:equipment:160')
  await page.goto(path)
  await expect(page.getByRole('heading', { name: 'Artisan Rapier', exact: true })).toBeVisible()
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('crykit')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('meta', 'readwrite')
      transaction.objectStore('meta').put({ key: 'catalog-corrections-v1', value: '{obsolete and unreadable' })
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onerror = () => { database.close(); reject(transaction.error) }
    }
  }))
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Artisan Rapier', exact: true })).toBeVisible()
  await page.goto('/#/settings/data')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export backup', exact: true }).click()
  const file = await (await download).path()
  if (!file) throw new Error('The planner backup download did not finish')
  const archive = unzipSync(await readFile(file))
  const payload = JSON.parse(new TextDecoder().decode(archive['bundle.json']))
  expect(payload).not.toHaveProperty('corrections')
  expect(payload).toHaveProperty('localData.personalDefinitions')
  expect(payload).toHaveProperty('localData.playthroughs')
})

test('pickers only offer editing for standalone custom definitions', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(referencePath('base:equipment:160'))
  await openCustomDefinition(page)
  await openSavedCatalogVersion(page, 'base:equipment:160', 'Synthetic saved rapier')
  await page.goto('/#/inventory/new')
  const form = page.getByRole('dialog', { name: 'Add inventory item', exact: true })
  const picker = page.getByRole('dialog', { name: 'Choose Item definition', exact: true })
  for (const name of ['Artisan Rapier', 'Synthetic saved rapier', 'Synthetic custom sword']) {
    await form.getByRole('button', { name: 'Choose Item definition', exact: true }).click()
    await picker.getByRole('searchbox', { name: 'Search available definitions', exact: true }).fill(name)
    const choices = picker.locator('[data-definition-result]').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) })
    await (name === 'Artisan Rapier' ? choices.filter({ hasText: 'PC 1.6.9.0' }) : choices).click()
    await form.getByRole('button', { name: 'Choose Item definition', exact: true }).click()
    const edit = picker.getByRole('button', { name: 'Edit selected definition', exact: true })
    if (name === 'Synthetic custom sword') {
      await edit.click()
      await expect(page.getByRole('dialog', { name: 'Edit custom definition: Synthetic custom sword', exact: true })).toBeVisible()
    } else {
      await expect(edit).toHaveCount(0)
      await page.keyboard.press('Escape')
    }
  }
})
