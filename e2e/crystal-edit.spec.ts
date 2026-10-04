import { openSavedCatalogVersion } from './definition-fixtures'
import { referencePath } from './reference-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import { expectOfflineReady } from './offline-helpers'
import { openBuildGameSetup, selectedPlaythrough } from './local-data-helpers'
import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { strFromU8, unzipSync } from 'fflate'
import { syntheticCrystalEdit, syntheticPrerequisiteCrystalEdit } from '../src/interchange/crystal-edit.test-helpers'
import type { LocalData } from '../src/domain/types'
import { DEFAULT_CATALOG } from '../src/catalog/bundled'
import { nativeSourceRecord } from '../src/domain/native-game'

const WARRIOR_PATH = referencePath('base:job:0')

async function openData(page: Page) {
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  return page.getByRole('dialog', { name: 'Data & settings', exact: true })
}

async function exportLocalData(page: Page): Promise<LocalData> {
  const settings = await openData(page)
  await settings.getByRole('button', { name: 'Import & backup', exact: true }).click()
  const download = page.waitForEvent('download')
  await settings.getByRole('button', { name: 'Export backup', exact: true }).click()
  const entries = unzipSync(await readFile((await (await download).path())!))
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  return (JSON.parse(strFromU8(entries['bundle.json']!)) as { localData: LocalData }).localData
}

