import { openSavedCatalogVersion } from './definition-fixtures'
import { referencePath } from './reference-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import { expect, test, type Page } from '@playwright/test'

const WARRIOR = referencePath('base:job:0')

async function checkDetailLayout(page: Page, desktop: boolean) {
  await expect(page.getByRole('heading', { name: 'Refine', exact: true })).toHaveCount(0)
  const facts = page.getByRole('region', { name: 'Definition facts', exact: true })
  const battle = facts.locator('.definition-row').filter({ has: page.locator('dt', { hasText: /^Battle Skill$/ }) }).filter({ has: page.getByRole('table') })
  const passives = facts.locator('.definition-row').filter({ has: page.locator('dt', { hasText: /^Passives$/ }) }).filter({ has: page.getByRole('table') })
  await expect(battle.getByRole('table')).toBeVisible()
  await expect(passives.getByRole('table')).toBeVisible()
  await expect(facts.locator('dt', { hasText: /^Table:|^Passives 2$/ })).toHaveCount(0)
  const geometry = await battle.evaluate(row => {
    const label = row.querySelector('dt')!.getBoundingClientRect()
    const value = row.querySelector('dd')!.getBoundingClientRect()
    const container = row.querySelector<HTMLElement>('.structured-value__table')!
    const rowBounds = row.getBoundingClientRect()
    const factsBounds = row.closest('section')!.getBoundingClientRect()
    return { above: label.bottom <= value.top, fullRow: value.width >= rowBounds.width - 1, factsRatio: value.width / factsBounds.width, tableOverflow: container.scrollWidth > container.clientWidth }
  })
  expect(geometry.above).toBe(true)
  expect(geometry.fullRow).toBe(true)
  expect(geometry.factsRatio).toBeGreaterThan(.8)
  if (desktop) expect(geometry.tableOverflow).toBe(false)
  const ratings = facts.locator('.definition-row').filter({ has: page.locator('dt', { hasText: /^Growth ratings$/ }) })
  await expect(ratings.locator('.stat-rating')).toHaveCount(10)
  const ratingGeometry = await ratings.locator('.stat-ratings').evaluate(record => {
    const bounds = record.getBoundingClientRect()
    return [...record.children].map(pair => {
      const label = document.createRange()
      label.selectNodeContents(pair.querySelector('dt')!)
      const labelBounds = label.getBoundingClientRect()
      const valueBounds = pair.querySelector('dd')!.getBoundingClientRect()
      return { gap: valueBounds.left - labelBounds.right, aligned: Math.abs(valueBounds.top + valueBounds.height / 2 - labelBounds.top - labelBounds.height / 2) < 2, fits: valueBounds.right <= bounds.right, column: Math.round(pair.getBoundingClientRect().left) }
    })
  })
  for (const pair of ratingGeometry) {
    expect(pair.gap).toBeGreaterThan(0)
    expect(pair.aligned).toBe(true)
    expect(pair.fits).toBe(true)
  }
  if (desktop) expect(new Set(ratingGeometry.map(pair => pair.column)).size).toBeGreaterThan(1)
  const factsBounds = (await facts.boundingBox())!
  const sourceBounds = (await page.getByRole('region', { name: 'Source trail', exact: true }).boundingBox())!
  expect(sourceBounds.y).toBeGreaterThanOrEqual(factsBounds.y + factsBounds.height)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

test('gives reference tables the detail width and restores filtered browsing', { tag: MOBILE_TEST_TAG }, async ({ page }, testInfo) => {
  await page.goto('/#/reference')
  await page.getByRole('searchbox', { name: 'Search reference', exact: true }).fill('Warrior')
  await page.locator('.reference-card').filter({ has: page.getByRole('heading', { name: 'Warrior', exact: true }) }).click()
  await checkDetailLayout(page, testInfo.project.name === 'desktop')
  await page.getByRole('button', { name: 'Back to results', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Refine', exact: true })).toBeVisible()
  await expect(page.getByRole('searchbox', { name: 'Search reference', exact: true })).toHaveValue('Warrior')
  await expect(page.locator('.reference-card').filter({ has: page.getByRole('heading', { name: 'Warrior', exact: true }) })).toBeVisible()
})

test('uses the same wide tables and clean headings for personal definitions', { tag: MOBILE_TEST_TAG }, async ({ page }, testInfo) => {
  await page.goto(WARRIOR)
  await openSavedCatalogVersion(page, 'base:job:0', 'Synthetic wide Warrior')
  await expect(page.getByRole('heading', { name: 'Synthetic wide Warrior', exact: true })).toBeVisible()
  await checkDetailLayout(page, testInfo.project.name === 'desktop')
})
