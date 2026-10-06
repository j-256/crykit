import { openStatBreakdown } from './calculation-presentation-helpers'
import { expect, test, type Page } from '@playwright/test'
import type { LocalData } from '../src/domain/types'
import { MOBILE_TEST_TAG } from './test-tags'

const SAMPLE_BUILD = 'Rowan: sample Warrior'

async function storedData(page: Page): Promise<LocalData> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('crykit')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const read = database.transaction('localDatas', 'readonly').objectStore('localDatas').getAll()
      read.onerror = () => { database.close(); reject(read.error) }
      read.onsuccess = () => { database.close(); resolve(read.result[0].localData) }
    }
  }))
}

async function openSample(page: Page) {
  await page.goto('/#/builds/library')
  await page.getByRole('button', { name: SAMPLE_BUILD, exact: true }).click()
}

test('existing 1.6.6 Builds open with numeric level-60 drafts without rewriting the saved checkpoint', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/builds/library')
  await expect(page.getByRole('heading', { name: 'Builds', exact: true })).toBeVisible()
  const before = await storedData(page)
  const build = Object.values(before.builds).find(build => build.title === SAMPLE_BUILD)!
  const original = before.buildRevisions[build.latestRevisionId!]!
  expect(original.content.calculation).toBeUndefined()
  await page.getByRole('button', { name: SAMPLE_BUILD, exact: true }).click()
  await openStatBreakdown(page)
  await expect(page.getByRole('heading', { name: 'Level 60 stats', exact: true })).toBeVisible()
  await openStatBreakdown(page)
  const overview = page.getByRole('table', { name: 'Planned build stats', exact: true })
  const totals = page.getByRole('table', { name: 'Calculated character stats', exact: true })
  await expect(overview).not.toContainText('Unknown')
  await expect(totals).not.toContainText('Unknown')
  await expect(totals.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Max HP', exact: true }) }).getByRole('cell').first()).toHaveText('1,244')
  expect(await storedData(page)).toEqual(before)
  await page.reload()
  await expect(page.getByLabel('Calculation level', { exact: true })).toHaveValue('60')
  expect(await storedData(page)).toEqual(before)
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
  await expect(page.getByRole('combobox', { name: /^Editor checkpoint/ }).locator('option:checked')).toContainText('r2')
  const after = await storedData(page)
  expect(after.buildRevisions[original.id]).toEqual(original)
  expect(after.gameSetups).toEqual(before.gameSetups)
  const saved = after.buildRevisions[after.builds[build.id]!.latestRevisionId!]!
  expect(saved.content.calculation?.level).toBe(60)
  expect(saved.content.calculation?.growth).toEqual([{ classRef: original.content.primaryClass, levels: 60 }])
  await page.reload()
  await expect(totals).not.toContainText('Unknown')
})

test('unsupported setup recovery explains the blocker and opens the existing setup controls', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await openSample(page)
  const before = await storedData(page)
  await page.locator('.build-behavior > summary').click()
  await page.getByRole('button', { name: 'Enter exact version', exact: true }).click()
  await page.getByLabel('Exact game version', { exact: true }).fill('1.7.0')
  await page.locator('.build-behavior > summary').click()
  await openStatBreakdown(page)
  const overview = page.getByRole('region', { name: 'Class stats', exact: true })
  await expect(overview).toContainText('Native calculations do not support game version 1.7.0.')
  await openStatBreakdown(page)
  await expect(page.getByRole('table', { name: 'Planned build stats', exact: true })).toHaveCount(0)
  await expect(page.getByRole('table', { name: 'Calculated character stats', exact: true })).toHaveCount(0)
  await expect(page.getByRole('table', { name: 'Damage benchmarks', exact: true })).toHaveCount(0)
  await overview.getByRole('button', { name: 'Review Game Setup', exact: true }).click()
  await expect(page.locator('.build-behavior')).toHaveAttribute('open')
  await expect(page.getByRole('combobox', { name: 'Copy Game Setup', exact: true })).toBeFocused()
  await page.getByLabel('Exact game version', { exact: true }).fill('1.6.6')
  await expect(page.getByRole('table', { name: 'Calculated character stats', exact: true })).not.toContainText('Unknown')
  expect(await storedData(page)).toEqual(before)
})

test('incomplete growth retains known components and recovers after correcting the allocation', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await openSample(page)
  await page.getByText(/^Level-up growth/).click()
  await page.getByLabel('Growth levels 1', { exact: true }).fill('55')
  await openStatBreakdown(page)
  const overview = page.getByRole('table', { name: 'Planned build stats', exact: true })
  await expect(overview.getByRole('columnheader')).toHaveText(['Stat', 'Base'])
  await expect(overview).not.toContainText('Unknown')
  await expect(overview.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Max HP', exact: true }) }).getByRole('cell')).toHaveText('149')
  await expect(page.getByRole('region', { name: 'Calculated stats', exact: true })).toContainText('Growth allocates 55 of 60 levels.')
  await expect(page.getByRole('table', { name: 'Calculated character stats', exact: true })).toHaveCount(0)
  await page.getByLabel('Growth levels 1', { exact: true }).fill('60')
  await expect(overview.getByRole('columnheader')).toHaveText(['Stat', 'Base', 'Equipment', 'Level', 'Gender', 'Total'])
  await expect(page.getByRole('table', { name: 'Calculated character stats', exact: true })).not.toContainText('Unknown')
})

test('an explicitly saved unknown level remains unknown when the Build is reopened', async ({ page }) => {
  await openSample(page)
  await page.getByLabel('Calculation level', { exact: true }).fill('')
  await page.getByRole('button', { name: 'Save new revision', exact: true }).click()
  await expect(page.getByRole('combobox', { name: /^Editor checkpoint/ }).locator('option:checked')).toContainText('r2')
  await page.reload()
  await expect(page.getByLabel('Calculation level', { exact: true })).toHaveValue('')
  await openStatBreakdown(page)
  await expect(page.getByRole('heading', { name: 'Level unknown stats', exact: true })).toBeVisible()
  await expect(page.getByRole('table', { name: 'Calculated character stats', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Calculated stats', exact: true })).toContainText('Choose a supported native calculation level.')
})
