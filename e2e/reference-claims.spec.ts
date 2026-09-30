import { expectOfflineReady } from './offline-helpers'
import { selectedPlaythrough, replacePlannerData } from './local-data-helpers'
import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'
import { STARTER_CATALOG } from '../src/catalog'
import type { CatalogSnapshot, LocalData } from '../src/domain/types'

const ITEM_PATH = '/#/reference/catalog/crystal-project-public-starter/revisions/wiki-v1/entities/base%3Aitem%3Aassassin-seal'
const EQUIVALENT_ITEM_PATH = '/#/reference/catalog/crystal-project-public-starter/revisions/bundled-v2/entities/base%3Aitem%3Aadjudicator'
const ITEM_SOURCE = 'https://crystal-project.fandom.com/wiki/Assassin_Seal?oldid=12583'
const TABLE_SOURCE = 'https://crystal-project.fandom.com/wiki/Accessories/table?oldid=12905'
const SELECTED_LOCATION = 'Reward: Master Assassin in Shoudu Province'

async function openData(page: Page) {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  return page.getByRole('dialog', { name: 'Data & settings', exact: true })
}

async function exportLocalData(page: Page) {
  const panel = await openData(page)
  await panel.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const downloaded = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export backup', exact: true }).click()
  const path = await (await downloaded).path()
  if (!path) throw new Error('Expected a completed backup download')
  const bytes = await readFile(path)
  const entries = unzipSync(bytes)
  const bundle = JSON.parse(strFromU8(entries['bundle.json']!)) as { localData: LocalData; catalogs: readonly CatalogSnapshot[] }
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  return { ...bundle, bytes }
}

function locationRow(page: Page) {
  return page.locator('.definition-row').filter({ has: page.locator('dt', { hasText: /^Location$/ }) })
}

test('equivalent source wording is shown as one fact with known implied', async ({ page }) => {
  await page.goto(EQUIVALENT_ITEM_PATH)
  const location = locationRow(page)
  await expect(location.getByText('Drop: Anubis in the Ancient Labyrinth', { exact: true })).toBeVisible()
  await expect(location.locator('.badge').getByText('known', { exact: true })).toHaveCount(0)
  await expect(location.getByText('differing source values')).toHaveCount(0)
  await expect(page.getByText('Source descriptions differ', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Review source differences', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Community wiki · Scythes/table', exact: true })).toHaveAttribute('href', 'https://crystal-project.fandom.com/wiki/Scythes/table?oldid=10848')
  await expect(page.getByRole('link', { name: 'Community wiki · Adjudicator', exact: true })).toHaveAttribute('href', 'https://crystal-project.fandom.com/wiki/Adjudicator?oldid=11911')
})

