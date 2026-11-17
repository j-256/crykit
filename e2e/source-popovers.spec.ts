import { expect, test, type Page } from '@playwright/test'
import { referencePath } from './reference-helpers'
import { MOBILE_TEST_TAG } from './test-tags'
import { sourcePayloadValid } from '../src/domain/source-fulfillment'
import { readLocalData, replacePlannerFixture, waitForPlannerReady } from './local-data-helpers'
import { REFERENCE_UNCERTAINTY_CATALOG, REFERENCE_UNCERTAINTY_ENTITIES, RETAINED_STUDY_SOURCES } from './reference-uncertainty-fixtures'

const study = REFERENCE_UNCERTAINTY_ENTITIES.study
const description = REFERENCE_UNCERTAINTY_ENTITIES.description
const independentPath = (record: typeof study) => referencePath(record.id, REFERENCE_UNCERTAINTY_CATALOG.id, REFERENCE_UNCERTAINTY_CATALOG.revisionId, record.name)
async function installIndependentSource(page: Page) {
  expect(sourcePayloadValid(REFERENCE_UNCERTAINTY_CATALOG)).toBe(true)
  await page.goto('/#/reference')
  await waitForPlannerReady(page)
  await replacePlannerFixture(page, await readLocalData(page), [REFERENCE_UNCERTAINTY_CATALOG])
}

test('Sources opens by keyboard and restores focus after Escape and Close', async ({ page }) => {
  await installIndependentSource(page)
  await page.goto(independentPath(study))
  const trigger = page.getByRole('button', { name: 'Sources for Synthetic retained study', exact: true })
  const popup = page.getByRole('dialog', { name: 'Sources for Synthetic retained study', exact: true })
  await trigger.focus()
  await trigger.press('Enter')
  await expect(popup).toBeVisible()
  await expect(popup.getByRole('heading', { name: 'Sources for Synthetic retained study', exact: true })).toBeFocused()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(popup.locator('.sources-trigger')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(popup).not.toBeVisible()
  await expect(trigger).toBeFocused()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await trigger.press('Space')
  await popup.getByRole('button', { name: 'Close sources', exact: true }).click()
  await expect(popup).not.toBeVisible()
  await expect(trigger).toBeFocused()
})

test('field Sources supports click-away, Tab-out and switching disclosures', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto(referencePath('base:job:0'))
  const trigger = page.getByRole('button', { name: 'Sources for Class master', exact: true })
  const popup = page.getByRole('dialog', { name: 'Sources for Class master', exact: true })
  await trigger.click()
  await expect(popup.getByRole('link', { name: /Community wiki/ })).toHaveAttribute('href', 'https://crystal-project.fandom.com/wiki/Warrior?oldid=13324')
  await page.getByRole('heading', { name: 'Warrior', exact: true }).click()
  await expect(popup).not.toBeVisible()
  await trigger.click()
  await popup.getByRole('link').last().focus()
  await page.keyboard.press('Tab')
  await expect(popup).not.toBeVisible()
  await expect(trigger).not.toBeFocused()
  await trigger.click()
  await page.getByRole('button', { name: 'Sources for Warrior', exact: true }).click()
  await expect(popup).not.toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Sources for Warrior', exact: true })).toBeVisible()
  await expect(page.locator('.sources-popup:popover-open')).toHaveCount(1)
})

test('Sources stays within a narrow viewport and scrolls long retained evidence', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await installIndependentSource(page)
  await page.goto(independentPath(study))
  const trigger = page.getByRole('button', { name: 'Sources for Synthetic retained study', exact: true })
  await expect(trigger).toHaveCSS('width', '16px')
  await expect(trigger).toHaveCSS('height', '16px')
  await trigger.click()
  const popup = page.getByRole('dialog', { name: 'Sources for Synthetic retained study', exact: true })
  await expect(popup).toBeVisible()
  const bounds = (await popup.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(640)
  await expect(popup.locator('.sources-popup__body')).toContainText(/missing HP/i)
  for (const source of RETAINED_STUDY_SOURCES) await expect(popup.locator(`a[href="${source.sourceId}"]`)).toBeVisible()
  const body = popup.locator('.sources-popup__body')
  expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await body.evaluate(element => { element.scrollTop = element.scrollHeight })
  expect(await body.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await popup.getByRole('button', { name: 'Close sources', exact: true }).click()
  await expect(trigger).toBeFocused()
})

test('superscript Sources stays attached when external field values and description headings wrap', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await installIndependentSource(page)
  for (const entry of [{ path: referencePath('base:job:0'), label: 'Sources for Class master' }, { path: independentPath(description), label: 'Sources for Description' }]) {
    await page.goto(entry.path)
    const trigger = page.getByRole('button', { name: entry.label, exact: true })
    const layout = await trigger.evaluate(element => {
      const group = element.closest<HTMLElement>('.sources-attached')!
      group.style.width = '72px'
      const value = group.querySelector<HTMLElement>('.sources-anchor')!
      const valueBounds = value.getBoundingClientRect()
      const markerBounds = element.getBoundingClientRect()
      const text = document.createTreeWalker(value, NodeFilter.SHOW_TEXT).nextNode()!
      const range = document.createRange()
      range.selectNodeContents(text)
      const lines = new Set(Array.from(range.getClientRects(), bounds => bounds.top)).size
      return { lines, valueRight: valueBounds.right, valueTop: valueBounds.top, markerLeft: markerBounds.left, markerTop: markerBounds.top, markerWidth: markerBounds.width, markerHeight: markerBounds.height, overflow: group.scrollWidth > group.clientWidth }
    })
    expect(layout.lines).toBeGreaterThan(1)
    expect(layout.markerLeft).toBeGreaterThanOrEqual(layout.valueRight)
    expect(layout.markerTop).toBeLessThanOrEqual(layout.valueTop)
    expect(layout.markerWidth).toBe(16)
    expect(layout.markerHeight).toBe(16)
    expect(layout.overflow).toBe(false)
    await trigger.click()
    const popup = page.getByRole('dialog', { name: entry.label, exact: true })
    await expect(popup).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(popup).toHaveCount(0)
    await expect(trigger).toBeFocused()
  }
})
