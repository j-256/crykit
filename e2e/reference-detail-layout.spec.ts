import { REFERENCE_EVIDENCE_CATALOG, REFERENCE_EVIDENCE_ENTITIES, evidenceReferencePath, installReferenceEvidence } from './reference-evidence-fixtures'
import { openSavedSourceVersion } from './definition-fixtures'
import { referencePath } from './reference-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

const TABLE_CLASS = evidenceReferencePath(REFERENCE_EVIDENCE_ENTITIES.wide)

async function checkDetailLayout(page: Page, desktop: boolean, testInfo: TestInfo, name = 'Synthetic table class') {
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
    const value = record.closest('dd')!.getBoundingClientRect()
    const wrapper = record.closest('.sources-attached')!.getBoundingClientRect()
    const anchor = record.closest('.sources-anchor')!.getBoundingClientRect()
    return { widths: { ratings: bounds.width, value: value.width, wrapper: wrapper.width, anchor: anchor.width }, pairs: [...record.children].map(pair => {
      const label = document.createRange()
      label.selectNodeContents(pair.querySelector('dt')!)
      const labelBounds = label.getBoundingClientRect()
      const valueBounds = pair.querySelector('dd')!.getBoundingClientRect()
      return { gap: valueBounds.left - labelBounds.right, aligned: Math.abs(valueBounds.top + valueBounds.height / 2 - labelBounds.top - labelBounds.height / 2) < 2, fits: valueBounds.right <= bounds.right, column: Math.round(pair.getBoundingClientRect().left) }
    }) }
  })
  await testInfo.attach('wide-fact-geometry', { body: JSON.stringify({ table: geometry, ratings: ratingGeometry }), contentType: 'application/json' })
  expect(Math.abs(ratingGeometry.widths.wrapper - ratingGeometry.widths.value)).toBeLessThanOrEqual(1)
  expect(ratingGeometry.widths.ratings).toBeCloseTo(ratingGeometry.widths.anchor, 0)
  for (const pair of ratingGeometry.pairs) {
    expect(pair.gap).toBeGreaterThan(0)
    expect(pair.aligned).toBe(true)
    expect(pair.fits).toBe(true)
  }
  if (desktop) expect(new Set(ratingGeometry.pairs.map(pair => pair.column)).size).toBeGreaterThan(1)
  await ratings.scrollIntoViewIfNeeded()
  await ratings.screenshot({ path: testInfo.outputPath('wide-fact-ratings.png') })
  const trigger = page.getByRole('button', { name: `Sources for ${name}`, exact: true })
  const sources = page.getByRole('dialog', { name: `Sources for ${name}`, exact: true })
  await expect(sources).toHaveCount(0)
  await trigger.scrollIntoViewIfNeeded()
  const triggerBounds = (await trigger.boundingBox())!
  expect(triggerBounds.width).toBeLessThanOrEqual(48)
  expect(triggerBounds.height).toBeLessThanOrEqual(48)
  const beforeOpening = await facts.evaluate(element => ({ top: element.getBoundingClientRect().top, width: element.getBoundingClientRect().width }))
  await trigger.click()
  await expect(sources).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('wide-fact-sources.png') })
  const popupBounds = (await sources.boundingBox())!
  const viewport = page.viewportSize()!
  expect(popupBounds.x).toBeGreaterThanOrEqual(0)
  expect(popupBounds.y).toBeGreaterThanOrEqual(0)
  expect(popupBounds.x + popupBounds.width).toBeLessThanOrEqual(viewport.width)
  expect(popupBounds.y + popupBounds.height).toBeLessThanOrEqual(viewport.height)
  expect(popupBounds.width).toBeLessThanOrEqual(360)
  const afterOpening = await facts.evaluate(element => ({ top: element.getBoundingClientRect().top, width: element.getBoundingClientRect().width }))
  expect(afterOpening.width).toBe(beforeOpening.width)
  expect(afterOpening.top).toBe(beforeOpening.top)
  await page.keyboard.press('Escape')
  await expect(sources).toHaveCount(0)
  await expect(trigger).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

