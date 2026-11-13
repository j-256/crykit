import { importSyntheticLibrary, syntheticReferencePath } from './mod-library-fixtures'
import { expect, test } from '@playwright/test'
import { referencePath } from './reference-helpers'
import { waitForPlannerReady } from './local-data-helpers'

const DESERT_PATH = referencePath('base:monster:316')
const PUN_STORM_PATH = syntheticReferencePath(1, 'Abilities', 9002, 'Synthetic Technique')

test('native and supplemental entries use exact current catalog routes directly', async ({ page }) => {
  for (const [path, name] of [
    ['/#/reference/crystal-project/vanilla/v1/item/203/quintar-berries', 'Quintar Berries'],
    ['/#/reference/crystal-project/vanilla/v1/other/ref-909/achievements', 'Achievements'],
  ]) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`${path}$`))
  }
})

test('native monster links carry reviewed variant names and survive new tabs and reloads', async ({ page, context }) => {
  await page.goto('/#/reference?v=1&q=Brutish+Quintar&kind=monster')
  await waitForPlannerReady(page)
  const desert = page.locator(`a[href^="${referencePath('base:monster:316').slice(1)}?"]`)
  const red = page.locator(`a[href^="${referencePath('base:monster:57').slice(1)}?"]`)
  await expect(desert).toBeVisible()
  await expect(red).toBeVisible()
  await expect(desert).toHaveAttribute('href', /\/316\/brutish-quintar-desert\?/)
  await expect(red).toHaveAttribute('href', /\/57\/brutish-quintar-red\?/)
  await expect(desert).toHaveAttribute('href', /q=Brutish\+Quintar/)
  const other = await context.newPage()
  await other.goto(DESERT_PATH)
  await waitForPlannerReady(other)
  await expect(other.getByRole('heading', { name: 'Brutish Quintar', exact: true })).toBeVisible()
  await expect(other.locator('.enemy-hero')).toContainText('4900')
  await other.reload()
  await waitForPlannerReady(other)
  await expect(other).toHaveURL(new RegExp(`${DESERT_PATH}$`))
  await expect(other.getByRole('heading', { name: 'Brutish Quintar', exact: true })).toBeVisible()
  await desert.click()
  await expect(page).toHaveURL(/\/316\/brutish-quintar-desert(?:\?|$)/)
  await expect(page).toHaveURL(/q=Brutish\+Quintar/)
})

test('a wrong slug resolves by ID and normalizes without an extra history entry', async ({ page }) => {
  await page.goto('/#/reference')
  await waitForPlannerReady(page)
  await expect(page.getByRole('heading', { name: 'Reference', exact: true })).toBeVisible()
  const initialLength = await page.evaluate(() => history.length)
  await page.evaluate(path => { location.hash = path.slice(1) }, DESERT_PATH.replace('brutish-quintar-desert', 'brutish-quintar-red'))
  await expect(page).toHaveURL(new RegExp(`${DESERT_PATH}$`))
  await expect(page.locator('.enemy-hero')).toContainText('4900')
  expect(await page.evaluate(() => history.length)).toBe(initialLength + 1)
  await page.goBack()
  await expect(page).toHaveURL(/#\/reference$/)
  await page.goForward()
  await expect(page).toHaveURL(new RegExp(`${DESERT_PATH}$`))
  await expect(page.getByRole('heading', { name: 'Brutish Quintar', exact: true })).toBeVisible()
})

test('mod names survive nested search routes', async ({ page }) => {
  await importSyntheticLibrary(page)
  await page.goto(PUN_STORM_PATH)
  await expect(page).toHaveURL(/\/crystal-project\/imported\/ce1-[a-f0-9]{64}\/j1-[a-f0-9]{64}-p1\/ability\/9002\/synthetic-technique$/)
  await page.getByRole('button', { name: /^(Search|Search planner)$/ }).filter({ visible: true }).click()
  await expect(page).toHaveURL(/\/9002\/synthetic-technique\/search$/)
  await page.reload()
  await expect(page.getByRole('dialog', { name: 'Search CryKit', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(new RegExp(`${PUN_STORM_PATH}$`))
})

test('slugless pre-release entity URLs show recovery', async ({ page }) => {
  await page.goto(DESERT_PATH.replace('/brutish-quintar-desert', ''))
  await expect(page.getByRole('heading', { name: 'This link could not be opened', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Brutish Quintar', exact: true })).toHaveCount(0)
})

test('retired catalog cloning links show recovery without opening an editor', async ({ page }) => {
  await page.goto(`${PUN_STORM_PATH}/definitions/override/${PUN_STORM_PATH.split('/reference/')[1]}`)
  await expect(page.getByRole('heading', { name: 'This link could not be opened', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Definition name', exact: true })).toHaveCount(0)
})

test('retired encoded-colon entity URLs show recovery', async ({ page }) => {
  await page.goto('/#/reference/catalog/crystal-project-public-starter/revisions/catalog-v1/entities/mod%3Amoonlight-project%3Aability%3A565')
  await expect(page.getByRole('heading', { name: 'This link could not be opened', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '100-Pun Storm', exact: true })).toHaveCount(0)
})

test('missing exact source routes preserve the request and show recovery', async ({ page }) => {
  const path = '/#/reference/crystal-project/vanilla/v99/equipment/3/dirk'
  await page.goto(path)
  await expect(page.getByText('Exact source unavailable', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Import source or backup', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Dirk', exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`${path}$`))
})
