import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'
import { syntheticCrystalEdit } from '../src/interchange/crystal-edit.test-helpers'
import type { Profile } from '../src/domain/types'

const WARRIOR_PATH = '/#/reference/catalog/crystal-project-public-starter/revisions/bundled-v1/entities/base%3Aclass%3Awarrior'

async function openData(page: Page) {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  return page.getByRole('dialog', { name: 'Data & settings', exact: true })
}

async function exportProfile(page: Page): Promise<Profile> {
  const settings = await openData(page)
  await settings.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const download = page.waitForEvent('download')
  await settings.getByRole('button', { name: 'Export backup', exact: true }).click()
  const entries = unzipSync(await readFile((await (await download).path())!))
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  return (JSON.parse(strFromU8(entries['bundle.json']!)) as { profile: Profile }).profile
}

test('bundled class calculations respond to explicit mixed growth and work offline', async ({ page, context, baseURL }, testInfo) => {
  const externalRequests: string[] = []
  page.on('request', request => { if (!request.url().startsWith(`${baseURL}/`)) externalRequests.push(request.url()) })
  await page.goto(WARRIOR_PATH)
  const research = page.getByRole('region', { name: 'Class growth and learning' })
  await research.getByText('Growth calculator', { exact: true }).click()
  const hp = research.getByRole('table', { name: 'Estimated base stats', exact: true }).getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'HP', exact: true }) })
  await expect(hp).toContainText('Unknown')
  await research.getByRole('button', { name: 'Use Warrior for all growth levels', exact: true }).click()
  await expect(hp).toContainText('1,244.38')
  await research.getByLabel('Character level', { exact: true }).fill('30')
  await expect(hp).toContainText('Unknown')
  await research.getByLabel('Growth levels 1', { exact: true }).fill('20')
  await research.getByRole('button', { name: 'Add growth class', exact: true }).click()
  await research.getByRole('button', { name: 'Choose Growth class 2', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Choose Growth class 2', exact: true })
  await picker.getByLabel('Search available definitions', { exact: true }).fill('Wizard')
  await picker.getByRole('button').filter({ has: page.locator('strong', { hasText: /^Wizard$/ }) }).click()
  await expect(research.getByRole('button', { name: 'Choose Growth class 2', exact: true })).toContainText('Wizard')
  await research.getByLabel('Growth levels 2', { exact: true }).fill('10')
  await expect(hp).toContainText('658.94')
  await research.getByText('Exported learn tree', { exact: true }).click()
  await expect(research.getByRole('list', { name: 'Exported learn tree nodes' }).getByText('Ability #28', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
  await page.screenshot({ path: testInfo.outputPath('class-growth-and-tree.png'), fullPage: true })
  const settings = await openData(page)
  await settings.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await settings.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expect(settings.getByText('Offline ready', { exact: true })).toBeVisible()
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  await research.getByText('Growth calculator', { exact: true }).click()
  await research.getByRole('button', { name: 'Use Warrior for all growth levels', exact: true }).click()
  await expect(hp).toContainText('1,244.38')
  expect(externalRequests).toEqual([])
})

test('custom class imports preserve the playthrough and supply tree names and command selections', async ({ page }, testInfo) => {
  await page.goto('/')
  const before = await exportProfile(page)
  const settings = await openData(page)
  await settings.getByRole('button', { name: 'Import & backup', exact: true }).click()
  await settings.getByLabel('Choose import file', { exact: true }).setInputFiles({ name: 'synthetic-mod.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(syntheticCrystalEdit())) })
  await expect(settings.getByRole('combobox', { name: /^Import action/ })).toHaveValue('add-reference')
  await expect(settings.getByText(/referenced ability or passive definitions are absent/)).toBeVisible()
  await settings.getByRole('button', { name: 'Add references', exact: true }).click()
  await expect(settings).not.toBeVisible()
  const after = await exportProfile(page)
  expect(after.id).toBe(before.id)
  expect(after.characters).toEqual(before.characters)
  expect(after.inventory).toEqual(before.inventory)
  expect(after.rulesets).toEqual(before.rulesets)
  await page.goto('/#/reference')
  await page.getByLabel('Search reference', { exact: true }).fill('Synthetic Scholar')
  await page.locator('.reference-card').filter({ has: page.getByRole('heading', { name: 'Synthetic Scholar', exact: true }) }).click()
  const research = page.getByRole('region', { name: 'Class growth and learning' })
  await research.getByText('Exported learn tree', { exact: true }).click()
  await expect(research.getByText('Synthetic Spark', { exact: true })).toBeVisible()
  await expect(research.getByText('Passive #2', { exact: true })).toBeVisible()
  await research.getByText('Growth calculator', { exact: true }).click()
  await research.getByRole('button', { name: 'Use Synthetic Scholar for all growth levels', exact: true }).click()
  const stats = research.getByRole('table', { name: 'Estimated base stats', exact: true })
  await expect(stats.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'HP', exact: true }) })).toContainText('1,166.58')
  await expect(stats.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'STR', exact: true }) })).toContainText('Unknown')
  await page.screenshot({ path: testInfo.outputPath('imported-class.png'), fullPage: true })
  await page.goto('/#/builds/library/new')
  const command = page.getByRole('combobox', { name: 'Sub-command', exact: true })
  await command.fill('Synthetic Research')
  await page.getByRole('listbox', { name: 'Choose Sub-command', exact: true }).getByRole('option').filter({ has: page.locator('strong', { hasText: /^Synthetic Research$/ }) }).click()
  await expect(command).toHaveValue('Synthetic Research')
})