async function expectClassProvenance(page: Page) {
  await expect(page.getByRole('region', { name: 'Game details', exact: true })).toHaveCount(0)
  const sources = page.getByRole('region', { name: 'Source trail', exact: true })
  expect(await sources.evaluate(element => Boolean(document.querySelector('[aria-label="Planning fields"]')!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true)
  const raw = sources.locator('pre.native-source-record')
  await expect(raw).not.toBeVisible()
  await sources.getByText('Source and version details', { exact: true }).click()
  await expect(sources).toContainText('Native job #0')
  await sources.getByText('Complete native source record', { exact: true }).click()
  await expect(raw).toBeVisible()
  expect(JSON.parse((await raw.textContent())!)).toEqual(nativeSourceRecord(DEFAULT_CATALOG.entities['base:job:0']!))
  await expect(raw.locator('..').locator('table, ol, ul')).toHaveCount(0)
  await expect(page.locator('.class-learn-tree')).toHaveCount(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

test('bundled class calculations respond to explicit mixed growth and work offline', { tag: MOBILE_TEST_TAG }, async ({ page, context, baseURL }, testInfo) => {
  const externalRequests: string[] = []
  page.on('request', request => { if (!request.url().startsWith(`${baseURL}/`)) externalRequests.push(request.url()) })
  await page.goto(WARRIOR_PATH)
  const research = page.getByRole('region', { name: 'Class growth and learning' })
  await research.getByText('Growth calculator', { exact: true }).click()
  const hp = research.getByRole('table', { name: 'Native base stats', exact: true }).getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'HP', exact: true }) })
  await expect(hp).toContainText('Unknown')
  await research.getByRole('button', { name: 'Use Warrior for all growth levels', exact: true }).click()
  await expect(hp).toContainText('1,244')
  await research.getByLabel('Growth calculation gender', { exact: true }).selectOption('male')
  await expect(hp).toContainText('1,344')
  await research.getByLabel('Growth calculation gender', { exact: true }).selectOption('')
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
  await expect(hp).toContainText('659')
  await research.getByText('Learn tree', { exact: true }).click()
  const tree = research.getByRole('list', { name: 'Learn tree skills' })
  await expect(research.locator('.learn-tree-sources')).toHaveCount(0)
  await expect(tree.getByRole('link', { name: 'ability Taunt 0 LP', exact: true })).toBeVisible()
  await expect(tree.getByRole('link', { name: 'passive Equip Axe 2 LP', exact: true })).toBeVisible()
  await expect(tree.getByRole('link', { name: 'ability Power Break 2 LP', exact: true })).toHaveAccessibleDescription('Requires all: Defender')
  await expect(tree.getByText(/^(Gate|Empty|Ability #|Passive #)/)).toHaveCount(0)
  await expect(research.locator('.learn-tree__connectors > path[data-from="1:0"][data-to="2:0"]')).toHaveCount(1)
  await expect(research.locator('.learn-tree__connectors > path[data-from="1:0"][data-to="2:0"]')).not.toHaveAttribute('marker-end')
  await expect(research.locator('.learn-tree__connectors > path[data-from="2:0"][data-to="3:0"]')).toHaveAttribute('marker-end', /url\(#.+\)/)
  const connectorBounds = await research.locator('.learn-tree__connectors').boundingBox()
  const treeBounds = await research.locator('.learn-tree').boundingBox()
  expect(connectorBounds!.width).toBeCloseTo(treeBounds!.width, 1)
  expect(connectorBounds!.height).toBeCloseTo(treeBounds!.height, 1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
  await page.screenshot({ path: testInfo.outputPath('class-growth-and-tree.png'), fullPage: true })
  const settings = await openData(page)
  await settings.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  await settings.getByRole('button', { name: 'Prepare for offline use', exact: true }).click()
  await expectOfflineReady(settings)
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  await research.getByText('Growth calculator', { exact: true }).click()
  await research.getByRole('button', { name: 'Use Warrior for all growth levels', exact: true }).click()
  await expect(hp).toContainText('1,244')
  await research.getByText('Learn tree', { exact: true }).click()
  await tree.getByRole('link', { name: 'ability Taunt 0 LP', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Taunt', exact: true })).toBeVisible()
  expect(externalRequests).toEqual([])
})

test('custom class imports preserve the playthrough and supply tree names and command selections', async ({ page }, testInfo) => {
  await page.goto('/')
  const before = await exportLocalData(page)
  const settings = await openData(page)
  await settings.getByRole('button', { name: 'Import & backup', exact: true }).click()
  await settings.getByLabel('Choose import file', { exact: true }).setInputFiles({ name: 'synthetic-mod.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(syntheticCrystalEdit())) })
  await expect(settings.getByRole('combobox', { name: /^Import action/ })).toHaveValue('add-reference')
  await expect(settings.getByText(/referenced ability or passive definitions are absent/)).toBeVisible()
  await settings.getByRole('button', { name: 'Add references', exact: true }).click()
  await expect(settings).not.toBeVisible()
  const after = await exportLocalData(page)
  expect(after.id).toBe(before.id)
  expect(selectedPlaythrough(after).characters).toEqual(selectedPlaythrough(before).characters)
  expect(selectedPlaythrough(after).inventory).toEqual(selectedPlaythrough(before).inventory)
  expect(after.gameSetups).toEqual(before.gameSetups)
  await page.goto('/#/reference')
  await page.getByLabel('Search reference', { exact: true }).fill('Synthetic Scholar')
  await page.locator('.reference-card').filter({ has: page.getByRole('heading', { name: 'Synthetic Scholar', exact: true }) }).click()
  const research = page.getByRole('region', { name: 'Class growth and learning' })
  await research.getByText('Learn tree', { exact: true }).click()
  await expect(research.getByText('Synthetic Spark', { exact: true })).toBeVisible()
  await expect(research.getByText('Passive #2', { exact: true })).toBeVisible()
  await expect(research.getByText('LP unknown', { exact: true })).toHaveCount(2)
  await expect(research.getByText('Equip Axe', { exact: true })).toHaveCount(0)
  await research.getByText('Growth calculator', { exact: true }).click()
  await research.getByRole('button', { name: 'Use Synthetic Scholar for all growth levels', exact: true }).click()
  const stats = research.getByRole('table', { name: 'Native base stats', exact: true })
  await expect(stats.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'HP', exact: true }) })).toContainText('1,167')
  await expect(stats.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'STR', exact: true }) })).toContainText('Unknown')
  await page.screenshot({ path: testInfo.outputPath('imported-class.png'), fullPage: true })
  await page.goto('/#/builds/library/new')
  await openBuildGameSetup(page)
  await page.locator('.game-setup-mods > summary').click()
  await page.getByText('Add another mod', { exact: true }).click()
  await page.getByRole('searchbox', { name: 'Search available mods', exact: true }).fill('Synthetic class export')
  const mod = page.getByRole('region', { name: 'Mod Synthetic class export', exact: true })
  await expect(mod.getByRole('combobox', { name: 'Version of Synthetic class export', exact: true }).locator('option:checked')).toHaveText('1.0 · saved · format 34')
  await mod.getByRole('button', { name: 'Enable Synthetic class export for this build', exact: true }).click()
  const command = page.getByRole('combobox', { name: 'Sub-command', exact: true })
  await command.fill('Synthetic Research')
  await page.getByRole('listbox', { name: 'Choose Sub-command', exact: true }).getByRole('option').filter({ has: page.locator('strong', { hasText: /^Synthetic Research \(Synthetic Scholar\)$/ }) }).click()
  await expect(command).toHaveValue('Synthetic Research (Synthetic Scholar)')
})

test('Scholar tree names monster learning and keeps its Adrenaline reference separate from the Warrior passive', async ({ page }) => {
  await page.goto(referencePath('base:job:13'))
  const research = page.getByRole('region', { name: 'Class growth and learning' })
  await research.getByText('Learn tree', { exact: true }).click()
  const tree = research.getByRole('list', { name: 'Learn tree skills' })
  await expect(research.locator('.learn-tree-sources')).toHaveCount(0)
  const adrenaline = tree.getByRole('link', { name: 'Monster magic Adrenaline Monster learning', exact: true })
  await expect(adrenaline).toBeVisible()
  await expect(adrenaline).toHaveAttribute('href', referencePath('base:ability:202').slice(1))
  await expect(tree.getByRole('link', { name: 'Monster magic Reflection Monster learning', exact: true })).toBeVisible()
  await expect(tree.getByText(/^(Gate|Empty|Ability #|Passive #)/)).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width)
})

test('native class trees retain named skills and exact links in the native catalog revision', async ({ page }) => {
  await page.goto(WARRIOR_PATH)
  await expectClassProvenance(page)
  const research = page.getByRole('region', { name: 'Class growth and learning' })
  await research.getByText('Learn tree', { exact: true }).click()
  const tree = research.getByRole('list', { name: 'Learn tree skills' })
  await expect(research.locator('.learn-tree-sources')).toHaveCount(0)
  const taunt = tree.getByRole('link', { name: 'ability Taunt 0 LP', exact: true })
  await expect(taunt).toBeVisible()
  await expect(taunt).toHaveAttribute('href', referencePath('base:ability:28').slice(1))
  await expect(tree.getByRole('link', { name: 'passive Equip Axe 2 LP', exact: true })).toBeVisible()
  await taunt.click()
  await expect(page.getByRole('heading', { name: 'Taunt', exact: true })).toBeVisible()
})

test('draws every simultaneous prerequisite into its skill and keeps arrows aligned after resizing', { tag: MOBILE_TEST_TAG }, async ({ page }, testInfo) => {
  await page.goto('/')
  const settings = await openData(page)
  await settings.getByRole('button', { name: 'Import & backup', exact: true }).click()
  await settings.getByLabel('Choose import file', { exact: true }).setInputFiles({ name: 'synthetic-prerequisites.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(syntheticPrerequisiteCrystalEdit())) })
  await settings.getByRole('button', { name: 'Add references', exact: true }).click()
  await expect(settings).not.toBeVisible()
  await page.goto('/#/reference')
  await page.getByLabel('Search reference', { exact: true }).fill('Synthetic Scholar')
  await page.locator('.reference-card').filter({ has: page.getByRole('heading', { name: 'Synthetic Scholar', exact: true }) }).click()
  const research = page.getByRole('region', { name: 'Class growth and learning' })
  await research.getByText('Learn tree', { exact: true }).click()
  const two = research.locator('[data-position="1:0"]')
  const three = research.locator('[data-position="1:1"]')
  await expect(two).toContainText('Synthetic Combination')
  await expect(two).toContainText('Requires all: Synthetic Spark and Synthetic Focus')
  await expect(three).toContainText('Synthetic Fusion')
  await expect(three).toContainText('Requires all: Synthetic Spark and Synthetic Focus and Synthetic Calm')
  await expect(research.locator('.learn-tree__connectors > path[data-to="1:0"]')).toHaveCount(2)
  await expect(research.locator('.learn-tree__connectors > path[data-to="1:1"]')).toHaveCount(3)

  const checkArrows = async () => {
    await expect.poll(() => research.evaluate(region => {
      return [...region.querySelectorAll<SVGPathElement>('.learn-tree__connectors > path[data-from]')].every(path => {
        const origin = region.querySelector(`[data-position="${path.getAttribute('data-from')}"]`)!.getBoundingClientRect()
        const destination = region.querySelector(`[data-position="${path.getAttribute('data-to')}"]`)!.getBoundingClientRect()
        const transform = path.getScreenCTM()!
        const start = path.getPointAtLength(0).matrixTransform(transform)
        const end = path.getPointAtLength(path.getTotalLength()).matrixTransform(transform)
        return Math.abs(start.x - (origin.left + origin.width / 2)) < 1 && Math.abs(start.y - origin.bottom) < 1 && Math.abs(end.x - (destination.left + destination.width / 2)) < 1 && Math.abs(end.y - destination.top) < 1
      })
    })).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const diagram = research.getByRole('group', { name: 'Scrollable learn tree', exact: true })
    const bounds = (await diagram.boundingBox())!
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    const scrollable = await diagram.evaluate(element => element.scrollWidth > element.clientWidth)
    if (scrollable) {
      await diagram.focus()
      await page.keyboard.press('ArrowRight')
      await expect.poll(() => diagram.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
      await diagram.evaluate(element => { element.scrollLeft = 0 })
    }
  }
  await checkArrows()
  const originalViewport = page.viewportSize()!
  await page.setViewportSize({ width: 760, height: 915 })
  await checkArrows()
  await page.setViewportSize(originalViewport)
  await checkArrows()
  await page.screenshot({ path: testInfo.outputPath('simultaneous-prerequisites.png'), fullPage: true })
})


test('native learn trees resolve game names and draw simultaneous incoming arrows', async ({ page }) => {
  await page.goto(referencePath('base:job:10'))
  const research = page.getByRole('region', { name: 'Class growth and learning', exact: true })
  await research.getByText('Learn tree', { exact: true }).click()
  const destination = research.locator('[data-position="2:1"]')
  await expect(destination).toContainText('Requires all:')
  await expect(destination.locator('strong')).not.toContainText(/Ability #|Passive #/)
  await expect(research.locator('.learn-tree__connectors > path[data-to="2:1"]')).toHaveCount(2)
})

test('native personal class versions retain raw provenance below their gameplay sections', async ({ page }) => {
  await page.goto(WARRIOR_PATH)
  await openSavedCatalogVersion(page, 'base:job:0', 'Synthetic personal Warrior')
  await expect(page.getByRole('heading', { name: 'Synthetic personal Warrior', exact: true })).toBeVisible()
  await expectClassProvenance(page)
  await page.getByRole('region', { name: 'Class growth and learning' }).getByText('Learn tree', { exact: true }).click()
  await expect(page.getByRole('list', { name: 'Learn tree skills' })).toBeVisible()
})
