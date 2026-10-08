import { importSyntheticLibrary, syntheticReferencePath } from './mod-library-fixtures'
import { expect, test } from '@playwright/test'
import { referencePath } from './reference-helpers'
import { waitForPlannerReady } from './local-data-helpers'

const DESERT_PATH = referencePath('base:monster:316')
const PUN_STORM_PATH = syntheticReferencePath(1, 'Abilities', 9002, 'Synthetic Technique')

test('native and supplemental entries use exact current catalog routes directly', async ({ page }) => {
  for (const [path, name] of [
    ['/#/reference/catalog/crystal-project-public-starter/catalog-v3/base/item/203/quintar-berries', 'Quintar Berries'],
    ['/#/reference/catalog/crystal-project-public-starter/catalog-v3/base/other/ref-909/achievements', 'Achievements'],
  ]) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`${path}$`))
  }
})

test('saved catalog-v2 reference links retain their original definitions', async ({ page }) => {
  const path = referencePath('mod:barbarian:class:ref-1078', 'crystal-project-public-starter', 'catalog-v2')
  await page.goto(path)
  await expect(page.getByRole('heading', { name: 'Barbarian', exact: true })).toBeVisible()
  await page.reload()
  await expect(page).toHaveURL(new RegExp(`${path}$`))
})

test('native monster links carry reviewed variant names and survive new tabs and reloads', async ({ page, context }) => {
  await page.goto('/#/reference?v=1&q=Brutish+Quintar&kind=monster')
  await waitForPlannerReady(page)
  const desert = page.locator(`a[href^="${referencePath('base:monster:316', 'crystal-project-public-starter', 'catalog-v3').slice(1)}?"]`)
  const red = page.locator(`a[href^="${referencePath('base:monster:57', 'crystal-project-public-starter', 'catalog-v3').slice(1)}?"]`)
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
  await expect(page).toHaveURL(/\/crystal-edit%3Asynthetic-moonlight\/sha256%3A[a-f0-9]{64}%3Arules-v2%3Alibrary-v3\/mod\/synthetic-moonlight\/ability\/9002\/synthetic-technique$/)
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

test('historical bundled routes preserve the pin when definitions are unavailable', async ({ page }) => {
  await page.goto('/#/reference/catalog/v1/mod/equipment-expansion/equipment/592/heavy-edge')
  await expect(page.getByText('Reference definition unavailable', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Heavy Edge', exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(/\/catalog\/v1\/mod\/equipment-expansion\/equipment\/592\/definition$/)
})