test('conflicting fields expose every claim and protect explicit review choices', async ({ page, baseURL }) => {
  const externalRequests: string[] = []
  page.on('request', (request) => { if (!request.url().startsWith(`${baseURL}/`)) externalRequests.push(request.url()) })
  await page.goto(ITEM_PATH)
  const location = locationRow(page)
  await expect(location.getByText(SELECTED_LOCATION, { exact: true })).toBeVisible()
  await expect(location.getByText(/The Assassin Master is found in Capital Sequoia/)).toBeVisible()
  await expect(location.getByRole('link', { name: 'Community wiki · Assassin Seal', exact: true })).toHaveAttribute('href', ITEM_SOURCE)
  await expect(location.getByRole('link', { name: 'Community wiki · Accessories/table', exact: true })).toHaveAttribute('href', TABLE_SOURCE)
  await expect(location.locator('.badge').getByText('Sources differ', { exact: true })).toBeVisible()
  await expect(location.getByText(/revision 12583/)).toBeVisible()
  await expect(location.getByText(/revision 12905/)).toBeVisible()
  await expect(page.getByText('No auxiliary claims were imported. Field-level claims appear with their values above.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  const review = page.getByRole('button', { name: 'Review source differences', exact: true })
  await review.focus()
  await page.keyboard.press('Enter')
  const editor = page.getByRole('dialog', { name: 'Create personal version: Assassin Seal', exact: true })
  const choices = editor.getByRole('group', { name: 'Location claims', exact: true })
  await expect(choices.getByRole('radio', { name: /^Keep unresolved/ })).toBeChecked()
  await choices.getByRole('radio', { name: /^Keep unresolved/ }).focus()
  await page.keyboard.press('ArrowDown')
  await expect(choices.getByRole('radio', { name: 'Use claim 1', exact: true })).toBeChecked()
  await choices.getByRole('radio', { name: 'Use claim 2', exact: true }).check()
  await page.keyboard.press('Escape')
  await expect(editor.getByText('Definition draft still open', { exact: true })).toBeVisible()
  await expect(choices.getByRole('radio', { name: 'Use claim 2', exact: true })).toBeChecked()
  await editor.getByRole('button', { name: 'Discard draft', exact: true }).click()
  await expect(location.getByText('2 differing source values', { exact: true })).toBeVisible()
  await review.click()
  await expect(choices.getByRole('radio', { name: /^Keep unresolved/ })).toBeChecked()
  await choices.getByRole('radio', { name: 'Use claim 1', exact: true }).check()
  await editor.getByRole('button', { name: 'Create personal version', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await expect(page).toHaveURL(/#\/reference\/personal\//)
  await expect(location.getByText(SELECTED_LOCATION, { exact: true })).toBeVisible()
  await expect(location.getByText('conflicting', { exact: true })).toHaveCount(0)
  await location.locator('summary').filter({ hasText: /^Sources$/ }).click()
  await expect(location.getByRole('link', { name: 'Community wiki · Accessories/table', exact: true })).toHaveAttribute('href', TABLE_SOURCE)
  await page.reload()
  await expect(location.getByText(SELECTED_LOCATION, { exact: true })).toBeVisible()
  await page.goto(ITEM_PATH)
  await expect(location.getByText('2 differing source values', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'View personal version', exact: true }).click()
  await expect(location.getByText(SELECTED_LOCATION, { exact: true })).toBeVisible()
  expect(externalRequests).toEqual([])
})

test('a reviewed claim survives offline save recovery and a backup round trip', async ({ page, context }) => {
  await page.goto(ITEM_PATH)
  const original = await exportLocalData(page)
  const panel = await openData(page)
  await panel.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  const prepare = panel.getByRole('button', { name: 'Prepare for offline use', exact: true })
  if (await prepare.isVisible()) await prepare.click()
  await expectOfflineReady(panel)
  await panel.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  await page.getByRole('button', { name: 'Review source differences', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Create personal version: Assassin Seal', exact: true })
  const choice = editor.getByRole('group', { name: 'Location claims', exact: true }).getByRole('radio', { name: 'Use claim 1', exact: true })
  await choice.check()
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if (this.name === 'localDatas') { IDBObjectStore.prototype.put = original; throw new DOMException('Synthetic storage failure', 'QuotaExceededError') }
      return original.apply(this, args)
    }
  })
  await editor.getByRole('button', { name: 'Create personal version', exact: true }).click()
  await expect(editor.getByText('Definition not saved', { exact: true })).toBeVisible()
  await expect(choice).toBeChecked()
  await editor.getByRole('button', { name: 'Create personal version', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await expect(page.getByText('Saved locally', { exact: true })).toBeVisible()
  await page.reload()
  await expect(locationRow(page).getByText(SELECTED_LOCATION, { exact: true })).toBeVisible()

  const saved = await exportLocalData(page)
  const definitions = Object.values(saved.localData.personalDefinitions)
  expect(definitions).toHaveLength(1)
  expect(definitions[0]?.fields.Location).toEqual({ state: 'known', value: SELECTED_LOCATION, sources: [expect.objectContaining({ sourceId: TABLE_SOURCE, locator: 'Accessories/table > Assassin Seal', snapshot: 'revision 12905' })] })
  const sourceCatalog = saved.catalogs.find((catalog) => catalog.id === STARTER_CATALOG.id && catalog.revisionId === STARTER_CATALOG.revisionId)
  expect(sourceCatalog?.checksum).toBe(STARTER_CATALOG.checksum)
  expect(sourceCatalog?.entities['base:item:assassin-seal']).toEqual(STARTER_CATALOG.entities['base:item:assassin-seal'])
  expect(selectedPlaythrough(saved.localData).inventory).toEqual(selectedPlaythrough(original.localData).inventory)
  expect(selectedPlaythrough(saved.localData).characters).toEqual(selectedPlaythrough(original.localData).characters)
  expect(saved.localData.buildRevisions).toEqual(original.localData.buildRevisions)
  const restore = await openData(page)
  await restore.getByRole('button', { name: 'Import & backup', exact: true }).click()
  await restore.locator('input[type="file"]').setInputFiles({ name: 'synthetic-claim-review.zip', mimeType: 'application/zip', buffer: saved.bytes })
  await replacePlannerData(restore)
  await expect(restore).not.toBeVisible()
  const restored = await exportLocalData(page)
  expect(restored.localData.personalDefinitions).toEqual(saved.localData.personalDefinitions)
  expect(restored.catalogs.map((catalog) => catalog.checksum)).toEqual(saved.catalogs.map((catalog) => catalog.checksum))
  expect(restored.catalogs.find((catalog) => catalog.id === STARTER_CATALOG.id && catalog.revisionId === STARTER_CATALOG.revisionId)?.entities['base:item:assassin-seal']).toEqual(sourceCatalog?.entities['base:item:assassin-seal'])
})
