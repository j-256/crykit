import { MOBILE_TEST_TAG } from './test-tags'
import { waitForPlannerReady } from './local-data-helpers'
import { expect, test } from '@playwright/test'
import { EQUIPMENT_CATEGORIES } from '../src/ui/reference-categories'

test('inventory category filters use equipment identities while keeping readable labels', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/inventory')
  await waitForPlannerReady(page)
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Linked category: All categories', exact: true }).click()
  await page.getByRole('dialog', { name: 'Filter by linked category', exact: true }).getByRole('button', { name: 'Shields (1)', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Linked category: Shields', exact: true })).toBeVisible()
  await expect(page.locator('.inventory-item-label__name')).toHaveText(['Buckler'])
  expect(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('category')).toBe(EQUIPMENT_CATEGORIES.Shield.key)
  await page.reload()
  await waitForPlannerReady(page)
  await expect(page.getByRole('button', { name: 'Linked category: Shields', exact: true })).toBeVisible()
  await expect(page.locator('.inventory-item-label__name')).toHaveText(['Buckler'])
  await page.getByRole('button', { name: 'Linked category: Shields', exact: true }).click()
  await page.getByRole('dialog', { name: 'Filter by linked category', exact: true }).getByRole('button', { name: 'Swords (1)', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.inventory-item-label__name')).toHaveText(['Short Sword', 'Buckler'])
  await expect(page.getByRole('button', { name: 'Linked category: 2 selected', exact: true })).toBeVisible()
})

test('inventory filters stay compact and item artwork aligns with its label', { tag: MOBILE_TEST_TAG }, async ({ page }) => {
  await page.goto('/#/inventory')
  await waitForPlannerReady(page)
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible()

  const stateFilters = page.getByRole('group', { name: 'Inventory filters', exact: true })
  expect(await stateFilters.evaluate((group) => {
    const bounds = group.getBoundingClientRect()
    return [...group.querySelectorAll('button')].every((button) => {
      const buttonBounds = button.getBoundingClientRect()
      return buttonBounds.left >= bounds.left - 1 && buttonBounds.right <= bounds.right + 1
    })
  })).toBe(true)

  await expect(page.getByRole('group', { name: 'Inventory category filters', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Linked category: All categories', exact: true }).click()
  const categoryDropdown = page.getByRole('dialog', { name: 'Filter by linked category', exact: true })
  await expect(categoryDropdown).toBeVisible()
  await expect(categoryDropdown.getByRole('button', { name: 'Heavy armor (1)', exact: true })).toBeVisible()
  await expect(categoryDropdown.getByRole('button', { name: 'Heavy Armor (1)', exact: true })).toHaveCount(0)
  await expect(categoryDropdown.getByRole('button', { name: 'Shields (1)', exact: true })).toBeVisible()
  await expect(categoryDropdown.getByRole('button', { name: 'Shield (1)', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')

  const sourceTrigger = page.getByRole('button', { name: 'Linked source: All sources', exact: true })
  await sourceTrigger.click()
  const sourceDropdown = page.getByRole('dialog', { name: 'Filter by linked source', exact: true })
  await expect(sourceDropdown).toBeVisible()
  await expect(sourceDropdown).not.toContainText('https://')
  const sourceBounds = await sourceDropdown.boundingBox()
  expect(sourceBounds).not.toBeNull()
  expect(sourceBounds!.x).toBeGreaterThanOrEqual(0)
  expect(sourceBounds!.x + sourceBounds!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth))
  await page.keyboard.press('Escape')
  await expect(sourceTrigger).toBeFocused()

  const alignment = await page.locator('.inventory-item-label').first().evaluate((label) => {
    const artwork = label.querySelector<HTMLElement>('.game-icon, .wiki-sprite')
    const name = label.querySelector<HTMLElement>('.inventory-item-label__name')
    if (!artwork || !name) return null
    const artworkBounds = artwork.getBoundingClientRect()
    const nameBounds = name.getBoundingClientRect()
    return {
      centerDifference: Math.abs(artworkBounds.top + artworkBounds.height / 2 - (nameBounds.top + nameBounds.height / 2)),
      gap: nameBounds.left - artworkBounds.right,
      paddingTop: Number.parseFloat(getComputedStyle(artwork).paddingTop),
    }
  })
  expect(alignment).not.toBeNull()
  expect(alignment!.centerDifference).toBeLessThanOrEqual(3)
  expect(alignment!.gap).toBeGreaterThanOrEqual(8)
  expect(alignment!.paddingTop).toBeGreaterThanOrEqual(3)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
