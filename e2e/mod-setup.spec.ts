import { importSyntheticLibrary, SYNTHETIC_LIBRARY_ROOTS } from './mod-library-fixtures'
import { expect, test, type Page } from '@playwright/test'
import { MOBILE_TEST_TAG } from './test-tags'
import { skipInitialModSetup } from './local-data-helpers'
import type { LocalData } from '../src/domain/types'

async function stored(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('crykit')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const transaction = database.transaction(['localDatas', 'catalogs', 'sources'])
      const read = <T,>(table: string) => new Promise<T[]>((resolve, reject) => {
        const request = transaction.objectStore(table).getAll()
        request.onsuccess = () => resolve(request.result as T[])
        request.onerror = () => reject(request.error)
      })
      const [roots, catalogs, sources] = await Promise.all([read<{ localData: LocalData }>('localDatas'), read<{ id: string; revisionId: string }>('catalogs'), read<{ bytes: Uint8Array }>('sources')])
      return { data: roots[0]!.localData, catalogs: catalogs.map(catalog => ({ id: catalog.id, revisionId: catalog.revisionId })), sources: sources.map(source => source.bytes.byteLength) }
    } finally { database.close() }
  })
}

test('a skipped profile discovers an imported mod in a picker and enables it only for the new Build', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  await importSyntheticLibrary(page, true, [SYNTHETIC_LIBRARY_ROOTS[1]!])
  await page.goto('/')
  const original = await stored(page)
  expect(original.sources.every(size => size > 0)).toBe(true)
  expect(original.sources).toHaveLength(1)
  await page.getByRole('button', { name: 'New Build', exact: true }).click()
  await page.getByRole('combobox', { name: 'Class', exact: true }).fill('Synthetic Class Synthetic Moonlight')
  const picker = page.getByRole('listbox', { name: 'Choose Class', exact: true })
  const option = picker.getByRole('option').filter({ has: page.locator('strong', { hasText: /^Synthetic Class$/ }) })
  await expect(option).toHaveCount(1)
  await option.click()
  const enable = page.getByRole('dialog', { name: 'Enable Synthetic Moonlight?', exact: true })
  await expect(enable).toBeVisible()
  await enable.getByRole('button', { name: 'Enable and select Synthetic Class', exact: true }).click()
  await expect(enable).not.toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Synthetic Class')
  await page.getByLabel('Build title', { exact: true }).fill('Synthetic discovered mod build')
  await page.getByRole('button', { name: 'Save build', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save new revision', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Synthetic discovered mod build', exact: true })).toBeVisible()
  const saved = await stored(page)
  const build = Object.values(saved.data.builds).find(build => build.title === 'Synthetic discovered mod build')!
  const checkpoint = saved.data.buildRevisions[build.latestRevisionId!]!
  expect(saved.data.gameSetups[checkpoint.gameSetupRevisionId]?.modComposition?.layers[0]?.enabled).toBe(true)
  expect(saved.data.gameSetups[original.data.planningGameSetupRevisionId!]).toEqual(original.data.gameSetups[original.data.planningGameSetupRevisionId!])
  expect(saved.data.referenceLibrary).toEqual(original.data.referenceLibrary)
  expect(saved.sources).toHaveLength(original.sources.length)
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Synthetic Class')
})
