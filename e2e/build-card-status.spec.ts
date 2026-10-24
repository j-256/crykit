import { clickBuildAction } from './planning-header-helpers'
import { expect, test, type Page } from '@playwright/test'
import { readLocalData, replacePlannerFixture, waitForPlannerReady } from './local-data-helpers'

const ORIGINAL_TITLE = 'Rowan: sample Warrior'

async function archiveBuildFixture(page: Page): Promise<readonly string[]> {
  const localData = await readLocalData(page)
  const archived = Object.values(localData.builds).find(build => build.title === ORIGINAL_TITLE)
  if (!archived) throw new Error('The synthetic Build is missing')
  const stored = await replacePlannerFixture(page, { ...localData, builds: { ...localData.builds, [archived.id]: { ...archived, archived: true } } })
  expect(stored.builds[archived.id]).toEqual({ ...archived, archived: true })
  return [archived.title]
}

test('saved and cloned Builds have no classification badges', async ({ page }) => {
  await page.goto('/#/builds/library')
  await expect(page.getByRole('button', { name: ORIGINAL_TITLE, exact: true })).toBeVisible()
  await expect(page.locator('.build-card__header > .badge')).toHaveCount(0)
  await page.getByRole('button', { name: ORIGINAL_TITLE, exact: true }).click()
  await clickBuildAction(page, 'Clone Build')
  await expect(page.getByRole('heading', { name: `${ORIGINAL_TITLE} (copy)`, exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Back to Build library', exact: true }).click()
  await expect(page.getByRole('button', { name: `${ORIGINAL_TITLE} (copy)`, exact: true })).toBeVisible()
  await expect(page.locator('.build-card__header > .badge')).toHaveCount(0)
  await expect(page.locator('.build-card .badge').filter({ hasText: /^sample$/ }).first()).toBeVisible()
})

test('archived Builds stay hidden without lifecycle classifications', async ({ page }) => {
  await page.goto('/#/builds/library')
  await expect(page.getByRole('button', { name: ORIGINAL_TITLE, exact: true })).toBeVisible()
  const originalCount = await page.locator('.build-card').count()
  const [archived] = await archiveBuildFixture(page)
  await page.reload()
  await waitForPlannerReady(page)
  await expect(page.getByRole('button', { name: archived, exact: true })).toHaveCount(0)
  await expect(page.locator('.build-card')).toHaveCount(originalCount - 1)
  await expect(page.locator('.build-card__header > .badge')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
