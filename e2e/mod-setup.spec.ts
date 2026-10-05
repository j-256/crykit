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

test('first-load selection keeps hidden choices, saves exact source priority and survives reload', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  const chooser = page.getByRole('dialog', { name: 'Choose your mods', exact: true })
  await expect(chooser).toBeVisible()
  const original = await stored(page)
  await chooser.getByRole('searchbox', { name: 'Search mods', exact: true }).fill('Boots')
  await chooser.getByRole('checkbox', { name: 'Boots of Flight', exact: true }).check()
  await chooser.getByRole('searchbox', { name: 'Search mods', exact: true }).fill('Moonlight')
  await chooser.getByRole('checkbox', { name: 'Moonlight Project - Classes', exact: true }).check()
  await chooser.getByRole('searchbox', { name: 'Search mods', exact: true }).fill('no matching synthetic title')
  await expect(chooser.getByText('2 selected', { exact: true })).toBeVisible()
  await expect(chooser.getByText('No mods match. Your selections are kept while searching.', { exact: true })).toBeVisible()
  await chooser.locator('summary').filter({ hasText: /^Mod priority$/ }).click()
  await chooser.getByRole('button', { name: 'Move Moonlight Project - Classes earlier', exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await chooser.getByRole('button', { name: 'Use selected mods', exact: true }).click()
  await expect(chooser).not.toBeVisible()
  const selected = await stored(page)
  const setup = selected.data.gameSetups[selected.data.planningGameSetupRevisionId!]!
  expect(setup.modComposition?.baseline.catalogRevisionId).toBe('catalog-v2')
  expect(setup.modComposition?.layers.map(layer => layer.catalogId)).toEqual(['crystal-edit:291840f3-509a-498f-bbf5-bc5d09956176', 'crystal-edit:3c1f2e0b-a46d-4feb-904d-7ceb49f8a578'])
  expect(setup.modComposition?.layers.every(layer => layer.enabled && selected.catalogs.some(catalog => catalog.id === layer.catalogId && catalog.revisionId === layer.catalogRevisionId))).toBe(true)
  expect(selected.sources.every(size => size > 0)).toBe(true)
  expect(selected.sources).toHaveLength(2)
  expect(selected.data.buildRevisions).toEqual(original.data.buildRevisions)
  expect(selected.data.gameSetups).toMatchObject(original.data.gameSetups)
  for (const layer of setup.modComposition!.layers) expect(selected.data.referenceLibrary?.excludedMods).not.toContain(layer.catalogId)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  await expect(chooser).not.toBeVisible()
  expect((await stored(page)).data).toEqual(selected.data)
  expect(errors).toEqual([])
})

test('a skipped profile discovers an unloaded mod in a picker and enables it only for the new Build', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/')
  await skipInitialModSetup(page)
  const original = await stored(page)
  expect(original.sources).toEqual([])
  await page.getByRole('button', { name: 'New Build', exact: true }).click()
  await page.getByRole('combobox', { name: 'Class', exact: true }).fill('Freelancer Moonlight')
  const picker = page.getByRole('listbox', { name: 'Choose Class', exact: true })
  const option = picker.getByRole('option').filter({ has: page.locator('strong', { hasText: /^Freelancer$/ }) })
  await expect(option).toHaveCount(1)
  await option.click()
  const enable = page.getByRole('dialog', { name: 'Enable Moonlight Project?', exact: true })
  await expect(enable).toBeVisible()
  await enable.getByRole('button', { name: 'Enable and select Freelancer', exact: true }).click()
  await expect(enable).not.toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Freelancer')
  await page.getByLabel('Build title', { exact: true }).fill('Synthetic discovered mod build')
  await page.getByRole('button', { name: 'Save build', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Synthetic discovered mod build', exact: true })).toBeVisible()
  const saved = await stored(page)
  const build = Object.values(saved.data.builds).find(build => build.title === 'Synthetic discovered mod build')!
  const checkpoint = saved.data.buildRevisions[build.latestRevisionId!]!
  expect(saved.data.gameSetups[checkpoint.gameSetupRevisionId]?.modComposition?.layers[0]?.enabled).toBe(true)
  expect(saved.data.gameSetups[original.data.planningGameSetupRevisionId!]).toEqual(original.data.gameSetups[original.data.planningGameSetupRevisionId!])
  expect(saved.data.referenceLibrary).toEqual(original.data.referenceLibrary)
  expect(saved.sources).toHaveLength(1)
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Class', exact: true })).toHaveValue('Freelancer')
})

test('a failed initial mod save preserves choices and rolls back sources until retry', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/')
  const chooser = page.getByRole('dialog', { name: 'Choose your mods', exact: true })
  await expect(chooser).toBeVisible()
  const original = await stored(page)
  await chooser.getByRole('searchbox', { name: 'Search mods', exact: true }).fill('Free Maps')
  await chooser.getByRole('checkbox', { name: 'Free Maps', exact: true }).check()
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add
    let fail = true
    IDBObjectStore.prototype.add = function(...args: Parameters<typeof add>) {
      if (this.name === 'history' && fail) { fail = false; throw new DOMException('Synthetic mod save quota failure', 'QuotaExceededError') }
      return add.apply(this, args)
    }
  })
  await chooser.getByRole('button', { name: 'Use selected mods', exact: true }).click()
  await expect(chooser.getByText('Mod choices not saved', { exact: true })).toBeVisible()
  expect(await stored(page)).toEqual(original)
  await expect(chooser.getByRole('checkbox', { name: 'Free Maps', exact: true })).toBeChecked()
  await chooser.getByRole('button', { name: 'Use selected mods', exact: true }).click()
  await expect(chooser).not.toBeVisible()
  expect((await stored(page)).data.modSetup?.state).toBe('completed')
})
