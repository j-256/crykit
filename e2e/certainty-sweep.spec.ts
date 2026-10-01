import { expect, test, type Page } from '@playwright/test'
import { expectOfflineReady } from './offline-helpers'

const CATALOG_PATH = '/#/reference/catalog/crystal-project-public-starter/revisions/'
const PUN_STORM_PATH = `${CATALOG_PATH}catalog-v1/entities/mod/moonlight-project/ability/565`
const FREELANCER_PATH = `${CATALOG_PATH}catalog-v1/entities/mod/moonlight-project/class/26`

function fact(page: Page, label: string) {
  return page.getByRole('region', { name: 'Definition facts', exact: true }).locator('.definition-row').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) })
}

test('Moonlight definitions open directly with relevant known facts', async ({ page, baseURL }) => {
  const errors: string[] = []
  const external: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (new URL(request.url()).origin !== new URL(baseURL!).origin) external.push(request.url()) })
  await page.goto(PUN_STORM_PATH)
  await expect(page.getByRole('heading', { name: '100-Pun Storm', exact: true })).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`${PUN_STORM_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  await expect(fact(page, 'Description')).toContainText('Using a signature technique')
  await expect(fact(page, 'Cost')).toContainText('None')
  await expect(fact(page, 'MP cost')).toContainText('0')
  await expect(page.getByRole('region', { name: 'Planning fields', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Definition facts', exact: true }).getByText('unknown', { exact: true })).toHaveCount(0)
  await page.getByText('Source and version details', { exact: true }).click()
  await expect(page.getByRole('region', { name: 'Source trail', exact: true })).toContainText('Abilities #565')
  await page.getByText('Complete mod source record', { exact: true }).click()
  await expect(page.locator('.native-source-record')).toContainText('"JP": 400')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])
  expect(external).toEqual([])
  await page.reload()
  await expect(page.getByRole('heading', { name: '100-Pun Storm', exact: true })).toBeVisible()
  await expect(page).toHaveURL(new RegExp('/entities/mod/moonlight-project/ability/565$'))
})

test('Moonlight trees stay named offline and do not imply personal learning', async ({ page, context }) => {
  await page.goto(FREELANCER_PATH)
  await expect(page.getByRole('heading', { name: 'Freelancer', exact: true })).toBeVisible()
  const learning = page.getByRole('region', { name: 'Class growth and learning', exact: true })
  await expect(learning).toContainText('100-Pun Storm')
  await expect(learning).not.toContainText(/(Ability|Passive) #\d+/)
  await page.getByRole('button', { name: /^(Data & settings|Open data and settings)$/ }).filter({ visible: true }).click()
  const settings = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await settings.getByRole('button', { name: 'Offline & storage', exact: true }).click()
  const prepare = settings.getByRole('button', { name: 'Prepare for offline use', exact: true })
  if (await prepare.isVisible()) await prepare.click()
  await expectOfflineReady(settings)
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Freelancer', exact: true })).toBeVisible()
  await expect(learning).toContainText('100-Pun Storm')
  await learning.getByText('Learn tree', { exact: true }).click()
  const punStorm = learning.getByRole('link', { name: /100-Pun Storm/ })
  await expect(punStorm).toHaveAttribute('href', PUN_STORM_PATH.slice(1))
  await punStorm.click()
  await expect(page.getByRole('heading', { name: '100-Pun Storm', exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Freelancer', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('explicit null is a known absent value and travel tools use base identities', async ({ page }) => {
  await page.goto(`${CATALOG_PATH}catalog-v1/entities/base/item/tonic`)
  const capacity = fact(page, 'Increase Max Capacity By')
  await expect(capacity).toContainText('Not set in source')
  await expect(capacity.getByText('unknown', { exact: true })).toHaveCount(0)
  await page.goto(`${CATALOG_PATH}catalog-v1/entities/base/item/treasure-finder`)
  await expect(page).toHaveURL(/catalog-v1\/entities\/base\/item\/treasure-finder$/)
  await expect(page.getByRole('heading', { name: 'Treasure Finder', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('retired encoded-colon entity URLs show recovery', async ({ page }) => {
  await page.goto(`${CATALOG_PATH}catalog-v1/entities/mod%3Amoonlight-project%3Aability%3A565`)
  await expect(page.getByRole('heading', { name: 'This link could not be opened', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '100-Pun Storm', exact: true })).toHaveCount(0)
})
