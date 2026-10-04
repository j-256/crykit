import { expect, test } from '@playwright/test'
import { referencePath, referenceUrlPattern } from './reference-helpers'
import { MOBILE_TEST_TAG } from './test-tags'

test('native effects lead the page while original claims remain available', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(referencePath('base:item:132'))
  await expect(page.locator('.reference-detail .reference-description')).toContainText(/missing HP/i)
  const facts = page.getByRole('region', { name: 'Definition facts', exact: true })
  await expect(facts.locator('.definition-row').filter({ has: page.getByText('Effect', { exact: true }) })).toContainText(/missing HP/i)
  await expect(facts).not.toContainText('Sources differ')
  await page.getByRole('button', { name: 'Sources for Shoudu Stew', exact: true }).click()
  const originalClaims = page.getByText('Original stat and effect claims', { exact: true }).locator('..')
  await originalClaims.locator(':scope > summary').click()
  await expect(originalClaims.getByText('Single target. Recovery 100% missing HP.', { exact: true })).toBeVisible()
  await expect(originalClaims.getByText('Single target. Recovery: 100% HP', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('complete native effects retain distinct strategy and directions as guide notes', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(referencePath('base:equipment:134'))
  await expect(page.getByRole('region', { name: 'Game details', exact: true })).toHaveCount(0)
  const description = page.locator('.reference-detail .reference-description')
  await expect(description.locator(':scope > p')).toContainText(/Resistance:\s*\+78/)
  const guideNotes = description.getByText('Guide notes', { exact: true }).locator('..')
  await guideNotes.locator(':scope > summary').click()
  await expect(guideNotes).toContainText("It can be useful to light armor wearers who don't need Mind or Spirit, such as Chemists.")
  await expect(guideNotes).toContainText('before reaching the Chemist crystal')
})

test('verified source alternatives navigate to native definitions without changing the original URL', async ({ page }) => {
  await page.goto(referencePath('base:recipe:ref-933'))
  await page.getByRole('button', { name: 'Sources for Fursuit', exact: true }).click()
  const counterpart = page.getByRole('button', { name: /View .* game definition/ })
  await expect(counterpart).toBeVisible()
  await counterpart.click()
  await expect(page).toHaveURL(referenceUrlPattern('base:recipe:36'))
  await page.getByRole('button', { name: 'Sources for Fursuit', exact: true }).click()
  await page.getByText('Related source entries', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Fursuit', exact: true })).toBeVisible()
})

test('a real acquisition disagreement remains visible alongside native routes', async ({ page }) => {
  await page.goto(referencePath('base:equipment:589'))
  await expect(page.getByRole('region', { name: 'How to obtain', exact: true })).toContainText('Steal')
  await page.getByRole('button', { name: 'Sources for Ember Scythe', exact: true }).click()
  await expect(page.getByText('Acquisition sources differ', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Sources for Ember Scythe', exact: true })).toContainText('Red Guardian')
  await page.keyboard.press('Escape')
  await page.getByRole('combobox', { name: 'Game mode', exact: true }).selectOption('chaos')
  await expect(page.getByRole('region', { name: 'Definition facts', exact: true })).toContainText('Red Guardian')
  await page.getByRole('button', { name: 'Sources for Ember Scythe', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Sources for Ember Scythe', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Sources for Ember Scythe', exact: true }).getByText('Acquisition sources differ', { exact: true })).toHaveCount(0)
})

test('changing acquisition mode retains notes that have no reviewed replacement in that mode', async ({ page }) => {
  await page.goto(referencePath('base:item:132'))
  const facts = page.getByRole('region', { name: 'Definition facts', exact: true })
  await expect(facts).not.toContainText('Can be purchased from Shoudu Province.')
  await page.getByRole('combobox', { name: 'Game mode', exact: true }).selectOption('chaos')
  await expect(facts).toContainText('Can be purchased from Shoudu Province.')
  await expect(page.getByRole('region', { name: 'How to obtain', exact: true })).not.toContainText('Additional acquisition guidance')
})
