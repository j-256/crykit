import { expect, test } from '@playwright/test'
import { referencePath } from './reference-helpers'
import { MOBILE_TEST_TAG } from './test-tags'

test('Sources opens by keyboard and restores focus after Escape and Close', async ({ page }) => {
  await page.goto(referencePath('base:item:132'))
  const trigger = page.getByRole('button', { name: 'Sources for Shoudu Stew', exact: true })
  const popup = page.getByRole('dialog', { name: 'Sources for Shoudu Stew', exact: true })
  await trigger.focus()
  await trigger.press('Enter')
  await expect(popup).toBeVisible()
  await expect(popup.getByRole('heading', { name: 'Sources for Shoudu Stew', exact: true })).toBeFocused()
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
  const trigger = page.getByRole('button', { name: 'Sources for Master', exact: true })
  const popup = page.getByRole('dialog', { name: 'Sources for Master', exact: true })
  await trigger.click()
  await expect(popup.getByRole('link', { name: /Community wiki/ })).toBeVisible()
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
  await page.goto(referencePath('base:item:132'))
  const trigger = page.getByRole('button', { name: 'Sources for Shoudu Stew', exact: true })
  await expect(trigger).toHaveCSS('width', '16px')
  await expect(trigger).toHaveCSS('height', '16px')
  await trigger.click()
  const popup = page.getByRole('dialog', { name: 'Sources for Shoudu Stew', exact: true })
  await expect(popup).toBeVisible()
  const bounds = (await popup.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(640)
  await expect(popup.locator('.sources-popup__body')).toContainText(/missing HP/i)
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
  for (const entry of [{ id: 'base:job:0', label: 'Sources for Master' }, { id: 'base:equipment:134', label: 'Sources for Description' }]) {
    await page.goto(referencePath(entry.id))
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
