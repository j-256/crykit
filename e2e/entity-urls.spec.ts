import { expect, test } from '@playwright/test'
import { referencePath } from './reference-helpers'

const DESERT_PATH = referencePath('base:monster:316')
const PUN_STORM_PATH = referencePath('mod:moonlight-project:ability:565')

test('base, mod, and supplemental entries use the bundled route contract directly', async ({ page }) => {
  for (const [path, name] of [
    ['/#/reference/catalog/v1/base/item/203/quintar-berries', 'Quintar Berries'],
    ['/#/reference/catalog/v1/mod/equipment-expansion/equipment/592/heavy-edge', 'Heavy Edge'],
    ['/#/reference/catalog/v1/base/other/ref-909/achievements', 'Achievements'],
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
  const desert = page.locator(`a[href^="${referencePath('base:monster:316', 'crystal-project-public-starter', 'catalog-v2').slice(1)}?"]`)
  const red = page.locator(`a[href^="${referencePath('base:monster:57', 'crystal-project-public-starter', 'catalog-v2').slice(1)}?"]`)
  await expect(desert).toBeVisible()
  await expect(red).toBeVisible()
  await expect(desert).toHaveAttribute('href', /\/316\/brutish-quintar-desert\?/)
  await expect(red).toHaveAttribute('href', /\/57\/brutish-quintar-red\?/)
  await expect(desert).toHaveAttribute('href', /q=Brutish\+Quintar/)
  const other = await context.newPage()
  await other.goto(DESERT_PATH)
  await expect(other.getByRole('heading', { name: 'Brutish Quintar', exact: true })).toBeVisible()
  await expect(other.locator('.enemy-hero')).toContainText('4900')
  await other.reload()
  await expect(other).toHaveURL(new RegExp(`${DESERT_PATH}$`))
  await expect(other.getByRole('heading', { name: 'Brutish Quintar', exact: true })).toBeVisible()
  await desert.click()
  await expect(page).toHaveURL(/\/316\/brutish-quintar-desert(?:\?|$)/)
  await expect(page).toHaveURL(/q=Brutish\+Quintar/)
})

test('a wrong slug resolves by ID and normalizes without an extra history entry', async ({ page }) => {
  await page.goto('/#/reference')
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
  await page.goto(PUN_STORM_PATH)
  await expect(page).toHaveURL(/\/mod\/moonlight-project\/ability\/565\/100-pun-storm$/)
  await page.getByRole('button', { name: /^(Search|Search planner)$/ }).filter({ visible: true }).click()
  await expect(page).toHaveURL(/\/565\/100-pun-storm\/search$/)
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
