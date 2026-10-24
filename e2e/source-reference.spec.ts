import { DEFAULT_CATALOG } from '../src/catalog/bundled'
import type { LocalData } from '../src/domain/types'
import { createSampleLocalData } from '../src/domain/sample-data'
import { waitForPlannerReady } from './local-data-helpers'
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
  await page.locator('.reference-actions').getByRole('button', { name: 'Actions', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Report a data issue', exact: true })).toHaveAttribute('href', 'https://github.com/j-256/crykit/issues')
  await expect(page.getByRole('button', { name: /^(Quick edit|Correct shared reference|Corrections)/ })).toHaveCount(0)
  await page.goto('/#/settings/data')
  await expect(page.getByRole('heading', { name: 'Data & settings', exact: true })).toBeVisible()
  await expect(page.getByText('Reference corrections', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('unused correction metadata cannot change source values or break planner backups', async ({ page }) => {
  const path = referencePath('base:equipment:160')
  // Obsolete metadata belongs to the supported legacy source, seeded before managed startup captures it
  await page.goto('/icon.svg')
  await page.evaluate(serialized => new Promise<void>((resolve, reject) => {
    const localData = JSON.parse(serialized) as LocalData
    const HISTORICAL_NATIVE_DATABASE_VERSION = 40
    const request = indexedDB.open('crykit', HISTORICAL_NATIVE_DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const schemas: Record<string, string[]> = { localDatas: ['id', 'revision', 'updatedAt'], catalogs: ['key', 'id', 'revisionId', 'checksum'], evidence: ['id', 'sourceDigest', 'group'], sources: ['id', 'digest', 'format'], history: ['id', 'localDataId', '[localDataId+nextRevision]'], imports: ['id', 'sourceDigest', 'localDataId'], meta: ['key'] }
      for (const [name, [keyPath, ...indexes]] of Object.entries(schemas)) {
        const store = request.result.createObjectStore(name, { keyPath })
        for (const index of indexes) store.createIndex(index, index === '[localDataId+nextRevision]' ? ['localDataId', 'nextRevision'] : index)
      }
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction(['localDatas', 'meta'], 'readwrite')
      transaction.objectStore('localDatas').put({ id: 'local-data-record', revision: localData.revision, updatedAt: localData.updatedAt, localData, lineage: { rootLocalDataId: localData.id } })
      transaction.objectStore('meta').put({ key: 'catalog-corrections-v1', value: '{obsolete and unreadable' })
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onerror = () => { database.close(); reject(transaction.error) }
    }
  }), JSON.stringify(createSampleLocalData(DEFAULT_CATALOG, '2026-01-01T00:00:00.000Z')))
  await page.goto(path)
  await waitForPlannerReady(page)
  await expect(page.getByRole('heading', { name: 'Artisan Rapier', exact: true })).toBeVisible()
  await page.reload()
  await waitForPlannerReady(page)
  await expect(page.getByRole('heading', { name: 'Artisan Rapier', exact: true })).toBeVisible()
  await page.goto('/#/settings/data')
  const download = page.waitForEvent('download')
  if (!await page.getByRole('button', { name: 'Export planner ZIP', exact: true }).isVisible()) await page.getByText("What's included in a backup?", { exact: true }).click()
  await page.getByRole('button', { name: 'Export planner ZIP', exact: true }).click()
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