test('gives reference tables the detail width and restores filtered browsing', { tag: MOBILE_TEST_TAG }, async ({ page }, testInfo) => {
  await installReferenceEvidence(page)
  await page.goto('/#/reference')
  await page.getByRole('searchbox', { name: 'Search reference', exact: true }).fill('Synthetic table class')
  await page.locator('.reference-card').filter({ has: page.getByRole('heading', { name: 'Synthetic table class', exact: true }) }).click()
  await checkDetailLayout(page, testInfo.project.name === 'desktop', testInfo)
  await page.getByRole('button', { name: 'Back to results', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Refine', exact: true })).toBeVisible()
  await expect(page.getByRole('searchbox', { name: 'Search reference', exact: true })).toHaveValue('Synthetic table class')
  await expect(page.locator('.reference-card').filter({ has: page.getByRole('heading', { name: 'Synthetic table class', exact: true }) })).toBeVisible()
})

test('uses the same wide tables and clean headings for personal definitions', { tag: MOBILE_TEST_TAG }, async ({ page }, testInfo) => {
  await installReferenceEvidence(page)
  await page.goto(TABLE_CLASS)
  await openSavedSourceVersion(page, REFERENCE_EVIDENCE_CATALOG, REFERENCE_EVIDENCE_ENTITIES.wide.id, 'Synthetic wide Warrior')
  await expect(page.getByRole('heading', { name: 'Synthetic wide Warrior', exact: true })).toBeVisible()
  await checkDetailLayout(page, testInfo.project.name === 'desktop', testInfo, 'Synthetic wide Warrior')
})

test('gameplay facts lead equipment details while engine fields stay available on demand', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(referencePath('base:equipment:134'))
  const facts = page.getByRole('region', { name: 'Definition facts', exact: true })
  await expect(facts.locator('dt').filter({ hasText: /^Max MP$/ })).toBeVisible()
  await expect(facts.locator('dt').filter({ hasText: /^Two-handed$/ })).toBeVisible()
  await expect(facts).not.toContainText('Stat modifiers')
  await expect(facts).not.toContainText('Automatic equipment price disabled')
  const planning = page.getByRole('region', { name: 'Planning fields', exact: true })
  await expect(planning).toBeVisible()
  await expect(planning).toContainText('Requirements')
  await expect(planning).toContainText('equipment:Light Body')
  await expect(planning).not.toContainText('Listed contributions')
  const technical = page.locator('.reference-technical')
  await expect(technical).not.toHaveAttribute('open')
  await expect(page.getByRole('region', { name: 'Technical facts', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Collect into Game Setup revision', exact: true })).toHaveCount(0)
  await technical.locator(':scope > summary').click()
  const engine = page.getByRole('region', { name: 'Technical facts', exact: true })
  await expect(engine).toContainText('Stat modifiers')
  await expect(engine.getByRole('columnheader', { name: 'Value1', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sources for Dress', exact: true })).toHaveCount(0)
  const directionsTrigger = page.getByRole('button', { name: 'Sources for Directions', exact: true })
  await directionsTrigger.click()
  const directionsSources = page.getByRole('dialog', { name: 'Sources for Directions', exact: true })
  await expect(directionsSources).toBeVisible()
  await expect(directionsSources.locator('a[href="https://crystal-project.fandom.com/wiki/Light_armor/table?oldid=11534"]')).toBeVisible()
  await expect(directionsSources).toContainText('CC-BY-SA')
  const sourceBounds = (await directionsSources.boundingBox())!
  const viewport = page.viewportSize()!
  expect(sourceBounds.x).toBeGreaterThanOrEqual(0)
  expect(sourceBounds.y).toBeGreaterThanOrEqual(0)
  expect(sourceBounds.x + sourceBounds.width).toBeLessThanOrEqual(viewport.width)
  expect(sourceBounds.y + sourceBounds.height).toBeLessThanOrEqual(viewport.height)
  await page.keyboard.press('Escape')
  await expect(directionsSources).toHaveCount(0)
  await expect(directionsTrigger).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await installReferenceEvidence(page)
  const contribution = REFERENCE_EVIDENCE_ENTITIES.contributions
  expect(contribution.listedContributions.Defense).toMatchObject({ state: 'known', value: { value: 18, unit: 'listed flat value' } })
  await page.goto(evidenceReferencePath(contribution))
  await expect(planning).toContainText('Listed contributions')
  await expect(planning.getByText('18', { exact: true })).toBeVisible()
  await expect(planning.getByText('listed flat value', { exact: true })).toBeVisible()
  await planning.getByRole('button', { name: 'Sources for Defense', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Sources for Defense', exact: true })).toContainText('Synthetic original table')
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(planning.getByText('18', { exact: true })).toBeVisible()
  await expect(planning.getByText('listed flat value', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
